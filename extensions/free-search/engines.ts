/**
 * free-search/engines.ts — 免 key 搜索引擎核心（纯逻辑，无 pi 依赖，可独立测试）
 *
 * 通道设计参考 dsh-free-search v0.6.5（E:\DSH_Desktop\dsh-free-search），
 * 全部端点经 2026-10-19 本机（中国大陆网络）实测直连可用：
 *   - Tavily keyless：POST api.tavily.com/search + header x-tavily-access-mode: keyless（免费匿名额度）
 *   - AnySearch：POST api.anysearch.com/v1/search（匿名免费额度，可选 Bearer 提额）
 *   - Firecrawl keyless：POST api.firecrawl.dev/v2/search（官方免 key 匿名额度）
 *   - Parallel MCP：POST search.parallel.ai/mcp（免 key MCP）
 *   - Bing HTML：www.bing.com/search（免 key；本网络存在"污染缓存页"问题，
 *     用查询-结果 token 覆盖率检测拦截，见 looksRelevant，参考 dsh issue #38）
 * Exa MCP / DuckDuckGo 本网络被墙，不列入。
 */

export interface Source {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

export interface SearchOptions {
  maxResults?: number;
  timeRange?: "day" | "week" | "month" | "year";
  signal?: AbortSignal;
}

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---------------------------------------------------------------- utilities

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function timedFetch(
  url: string,
  init: RequestInit,
  ms: number,
  outer?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    if (outer?.aborted) throw error;
    throw new Error(`connection error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

function uniqueSources(sources: Source[], limit: number): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of sources) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      out.push(s);
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------- Bing 污染页检测（dsh #38）

// token 规则：CJK 取二元组；拉丁/数字取长度 >=2 的词
export function queryOverlapTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const run of query.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 2) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  for (const word of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 2) tokens.add(word);
  }
  return [...tokens];
}

// 改进版相关性检测（比 dsh 的"任一命中即过"更严）：
// 污染页常含查询的通用首词（如词典页命中 "green"/"ammonia"），单点命中不足以证明相关。
// 规则：最长的 3 个 token（区分度最高）至少命中 2 个（查询不足 4 个 token 时要求 1 个），
// 且总体 token 覆盖率 >= 25%。
export function looksRelevant(query: string, sources: Source[]): boolean {
  const tokens = queryOverlapTokens(query);
  if (tokens.length === 0) return true;
  const hay = sources
    .map((s) => `${s.title ?? ""} ${s.snippet ?? ""} ${s.url ?? ""}`)
    .join(" \n ")
    .toLowerCase();
  const lower = tokens.map((t) => t.toLowerCase());
  const coverage = lower.filter((t) => hay.includes(t)).length / lower.length;
  const distinctive = [...tokens].sort((a, b) => b.length - a.length).slice(0, 3);
  const need = tokens.length >= 4 ? 2 : 1;
  const distinctiveHits = distinctive.filter((t) => hay.includes(t.toLowerCase())).length;
  return distinctiveHits >= need && coverage >= 0.25;
}

// ---------------------------------------------------------------- engines

export const ENGINE_NAMES = [
  "tavily-keyless",
  "anysearch",
  "firecrawl-keyless",
  "parallel-mcp",
  "bing",
] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

// 默认回退链：全部实测可用；Bing 因污染缓存页问题垫底
export const DEFAULT_CHAIN: EngineName[] = [
  "tavily-keyless",
  "anysearch",
  "firecrawl-keyless",
  "parallel-mcp",
  "bing",
];

// Tavily：keyless 免 key 模式（dsh-free-search 同款 header）
async function searchTavily(query: string, opts: SearchOptions): Promise<Source[]> {
  const body: Record<string, unknown> = {
    query,
    max_results: Math.min(opts.maxResults ?? 8, 20),
    search_depth: "basic",
  };
  if (opts.timeRange) body.time_range = opts.timeRange;
  const res = await timedFetch(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-tavily-access-mode": "keyless",
      },
      body: JSON.stringify(body),
    },
    15000,
    opts.signal,
  );
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  const results: Source[] = (data.results ?? [])
    .filter((r: any) => r.url)
    .map((r: any) => ({
      url: String(r.url),
      title: r.title ? String(r.title) : undefined,
      snippet: r.content ? String(r.content).slice(0, 400) : undefined,
      publishedAt: r.published_date ? String(r.published_date) : undefined,
    }));
  return uniqueSources(results, opts.maxResults ?? 8);
}

// AnySearch：匿名免费额度
async function searchAnysearch(query: string, opts: SearchOptions): Promise<Source[]> {
  const res = await timedFetch(
    "https://api.anysearch.com/v1/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, max_results: opts.maxResults ?? 8 }),
    },
    12000,
    opts.signal,
  );
  if (!res.ok) throw new Error(`AnySearch HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`AnySearch error: ${data.message ?? data.code}`);
  const results: Source[] = (data.data?.results ?? [])
    .filter((r: any) => r.url)
    .map((r: any) => ({
      url: String(r.url),
      title: r.title ? String(r.title) : undefined,
      snippet: r.snippet ? String(r.snippet).slice(0, 400) : undefined,
      publishedAt: r.published_at ? String(r.published_at) : undefined,
    }));
  return uniqueSources(results, opts.maxResults ?? 8);
}

// Firecrawl：官方免 key 匿名额度；tbs 支持时间过滤
const FIRECRAWL_TBS: Record<string, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};
async function searchFirecrawl(query: string, opts: SearchOptions): Promise<Source[]> {
  const body: Record<string, unknown> = {
    query,
    limit: Math.min(Math.max(opts.maxResults ?? 8, 1), 10),
  };
  if (opts.timeRange && FIRECRAWL_TBS[opts.timeRange]) body.tbs = FIRECRAWL_TBS[opts.timeRange];
  const res = await timedFetch(
    "https://api.firecrawl.dev/v2/search",
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    },
    20000,
    opts.signal,
  );
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(`Firecrawl error: ${data.error ?? "unknown"}`);
  const results: Source[] = (data.data?.web ?? [])
    .filter((r: any) => r.url)
    .map((r: any) => ({
      url: String(r.url),
      title: r.title ? String(r.title) : undefined,
      snippet: r.description ? String(r.description).slice(0, 400) : undefined,
      publishedAt: r.publishedDate ? String(r.publishedDate) : undefined,
    }));
  return uniqueSources(results, opts.maxResults ?? 8);
}

// Parallel MCP：免 key 公开 MCP（JSON 或 SSE 响应）
async function searchParallel(query: string, opts: SearchOptions): Promise<Source[]> {
  let objective = query;
  if (opts.timeRange) {
    const days = { day: 1, week: 7, month: 30, year: 365 }[opts.timeRange]!;
    const after = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    objective = `${query} (prefer results published after ${after})`;
  }
  const res = await timedFetch(
    "https://search.parallel.ai/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: {
            objective,
            search_queries: [query],
            session_id: crypto.randomUUID(),
          },
        },
      }),
    },
    25000,
    opts.signal,
  );
  if (!res.ok) throw new Error(`Parallel HTTP ${res.status}`);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          json = JSON.parse(line.slice(6));
          break;
        } catch {
          /* try next line */
        }
      }
    }
  }
  if (!json || json.error) throw new Error(`Parallel error: ${json?.error?.message ?? "no data"}`);
  const blocks = (json.result?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text);
  if (json.result?.isError)
    throw new Error(`Parallel tool error: ${String(blocks.join(" ")).slice(0, 150)}`);
  let payload: any = null;
  for (const block of blocks) {
    try {
      payload = JSON.parse(block);
      break;
    } catch {
      /* try next block */
    }
  }
  const results: Source[] = (payload?.results ?? [])
    .filter((r: any) => r.url)
    .map((r: any) => {
      const excerpt = (r.excerpts ?? []).find((e: any) => String(e).trim().length > 0);
      return {
        url: String(r.url),
        title: r.title ? String(r.title) : undefined,
        snippet: excerpt ? String(excerpt).slice(0, 400) : undefined,
        publishedAt: r.publish_date ? String(r.publish_date) : undefined,
      };
    });
  return uniqueSources(results, opts.maxResults ?? 8);
}

// Bing HTML：免 key；带重试与污染页检测（本网络 cn.bing.com 常返回无关缓存 SERP）
const BING_MARKETS: Record<string, string> = {
  zh: "zh-CN",
  en: "en-US",
  ja: "ja-JP",
  ko: "ko-KR",
  de: "de-DE",
};
async function searchBing(query: string, opts: SearchOptions): Promise<Source[]> {
  const isCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(query);
  const market = isCjk ? BING_MARKETS.zh : BING_MARKETS.en;
  const acceptLang = isCjk ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9";
  const params = new URLSearchParams({ q: query, mkt: market, adlt: "off" });
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 1500 * (attempt - 1)));
    try {
      const res = await timedFetch(
        `https://www.bing.com/search?${params}`,
        {
          headers: {
            "user-agent": USER_AGENT,
            "accept-language": acceptLang,
          },
        },
        12000,
        opts.signal,
      );
      if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
      const html = await res.text();
      const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
      const results: Source[] = [];
      for (const block of blocks) {
        const href = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/)?.[1];
        const title = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/)?.[1];
        const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1];
        if (!href) continue;
        results.push({
          url: href,
          title: title ? stripTags(title) : undefined,
          snippet: snippet ? stripTags(snippet).slice(0, 400) : undefined,
        });
      }
      if (results.length === 0) {
        lastError = new Error("Bing returned 0 parseable results");
        continue;
      }
      // 污染缓存页检测：结果与查询几乎无 token 重叠 → 判 0 结果，交回退链
      if (!looksRelevant(query, results)) {
        lastError = new Error("Bing returned an irrelevant cached SERP (pollution filtered)");
        continue;
      }
      return uniqueSources(results, opts.maxResults ?? 8);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const ENGINE_IMPL: Record<EngineName, (q: string, o: SearchOptions) => Promise<Source[]>> = {
  "tavily-keyless": searchTavily,
  anysearch: searchAnysearch,
  "firecrawl-keyless": searchFirecrawl,
  "parallel-mcp": searchParallel,
  bing: searchBing,
};

// ---------------------------------------------------------------- chain

export interface ChainResult {
  sources: Source[];
  engine: EngineName;
  errors: string[];
}

export async function searchWeb(
  query: string,
  opts: SearchOptions & { engine?: EngineName | "auto" } = {},
): Promise<ChainResult> {
  const chain =
    opts.engine && opts.engine !== "auto" ? [opts.engine] : DEFAULT_CHAIN;
  const errors: string[] = [];
  for (const engine of chain) {
    try {
      const sources = await ENGINE_IMPL[engine](query, opts);
      if (sources.length > 0) return { sources, engine, errors };
      errors.push(`${engine}: 0 results`);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      errors.push(`${engine}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`所有搜索引擎失败：\n${errors.join("\n")}`);
}

// ---------------------------------------------------------------- fetch

export interface FetchResult {
  url: string;
  finalUrl: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

function htmlToText(html: string): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  out = out
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  out = stripTags(out);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

// 直连抓取失败（403/401/429/999 或 Cloudflare 挑战页）时，走 Firecrawl keyless scrape 兜底
async function fetchViaFirecrawl(
  url: string,
  opts: { maxChars: number; signal?: AbortSignal },
): Promise<FetchResult> {
  const res = await timedFetch(
    "https://api.firecrawl.dev/v2/scrape",
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    },
    30000,
    opts.signal,
  );
  if (!res.ok) throw new Error(`Firecrawl scrape HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(`Firecrawl scrape error: ${data.error ?? "unknown"}`);
  const md: string = data.data?.markdown ?? "";
  const truncated = md.length > opts.maxChars;
  return {
    url,
    finalUrl: data.data?.metadata?.sourceURL ?? url,
    contentType: "text/markdown (via firecrawl)",
    text: truncated ? md.slice(0, opts.maxChars) : md,
    truncated,
  };
}

const CLOUDFLARE_CHALLENGE = (body: string) =>
  /cf-chl-|cloudflare|checking your browser|just a moment/i.test(body.slice(0, 3000));

export async function fetchContent(
  url: string,
  opts: { maxChars?: number; raw?: boolean; signal?: AbortSignal } = {},
): Promise<FetchResult> {
  const maxChars = opts.maxChars ?? 30000;
  const fcOpts = { maxChars, signal: opts.signal };
  let res: Response;
  try {
    res = await timedFetch(
      url,
      { headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" } },
      30000,
      opts.signal,
    );
  } catch (error) {
    // 连接层失败（超时/重置）也交给 Firecrawl 兜底
    if (opts.signal?.aborted) throw error;
    return fetchViaFirecrawl(url, fcOpts);
  }
  if (!res.ok) {
    if ([401, 403, 429, 999].includes(res.status)) return fetchViaFirecrawl(url, fcOpts);
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const rawBody = await res.text();
  if (CLOUDFLARE_CHALLENGE(rawBody)) return fetchViaFirecrawl(url, fcOpts);
  const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /^\s*</.test(rawBody.slice(0, 200));
  let text: string;
  if (opts.raw || !isHtml) {
    text = rawBody;
  } else {
    const doc = rawBody;
    // 提取 main/article/正文容器优先，失败则全文
    const mainMatch =
      doc.match(/<main[\s\S]*?<\/main>/i) ??
      doc.match(/<article[\s\S]*?<\/article>/i);
    text = htmlToText(mainMatch ? mainMatch[0] : doc);
  }
  const truncated = text.length > maxChars;
  return {
    url,
    finalUrl: res.url,
    contentType,
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
  };
}
