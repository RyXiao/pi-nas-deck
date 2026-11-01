/**
 * free-search — 免 API key 的 web_search / web_fetch 工具
 *
 * 通道设计参考 dsh-free-search（DeepSeek Harness 的免费搜索插件），
 * 引擎实现在 ./engines.ts（Tavily keyless / AnySearch / Firecrawl keyless /
 * Parallel MCP / Bing HTML 污染检测），全部端点免 key 且经本机网络实测可用。
 *
 * 安装：本文件位于 ~/.pi/agent/extensions/free-search/index.ts，pi 启动时自动加载。
 * 与 @bytetrue/pi-web-search 等注册同名工具的扩展互斥（pi 工具名唯一）。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENGINE_NAMES, searchWeb, fetchContent, type EngineName } from "./engines.js";

function formatResults(
  sources: { url: string; title?: string; snippet?: string; publishedAt?: string }[],
  engine: string,
  errors: string[],
): string {
  const lines: string[] = [];
  sources.forEach((s, i) => {
    const meta = [s.publishedAt].filter(Boolean).join(" · ");
    lines.push(`[${i + 1}] ${s.title ?? s.url}`);
    lines.push(`    ${s.url}${meta ? `  (${meta})` : ""}`);
    if (s.snippet) lines.push(`    ${s.snippet.replace(/\s+/g, " ").slice(0, 300)}`);
  });
  let footer = `\n(引擎: ${engine}, ${sources.length} 条结果)`;
  if (errors.length > 0) {
    footer += `\n(回退记录: ${errors.join("; ")})`;
  }
  return lines.join("\n") + footer;
}

const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description:
    "免费网络搜索（无需 API key）。自动在 Tavily-keyless / AnySearch / Firecrawl / Parallel / Bing 之间回退。返回标题、URL、摘要、发布日期。",
  parameters: Type.Object({
    query: Type.String({ description: "搜索查询（单条）" }),
    queries: Type.Optional(
      Type.Array(Type.String(), { maxItems: 5, description: "多条查询并发搜索（可替代 query）" }),
    ),
    max_results: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 15, description: "每条查询返回结果数（默认 8）" }),
    ),
    time_range: Type.Optional(
      Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
        description: "时间过滤（tavily/firecrawl/parallel 支持）",
      }),
    ),
    engine: Type.Optional(
      Type.Union(
        [...ENGINE_NAMES.map((n) => Type.Literal(n)), Type.Literal("auto")],
        { description: "指定引擎（默认 auto 按回退链）" },
      ),
    ),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },

  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    const queries = params.queries?.length ? params.queries : [params.query];
    const maxResults = params.max_results ?? 8;
    const parts: string[] = [];
    let anyOk = false;
    const chainErrors: string[] = [];
    for (const q of queries) {
      try {
        const { sources, engine, errors } = await searchWeb(q, {
          maxResults,
          timeRange: params.time_range,
          engine: (params.engine as EngineName | "auto" | undefined) ?? "auto",
          signal,
        });
        anyOk = true;
        parts.push(`### 查询: ${q}\n${formatResults(sources, engine, errors)}`);
      } catch (error) {
        chainErrors.push(`${q}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!anyOk) {
      throw new Error(`web_search 失败：\n${chainErrors.join("\n")}`);
    }
    const text = parts.join("\n\n");
    return {
      content: [{ type: "text" as const, text }],
      details: { queries, ok: anyOk, failures: chainErrors.length ? chainErrors : undefined },
    };
  },
});

const webFetchTool = defineTool({
  name: "web_fetch",
  label: "Web Fetch",
  description:
    "抓取 URL 内容并提取正文文本（HTML 自动去脚本/样式转纯文本）。大页面截断并在结果中标注。",
  parameters: Type.Object({
    url: Type.String({ description: "要抓取的 http(s) URL" }),
    max_chars: Type.Optional(
      Type.Integer({ minimum: 1000, maximum: 200000, description: "最大返回字符数（默认 30000）" }),
    ),
    raw: Type.Optional(Type.Boolean({ description: "true 则返回原始 HTML 而非提取文本" })),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },

  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    let url = params.url.trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const result = await fetchContent(url, {
      maxChars: params.max_chars,
      raw: params.raw,
      signal,
    });
    const header = `# ${result.finalUrl}\n(content-type: ${result.contentType || "unknown"}${
      result.truncated ? `，已截断至 ${result.text.length} 字符（完整内容请用 bash 工具抓取）` : ""
    })\n\n`;
    return {
      content: [{ type: "text" as const, text: header + result.text }],
      details: { url: result.finalUrl, truncated: result.truncated, chars: result.text.length },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
}
