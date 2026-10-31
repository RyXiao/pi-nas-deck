/**
 * usage-logger — PiNasDeck 内置用量记录器（随镜像分发，启动自动同步进 pi 扩展目录）。
 *
 * 每轮助手消息结束（message_end 是唯一携带 usage 的事件，pi-tracker 实测结论一致）后，
 * 把 token 用量追加到 ~/.pi/agent/analytics/pnd-usage.jsonl。
 *
 * 行格式（位置数组，与 PiNasDeck server/lib/usageStats.js 聚合器约定）：
 *   [ts毫秒, sessionFile, cwd, "provider/model", input, output, cache, 0, total, 0]
 * 恒等式：total = input + output + cache（本扩展构造时保证，聚合器按此校验防格式漂移）。
 *
 * 与第三方 pi-tracker 的区别：它写 analytics/usage.jsonl，本扩展写 pnd-usage.jsonl，
 * 互不覆盖；聚合器优先读本文件（装过 pi-tracker 的环境也只统计一份）。
 * 记录失败不打断会话（磁盘故障降级为「本轮不统计」）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const analyticsDir = join(homedir(), ".pi", "agent", "analytics");
const usageFile = join(analyticsDir, "pnd-usage.jsonl");

function safe(fn) {
  try {
    return fn();
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event: any, sessionCtx: any) => {
    const msg = event?.message;
    if (msg?.role !== "assistant" || !msg.usage) return;
    const input = msg.usage.input ?? 0;
    const output = msg.usage.output ?? 0;
    const cache = (msg.usage.cacheRead ?? 0) + (msg.usage.cacheWrite ?? 0);
    const total = input + output + cache;
    const cwd = safe(() => sessionCtx?.cwd ?? "");
    const sessionFile = safe(() => sessionCtx?.sessionManager?.getSessionFile?.() ?? "");
    const model = `${msg.provider || "unknown"}/${msg.model || "unknown"}`;
    const row = [msg.timestamp ?? Date.now(), sessionFile, cwd, model, input, output, cache, 0, total, 0];
    try {
      mkdirSync(analyticsDir, { recursive: true });
      appendFileSync(usageFile, `${JSON.stringify(row)}\n`);
    } catch {
      /* 记录失败不打断会话 */
    }
  });
}
