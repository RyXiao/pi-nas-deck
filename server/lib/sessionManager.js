// 项目与会话进程管理。
// 设计：
// - 项目 = {id, name, path}（path 是容器内路径，通常挂载在 /workspace 下）
// - 会话存储统一用 --session-dir <DATA>/sessions，pi 会再按 cwd 分子目录；
//   我们扫描该目录、读 jsonl 首行 header 的 cwd 来归属项目，不依赖 pi 的目录名编码规则。
// - 每个打开的会话对应一个常驻 pi RPC 进程（与 PiDeck 相同）；空闲超时自动回收。
import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PiProcess } from "./piProcess.js";
import { readJson, writeJson } from "./store.js";

const IDLE_KILL_MS = Number(process.env.PI_IDLE_KILL_MS || 30 * 60 * 1000);

export class SessionManager {
  constructor(projectsPath, sessionDir) {
    this.projectsPath = projectsPath;
    this.sessionDir = sessionDir;
    this.projects = readJson(projectsPath, []);
    /** 会话元数据（归档标记等）：{ [sessionFile]: {archived?: boolean} }。不写 pi 的 jsonl，用侧文件。 */
    this.metaPath = join(sessionDir, "..", "session-meta.json");
    this.meta = readJson(this.metaPath, {});
    /** @type {Map<string, PiProcess>} sessionFile->process 或 "new:<projectId>"->process */
    this.processes = new Map();
    this.onEvent = null; // (key, record) => void，由上层转发给 WS

    this._sweeper = setInterval(() => this._sweepIdle(), 60_000);
    this._sweeper.unref?.();
  }

  // ===== 项目 =====

  listProjects() {
    return this.projects.map((p) => ({ ...p, exists: existsSync(p.path) }));
  }

  addProject(name, path) {
    const abs = resolve(path);
    const project = { id: randomUUID().slice(0, 8), name: name || abs.split(sep).pop() || abs, path: abs, createdAt: Date.now() };
    this.projects.push(project);
    this._save();
    return project;
  }

  removeProject(id) {
    const target = this.projects.find((p) => p.id === id);
    if (!target) return false;
    const oldPath = target.path;
    this.projects = this.projects.filter((p) => p.id !== id);
    // 关掉该项目下仍在运行的会话进程：新建进程 key 含项目 id，历史进程按 cwd 匹配
    const removedPath = oldPath ? normalizePath(oldPath) : null;
    for (const [key, proc] of this.processes) {
      if (key.includes(id) || (removedPath && normalizePath(proc.cwd) === removedPath)) {
        proc.kill();
        this.processes.delete(key);
      }
    }
    this._save();
    return true;
  }

  getProject(id) {
    return this.projects.find((p) => p.id === id) || null;
  }

  _save() {
    writeJson(this.projectsPath, this.projects);
  }

  // ===== 会话列表 =====

  /** 扫描会话目录，按 header.cwd 归属项目。默认排除已归档；includeArchived 时一并返回。
   *  另外把「运行中但文件尚未落盘」的进程合成条目（pi 新会话首次写入才创建文件）。 */
  listSessions(projectId, { includeArchived = false } = {}) {
    const project = this.getProject(projectId);
    if (!project) return [];
    const found = [];
    const seenFiles = new Set();
    this._walk(this.sessionDir, (file) => {
      if (!file.endsWith(".jsonl")) return;
      const info = this._readHeader(file);
      if (!info || normalizePath(info.cwd) !== normalizePath(project.path)) return;
      const archived = !!this.meta[file]?.archived;
      if (archived && !includeArchived) return;
      seenFiles.add(resolve(file));
      found.push({
        sessionFile: file,
        id: info.id,
        timestamp: info.timestamp,
        name: info.name || null,
        preview: info.preview || "",
        running: this.processes.has(file),
        streaming: !!this.processes.get(file)?.streaming,
        archived,
        bytes: safeSize(file),
      });
    });
    // 运行中但文件未落盘的进程（新建空会话）：合成条目，保证 running 状态/关闭/归档都能对上
    for (const [key, proc] of this.processes) {
      if (!proc.sessionFile || seenFiles.has(resolve(proc.sessionFile))) continue;
      if (normalizePath(proc.cwd) !== normalizePath(project.path)) continue;
      const archived = !!this.meta[resolve(proc.sessionFile)]?.archived;
      if (archived && !includeArchived) continue;
      found.push({
        sessionFile: proc.sessionFile,
        id: null,
        timestamp: new Date().toISOString(),
        name: null,
        preview: "（新会话，尚未发消息）",
        running: true,
        streaming: !!proc.streaming,
        archived,
        bytes: 0,
      });
      void key;
    }
    found.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return found;
  }

  /** 归档/取消归档（归档后默认列表隐藏，文件不动，可随时恢复）。文件未落盘时也接受——
   *  标记会在文件创建后自然生效（新会话首次发消息落盘后即被视为已归档）。 */
  setArchived(sessionFile, archived) {
    const abs = resolve(sessionFile);
    if (!abs.startsWith(resolve(this.sessionDir))) throw new Error("非法路径");
    if (!existsSync(abs) && !this.processes.has(abs) && !this.processes.has(sessionFile)) {
      throw new Error("会话不存在");
    }
    this.meta[abs] = { ...(this.meta[abs] || {}), archived: !!archived };
    writeJson(this.metaPath, this.meta);
    return { archived: !!archived };
  }

  /** 关闭会话：杀进程保留文件（释放内存，下次点开会话自动重启进程）。 */
  closeSession(sessionFile) {
    const proc = this.processes.get(sessionFile);
    if (!proc) return { closed: false, running: false };
    proc.kill();
    this.processes.delete(sessionFile);
    return { closed: true, running: false };
  }

  _walk(dir, onFile) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) this._walk(full, onFile);
      else onFile(full);
    }
  }

  /** 读 jsonl 头部与首条用户消息做预览；只读前 64KB（fd 限读，不把大文件整个载入内存）。 */
  _readHeader(file) {
    try {
      let raw;
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(65536);
        const read = readSync(fd, buf, 0, 65536, 0);
        raw = buf.subarray(0, read).toString("utf8");
      } finally {
        closeSync(fd);
      }
      let header = null;
      let name = null;
      let preview = "";
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          break; // 64KB 切到半个 JSON 行，忽略即可
        }
        if (record.type === "session") header = record;
        if (record.type === "session_info" && record.name) name = record.name;
        if (!preview && record.type === "message" && record.message?.role === "user") {
          preview = extractText(record.message.content).slice(0, 120);
        }
        if (header && (name || preview)) break;
      }
      if (!header) return null;
      return { ...header, name, preview };
    } catch {
      return null;
    }
  }

  deleteSession(sessionFile) {
    if (this.processes.has(sessionFile)) throw new Error("会话正在运行，先关闭");
    const abs = resolve(sessionFile);
    if (!abs.startsWith(resolve(this.sessionDir))) throw new Error("非法路径");
    if (!existsSync(abs)) return false;
    unlinkSync(abs);
    return true;
  }

  // ===== 进程 =====

  /**
   * 打开（或复用）一个会话进程。
   * @param {string} projectId
   * @param {string|null} sessionFile 历史会话路径；null = 新会话
   */
  async open(projectId, sessionFile, name) {
    const project = this.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    if (!existsSync(project.path)) throw new Error(`项目目录不存在: ${project.path}`);

    const key = sessionFile || `new:${projectId}:${randomUUID().slice(0, 6)}`;
    let proc = this.processes.get(key);
    if (proc && !proc.closed) {
      proc.lastActivity = Date.now();
      const state = await proc.request({ type: "get_state" });
      return { key, state };
    }

    proc = new PiProcess({ cwd: project.path, sessionFile, sessionDir: this.sessionDir, name });
    this.processes.set(key, proc);
    proc.on("event", (record) => {
      if (record.type === "message_end" && record.message?.sessionFile) {
        // 新会话落盘后，把 key 迁移到真实文件路径，后续请求/事件归属正确
        const real = record.message.sessionFile;
        if (real && this.processes.get(key) === proc && real !== key) {
          this.processes.delete(key);
          this.processes.set(real, proc);
          proc.sessionFile = real;
          this._pendingKeyFix?.(key, real);
        }
      }
      this.onEvent?.(this._keyOf(proc), record);
    });
    proc.on("exit", () => {
      this.processes.delete(this._keyOf(proc));
    });

    const state = await withTimeout(proc.request({ type: "get_state" }), 30_000, "pi 启动超时（检查 API 配置）");
    // 用 get_state 返回的真实 sessionFile 迁移进程 key，保证会话列表/恢复/微信绑定都能找到运行中的进程
    if (state?.sessionFile) {
      if (key !== state.sessionFile) this.processes.delete(key);
      proc.sessionFile = state.sessionFile;
      this.processes.set(state.sessionFile, proc);
      return { key: state.sessionFile, state };
    }
    return { key, state };
  }

  _keyOf(proc) {
    for (const [key, value] of this.processes) if (value === proc) return key;
    return "";
  }

  get(key) {
    return this.processes.get(key) || null;
  }

  /** 供 WS 断开重连后找回进程：按项目+会话文件。 */
  findBySessionFile(sessionFile) {
    return this.processes.get(sessionFile) || null;
  }

  resolveSessionFile(projectId, sessionId) {
    const project = this.getProject(projectId);
    if (!project) return null;
    const results = [];
    this._walk(this.sessionDir, (file) => {
      if (!file.endsWith(".jsonl")) return;
      const info = this._readHeader(file);
      if (info && info.id === sessionId && normalizePath(info.cwd) === normalizePath(project.path)) results.push(file);
    });
    return results[0] || null;
  }

  closeAll() {
    for (const proc of this.processes.values()) proc.kill();
    this.processes.clear();
  }

  _sweepIdle() {
    const now = Date.now();
    for (const [key, proc] of this.processes) {
      if (proc.streaming) {
        proc.lastActivity = now;
        continue;
      }
      if (now - proc.lastActivity > IDLE_KILL_MS) {
        proc.kill();
        this.processes.delete(key);
      }
    }
  }

  /**
   * 会话全文搜索：流式扫描会话 jsonl，按消息文本匹配关键词（大小写不敏感子串）。
   * 预算：最多扫 300 个文件 / 10 秒，每会话最多 5 条命中；超预算停止并标记 truncated。
   * 结果按会话文件 mtime 倒序（新会话优先）。
   * @param {string} q 关键词（≥2 字符由路由层把关）
   */
  async searchSessions(q, { projectId = "", includeArchived = false, limit = 30 } = {}) {
    const needle = q.toLowerCase();
    const deadline = Date.now() + 10_000;
    const projects = projectId ? [this.getProject(projectId)].filter(Boolean) : this.projects;
    const projectByPath = new Map(projects.map((p) => [normalizePath(p.path), p]));
    const files = [];
    this._walk(this.sessionDir, (file) => {
      if (file.endsWith(".jsonl")) files.push(file);
    });
    files.sort((a, b) => safeMtime(b) - safeMtime(a));

    const results = [];
    let filesScanned = 0;
    let truncated = false;
    for (const file of files) {
      if (results.length >= limit || filesScanned >= 300 || Date.now() > deadline) {
        truncated = true;
        break;
      }
      // 归属/名称从头部拿（fd 限读 64KB），不为归属把整个文件读两遍
      const info = this._readHeader(file);
      if (!info) continue;
      const project = projectByPath.get(normalizePath(info.cwd));
      if (!project) continue;
      if (this.meta[resolve(file)]?.archived && !includeArchived) continue;
      filesScanned++;
      const sessionName = info.name || info.preview || file.split(/[\\/]/).pop();
      const base = {
        projectId: project.id,
        projectName: project.name,
        sessionFile: file,
        sessionId: info.id,
        sessionName,
        sessionTimestamp: info.timestamp,
        archived: !!this.meta[resolve(file)]?.archived,
      };
      // 会话名/预览命中也给一条结果（kind: "session"）
      if (sessionName.toLowerCase().includes(needle) && results.length < limit) {
        results.push({ ...base, kind: "session", role: null, messageIndex: null, snippet: truncateSnippet(sessionName, needle) });
      }
      const hits = await scanSessionFile(file, needle, Math.min(5, limit - results.length), deadline);
      for (const hit of hits) {
        results.push({ ...base, kind: "message", role: hit.role, messageIndex: hit.index, snippet: hit.snippet });
      }
    }
    return { results, filesScanned, truncated };
  }
}

/** 路径归一化（供 usageStats 等模块做 cwd → 项目映射复用）。 */
export function normalizePath(p) {
  if (!p) return "";
  let out = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** 流式扫描单个会话文件的命中。LF 分帧（勿用 readline：它把 U+2028 当换行会截断 JSON 字符串）。 */
async function scanSessionFile(file, needle, maxHits, deadline) {
  const hits = [];
  if (maxHits <= 0) return hits;
  let buf = "";
  let index = 0; // 消息序号（仅 type === "message" 计数）
  const MAX_LINE = 8 * 1024 * 1024; // 单行上限（超大工具结果），超限丢弃防止内存膨胀
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const handleLine = (line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return false; // 半行/损坏行，跳过
    }
    if (record.type !== "message" || !record.message) return false;
    const text = extractText(record.message.content || "");
    const myIndex = index++;
    if (!text) return false;
    if (text.toLowerCase().indexOf(needle) < 0) return false;
    hits.push({ role: record.message.role || null, index: myIndex, snippet: truncateSnippet(text, needle) });
    return hits.length >= maxHits;
  };
  for await (const chunk of stream) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      if (handleLine(line)) {
        stream.destroy();
        return hits;
      }
    }
    if (buf.length > MAX_LINE) buf = "";
    if (Date.now() > deadline) {
      stream.destroy();
      return hits;
    }
  }
  const rest = buf.trim(); // 文件尾可能没有换行符
  if (rest) handleLine(rest);
  return hits;
}

/** 取命中词前后一段上下文做摘要，压掉换行便于单行展示。 */
function truncateSnippet(text, needle) {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text.slice(0, 160).replace(/\s+/g, " ").trim();
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + needle.length + 100);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

function safeMtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : block?.text || ""))
      .join(" ");
  }
  return "";
}

function safeSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref?.())]);
}
