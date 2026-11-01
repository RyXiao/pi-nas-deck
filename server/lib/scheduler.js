// 定时任务：按「每天 HH:MM」或「每 N 分钟」触发，在指定项目开新会话执行 prompt，
// 产出保存为项目内的 md 文件（默认 定时任务/<名称>-YYYY-MM-DD.md）——
// 文件树时间倒序下新产出自动置顶，形成日报闭环。
// 串行保护：同一任务不并发；tick 每 30s 一次。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJson } from "./store.js";
import { pickLatestAssistantText } from "../wechat/wechatText.js";

const TICK_MS = 30_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_DIR_MAX = 200;

export class Scheduler {
  constructor(deps) {
    this.deps = deps; // {sessions, configPath, emit}
    const cfg = readJson(deps.configPath, { tasks: [] });
    this.tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [];
    this.running = new Set();
    // 启动时重算所有启用任务的 nextRunAt（不只是补齐）：
    // 容器时区修正/时钟漂移后，已存排期自动按当前时区自愈，无需手改任务
    for (const task of this.tasks) {
      if (task.enabled) task.nextRunAt = computeNextRun(task, Date.now());
    }
    this._save();
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._timer.unref?.();
  }

  getStatus() {
    return {
      tasks: this.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        projectId: t.projectId,
        schedule: t.schedule,
        prompt: t.prompt,
        outputDir: t.outputDir,
        enabled: !!t.enabled,
        running: this.running.has(t.id),
        lastRunAt: t.lastRunAt || null,
        lastResult: t.lastResult || null,
        lastError: t.lastError || null,
        nextRunAt: t.enabled ? t.nextRunAt || null : null,
      })),
    };
  }

  upsertTask(input) {
    const task = validateTask(input, this.deps.sessions);
    if (task.id) {
      const idx = this.tasks.findIndex((t) => t.id === task.id);
      if (idx < 0) throw new Error("任务不存在");
      const prev = this.tasks[idx];
      this.tasks[idx] = { ...prev, ...task, nextRunAt: computeNextRun(task, Date.now()) };
    } else {
      task.id = randomUUID().slice(0, 8);
      task.nextRunAt = computeNextRun(task, Date.now());
      this.tasks.push(task);
    }
    this._save();
    this._emit();
    return { task: this.tasks.find((t) => t.id === task.id) };
  }

  removeTask(id) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this._save();
    this._emit();
    return { ok: this.tasks.length < before, id };
  }

  async runNow(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error("任务不存在");
    const result = await this._runTask(task, { manual: true });
    // 手动触发不消耗排期：保持原 nextRunAt
    this._save();
    this._emit();
    return result;
  }

  async _tick() {
    const now = Date.now();
    for (const task of this.tasks) {
      if (!task.enabled || this.running.has(task.id)) continue;
      if (!task.nextRunAt) task.nextRunAt = computeNextRun(task, now);
      if (task.nextRunAt <= now) {
        void this._runTask(task).catch(() => {});
      }
    }
  }

  async _runTask(task, { manual = false } = {}) {
    if (this.running.has(task.id)) throw new Error("该任务正在运行");
    const project = this.deps.sessions.getProject(task.projectId);
    if (!project) throw new Error("任务绑定的项目不存在");
    const startedAt = Date.now();
    this.running.add(task.id);
    this._emit();
    try {
      const date = new Date(startedAt).toISOString().slice(0, 10);
      // 每次运行开新会话：日报互不污染上下文
      const { key, state } = await this.deps.sessions.open(task.projectId, null, `${task.name} ${date}`);
      const proc = this.deps.sessions.get(key);
      const settled = waitForSettled(proc, RUN_TIMEOUT_MS);
      await proc.request({ type: "prompt", message: task.prompt }, 15_000);
      const outcome = await settled;
      const messages = await proc.request({ type: "get_messages" }).catch(() => null);
      const flat = (messages?.messages || []).map((m) => ({ role: m?.role, text: extractContentText(m?.content) }));
      const reply = pickLatestAssistantText(flat);
      // 产出写回项目文件（文件树时间倒序下自动置顶）
      const dirRel = task.outputDir || "定时任务";
      const fileName = `${task.name}-${date}.md`;
      const outAbs = join(project.path, dirRel, fileName);
      mkdirSync(dirname(outAbs), { recursive: true });
      const relOut = `${dirRel}/${fileName}`.replace(/\\/g, "/");
      writeFileSync(
        outAbs,
        `# ${task.name}（${date}）\n\n> 由 PiNasDeck 定时任务自动生成（${new Date(startedAt).toLocaleString()}）。\n\n${reply || "（本轮无文本产出，会话可能仍在后台）"}\n`,
        "utf8",
      );
      task.lastRunAt = startedAt;
      task.lastResult = { ok: outcome !== "exited", outcome, rel: relOut, sessionFile: state?.sessionFile || key, manual };
      task.lastError = null;
      return task.lastResult;
    } catch (error) {
      task.lastRunAt = startedAt;
      task.lastResult = null;
      task.lastError = String(error?.message || error);
      return { ok: false, error: task.lastError };
    } finally {
      this.running.delete(task.id);
      if (!manual) task.nextRunAt = computeNextRun(task, Date.now());
      this._save();
      this._emit();
    }
  }

  _save() {
    writeJson(this.deps.configPath, { tasks: this.tasks });
  }

  _emit() {
    this.deps.emit?.("scheduler:status", this.getStatus());
  }
}

/** 计算下次触发时间（纯函数，供测试）。 */
export function computeNextRun(task, now) {
  const sched = task.schedule || {};
  if (sched.kind === "interval") {
    const minutes = Math.max(5, Math.min(1440, Number(sched.minutes) || 60));
    return now + minutes * 60_000;
  }
  // daily / weekday / monthly：本地时区的 HH:MM
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(sched.time || ""));
  if (!m) return now + 24 * 3600_000;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (sched.kind === "monthly") {
    // 每月 D 日 HH:MM；当月没有 D 号（如 2 月 31）则落到当月最后一天
    const day = Math.max(1, Math.min(31, Number(sched.day) || 1));
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    if (d.getTime() <= now) {
      // 先置 1 号再跨月，防 1/31 + setMonth 滚到 3 月的经典坑
      const target = new Date(now);
      target.setHours(hh, mm, 0, 0);
      target.setDate(1);
      target.setMonth(target.getMonth() + 1);
      target.setDate(Math.min(day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
      return target.getTime();
    }
    return d.getTime();
  }
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  if (sched.kind === "weekday") {
    // 工作日：跳过周六(6)/周日(0)
    while (d.getTime() <= now || d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // daily
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 任务校验（纯函数部分可测）。 */
export function validateTask(input, sessions) {
  const name = String(input?.name || "").trim();
  if (!name || name.length > 60) throw new Error("任务名必填且 ≤60 字");
  const projectId = String(input?.projectId || "");
  if (!sessions.getProject(projectId)) throw new Error("请选择有效项目");
  const prompt = String(input?.prompt || "").trim();
  if (!prompt || prompt.length > 20_000) throw new Error("提示词必填且 ≤20000 字");
  const kindRaw = String(input?.schedule?.kind || "daily");
  const kind = ["daily", "weekday", "monthly", "interval"].includes(kindRaw) ? kindRaw : "daily";
  let schedule;
  if (kind === "interval") {
    const minutes = Math.max(5, Math.min(1440, Number(input?.schedule?.minutes) || 60));
    schedule = { kind, minutes };
  } else if (kind === "monthly") {
    const time = String(input?.schedule?.time || "");
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) throw new Error("每月触发时间格式应为 HH:MM");
    const day = Number(input?.schedule?.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("每月触发的日期应为 1-31 的整数");
    schedule = { kind, day, time };
  } else {
    const time = String(input?.schedule?.time || "");
    const timeOk = /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
    if (!timeOk) throw new Error("触发时间格式应为 HH:MM");
    schedule = { kind: kind === "weekday" ? "weekday" : "daily", time };
  }
  let outputDir = String(input?.outputDir || "定时任务").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (outputDir.split("/").some((seg) => seg === ".." || !seg)) throw new Error("输出目录不合法");
  if (outputDir.length > OUTPUT_DIR_MAX) throw new Error("输出目录过长");
  return {
    id: String(input?.id || "") || undefined,
    name,
    projectId,
    prompt,
    schedule,
    outputDir: outputDir || "定时任务",
    enabled: input?.enabled !== false,
  };
}

/** 等 proc 的下一次 agent_settled（与 bridge 同语义的最小实现）。 */
function waitForSettled(proc, timeoutMs) {
  return new Promise((resolve) => {
    const onEvent = (record) => {
      if (record.type === "agent_settled") {
        cleanup();
        resolve(record.aborted ? "aborted" : "settled");
      }
    };
    const onExit = () => {
      cleanup();
      resolve("exited");
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve("timeout");
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      proc.off("event", onEvent);
      proc.off("exit", onExit);
    }
    proc.on("event", onEvent);
    proc.on("exit", onExit);
  });
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : block?.text || ""))
      .join("\n");
  }
  return content?.text || "";
}
