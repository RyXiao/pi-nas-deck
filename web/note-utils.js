// 笔记链接解析（浏览器与 node 测试共用；app.js 经 <script> 引入全局函数）。
// 解析顺序对齐 Obsidian：完整路径精确 → 完整后缀唯一 → basename（多义时取最短并标记）。
// 关键场景：wiki 链接相对 wiki/ 子目录书写、而项目根注册在仓库根时，索引条目前缀
// 多出一级（如 wiki/entities/...），精确匹配必失败——唯一后缀匹配是正确性关键，
// basename 兜底在同名文件众多（每个实体页都叫 profile.md）时会选错，必须显式告知。

/** Obsidian 式解析：返回 { rel, ambiguous }；ambiguous = basename 兜底时的同名数（>1 表示有歧义）。 */
function resolveWikiTarget(target, index) {
  const clean = String(target).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "").trim().toLowerCase();
  if (!clean) return { rel: null, ambiguous: 0 };
  const norm = (f) => f.replace(/\.md$/i, "").toLowerCase();
  // 1) 完整路径精确
  const exact = index.find((f) => norm(f) === clean);
  if (exact) return { rel: exact, ambiguous: 0 };
  // 2) 完整后缀唯一匹配（链接相对子目录书写、项目根在上层时的关键一步）
  const suffixed = index.filter((f) => norm(f).endsWith("/" + clean));
  if (suffixed.length === 1) return { rel: suffixed[0], ambiguous: 0 };
  if (suffixed.length > 1) {
    // 多个同后缀（不同子树里同名路径）：取最短并标记歧义
    suffixed.sort((a, b) => a.length - b.length);
    return { rel: suffixed[0], ambiguous: suffixed.length };
  }
  // 3) basename 兜底（同名文件多时易错，标记歧义让前端提示）
  const base = clean.split("/").pop();
  const matches = index.filter((f) => norm(f) === base || norm(f).endsWith("/" + base));
  if (!matches.length) return { rel: null, ambiguous: 0 };
  matches.sort((a, b) => a.length - b.length);
  return { rel: matches[0], ambiguous: matches.length };
}

/** 相对路径解析（posix 语义，基于当前文件所在目录）。 */
function resolveRelDir(baseFile, rel) {
  const segs = baseFile.split("/").slice(0, -1);
  for (const part of String(rel).replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return segs.join("/");
}

if (typeof module !== "undefined" && module.exports) module.exports = { resolveWikiTarget, resolveRelDir };
