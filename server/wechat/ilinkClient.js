// 微信 iLink 传输层：一次请求 → 一个结构化结果或 IlinkError。
// 移植自 PiDeck（MIT）src/main/wechat/IlinkClient.ts；媒体收发（getuploadurl/CDN）
// 按腾讯官方包 @tencent-weixin/openclaw-weixin@2.4.10 对齐。
import { readFile } from "node:fs/promises";
import { aesEcbPaddedSize, downloadCdnMedia, inboundMediaRef, makeUploadKeys, md5Hex, uploadBufferToCdn, UPLOAD_MEDIA_TYPE, WEIXIN_MEDIA_MAX_BYTES } from "./ilinkMedia.js";
import {
  API_TIMEOUT_MS,
  buildBaseInfo,
  ILINK_AUTH_TYPE_VALUE,
  ILINK_CDN_BASE_URL,
  ILINK_DEFAULT_BASE_URL,
  ILINK_EP_GET_BOT_QRCODE,
  ILINK_EP_GET_CONFIG,
  ILINK_EP_GET_QRCODE_STATUS,
  ILINK_EP_GET_UPDATES,
  ILINK_EP_GET_UPLOAD_URL,
  ILINK_EP_NOTIFY_START,
  ILINK_EP_NOTIFY_STOP,
  ILINK_EP_SEND_MESSAGE,
  ILINK_EP_SEND_TYPING,
  ILINK_HEADER_APP_CLIENT_VERSION,
  ILINK_HEADER_APP_ID,
  ILINK_HEADER_AUTH,
  ILINK_HEADER_AUTH_TYPE,
  ILINK_HEADER_UIN,
  ILINK_RET_OK,
  isSessionExpired,
  ITEM_TYPE_FILE,
  ITEM_TYPE_IMAGE,
  ITEM_TYPE_TEXT,
  MESSAGE_STATE_DELIVERED,
  MESSAGE_TYPE_BOT,
  POLL_TIMEOUT_MS,
  QR_STATUS_TIMEOUT_MS,
  randomWechatUin,
} from "./ilinkProtocol.js";

const MAX_RESPONSE_CHARS = 1_000_000;
const LOG_SNIPPET_CHARS = 400;

export class IlinkError extends Error {
  constructor(kind, endpoint, message, extra = {}) {
    super(message);
    this.name = "IlinkError";
    this.kind = kind; // timeout|network|http|business|malformed|session-expired
    this.endpoint = endpoint;
    this.httpStatus = extra.httpStatus;
    this.ret = extra.ret;
    this.errcode = extra.errcode;
  }
}

/** 日志脱敏：bot_token/context_token/typing_ticket 是长期或短期凭据，出口即脱敏。 */
export function redactSecrets(text) {
  return text
    .replace(/("bot_token"\s*:\s*")[^"]*(")/g, "$1<redacted>$2")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/@:-]+/g, "$1<redacted>")
    .replace(/("context_token"\s*:\s*")[^"]*(")/g, "$1<redacted>$2")
    .replace(/("typing_ticket"\s*:\s*")[^"]*(")/g, "$1<redacted>$2");
}

export class IlinkClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || ILINK_DEFAULT_BASE_URL;
    this.channelVersion = options.channelVersion;
    this.botAgent = options.botAgent;
    this.fetchImpl = options.fetchImpl || ((url, init) => globalThis.fetch(url, init));
    this.logger = options.logger;
    this.apiTimeoutMs = options.timeouts?.api ?? API_TIMEOUT_MS;
    this.qrStatusTimeoutMs = options.timeouts?.qrStatus ?? QR_STATUS_TIMEOUT_MS;
    this.pollTimeoutMs = options.timeouts?.poll ?? POLL_TIMEOUT_MS;
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  /** 服务端可能回传新 base（扫码 redirect / confirmed baseurl），空值忽略。 */
  setBaseUrl(url) {
    if (!url) return;
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    if (normalized === this.baseUrl) return;
    this.log(`切换到 base ${normalized}`);
    this.baseUrl = normalized;
  }

  log(message, detail) {
    this.logger?.("debug", message, detail);
  }

  appHeaders() {
    return { "Content-Type": "application/json" };
  }

  /** 业务请求头：带 bot_token；X-WECHAT-UIN 每次新随机值。 */
  authHeaders(botToken) {
    return {
      ...this.appHeaders(),
      [ILINK_HEADER_AUTH_TYPE]: ILINK_AUTH_TYPE_VALUE,
      [ILINK_HEADER_AUTH]: `Bearer ${botToken}`,
      [ILINK_HEADER_UIN]: randomWechatUin(),
    };
  }

  async request(method, path, { body, headers, timeoutMs, label }) {
    const url = new URL(path, `${this.baseUrl}/`).toString();
    const bodyStr = body === undefined ? undefined : JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(bodyStr !== undefined ? { body: bodyStr } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error?.message || String(error);
      const timedOut = error?.name === "AbortError" || /aborted/i.test(detail);
      throw new IlinkError(timedOut ? "timeout" : "network", label, `${label} ${timedOut ? "超时" : "网络失败"}：${detail}`);
    } finally {
      clearTimeout(timer);
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw new IlinkError("network", label, `${label} 响应读取失败：${error?.message || String(error)}`);
    }

    if (text.length > MAX_RESPONSE_CHARS) {
      throw new IlinkError("malformed", label, `${label} 响应过大（${text.length} 字符）`, { httpStatus: response.status });
    }
    this.log(`${label} → HTTP ${response.status}`, redactSecrets(text.slice(0, LOG_SNIPPET_CHARS)));

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new IlinkError("malformed", label, `${label} 返回非 JSON：${redactSecrets(text.slice(0, LOG_SNIPPET_CHARS))}`, { httpStatus: response.status });
    }

    if (response.status < 200 || response.status >= 300) {
      throw new IlinkError("http", label, `${label} HTTP ${response.status}`, { httpStatus: response.status });
    }
    // 会话失效可能只出现在 errcode 上而 ret 仍为 0，必须独立判定
    if (isSessionExpired(payload)) {
      throw new IlinkError("session-expired", label, `${label} 会话已失效`, { httpStatus: response.status, ret: payload.ret, errcode: payload.errcode });
    }
    // iLink 用 HTTP 200 + ret 表达业务失败，2xx 不等于成功
    if (payload.ret !== undefined && payload.ret !== ILINK_RET_OK) {
      throw new IlinkError("business", label, `${label} 业务失败 ret=${payload.ret}${payload.errmsg ? ` ${payload.errmsg}` : ""}`, {
        httpStatus: response.status,
        ret: payload.ret,
        errcode: payload.errcode,
      });
    }
    return payload;
  }

  baseInfo() {
    return buildBaseInfo(this.channelVersion, this.botAgent);
  }

  // ===== 扫码（应用级，无凭据） =====

  async createQrcode() {
    return this.request("POST", `${ILINK_EP_GET_BOT_QRCODE}?bot_type=3`, {
      body: { local_token_list: [] },
      headers: this.appHeaders(),
      timeoutMs: this.apiTimeoutMs,
      label: "get_bot_qrcode",
    });
  }

  /** 长轮询：无状态变化时服务端挂连接，超时=「还没变化」，调用方须继续等。 */
  async queryQrcodeStatus(qrcode, verifyCode) {
    const params = new URLSearchParams({ qrcode });
    if (verifyCode) params.set("verify_code", verifyCode);
    return this.request("GET", `${ILINK_EP_GET_QRCODE_STATUS}?${params}`, {
      headers: this.appHeaders(),
      timeoutMs: this.qrStatusTimeoutMs,
      label: "get_qrcode_status",
    });
  }

  // ===== 在线状态 =====

  async notifyStart(session) {
    return this.request("POST", ILINK_EP_NOTIFY_START, {
      body: { base_info: this.baseInfo() },
      headers: this.authHeaders(session.botToken),
      timeoutMs: this.apiTimeoutMs,
      label: "notifystart",
    });
  }

  async notifyStop(session) {
    return this.request("POST", ILINK_EP_NOTIFY_STOP, {
      body: { base_info: this.baseInfo() },
      headers: this.authHeaders(session.botToken),
      timeoutMs: this.apiTimeoutMs,
      label: "notifystop",
    });
  }

  // ===== 收信 =====

  /** 长轮询收信；游标需持久化并回传，保证不重复投递。 */
  async getUpdates(session, cursor) {
    const payload = await this.request("POST", ILINK_EP_GET_UPDATES, {
      body: { get_updates_buf: cursor ?? "", base_info: this.baseInfo() },
      headers: this.authHeaders(session.botToken),
      timeoutMs: this.pollTimeoutMs,
      label: "getupdates",
    });
    return { msgs: payload.msgs ?? [], cursor: payload.get_updates_buf ?? cursor ?? "" };
  }

  // ===== 回信 =====

  async getConfig(session, userId, contextToken) {
    return this.request("POST", ILINK_EP_GET_CONFIG, {
      body: { ilink_user_id: userId, context_token: contextToken, base_info: this.baseInfo() },
      headers: this.authHeaders(session.botToken),
      timeoutMs: this.apiTimeoutMs,
      label: "getconfig",
    });
  }

  async sendTyping(session, userId, typingTicket, status = 1) {
    return this.request("POST", ILINK_EP_SEND_TYPING, {
      body: { ilink_user_id: userId, typing_ticket: typingTicket, status, base_info: this.baseInfo() },
      headers: this.authHeaders(session.botToken),
      timeoutMs: this.apiTimeoutMs,
      label: "sendtyping",
    });
  }

  /** 发文本。必须先收到带 context_token 的用户消息——协议不支持主动推送。 */
  async sendText(session, { toUserId, contextToken, text, clientId, runId }) {
    return this._sendMessageItem(session, { toUserId, contextToken, clientId, runId, item: { type: ITEM_TYPE_TEXT, text_item: { text } } });
  }

  /** 逐条 sendmessage 发一个 item（官方 sendMediaItems 同款：文本项与媒体项分开发）。 */
  async _sendMessageItem(session, { toUserId, contextToken, clientId, runId, item }) {
    return this.request("POST", ILINK_EP_SEND_MESSAGE, {
      body: {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          ...(clientId ? { client_id: clientId } : {}),
          ...(runId ? { run_id: runId } : {}),
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_DELIVERED,
          context_token: contextToken,
          item_list: [item],
        },
        base_info: this.baseInfo(),
      },
      headers: this.authHeaders(session.botToken),
      timeoutMs: this.apiTimeoutMs,
      label: "sendmessage",
    });
  }

  // ===== 媒体（文件/图片收发，CDN + AES-128-ECB） =====

  /** getuploadurl：申请 CDN 预签名上传参数。 */
  async getUploadUrl(session, body) {
    return this.request("POST", ILINK_EP_GET_UPLOAD_URL, {
      body: { ...body, base_info: this.baseInfo() },
      headers: this.authHeaders(session.botToken),
      timeoutMs: this.apiTimeoutMs,
      label: "getuploadurl",
    });
  }

  /** 上传本地文件到微信 CDN。返回回填 sendmessage 所需的全部字段。 */
  async uploadLocalFile(session, { filePath, toUserId, mediaType = UPLOAD_MEDIA_TYPE.FILE, cdnBaseUrl = ILINK_CDN_BASE_URL }) {
    const plaintext = await readFile(filePath);
    if (plaintext.length > WEIXIN_MEDIA_MAX_BYTES) throw new Error(`文件超过微信媒体上限 100MB（${(plaintext.length / 1024 / 1024).toFixed(1)}MB）`);
    const rawsize = plaintext.length;
    const rawfilemd5 = md5Hex(plaintext);
    const filesize = aesEcbPaddedSize(rawsize);
    const { filekey, aeskey } = makeUploadKeys();
    const resp = await this.getUploadUrl(session, {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    });
    const uploadFullUrl = resp.upload_full_url?.trim();
    const uploadParam = resp.upload_param;
    if (!uploadFullUrl && !uploadParam) throw new IlinkError("business", "getuploadurl", "getuploadurl 未返回上传地址");
    const downloadParam = await uploadBufferToCdn({
      buf: plaintext,
      uploadFullUrl: uploadFullUrl || undefined,
      uploadParam: uploadParam ?? undefined,
      filekey,
      cdnBaseUrl,
      aeskey,
      fetchImpl: this.fetchImpl,
    });
    return { downloadEncryptedQueryParam: downloadParam, aeskeyHex: aeskey.toString("hex"), fileSize: rawsize, filekey };
  }

  /** 发送文件消息（可选前置一条文字说明；逐 item 发送）。 */
  async sendFile(session, { toUserId, contextToken, text, fileName, uploaded, runId, clientId }) {
    if (text) await this._sendMessageItem(session, { toUserId, contextToken, clientId, runId, item: { type: ITEM_TYPE_TEXT, text_item: { text } } });
    return this._sendMessageItem(session, {
      toUserId,
      contextToken,
      clientId,
      runId,
      item: {
        type: ITEM_TYPE_FILE,
        file_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            // 官方包同款编码：base64(hex 字符串)；接收端 parseAesKey 兼容
            aes_key: Buffer.from(uploaded.aeskeyHex).toString("base64"),
            encrypt_type: 1,
          },
          file_name: fileName,
          len: String(uploaded.fileSize),
        },
      },
    });
  }

  /** 发送图片消息（图片不带文件名）。 */
  async sendImage(session, { toUserId, contextToken, text, uploaded, runId, clientId }) {
    if (text) await this._sendMessageItem(session, { toUserId, contextToken, clientId, runId, item: { type: ITEM_TYPE_TEXT, text_item: { text } } });
    return this._sendMessageItem(session, {
      toUserId,
      contextToken,
      clientId,
      runId,
      item: {
        type: ITEM_TYPE_IMAGE,
        image_item: {
          media: { encrypt_query_param: uploaded.downloadEncryptedQueryParam, aes_key: Buffer.from(uploaded.aeskeyHex).toString("base64"), encrypt_type: 1 },
          len: String(uploaded.fileSize),
        },
      },
    });
  }

  /** 下载并解密一个入站媒体条目（file_item / image_item）。 */
  async downloadInboundMedia(item, { cdnBaseUrl = ILINK_CDN_BASE_URL } = {}) {
    const ref = inboundMediaRef(item);
    if (!ref) throw new Error("条目不含可下载的媒体引用");
    const buffer = await downloadCdnMedia({
      encryptQueryParam: ref.encryptQueryParam,
      aesKeyBase64: ref.aesKeyBase64,
      fullUrl: ref.fullUrl || undefined,
      cdnBaseUrl,
      fetchImpl: this.fetchImpl,
    });
    if (buffer.length > WEIXIN_MEDIA_MAX_BYTES) throw new Error("媒体超过 100MB 上限");
    return { buffer, fileName: ref.fileName || "" };
  }
}
