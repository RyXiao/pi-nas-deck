// 微信 iLink 媒体层：CDN 收发（AES-128-ECB 加解密 + 预签名 URL）。
// 逐字段对齐腾讯官方包 @tencent-weixin/openclaw-weixin@2.4.10（cdn/*、media/media-download.js）：
// - 下载：GET {cdn}/download?encrypted_query_param=… → AES-128-ECB(PKCS7) 解密；
//   aes_key 两种编码：base64(裸 16 字节)【图片】或 base64(hex 字符串)【文件/语音/视频】；
// - 上传：getuploadurl（filekey/md5/aeskey(hex) 等）→ POST 密文到 {cdn}/upload?…
//   → 响应头 x-encrypted-param 即回填进 sendmessage 的 download 参数。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ILINK_CDN_BASE_URL } from "./ilinkProtocol.js";

/** UploadMediaType（上传接口的 media_type 枚举，与消息 item type 不同）。 */
export const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };

/** 官方包同款媒体上限。 */
export const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** CDN 上传/下载的兜底超时（大文件在 NAS 上慢，放宽到 2 分钟）。 */
const CDN_IO_TIMEOUT_MS = 120_000;

export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-ECB(PKCS7) 密文大小。 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * 解析 CDNMedia.aes_key（官方包 pic-decrypt.js 同款逻辑）：
 * base64 解出来是 16 字节 → 直接用；是 32 字符 hex → 再按 hex 解成 16 字节。
 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`aes_key 必须是 base64(16字节) 或 base64(32字符hex)，实际解出 ${decoded.length} 字节`);
}

export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl = ILINK_CDN_BASE_URL) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function fetchCdnBytes(url, label, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_IO_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    throw new Error(`${label} CDN 下载网络失败：${error?.message || String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`${label} CDN 下载 HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 下载并（若加密）解密一个媒体条目，返回明文 Buffer。
 * @param {object} opts
 * @param {string} [opts.encryptQueryParam] CDNMedia.encrypt_query_param
 * @param {string} [opts.aesKeyBase64] CDNMedia.aes_key（两种编码均可，见 parseAesKey）
 * @param {string} [opts.fullUrl] 服务端可能直接给完整 URL，优先于拼接
 * @param {string} [opts.cdnBaseUrl]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function downloadCdnMedia({ encryptQueryParam, aesKeyBase64, fullUrl, cdnBaseUrl = ILINK_CDN_BASE_URL, fetchImpl = globalThis.fetch }) {
  const url = fullUrl || (encryptQueryParam ? buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl) : null);
  if (!url) throw new Error("CDN 下载缺少 encrypt_query_param 与 full_url");
  const encrypted = await fetchCdnBytes(url, "media", fetchImpl);
  if (!aesKeyBase64) return encrypted; // 未加密条目（个别图片）
  return decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
}

/**
 * 把密文 POST 到 CDN，返回响应头 x-encrypted-param（回填 sendmessage 的 download 参数）。
 * @param {object} opts
 * @param {Buffer} opts.buf 明文（内部加密）
 * @param {string} [opts.uploadFullUrl] getuploadurl 直接给的完整地址
 * @param {string} [opts.uploadParam] 否则用 upload_param + filekey 拼
 * @param {string} opts.filekey
 * @param {Buffer} opts.aeskey 16 字节随机 key
 */
export async function uploadBufferToCdn({ buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl = ILINK_CDN_BASE_URL, aeskey, fetchImpl = globalThis.fetch }) {
  const url = uploadFullUrl?.trim() || (uploadParam ? buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) : null);
  if (!url) throw new Error("CDN 上传缺少 upload_full_url 与 upload_param");
  const ciphertext = encryptAesEcb(buf, aeskey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_IO_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`CDN 上传网络失败：${error?.message || String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errMsg = res.headers?.get?.("x-error-message") || `status ${res.status}`;
    throw new Error(`CDN 上传失败 ${res.status}: ${errMsg}`);
  }
  const downloadParam = res.headers?.get?.("x-encrypted-param");
  if (!downloadParam) throw new Error("CDN 上传响应缺少 x-encrypted-param 头");
  return downloadParam;
}

/** 从入站 item 里取出该媒体条目的下载参数（file_item / image_item 通用形状）。 */
export function inboundMediaRef(item) {
  const body = item?.file_item || item?.image_item;
  if (!body?.media) return null;
  return {
    encryptQueryParam: body.media.encrypt_query_param || "",
    aesKeyBase64: body.aeskey ? Buffer.from(body.aeskey, "hex").toString("base64") : body.media.aes_key || "",
    fullUrl: body.media.full_url || "",
    fileName: body.file_name || "",
  };
}

/** 按魔数嗅探常见图片 MIME（微信图片条目不带 MIME）。 */
export function sniffImageMime(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
}

/** 生成上传用的 filekey/aeskey 对。 */
export function makeUploadKeys() {
  return { filekey: randomBytes(16).toString("hex"), aeskey: randomBytes(16) };
}

/** 文件 md5（hex）。 */
export function md5Hex(buf) {
  return createHash("md5").update(buf).digest("hex");
}
