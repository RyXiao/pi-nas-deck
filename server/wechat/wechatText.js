// 微信侧文本适配：Agent 的 Markdown 输出降级为聊天窗可读纯文本。
// 移植自 PiDeck（MIT）src/main/wechat/weChatText.ts。规则全部是保守字符级替换，不重排代码块。

export const WECHAT_TEXT_CHUNK_MAX = 1_500;

/** 去掉宿主动作标记（[SEND_FILE:...] 等），微信通道不支持附件。 */
export function stripActionMarkers(text) {
  return text
    .replace(/^\s*\[(?:SEND_FILE|CREATE_DOC|SEND_IMAGE|SEND_TO_FEISHU):[^\]]*\]\s*$/gm, "")
    .replace(/\[(?:SEND_FILE|CREATE_DOC|SEND_IMAGE|SEND_TO_FEISHU):[^\]]*\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 去掉推理块；未闭合的 <thinking>（流式截断）整段丢弃。 */
export function stripThinkingBlocks(text) {
  const closed = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  const unclosed = closed.search(/<thinking>/i);
  if (unclosed >= 0) return closed.slice(0, unclosed);
  return closed.replace(/<\/?thinking>/gi, "");
}

/** Markdown → 纯文本（保守替换，目标是看得懂，不是渲染还原）。 */
export function stripMarkdown(text) {
  let out = text;
  // 代码围栏：保留内容去掉 ``` 行
  out = out.replace(/^[\t ]*```[^\n]*$/gm, "");
  // 行内代码去反引号
  out = out.replace(/`([^`\n]+)`/g, "$1");
  // 标题去 #
  out = out.replace(/^[\t ]{0,3}#{1,6}[\t ]+/gm, "");
  // 粗斜体去标记
  out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,，。])/g, "$1$2");
  out = out.replace(/__([^_\n]+)__/g, "$1");
  // 图片降级为链接（必须排在普通链接前，![alt](url) 是 [alt](url) 超集）
  out = out.replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => (label ? `${label} (${url})` : url));
  out = out.replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => (label ? `${label} (${url})` : url));
  // 引用去 >
  out = out.replace(/^[\t ]*>[\t ]?/gm, "");
  // 分隔线
  out = out.replace(/^[\t ]*(?:-{3,}|\*{3,}|_{3,})[\t ]*$/gm, "──────────");
  // 列表 * 统一成 -
  out = out.replace(/^([\t ]*)[*+][\t ]+/gm, "$1- ");
  // 表格：去对齐行，行内单元格空格连接
  out = out.replace(/^[\t ]*\|?[\t :|-]+\|[\t :|-]*$/gm, "");
  out = out.replace(/^[\t ]*\|(.+)\|[\t ]*$/gm, (_m, row) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)
      .join("  "),
  );
  out = out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

export function prepareOutgoingText(text) {
  return stripMarkdown(stripActionMarkers(stripThinkingBlocks(text))).trim();
}

/** 按行边界切分（单行超长才硬切），避免把路径/代码从中间断开。 */
export function splitForWeChat(text, limit = WECHAT_TEXT_CHUNK_MAX) {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** 取最近一条失败信息（role=error 或 stopReason=error）。 */
export function pickLatestFailureText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role !== "error" && message.stopReason !== "error") continue;
    const text = stripThinkingBlocks(message.text || "").trim();
    if (text) return text;
  }
  return "";
}

/** 取最近一条有正文的助手消息（只有思考的消息不算回复）。 */
export function pickLatestAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !message.text) continue;
    const text = stripThinkingBlocks(message.text).trim();
    if (text) return text;
  }
  return "";
}
