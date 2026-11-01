/**
 * ask-choice — 让模型向用户出选择题（PiNasDeck 网页端渲染选项按钮）。
 *
 * 背景：pi 的 RPC 协议没有交互问答机制（AskUserQuestion 只是 Anthropic 兼容层的
 * 工具名映射），本扩展用零侵入的「文件握手」实现：
 *   1. 工具阻塞，把问题写入会话 cwd 的 .pnd-ask/<toolCallId>.json；
 *   2. 网页端从 tool_execution_start 事件看到问题 → 渲染选项按钮；
 *   3. 用户点击 → 网页经 /api/fs/file 写入 .pnd-ask/<toolCallId>.answer.json；
 *   4. 工具轮询读到回答即返回「用户选择：xxx」，模型继续。
 * 10 分钟无人回答则超时返回，模型按默认判断继续（定时任务/微信场景同样安全降级）。
 * 清理：回答或超时后删除问题/答案文件（.pnd-ask 残留无害）。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ASK_DIR = ".pnd-ask";
const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 500;

const askUserChoiceTool = defineTool({
  name: "ask_user_choice",
  label: "Ask user choice",
  description:
    "向用户提出选择题（2~6 个选项），网页聊天界面会渲染选项按钮等待用户点击，返回所选文本。" +
    "仅在确实需要用户决策（如方案取舍、目标优先级）时使用；能自行给出合理默认的不要问。",
  parameters: Type.Object({
    question: Type.String({ description: "要问的问题（一句话）" }),
    options: Type.Array(Type.String({ description: "选项文本（2~6 个，简短明确）" }), { description: "选项列表" }),
    allow_other: Type.Boolean({ description: "是否提供「其它」输入框让用户自填（默认 false）" }),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },

  async execute(toolCallId, params, signal) {
    const options = (params.options || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
    if (options.length < 2) {
      return { content: [{ type: "text", text: "错误：选项至少需要 2 个" }], details: { error: "options<2" } };
    }
    // toolCallId 作为问题 id：网页端从事件里拿同一个 id 写回答文件
    const askDir = join(process.cwd(), ASK_DIR);
    mkdirSync(askDir, { recursive: true });
    const questionPath = join(askDir, `${toolCallId}.json`);
    const answerPath = join(askDir, `${toolCallId}.answer.json`);
    writeFileSync(
      questionPath,
      JSON.stringify({ askId: toolCallId, question: String(params.question || ""), options, allowOther: !!params.allow_other, askedAt: Date.now() }, null, 2),
    );
    const deadline = Date.now() + TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) break;
        if (existsSync(answerPath)) {
          let answer = "";
          try {
            answer = String(JSON.parse(readFileSync(answerPath, "utf8")).answer || "");
          } catch {
            /* 坏文件当未回答 */
          }
          if (answer) {
            return { content: [{ type: "text", text: `用户选择：${answer}` }], details: { askId: toolCallId, answer } };
          }
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } finally {
      // 无论成败都清理问题/答案文件（用户侧未点删则超时后由这里兜底）
      try {
        unlinkSync(questionPath);
      } catch {
        /* 已删/不存在 */
      }
      try {
        unlinkSync(answerPath);
      } catch {
        /* 已删/不存在 */
      }
    }
    return {
      content: [{ type: "text", text: "用户超时未回答（10 分钟）。请按你的最佳默认判断继续推进，并在回复中说明所做假设。" }],
      details: { askId: toolCallId, timeout: true },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(askUserChoiceTool);
}
