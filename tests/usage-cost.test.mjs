// 用量成本折算回归：USD/百万 token，缺价格时 cost=null 且 priceMissing 标记。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsage } from "../server/lib/usageStats.js";

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

const dir = mkdtempSync(join(tmpdir(), "pnd-cost-"));
mkdirSync(join(dir, "analytics"));
// [ts, session, cwd, "provider/model", input, output, cache, 0, total, 0]
const row = (model, input, output, cache) => {
  const total = input + output + cache;
  return JSON.stringify([Date.now(), "s", "E:\\p", model, input, output, cache, 0, total, 0]);
};
writeFileSync(
  join(dir, "analytics", "pnd-usage.jsonl"),
  [
    row("prov-a/cheap", 1_000_000, 1_000_000, 0), // 1M in + 1M out
    row("prov-a/cheap", 1_000_000, 0, 1_000_000), // 1M in + 1M cache
    row("prov-b/noprice", 500_000, 0, 0), // 未配价
  ].join("\n") + "\n",
);

const costs = {
  "prov-a/cheap": { input: 0.5, output: 2, cacheRead: 0.1 }, // USD/M
};

const agg = await aggregateUsage(dir, { group: "day", costs });
const cheap = agg.rows.find((r) => r.model === "prov-a/cheap");
const noprice = agg.rows.find((r) => r.model === "prov-b/noprice");

// cheap: 行1 = 1M*0.5 + 1M*2 = 2.5；行2 = 1M*0.5 + 1M*0.1(缓存读) = 0.6 → 合计 3.1
assert(Math.abs(cheap.cost - 3.1) < 1e-9, `已配价模型成本折算（实际 ${cheap?.cost}）`);
assert(cheap.priceMissing === false, "全部行有价格时 priceMissing=false");
assert(noprice.cost === null && noprice.priceMissing === true, "未配价模型 cost=null 且标记 priceMissing");

assert(Math.abs(agg.totals.cost - 3.1) < 1e-9, "合计只累加已知价格部分");
assert(agg.totals.priceMissing === true, "合计标记存在未配价行");

// 不做价格表时：全部 null、无崩
const noCost = await aggregateUsage(dir, { group: "day" });
assert(noCost.rows.every((r) => r.cost === null) && noCost.totals.cost === null, "无价格表时 cost 全为 null");

// 缓存读缺省回退到 input 价
const fallback = await aggregateUsage(dir, { group: "day", costs: { "prov-a/cheap": { input: 1, output: 0 } } });
const c2 = fallback.rows.find((r) => r.model === "prov-a/cheap");
// 行1: 1M*1 + 0 = 1；行2: 1M*1 + 缓存 1M 回退 input 价 1 = 2 → 3
assert(Math.abs(c2.cost - 3) < 1e-9, `cacheRead 缺省回退 input 价（实际 ${c2?.cost}）`);

rmSync(dir, { recursive: true, force: true });
console.log("\nUSAGE-COST TESTS PASSED");
