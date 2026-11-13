// pi --mode rpc 子进程封装。
//
// 关键约束（来自 pi 官方 docs/rpc.md、docs/json.md）：
// - JSONL 帧：只按 LF 切分，绝不能用 Node readline（它把 U+2028/2029 也当换行，会截断 JSON 字符串）。
// - stdout 必须持续消费，否则管道缓冲填满会把 pi 卡死。
// - 命令响应按 id 关联，事件无 id。
// - prompt 响应只代表"已接受"，完成要看 agent_settled 事件。
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

let nextReqId = 1;

export class PiProcess extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cwd 项目工作目录
   * @param {string} [opts.sessionFile] 恢复已有会话（--session <path>）
   * @param {string} [opts.sessionDir] 会话存储目录（--session-dir），由服务端统一控制
   * @param {string} [opts.name] 会话显示名（仅新建时生效）
   * @param {string[]} [opts.extraArgs]
   * @param {number} [opts.requestTimeoutMs]
   */
  constructor(opts) {
    super();
    this.cwd = opts.cwd;
    this.sessionFile = opts.sessionFile || null;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.lastActivity = Date.now();
    this.streaming = false;
    this.closed = false;
    this.stderrTail = [];

    const args = ["--mode", "rpc", "--approve"];
    // 默认模型：仅在新建会话时生效（历史会话保留其原模型）
    if (opts.model?.provider && opts.model?.id) args.push("--model", `${opts.model.provider}/${opts.model.id}`);
    if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
    if (opts.sessionFile) args.push("--session", opts.sessionFile);
    if (opts.name) args.push("--name", opts.name);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    // Windows 上全局 npm 的 pi 是 .cmd，spawn 不带 shell 起不来；容器内（Linux）不走 shell。
    const isWin = process.platform === "win32";
    this.child = spawn("pi", args, { cwd: opts.cwd, shell: isWin, stdio: ["pipe", "pipe", "pipe"] });

    // stdout：自实现 LF 分帧
    const decoder = new StringDecoder("utf8");
    let buf = "";
    this.child.stdout.on("data", (chunk) => {
      buf += decoder.write(chunk);
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        this._onLine(line);
      }
    });
    this.child.stdout.on("end", () => {
      const rest = decoder.end() + buf;
      if (rest.trim()) this._onLine(rest.trim());
    });

    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderrTail.push(text);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.emit("stderr", text);
    });

    this.child.on("exit", (code, signal) => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`pi 进程已退出 (code=${code})`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    /** @type {Map<string, {resolve:Function, reject:Function, timer:NodeJS.Timeout, command:string}>} */
    this.pending = new Map();
  }

  _onLine(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      this.emit("badline", line);
      return;
    }
    this.lastActivity = Date.now();

    if (record.type === "response" && record.id && this.pending.has(record.id)) {
      const pending = this.pending.get(record.id);
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.success) pending.resolve(record.data);
      else pending.reject(new Error(record.error || `${pending.command} 失败`));
      return;
    }
    // 会话事件（agent_start/message_update/tool_execution_*/agent_settled...）
    if (record.type === "agent_start" || record.type === "turn_start") this.streaming = true;
    if (record.type === "agent_settled") this.streaming = false;
    if (record.type === "message_end" && record.message?.sessionFile) {
      this.sessionFile = record.message.sessionFile;
    }
    this.emit("event", record);
  }

  /** 发送命令，等待响应。 */
  request(command, timeoutMs) {
    if (this.closed) return Promise.reject(new Error("pi 进程已关闭"));
    const id = `r${nextReqId++}`;
    const payload = { id, ...command };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${command.type} 超时`));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: command.type });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /** 单向写入（不等响应）：extension_ui_response 等 stdin 消息。 */
  send(command) {
    if (this.closed) return false;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  kill() {
    if (this.closed) return;
    try {
      this.child.kill("SIGTERM");
    } catch { /* ignore */ }
    // 兜底强杀
    setTimeout(() => {
      try {
        if (!this.closed) this.child.kill("SIGKILL");
      } catch { /* ignore */ }
    }, 5000).unref?.();
  }
}
