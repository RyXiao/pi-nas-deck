// 定时任务纯函数回归：下次触发时间计算 + 任务校验。
import { computeNextRun, validateTask } from "../server/lib/scheduler.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../server/lib/scheduler.js";

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

const fakeSessions = { getProject: (id) => (id === "p1" ? { id: "p1", path: "/x" } : null) };

// ---- computeNextRun ----
// 基准：2026-10-31 10:00 本地时间
const base = new Date(2026, 9, 31, 10, 0, 0).getTime();

// daily：未来时间 → 今天
let next = computeNextRun({ schedule: { kind: "daily", time: "18:00" } }, base);
assert(next === new Date(2026, 9, 31, 18, 0).getTime(), "daily 未来时间 → 今天 18:00");

// daily：已过时间 → 明天
next = computeNextRun({ schedule: { kind: "daily", time: "09:30" } }, base);
assert(next === new Date(2026, 10, 1, 9, 30).getTime(), "daily 已过时间 → 明天 09:30");

// daily：恰好当前分钟 → 推到明天（避免同分钟重跑）
next = computeNextRun({ schedule: { kind: "daily", time: "10:00" } }, base);
assert(next === new Date(2026, 10, 1, 10, 0).getTime(), "daily 恰好当前分钟 → 明天");

// interval：基本值与上下限
assert(computeNextRun({ schedule: { kind: "interval", minutes: 30 } }, base) === base + 30 * 60000, "interval 30 分钟");
assert(computeNextRun({ schedule: { kind: "interval", minutes: 1 } }, base) === base + 5 * 60000, "interval 下限 5 分钟");
assert(computeNextRun({ schedule: { kind: "interval", minutes: 99999 } }, base) === base + 1440 * 60000, "interval 上限 1440 分钟");

// 非法 daily 时间兜底为明天
next = computeNextRun({ schedule: { kind: "daily", time: "25:99" } }, base);
assert(next > base && next <= base + 24 * 3600_000, "非法时间兜底 +24h");

// ---- weekday（base = 2026-10-31 周六 10:00） ----
next = computeNextRun({ schedule: { kind: "weekday", time: "18:00" } }, base);
assert(next === new Date(2026, 10, 2, 18, 0).getTime(), "weekday: 周六触发 → 跳到周一");
next = computeNextRun({ schedule: { kind: "weekday", time: "09:00" } }, base);
assert(next === new Date(2026, 10, 2, 9, 0).getTime(), "weekday: 周末+时间已过 → 周一");
const wedBase = new Date(2026, 10, 4, 10, 0).getTime(); // 2026-11-04 周三
next = computeNextRun({ schedule: { kind: "weekday", time: "18:00" } }, wedBase);
assert(next === new Date(2026, 10, 4, 18, 0).getTime(), "weekday: 周中当天未来时间");
const friBase = new Date(2026, 9, 30, 20, 0).getTime(); // 2026-10-30 周五
next = computeNextRun({ schedule: { kind: "weekday", time: "18:00" } }, friBase);
assert(next === new Date(2026, 10, 2, 18, 0).getTime(), "weekday: 周五已过 → 下周一");

// ---- monthly（月报；base = 2026-10-31 10:00） ----
next = computeNextRun({ schedule: { kind: "monthly", day: 5, time: "18:00" } }, base);
assert(next === new Date(2026, 10, 5, 18, 0).getTime(), "monthly: 当月 5 号已过 → 下月同日");
next = computeNextRun({ schedule: { kind: "monthly", day: 31, time: "18:00" } }, base);
assert(next === new Date(2026, 9, 31, 18, 0).getTime(), "monthly: 当月 31 号未到 → 当天");
const janEnd = new Date(2027, 0, 31, 20, 0).getTime(); // 2027-01-31 晚
next = computeNextRun({ schedule: { kind: "monthly", day: 31, time: "18:00" } }, janEnd);
assert(next === new Date(2027, 1, 28, 18, 0).getTime(), "monthly: 2 月无 31 号 → 鉗位 28 日");

// ---- validateTask ----
let t = validateTask({ name: "日报", projectId: "p1", prompt: "生成日报", schedule: { kind: "daily", time: "18:00" } }, fakeSessions);
assert(t.outputDir === "定时任务" && t.enabled === true && t.schedule.time === "18:00", "合法任务 + 默认输出目录");

t = validateTask({ name: "采集", projectId: "p1", prompt: "x", schedule: { kind: "interval", minutes: 90 }, outputDir: "reports/自动" }, fakeSessions);
assert(t.schedule.kind === "interval" && t.schedule.minutes === 90 && t.outputDir === "reports/自动", "间隔任务 + 自定义目录");
t = validateTask({ name: "周报", projectId: "p1", prompt: "x", schedule: { kind: "weekday", time: "18:30" } }, fakeSessions);
assert(t.schedule.kind === "weekday" && t.schedule.time === "18:30", "工作日任务");
t = validateTask({ name: "月报", projectId: "p1", prompt: "x", schedule: { kind: "monthly", day: 1, time: "09:00" } }, fakeSessions);
assert(t.schedule.kind === "monthly" && t.schedule.day === 1 && t.schedule.time === "09:00", "月报任务");

t = validateTask({ name: "谷电任务", projectId: "p1", prompt: "x", schedule: { kind: "daily", time: "02:00" }, model: { provider: "cheap", id: "night-model" } }, fakeSessions);
assert(t.model?.provider === "cheap" && t.model.id === "night-model", "指定模型（谷电择优）");
assert(validateTask({ name: "无模型", projectId: "p1", prompt: "x", schedule: { kind: "daily", time: "02:00" } }, fakeSessions).model === null, "缺省模型为 null");

const rejects = [
  [{ name: "", projectId: "p1", prompt: "x" }, "缺任务名"],
  [{ name: "t", projectId: "不存在", prompt: "x" }, "无效项目"],
  [{ name: "t", projectId: "p1", prompt: "" }, "缺提示词"],
  [{ name: "t", projectId: "p1", prompt: "x", schedule: { kind: "daily", time: "9点" } }, "非法时间格式"],
  [{ name: "t", projectId: "p1", prompt: "x", schedule: { kind: "monthly", day: 32, time: "09:00" } }, "月报日期32"],
  [{ name: "t", projectId: "p1", prompt: "x", schedule: { kind: "monthly", day: 0, time: "09:00" } }, "月报日期0"],
  [{ name: "t", projectId: "p1", prompt: "x", schedule: { kind: "monthly", day: 1 } }, "月报缺时间"],
  [{ name: "t", projectId: "p1", prompt: "x", outputDir: "../escape" }, "目录穿越"],
  [{ name: "t", projectId: "p1", prompt: "x", outputDir: "a//b" }, "非法目录段"],
  [{ name: "t", projectId: "p1", prompt: "x", model: { provider: "", id: "m" } }, "模型缺 provider"],
  [{ name: "t", projectId: "p1", prompt: "x", model: { provider: "p", id: "" } }, "模型缺 id"],
];
for (const [input, label] of rejects) {
  let threw = false;
  try {
    validateTask(input, fakeSessions);
  } catch {
    threw = true;
  }
  assert(threw, `拒绝：${label}`);
}

console.log("\n---- 实例级：创建 → 修订 → 删除（v0.4.2 编辑链路） ----");
const tmp = mkdtempSync(join(tmpdir(), "pnd-sched-"));
const sched = new Scheduler({
  sessions: { getProject: (id) => (id === "p1" ? { id: "p1", path: "/x" } : null) },
  configPath: join(tmp, "scheduler.json"),
  emit: () => {},
});
const created = sched.upsertTask({ name: "日报", projectId: "p1", prompt: "v1", schedule: { kind: "daily", time: "18:00" } }).task;
assert(created.id && created.nextRunAt > Date.now(), "创建任务返回 id 与排期");
const edited = sched.upsertTask({ id: created.id, name: "修订后的日报", projectId: "p1", prompt: "v2 内容", schedule: { kind: "weekday", time: "09:30" }, enabled: false }).task;
assert(edited.id === created.id && edited.name === "修订后的日报" && edited.prompt === "v2 内容" && edited.schedule.kind === "weekday" && edited.enabled === false, "按 id 修订（名称/提示词/排期/启停）");
assert(sched.getStatus().tasks.length === 1, "修订不产生新任务");
const savedCfg = JSON.parse(readFileSync(join(tmp, "scheduler.json"), "utf8"));
assert(savedCfg.tasks[0].prompt === "v2 内容", "修订已持久化到磁盘");
let missing = false;
try {
  sched.upsertTask({ id: "不存在", name: "x", projectId: "p1", prompt: "x", schedule: { kind: "daily", time: "10:00" } });
} catch {
  missing = true;
}
assert(missing, "修订不存在的任务报错");
assert(sched.removeTask(created.id).ok && sched.getStatus().tasks.length === 0, "删除任务");
clearInterval(sched._timer);
rmSync(tmp, { recursive: true, force: true });

console.log("\nSCHEDULER TESTS PASSED");
