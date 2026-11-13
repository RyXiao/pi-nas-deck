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

// 11. v0.4.3：定时任务模型 / txt·json 编辑 / 选择题（文件握手）
assert(app.includes("modelSel"), "定时任务表单含模型选择");
const schedSrc = readFileSync(join(import.meta.dirname, "..", "server", "lib", "scheduler.js"), "utf8");
assert(schedSrc.includes("set_model") && schedSrc.includes("task.model") && schedSrc.includes("model = { provider, id }"), "定时任务模型校验+执行前 set_model 完整");
assert(server.includes("\\.(md|markdown|txt|json)$") && app.includes("isEditable"), "编辑白名单含 txt/json");
const askExt = readFileSync(join(import.meta.dirname, "..", "extensions", "ask-choice", "index.ts"), "utf8");
assert(askExt.includes("ask_user_choice") && askExt.includes("ctx?.ui?.select"), "选择题扩展用 pi 1.5 原生 ctx.ui.select");
assert(askExt.includes("ctx?.ui?.select") && !askExt.includes("unlinkSync") && !app.includes(".answer.json"), "选择题走原生协议，旧文件握手（写/删文件）已移除");
assert(app.includes("handleExtensionUiRequest") && app.includes("sendUiResponse") && server.includes("extension_ui_response"), "扩展 UI 子协议链路完整");

// 12. v0.5.0：pi 1.5 锁定 / 本轮产出文件 / 连接期消息不再静默丢
const dockerfile = readFileSync(join(import.meta.dirname, "..", "Dockerfile"), "utf8");
assert(/ARG PI_VERSION=1\.5\.[0-9]+/.test(dockerfile), "Dockerfile 锁定 pi 1.5.x");
assert(server.includes("/api/fs/changed-since") && app.includes("fetchTurnOutputs"), "本轮产出文件链路完整");
assert(app.includes("pendingPrompt") && app.includes("flushPendingPrompt") && app.includes('msg.type === "error"'), "连接期消息自动补发 + 服务端错误可见");

// 13. v0.5.1：供应商重命名 / baseUrl 拉模型 / 会话状态点 / 移动端顶栏
assert(app.includes("pendingName") && app.includes("同名供应商已存在"), "供应商可重命名（校验+去重）");
assert(server.includes("/api/models/fetch") && app.includes("按 baseUrl 获取模型列表"), "模型清单拉取链路完整");
const sessSrc = readFileSync(join(import.meta.dirname, "..", "server", "lib", "sessionManager.js"), "utf8");
assert(sessSrc.includes("streaming:") && app.includes("sess-dot green") && app.includes("sess-dot blue"), "会话状态点（绿=运行/蓝=待命）");
assert(html.includes('id="mobile-topbar"') && html.includes('id="welcome-new-btn"') && app.includes("welcome-new-btn"), "移动端顶栏 + 对话优先首页");

// 14. v0.5.1 修：role=error 实时渲染（0s 静默）/ 下拉带服务商名 / 保存提示重开会话
assert(app.includes('record.message?.role === "error"') && app.includes("renderLiveError"), "provider 错误实时渲染（0s 静默修复）");
assert(app.includes("${model.name || model.id} · ${model.provider}"), "模型下拉选项带服务商名");
assert(app.includes("新模型对已开的会话需关闭重开才生效"), "保存模型提示 pi 进程缓存语义");

// 15. v0.5.2：成本换算（价格表从 models.json cost 来，缺价不偷换成 0）
assert(server.includes("costs[`${pname}/${m.id}`]") && app.includes("fmtCost") && app.includes("priceMissing"), "成本换算链路完整");
assert(app.includes("model-price") && app.includes("输入 $/M"), "模型表单可填价格");

// 16. v0.5.3：subagent 可视化 / Ctrl+K 全局搜索 / 进程池治理
assert(app.includes("renderSubagentCard") && app.includes("subagent-card"), "subagent 子代理卡片");
assert(html.includes('id="palette"') && app.includes("runPaletteSearch") && server.includes("/api/fs/search"), "Ctrl+K 全局搜索（会话+文件）");
const smSrc = readFileSync(join(import.meta.dirname, "..", "server", "lib", "sessionManager.js"), "utf8");
assert(smSrc.includes("_enforceLimit") && smSrc.includes("MAX_CONCURRENT") && server.includes("/api/sessions/processes"), "进程池 LRU 治理 + 设置页可见");

// 17. v0.5.4：重启 agent（新模型生效）/ 模型列表全选全不选
assert(smSrc.includes("restartProcesses") && server.includes("/api/sessions/restart") && app.includes("重启 Agent 进程"), "重启 agent 链路（模型新配置生效）");
assert(app.includes('"全选"') && app.includes('"全不选"'), "模型列表全选/全不选");
// v0.4.3 修：模型选项值不得再用 NUL 分隔（innerHTML 解析会吞掉 NUL → id 为空 → 校验失败）
assert(app.includes("modelChoices[Number(modelSel.value)]"), "模型选项用数组下标（非 NUL 分隔）");
assert(!app.includes("escapeHtml(pname)}\\u0000"), "无 NUL 分隔的选项构建残留");

console.log("\nNOTE-LINK SOURCE GUARDS PASSED");
