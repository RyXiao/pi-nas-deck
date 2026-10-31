// models.json 可视化管理 + 连接测试 + pi 在线更新。
// models.json 位置：<PI_AGENT_DIR>/models.json（容器内 /root/.pi/agent/models.json，挂 volume）。
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./store.js";

const PI_AGENT_DIR = process.env.PI_AGENT_DIR || join(process.env.HOME || "/root", ".pi", "agent");
const MODELS_PATH = join(PI_AGENT_DIR, "models.json");
const MODELS_SCHEMA = "https://pi.dev/schemas/models.schema.json";

export function readModels() {
  if (!existsSync(MODELS_PATH)) return { $schema: MODELS_SCHEMA, providers: {} };
  try {
    return JSON.parse(readFileSync(MODELS_PATH, "utf8"));
  } catch (error) {
    throw new Error(`models.json 解析失败：${error.message}`);
  }
}

export function writeModels(config) {
  if (!config || typeof config !== "object" || typeof config.providers !== "object") {
    throw new Error("非法配置结构");
  }
  writeJson(MODELS_PATH, { $schema: MODELS_SCHEMA, providers: config.providers });
}

/**
 * 连接测试：按 api 类型探测端点。
 * openai-completions: GET <baseUrl>/models（Bearer）
 * anthropic-messages: POST <baseUrl>/messages（x-api-key，最小请求）
 */
export async function testConnection(provider) {
  const { baseUrl, apiKey, api = "openai-completions", models } = provider;
  if (!baseUrl) return { ok: false, detail: "缺少 baseUrl" };
  const base = baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    if (api === "anthropic-messages") {
      const modelId = models?.[0]?.id || "claude-sonnet-4-5-20250929";
      const res = await fetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey || "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: controller.signal,
      });
      // 400/401/404 都能证明"网络通、端点存在"，区分鉴权与连通性
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `鉴权失败 HTTP ${res.status}，检查 API Key` };
      if (res.status === 404) return { ok: false, detail: "端点不存在（404），检查 baseUrl 是否含 /v1 等路径" };
      return { ok: res.status < 500, detail: `HTTP ${res.status}（连通正常${res.status === 400 ? "，请求被拒属预期" : ""}）` };
    }
    // openai 兼容：优先 GET /models，不支持的网关回 404/405 时退回 /chat/completions 探测
    let res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${apiKey || ""}` }, signal: controller.signal });
    if (res.status === 404 || res.status === 405) {
      const modelId = models?.[0]?.id;
      if (!modelId) return { ok: false, detail: "该端点不支持 /models，请至少配置一个模型 ID 再测" };
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey || ""}` },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: controller.signal,
      });
    }
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `鉴权失败 HTTP ${res.status}，检查 API Key` };
    if (res.status >= 500) return { ok: false, detail: `服务端错误 HTTP ${res.status}` };
    return { ok: true, detail: `HTTP ${res.status}，连通正常` };
  } catch (error) {
    return { ok: false, detail: error.name === "AbortError" ? "超时（15s），检查地址/网络" : `网络失败：${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ===== pi 版本与在线更新 =====

export function getPiVersion() {
  return new Promise((resolvePromise) => {
    execFile("pi", ["--version"], { timeout: 15_000, shell: process.platform === "win32" }, (error, stdout) => {
      resolvePromise(error ? null : stdout.trim());
    });
  });
}

const NPM_REGISTRY = process.env.NPM_REGISTRY || "https://registry.npmjs.org";

export async function getLatestPiVersion() {
  const url = `${NPM_REGISTRY}/@earendil-works%2fpi-coding-agent/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.version || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 容器内在线更新 pi。返回 Promise，进度通过 onUpdateLog 回调推送。
 * npm i -g 覆盖镜像内安装；容器重建后回到镜像版本（文档中说明，属预期行为）。
 */
export function updatePi(onLog) {
  return new Promise((resolvePromise) => {
    const registry = process.env.NPM_INSTALL_REGISTRY ? ["--registry", process.env.NPM_INSTALL_REGISTRY] : [];
    const child = execFile(
      "npm",
      ["install", "-g", "@earendil-works/pi-coding-agent@latest", "--no-fund", "--no-audit", ...registry],
      { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        const ok = !error;
        onLog?.(`\n${ok ? "✅ 更新完成" : `❌ 更新失败: ${error.message}`}\n`);
        resolvePromise({ ok, detail: ok ? stdout.slice(-2000) : (stderr || stdout).slice(-2000) });
      },
    );
    child.stdout?.on("data", (chunk) => onLog?.(chunk.toString()));
    child.stderr?.on("data", (chunk) => onLog?.(chunk.toString()));
  });
}
