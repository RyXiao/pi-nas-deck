// 单用户认证：密码哈希存本地，登录签发 HMAC token（30 天）。
// WebSocket 握手也用同一个 token（query 参数携带）。
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readJson, writeJson } from "./store.js";

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

export class Auth {
  constructor(configPath, initialPassword) {
    this.configPath = configPath;
    const cfg = readJson(configPath, {});
    // 首次启动：优先用环境变量密码，否则生成随机密码打到日志（用户去容器日志里找）。
    if (!cfg.passwordHash) {
      const password = initialPassword || randomBytes(6).toString("hex");
      this._savePassword(password);
      this.bootstrapPassword = initialPassword ? null : password;
    }
    this.passwordHash = readJson(configPath, {}).passwordHash;
    this.secret = readJson(configPath, {}).secret || randomBytes(32).toString("hex");
    writeJson(configPath, { passwordHash: this.passwordHash, secret: this.secret });
  }

  _savePassword(password) {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 32).toString("hex");
    const existing = readJson(this.configPath, {});
    writeJson(this.configPath, { ...existing, passwordHash: `${salt}:${hash}`, secret: existing.secret || randomBytes(32).toString("hex") });
  }

  setPassword(password) {
    this._savePassword(password);
    this.passwordHash = readJson(this.configPath, {}).passwordHash;
  }

  verifyPassword(password) {
    const [salt, hash] = (this.passwordHash || "").split(":");
    if (!salt || !hash) return false;
    const candidate = scryptSync(password, salt, 32);
    return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
  }

  issueToken() {
    const exp = Date.now() + TOKEN_TTL_MS;
    const payload = `v1.${exp}`;
    const sig = createHmac("sha256", this.secret).update(payload).digest("hex");
    return `${payload}.${sig}`;
  }

  verifyToken(token) {
    if (typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [v, expStr, sig] = parts;
    const payload = `${v}.${expStr}`;
    const expected = createHmac("sha256", this.secret).update(payload).digest("hex");
    try {
      if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return false;
    } catch {
      return false;
    }
    return Number(expStr) > Date.now();
  }
}
