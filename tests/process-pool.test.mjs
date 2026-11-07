// 会话进程池 LRU 治理回归（不真起 pi 进程：注入假 proc 验证逻辑）。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../server/lib/sessionManager.js";

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

const dir = mkdtempSync(join(tmpdir(), "pnd-pool-"));
const projectsPath = join(dir, "projects.json");
writeFileSync(projectsPath, JSON.stringify([{ id: "p1", name: "proj", path: dir }]));
const mgr = new SessionManager(projectsPath, join(dir, "sessions"));

// 假进程：只需 streaming/lastActivity/kill
function fakeProc(streaming, lastActivity, key) {
  return {
    streaming,
    lastActivity,
    closed: false,
    cwd: dir,
    sessionFile: key,
    child: { pid: 1 },
    kill() {
      this.closed = true;
    },
  };
}

const now = Date.now();
mgr.processes.set("old-idle", fakeProc(false, now - 100_000, "old-idle"));
mgr.processes.set("mid-idle", fakeProc(false, now - 50_000, "mid-idle"));
mgr.processes.set("busy", fakeProc(true, now - 999_999, "busy")); // 最久但流式中
mgr.processes.set("fresh", fakeProc(false, now, "fresh"));

// 上限当前=4（默认），塞到 5 触发一次淘汰
mgr.processes.set("newcomer", fakeProc(false, now, "newcomer"));
const suspended = mgr._enforceLimit("newcomer");

assert(suspended.includes("old-idle"), "淘汰最久未活动的空闲进程");
assert(!suspended.includes("busy"), "流式中的进程绝不挂起（即使最久）");
assert(!suspended.includes("newcomer"), "刚打开的进程保留");
assert(mgr.processes.has("busy") && mgr.processes.has("fresh") && mgr.processes.has("newcomer"), "保留其余进程");
assert(mgr.processes.size <= 4, `治理后不超过上限（实际 ${mgr.processes.size}）`);

// 全都在流式时：宁超限也不打断
const mgr2 = new SessionManager(projectsPath, join(dir, "sessions2"));
for (let i = 0; i < 6; i++) mgr2.processes.set(`s${i}`, fakeProc(true, now - i * 1000, `s${i}`));
const s2 = mgr2._enforceLimit("s0");
assert(s2.length === 0 && mgr2.processes.size === 6, "全部流式中：不淘汰（宁超限不打断）");

// suspend：运行中拒绝，空闲成功
const r1 = mgr.suspend("busy");
assert(r1.suspended === false && r1.reason === "streaming", "挂起运营中进程被拒绝");
const r2 = mgr.suspend("fresh");
assert(r2.suspended === true && !mgr.processes.has("fresh"), "挂起空闲进程成功");

// listProcesses 形状
const list = mgr.listProcesses();
assert(Array.isArray(list) && list.every((p) => typeof p.idleMs === "number" && typeof p.streaming === "boolean"), "进程池快照字段完整");

clearInterval(mgr._sweeper);
clearInterval(mgr2._sweeper);
rmSync(dir, { recursive: true, force: true });
console.log("\nPROCESS POOL TESTS PASSED");
