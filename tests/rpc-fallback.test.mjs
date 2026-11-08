// 服务端 WS 订阅回退回归（v0.5.3 引入 LRU 挂起后暴露的 bug）：
// 进程被挂起/重启后 subscriptions 里的 entry.proc 指向已关闭的旧进程，
// 旧代码 `entry?.proc || sessions.get(key)` 永远拿到死进程 → 所有 RPC 永久失败
// → 前端 get_available_models 失败 → 模型下拉被静默隐藏（本次用户报的 bug）。
// 这里用源码断言 + 逻辑模拟双重锁定。
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

const serverSrc = readFileSync(join(import.meta.dirname, "..", "server", "index.js"), "utf8");

// 1. 必须有 closed 检测与回退
assert(serverSrc.includes("if (!proc || proc.closed)"), "RPC 分发检测 proc.closed");
assert(serverSrc.includes("const fresh = sessions.get(msg.key)"), "关闭后回退到进程池新进程");
assert(serverSrc.includes('fresh.on("event", entry.handler)'), "事件重绑到新进程");
assert(!/const proc = entry\?\.proc \|\| sessions\.get\(msg\.key\)/.test(serverSrc), "旧的短路写法已移除");

// 2. 模拟分发逻辑（等价实现）验证行为
function pickProc(entry, sessionsGet) {
  let proc = entry?.proc;
  if (!proc || proc.closed) {
    const fresh = sessionsGet();
    if (fresh) {
      if (entry) entry.proc = fresh;
      proc = fresh;
    }
  }
  return proc && !proc.closed ? proc : null;
}

const dead = { closed: true, name: "dead" };
const live = { closed: false, name: "live" };
const entry = { proc: dead, handler: () => {} };
let got = pickProc(entry, () => live);
assert(got === live, "死进程 → 回退到活进程");
assert(entry.proc === live, "订阅已重绑到新进程");
assert(pickProc(entry, () => null) === live, "池里没有时仍用已绑定的新进程");

const entry2 = { proc: live, handler: () => {} };
assert(pickProc(entry2, () => ({ closed: false, name: "other" })) === live, "进程健康时不打扰");

const entry3 = { proc: dead, handler: () => {} };
assert(pickProc(entry3, () => null) === null, "池空且旧进程已死 → 返回 null（报会话未打开）");

// 3. 前端不得再因 <2 隐藏下拉
const appSrc = readFileSync(join(import.meta.dirname, "..", "web", "app.js"), "utf8");
assert(!appSrc.includes("models.length < 2"), "前端不再因 <2 隐藏模型下拉");
assert(appSrc.includes("（无可用模型，检查设置→模型）") && appSrc.includes("（模型加载失败，可重开会话）"), "无模型/失败时给可读状态而非隐藏");
assert(appSrc.includes("进程已挂起") && appSrc.includes("state.reattaching"), "挂起后前端自动重连");
assert(appSrc.includes("explainNoModels") && serverSrc.includes("/api/models/health"), "无模型时自检 models.json 并给出可操作提示");

console.log("\nRPC FALLBACK TESTS PASSED");