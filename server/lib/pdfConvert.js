// PDF → Markdown 服务端转换：复用镜像内 /opt/agent-venv（pdfplumber/pypdf 都在），
// 让 agent 只读文本而不是按页截图喂视觉模型——token 成本降一个数量级。
// 产物 = pdf 同目录的同名 .md 侧文件；存在且比 pdf 新则直接复用（缓存）。
// 开发机/无 venv 环境通过 PND_PYTHON 覆盖解释器；彻底缺失时返回明确的 501 语义错误。
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pdf2md.py");
const CONVERT_TIMEOUT_MS = 180_000;
const MAX_PAGES = 500;

export function pdfSidecarPath(pdfPath) {
  return String(pdfPath).replace(/\.pdf$/i, "") + ".md";
}

/** 解释器优先级：显式环境变量 > 镜像 venv。实际可用性由 spawn 结果最终判定。 */
export function resolvePython() {
  return process.env.PND_PYTHON || "/opt/agent-venv/bin/python";
}

/**
 * 转换（或复用缓存）。
 * @returns {Promise<{ok:true, cached:boolean, mdPath:string, pages?:number, total?:number, engine?:string, chars:number}>}
 */
export function convertPdfToMd(pdfPath, { python = resolvePython(), timeoutMs = CONVERT_TIMEOUT_MS, maxPages = MAX_PAGES } = {}) {
  if (!/\.pdf$/i.test(pdfPath) || !existsSync(pdfPath)) return Promise.reject(new Error("仅支持已存在的 .pdf 文件"));
  const mdPath = pdfSidecarPath(pdfPath);
  // 缓存：md 存在且不比 pdf 旧 → 直接复用（同一份 PDF 的多轮分析不再重复提取）
  if (existsSync(mdPath) && statSync(mdPath).mtimeMs >= statSync(pdfPath).mtimeMs) {
    return Promise.resolve({ ok: true, cached: true, mdPath, chars: statSync(mdPath).size });
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [SCRIPT, pdfPath, mdPath, String(maxPages)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`PDF 转换超时（>${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") reject(new Error("转换器不可用：容器内缺少 /opt/agent-venv（需 v0.3.0+ 镜像；开发机可用 PND_PYTHON 指定解释器）"));
      else reject(error);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      let info = null;
      try {
        info = JSON.parse(stdout.trim().split("\n").pop() || "null");
      } catch {
        /* JSON 坏了走下方报错 */
      }
      if (info?.ok) return resolvePromise({ ok: true, cached: false, mdPath, pages: info.pages, total: info.total, engine: info.engine, chars: info.chars });
      const detail = info?.error || stderr.trim().split("\n").pop() || `退出码异常（${stdout.slice(0, 200)}）`;
      if (/No module named/.test(detail)) return reject(new Error("转换器缺少 pdfplumber/pypdf（镜像 venv 未装齐；开发机可 pip install pypdf）"));
      reject(new Error(`PDF 转换失败：${detail}`));
    });
  });
}
