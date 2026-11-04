/**
 * ask-choice — 让模型向用户出选择题。
 *
 * v0.5.0 起改用 pi 1.5 官方 RPC 扩展 UI 子协议（docs/rpc-extension-ui.md）：
 *   ctx.ui.select(...) → pi 发出 extension_ui_request → PiNasDeck 网页渲染选项卡片
 *   → 回 extension_ui_response（value / cancelled）→ 工具返回所选文本。
 * 相比 v0.4.3 的文件握手：无 .pnd-ask 文件残留、无需客户端跟踪超时
 * （带 timeout 由 pi 侧自动解决返回 undefined），且取消/超时语义由协议原生定义。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMEOUT_MS = 10 * 60 * 1000;

const askUserChoiceTool = defineTool({
  name: "ask_user_choice",
  label: "Ask user choice",
  description:
    "向用户提出选择题（2~6 个选项），聊天界面会渲染选项按钮等待用户点击，返回所选文本。" +
    "仅在确实需要用户决策（如方案取舍、目标优先级）时使用；能自行给出合理默认的不要问。",
  parameters: Type.Object({
    question: Type.String({ description: "要问的问题（一句话）" }),
    options: Type.Array(Type.String({ description: "选项文本（2~6 个，简短明确）" }), { description: "选项列表" }),
    allow_other: Type.Boolean({ description: "（预留）是否允许自填其它答案，默认 false" }),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const options = (params.options || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
    if (options.length < 2) {
      return { content: [{ type: "text", text: "错误：选项至少需要 2 个" }], details: { error: "options<2" } };
    }
    try {
      const answer = await ctx?.ui?.select?.(String(params.question || "请选择"), options, { timeout: TIMEOUT_MS });
      if (answer === undefined || answer === null) {
        return {
          content: [{ type: "text", text: "用户超时或取消了选择。请按你的最佳默认判断继续推进，并在回复中说明所做假设。" }],
          details: { timeout: true },
        };
      }
      return { content: [{ type: "text", text: `用户选择：${answer}` }], details: { answer: String(answer) } };
    } catch (error) {
      return {
        content: [{ type: "text", text: `选择交互不可用（${error?.message || error}），请按最佳默认继续。` }],
        details: { error: String(error?.message || error) },
      };
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(askUserChoiceTool);
}
