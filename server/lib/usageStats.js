// 用量统计：聚合 pi 的 analytics/usage.jsonl。
// 行格式（位置数组，pi 1.x 实测）：
//   [ts毫秒, sessionFile, cwd, "provider/model", inputTokens, outputTokens, contextTokens, ?, totalTokens, ?]
//   恒等式：total = input + output + context（解析时校验，防版本漂移误读）。
// 坏行/短行跳过；字段顺序变化时整行丢弃而不是算出垃圾数据。
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "./sessionManager.js";

const PND_USAGE_FILE = join("analytics", "pnd-usage.jsonl"); // 内置 usage-logger 扩展写的
const LEGACY_USAGE_FILE = join("analytics", "usage.jsonl"); // 第三方 pi-tracker 写的
const MAX_LINE = 1024 * 1024;

/**
 * 读取并聚合用量。
 * @param {string} piAgentDir pi 的 agent 目录（含 analytics/usage.jsonl）
 * @param {object} opts
 * @param {"day"|"month"} [opts.group] 时间桶粒度，默认 day
 * @param {number} [opts.limitBuckets] 保留最近多少个桶（倒序后截断），默认 day=30 / month=12
 * @param {Array<{id:string,path:string,name:string}>} [opts.projects] 用于 cwd → 项目名映射
 * @param {object} [opts.costs] 价格表：{"provider/model": {input,output,cacheRead,cacheWrite}}
 *   （单位 USD/百万 token，来自 pi 的 models.json cost 字段；缺价格则 cost 为 null）
 * @returns {Promise<{group:string, rows:Array<{bucket:string,project:string,model:string,input:number,output:number,total:number,count:number,cost:number|null,costPartial:boolean}>, totals:{input:number,output:number,total:number,count:number,cost:number|null}, scanned:number, skipped:number}>}
 */
export async function aggregateUsage(piAgentDir, { group = "day", limitBuckets, projects = [], costs = {} } = {}) {
  // 优先读内置 usage-logger 的 pnd-usage.jsonl（两文件同时存在时只统计它，防双计）；
  // 没有则回退 pi-tracker 的 usage.jsonl。
  const pndFile = join(piAgentDir, PND_USAGE_FILE);
  const legacyFile = join(piAgentDir, LEGACY_USAGE_FILE);
  const usePnd = existsSync(pndFile) && statSync(pndFile).size > 0;
  const file = usePnd ? pndFile : legacyFile;
  const source = usePnd ? "usage-logger" : existsSync(legacyFile) ? "pi-tracker" : "none";
  const buckets = new Map(); // bucket|project|model -> 累计
  let scanned = 0;
  let skipped = 0;
  const totals = { input: 0, output: 0, total: 0, count: 0, cost: 0, costKnown: 0 };

  const projectByPath = new Map(projects.map((p) => [normalizePath(p.path), p.name]));
  const bucketOf = (date) => (group === "month" ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);

  if (existsSync(file)) {
    for await (const line of readLines(file)) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      // 位置数组：至少要有 model 与三个 token 字段
      if (!Array.isArray(row) || row.length < 9 || typeof row[3] !== "string") {
        skipped++;
        continue;
      }
      // 位置数组：[ts, sessionFile, cwd, model, input, output, cache, ?, total, ?]
      // （cache 在下标 6；曾经误读为 9 导致缓存行不计成本）
      const [ts, , cwd, model, input, output, cache, , total] = row;
      const inTok = Number(input) || 0;
      const outTok = Number(output) || 0;
      const cacheTok = Number(cache) || 0;
      const allTok = Number(total) || 0;
      if (typeof ts !== "number" || !model || (allTok > 0 && allTok !== inTok + outTok + (Number(row[6]) || 0))) {
        skipped++; // 字段顺序疑似变化（恒等式不成立），丢弃防误统计
        continue;
      }
      scanned++;
      const bucket = bucketOf(new Date(ts));
      const project = (cwd && projectByPath.get(normalizePath(cwd))) || "";
      const key = `${bucket}\u0000${project}\u0000${model}`;
      let slot = buckets.get(key);
      if (!slot) {
        slot = { bucket, project, model, input: 0, output: 0, total: 0, count: 0, cost: 0, costKnown: 0 };
        buckets.set(key, slot);
      }
      // 成本：按 models.json 的 cost（USD/百万 token）折算；缺价格则该行不计（costKnown 保持 0）
      const price = costs[model];
      const rowCost = price
        ? (inTok / 1e6) * (Number(price.input) || 0) + (outTok / 1e6) * (Number(price.output) || 0) + (cacheTok / 1e6) * (Number(price.cacheRead ?? price.input) || 0)
        : null;
      if (rowCost !== null) {
        slot.cost += rowCost;
        slot.costKnown += 1;
        totals.cost += rowCost;
        totals.costKnown += 1;
      }
      slot.input += inTok;
      slot.output += outTok;
      slot.total += allTok;
      slot.count += 1;
      totals.input += inTok;
      totals.output += outTok;
      totals.total += allTok;
      totals.count += 1;
    }
  }

  let rows = [...buckets.values()].sort((a, b) => (b.bucket < a.bucket ? -1 : b.bucket > a.bucket ? 1 : b.total - a.total));
  // 输出前把内部计数转成对外字段：cost（已知部分）与 priceMissing（该行有部分行缺价格）
  rows = rows.map((r) => ({
    bucket: r.bucket,
    project: r.project,
    model: r.model,
    input: r.input,
    output: r.output,
    total: r.total,
    count: r.count,
    cost: r.costKnown > 0 ? r.cost : null,
    priceMissing: r.costKnown < r.count,
  }));
  const keep = limitBuckets || (group === "month" ? 12 : 30);
  const seen = new Set();
  rows = rows.filter((r) => {
    if (seen.has(r.bucket)) return true;
    seen.add(r.bucket);
    return seen.size <= keep;
  });
  return {
    group,
    rows,
    totals: {
      input: totals.input,
      output: totals.output,
      total: totals.total,
      count: totals.count,
      cost: totals.costKnown > 0 ? totals.cost : null,
      priceMissing: totals.costKnown < totals.count,
      pricedModels: totals.costKnown,
    },
    scanned,
    skipped,
    source,
  };
}

/** 按 LF 切分的流式行读取（勿用 readline：U+2028 会截断 JSON 字符串）。 */
async function* readLines(file) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    if (buf.length > MAX_LINE) buf = "";
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  if (buf.trim()) yield buf;
}
