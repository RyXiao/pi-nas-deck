// 前端源码级回归：点击拦截的分支顺序与 wikilink 排除。
// 背景（v0.3.2 修复）：wiki 链接渲染为 href="#" + data-wiki；若锚点分支用
// closest("a[href^='#']") 会把所有 wikilink 误拦为页内锚点，永远走不到 navigateNote。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dirname, "..", "web", "app.js"), "utf8");

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}

// 1. 锚点选择器必须排除 data-wiki
assert(app.includes(`closest("a[href^='#']:not([data-wiki])")`), "锚点分支排除 data-wiki（v0.3.2 修复行）");
assert(!app.includes(`closest("a[href^='#']")`), "不存在未排除 data-wiki 的旧写法");

// 2. 渲染器输出 data-wiki + href="#"（点击分支依赖这个形态）
assert(app.includes(`data-wiki="`), "renderer 输出 data-wiki 属性");

// 3. 点击处理里 wiki 分支存在且在锚点分支之后（顺序保证 wikilink 先被排除、再走 wiki 导航）
const handlerAt = app.indexOf(`a[href^='#']:not([data-wiki])`);
const wikiBranchAt = app.indexOf(`getAttribute("data-wiki")`);
assert(handlerAt > 0 && wikiBranchAt > handlerAt, "锚点分支在前、wiki 导航分支在后");

// 4. navigateNote 与 md-index 解析链存在
assert(app.includes("async function navigateNote") && app.includes("/api/fs/md-index"), "wiki 导航解析链完整");

// 5. v0.3.3：#标题 片段感知（不再丢弃片段只开文件）
assert(app.includes("function scrollToHeading") && app.includes("if (heading) scrollToHeading(heading)"), "跨文件/同文件 #标题 定位完整");

// 6. v0.3.3：HTML 走路径式预览路由（相对资源自动跟随）+ 存储垫片档
assert(app.includes("/preview/${encodeURIComponent(state.token)}") && app.includes("previewHtmlUrl"), "HTML 预览走路径式路由");
const server = readFileSync(join(import.meta.dirname, "..", "server", "index.js"), "utf8");
assert(server.includes("injectStorageShim") && server.includes("PREVIEW_MIME"), "服务端预览路由含垫片与 MIME 表");

// 7. v0.3.4：解析器在 note-utils.js（测试真实现），app.js 不重复定义；唯一后缀匹配由 note-utils 测试覆盖
const html = readFileSync(join(import.meta.dirname, "..", "web", "index.html"), "utf8");
assert(html.includes('src="/note-utils.js"'), "note-utils.js 已在页面引入");
assert(!app.includes("function resolveWikiTarget") && app.includes("resolveWikiTarget(filePart, index)"), "app.js 使用全局解析器（不重复定义）");
assert(app.includes("ambiguous > 1") && app.includes("同名笔记"), "歧义解析有前端提示");

// 8. v0.4.0 文件管理器：右键菜单/剪贴板/多选/内联改名/快捷键 + 四个管理端点
assert(app.includes('addEventListener("contextmenu"') && app.includes("fsPasteInto") && app.includes("beginInlineRename") && app.includes("fsSelectionItems"), "文件管理器前端链路完整");
for (const route of ["/api/fs/rename", "/api/fs/mkdir", "/api/fs/copy", "/api/fs/move"]) {
  assert(server.includes(route), `管理端点存在：${route}`);
}
assert(server.includes("不能把目录拷贝/移动到它自己的子目录") && server.includes("measurePath"), "子树防护与预算统计在位");

// 9. v0.4.1：PDF 转换链路 / 定时任务 / 文件树时间倒序
assert(server.includes("/api/fs/convert") && app.includes("pdf-convert-btn") && html.includes('id="pdf-convert-btn"'), "PDF→md 转换链路（路由+按钮）完整");
assert(server.includes("/api/scheduler") && app.includes("renderSchedulerTab"), "定时任务链路（路由+设置页）完整");
assert(server.includes('query.get("sort") === "time"') && app.includes("fs-sort-btn"), "文件树时间倒序（服务端参数+前端切换）在位");

// 10. v0.4.2 追加：Chrome 式标签页（工作区标签/左键切换/中键关闭/刷新恢复）
assert(html.includes('id="tab-bar"') && app.includes("renderTabBar") && app.includes("activateTab") && app.includes("closeTab"), "标签页管理器完整");
assert(app.includes('e.button === 1') && app.includes("restoreTabs") && app.includes('setItem("pnd-tabs"'), "中键关闭 + 刷新恢复在位");
assert(!app.includes("state.noteHistory") && !app.includes("previewReturn"), "历史已迁移到每标签（旧全局引用清零）");

console.log("\nNOTE-LINK SOURCE GUARDS PASSED");
