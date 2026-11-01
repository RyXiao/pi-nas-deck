// 离线回归：docx 文本提取（手工构造 zip，覆盖 store/deflate 条目）+ 用量数据源优先级。
// 运行：node tests/docx-usage.test.mjs（零网络）
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { docxXmlToText, extractDocxText } from "../server/lib/docx.js";
import { aggregateUsage } from "../server/lib/usageStats.js";

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

/** 手工构造 zip（我们只需要 reader 能解析；CRC 写 0，reader 不校验）。 */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const comp = f.method === 8 ? deflateRawSync(f.data) : f.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.method, 8);
    local.writeUInt32LE(comp.length, 18); // compSize（无 data descriptor）
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(f.method, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---- docx 提取 ----
const documentXml = `<?xml version="1.0"?>
<w:document><w:body>
  <w:p><w:r><w:t>第一段：Hello docx &amp; PiNasDeck</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">第二段有</w:t></w:r><w:r><w:t>制表&#9;和 &lt;标签&gt;</w:t></w:r></w:p>
  <w:p><w:r><w:t>multi</w:t></w:r><w:br/><w:r><w:t>line</w:t></w:r></w:p>
</w:body></w:document>`;
const docx = buildZip([
  { name: "[Content_Types].xml", data: Buffer.from("<Types/>"), method: 0 },
  { name: "word/document.xml", data: Buffer.from(documentXml), method: 8 }, // deflate 条目
]);
const text = extractDocxText(docx);
assert(text.includes("第一段：Hello docx & PiNasDeck"), "docx 正文提取 + &amp; 实体解码");
assert(text.includes("制表\t和 <标签>"), "tab 保留 + &lt;/&gt; 实体解码");
assert(text.includes("multi\nline"), "w:br 换行");
assert(text.split("\n").length >= 3, "段落分隔");

const storedDocx = buildZip([{ name: "word/document.xml", data: Buffer.from(documentXml), method: 0 }]);
assert(extractDocxText(storedDocx).includes("第一段"), "store(0) 条目兼容");

let threw = false;
try {
  extractDocxText(Buffer.from("not a zip at all"));
} catch {
  threw = true;
}
assert(threw, "非 zip 报错");

assert(docxXmlToText('<w:p>a &amp; b</w:p><w:p>&#20320;好</w:p>').includes("a & b\n你好"), "xml→text 纯函数 + 数字实体");

// ---- 用量数据源优先级 ----
const dir = mkdtempSync(join(tmpdir(), "pnd-usage-"));
mkdirSync(join(dir, "analytics"));
const row = (ts, model, input, output, cache) => {
  const total = input + output + cache;
  return JSON.stringify([ts, "s1", "E:\\proj", model, input, output, cache, 0, total, 0]);
};
// pi-tracker 的旧文件（写满历史）+ 我们自己的新文件（今天一条）
writeFileSync(join(dir, "analytics", "usage.jsonl"), row(1_700_000_000_000, "prov/old-model", 10, 5, 0) + "\n");
writeFileSync(join(dir, "analytics", "pnd-usage.jsonl"), row(Date.now(), "prov/new-model", 100, 20, 80) + "\n");

let agg = await aggregateUsage(dir, { group: "day" });
assert(agg.source === "usage-logger", "存在 pnd-usage 时数据源 = usage-logger");
assert(agg.scanned === 1 && agg.rows[0].model === "prov/new-model" && agg.rows[0].total === 200, "只统计 pnd 文件（防与 pi-tracker 双计），恒等式通过");

writeFileSync(join(dir, "analytics", "pnd-usage.jsonl"), "");
agg = await aggregateUsage(dir, { group: "day" });
assert(agg.source === "pi-tracker" && agg.scanned === 1 && agg.rows[0].model === "prov/old-model", "pnd 为空时回退 pi-tracker 数据");

// 坏行（恒等式不成立）不计入
writeFileSync(join(dir, "analytics", "usage.jsonl"), row(1_700_000_000_000, "prov/x", 10, 5, 0) + "\n[1,2,3]\n");
agg = await aggregateUsage(dir, { group: "day" });
assert(agg.scanned === 1 && agg.skipped === 1, "坏行跳过计数正确");

console.log("\nALL DOCX/USAGE TESTS PASSED");
