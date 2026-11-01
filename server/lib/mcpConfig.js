// MCP 配置管理：读写 pi 的 $PI_AGENT_DIR/mcp.json。
// 结构：{ mcpServers: { <name>: { type?: "http", url } | { command, args?, env? }, ... } }
// 写入校验：名字合法、值为对象、http 型必须有 url、command 型必须有 command（string）。
// 原子写：tmp + rename。改动对「新会话」生效（pi 启动子进程时读配置）。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MCP_FILE = "mcp.json";
const MAX_SERVERS = 64;

export function mcpConfigPath(piAgentDir) {
  return join(piAgentDir, MCP_FILE);
}

export function readMcpConfig(piAgentDir) {
  const file = mcpConfigPath(piAgentDir);
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const servers = raw?.mcpServers;
  if (!servers || typeof servers !== "object") return {};
  return servers;
}

/** 校验并规范化一份 mcpServers 映射；非法结构抛错（信息面向前端展示）。 */
export function validateMcpServers(servers) {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("mcpServers 必须是对象");
  const names = Object.keys(servers);
  if (names.length > MAX_SERVERS) throw new Error(`MCP 服务器最多 ${MAX_SERVERS} 个`);
  const out = {};
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`非法服务器名: ${name}`);
    const cfg = servers[name];
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`${name}: 配置必须是对象`);
    const normalized = { ...cfg };
    const isHttp = typeof cfg.url === "string" && cfg.url;
    const isStdio = typeof cfg.command === "string" && cfg.command;
    if (!isHttp && !isStdio) throw new Error(`${name}: 需要 url（HTTP 型）或 command（命令行型）`);
    if (isHttp && !/^https?:\/\//i.test(cfg.url)) throw new Error(`${name}: url 必须是 http(s) 地址`);
    if (cfg.args !== undefined && (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== "string"))) throw new Error(`${name}: args 必须是字符串数组`);
    if (cfg.env !== undefined && (typeof cfg.env !== "object" || cfg.env === null || Array.isArray(cfg.env))) throw new Error(`${name}: env 必须是对象`);
    if (normalized.enabled === undefined) delete normalized.enabled; // 不强行补默认值，pi 的缺省语义自己管
    out[name] = normalized;
  }
  return out;
}

export function writeMcpConfig(piAgentDir, servers) {
  const validated = validateMcpServers(servers);
  const file = mcpConfigPath(piAgentDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mcpServers: validated }, null, 2));
  renameSync(tmp, file);
  return validated;
}
