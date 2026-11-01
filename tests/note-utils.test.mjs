// 链接解析回归（真实实现 web/note-utils.js，非复制）。
// 场景（v0.3.4 修复，源自真实用户库）：wiki 链接相对 wiki/ 子目录书写，而项目根注册
// 在仓库根 → 索引条目前缀多一级；库内每个实体页都叫 profile.md（50 个同名），
// 旧版 basename 兜底"取最短"必然选中 entities/EXAMPLE/profile.md（模板页）。
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { resolveWikiTarget, resolveRelDir } = require(join(import.meta.dirname, "..", "web", "note-utils.js"));

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

// ---- 模拟「根=仓库根」的索引（wiki/ 前缀 + 大量同名 profile.md）----
const repoRootIndex = [];
repoRootIndex.push("wiki/entities/EXAMPLE/profile.md");
for (const name of ["样本食品600001", "样例车业600002", "示例化工600003"]) {
  repoRootIndex.push(`wiki/entities/portfolio/${name}/profile.md`);
}
for (let i = 0; i < 46; i++) repoRootIndex.push(`wiki/entities/other/entity${i}/profile.md`);
repoRootIndex.push("wiki/sources/2026-10-31-样例三季报.md", "wiki/sources/2026-08-25-样本食品2025年年报.md", "wiki/主页.md");
// 确认同名规模
assert(repoRootIndex.filter((f) => f.endsWith("/profile.md")).length === 50, "夹具：50 个同名 profile.md");

// ---- 核心修复：完整后缀唯一匹配（链接相对 wiki/、根在上层） ----
let r = resolveWikiTarget("entities/portfolio/样本食品600001/profile", repoRootIndex);
assert(r.rel === "wiki/entities/portfolio/样本食品600001/profile.md" && r.ambiguous === 0, "样本 profile 唯一后缀命中（修复前打开 EXAMPLE）");
r = resolveWikiTarget("entities/portfolio/样例车业600002/profile", repoRootIndex);
assert(r.rel === "wiki/entities/portfolio/样例车业600002/profile.md", "样例 profile 同样命中");

// ---- 精确匹配优先（根=wiki 目录的注册方式行为不变） ----
const wikiRootIndex = ["entities/EXAMPLE/profile.md", "entities/portfolio/样本食品600001/profile.md", "sources/2026-10-31-样例三季报.md", "主页.md"];
r = resolveWikiTarget("entities/portfolio/样本食品600001/profile", wikiRootIndex);
assert(r.rel === "entities/portfolio/样本食品600001/profile.md" && r.ambiguous === 0, "根=wiki 时精确命中");

// ---- 扁平库无回归（另一个 wiki 的情况） ----
const flatIndex = ["sources/2026-10-31-样例三季报.md", "笔记/主页.md"];
r = resolveWikiTarget("sources/2026-10-31-样例三季报", flatIndex);
assert(r.rel === "sources/2026-10-31-样例三季报.md", "扁平库精确命中无回归");

// ---- 真歧义：basename 兜底多义时必须标记（前端据此提示） ----
r = resolveWikiTarget("profile", repoRootIndex);
assert(r.rel && r.ambiguous === 50, `裸名 profile 歧义标记（ambiguous=50，前端提示「已开路径最短」）`);
// 唯一 basename 不标歧义
r = resolveWikiTarget("主页", repoRootIndex);
assert(r.rel === "wiki/主页.md" && r.ambiguous === 0, "唯一 basename 不标歧义");

// ---- 多个同后缀（不同子树同名路径）也标记歧义 ----
const dupIndex = ["a/x/profile.md", "b/x/profile.md"];
r = resolveWikiTarget("x/profile", dupIndex);
assert(r.rel === "a/x/profile.md" && r.ambiguous === 2, "多同后缀取最短并标记");

// ---- 大小写 / 斜杠 / .md 后缀容错 ----
r = resolveWikiTarget("ENTITIES/Portfolio/样本食品600001/Profile.md", repoRootIndex);
assert(r.rel === "wiki/entities/portfolio/样本食品600001/profile.md", "大小写与 .md 后缀容错");
r = resolveWikiTarget("不存在的笔记", repoRootIndex);
assert(r.rel === null, "不存在返回 null（前端提示找不到）");

// ---- resolveRelDir 回归 ----
assert(resolveRelDir("wiki/a/b.md", "../c/d.md") === "wiki/c/d.md", "相对路径 ../ 解析");
assert(resolveRelDir("主页.md", "sources/x.md") === "sources/x.md", "根文件出发的相对解析");

console.log("\nNOTE-UTILS RESOLVER TESTS PASSED");
