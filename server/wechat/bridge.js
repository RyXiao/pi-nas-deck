// 微信 iLink 桥接（多账号版）：最多 MAX_ACCOUNTS 个微信号，各自独立扫码登录、
// 长轮询收信、绑定会话与任务队列；全局一个启用开关。
// 结构参考 PiDeck（MIT）WeChatLogin/WeChatBridge/WeChatService，按 Web 服务端场景简化：
// - 无 Electron safeStorage，bot_token 明文存 volume（文档提示风险）；
// - 无模型链，直接用会话当前模型；
// - 绑定 = 账号内 微信 chat ↔ (projectId, sessionId)，首次对话自动建会话；
// - 配置 v2：{ version:2, enabled, defaultProjectId, accounts:[{id,…,bindings:{}}] }；
//   v1 单账号配置（{account, bindings}）启动时自动迁移为 accounts[0]（槽位 a1）。
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJson } from "../lib/store.js";
import { UPLOAD_MEDIA_TYPE, sniffImageMime } from "./ilinkMedia.js";
import { IlinkClient, IlinkError } from "./ilinkClient.js";
import { convertPdfToMd } from "../lib/pdfConvert.js";
import { ILINK_CHANNEL_VERSION, ITEM_TYPE_FILE, ITEM_TYPE_IMAGE, ITEM_TYPE_TEXT, extractMessageText, MESSAGE_TYPE_USER, POLL_RETRY_FAST_MS, POLL_RETRY_SLOW_AFTER, POLL_RETRY_SLOW_MS, QR_STATUS_POLL_INTERVAL_MS } from "./ilinkProtocol.js";
import { pickLatestAssistantText, pickLatestFailureText, prepareOutgoingText, splitForWeChat } from "./wechatText.js";

const RUN_TIMEOUT_MS = 300_000;
const FILE_RUN_TIMEOUT_MS = 900_000; // 文件处理（office 分析/修改）给 15 分钟
const MAX_REPLY_FILES = 5; // 单轮最多回传的成品文件数
const MAX_REPLY_FILE_BYTES = 50 * 1024 * 1024; // 单个回传文件上限 50MB（微信媒体上限 100MB，留余量）
const MULTI_CHUNK_GAP_MS = 400;
const RESULT_SETTLE_MS = 800;
const DEDUP_MAX = 200;
const TYPING_TICKET_TTL_MS = 30_000;

/** 账号槽位：固定两个（两只手机），未扫码的槽位显示为「未登录」。 */
export const MAX_ACCOUNTS = 2;
export const ACCOUNT_SLOTS = ["a1", "a2"];

export class WeChatBridge {
  /**
   * @param {object} deps
   * @param {import("../lib/sessionManager.js").SessionManager} deps.sessions
   * @param {string} deps.configPath wechat.json 路径
   * @param {(event: string, payload: any) => void} deps.emit 状态广播（推给前端 WS）
   * @param {() => Array<{id:string,name:string}>} deps.listProjects
   * @param {string} [deps.botAgent]
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, {client:any, polling:boolean, stopping:boolean, activeRun:any, seen:string[], seenSet:Set<string>, status:string, errorMessage:string|null}>} */
    this.runtime = new Map();
    this.login = null; // { accountId, cancelled }
    // 微信文件收发目录：inbox 存收到的文件/图片，out 存 agent 成品（回传后即删）
    this.inboxDir = join(dirname(deps.configPath), "wechat-files", "inbox");
    this.outDir = join(dirname(deps.configPath), "wechat-files", "out");
    mkdirSync(this.inboxDir, { recursive: true });
    mkdirSync(this.outDir, { recursive: true });
    this._migrateConfig();
  }

  // ===== 配置 =====

  _cfg() {
    return readJson(this.deps.configPath, { version: 2, enabled: false, defaultProjectId: null, accounts: [] });
  }

  _saveCfg(patch) {
    const cfg = { ...this._cfg(), ...patch };
    writeJson(this.deps.configPath, cfg);
    return cfg;
  }

  /** v1（单 account + 全局 bindings）→ v2（accounts 数组，绑定归属账号）。 */
  _migrateConfig() {
    const raw = this._cfg();
    if (raw.version >= 2 && Array.isArray(raw.accounts)) return;
    const migrated = { version: 2, enabled: !!raw.enabled, defaultProjectId: raw.defaultProjectId || null, accounts: [] };
    if (raw.account) {
      migrated.accounts.push({ id: "a1", ...raw.account, defaultProjectId: null, bindings: raw.bindings || {} });
    }
    writeJson(this.deps.configPath, migrated);
  }

  _findAccount(cfg, accountId) {
    return (cfg.accounts || []).find((a) => a.id === accountId) || null;
  }

  /** 局部更新某个账号条目（读-改-写，避免并发覆盖其他账号）。 */
  _updateAccount(accountId, patch) {
    const cfg = this._cfg();
    const accounts = (cfg.accounts || []).map((a) => (a.id === accountId ? { ...a, ...patch } : a));
    return this._saveCfg({ accounts });
  }

  // ===== 状态 =====

  getStatus() {
    const cfg = this._cfg();
    return {
      enabled: cfg.enabled,
      defaultProjectId: cfg.defaultProjectId,
      maxAccounts: MAX_ACCOUNTS,
      accounts: ACCOUNT_SLOTS.slice(0, MAX_ACCOUNTS).map((id, index) => {
        const account = this._findAccount(cfg, id);
        const rt = this.runtime.get(id);
        let status = "disconnected";
        if (account && cfg.enabled) status = account.needsRelogin ? "error" : rt?.status || "disconnected";
        return {
          id,
          slot: index + 1,
          status,
          errorMessage: account?.needsRelogin ? "login-required" : rt?.errorMessage || undefined,
          account: publicAccount(account),
          defaultProjectId: account?.defaultProjectId ?? null,
          bindings: Object.entries(account?.bindings || {}).map(([chatId, b]) => ({ chatId: `${chatId.slice(0, 8)}…`, chatIdFull: chatId, ...b })),
        };
      }),
    };
  }

  setEnabled(enabled) {
    this._saveCfg({ enabled });
    if (enabled) void this.start();
    else void this.stop();
    return this.getStatus();
  }

  setDefaultProject(projectId) {
    this._saveCfg({ defaultProjectId: projectId });
    return this.getStatus();
  }

  /** 账号级默认项目（优先于全局；两只手机可各绑不同项目）。 */
  setAccountDefaultProject(accountId, projectId) {
    const cfg = this._cfg();
    if (!this._findAccount(cfg, accountId)) return this.getStatus();
    this._updateAccount(accountId, { defaultProjectId: projectId });
    return this.getStatus();
  }

  unbind(accountId, chatId) {
    const cfg = this._cfg();
    const account = this._findAccount(cfg, accountId);
    if (!account) return;
    const bindings = { ...(account.bindings || {}) };
    delete bindings[chatId];
    this._updateAccount(accountId, { bindings });
    this.deps.emit("wechat:status", this.getStatus());
  }

  // ===== 扫码登录（按槽位） =====
  // 协议坑：get_qrcode_status 是长轮询，超时=「还没变化」继续等；scaned_but_redirect 要换 base。

  async beginLogin(accountId) {
    if (!ACCOUNT_SLOTS.slice(0, MAX_ACCOUNTS).includes(accountId)) throw new Error(`无效账号槽位: ${accountId}`);
    this.cancelLogin();
    const cfg = this._cfg();
    const existing = this._findAccount(cfg, accountId);
    const client = new IlinkClient({
      baseUrl: existing?.baseUrl,
      channelVersion: ILINK_CHANNEL_VERSION,
      botAgent: this.deps.botAgent || "PiNasDeck",
    });

    const qr = await client.createQrcode();
    if (!qr.qrcode) throw new Error("get_bot_qrcode 未返回 qrcode");
    const state = { accountId, phase: "waiting", qrcodeContent: qr.qrcode_img_content || "" };
    this.deps.emit("wechat:login", state);

    this.login = { accountId, cancelled: false };
    const session = this.login;
    void this._pollLogin(client, qr.qrcode, state.qrcodeContent, accountId, session);
    return state;
  }

  cancelLogin(accountId) {
    if (this.login && (!accountId || this.login.accountId === accountId)) {
      this.login.cancelled = true;
      this.login = null;
    }
  }

  async _pollLogin(client, qrcode, qrContent, accountId, session) {
    const deadline = Date.now() + 8 * 60 * 1000;
    while (!session.cancelled && Date.now() < deadline) {
      await sleep(QR_STATUS_POLL_INTERVAL_MS);
      if (session.cancelled) return;
      let status;
      try {
        status = await client.queryQrcodeStatus(qrcode);
      } catch (error) {
        // 长轮询超时是正常现象；其余网络抖动也容忍重试，不逼用户重扫
        if (error instanceof IlinkError && error.kind === "session-expired") break;
        continue;
      }
      const value = status.status || "wait";
      if (value === "scaned") {
        this.deps.emit("wechat:login", { accountId, phase: "scanned", qrcodeContent: qrContent });
      } else if (value === "scaned_but_redirect" || value === "binded_redirect") {
        client.setBaseUrl(status.redirect_host);
      } else if (value === "need_verifycode") {
        this.deps.emit("wechat:login", { accountId, phase: "need-verify-code", qrcodeContent: qrContent });
      } else if (value === "verify_code_blocked") {
        this.deps.emit("wechat:login", { accountId, phase: "error", error: "verify_code_blocked" });
        return;
      } else if (value === "expired") {
        this.deps.emit("wechat:login", { accountId, phase: "expired" });
        return;
      } else if (value === "confirmed") {
        if (!status.bot_token || !status.ilink_bot_id) {
          this.deps.emit("wechat:login", { accountId, phase: "error", error: "confirmed 但未返回凭据" });
          return;
        }
        client.setBaseUrl(status.baseurl);
        // 落盘账号（bot_token 是长期凭据，勿入日志）。重扫保留原绑定：
        // 换绑到别的微信号后旧 chat 绑定自然失效（_handleIncoming 按 ilinkUserId 过滤）。
        const cfg = this._cfg();
        const previous = this._findAccount(cfg, accountId);
        const accounts = (cfg.accounts || []).filter((a) => a.id !== accountId);
        accounts.push({
          id: accountId,
          ilinkBotId: status.ilink_bot_id,
          ilinkUserId: status.ilink_user_id || "",
          botToken: status.bot_token,
          baseUrl: client.getBaseUrl(),
          loggedInAt: Date.now(),
          cursor: "",
          needsRelogin: false,
          defaultProjectId: previous?.defaultProjectId ?? null,
          bindings: previous?.bindings || {},
        });
        accounts.sort((a, b) => ACCOUNT_SLOTS.indexOf(a.id) - ACCOUNT_SLOTS.indexOf(b.id));
        this._saveCfg({ accounts });
        this.deps.emit("wechat:login", { accountId, phase: "confirmed" });
        await this.stopAccount(accountId);
        if (this._cfg().enabled) await this.startAccount(accountId);
        return;
      }
    }
    if (!session.cancelled) this.deps.emit("wechat:login", { accountId, phase: "expired" });
  }

  async logout(accountId) {
    await this.stopAccount(accountId);
    const cfg = this._cfg();
    const account = this._findAccount(cfg, accountId);
    if (!account) return;
    // 只清凭据，保留绑定：同一微信号重扫后绑定继续有效
    const accounts = (cfg.accounts || []).map((a) =>
      a.id === accountId ? { ...a, ilinkBotId: null, ilinkUserId: "", botToken: null, cursor: "", loggedInAt: null, needsRelogin: false } : a,
    );
    this._saveCfg({ accounts });
    this.deps.emit("wechat:login", { accountId, phase: "idle" });
    this.deps.emit("wechat:status", this.getStatus());
  }

  // ===== 桥接生命周期 =====

  async start() {
    const cfg = this._cfg();
    if (!cfg.enabled) return;
    for (const account of cfg.accounts || []) {
      if (account.botToken && !account.needsRelogin) await this.startAccount(account.id);
    }
  }

  async stop() {
    for (const id of [...this.runtime.keys()]) await this.stopAccount(id);
  }

  async startAccount(accountId) {
    const cfg = this._cfg();
    const account = this._findAccount(cfg, accountId);
    if (!cfg.enabled || !account?.botToken || account.needsRelogin) return;

    let rt = this.runtime.get(accountId);
    if (!rt) {
      rt = { client: null, polling: false, stopping: false, activeRun: null, seen: [], seenSet: new Set(), status: "connecting", errorMessage: null };
      this.runtime.set(accountId, rt);
    }
    rt.status = "connecting";
    rt.stopping = false;
    rt.client = new IlinkClient({ baseUrl: account.baseUrl, channelVersion: ILINK_CHANNEL_VERSION, botAgent: this.deps.botAgent || "PiNasDeck" });
    this.deps.emit("wechat:status", this.getStatus());
    try {
      await rt.client.notifyStart(this._session(account));
    } catch {
      // notifyStart 非必需，失败不阻断
    }
    rt.status = "connected";
    this.deps.emit("wechat:status", this.getStatus());
    if (!rt.polling) {
      rt.polling = true;
      void this._pollLoop(accountId);
    }
  }

  async stopAccount(accountId) {
    const rt = this.runtime.get(accountId);
    if (!rt) return;
    rt.stopping = true;
    rt.polling = false;
    const account = this._findAccount(this._cfg(), accountId);
    if (rt.client && account) {
      try {
        await rt.client.notifyStop(this._session(account));
      } catch {
        // 停机路径失败不打扰
      }
    }
    this.runtime.delete(accountId);
    this.deps.emit("wechat:status", this.getStatus());
  }

  _session(account) {
    return { botToken: account.botToken, baseUrl: account.baseUrl, ilinkBotId: account.ilinkBotId, ilinkUserId: account.ilinkUserId, cursor: account.cursor || "" };
  }

  // ===== 收信循环（每账号一个） =====

  async _pollLoop(accountId) {
    let consecutiveFailures = 0;
    const rt = this.runtime.get(accountId);
    if (!rt) return;
    while (!rt.stopping) {
      const cfg = this._cfg();
      const account = this._findAccount(cfg, accountId);
      if (!account || !rt.client) return;
      const session = this._session(account);
      try {
        const { msgs, cursor } = await rt.client.getUpdates(session, session.cursor);
        consecutiveFailures = 0;
        if (cursor && cursor !== account.cursor) this._updateAccount(accountId, { cursor });
        for (const message of msgs) this._handleIncoming(message, cfg, accountId);
      } catch (error) {
        if (rt.stopping) return;
        if (error instanceof IlinkError && error.kind === "session-expired") {
          // errcode -14：官方要求暂停该账号 1 小时，直接停轮询要求重扫，绝不自动重试
          this._updateAccount(accountId, { needsRelogin: true });
          rt.status = "error";
          rt.errorMessage = "login-required";
          this.deps.emit("wechat:status", this.getStatus());
          return;
        }
        consecutiveFailures += 1;
        const delay = consecutiveFailures >= POLL_RETRY_SLOW_AFTER ? POLL_RETRY_SLOW_MS : POLL_RETRY_FAST_MS;
        await sleep(delay);
      }
    }
  }

  /** 同步分诊：忙判定/命令判定在任何 await 之前完成，避免相邻消息交叉进入 run。 */
  _handleIncoming(message, cfg, accountId) {
    if (message.message_type !== MESSAGE_TYPE_USER) return;
    const rt = this.runtime.get(accountId);
    const account = this._findAccount(cfg, accountId);
    if (!rt || !account) return;
    // 去重：无 message_id 的消息（媒体消息常见）用 item_list 哈希兜底，否则第二条会被误判重复
    const messageId = message.message_id || `${message.from_user_id || ""}:${createHash("sha1").update(JSON.stringify(message.item_list || [])).digest("hex")}`;
    if (this._isDuplicate(rt, messageId)) return;

    const chatId = message.from_user_id;
    const contextToken = message.context_token || "";
    if (message.group_id) {
      void this._sendSafe(accountId, chatId, contextToken, "目前只支持私聊，请和我单聊。");
      return;
    }
    // 只响应该槽位扫码绑定的微信号；协议不拦陌生人，我们静默丢弃
    if (account.ilinkUserId && chatId !== account.ilinkUserId) return;

    const text = extractMessageText(message.item_list || []).trim();
    const media = collectMediaItems(message.item_list || []);
    if (!text && !media.files.length && !media.images.length) {
      if (media.unsupported) void this._sendSafe(accountId, chatId, contextToken, "暂不支持语音/视频消息，请发文字或文件（doc/xlsx/pdf/pptx 等都可以）。");
      return;
    }

    // 斜杠命令只在纯文本消息时生效（带附件的消息按内容处理）
    if (text.startsWith("/") && !media.files.length && !media.images.length) {
      void this._handleCommand(accountId, chatId, contextToken, text);
      return;
    }
    if (rt.activeRun) {
      void this._sendSafe(accountId, chatId, contextToken, "上一个任务还在跑，完成后会回复你。");
      return;
    }
    rt.activeRun = { chatId, startedAt: Date.now() };
    void this._runAgent(accountId, chatId, contextToken, text, media).finally(() => {
      rt.activeRun = null;
    });
  }

  _isDuplicate(rt, messageId) {
    if (rt.seenSet.has(messageId)) return true;
    rt.seenSet.add(messageId);
    rt.seen.push(messageId);
    if (rt.seen.length > DEDUP_MAX) {
      const old = rt.seen.shift();
      rt.seenSet.delete(old);
    }
    return false;
  }

  async _handleCommand(accountId, chatId, contextToken, text) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    const cfg = this._cfg();
    const account = this._findAccount(cfg, accountId);
    if (!account) return;
    if (cmd === "/new") {
      const bindings = { ...(account.bindings || {}) };
      delete bindings[chatId];
      this._updateAccount(accountId, { bindings });
      await this._sendSafe(accountId, chatId, contextToken, "已重置绑定，下一条消息会创建新会话。");
    } else if (cmd === "/stop") {
      const binding = account.bindings?.[chatId];
      const proc = binding?.sessionId ? this.deps.sessions.findBySessionFile(binding.sessionId) : null;
      if (proc) {
        await proc.request({ type: "abort" }).catch(() => {});
        await this._sendSafe(accountId, chatId, contextToken, "已停止当前任务。");
      } else {
        await this._sendSafe(accountId, chatId, contextToken, "当前没有正在跑的任务。");
      }
    } else if (cmd === "/status") {
      const binding = account.bindings?.[chatId];
      const rt = this.runtime.get(accountId);
      await this._sendSafe(accountId, chatId, contextToken, binding?.sessionId ? `已绑定会话，正在${rt?.activeRun ? "执行任务" : "待命"}。发 /new 可重置会话。` : "尚未绑定会话，直接发消息即可开始。");
    } else {
      await this._sendSafe(accountId, chatId, contextToken, "可用命令：/new 重置会话 · /stop 停止任务 · /status 查看状态");
    }
  }

  /** 跑一轮：确保绑定 →（媒体则下载）→ 提交 prompt → 等收口 → 回信 →（媒体则回传成品）。 */
  async _runAgent(accountId, chatId, contextToken, text, media = null) {
    const binding = await this._ensureBinding(accountId, chatId);
    if (!binding) return;
    const proc = this.deps.sessions.findBySessionFile(binding.sessionId);
    if (!proc || proc.closed) {
      await this._sendSafe(accountId, chatId, contextToken, "绑定的会话已失效，请发 /new 重新绑定。");
      return;
    }
    const rt = this.runtime.get(accountId);
    const account = this._findAccount(this._cfg(), accountId);
    const isMediaRun = !!(media?.files?.length || media?.images?.length);
    const runTimeoutMs = isMediaRun ? FILE_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS;

    // 下载入站媒体到 inbox（单个失败逐个告知，不阻断其余）
    const downloads = { files: [], images: [] };
    if (isMediaRun) {
      const stamp = Date.now();
      for (const entry of media.files) {
        try {
          const { buffer, fileName } = await rt.client.downloadInboundMedia(entry.item);
          const name = sanitizeFileName(fileName || "file.bin");
          const path = join(this.inboxDir, `${stamp}-${randomUUID().slice(0, 6)}-${name}`);
          writeFileSync(path, buffer);
          downloads.files.push({ path, name, size: buffer.length });
          // PDF 先服务端转文本（省一个量级 token）；转不了就让 agent 自己处理原件
          if (/\.pdf$/i.test(name)) {
            try {
              const conv = await convertPdfToMd(path);
              downloads.files[downloads.files.length - 1].mdPath = conv.mdPath;
            } catch {
              /* 保持原样 */
            }
          }
        } catch (error) {
          await this._sendSafe(accountId, chatId, contextToken, `文件 ${entry.fileName || ""} 下载失败：${error.message}`);
        }
      }
      for (const entry of media.images) {
        try {
          const { buffer } = await rt.client.downloadInboundMedia(entry.item);
          downloads.images.push({ data: buffer.toString("base64"), mimeType: sniffImageMime(buffer) });
        } catch (error) {
          await this._sendSafe(accountId, chatId, contextToken, `图片下载失败：${error.message}`);
        }
      }
      if (!downloads.files.length && !downloads.images.length) return; // 全部下载失败
    }

    const runId = randomUUID();
    const startedAt = Date.now();
    // 先登记事件等待再提交，避免快速失败错过 agent_settled
    const settled = waitForSettled(proc, runTimeoutMs);
    try {
      const state = await proc.request({ type: "get_state" }).catch(() => null);
      const isStreaming = state?.isStreaming;
      const promptReq = { type: "prompt", message: composeAgentPrompt(this.outDir, text, downloads), ...(isStreaming ? { streamingBehavior: "followUp" } : {}) };
      if (downloads.images.length) {
        promptReq.images = downloads.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }));
      }
      await proc.request(promptReq, 15_000);
    } catch (error) {
      await this._sendSafe(accountId, chatId, contextToken, `提交失败：${error.message}`, runId);
      return;
    }

    const outcome = await settled;
    await sleep(RESULT_SETTLE_MS);
    // 成品扫描：out 目录里本次运行之后新出现的文件
    const newFiles = isMediaRun ? collectNewFiles(this.outDir, startedAt) : [];

    if (outcome === "timeout") {
      await this._sendSafe(accountId, chatId, contextToken, `任务超过 ${Math.round(runTimeoutMs / 60000)} 分钟未完成，仍在后台跑。稍后发 /status 查看，或 /stop 停止。`, runId);
      return;
    }

    // 收口后取结果：先看错误，再取最近一条助手正文
    const messages = await proc.request({ type: "get_messages" }).catch(() => null);
    const list = messages?.messages || [];
    const failure = outcome === "aborted" ? "" : pickLatestFailureText(list.map(toFlat));
    const reply = failure || pickLatestAssistantText(list.map(toFlat));
    let prepared = reply ? prepareOutgoingText(reply) : "";
    if (!prepared && newFiles.length) prepared = "处理完成，成品文件见下。";
    if (prepared) {
      const chunks = splitForWeChat(prepared);
      for (const [index, chunk] of chunks.entries()) {
        if (index > 0) await sleep(MULTI_CHUNK_GAP_MS);
        const sent = await this._sendSafe(accountId, chatId, contextToken, chunk, runId);
        if (!sent) return; // context_token 失效，后面的文件也发不出去
      }
    } else if (!isMediaRun) {
      await this._sendSafe(accountId, chatId, contextToken, outcome === "aborted" ? "任务已停止。" : "任务完成但没有返回文本。", runId);
    }

    // 回传成品文件（发完即删，防 out 目录膨胀）
    for (const file of newFiles) {
      try {
        const uploaded = await rt.client.uploadLocalFile(this._session(account), { filePath: file.path, toUserId: chatId, mediaType: UPLOAD_MEDIA_TYPE.FILE });
        await rt.client.sendFile(this._session(account), { toUserId: chatId, contextToken, fileName: file.name, uploaded, runId, clientId: clientIdFor(account.ilinkBotId) });
        unlinkSync(file.path);
      } catch (error) {
        await this._sendSafe(accountId, chatId, contextToken, `文件 ${file.name} 回传失败：${error.message}`, runId);
      }
    }
    // 清理本次收到的 inbox 文件（处理链路已结束）
    for (const file of downloads.files) {
      try {
        unlinkSync(file.path);
      } catch {
        /* 已删/不存在 */
      }
    }
  }

  /** 确保 chat 有绑定会话；没有则在该项目下新建（账号级默认项目优先，其次全局）。 */
  async _ensureBinding(accountId, chatId) {
    const cfg = this._cfg();
    const account = this._findAccount(cfg, accountId);
    if (!account) return null;
    const bindings = account.bindings || {};
    const existing = bindings[chatId];
    if (existing?.sessionId && this.deps.sessions.findBySessionFile(existing.sessionId)) return existing;

    const projectId = existing?.projectId || account.defaultProjectId || cfg.defaultProjectId || this.deps.listProjects()[0]?.id;
    if (!projectId) {
      await this._sendSafe(accountId, chatId, "", "服务端还没有配置任何项目，请先在 Web 界面添加项目。");
      return null;
    }
    const { key, state } = await this.deps.sessions.open(projectId, null, `wechat-${chatId.slice(0, 6)}`);
    const sessionId = state?.sessionFile || key;
    const next = { ...bindings, [chatId]: { projectId, sessionId, boundAt: Date.now() } };
    this._updateAccount(accountId, { bindings: next });
    this.deps.emit("wechat:status", this.getStatus());
    return next[chatId];
  }

  async _sendSafe(accountId, chatId, contextToken, text, runId) {
    const rt = this.runtime.get(accountId);
    const account = this._findAccount(this._cfg(), accountId);
    if (!account?.botToken || !rt?.client || !chatId) return false;
    try {
      await rt.client.sendText(this._session(account), { toUserId: chatId, contextToken, text, runId, clientId: clientIdFor(account.ilinkBotId) });
      return true;
    } catch (error) {
      console.warn(`[wechat:${accountId}] 回信失败:`, error?.message || error);
      return false;
    }
  }
}

// ===== 工具 =====

/** 从 item_list 收集文件/图片条目；语音/视频标记为不支持。 */
function collectMediaItems(items) {
  const result = { files: [], images: [], unsupported: false };
  if (!Array.isArray(items)) return result;
  for (const item of items) {
    if (!item || item.type === ITEM_TYPE_TEXT) continue;
    if (item.type === ITEM_TYPE_FILE) result.files.push({ item, fileName: item.file_item?.file_name || "file.bin" });
    else if (item.type === ITEM_TYPE_IMAGE) result.images.push({ item });
    else result.unsupported = true;
  }
  return result;
}

/** 组装给 agent 的用户消息：文件路径/图片 + 用户说明 + 处理约定（venv python、成品目录、总结要求）。 */
function composeAgentPrompt(outDir, text, downloads) {
  const lines = [];
  for (const file of downloads.files) {
    if (file.mdPath) {
      lines.push(`[用户通过微信发来 PDF：${file.name}（${fmtBytes(file.size)}）；已自动提取文本，优先读 ${file.mdPath}（省 token），仅在需要图表/版式时才看原文件 ${file.path}]`);
    } else {
      lines.push(`[用户通过微信发来文件：${file.path}（${file.name}，${fmtBytes(file.size)}）]`);
    }
  }
  if (downloads.images.length) lines.push(`[用户发来 ${downloads.images.length} 张图片，已随消息附上，请直接查看分析]`);
  lines.push(text || (downloads.files.length ? "请分析这个文件，把结论总结回复给我。" : "请分析图片内容，把结论总结回复给我。"));
  if (downloads.files.length) {
    lines.push("");
    lines.push("处理约定：");
    lines.push("- Python 用 /opt/agent-venv/bin/python（已装 openpyxl/python-docx/python-pptx/pypdf/pdfplumber/pandas/matplotlib；画图设 MPLBACKEND=Agg）");
    lines.push("- PDF 一律优先读已提取的 .md 文本，绝不要把 PDF 转成图片逐页看（那是几十倍的 token 浪费）；没有 .md 时用 /opt/agent-venv/bin/python 的 pypdf 提取后再读");
    lines.push(`- 若需生成或修改成品文件，把成品写到 ${outDir} 目录（尽量保留原文件名或加 _modified 后缀）；只分析不修改时无需产出文件`);
    lines.push("- 老格式 .doc/.xls/.ppt 没有转换工具，请直接回复让用户转存为 .docx/.xlsx/.pptx 再发");
    lines.push("- 最后用一段简短中文总结分析结论或修改内容（这段话会直接回复到微信里）");
  }
  return lines.join("\n");
}

/** 扫描 out 目录里 since 之后新出现的可回传文件（数量/大小有上限）。导出供测试。 */
export function collectNewFiles(dir, since, { maxFiles = MAX_REPLY_FILES, maxFileBytes = MAX_REPLY_FILE_BYTES } = {}) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of entries) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxFileBytes) continue;
    if (stat.mtimeMs < since) continue;
    found.push({ path, name, size: stat.size, mtime: stat.mtimeMs });
  }
  found.sort((a, b) => a.mtime - b.mtime);
  return found.slice(0, maxFiles);
}

/** 上传文件名消毒：去路径分隔符、控制字符，限长。 */
function sanitizeFileName(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "file";
  return base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").slice(0, 100) || "file";
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function publicAccount(account) {
  if (!account?.botToken) return null;
  return { ilinkBotId: account.ilinkBotId, loggedInAt: account.loggedInAt, baseUrl: account.baseUrl, needsRelogin: account.needsRelogin || false };
}

function clientIdFor(botId) {
  // 出站 client_id 按 Bot 账号派生，重启保持同一值
  let hash = 0;
  const seed = `pnd-${botId || "default"}`;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return `pnd${hash.toString(36)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等 proc 的下一次 agent_settled。 */
function waitForSettled(proc, timeoutMs) {
  return new Promise((resolve) => {
    const onEvent = (record) => {
      if (record.type === "agent_settled") {
        cleanup();
        resolve(record.aborted ? "aborted" : "settled");
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve("timeout");
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve("exited");
    };
    function cleanup() {
      clearTimeout(timer);
      proc.off("event", onEvent);
      proc.off("exit", onExit);
    }
    proc.on("event", onEvent);
    proc.on("exit", onExit);
  });
}

/** get_messages 返回的 AgentMessage 转成 pick* 函数期望的扁平形状。 */
function toFlat(message) {
  const content = message?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((block) => (typeof block === "string" ? block : block?.text || ""))
      .join("\n");
  }
  return { role: message?.role, text, stopReason: message?.stopReason };
}
