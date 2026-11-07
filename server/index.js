// PiNasDeck 服务端：HTTP API + WebSocket 桥 + 静态前端。
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import { Auth } from "./lib/auth.js";
import { extractDocxText } from "./lib/docx.js";
import { convertPdfToMd } from "./lib/pdfConvert.js";
import { syncBuiltinExtensions } from "./lib/extensions.js";
import { readMcpConfig, writeMcpConfig } from "./lib/mcpConfig.js";
import { getLatestPiVersion, getPiVersion, readModels, testConnection, updatePi, writeModels } from "./lib/modelsConfig.js";
import { SessionManager } from "./lib/sessionManager.js";
import { deleteSkill, getSkill, listSkills, saveSkill } from "./lib/skillsManager.js";
import { aggregateUsage } from "./lib/usageStats.js";
import { Scheduler } from "./lib/scheduler.js";
import { WeChatBridge } from "./wechat/bridge.js";

const PORT = Number(process.env.PORT || 8080);
// 应用版本（显示在侧栏底部/系统页；版本没变 = 升级没生效）
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version || "dev";
  } catch {
    return "dev";
  }
})();
const APP_STARTED_AT = Date.now();
const CHANGELOG_PATH = new URL("../CHANGELOG.md", import.meta.url);
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const PI_AGENT_DIR = process.env.PI_AGENT_DIR || join(process.env.HOME || "/root", ".pi", "agent");
const SESSION_DIR = process.env.SESSION_DIR || join(DATA_DIR, "sessions");
const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT || "/workspace");
const WEB_ROOT = resolve(process.env.WEB_ROOT || join(process.cwd(), "web"));
// 跨源访问默认关闭：SPA 与 API 同源，不需要 CORS。确有跨源消费者（如外部脚本调 API）时
// 用 ALLOW_ORIGIN 显式开启（值即 Access-Control-Allow-Origin，如 https://example.com）。
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "";

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(SESSION_DIR, { recursive: true });
mkdirSync(PI_AGENT_DIR, { recursive: true });

// pi 只认 $HOME/.pi/agent，不认 PI_AGENT_DIR。若 PI_AGENT_DIR 是标准结构
// （.../.pi/agent），派生 HOME 指向其父目录，保证服务端与 pi 读写同一份配置、
// 会话与扩展（容器内 /data/.pi/agent ↔ HOME=/data，与镜像 ENV 一致）。
const agentDirMatch = PI_AGENT_DIR.match(/^(.*)[\\/]\.pi[\\/]agent[\\/]?$/);
if (agentDirMatch) process.env.HOME = agentDirMatch[1];

// 内置扩展（如 free-search 免 key 搜索）同步进 pi 的 extensions 目录，pi 进程启动即加载
const BUILTIN_EXTENSIONS_DIR = process.env.EXTENSIONS_SOURCE || join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");
syncBuiltinExtensions(BUILTIN_EXTENSIONS_DIR, join(PI_AGENT_DIR, "extensions"));

const auth = new Auth(join(DATA_DIR, "auth.json"), process.env.INITIAL_PASSWORD);
if (auth.bootstrapPassword) {
  console.log("========================================");
  console.log(`首次启动，随机管理密码：${auth.bootstrapPassword}`);
  console.log("请尽快登录后在「设置 → 密码」中修改。");
  console.log("========================================");
}

const sessions = new SessionManager(join(DATA_DIR, "projects.json"), SESSION_DIR);

/** 广播给所有已认证 WS 客户端（微信状态等全局事件）。 */
const wsClients = new Set();
function broadcast(channel, payload) {
  const frame = JSON.stringify({ type: "broadcast", channel, payload });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(frame);
  }
}

const wechat = new WeChatBridge({
  sessions,
  configPath: join(DATA_DIR, "wechat.json"),
  emit: broadcast,
  listProjects: () => sessions.listProjects(),
  botAgent: "PiNasDeck/0.1.0",
});
void wechat.start(); // 已启用且已登录时自动重连，否则内部短路

// 定时任务（日报等周期性产出）：产出写回项目文件，文件树时间倒序下自动置顶
const scheduler = new Scheduler({
  sessions,
  configPath: join(DATA_DIR, "scheduler.json"),
  emit: broadcast,
});

// ===== 路由处理函数约定：直接操作 res，或返回 {json} 由框架发送 =====

const routes = [
  ["POST", "/api/login", (body) => {
    if (!auth.verifyPassword(body?.password || "")) return { status: 401, json: { error: "密码错误" } };
    return { json: { token: auth.issueToken() } };
  }],

  ["POST", "/api/password", (body) => {
    if (!body?.password || String(body.password).length < 6) return { status: 400, json: { error: "密码至少 6 位" } };
    auth.setPassword(String(body.password));
    return { json: { ok: true } };
  }],

  // ===== 项目 =====

  ["GET", "/api/projects", () => ({ json: sessions.listProjects() })],

  ["POST", "/api/projects", (body) => {
    const path = String(body?.path || "").trim();
    if (!path) return { status: 400, json: { error: "缺少 path" } };
    const abs = resolve(path);
    // 安全：项目目录必须在 workspace 根之下（Docker 卷挂载范围）
    if (!abs.startsWith(WORKSPACE_ROOT + sep) && abs !== WORKSPACE_ROOT) {
      return { status: 400, json: { error: `项目目录必须位于 ${WORKSPACE_ROOT} 之下` } };
    }
    if (!existsSync(abs)) return { status: 400, json: { error: `目录不存在: ${abs}` } };
    return { json: sessions.addProject(body?.name, abs) };
  }],

  ["DELETE", "/api/projects", (body) => ({ json: { ok: sessions.removeProject(String(body?.id || "")) } })],

  // 目录浏览（仅 workspace 根内），添加项目时选路径用
  ["GET", "/api/dirs", (_body, query) => {
    const target = resolve(WORKSPACE_ROOT, query.get("path") || "");
    // 不能只 startsWith 根路径本身：否则兄弟目录（如 /workspace-evil）也能通过
    if (target !== WORKSPACE_ROOT && !target.startsWith(WORKSPACE_ROOT + sep)) {
      return { status: 400, json: { error: "越界" } };
    }
    if (!existsSync(target)) return { status: 404, json: { error: "不存在" } };
    const entries = readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    return { json: { path: target, parent: target === WORKSPACE_ROOT ? null : resolve(target, ".."), dirs: entries } };
  }],

  // 新建目录（仅 workspace 根内；添加项目选路径时用）
  ["POST", "/api/dirs", (body) => {
    const rel = String(body?.path || "").trim();
    const name = String(body?.name || "").trim();
    if (!name || !/^[^\\/:*?"<>|\x00-\x1f]{1,100}$/.test(name) || name === "." || name === "..") {
      return { status: 400, json: { error: "目录名不合法" } };
    }
    const parent = resolve(WORKSPACE_ROOT, rel);
    if (parent !== WORKSPACE_ROOT && !parent.startsWith(WORKSPACE_ROOT + sep)) {
      return { status: 400, json: { error: "越界" } };
    }
    if (!existsSync(parent)) return { status: 404, json: { error: "上级目录不存在" } };
    const target = join(parent, name);
    if (existsSync(target)) return { status: 409, json: { error: "同名目录已存在" } };
    mkdirSync(target, { recursive: true });
    return { json: { ok: true, path: target } };
  }],

  // ===== 文件管理：重命名 / 新建目录 / 复制 / 移动（右键菜单与剪贴板粘贴用） =====

  ["POST", "/api/fs/rename", async (body) => {
    const project = sessions.getProject(String(body?.project || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const rel = normalizeRelPath(String(body?.path || ""));
    const newName = String(body?.newName || "").trim();
    if (!rel) return { status: 400, json: { error: "缺少 path" } };
    if (!isValidFsName(newName)) return { status: 400, json: { error: "新名称不合法" } };
    const src = safeProjectPath(project.path, rel);
    if (!src) return { status: 400, json: { error: "越界" } };
    const parentRel = rel.split("/").slice(0, -1).join("/");
    const destRel = parentRel ? `${parentRel}/${newName}` : newName;
    const dest = safeProjectPath(project.path, destRel);
    if (!dest) return { status: 400, json: { error: "越界" } };
    try {
      const realRoot = realpathSync(resolve(project.path));
      const real = realpathSync(src);
      if (real === realRoot || !real.startsWith(realRoot + sep)) return { status: 400, json: { error: "越界" } };
      if (real.toLowerCase() !== (dest.toLowerCase())) {
        if (existsSync(dest)) return { status: 409, json: { error: "同名文件已存在" } };
      }
      await fsp.rename(real, dest);
      return { json: { ok: true, path: destRel } };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  ["POST", "/api/fs/mkdir", (body) => {
    const project = sessions.getProject(String(body?.project || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const parentRel = normalizeRelPath(String(body?.dirPath || ""));
    const name = String(body?.name || "").trim();
    if (!isValidFsName(name)) return { status: 400, json: { error: "目录名不合法" } };
    const parent = safeProjectPath(project.path, parentRel);
    if (!parent || !existsSync(parent) || !statSync(parent).isDirectory()) return { status: 400, json: { error: "上级目录不存在" } };
    const target = join(parent, name);
    if (existsSync(target)) return { status: 409, json: { error: "同名目录已存在" } };
    try {
      const realRoot = realpathSync(resolve(project.path));
      const realParent = realpathSync(parent);
      if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) return { status: 400, json: { error: "越界（符号链接）" } };
      mkdirSync(join(realParent, name), { recursive: true });
      return { json: { ok: true, path: parentRel ? `${parentRel}/${name}` : name } };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  ["POST", "/api/fs/copy", async (body) => handleFsTransfer(sessions, body, false)],
  ["POST", "/api/fs/move", async (body) => handleFsTransfer(sessions, body, true)],

  // PDF → Markdown（服务端提取文本，agent 只读文本省一个量级的 token；同目录 .md 侧文件做缓存）
  ["POST", "/api/fs/convert", async (body) => {
    const project = sessions.getProject(String(body?.project || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const rel = normalizeRelPath(String(body?.path || ""));
    if (!rel || !/\.pdf$/i.test(rel)) return { status: 400, json: { error: "仅支持 .pdf 文件" } };
    const target = safeProjectPath(project.path, rel);
    if (!target) return { status: 400, json: { error: "越界" } };
    try {
      const realRoot = realpathSync(resolve(project.path));
      const real = realpathSync(target);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return { status: 400, json: { error: "越界（符号链接）" } };
      const result = await convertPdfToMd(real);
      return { json: { ...result, rel: rel.replace(/\.pdf$/i, "") + ".md", project: project.id } };
    } catch (error) {
      const msg = String(error.message || "");
      return { status: msg.includes("不可用") || msg.includes("缺少") ? 501 : 400, json: { error: msg } };
    }
  }],

  // ===== 文件删除（文件或目录递归；禁删项目根，realpath 防 symlink 逃逸） =====

  ["DELETE", "/api/fs", (_body, query) => {
    const project = sessions.getProject(String(query.get("project") || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const rel = normalizeRelPath(query.get("path"));
    if (!rel) return { status: 400, json: { error: "不能删除项目根目录" } };
    const target = safeProjectPath(project.path, rel);
    if (!target) return { status: 400, json: { error: "越界" } };
    try {
      const realRoot = realpathSync(resolve(project.path));
      const real = realpathSync(target);
      if (real === realRoot || !real.startsWith(realRoot + sep)) return { status: 400, json: { error: "越界" } };
      rmSync(real, { recursive: true, force: false });
      return { json: { ok: true, path: rel } };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  // ===== 文件树 / 文件预览（只读，限项目目录内） =====
  // 树按目录懒加载（展开才请求），预览限读前 1MiB，二进制只报元信息。

  ["GET", "/api/fs/tree", (_body, query) => {
    const project = sessions.getProject(String(query.get("project") || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const rel = normalizeRelPath(query.get("path"));
    const target = safeProjectPath(project.path, rel);
    if (!target) return { status: 400, json: { error: "越界" } };
    if (!existsSync(target)) return { status: 404, json: { error: "不存在" } };
    let stat;
    try {
      stat = statSync(target);
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
    if (!stat.isDirectory()) return { status: 400, json: { error: "不是目录" } };
    let entries;
    try {
      entries = readdirSync(target, { withFileTypes: true });
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
    const MAX_ENTRIES = 500;
    const sort = query.get("sort") === "time" ? "time" : "name"; // time=按修改时间倒序（新文件置顶）
    const list = [];
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      const isDir = entry.isDirectory();
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = statSync(join(target, entry.name));
        size = isDir ? 0 : st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        /* 瞬态消失按 0 */
      }
      list.push({ name: entry.name, type: isDir ? "dir" : "file", size, mtimeMs });
    }
    const collator = new Intl.Collator("zh");
    if (sort === "time") list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    else list.sort((a, b) => (a.type === b.type ? collator.compare(a.name, b.name) : a.type === "dir" ? -1 : 1));
    const parentRel = rel ? rel.split("/").slice(0, -1).join("/") : null;
    return { json: { path: rel, parent: parentRel, entries: list, truncated: entries.length > MAX_ENTRIES } };
  }],

  ["GET", "/api/fs/file", (_body, query) => {
    const project = sessions.getProject(String(query.get("project") || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const rel = normalizeRelPath(query.get("path"));
    if (!rel) return { status: 400, json: { error: "缺少 path" } };
    const full = query.get("full") === "1"; // 编辑模式：全量读取（上限 10MiB），防保存时截断超长文件
    const target = safeProjectPath(project.path, rel);
    if (!target) return { status: 400, json: { error: "越界" } };
    // symlink 逃逸防护：真实路径（resolve 后）也必须落在项目根内
    try {
      const realRoot = realpathSync(resolve(project.path));
      const real = realpathSync(target);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        return { status: 400, json: { error: "越界（符号链接）" } };
      }
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
    let stat;
    try {
      stat = statSync(target);
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
    if (!stat.isFile()) return { status: 400, json: { error: "不是文件" } };
    const ext = extname(target).toLowerCase();
    // Word 文档：docx 提取正文（zip 完整读取 ≤50MB）；老格式无转换工具，提示转新格式
    if (ext === ".docx" && stat.size <= DOCX_MAX_BYTES) {
      try {
        const text = extractDocxText(readFileSync(target));
        return { json: { name: rel.split("/").pop(), path: rel, size: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs, kind: "docx", binary: false, truncated: false, content: text } };
      } catch (error) {
        return { json: { name: rel.split("/").pop(), path: rel, size: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs, kind: "docx-broken", binary: false, truncated: false, content: `（docx 解析失败：${error.message}）` } };
      }
    }
    if (ext === ".doc" || ext === ".xls" || ext === ".ppt") {
      return { json: { name: rel.split("/").pop(), path: rel, size: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs, kind: "legacy-office", binary: false, truncated: false, content: "" } };
    }
    const READ_LIMIT = full ? 10 * 1024 * 1024 : 1024 * 1024; // 预览限读前 1MiB；编辑模式全量（≤10MiB）
    const toRead = Math.min(stat.size, READ_LIMIT);
    const buf = Buffer.alloc(toRead);
    let read = 0;
    if (toRead) {
      const fd = openSync(target, "r");
      try {
        read = readSync(fd, buf, 0, toRead, 0);
      } finally {
        closeSync(fd);
      }
    }
    const binary = buf.subarray(0, Math.min(read, 8192)).includes(0); // 首 8KB 含 NUL 判定为二进制
    return {
      json: {
        name: rel.split("/").pop(),
        path: rel,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        binary,
        truncated: stat.size > read,
        content: binary ? "" : buf.subarray(0, read).toString("utf8"),
      },
    };
  }],

  // ===== 会话 =====

  ["GET", "/api/sessions", (_body, query) => ({
    json: sessions.listSessions(query.get("project") || "", { includeArchived: query.get("archived") === "1" }),
  })],

  // 会话全文搜索（关键词 ≥2 字符；默认排除归档、最多 30 条结果）
  ["GET", "/api/search", async (_body, query) => {
    const q = String(query.get("q") || "").trim();
    if (q.length < 2) return { status: 400, json: { error: "关键词至少 2 个字符" } };
    return {
      json: await sessions.searchSessions(q, {
        projectId: String(query.get("project") || ""),
        includeArchived: query.get("archived") === "1",
        limit: Math.min(Number(query.get("limit")) || 30, 100),
      }),
    };
  }],

  ["POST", "/api/sessions/archive", (body) => {
    try {
      return { json: sessions.setArchived(String(body?.sessionFile || ""), !!body?.archived) };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  ["POST", "/api/sessions/close", (body) => ({
    json: sessions.closeSession(String(body?.sessionFile || "")),
  })],

  ["DELETE", "/api/sessions", (body) => {
    try {
      return { json: { ok: sessions.deleteSession(String(body?.sessionFile || "")) } };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  // ===== 附件上传（非图片文件；图片走 WS prompt 的 images 字段不落盘） =====
  // 上传到 /data/uploads，把绝对路径附在 prompt 文本里，agent 用 read 工具直接读。
  ["POST", "/api/upload", (body) => {
    const name = sanitizeUploadName(body?.name);
    const data = body?.data; // base64（不含 data: 前缀）
    if (!name || !data) return { status: 400, json: { error: "缺少 name/data" } };
    let buffer;
    try {
      buffer = Buffer.from(String(data), "base64");
    } catch {
      return { status: 400, json: { error: "base64 解码失败" } };
    }
    if (!buffer.length) return { status: 400, json: { error: "空文件" } };
    if (buffer.length > 50 * 1024 * 1024) return { status: 413, json: { error: "文件超过 50MB" } };
    const dir = join(DATA_DIR, "uploads");
    mkdirSync(dir, { recursive: true });
    const saved = join(dir, `${Date.now()}-${name}`);
    writeFileSync(saved, buffer);
    return { json: { path: saved, name, size: buffer.length } };
  }],

  // ===== 模型配置 =====

  ["GET", "/api/models", () => {
    try {
      return { json: readModels() };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  ["PUT", "/api/models", (body) => {
    try {
      writeModels(body);
      return { json: { ok: true } };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  ["POST", "/api/models/test", async (body) => ({ json: await testConnection(body || {}) })],

  // 按 baseUrl 拉取模型清单（服务端代抓，绕开浏览器 CORS；供供应商表单勾选添加）
  ["POST", "/api/models/fetch", async (body) => {
    const baseUrl = String(body?.baseUrl || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrl)) return { status: 400, json: { error: "baseUrl 必须是 http(s) 地址" } };
    const apiKey = String(body?.apiKey || "");
    const anthropic = body?.api === "anthropic-messages";
    const candidates = [...new Set([`${baseUrl}/models`, `${baseUrl}/v1/models`, `${baseUrl.replace(/\/v1$/, "")}/models`])];
    let lastErr = "";
    for (const url of candidates) {
      try {
        const headers = anthropic
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : apiKey
            ? { authorization: `Bearer ${apiKey}` }
            : {};
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          lastErr = `HTTP ${res.status}（${url}）`;
          continue;
        }
        const data = await res.json();
        const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : null;
        if (!list) {
          lastErr = `响应不是模型清单格式（${url}）`;
          continue;
        }
        const models = list.map((m) => String(m?.id || m?.name || "").trim()).filter(Boolean).slice(0, 200);
        return { json: { models, url } };
      } catch (error) {
        lastErr = `${error?.message || error}（${url}）`;
      }
    }
    return { status: 400, json: { error: `获取模型列表失败：${lastErr}` } };
  }],

  // ===== 用量统计（聚合 pi 的 analytics/usage.jsonl，按日/月 × 模型 × 项目） =====

  ["GET", "/api/usage", async (_body, query) => {
    // 价格表：models.json 的 model.cost（USD/百万 token）→ {"provider/model": cost}
    let providers = {};
    try {
      providers = readModels().providers || {};
    } catch {
      /* 配置缺失时无价格，只统计 token */
    }
    const costs = {};
    for (const [pname, prov] of Object.entries(providers)) {
      for (const m of prov.models || []) {
        if (m?.id && m.cost && typeof m.cost === "object") costs[`${pname}/${m.id}`] = m.cost;
      }
    }
    return {
      json: await aggregateUsage(PI_AGENT_DIR, {
        group: query.get("group") === "month" ? "month" : "day",
        projects: sessions.listProjects(),
        costs,
      }),
    };
  }],

  // ===== MCP 配置（$PI_AGENT_DIR/mcp.json；改动对新会话生效，已开会话需关闭重开） =====

  ["GET", "/api/mcp", () => ({ json: { servers: readMcpConfig(PI_AGENT_DIR) } })],

  ["PUT", "/api/mcp", (body) => {
    try {
      return { json: { servers: writeMcpConfig(PI_AGENT_DIR, body?.servers || {}) } };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  // ===== Skills（$PI_AGENT_DIR/skills/<name>/SKILL.md；新建/覆盖/删除） =====

  ["GET", "/api/skills", (_body, query) => {
    const name = query.get("name");
    if (!name) return { json: { skills: listSkills(PI_AGENT_DIR) } };
    try {
      return { json: { name, content: getSkill(PI_AGENT_DIR, name) } };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  ["PUT", "/api/skills", (body) => {
    try {
      return { json: saveSkill(PI_AGENT_DIR, String(body?.name || ""), body?.content) };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  ["DELETE", "/api/skills", (_body, query) => {
    try {
      return { json: deleteSkill(PI_AGENT_DIR, String(query.get("name") || "")) };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  // ===== 更新说明（CHANGELOG.md 随包分发进镜像；缺失返回空串不报错） =====

  ["GET", "/api/changelog", () => {
    let changelog = "";
    try {
      changelog = readFileSync(CHANGELOG_PATH, "utf8");
    } catch {
      /* 容器里未打包时降级为空 */
    }
    return { json: { version: APP_VERSION, changelog } };
  }],

  // ===== 笔记库（Obsidian 式）：md 索引 / 入链 / 保存 =====

  // 全部 .md 清单（链接解析 + [[ 插入选择器用）；跳过 .git/node_modules 等重目录
  ["GET", "/api/fs/md-index", (_body, query) => {
    const project = sessions.getProject(String(query.get("project") || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const { files, truncated } = collectMdFiles(resolve(project.path));
    return { json: { files, truncated } };
  }],

  // 入链（backlinks）：哪些 md 引用了本文；流式扫描预算同全文搜索（≤300 文件/10s）
  ["GET", "/api/fs/backlinks", (_body, query) => {
    const project = sessions.getProject(String(query.get("project") || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const rel = normalizeRelPath(query.get("path"));
    const target = safeProjectPath(project.path, rel);
    if (!target || !/\.md$/i.test(rel)) return { json: { links: [], scanned: 0, truncated: false } };
    const base = rel.split("/").pop().replace(/\.md$/i, "");
    const deadline = Date.now() + 10_000;
    const { files } = collectMdFiles(resolve(project.path), { maxFiles: 3000 });
    const links = [];
    let scanned = 0;
    let truncated = false;
    outer: for (const file of files) {
      if (file === rel) continue;
      if (scanned >= 300 || Date.now() > deadline) {
        truncated = true;
        break;
      }
      let text;
      try {
        const full = join(resolve(project.path), file);
        if (statSync(full).size > 1024 * 1024) continue; // 超大笔记不扫（预算保护）
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      scanned++;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes("[[") && !line.includes("](")) continue;
        if (!lineReferences(line, base, rel)) continue;
        links.push({ file, line: i + 1, snippet: line.trim().replace(/\s+/g, " ").slice(0, 160) });
        if (links.length >= 100) {
          truncated = true;
          break outer;
        }
      }
    }
    return { json: { links, scanned, truncated } };
  }],

  // 保存 md（编辑模式）：原子写 + mtime 冲突防护（打开后被改过则拒，防覆盖）
  ["PUT", "/api/fs/file", (body) => {
    const project = sessions.getProject(String(body?.project || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const rel = normalizeRelPath(String(body?.path || ""));
    if (!rel || !/\.(md|markdown|txt|json)$/i.test(rel)) return { status: 400, json: { error: "仅支持 .md/.txt/.json 文件" } };
    if (typeof body?.content !== "string") return { status: 400, json: { error: "缺少 content" } };
    if (Buffer.byteLength(body.content, "utf8") > 10 * 1024 * 1024) return { status: 400, json: { error: "内容超过 10MB 上限" } };
    const target = safeProjectPath(project.path, rel);
    if (!target) return { status: 400, json: { error: "越界" } };
    try {
      const realRoot = realpathSync(resolve(project.path));
      let real;
      if (!existsSync(target)) {
        // 新建（新建文件按钮）：上级目录必须存在；无 mtime 冲突可言
        const parentRel2 = rel.split("/").slice(0, -1).join("/");
        const parentDir = parentRel2 ? safeProjectPath(project.path, parentRel2) : resolve(project.path);
        if (!parentDir || !existsSync(parentDir) || !statSync(parentDir).isDirectory()) return { status: 400, json: { error: "上级目录不存在" } };
        const realParent = realpathSync(parentDir);
        if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) return { status: 400, json: { error: "越界（符号链接）" } };
        real = join(realParent, basename(rel));
      } else {
        real = realpathSync(target);
        if (real !== realRoot && !real.startsWith(realRoot + sep)) return { status: 400, json: { error: "越界（符号链接）" } };
        if (!statSync(real).isFile()) return { status: 400, json: { error: "不是文件" } };
        const expected = Number(body?.expectedMtimeMs);
        if (Number.isFinite(expected) && expected > 0) {
          const current = statSync(real).mtimeMs;
          if (Math.abs(current - expected) > 1) {
            return { status: 409, json: { error: "文件在打开后被修改过，请刷新再编辑（避免覆盖别处的改动）" } };
          }
        }
      }
      const tmp = `${real}.pnd-saving`;
      writeFileSync(tmp, body.content, "utf8");
      renameSync(tmp, real);
      return { json: { ok: true, path: rel, mtimeMs: statSync(real).mtimeMs } };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  // ===== 定时任务（日报/周报等周期性产出） =====

  ["GET", "/api/scheduler", () => ({ json: scheduler.getStatus() })],

  ["POST", "/api/scheduler/task", (body) => {
    try {
      return { json: scheduler.upsertTask(body || {}) };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  ["DELETE", "/api/scheduler/task", (body, query) => ({ json: scheduler.removeTask(String(query.get("id") || "")) })],

  ["POST", "/api/scheduler/run", async (body) => {
    try {
      return { json: await scheduler.runNow(String(body?.id || "")) };
    } catch (error) {
      return { status: 400, json: { error: error.message } };
    }
  }],

  // 本轮产出：turnStart 后项目内新增/修改的文件（对话结束时列在回答下方，可点开）
  ["GET", "/api/fs/changed-since", async (_body, query) => {
    const project = sessions.getProject(String(query.get("project") || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const since = Number(query.get("since"));
    if (!Number.isFinite(since) || since <= 0) return { status: 400, json: { error: "缺少 since" } };
    const skip = new Set([".git", "node_modules", ".pnd-ask", ".obsidian"]);
    const files = [];
    let checked = 0;
    let truncated = false;
    const deadline = Date.now() + 3000;
    const walk = async (dir, rel) => {
      if (truncated) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= 200 || checked >= 20000 || Date.now() >= deadline) {
          truncated = true;
          return;
        }
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!skip.has(entry.name) && !entry.name.startsWith(".")) await walk(join(dir, entry.name), childRel);
        } else {
          checked++;
          try {
            const st = await fsp.lstat(join(dir, entry.name));
            if (st.mtimeMs >= since && st.size > 0) files.push({ path: childRel, size: st.size, mtimeMs: st.mtimeMs });
          } catch {
            /* 瞬态消失 */
          }
        }
      }
    };
    await walk(resolve(project.path), "");
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { json: { files, checked, truncated } };
  }],

  // 文件名搜索（全库模糊匹配，供 Ctrl+K 面板；跳过点目录/依赖目录）
  ["GET", "/api/fs/search", async (_body, query) => {
    const project = sessions.getProject(String(query.get("project") || ""));
    if (!project) return { status: 404, json: { error: "项目不存在" } };
    const q = String(query.get("q") || "").trim().toLowerCase();
    if (!q) return { json: { files: [], truncated: false } };
    const skip = new Set([".git", "node_modules", ".pnd-ask", ".obsidian", "__pycache__"]);
    const files = [];
    let checked = 0;
    let truncated = false;
    const deadline = Date.now() + 3000;
    const walk = async (dir, rel) => {
      if (truncated) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= 100 || checked >= 20000 || Date.now() >= deadline) {
          truncated = true;
          return;
        }
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!skip.has(entry.name) && !entry.name.startsWith(".")) await walk(join(dir, entry.name), childRel);
        } else {
          checked++;
          const lower = entry.name.toLowerCase();
          const at = lower.indexOf(q);
          if (at >= 0) files.push({ path: childRel, name: entry.name, score: at === 0 ? 0 : 1 });
        }
      }
    };
    await walk(resolve(project.path), "");
    files.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
    return { json: { files: files.slice(0, 50), truncated } };
  }],

  // ===== 会话进程池（内存治理：查看/手动挂起） =====
  ["GET", "/api/sessions/processes", () => ({ json: { processes: sessions.listProcesses(), limits: sessions.limits } })],

  ["POST", "/api/sessions/suspend", (body) => ({ json: sessions.suspend(String(body?.key || "")) })],

  // ===== 系统 / pi 更新 =====

  ["GET", "/api/system", async () => {
    const [piVersion, latest] = await Promise.all([getPiVersion(), getLatestPiVersion()]);
    return {
      json: {
        appVersion: APP_VERSION,
        appBuildDate: process.env.PND_BUILD_DATE || "unknown",
        appStartedAt: APP_STARTED_AT,
        serverTz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        piVersion,
        latestPiVersion: latest,
        updateAvailable: !!(piVersion && latest && piVersion !== latest),
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`,
        workspaceRoot: WORKSPACE_ROOT,
      },
    };
  }],

  ["POST", "/api/system/update-pi", async (_body, _query, res) => {
    // SSE 推进度
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const push = (chunk) => res.write(`data: ${JSON.stringify({ log: chunk })}\n\n`);
    const result = await updatePi(push);
    res.write(`data: ${JSON.stringify({ done: true, ok: result.ok, detail: result.detail })}\n\n`);
    res.end();
    return { handled: true };
  }],

  // ===== 微信（多账号：两个槽位 a1/a2，路由统一下发 accountId） =====

  ["GET", "/api/wechat", () => ({ json: wechat.getStatus() })],

  ["POST", "/api/wechat/login", async (body) => {
    try {
      const state = await wechat.beginLogin(String(body?.accountId || "a1"));
      const qrDataUrl = state.qrcodeContent ? await QRCode.toDataURL(state.qrcodeContent, { margin: 1, width: 280 }) : null;
      return { json: { ...state, qrDataUrl } };
    } catch (error) {
      return { status: 500, json: { error: error.message } };
    }
  }],

  ["POST", "/api/wechat/login/cancel", (body) => {
    wechat.cancelLogin(String(body?.accountId || ""));
    return { json: { ok: true } };
  }],

  ["POST", "/api/wechat/logout", async (body) => {
    await wechat.logout(String(body?.accountId || "a1"));
    return { json: { ok: true } };
  }],

  ["POST", "/api/wechat/enabled", (body) => ({ json: wechat.setEnabled(!!body?.enabled) })],

  ["POST", "/api/wechat/default-project", (body) => ({ json: wechat.setDefaultProject(body?.projectId || null) })],

  ["POST", "/api/wechat/account-default-project", (body) => ({
    json: wechat.setAccountDefaultProject(String(body?.accountId || ""), body?.projectId || null),
  })],

  ["DELETE", "/api/wechat/bindings", (body) => {
    wechat.unbind(String(body?.accountId || ""), String(body?.chatId || ""));
    return { json: { ok: true } };
  }],
];

// ===== HTTP =====

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

const FS_UPLOAD_MAX_BYTES = 500 * 1024 * 1024; // 单文件上传上限 500MB
const DOCX_MAX_BYTES = 50 * 1024 * 1024; // docx 文本提取需完整读 zip，限 50MB

// /preview/ 路由的 content-type 表（HTML 预览的相对资源：css/js/字体/图片/音视频）
const PREVIEW_MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

// 隔离源（sandbox 无 allow-same-origin）里访问 localStorage/sessionStorage 会抛
// SecurityError，大量 HTML 页面顶层一碰就白屏——注入桩对象兕底（仅 shim=1 时）。
const STORAGE_SHIM =
  '<script>(function(){var s={getItem:function(){return null},setItem:function(){},removeItem:function(){},clear:function(){},key:function(){return null}};Object.defineProperty(s,"length",{value:0});try{Object.defineProperty(window,"localStorage",{value:s,configurable:true})}catch(e){}try{Object.defineProperty(window,"sessionStorage",{value:s,configurable:true})}catch(e){}try{window.indexedDB={open:function(){return{result:null,error:new Error("preview: storage blocked")}}}}catch(e){}})();</script>';

function injectStorageShim(html) {
  const m = html.match(/<head[^>]*>/i);
  if (m && m.index !== undefined) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + STORAGE_SHIM + html.slice(at);
  }
  return STORAGE_SHIM + html;
}

// /api/fs/raw 的 content-type 白名单（预览场景，其余按二进制下载）
const RAW_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (ALLOW_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PUT,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // ===== 文件上传（流式裸字节，绕开 JSON body 70MB 限制，大文件直写磁盘） =====
  // 在通用分发之前处理：POST /api/fs/upload?project=&path=<目标文件相对路径>，body 即文件内容。
  // ===== HTML 预览专用路径路由：/preview/<token>/<project>/<相对路径> =====
  // token 在路径里 → HTML 的相对引用（css/js/图片）自动落在同一前缀下，无需逐个授权；
  // ?shim=1 时向 html 注入存储垫片（隔离源里 localStorage 访问会抛 SecurityError，垫片兑底）。
  if (req.method === "GET" && path.startsWith("/preview/")) {
    const segments = path.slice("/preview/".length).split("/").map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return "";
      }
    });
    const [token, projectId, ...relSegs] = segments;
    if (!auth.verifyToken(token || "")) {
      sendJson(res, 401, { error: "未认证" });
      return;
    }
    const project = sessions.getProject(projectId || "");
    const rel = normalizeRelPath(relSegs.join("/"));
    const target = project && rel ? safeProjectPath(project.path, rel) : null;
    if (!target) {
      sendJson(res, 400, { error: "越界" });
      return;
    }
    try {
      const realRoot = realpathSync(resolve(project.path));
      const real = realpathSync(target);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        sendJson(res, 400, { error: "越界（符号链接）" });
        return;
      }
      const stat = statSync(real);
      if (!stat.isFile()) {
        sendJson(res, 404, { error: "不存在" });
        return;
      }
      const ext = extname(real).toLowerCase();
      const wantShim = url.searchParams.get("shim") === "1" && ext === ".html";
      if (wantShim) {
        const buf = Buffer.from(injectStorageShim(readFileSync(real, "utf8")), "utf8");
        res.writeHead(200, {
          "content-type": PREVIEW_MIME[ext] || "application/octet-stream",
          "content-length": buf.length,
          "cache-control": "no-cache",
        });
        res.end(buf);
      } else {
        res.writeHead(200, {
          "content-type": PREVIEW_MIME[ext] || "application/octet-stream",
          "content-length": stat.size,
          "cache-control": "no-cache",
        });
        createReadStream(real).pipe(res);
      }
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && path === "/api/fs/upload") {
    if (!auth.verifyToken(bearer(req) || url.searchParams.get("token"))) {
      sendJson(res, 401, { error: "未认证" });
      return;
    }
    const project = sessions.getProject(String(url.searchParams.get("project") || ""));
    if (!project) {
      sendJson(res, 404, { error: "项目不存在" });
      return;
    }
    const rel = normalizeRelPath(url.searchParams.get("path"));
    if (!rel) {
      sendJson(res, 400, { error: "缺少目标文件路径" });
      return;
    }
    const target = safeProjectPath(project.path, rel);
    if (!target) {
      sendJson(res, 400, { error: "越界" });
      return;
    }
    const tmp = `${target}.pnd-uploading`;
    try {
      mkdirSync(dirname(target), { recursive: true });
      // symlink 防御：落盘目录的真实路径也必须在项目根内
      const realRoot = realpathSync(resolve(project.path));
      const realParent = realpathSync(dirname(target));
      if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
        sendJson(res, 400, { error: "越界（符号链接）" });
        return;
      }
      const size = await streamToDisk(req, tmp, FS_UPLOAD_MAX_BYTES);
      renameSync(tmp, target);
      sendJson(res, 200, { ok: true, path: rel, size });
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* 临时文件可能不存在 */
      }
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // ===== 原始字节流（图片/PDF 预览用 <img>/<iframe> 直连；token 走 query，浏览器 img 发不了 header） =====
  if (req.method === "GET" && path === "/api/fs/raw") {
    if (!auth.verifyToken(bearer(req) || url.searchParams.get("token"))) {
      sendJson(res, 401, { error: "未认证" });
      return;
    }
    const project = sessions.getProject(String(url.searchParams.get("project") || ""));
    const rel = normalizeRelPath(url.searchParams.get("path"));
    const target = project && rel ? safeProjectPath(project.path, rel) : null;
    if (!target) {
      sendJson(res, 400, { error: "越界" });
      return;
    }
    try {
      const realRoot = realpathSync(resolve(project.path));
      const real = realpathSync(target);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        sendJson(res, 400, { error: "越界（符号链接）" });
        return;
      }
      const stat = statSync(real);
      if (!stat.isFile()) {
        sendJson(res, 400, { error: "不是文件" });
        return;
      }
      res.writeHead(200, {
        "content-type": RAW_MIME[extname(real).toLowerCase()] || "application/octet-stream",
        "content-length": stat.size,
        "cache-control": "no-cache",
      });
      createReadStream(real).pipe(res);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (path.startsWith("/api/")) {
    const route = routes.find(([method, prefix]) => req.method === method && path === prefix);
    if (!route) return sendJson(res, 404, { error: "not found" });
    if (path !== "/api/login" && !auth.verifyToken(bearer(req) || url.searchParams.get("token"))) {
      return sendJson(res, 401, { error: "未认证" });
    }
    try {
      const body = ["POST", "PUT", "DELETE"].includes(req.method) ? await readBody(req) : null;
      const result = await route[2](body, url.searchParams, res);
      if (result?.handled || res.writableEnded) return;
      sendJson(res, result?.status || 200, result?.json ?? { ok: true });
    } catch (error) {
      if (!res.writableEnded) sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // 静态文件（SPA fallback 到 index.html）
  let filePath = resolve(join(WEB_ROOT, path === "/" ? "index.html" : path));
  // 同 /api/dirs 的教训：resolve 归一化后再比对，且带分隔符防前缀兄弟目录
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + sep)) {
    res.writeHead(403);
    return res.end();
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(WEB_ROOT, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(filePath).pipe(res);
});

// ===== WebSocket =====

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") return socket.destroy();
  if (!auth.verifyToken(url.searchParams.get("token") || "")) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  wsClients.add(ws);
  /** 本连接订阅：key -> {proc, handler} */
  const subscriptions = new Map();

  ws.on("close", () => {
    wsClients.delete(ws);
    // 进程不随连接关闭：刷新页面后会话仍在；空闲超时由 SessionManager 回收
    for (const { proc, handler } of subscriptions.values()) proc.off("event", handler);
    subscriptions.clear();
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.type === "attach") {
        const { key, state } = await sessions.open(msg.projectId, msg.sessionFile || null, msg.name);
        const proc = sessions.get(key);
        const handler = (record) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: "event", key, record }));
        };
        proc.on("event", handler);
        subscriptions.set(key, { proc, handler });
        ws.send(JSON.stringify({ type: "attached", key, state }));
      } else if (msg.type === "rpc") {
        const entry = subscriptions.get(msg.key);
        const proc = entry?.proc || sessions.get(msg.key);
        if (!proc) return ws.send(JSON.stringify({ type: "rpc-result", id: msg.id, ok: false, error: "会话未打开" }));
        try {
          const data = await proc.request(msg.command, msg.timeoutMs);
          ws.send(JSON.stringify({ type: "rpc-result", id: msg.id, ok: true, data }));
        } catch (error) {
          ws.send(JSON.stringify({ type: "rpc-result", id: msg.id, ok: false, error: error.message }));
        }
      } else if (msg.type === "ui-response") {
        // 扩展 UI 子协议：客户端回答（不等 pi 回响应，单向写 stdin）
        const entry = subscriptions.get(msg.key);
        const proc = entry?.proc || sessions.get(msg.key);
        if (proc) proc.send({ type: "extension_ui_response", ...msg.payload });
      } else if (msg.type === "detach") {
        const entry = subscriptions.get(msg.key);
        if (entry) entry.proc.off("event", entry.handler);
        subscriptions.delete(msg.key);
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", error: error.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`PiNasDeck 已启动: http://0.0.0.0:${PORT}`);
  console.log(`workspace 根目录: ${WORKSPACE_ROOT}`);
  console.log(`pi agent 目录:   ${PI_AGENT_DIR}`);
});

process.on("SIGTERM", () => {
  sessions.closeAll();
  void wechat.stop().then(() => process.exit(0));
});

// ===== 小工具 =====

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 70 * 1024 * 1024) {
        // 50MB 文件 base64 后约 67MB，留点余量
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolvePromise(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

/** 上传文件名消毒：去路径分隔符、控制字符，限长。 */
function sanitizeUploadName(name) {
  if (!name) return "";
  const base = String(name).split(/[\\/]/).pop() || "file";
  return base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").slice(0, 100) || "file";
}

/** 递归收集项目内 md 文件（跳过 .git/node_modules/点开头目录；上限防大库拖垮）。 */
function collectMdFiles(root, { maxFiles = 5000 } = {}) {
  const out = [];
  let truncated = false;
  const skip = new Set([".git", "node_modules"]);
  const walk = (dir, rel) => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (/\.(md|markdown)$/i.test(entry.name)) {
        out.push(rel ? `${rel}/${entry.name}` : entry.name);
        if (out.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  };
  walk(root, "");
  return { files: out.sort(), truncated };
}

/** 一行文本是否引用了目标笔记（wiki [[x]] / [[dir/x]] / 相对链接 x.md）。 */
function lineReferences(line, base, relPath) {
  const baseLc = base.toLowerCase();
  let m;
  const wikiRe = /\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g;
  while ((m = wikiRe.exec(line))) {
    const target = m[1].trim().replace(/\.md$/i, "").toLowerCase();
    if (target === baseLc || target.endsWith("/" + baseLc)) return true;
  }
  const hrefRe = /\]\(([^)\s]+)\)/g;
  const relLc = relPath.toLowerCase();
  while ((m = hrefRe.exec(line))) {
    let href = m[1].toLowerCase();
    const hash = href.indexOf("#");
    if (hash >= 0) href = href.slice(0, hash);
    try {
      href = decodeURIComponent(href);
    } catch {
      /* 编码坏了就按原样比 */
    }
    if (href.endsWith(baseLc + ".md") || href === relLc) return true;
  }
  return false;
}

/** 把请求体流式写入磁盘（带大小上限与背压处理），返回写入字节数。 */
function streamToDisk(req, filePath, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    const out = createWriteStream(filePath);
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(error);
    };
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        return fail(new Error(`文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`));
      }
      if (!out.write(chunk)) req.pause(); // 背压：磁盘慢时暂停读请求
    });
    out.on("drain", () => req.resume());
    let ending = false; // end 已到、等待落盘完成（此间 close 属正常收尾，不算中断）
    req.on("end", () => {
      if (settled || ending) return;
      ending = true;
      out.end(() => {
        if (settled) return;
        settled = true;
        resolvePromise(total);
      });
    });
    // 客户端中途断开（点取消/断网）：及时失败，路由层清掉半截 tmp 文件
    req.on("close", () => {
      if (!settled && !ending) fail(new Error("上传中断"));
    });
    req.on("error", fail);
    out.on("error", fail);
  });
}

/** 文件/目录名合法性（与 mkdir 路由同款白名单）。 */
function isValidFsName(name) {
  return !!name && /^[^\\/:*?"<>|\x00-\x1f]{1,100}$/.test(name) && name !== "." && name !== "..";
}

const FS_COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 复制/移动预算：2GB
const FS_COPY_MAX_FILES = 20_000;

/** 异步统计路径规模（文件数/字节数），超预算即抛（防大目录拖垮/阻塞）。 */
async function measurePath(p) {
  const st = await fsp.lstat(p);
  if (st.isSymbolicLink()) return { files: 1, bytes: 0 };
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  const walk = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const s = await fsp.lstat(join(dir, entry.name));
      if (s.isDirectory()) await walk(join(dir, entry.name));
      else {
        files++;
        bytes += s.size;
      }
      if (files > FS_COPY_MAX_FILES || bytes > FS_COPY_MAX_BYTES) throw new Error(`超出预算（上限 ${FS_COPY_MAX_FILES} 文件 / 2GB）`);
    }
  };
  await walk(p);
  return { files, bytes };
}

/** 复制/移动通用处理：越界/子树/重名/预算全护栏；move 优先 rename，跨盘降级 copy+rm。 */
async function handleFsTransfer(sessions, body, isMove) {
  const fromProject = sessions.getProject(String(body?.fromProject || ""));
  const toProject = sessions.getProject(String(body?.toProject || body?.fromProject || ""));
  if (!fromProject || !toProject) return { status: 404, json: { error: "项目不存在" } };
  const fromRel = normalizeRelPath(String(body?.fromPath || ""));
  const toRel = normalizeRelPath(String(body?.toPath || ""));
  if (!fromRel || !toRel) return { status: 400, json: { error: "缺少路径" } };
  const src = safeProjectPath(fromProject.path, fromRel);
  const dest = safeProjectPath(toProject.path, toRel);
  if (!src || !dest) return { status: 400, json: { error: "越界" } };
  // 目录不能拷贝/移动进自己的子树（递归炸弹）
  if (fromProject.id === toProject.id && (toRel === fromRel || toRel.startsWith(fromRel + "/"))) {
    return { status: 400, json: { error: "不能把目录拷贝/移动到它自己的子目录" } };
  }
  if (existsSync(dest)) return { status: 409, json: { error: "目标已存在" } };
  try {
    const realRoot = realpathSync(resolve(fromProject.path));
    const realSrc = realpathSync(src);
    if (realSrc === realRoot || !realSrc.startsWith(realRoot + sep)) return { status: 400, json: { error: "越界" } };
    const destParentRel = toRel.split("/").slice(0, -1).join("/");
    const destParent = destParentRel ? safeProjectPath(toProject.path, destParentRel) : resolve(toProject.path);
    if (!destParent || !existsSync(destParent) || !statSync(destParent).isDirectory()) return { status: 400, json: { error: "目标目录不存在" } };
    const realToRoot = realpathSync(resolve(toProject.path));
    const realParent = realpathSync(destParent);
    if (realParent !== realToRoot && !realParent.startsWith(realToRoot + sep)) return { status: 400, json: { error: "越界（符号链接）" } };
    const budget = await measurePath(realSrc);
    const destPath = join(realParent, basename(toRel));
    if (isMove) {
      try {
        await fsp.rename(realSrc, destPath);
      } catch (error) {
        if (error.code !== "EXDEV") throw error;
        // 跨设备：降级 copy + rm（fs.promises.cp 为异步实现，不阻塞事件循环）
        await fsp.cp(realSrc, destPath, { recursive: true, force: false, errorOnExist: true });
        await fsp.rm(realSrc, { recursive: true });
      }
    } else {
      await fsp.cp(realSrc, destPath, { recursive: true, force: false, errorOnExist: true });
    }
    return { json: { ok: true, path: toRel, files: budget.files, bytes: budget.bytes } };
  } catch (error) {
    return { status: 400, json: { error: error.message } };
  }
}

/** 项目内相对路径归一化：反斜杠转正斜杠、去首尾斜杠。 */
function normalizeRelPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** 把项目内相对路径解析为绝对路径；越界（..、前缀兄弟目录、NUL）返回 null。 */
function safeProjectPath(rootRaw, rel) {
  if (rel.includes("\0")) return null;
  if (rel.split("/").some((seg) => seg === "..")) return null;
  const root = resolve(rootRaw);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}
