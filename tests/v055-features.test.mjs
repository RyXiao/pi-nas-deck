// v0.5.5 回归：默认模型（prefs）+ 终端参数注入 + Dockerfile pi 版本。
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

const root = join(import.meta.dirname, "..");
const serverSrc = readFileSync(join(root, "server", "index.js"), "utf8");
const smSrc = readFileSync(join(root, "server", "lib", "sessionManager.js"), "utf8");
const procSrc = readFileSync(join(root, "server", "lib", "piProcess.js"), "utf8");
const appSrc = readFileSync(join(root, "web", "app.js"), "utf8");
const htmlSrc = readFileSync(join(root, "web", "index.html"), "utf8");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

// 1. 默认模型：prefs + 进程启动参数
assert(serverSrc.includes("/api/prefs") && serverSrc.includes("getPrefs"), "prefs API 存在");
assert(serverSrc.includes("getDefaultModel: () => getPrefs().defaultModel"), "SessionManager 注入默认模型来源");
assert(smSrc.includes("getDefaultModel"), "SessionManager 支持默认模型提供器");
assert(procSrc.includes('args.push("--model"') && procSrc.includes("opts.model"), "PiProcess 用 --model 启动参数");
assert(smSrc.includes("model: sessionFile ? null : this.getDefaultModel()"), "仅新会话套默认模型（历史会话不变）");

// 2. 终端：WS 协议 + 视图
for (const t of ["term-open", "term-input", "term-signal", "term-close"]) {
  assert(serverSrc.includes(`msg.type === "${t}"`), `服务端处理 ${t}`);
}
assert(serverSrc.includes('spawn("bash"') && serverSrc.includes("closeTerm()"), "终端 spawn bash 且断连回收");
assert(htmlSrc.includes('id="term-view"') && htmlSrc.includes('id="term-output"'), "终端视图 DOM 存在");
assert(appSrc.includes("termAppend") && appSrc.includes("stripAnsi"), "前端终端渲染 + ANSI 清理");

// 3. pi 版本
assert(/ARG PI_VERSION=1\.5\.2/.test(dockerfile), "Dockerfile 锁定 pi 1.5.2");

console.log("\nV0.5.5 FEATURE TESTS PASSED");