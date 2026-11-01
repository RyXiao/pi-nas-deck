// PDF → Markdown 转换回归：语法编译、侧文件命名、缓存复用、真实提取端到端。
// 端到端用临时 venv + pypdf（纯 Python 包，安装快），并手工构造最小合法 PDF。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { convertPdfToMd, pdfSidecarPath, resolvePython } from "../server/lib/pdfConvert.js";

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

const SCRIPT = join(import.meta.dirname, "..", "server", "scripts", "pdf2md.py");

// 1. 脚本语法（python 存在才跑；CI/容器内必有）
const pyCheck = spawnSync("python", ["-m", "py_compile", SCRIPT], { encoding: "utf8" }) ?? spawnSync("python3", ["-m", "py_compile", SCRIPT]);
assert((pyCheck.status ?? 1) === 0 || (spawnSync("python3", ["-m", "py_compile", SCRIPT]).status ?? 1) === 0, "pdf2md.py 语法编译通过");

// 2. 侧文件命名
assert(pdfSidecarPath("/a/b/report.pdf") === "/a/b/report.md", "侧文件命名：同名 .md");
assert(pdfSidecarPath("/a/B.PDF") === "/a/B.md", "大写扩展名");

// 3. 缓存复用：md 比 pdf 新 → 不需要 python 也能返回 cached
const dir = mkdtempSync(join(tmpdir(), "pnd-pdf-"));
const fakePdf = join(dir, "cache.pdf");
writeFileSync(fakePdf, "not a real pdf");
const fakeMd = join(dir, "cache.md");
writeFileSync(fakeMd, "# 已转换");
utimesSync(fakeMd, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
const cached = await convertPdfToMd(fakePdf, { python: "这个解释器不存在" });
assert(cached.cached === true && cached.mdPath === fakeMd, "缓存命中（md 比 pdf 新，跳过转换）");

// 4. 真实端到端：临时安装 pypdf（--target 目录 + PYTHONPATH，避开 venv shim 的非 ASCII 路径问题）
const pkgDir = join(dir, "pylibs");
const pip = spawnSync("python", ["-m", "pip", "install", "--quiet", "--target", pkgDir, "-i", "https://mirrors.aliyun.com/pypi/simple", "pypdf"], { encoding: "utf8" });
assert(pip.status === 0, `安装 pypdf 到临时目录（${(pip.stderr || "").slice(-80)}）`);
process.env.PYTHONPATH = pkgDir; // 子进程继承；仅本测试进程内有效

// 最小合法 PDF（含真实字节偏移的 xref/trailer，pypdf 严格校验）
function buildPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefPos = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`;
  return body;
}
const realPdf = join(dir, "real.pdf");
writeFileSync(realPdf, buildPdf("Hello PiNasDeck PDF"));
const result = await convertPdfToMd(realPdf, { python: "python" });
assert(result.ok && !result.cached && result.pages === 1 && result.engine === "pypdf", `真实提取成功（pages=${result.pages}, engine=${result.engine}）`);
const md = readFileSync(result.mdPath, "utf8"); // 不经 python print（Windows 控制台编码会搞花中文）
assert(md.includes("Hello PiNasDeck PDF"), "提取文本包含 PDF 内容");
assert(md.includes("## 第 1 页"), "产物按页分节");
// 二次调用走缓存
const again = await convertPdfToMd(realPdf, { python: "python" });
assert(again.cached === true, "二次调用复用缓存");

// 5. 非 pdf 拒绝
let threw = false;
try {
  await convertPdfToMd(join(dir, "cache.md"));
} catch {
  threw = true;
}
assert(threw, "非 .pdf 拒绝");

// 6. 解析优先级（不实际执行）
if (!process.env.PND_PYTHON) assert(resolvePython() === "/opt/agent-venv/bin/python", "默认解释器 = 镜像 venv");

rmSync(dir, { recursive: true, force: true });
console.log("\nPDF-CONVERT TESTS PASSED");
