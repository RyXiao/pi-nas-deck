// 模型配置 cost 字段回归（v0.5.4c 根因）：
// pi 要求 model.cost 含全部 4 个数值字段（input/output/cacheRead/cacheWrite），
// 缺任一个 → 整个 models.json 被判无效 → get_available_models 返回 0 个模型
// → 前端「无可用模型」。这里锁住 writeModels 的修复行为。
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { sanitizeProviders } = require(join(import.meta.dirname, "..", "server", "lib", "modelsConfig.js"));

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

const wrap = (cost) => ({ p1: { baseUrl: "https://x/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m1", cost }] } });
const costOf = (out) => out.p1.models[0].cost;

// 1. 缺字段的 cost 被补齐为 4 字段
let out = sanitizeProviders(wrap({ input: 1, output: 2 }));
let c = costOf(out);
assert(c && ["input", "output", "cacheRead", "cacheWrite"].every((k) => typeof c[k] === "number"), "缺 cacheRead/cacheWrite 时补齐 4 字段");
assert(c.cacheRead === 1 && c.cacheWrite === 1, "cache* 缺省回退到 input 价");

out = sanitizeProviders(wrap({ output: 2 }));
c = costOf(out);
assert(c && c.input === 2 && c.cacheRead === 2, "只有 output 时 input/cache* 回退到 output 价");

// 2. 空 cost / 无有效价格 → 整个 cost 被移除（等于未配价，不会让 pi 拒载）
out = sanitizeProviders(wrap({}));
assert(costOf(out) === undefined, "cost 空对象 → 移除");

out = sanitizeProviders(wrap({ input: "abc", output: null }));
assert(costOf(out) === undefined, "无效值 → 移除");

// 3. 完整 cost 原样保留（含 0 值）
out = sanitizeProviders(wrap({ input: 0, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }));
c = costOf(out);
assert(c.input === 0 && c.output === 2 && c.cacheRead === 0.1 && c.cacheWrite === 0.2, "完整 cost 保留（含 0 值不丢）");

// 4. 字符串数字被转成 number（表单可能传来字符串）
out = sanitizeProviders(wrap({ input: "0.5", output: "2" }));
c = costOf(out);
assert(c.input === 0.5 && c.output === 2 && typeof c.cacheWrite === "number", "字符串数字归一化为 number");

// 5. 无 cost 的模型不受影响
out = sanitizeProviders(wrap(undefined));
assert(costOf(out) === undefined && out.p1.models[0].id === "m1", "无 cost 模型原样保留");

// 6. 其它字段（name/baseUrl/models 等）不被破坏
const src = { p1: { baseUrl: "https://x/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m1", name: "M1", contextWindow: 1000, cost: { input: 1 } }] } };
out = sanitizeProviders(src);
assert(out.p1.baseUrl === "https://x/v1" && out.p1.models[0].name === "M1" && out.p1.models[0].contextWindow === 1000, "其它字段不被破坏");
assert(src.p1.models[0].cost.input === 1, "不修改入参（纯函数）");

console.log("\nMODELS COST TESTS PASSED");