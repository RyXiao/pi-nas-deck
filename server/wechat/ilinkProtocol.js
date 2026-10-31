// 微信 iLink（ClawBot）协议常量与纯函数。
// 移植自 PiDeck（MIT）src/main/wechat/ilinkProtocol.ts，事实来源 Tencent/openclaw-weixin 协议文档。
// 与文档不一致的实测偏差见各常量注释——照文档写会挂的地方都保留了注释。

export const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const ILINK_BOT_TYPE = 3; // 固定 3，换值扫码后拿不到 bot_token
export const ILINK_CHANNEL_VERSION = "1.0.2"; // 「插件版本」，服务端仅观测，不随应用版本跳
export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export const ILINK_EP_GET_BOT_QRCODE = "/ilink/bot/get_bot_qrcode";
export const ILINK_EP_GET_QRCODE_STATUS = "/ilink/bot/get_qrcode_status";
export const ILINK_EP_GET_UPDATES = "/ilink/bot/getupdates";
export const ILINK_EP_SEND_MESSAGE = "/ilink/bot/sendmessage";
export const ILINK_EP_GET_CONFIG = "/ilink/bot/getconfig";
export const ILINK_EP_SEND_TYPING = "/ilink/bot/sendtyping";
export const ILINK_EP_NOTIFY_START = "/ilink/bot/msg/notifystart";
export const ILINK_EP_NOTIFY_STOP = "/ilink/bot/msg/notifystop";
export const ILINK_EP_GET_UPLOAD_URL = "/ilink/bot/getuploadurl";

export const API_TIMEOUT_MS = 15_000;
export const QR_STATUS_TIMEOUT_MS = 45_000; // 长轮询，默认 15s 会把自己打死
export const QR_STATUS_POLL_INTERVAL_MS = 2_000;
export const POLL_TIMEOUT_MS = 40_000; // getupdates 实测 ~18s 返回，兜 40s
export const POLL_RETRY_FAST_MS = 2_000;
export const POLL_RETRY_SLOW_MS = 30_000;
export const POLL_RETRY_SLOW_AFTER = 3;
export const SESSION_EXPIRED_COOLDOWN_MS = 60 * 60 * 1000; // errcode -14 后必须暂停 1 小时

export const ILINK_HEADER_AUTH_TYPE = "AuthorizationType";
export const ILINK_HEADER_AUTH = "Authorization";
export const ILINK_HEADER_UIN = "X-WECHAT-UIN";
export const ILINK_HEADER_APP_ID = "iLink-App-Id";
export const ILINK_HEADER_APP_CLIENT_VERSION = "iLink-App-ClientVersion";
export const ILINK_AUTH_TYPE_VALUE = "ilink_bot_token";

export const ILINK_RET_OK = 0;
export const ILINK_ERR_SESSION_EXPIRED = -14;

export const ITEM_TYPE_TEXT = 1;
export const ITEM_TYPE_IMAGE = 2;
export const ITEM_TYPE_VOICE = 3;
export const ITEM_TYPE_FILE = 4;
export const ITEM_TYPE_VIDEO = 5;
export const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;
export const MESSAGE_STATE_DELIVERED = 2;

/** 随机 X-WECHAT-UIN：uint32 十进制字符串 base64。实测非必需，文档要求且零成本，照发。 */
export function randomWechatUin() {
  const value = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(value), "utf-8").toString("base64");
}

export function buildBaseInfo(channelVersion, botAgent) {
  const info = { channel_version: channelVersion };
  if (botAgent) info.bot_agent = botAgent;
  return info;
}

/** 会话过期：ret 或 errcode 任一命中 -14。 */
export function isSessionExpired(payload) {
  return payload?.ret === ILINK_ERR_SESSION_EXPIRED || payload?.errcode === ILINK_ERR_SESSION_EXPIRED;
}

/** 一条消息可能拆成多个 text item，全部抽出拼接。 */
export function extractMessageText(items) {
  if (!Array.isArray(items)) return "";
  return items
    .filter((item) => item?.type === ITEM_TYPE_TEXT && typeof item.text_item?.text === "string")
    .map((item) => item.text_item.text)
    .join("");
}

/** 是否含非文本 item（图片/语音/文件/视频），用于降级提示。 */
export function hasUnsupportedItem(items) {
  if (!Array.isArray(items)) return false;
  return items.some((item) => item?.type !== ITEM_TYPE_TEXT);
}
