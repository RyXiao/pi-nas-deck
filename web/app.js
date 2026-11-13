/* PiNasDeck 前端 */
"use strict";

// ===== 全局状态 =====
const state = {
  token: localStorage.getItem("pnd-token") || "",
  projects: [],
  activeProject: null,
  activeSession: null, // {sessionFile, id, name}
  ws: null,
  wsKey: null, // 当前订阅的进程 key
  rpcId: 1,
  rpcPending: new Map(),
  streaming: false,
  settingsTab: "models",
  // 文件树面板（屏幕右侧）：开关/选中项目持久化，目录展开状态持久化，条目会话内缓存
  fsOpen: false,
  fsPanelProject: null,
  fsSelectedDir: "", // 上传目标目录（点目录行选中；空 = 项目根）
  fsExpanded: JSON.parse(localStorage.getItem("pnd-fs-expanded") || "{}"),
  fsCache: new Map(),
  previewMd: localStorage.getItem("pnd-preview-md") !== "0",
  highlightQuery: null,
  tabs: [], // 文件标签页（Chrome 式）：{id, projectId, rel, data, md, history:{stack,index}}
  activeTab: "workspace", // "workspace" | tabId
  tabsRestored: false,
  mdIndexCache: new Map(), // projectId -> {files, at}（链接解析/插入选择器用，30s 缓存）
  noteEdit: null, // 编辑模式：{mtimeMs}（保存时冲突防护）
  fsSelected: null, // {project, rel, type} 单选主项（上传目标/快捷键作用对象）
  fsMulti: new Map(), // 多选：rel -> type（Ctrl/Shift 点选）
  fsAnchor: null, // shift 范围选择的锚点 rel
  fsRowOrder: [], // 最近一次渲染的可见行顺序（shift 范围选择用）
  fsClipboard: null, // {mode:"copy"|"cut", project, items:[{rel,type}]}
  fsSort: localStorage.getItem("pnd-fs-sort") === "time" ? "time" : "name", // 文件树排序
  turnStartedAt: 0, // 本轮开始时间（changed-since 扫产出文件）
  lastTurnFooter: null, // 最近一轮的分割行（产出块挂它后面）
  lastTurnStats: { files: [] },
  pendingPrompt: false, // 会话连接中发送的消息：连上后自动补发（防静默丢弃）
};

// 兼容旧值：pnd-fs-open 曾存「打开的项目 id」，现在只存 1/0
{
  const raw = localStorage.getItem("pnd-fs-open");
  state.fsOpen = raw === "1" || (!!raw && raw !== "0");
  state.fsPanelProject = (raw && raw !== "1" ? raw : null) || localStorage.getItem("pnd-fs-panel-project") || null;
}

const $ = (id) => document.getElementById(id);

// ===== API =====
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${state.token}`, ...(options.headers || {}) },
  });
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("未认证");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = isError ? "error" : "";
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 3500);
}

// ===== 登录 =====
function showLogin() {
  $("login-view").classList.remove("hidden");
  $("main-view").classList.add("hidden");
}

async function tryBoot() {
  if (!state.token) return showLogin();
  try {
    await api("/api/projects");
    boot();
  } catch {
    showLogin();
  }
}

$("login-btn").addEventListener("click", doLogin);
$("login-password").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
async function doLogin() {
  const password = $("login-password").value;
  try {
    const { token } = await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    state.token = token;
    localStorage.setItem("pnd-token", token);
    $("login-view").classList.add("hidden");
    boot();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
}

// ===== WebSocket =====
function connectWs() {
  if (state.ws && state.ws.readyState <= 1) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onopen = () => {
    // 断线重连后自动重挂当前会话
    if (state.activeSession && state.activeProject) attachSession(state.activeProject, state.activeSession, { silent: true });
  };
  ws.onclose = () => {
    state.wsKey = null;
    setTimeout(connectWs, 2000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "event" && msg.key === state.wsKey) handleEvent(msg.record);
    else if (msg.type === "attached") {
      state.wsKey = msg.key;
      void onAttached(msg.state).then(flushPendingPrompt).catch(() => {});
    } else if (msg.type === "term-output") {
      if (!$("term-view").classList.contains("hidden")) termAppend(msg.text || "", msg.kind);
      else state.term.pending = (state.term.pending || "") + (msg.text || "");
    } else if (msg.type === "extension_ui_request") {
      handleExtensionUiRequest(msg);
    } else if (msg.type === "error") {
      // 服务端错误（attach 失败等）之前被静默吞掉——多会话时“发指令无反馈”的帮凶
      toast(msg.error || "服务端错误", true);
    } else if (msg.type === "rpc-result") {
      const pending = state.rpcPending.get(msg.id);
      if (pending) {
        state.rpcPending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.data);
        else {
          // 进程被挂起/回收后 RPC 会报“会话未打开”——自动重挂一次，避免界面卡死
          if (String(msg.error || "").includes("进程已挂起") && !state.reattaching && state.activeSession && state.activeProject) {
            state.reattaching = true;
            toast("会话进程已挂起，正在自动重连…");
            attachSession(state.activeProject, state.activeSession, { silent: true }).finally(() => setTimeout(() => (state.reattaching = false), 3000));
          }
          pending.reject(new Error(msg.error));
        }
      }
    } else if (msg.type === "broadcast") {
      if (msg.channel === "wechat:status" && state.settingsTab === "wechat") renderSettings();
      if (msg.channel === "wechat:login" && msg.payload?.accountId) lastLoginPhases[msg.payload.accountId] = msg.payload.phase || "idle";
    }
  };
}

function rpc(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== 1) return reject(new Error("连接未就绪"));
    const id = `c${state.rpcId++}`;
    state.rpcPending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify({ type: "rpc", key: state.wsKey, id, command, timeoutMs }));
    setTimeout(() => {
      if (state.rpcPending.has(id)) {
        state.rpcPending.delete(id);
        reject(new Error("请求超时"));
      }
    }, timeoutMs || 60000);
  });
}

// ===== 项目会话树 =====
// 项目行（chevron 展开/收起） → 下挂该项目的会话列表，与 PiDeck 一致。
// 展开状态持久化到 localStorage；归档会话默认隐藏，侧边栏底部可切换显示。

state.expanded = new Set(JSON.parse(localStorage.getItem("pnd-expanded") || "[]"));
state.showArchived = localStorage.getItem("pnd-show-archived") === "1";

function persistExpanded() {
  localStorage.setItem("pnd-expanded", JSON.stringify([...state.expanded]));
}

async function loadProjects() {
  state.projects = await api("/api/projects");
  await renderTree();
  syncFsPanel();
}

async function renderTree() {
  $("fs-toggle-btn")?.classList.toggle("active", !!state.fsOpen);
  const box = $("project-list");
  box.innerHTML = "";
  for (const project of state.projects) {
    box.append(await projectRow(project));
  }
  if (!state.projects.length) {
    box.append(el("div", "hint", "还没有项目，点下方「＋ 添加项目」"));
  }
  // 归档切换
  if (state.projects.length) {
    const toggle = el("button", "", state.showArchived ? "🗄 隐藏归档" : "🗄 显示归档");
    toggle.style.marginTop = "10px";
    toggle.style.width = "100%";
    toggle.style.fontSize = "12px";
    toggle.onclick = () => {
      state.showArchived = !state.showArchived;
      localStorage.setItem("pnd-show-archived", state.showArchived ? "1" : "0");
      renderTree();
    };
    box.append(toggle);
  }
  const addBtn = el("button", "", "＋ 添加项目");
  addBtn.style.marginTop = "8px";
  addBtn.onclick = showAddProject;
  box.append(addBtn);
}

async function projectRow(project) {
  const expanded = state.expanded.has(project.id);
  const sessions = expanded ? await fetchSessions(project.id) : [];
  const wrapper = el("div", "");

  const row = el("div", "item proj-row");
  if (state.activeProject?.id === project.id) row.classList.add("active");
  const chevron = el("span", `chevron${expanded ? " open" : ""}`, "▶");
  chevron.title = expanded ? "收起" : "展开";
  const name = el("span", "proj-name", project.name + (project.exists ? "" : " ⚠️"));
  name.title = project.path;
  const count = el("span", "sub", `${sessions.length}`);
  const addSess = el("button", "add-sess", "＋");
  addSess.title = "在此项目下新建会话";
  const fsBtn = el("button", "add-sess", "📁");
  fsBtn.title = "文件树（在屏幕右侧打开）";
  const del = el("button", "del", "✕");
  del.title = "删除项目（不影响磁盘文件）";

  chevron.onclick = (e) => {
    e.stopPropagation();
    if (expanded) state.expanded.delete(project.id);
    else state.expanded.add(project.id);
    persistExpanded();
    renderTree();
  };
  addSess.onclick = async (e) => {
    e.stopPropagation();
    state.expanded.add(project.id);
    persistExpanded();
    await attachSession(project, null);
  };
  fsBtn.onclick = (e) => {
    e.stopPropagation();
    state.fsOpen = true;
    state.fsPanelProject = project.id;
    state.fsCache.clear();
    persistFsState();
    syncFsPanel();
  };
  del.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(`删除项目「${project.name}」？仅移除记录，不删磁盘文件。`)) return;
    await api("/api/projects", { method: "DELETE", body: JSON.stringify({ id: project.id }) });
    loadProjects();
  };
  name.onclick = () => selectProject(project, !expanded);

  row.append(chevron, name, count, addSess, fsBtn, del);
  wrapper.append(row);

  if (expanded) {
    const group = el("div", "sess-group");
    const visible = sessions.filter((s) => state.showArchived || !s.archived);
    if (!visible.length) {
      group.append(el("div", "hint", sessions.length ? "（会话已归档，点下方按钮显示）" : "暂无会话"));
    }
    for (const session of visible) group.append(await sessionRow(project, session));
    wrapper.append(group);
  }
  return wrapper;
}

async function sessionRow(project, session) {
  const item = el("div", "item");
  item.dataset.session = session.sessionFile;
  if (state.activeSession?.sessionFile === session.sessionFile) item.classList.add("active");
  if (session.archived) item.classList.add("archived");

  const left = el("div", "");
  left.style.minWidth = "0";
  left.style.flex = "1";
  const name = el("div", "name");
  if (session.streaming) {
    const dot = el("span", "sess-dot green");
    dot.title = "正在运行";
    name.append(dot);
  } else if (session.running) {
    const dot = el("span", "sess-dot blue");
    dot.title = "会话在线（已完成/待命，空闲超时自动回收）";
    name.append(dot);
  }
  name.append(document.createTextNode(session.name || session.preview || "（空会话）"));
  const meta = el("div", "sub", new Date(session.timestamp).toLocaleString());
  left.append(name, meta);

  const tags = el("span", "");
  tags.style.display = "flex";
  tags.style.gap = "4px";
  tags.style.flexShrink = "0";
  if (session.archived) tags.append(el("span", "tag", "已归档"));

  // 操作：关闭（运行中）/ 归档 / 删除
  const closeBtn = el("button", "act", "⏻");
  closeBtn.title = "关闭会话（停止进程，保留记录，再次点开自动重启）";
  closeBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      await api("/api/sessions/close", { method: "POST", body: JSON.stringify({ sessionFile: session.sessionFile }) });
      toast("会话已关闭");
      // 若关的是当前会话，解除附着
      if (state.wsKey === session.sessionFile) {
        state.wsKey = null;
        $("chat-view").classList.add("hidden");
        $("welcome-view").classList.remove("hidden");
        state.activeSession = null;
      }
      renderTree();
    } catch (error) {
      toast(error.message, true);
    }
  };
  const archiveBtn = el("button", "act", session.archived ? "📤" : "🗄");
  archiveBtn.title = session.archived ? "取消归档" : "归档（从列表隐藏，可随时恢复）";
  archiveBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      await api("/api/sessions/archive", { method: "POST", body: JSON.stringify({ sessionFile: session.sessionFile, archived: !session.archived }) });
      toast(session.archived ? "已恢复" : "已归档");
      renderTree();
    } catch (error) {
      toast(error.message, true);
    }
  };
  const del = el("button", "del", "✕");
  del.title = "删除会话（不可恢复）";
  del.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm("删除该会话？不可恢复。")) return;
    try {
      await api("/api/sessions", { method: "DELETE", body: JSON.stringify({ sessionFile: session.sessionFile }) });
      if (state.activeSession?.sessionFile === session.sessionFile) {
        state.activeSession = null;
        state.wsKey = null;
        $("chat-view").classList.add("hidden");
        $("welcome-view").classList.remove("hidden");
      }
      renderTree();
    } catch (error) {
      toast(error.message, true);
    }
  };

  if (session.running) tags.append(closeBtn);
  tags.append(archiveBtn, del);
  item.append(left, tags);
  item.onclick = () => attachSession(project, session);
  return item;
}

async function fetchSessions(projectId) {
  try {
    return await api(`/api/sessions?project=${encodeURIComponent(projectId)}&archived=1`);
  } catch {
    return [];
  }
}

async function selectProject(project, expand = false) {
  state.activeProject = project;
  state.activeSession = null;
  state.fsPanelProject = project.id; // 右侧文件树跟随选中项目
  closeMobileSidebar();
  if (expand) {
    state.expanded.add(project.id);
    persistExpanded();
  }
  showWorkspaceView();
  await renderTree();
  syncFsPanel();
}

/** 兼容旧调用点：刷新会话列表 = 重渲染整棵树。 */
async function loadSessions() {
  await renderTree();
}

// ===== 添加项目（目录选择器） =====
async function showAddProject() {
  $("chat-view").classList.add("hidden");
  $("settings-view").classList.add("hidden");
  $("welcome-view").classList.remove("hidden");
  const view = $("welcome-view");
  view.innerHTML = "";
  const box = el("div", "panel");
  box.style.width = "min(560px, 90%)";
  box.innerHTML = `<div class="card"><h3>添加项目</h3>
    <div class="row"><label>名称</label><input id="np-name" placeholder="留空取目录名"></div>
    <div class="row"><label>目录</label><input id="np-path" placeholder="/workspace/..."></div>
    <div id="np-browser"></div>
    <p class="hint">目录必须位于挂载的 workspace 之内（Docker 卷）。</p>
    <div class="row"><button id="np-save" class="primary">保存</button><button id="np-cancel">取消</button></div></div>`;
  view.append(box);
  let currentPath = "";
  const browser = box.querySelector("#np-browser");
  const pathInput = box.querySelector("#np-path");
  async function browse(path) {
    try {
      const data = await api(`/api/dirs?path=${encodeURIComponent(path || "")}`);
      currentPath = data.path;
      pathInput.value = data.path;
      browser.innerHTML = "";
      const list = el("div", "");
      list.style.maxHeight = "200px";
      list.style.overflowY = "auto";
      if (data.parent) {
        const up = el("div", "item", "⬆️ ..");
        up.onclick = () => browse(relativeToRoot(data.parent));
        list.append(up);
      }
      for (const dir of data.dirs) {
        const item = el("div", "item", `📁 ${dir}`);
        item.onclick = () => browse((path ? path + "/" : "") + dir);
        list.append(item);
      }
      browser.append(list);
      // 当前目录下新建文件夹（NAS 文件管理器看不见容器文件时，建目录也靠这里）
      const newDirBtn = el("button", "", "＋ 新建文件夹");
      newDirBtn.style.marginTop = "6px";
      newDirBtn.onclick = async () => {
        const name = prompt("新文件夹名称：");
        if (!name?.trim()) return;
        try {
          await api("/api/dirs", { method: "POST", body: JSON.stringify({ path: path || "", name: name.trim() }) });
          toast("文件夹已创建");
          await browse(path || "");
        } catch (error) {
          toast(error.message, true);
        }
      };
      browser.append(newDirBtn);
    } catch (error) {
      browser.innerHTML = `<p class="error">${error.message}</p>`;
    }
  }
  function relativeToRoot(abs) {
    // 后端 /api/dirs 接受相对 workspace 根的路径；把绝对路径转回去
    return abs.replace(/^.*\/workspace\/?/, "");
  }
  await browse("");
  box.querySelector("#np-cancel").onclick = () => {
    view.innerHTML = "";
    view.append(welcomePlaceholder());
  };
  box.querySelector("#np-save").onclick = async () => {
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: box.querySelector("#np-name").value, path: pathInput.value }),
      });
      view.innerHTML = "";
      view.append(welcomePlaceholder());
      await loadProjects();
      toast("项目已添加");
    } catch (error) {
      toast(error.message, true);
    }
  };
}

function welcomePlaceholder() {
  const div = el("div", "");
  div.innerHTML = `<h2>欢迎使用 PiNasDeck</h2><p class="muted">左侧选择项目和会话，或点「＋ 新会话」开始。<br>先到 ⚙️ 设置里配置模型 API 和微信。</p>`;
  return div;
}

// ===== 会话附着与聊天 =====
async function newChat() {
  if (!state.activeProject) {
    // 没选项目时默认用第一个
    if (!state.projects.length) return toast("请先添加项目", true);
    state.activeProject = state.projects[0];
    await loadProjects();
    await loadSessions();
  }
  await attachSession(state.activeProject, null);
}

async function attachSession(project, session, opts = {}) {
  state.activeProject = project;
  state.activeSession = session;
  state.fsPanelProject = project.id; // 文件树跟随切换的会话/项目（防上传到错项目）
  closeMobileSidebar(); // 手机上选完会话自动收起抽屉
  connectWs();
  if (state.wsKey) {
    state.ws.send(JSON.stringify({ type: "detach", key: state.wsKey }));
    state.wsKey = null;
  }
  showWorkspaceView();
  $("chat-title").textContent = session?.name || session?.preview || "新会话";
  $("mobile-title").textContent = session?.name || session?.preview || "新会话";
  $("messages").innerHTML = "";
  $("abort-btn").classList.add("hidden");
  if (!opts.silent) loadSessions();
  if (state.fsOpen) syncFsPanel(); // 右树跟随切到新项目
  state.ws.send(JSON.stringify({ type: "attach", projectId: project.id, sessionFile: session?.sessionFile || null }));
}

async function onAttached(rpcState) {
  if (rpcState?.sessionFile) state.activeSession = { ...(state.activeSession || {}), sessionFile: rpcState.sessionFile };
  state.currentModelId = rpcState?.model?.id || null;
  state.currentModelProvider = rpcState?.model?.provider || null;
  try {
    const messages = await rpc({ type: "get_messages" });
    renderHistory(messages?.messages || []);
  } catch (error) {
    toast(`加载历史失败: ${error.message}`, true);
  }
  // 模型下拉与命令菜单都是增强能力，失败不阻断聊天
  loadModelSelect().catch(() => {});
  loadCommands().catch(() => {});
  // 自检：会话就绪后 3 秒确认下拉状态（诊断“下拉不显示”类问题）
  setTimeout(() => {
    const sel = $("model-select");
    if (sel.classList.contains("hidden")) {
      console.warn("[model-select] 仍未显示：models<2 或加载失败", { currentModel: state.currentModelId, wsKey: !!state.wsKey });
    }
  }, 3000);
}

// ===== 模型切换 =====
// 有 ≥2 个可用模型时显示下拉，切换走 set_model（会话级，不影响其他会话）。
async function loadModelSelect() {
  const select = $("model-select");
  try {
    const data = await rpc({ type: "get_available_models" });
    // 过滤脏数据（缺 provider/id）：否则 option.value 会变成 "undefined\\0undefined"
    const models = (data?.models || []).filter((m) => m && m.id && m.provider);
    if (!models.length) {
      // 不再静默隐藏：保留下拉并显示可读状态
      select.innerHTML = '<option value="">（无可用模型，检查设置→模型）</option>';
      select.classList.remove("hidden");
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML = "";
    for (const model of models) {
      const option = document.createElement("option");
      option.value = `${model.provider}\u0000${model.id}`;
      // 选项文案带服务商名（同名模型跨服务商可区分）；完整信息仍在 title
      option.textContent = `${model.name || model.id} · ${model.provider}`;
      option.title = `${model.provider}/${model.id}`;
      // 选中态必须同时比 provider + id（同名模型跨服务商时不能只比 id）
      if (model.id === state.currentModelId && (!state.currentModelProvider || model.provider === state.currentModelProvider)) option.selected = true;
      select.append(option);
    }
    // 单模型时也显示（不再因为 <2 而隐藏，避免“下拉不见了”找不到原因）
    select.classList.remove("hidden");
  } catch (error) {
    // 之前这里被 .catch(() => {}) 完全吞掉，下拉不出现也无任何线索
    select.innerHTML = '<option value="">（模型加载失败，可重开会话）</option>';
    select.classList.remove("hidden");
    select.disabled = true;
    console.warn("[model-select] 加载失败:", error);
    toast(`模型列表加载失败：${error.message}（可点设置→模型 重启 Agent 后重试）`, true);
  }
}

$("model-select").addEventListener("change", async (e) => {
  const [provider, modelId] = e.target.value.split("\u0000");
  try {
    const model = await rpc({ type: "set_model", provider, modelId });
    state.currentModelId = model?.id || modelId;
    state.currentModelProvider = model?.provider || provider;
    toast(`已切换到 ${model?.name || modelId}`);
  } catch (error) {
    toast(`切换失败: ${error.message}`, true);
    loadModelSelect().catch(() => {}); // 还原下拉选择
  }
});

// ===== 命令 / skills 菜单 =====
// attach 后 get_commands 枚举 extension 命令 + prompt 模板 + skills；
// 输入框以 / 开头且未含空格时弹出过滤菜单，↑↓ 选择、Enter 插入、Esc 关闭。
async function loadCommands() {
  try {
    const data = await rpc({ type: "get_commands" });
    state.commands = data?.commands || [];
  } catch {
    state.commands = [];
  }
}

state.cmdFiltered = [];
state.cmdIndex = 0;

function updateCmdMenu() {
  const menu = $("cmd-menu");
  const text = $("input").value;
  const match = text.match(/^\/([^\s]*)$/);
  if (!match || !state.commands?.length) {
    menu.classList.add("hidden");
    return;
  }
  const query = match[1].toLowerCase();
  state.cmdFiltered = state.commands
    .filter((c) => c.name.toLowerCase().includes(query) || (c.description || "").toLowerCase().includes(query))
    .slice(0, 30);
  state.cmdIndex = 0;
  if (!state.cmdFiltered.length) {
    menu.innerHTML = '<div class="cmd-empty">没有匹配的命令</div>';
    menu.classList.remove("hidden");
    return;
  }
  menu.innerHTML = "";
  state.cmdFiltered.forEach((cmd, index) => {
    const item = el("div", `cmd-item${index === 0 ? " selected" : ""}`);
    const srcLabel = cmd.source === "skill" ? "skill" : cmd.source === "prompt" ? "模板" : "cmd";
    item.innerHTML = `<span class="cmd-name">/${escapeHtml(cmd.name)}</span><span class="cmd-desc">${escapeHtml(cmd.description || "")}</span><span class="cmd-src ${cmd.source}">${srcLabel}</span>`;
    item.onmousedown = (e) => {
      e.preventDefault(); // 防止输入框失焦导致菜单关闭
      pickCommand(index);
    };
    menu.append(item);
  });
  menu.classList.remove("hidden");
}

function moveCmdSelection(delta) {
  if ($("cmd-menu").classList.contains("hidden") || !state.cmdFiltered.length) return false;
  state.cmdIndex = (state.cmdIndex + delta + state.cmdFiltered.length) % state.cmdFiltered.length;
  const items = $("cmd-menu").querySelectorAll(".cmd-item");
  items.forEach((item, index) => item.classList.toggle("selected", index === state.cmdIndex));
  items[state.cmdIndex]?.scrollIntoView({ block: "nearest" });
  return true;
}

function pickCommand(index) {
  const cmd = state.cmdFiltered[index];
  if (!cmd) return;
  $("input").value = `/${cmd.name} `;
  $("cmd-menu").classList.add("hidden");
  autoResize($("input"));
  $("input").focus();
}

function cmdMenuVisible() {
  return !$("cmd-menu").classList.contains("hidden");
}

// ===== 事件流渲染 =====
let currentAssistant = null; // {contentEl, blocks: Map<index, {type, text}>}
let turnStats = null; // 本轮统计：{startedAt, toolIds:Set, files:[], tokens}（结束时进分割行）

function handleEvent(record) {
  switch (record.type) {
    case "agent_start":
      state.streaming = true;
      state.turnStartedAt = Date.now();
      $("abort-btn").classList.remove("hidden");
      $("send-btn").disabled = true;
      break;
    case "agent_settled":
      state.streaming = false;
      $("abort-btn").classList.add("hidden");
      $("send-btn").disabled = false;
      finalizeAssistant();
      finalizeWaitingAskCards(); // 未作答的选择卡（pi 侧已超时/取消）收尾
      void fetchTurnOutputs(); // 本轮产出文件列表（异步，挂在分割行下）
      updateStats();
      break;
    case "message_start":
      if (record.message?.role === "assistant") startAssistantMsg();
      break;
    case "message_update":
      applyAssistantDelta(record);
      break;
    case "message_end":
      if (record.message?.role === "assistant") finalizeAssistant();
      else if (record.message?.role === "error") {
        // provider/模型报错（如新加的模型配置不完整）：实时渲染，不再静默吞掉（v0.5.1 修）
        finalizeAssistant();
        renderLiveError(record.message);
      }
      break;
    case "tool_execution_start":
      renderToolEvent(record, "running");
      break;
    case "tool_execution_update":
      renderToolEvent(record, "running");
      break;
    case "tool_execution_end":
      renderToolEvent(record, record.isError ? "fail" : "done");
      break;
    case "session_info_changed":
      if (record.name) {
        $("chat-title").textContent = record.name;
        loadSessions();
      }
      break;
  }
}

/** subagent 工具卡片：展示子代理名/任务/状态与实时输出（多会话编排可视化）。
 *  pi-subagents 把进度放在 tool_execution_update.partialResult。 */
function renderSubagentCard(record, status) {
  if (!currentAssistant) startAssistantMsg();
  const id = record.toolCallId;
  let card = $("messages").querySelector(`[data-sa="${CSS.escape(id)}"]`);
  const args = record.args || {};
  if (!card) {
    card = el("div", "subagent-card");
    card.dataset.sa = id;
    const head = el("div", "sa-head");
    const agent = args.agent || args.agents || "subagent";
    head.append(el("span", "sa-icon", "🧩"), el("span", "sa-agent", `子代理 · ${typeof agent === "string" ? agent : "多个"}`));
    const badge = el("span", "sa-status");
    head.append(badge);
    card.append(head);
    const task = args.task || args[0]?.task;
    if (task) card.append(el("div", "sa-task", String(task).slice(0, 200)));
    card.append(el("div", "sa-log"));
    currentAssistant.content.append(card);
  }
  const badge = card.querySelector(".sa-status");
  const log = card.querySelector(".sa-log");
  badge.className = `sa-status ${status}`;
  badge.textContent = status === "running" ? "● 运行中" : status === "fail" ? "✗ 失败" : "✓ 完成";
  const partial = record.partialResult?.content || record.result?.content;
  if (partial) {
    const text = extractToolText(partial);
    if (text) {
      log.textContent = truncate(text, 4000);
      log.classList.remove("hidden");
    }
  }
  scrollBottom();
}

function renderLiveError(message) {
  const text = extractText(message.content) || "（无错误详情）";
  const msg = el("div", "msg error");
  msg.append(el("div", "content", text));
  $("messages").append(msg);
  scrollBottom();
}

function startAssistantMsg() {
  finalizeAssistant();
  const msg = el("div", "msg assistant");
  const role = el("div", "role", "🤖 Assistant");
  const content = el("div", "content");
  msg.append(role, content);
  $("messages").append(msg);
  currentAssistant = { msg, content, blocks: new Map() };
  turnStats = { startedAt: Date.now(), toolIds: new Set(), files: [], tokens: 0 };
  scrollBottom();
}

function applyAssistantDelta(record) {
  if (!currentAssistant) startAssistantMsg();
  const evt = record.assistantMessageEvent;
  if (!evt) return;
  const idx = evt.contentIndex ?? 0;
  let block = currentAssistant.blocks.get(idx);
  if (!block) {
    block = { type: "text", text: "" };
    currentAssistant.blocks.set(idx, block);
  }
  switch (evt.type) {
    case "thinking_start":
      block.type = "thinking";
      break;
    case "text_start":
      block.type = "text";
      break;
    case "toolcall_start":
      block.type = "toolcall";
      block.toolName = evt.toolName;
      block.text = "";
      break;
    case "thinking_delta":
    case "text_delta":
    case "toolcall_delta":
      block.text += evt.delta;
      break;
    case "thinking_end":
    case "text_end":
      block.text = evt.content ?? block.text;
      break;
    case "toolcall_end":
      block.text = JSON.stringify(evt.toolCall?.arguments || evt.toolCall || {}, null, 1);
      break;
  }
  if (record.usage?.totalTokens) {
    $("context-badge").textContent = `${Math.round((record.usage.totalTokens || 0) / 1000)}k tok`;
    if (turnStats) turnStats.tokens = record.usage.totalTokens;
  }
  renderAssistantBlocks();
}

function renderAssistantBlocks() {
  const ca = currentAssistant;
  if (!ca) return;
  ca.content.innerHTML = "";
  const sorted = [...ca.blocks.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, block] of sorted) {
    if (block.type === "thinking") {
      const div = el("div", "thinking-block", block.text || "…");
      ca.content.append(div);
    } else if (block.type === "toolcall") {
      const div = el("div", "tool-chip running", `🔧 ${block.toolName || "tool"}`);
      ca.content.append(div);
      if (block.text) {
        const details = el("div", "tool-details", block.text);
        ca.content.append(details);
      }
    } else if (block.text) {
      const div = el("div", "");
      div.innerHTML = renderMarkdown(block.text) + '<span class="cursor-blink">&nbsp;</span>';
      ca.content.append(div);
    }
  }
  scrollBottom();
}

function finalizeAssistant() {
  const ca = currentAssistant;
  if (!ca) return;
  // 去掉流式闪烁光标，并在本轮末尾追加分割元信息行（耗时/工具/tokens/改动文件/模型）
  ca.content.querySelectorAll(".cursor-blink").forEach((cursor) => cursor.remove());
  appendTurnFooter(ca.msg);
  currentAssistant = null;
  turnStats = null;
}

/** 每轮结束后的分割行：PiDeck 风格尾部元信息（耗时+模型+改动文件），兼作轮次分隔线。 */
function appendTurnFooter(msg) {
  if (!msg || !msg.isConnected) return;
  const stats = turnStats;
  const footer = el("div", "turn-footer");
  footer.append(el("span", "", `🕐 ${fmtDuration(Math.max(0, Date.now() - (stats?.startedAt || Date.now())))}`));
  const toolCount = stats?.toolIds.size || 0;
  if (toolCount) footer.append(el("span", "", `🔧 ${toolCount} 个工具`));
  const tokens = stats?.tokens || 0;
  if (tokens) footer.append(el("span", "", `${fmtTokens(tokens)} tok`));
  if (state.currentModelId) {
    const chip = el("span", "model-chip", state.currentModelId);
    chip.title = state.currentModelId;
    footer.append(chip);
  }
  msg.after(footer);
  state.lastTurnFooter = footer;
  state.lastTurnStats = { files: [...(stats?.files || [])] };
  scrollBottom();
}

/** 连接建立后自动补发连接期间发送的消息。 */
function flushPendingPrompt() {
  if (!state.pendingPrompt) return;
  if (state.wsKey && $("input").value.trim()) {
    state.pendingPrompt = false;
    void sendPrompt();
  } else if (!$("input").value.trim()) {
    state.pendingPrompt = false;
  }
}

/** 本轮产出文件：turnStart 后项目内新增/修改的文件，挂分割行下、可点开；
 *  扫不到（如文件在项目外）时回退到工具参数里的改动记录。 */
async function fetchTurnOutputs() {
  const footer = state.lastTurnFooter;
  const project = state.activeProject;
  if (!footer || !footer.isConnected || !project || !state.turnStartedAt) return;
  if (footer.nextElementSibling?.classList?.contains("turn-outputs")) return; // 防重复挂载
  try {
    const data = await api(`/api/fs/changed-since?project=${encodeURIComponent(project.id)}&since=${Math.max(1, state.turnStartedAt - 2000)}`);
    if (!footer.isConnected) return;
    const block = el("div", "turn-outputs");
    const files = data.files || [];
    if (files.length) {
      block.append(el("div", "list-label", `📄 本轮产出（${files.length}${data.truncated ? "+" : ""}）`));
      for (const f of files.slice(0, 40)) {
        const item = el("div", "output-file");
        item.append(el("span", "of-name", f.path.split("/").pop()), el("span", "sub", fmtSize(f.size)));
        item.title = `${f.path} — 点击查看`;
        item.onclick = () => void openFilePreview(project, f.path);
        block.append(item);
      }
    } else if (state.lastTurnStats?.files?.length) {
      block.append(el("div", "list-label", "📝 改动（工具记录）"));
      const wrap = el("div", "turn-outputs-chips");
      for (const name of state.lastTurnStats.files.slice(0, 20)) wrap.append(el("span", "file-chip", name));
      block.append(wrap);
    } else {
      return;
    }
    footer.after(block);
  } catch {
    /* 扫描失败不打扰阅读 */
  }
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

// ---- 扩展 UI 子协议（pi 1.5 extension_ui_request/response） ----
// 选择/确认/输入对话框由 ask-choice 等扩展经 ctx.ui.select/confirm/input 发起，
// 网页渲染卡片，点击后经 WS ui-response 通道回 extension_ui_response（不走文件握手）。
function sendUiResponse(payload) {
  if (!state.wsKey || state.ws?.readyState !== 1) return;
  state.ws.send(JSON.stringify({ type: "ui-response", key: state.wsKey, payload }));
}

function handleExtensionUiRequest(msg) {
  if (msg.method === "notify") {
    toast(String(msg.message || ""), msg.notifyType === "error" || msg.notifyType === "warning");
    return;
  }
  if (msg.method === "select" && Array.isArray(msg.options)) {
    renderAskCard({ id: msg.id, question: msg.title || "请选择", options: msg.options });
    return;
  }
  if (msg.method === "confirm") {
    renderConfirmCard(msg);
    return;
  }
  if (msg.method === "input") {
    renderInputCard(msg);
    return;
  }
  // editor/custom 等暂不支持：取消，绝不卡住模型
  sendUiResponse({ id: msg.id, cancelled: true });
}

/** 选择题卡片（select）：选项按钮点击回 value。 */
function renderAskCard(msg) {
  const id = msg.id;
  if ($("messages").querySelector(`[data-ask="${CSS.escape(id)}"]`)) return;
  const card = el("div", "msg ask-card");
  card.dataset.ask = id;
  card.append(el("div", "role", "❓ 等待你的选择"));
  card.append(el("div", "content", msg.question || "（缺少问题）"));
  const row = el("div", "ask-options");
  const finish = (answer) => {
    row.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
    card.classList.add("answered");
    card.querySelector(".role").textContent = `✅ 已选择：${answer}`;
    sendUiResponse({ id, value: String(answer) });
  };
  for (const opt of msg.options) {
    const btn = el("button", "ask-option", String(opt));
    btn.onclick = () => finish(opt);
    row.append(btn);
  }
  card.append(row);
  $("messages").append(card);
  scrollBottom();
}

/** 确认卡片（confirm）：是/否。 */
function renderConfirmCard(msg) {
  const id = msg.id;
  if ($("messages").querySelector(`[data-ask="${CSS.escape(id)}"]`)) return;
  const card = el("div", "msg ask-card");
  card.dataset.ask = id;
  card.append(el("div", "role", "❓ 等待确认"));
  const lines = [msg.title || "确认？"];
  if (msg.message) lines.push(msg.message);
  card.append(el("div", "content", lines.join("\n")));
  const row = el("div", "ask-options");
  const finish = (confirmed) => {
    row.querySelectorAll("button").forEach((b) => (b.disabled = true));
    card.classList.add("answered");
    card.querySelector(".role").textContent = confirmed ? "✅ 已确认" : "❎ 已取消";
    sendUiResponse({ id, confirmed });
  };
  const yes = el("button", "ask-option", "确认");
  yes.onclick = () => finish(true);
  const no = el("button", "ask-option", "取消");
  no.onclick = () => finish(false);
  row.append(yes, no);
  card.append(row);
  $("messages").append(card);
  scrollBottom();
}

/** 输入卡片（input）：单行文本。 */
function renderInputCard(msg) {
  const id = msg.id;
  if ($("messages").querySelector(`[data-ask="${CSS.escape(id)}"]`)) return;
  const card = el("div", "msg ask-card");
  card.dataset.ask = id;
  card.append(el("div", "role", "✍️ 等待输入"));
  card.append(el("div", "content", msg.title || "请输入"));
  const row = el("div", "ask-options");
  const input = el("input", "ask-other");
  input.placeholder = msg.placeholder || "";
  const ok = el("button", "ask-option", "提交");
  const cancel = el("button", "ask-option", "取消");
  const finish = (payload, label) => {
    row.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
    card.classList.add("answered");
    card.querySelector(".role").textContent = label;
    sendUiResponse({ id, ...payload });
  };
  ok.onclick = () => {
    if (input.value.trim()) finish({ value: input.value.trim() }, `✅ 已提交：${input.value.trim()}`);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") ok.onclick();
    e.stopPropagation();
  };
  cancel.onclick = () => finish({ cancelled: true }, "❎ 已取消");
  row.append(input, ok, cancel);
  card.append(row);
  $("messages").append(card);
  input.focus();
  scrollBottom();
}

/** 轮次结束时把未作答的对话卡收尾（pi 侧 timeout 已自动解决，视觉上不能永远“等待”）。 */
function finalizeWaitingAskCards() {
  for (const card of $("messages").querySelectorAll(".ask-card:not(.answered)")) {
    card.classList.add("answered");
    card.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
    const role = card.querySelector(".role");
    if (role) role.textContent = "⏳ 未作答（超时/已跳过），模型已按默认继续";
  }
}

function renderToolEvent(record, status) {
  // subagent 工具：单独渲染子代理卡片（多会话编排可视化）
  if (record.toolName === "subagent" || String(record.toolName || "").startsWith("subagents_")) {
    renderSubagentCard(record, status);
    return;
  }
  // 工具事件独立成行显示（不在 assistant 块内，避免流式重排抖动）
  if (!currentAssistant) startAssistantMsg();
  const key = record.toolCallId;
  let chip = currentAssistant.content.querySelector(`[data-tool="${key}"]`);
  if (!chip) {
    chip = el("div", `tool-chip ${status}`, "");
    chip.dataset.tool = key;
    chip.style.display = "inline-flex";
    currentAssistant.content.append(chip);
    // 首次出现计入本轮工具数；写/改类工具的文件路径记入本轮改动清单
    if (turnStats) {
      turnStats.toolIds.add(key);
      const filePath = record.args?.file_path || record.args?.path || "";
      if (filePath && /write|edit|multiedit|notebook/i.test(record.toolName || "")) {
        const base = String(filePath).split(/[\\/]/).pop();
        if (base && !turnStats.files.includes(base)) turnStats.files.push(base);
      }
    }
  }
  chip.className = `tool-chip ${status}`;
  chip.textContent = `${status === "running" ? "🔧" : status === "fail" ? "❌" : "✅"} ${record.toolName}${record.toolName === "bash" && record.args?.command ? `: ${truncate(record.args.command, 40)}` : ""}`;
  if (record.partialResult?.content) {
    const text = extractToolText(record.partialResult.content);
    let details = currentAssistant.content.querySelector(`[data-tool-details="${key}"]`);
    if (!details) {
      details = el("div", "tool-details", "");
      details.dataset.toolDetails = key;
      chip.after(details);
    }
    details.textContent = truncate(text, 2000);
  }
  if (status !== "running" && record.result?.content) {
    const details = currentAssistant.content.querySelector(`[data-tool-details="${key}"]`);
    const text = extractToolText(record.result.content);
    if (details && text) details.textContent = truncate(text, 2000);
    else details?.remove();
  }
  scrollBottom();
}

function extractToolText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block === "string" ? block : block?.text || ""))
    .join("\n")
    .trim();
}

function renderHistory(messages) {
  $("messages").innerHTML = "";
  currentAssistant = null;
  for (const message of messages) {
    if (message.role === "user") {
      const msg = el("div", "msg user");
      msg.append(el("div", "role", "👤 You"), el("div", "content", extractText(message.content)));
      $("messages").append(msg);
    } else if (message.role === "assistant") {
      const text = extractText(message.content);
      const thinking = extractThinking(message.content);
      if (!text && !thinking) continue;
      const msg = el("div", "msg assistant");
      msg.append(el("div", "role", "🤖 Assistant"));
      const content = el("div", "content");
      if (thinking) content.append(el("div", "thinking-block", thinking));
      const div = el("div", "");
      div.innerHTML = renderMarkdown(text);
      content.append(div);
      msg.append(content);
      $("messages").append(msg);
    } else if (message.role === "error") {
      const msg = el("div", "msg error");
      msg.append(el("div", "content", extractText(message.content) || "出错了"));
      $("messages").append(msg);
    }
  }
  scrollBottom();
  // 搜索跳转：找到第一条包含关键词的消息，滚动居中并闪烁提示（内容匹配，不依赖消息序号）
  if (state.highlightQuery) {
    const q = state.highlightQuery;
    state.highlightQuery = null;
    for (const msg of $("messages").querySelectorAll(".msg")) {
      if (msg.textContent.toLowerCase().includes(q.toLowerCase())) {
        msg.scrollIntoView({ block: "center" });
        msg.classList.add("flash");
        setTimeout(() => msg.classList.remove("flash"), 2500);
        break;
      }
    }
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : block?.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content?.text || "";
}

function extractThinking(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "thinking")
    .map((block) => block.thinking || block.text || "")
    .join("\n");
}

function renderMarkdown(text) {
  if (!text) return "";
  try {
    return DOMPurify.sanitize(marked.parse(text));
  } catch {
    return escapeHtml(text);
  }
}

// ===== 发送 =====
// ===== 附件 =====
// 图片：直接走 pi prompt 的 images 字段（base64 内联，不落盘）；
// 其他文件：POST /api/upload 存到服务端，把绝对路径附在消息文本里，agent 用 read 工具读取。
state.attachments = []; // {kind:'image'|'file', name, mime, data(base64, 无前缀), size, previewUrl?}

$("attach-btn").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  addAttachments([...e.target.files]);
  e.target.value = "";
});

// 拖拽到输入区
const composer = $("composer");
["dragover", "dragenter"].forEach((ev) =>
  composer.addEventListener(ev, (e) => {
    e.preventDefault();
    composer.classList.add("drag-over");
  }),
);
["dragleave", "drop"].forEach((ev) => composer.addEventListener(ev, () => composer.classList.remove("drag-over")));
composer.addEventListener("drop", (e) => {
  e.preventDefault();
  addAttachments([...(e.dataTransfer?.files || [])]);
});

async function addAttachments(files) {
  for (const file of files) {
    if (state.attachments.length >= 8) {
      toast("最多 8 个附件", true);
      break;
    }
    if (file.size > 50 * 1024 * 1024) {
      toast(`${file.name} 超过 50MB，跳过`, true);
      continue;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      const [, base64] = dataUrl.split(",");
      const isImage = file.type.startsWith("image/");
      state.attachments.push({
        kind: isImage ? "image" : "file",
        name: file.name,
        mime: file.type || "application/octet-stream",
        data: base64,
        size: file.size,
        previewUrl: isImage ? dataUrl : null,
      });
    } catch (error) {
      toast(`读取 ${file.name} 失败: ${error.message}`, true);
    }
  }
  renderAttachments();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderAttachments() {
  const box = $("attachments");
  box.innerHTML = "";
  box.classList.toggle("hidden", state.attachments.length === 0);
  state.attachments.forEach((att, index) => {
    const chip = el("div", "att-chip");
    if (att.previewUrl) {
      const img = el("img");
      img.src = att.previewUrl;
      chip.append(img);
    }
    chip.append(el("span", "", `${att.kind === "image" ? "🖼" : "📄"} ${att.name} (${fmtSize(att.size)})`));
    const remove = el("button", "att-remove", "✕");
    remove.onclick = () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    };
    chip.append(remove);
    box.append(chip);
  });
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 发送前处理附件：文件先上传拿路径；返回 {images, fileNotes} 并从待发列表移除。 */
async function prepareAttachments() {
  const images = [];
  const fileNotes = [];
  const remaining = [];
  for (const att of state.attachments) {
    if (att.kind === "image") {
      images.push({ type: "image", data: att.data, mimeType: att.mime });
    } else {
      try {
        const uploaded = await api("/api/upload", { method: "POST", body: JSON.stringify({ name: att.name, data: att.data }) });
        fileNotes.push(`[用户上传了文件：${uploaded.path}（${att.name}，${fmtSize(uploaded.size)}）]`);
      } catch (error) {
        toast(`上传 ${att.name} 失败: ${error.message}`, true);
        remaining.push(att); // 失败的留在待发区
      }
    }
  }
  state.attachments = remaining;
  renderAttachments();
  return { images, fileNotes };
}

async function sendPrompt() {
  const input = $("input");
  let text = input.value.trim();
  if (!text && !state.attachments.length) return;
  if (!state.wsKey) {
    // 会话连接中（新会话冷启动/切换会话时）：保留输入并提示，连上后自动补发——
    // 之前这里静默 return，多会话时发指令「毫无反馈」（v0.5.0 修）
    state.pendingPrompt = true;
    toast("会话连接中，连上后会自动发送");
    return;
  }
  state.pendingPrompt = false;
  input.value = "";
  autoResize(input);

  const { images, fileNotes } = await prepareAttachments();
  if (fileNotes.length) text = `${text}${text ? "\n\n" : ""}${fileNotes.join("\n")}`;
  if (!text && images.length) text = "请看这张图片。";
  if (!text) return;

  const msg = el("div", "msg user");
  msg.append(el("div", "role", "👤 You"), el("div", "content", text));
  // 气泡里展示图片预览 + 文件名
  if (images.length || fileNotes.length) {
    const strip = el("div", "att-strip");
    for (const img of images) {
      const preview = el("img");
      preview.src = `data:${img.mimeType};base64,${img.data}`;
      strip.append(preview);
    }
    for (const note of fileNotes) {
      const label = note.match(/（([^，]+)，/)?.[1] || "文件";
      strip.append(el("span", "file-pill", `📄 ${label}`));
    }
    msg.querySelector(".content").after(strip);
  }
  $("messages").append(msg);
  scrollBottom();
  try {
    // 斜杠命令（扩展/模板/skill）必须用 prompt：follow_up/steer 不接受扩展命令；
    // 其余在流式中用 follow_up 排队，空闲时直接 prompt。
    const isSlash = text.startsWith("/");
    const base = isSlash || !state.streaming ? { type: "prompt", message: text } : { type: "follow_up", message: text };
    if (images.length) base.images = images;
    await rpc(base, 30000);
  } catch (error) {
    toast(error.message, true);
  }
}

$("send-btn").addEventListener("click", sendPrompt);
$("input").addEventListener("keydown", (e) => {
  if (cmdMenuVisible()) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveCmdSelection(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveCmdSelection(-1);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      pickCommand(state.cmdIndex);
      return;
    }
    if (e.key === "Escape") {
      $("cmd-menu").classList.add("hidden");
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
$("input").addEventListener("input", (e) => {
  autoResize(e.target);
  updateCmdMenu();
});
// 点击输入区外部关闭菜单
document.addEventListener("click", (e) => {
  if (!e.target.closest("#composer")) {
    $("cmd-menu").classList.add("hidden");
    closeQuickMenu();
  }
});
function autoResize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

$("abort-btn").addEventListener("click", async () => {
  try {
    await rpc({ type: "abort" }, 15000);
  } catch (error) {
    toast(error.message, true);
  }
});

$("new-chat-btn").addEventListener("click", newChat);
$("welcome-new-btn").addEventListener("click", () => void newChat());

// ===== 快捷菜单：⚡ Skills / 🔌 MCP =====
// ⚡ 列出 skills（读 /api/skills，不依赖会话），点击把 /name 填入输入框；
// 🔌 列出 MCP 服务器，点击插入「请使用 xxx MCP 提供的工具：」提示（pi 无工具点名协议，
// 用文本提示模型优先用该 server 的工具）。
const quickMenu = { source: null };

function closeQuickMenu() {
  $("quick-menu").classList.add("hidden");
  quickMenu.source = null;
}

function insertAtCursor(text) {
  const input = $("input");
  input.value = `${input.value.replace(/\s+$/, "")}${input.value.trim() ? " " : ""}${text}`;
  autoResize(input);
  input.focus();
}

$("skills-btn").addEventListener("click", async () => {
  const menu = $("quick-menu");
  if (!menu.classList.contains("hidden") && quickMenu.source === "skills") return closeQuickMenu();
  quickMenu.source = "skills";
  menu.innerHTML = '<div class="cmd-empty">加载中…</div>';
  menu.classList.remove("hidden");
  try {
    const data = await api("/api/skills");
    const skills = data.skills || [];
    if (!skills.length) {
      menu.innerHTML = '<div class="cmd-empty">暂无 Skill，到 ⚙️ 设置 → Skills 添加</div>';
      return;
    }
    menu.innerHTML = "";
    for (const skill of skills) {
      const item = el("div", "cmd-item");
      item.innerHTML = `<span class="cmd-name">/${escapeHtml(skill.name)}</span><span class="cmd-desc">${escapeHtml(skill.description || "")}</span><span class="cmd-src skill">skill</span>`;
      item.onmousedown = (e) => {
        e.preventDefault(); // 防止输入框失焦导致菜单关闭
        insertAtCursor(`/${skill.name} `);
        closeQuickMenu();
      };
      menu.append(item);
    }
  } catch (error) {
    menu.innerHTML = `<div class="cmd-empty error">${escapeHtml(error.message)}</div>`;
  }
});

$("mcp-btn").addEventListener("click", async () => {
  const menu = $("quick-menu");
  if (!menu.classList.contains("hidden") && quickMenu.source === "mcp") return closeQuickMenu();
  quickMenu.source = "mcp";
  menu.innerHTML = '<div class="cmd-empty">加载中…</div>';
  menu.classList.remove("hidden");
  try {
    const data = await api("/api/mcp");
    const servers = Object.entries(data.servers || {}).filter(([, cfg]) => cfg?.enabled !== false);
    if (!servers.length) {
      menu.innerHTML = '<div class="cmd-empty">暂无可用 MCP，到 ⚙️ 设置 → MCP 添加</div>';
      return;
    }
    menu.innerHTML = '<div class="cmd-empty">点选后在消息里引用该 MCP</div>';
    for (const [name, cfg] of servers) {
      const item = el("div", "cmd-item");
      const kind = cfg.url ? "http" : "stdio";
      const detail = cfg.url || `${cfg.command || ""} ${(cfg.args || []).join(" ")}`.trim();
      item.innerHTML = `<span class="cmd-name">@${escapeHtml(name)}</span><span class="cmd-desc">${escapeHtml(detail)}</span><span class="cmd-src mcp">${kind}</span>`;
      item.onmousedown = (e) => {
        e.preventDefault();
        insertAtCursor(`请使用 ${name} MCP 提供的工具：`);
        closeQuickMenu();
      };
      menu.append(item);
    }
  } catch (error) {
    menu.innerHTML = `<div class="cmd-empty error">${escapeHtml(error.message)}</div>`;
  }
});

async function updateStats() {
  try {
    const stats = await rpc({ type: "get_session_stats" });
    if (stats?.contextUsage) {
      $("context-badge").textContent = `${stats.contextUsage.percent}% · ${Math.round((stats.contextUsage.tokens || 0) / 1000)}k`;
    }
  } catch { /* 会话可能已关闭 */ }
}

// ===== 设置 =====
$("settings-btn").addEventListener("click", async () => {
  $("chat-view").classList.add("hidden");
  $("welcome-view").classList.add("hidden");
  $("settings-view").classList.remove("hidden");
  renderTabBar(); // 设置页隐藏标签栏；离开设置后由视图切换函数恢复
  renderSettings();
});

for (const btn of document.querySelectorAll("#settings-tabs button")) {
  btn.addEventListener("click", () => {
    state.settingsTab = btn.dataset.tab;
    for (const b of document.querySelectorAll("#settings-tabs button")) b.classList.toggle("active", b === btn);
    renderSettings();
  });
}

async function renderSettings() {
  const body = $("settings-body");
  body.innerHTML = '<p class="muted">加载中…</p>';
  try {
    if (state.settingsTab === "models") await renderModelsTab(body);
    else if (state.settingsTab === "usage") await renderUsageTab(body);
    else if (state.settingsTab === "mcp") await renderMcpTab(body);
    else if (state.settingsTab === "skills") await renderSkillsTab(body);
    else if (state.settingsTab === "scheduler") await renderSchedulerTab(body);
    else if (state.settingsTab === "wechat") await renderWechatTab(body);
    else if (state.settingsTab === "system") await renderSystemTab(body);
    else if (state.settingsTab === "security") renderSecurityTab(body);
  } catch (error) {
    body.innerHTML = `<p class="error">${error.message}</p>`;
  }
}

// ---- 模型配置 ----

async function renderModelsTab(body) {
  const config = await api("/api/models");
  const providers = config.providers || {};
  const panel = el("div", "panel");

  panel.append(el("p", "hint", "管理 pi 的 models.json：添加 OpenAI 兼容端点（中转站 / Ollama / vLLM / 官方 API）。apiKey 建议用 $环境变量 引用，或直接填明文（存于容器卷）。保存后新会话即生效。"));

  // 默认模型：新开会话默认用这个（历史会话不变）
  const prefs = await api("/api/prefs").catch(() => ({ defaultModel: null }));
  const defCard = el("div", "card");
  defCard.innerHTML = "<h3>⭐ 默认模型</h3>";
  defCard.append(el("p", "hint", "新建会话时默认选中的模型（已存在的历史会话保留自己原来的模型）。改完对新会话生效。"));
  const defSel = el("select", "");
  {
    const opts = ['<option value="">（不设置，用 pi 默认）</option>'];
    const choices = [];
    for (const [pname, prov] of Object.entries(providers)) {
      for (const m of prov.models || []) {
        if (!m.id) continue;
        choices.push({ provider: pname, id: m.id });
        opts.push(`<option value="${choices.length - 1}">${escapeHtml(m.name || m.id)} · ${escapeHtml(pname)}/${escapeHtml(m.id)}</option>`);
      }
    }
    defSel.innerHTML = opts.join("");
    defSel._choices = choices;
    if (prefs.defaultModel) {
      const idx = choices.findIndex((c) => c.provider === prefs.defaultModel.provider && c.id === prefs.defaultModel.id);
      if (idx >= 0) defSel.value = String(idx);
    }
  }
  const defSave = el("button", "primary", "保存默认模型");
  defSave.onclick = async () => {
    try {
      const v = defSel.value === "" ? null : defSel._choices[Number(defSel.value)] || null;
      await api("/api/prefs", { method: "PUT", body: JSON.stringify({ defaultModel: v }) });
      toast(v ? `默认模型已设为 ${v.provider}/${v.id}（新会话生效）` : "已清除默认模型");
    } catch (error) {
      toast(error.message, true);
    }
  };
  defCard.append(defSel, defSave);
  panel.append(defCard);

  // 重启 agent：pi 只在进程启动时读 models.json，新加模型必须重启进程才可见
  const restartCard = el("div", "card");
  restartCard.innerHTML = "<h3>🔄 重启 Agent 进程</h3>";
  restartCard.append(el("p", "hint", "pi 只在进程启动时读取 models.json / mcp.json / skills。新增模型后点这里重启所有空闲的会话进程（流式中的会跳过，不打断任务）；重启后再点开会话，新模型就出现在下拉里了。"));
  const restartBtn = el("button", "primary", "立即重启全部空闲会话进程");
  restartBtn.onclick = async () => {
    restartBtn.disabled = true;
    const old = restartBtn.textContent;
    restartBtn.textContent = "重启中…";
    try {
      const res = await api("/api/sessions/restart", { method: "POST", body: JSON.stringify({}) });
      const msg = res.restarted || res.skipped ? `已重启 ${res.restarted} 个进程${res.skipped ? `，跳过 ${res.skipped} 个运行中` : ""}；重开会话即可看到新模型` : "当前没有运行中的会话进程（新开会话直接用最新配置）";
      toast(msg, false);
      restartCard.querySelector(".hint:last-of-type")?.remove();
      restartCard.append(el("p", "hint", msg));
    } catch (error) {
      toast(error.message, true);
    } finally {
      restartBtn.disabled = false;
      restartBtn.textContent = old;
    }
  };
  restartCard.append(restartBtn);
  panel.append(restartCard);

  const list = el("div", "");
  panel.append(list);

  function renderProviderCards() {
    list.innerHTML = "";
    for (const [name, provider] of Object.entries(providers)) {
      list.append(providerCard(name, provider));
    }
    const addBtn = el("button", "", "＋ 添加供应商");
    addBtn.style.marginTop = "10px";
    addBtn.onclick = () => {
      let n = 1;
      while (providers[`provider${n}`]) n += 1;
      providers[`供应商${n}`] = { baseUrl: "", api: "openai-completions", apiKey: "", models: [{ id: "" }] };
      renderProviderCards();
    };
    list.append(addBtn);
  }

  function providerCard(name, provider) {
    const card = el("div", "card");
    card.style.marginBottom = "12px";
    const models = provider.models || [];
    let pendingName = name; // 保存时生效的重命名

    card.innerHTML = `<h3>📦 ${escapeHtml(name)}</h3>`;
    const rows = el("div", "");
    rows.append(
      fieldRow("名称", (input) => {
        input.value = name;
        input.placeholder = "供应商名称（如 deepseek、xiaomi）";
        input.oninput = () => (pendingName = input.value);
      }),
      fieldRow("baseUrl", (input) => {
        input.value = provider.baseUrl || "";
        input.placeholder = "https://api.example.com/v1";
        input.oninput = () => (provider.baseUrl = input.value);
      }),
      fieldRow("API 类型", (input) => {
        input.innerHTML = `
          <option value="openai-completions">openai-completions（OpenAI 兼容）</option>
          <option value="anthropic-messages">anthropic-messages</option>`;
        input.value = provider.api || "openai-completions";
        input.onchange = () => (provider.api = input.value);
      }),
      fieldRow("API Key", (input) => {
        input.type = "password";
        input.value = provider.apiKey || "";
        input.placeholder = "sk-… 或 $ENV_NAME";
        input.oninput = () => (provider.apiKey = input.value);
      }),
    );
    card.append(rows);

    // 按 baseUrl 获取模型清单（服务端代抓绕开 CORS）→ 勾选批量添加到本供应商
    const fetchRow = el("div", "row");
    const fetchBtn = el("button", "", "🔍 按 baseUrl 获取模型列表");
    const pickBox = el("div", "");
    fetchBtn.onclick = async () => {
      const url = String(provider.baseUrl || "").trim();
      if (!/^https?:\/\//i.test(url)) return toast("先填写 baseUrl（http/https）", true);
      fetchBtn.disabled = true;
      const orig = fetchBtn.textContent;
      fetchBtn.textContent = "查询中…（最多 15 秒）";
      try {
        const res = await api("/api/models/fetch", { method: "POST", body: JSON.stringify({ baseUrl: url, api: provider.api, apiKey: provider.apiKey }) });
        const have = new Set((provider.models || []).map((m) => m.id));
        const fresh = (res.models || []).filter((id) => !have.has(id));
        pickBox.innerHTML = "";
        pickBox.append(el("div", "hint", `查到 ${res.models.length} 个模型，可新增 ${fresh.length} 个（已存在的已排除）：`));
        if (!fresh.length) pickBox.append(el("div", "hint", "没有新模型——列表里已全有"));
        for (const id of fresh) {
          const label = el("label", "model-pick");
          const cb = el("input", "");
          cb.type = "checkbox";
          cb.value = id;
          cb.checked = true;
          label.append(cb, el("span", "", id));
          pickBox.append(label);
        }
        if (fresh.length) {
          // 全选 / 全不选（只挑几个模型时快速操作）
          const selRow = el("div", "row");
          const allBtn = el("button", "", "全选");
          const noneBtn = el("button", "", "全不选");
          allBtn.onclick = () => pickBox.querySelectorAll('input[type="checkbox"]').forEach((c) => (c.checked = true));
          noneBtn.onclick = () => pickBox.querySelectorAll('input[type="checkbox"]').forEach((c) => (c.checked = false));
          selRow.append(allBtn, noneBtn);
          pickBox.append(selRow);
          const addBtn2 = el("button", "primary", "添加勾选的模型");
          addBtn2.style.marginTop = "6px";
          addBtn2.onclick = () => {
            const checked = [...pickBox.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
            if (!checked.length) return toast("未勾选任何模型", true);
            provider.models = provider.models || [];
            for (const id of checked) if (!provider.models.some((m) => m.id === id)) provider.models.push({ id });
            toast(`已添加 ${checked.length} 个模型（点「保存」写入配置）`);
            renderProviderCards();
          };
          pickBox.append(addBtn2);
        }
      } catch (error) {
        toast(error.message, true);
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = orig;
      }
    };
    fetchRow.append(fetchBtn);
    card.append(fetchRow, pickBox);

    const modelLabel = el("div", "list-label", "模型 ID（每行一个）");
    card.append(modelLabel);
    const modelBox = el("div", "");
    models.forEach((model, index) => {
      modelBox.append(modelRow(model, index));
    });
    card.append(modelBox);
    const addModel = el("button", "", "＋ 添加模型");
    addModel.onclick = () => {
      const model = { id: "" };
      provider.models = provider.models || [];
      provider.models.push(model);
      modelBox.append(modelRow(model, provider.models.length - 1));
    };
    card.append(addModel);

    const actions = el("div", "row");
    actions.style.marginTop = "12px";
    const testBtn = el("button", "", "🔌 测试连接");
    const saveBtn = el("button", "primary", "保存");
    const delBtn = el("button", "danger", "删除供应商");
    actions.append(testBtn, saveBtn, delBtn);
    card.append(actions);
    const result = el("p", "hint");
    card.append(result);

    testBtn.onclick = async () => {
      result.textContent = "测试中…";
      testBtn.disabled = true;
      try {
        const r = await api("/api/models/test", { method: "POST", body: JSON.stringify(provider) });
        result.textContent = `${r.ok ? "✅" : "❌"} ${r.detail}`;
        result.style.color = r.ok ? "var(--ok)" : "var(--danger)";
      } catch (error) {
        result.textContent = `❌ ${error.message}`;
      }
      testBtn.disabled = false;
    };
    saveBtn.onclick = async () => {
      provider.models = (provider.models || []).filter((m) => m.id && m.id.trim());
      // 重命名供应商（改 key）：校验后移动条目并重渲染整表
      const newName = (pendingName || name).trim();
      if (newName !== name) {
        if (!/^[\w\u4e00-\u9fa5\- ]{1,64}$/.test(newName)) return toast("名称仅限中英文/数字/_/-/空格（1-64 字）", true);
        if (providers[newName]) return toast("同名供应商已存在", true);
        delete providers[name];
        providers[newName] = provider;
        try {
          await api("/api/models", { method: "PUT", body: JSON.stringify({ providers }) });
          toast(`已保存并重命名为「${newName}」（已开会话可能仍引用旧名，新会话生效）`);
          renderProviderCards();
        } catch (error) {
          toast(error.message, true);
        }
        return;
      }
      try {
        await api("/api/models", { method: "PUT", body: JSON.stringify({ providers }) });
        // pi 进程启动时读 models.json（已实测：运行中改配置 get_available_models 不变）
        toast("已保存；新模型对已开的会话需关闭重开才生效（pi 启动时读配置）");
      } catch (error) {
        toast(error.message, true);
      }
    };
    delBtn.onclick = () => {
      delete providers[name];
      renderProviderCards();
    };
    return card;
  }

  function modelRow(model, index) {
    const row = el("div", "model-row");
    const input = el("input");
    input.value = model.id || "";
    input.placeholder = "模型 ID，如 gpt-4o / qwen2.5-coder:7b";
    input.oninput = () => (model.id = input.value);
    // 价格（USD/百万 token，pi 的 cost 字段）：决定了用量页的费用换算
    const nums = [
      ["in", "输入 $/M"],
      ["out", "输出 $/M"],
      ["cacheRead", "缓存读 $/M"],
      ["cacheWrite", "缓存写 $/M"],
    ];
    const priceInputs = nums.map(([key, ph]) => {
      const inp = el("input", "model-price");
      inp.type = "number";
      inp.step = "0.001";
      inp.min = "0";
      inp.placeholder = ph;
      inp.title = `${ph}（USD/百万 token）。pi 要求 4 个价格字段齐全，留空会自动沿用输入价`;
      const v = model.cost?.[key];
      if (typeof v === "number") inp.value = String(v);
      inp.oninput = () => {
        const n = inp.value.trim();
        model.cost = model.cost || {};
        if (n === "") {
          delete model.cost[key];
          if (!Object.keys(model.cost).length) delete model.cost; // 全空则清掉 cost
        } else {
          model.cost[key] = Number(n);
        }
      };
      return inp;
    });
    const del = el("button", "del", "✕");
    del.onclick = () => {
      const provider = Object.values(providers).find((p) => (p.models || []).includes(model));
      if (provider) provider.models = provider.models.filter((m) => m !== model);
      row.remove();
    };
    row.append(input, ...priceInputs, del);
    void index;
    return row;
  }

  function fieldRow(label, setup) {
    const row = el("div", "row");
    const labelEl = el("label", "", label);
    const input = el("input", "");
    setup(input);
    row.append(labelEl, input);
    return row;
  }

  renderProviderCards();
  body.innerHTML = "";
  body.append(panel);
}

// ---- 用量统计 ----
// 聚合 pi 的 analytics/usage.jsonl：日/月 × 模型 × 项目，CSS 条形图不引图表库。
async function renderUsageTab(body) {
  const group = state.usageGroup || "day";
  const data = await api(`/api/usage?group=${group}`);
  const panel = el("div", "panel");

  const head = el("div", "row");
  const dayBtn = el("button", group === "day" ? "primary" : "", "按日");
  const monthBtn = el("button", group === "month" ? "primary" : "", "按月");
  dayBtn.onclick = () => {
    state.usageGroup = "day";
    renderSettings();
  };
  monthBtn.onclick = () => {
    state.usageGroup = "month";
    renderSettings();
  };
  head.append(dayBtn, monthBtn);
  panel.append(head);
  const sourceLabel = data.source === "usage-logger" ? "内置 usage-logger 扩展" : data.source === "pi-tracker" ? "pi-tracker（第三方）" : "暂无数据源";
  panel.append(el("p", "hint", `数据源：${sourceLabel}（共 ${data.scanned} 条${data.skipped ? `，跳过 ${data.skipped} 条异常行` : ""}）。月份按服务器本地时区划分。`));
  if (data.source === "none") {
    panel.append(el("p", "hint", "usage-logger 随镜像内置：发一条消息后开始记录；若本次刚部署，确认容器已重建（扩展在启动时同步进 pi）。"));
  }

  if (!data.rows.length) {
    panel.append(el("p", "hint", "暂无用量数据。模型跑过任务后这里会出现统计。"));
  } else {
    const maxTotal = Math.max(1, ...data.rows.map((r) => r.total));
    const table = el("table", "simple");
    const headRow = el("tr", "");
    headRow.innerHTML = `<th>${group === "day" ? "日期" : "月份"}</th><th>项目</th><th>模型</th><th style="text-align:right">次数</th><th style="text-align:right">输入</th><th style="text-align:right">输出</th><th style="text-align:right">合计</th><th style="text-align:right">费用</th><th style="width:110px">占比</th>`;
    table.append(headRow);
    for (const row of data.rows) {
      const tr = el("tr", "");
      const modelShort = row.model.split("/").pop();
      const costCell = row.cost === null ? '<span class="hint">未配价</span>' : `${fmtCost(row.cost)}${row.priceMissing ? '<span class="hint" title="部分请求使用的模型未配价格">*</span>' : ""}`;
      tr.innerHTML =
        `<td>${escapeHtml(row.bucket)}</td><td>${escapeHtml(row.project || "—")}</td><td title="${escapeHtml(row.model)}">${escapeHtml(modelShort)}</td>` +
        `<td style="text-align:right">${row.count}</td><td style="text-align:right">${fmtTokens(row.input)}</td><td style="text-align:right">${fmtTokens(row.output)}</td><td style="text-align:right">${fmtTokens(row.total)}</td>` +
        `<td style="text-align:right">${costCell}</td>` +
        `<td><div class="usage-bar"><div style="width:${Math.max(2, Math.round((row.total / maxTotal) * 100))}%"></div></div></td>`;
      table.append(tr);
    }
    panel.append(table);
  }
  const costLine = data.totals.cost === null ? "（未配价格，无法估算——到「模型 / API」给模型填 cost）" : fmtCost(data.totals.cost) + (data.totals.priceMissing ? "*（部分模型未配价，已计入的为已知部分）" : "");
  panel.append(el("p", "hint", `全部合计：${fmtTokens(data.totals.total)} tokens（输入 ${fmtTokens(data.totals.input)} / 输出 ${fmtTokens(data.totals.output)}），共 ${data.totals.count} 次请求；费用约 ${costLine}`));
  if (group === "month" && data.rows.length) {
    const months = [...new Set(data.rows.map((r) => r.bucket))];
    if (months.length > 1) {
      panel.append(el("p", "hint", `月度对比：${months.slice(0, 6).map((m) => `${m} ${fmtCost(sumCostOf(data.rows.filter((r) => r.bucket === m)))}`).join(" · ")}`));
    }
  }
  body.innerHTML = "";
  body.append(panel);
}

/** 成本显示：USD 为主，小于 0.01 时给四位小数 */
function fmtCost(usd) {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function sumCostOf(rows) {
  let sum = 0;
  let known = false;
  for (const r of rows) {
    if (r.cost !== null) {
      sum += r.cost;
      known = true;
    }
  }
  return known ? sum : null;
}

/** 无可用模型时自检 models.json，把“到底哪一侧坏了”说清楚（不再只丢一句提示）。 */
async function explainNoModels(select, rpcData) {
  try {
    const h = await api("/api/models/health");
    console.warn("[model-select] RPC 返回模型数 =", (rpcData?.models || []).length, "| models.json 健康度 =", h);
    if (!h.ok) {
      select.title = `models.json 解析失败：${h.error}（路径 ${h.modelsPath}）`;
      toast(`models.json 已损坏：${h.error}。请到设置→模型 重新保存一次`, true);
      return;
    }
    if (h.modelCount === 0) {
      select.title = "models.json 里没有有效模型（每个供应商下需至少一个模型 ID）";
      toast(`models.json 配置了 ${h.providerCount} 个供应商但 0 个有效模型——请在设置→模型 填模型 ID 并保存`, true);
      return;
    }
    // 配置里有模型，但 pi 返回 0：进程未读到配置
    const detail = h.providers.map((p) => `${p.name}(${p.models})`).join("、");
    select.title = `models.json 有 ${h.modelCount} 个模型（${detail}），但当前 pi 进程返回 0——需重启 Agent 进程`;
    toast(`models.json 有 ${h.modelCount} 个模型，但 pi 进程读到 0 个——请点设置→模型→「重启 Agent 进程」`, true);
  } catch (error) {
    console.warn("[model-select] 健康检查失败:", error);
  }
}

function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0);
}

// ---- MCP 管理 ----
// 读写 $PI_AGENT_DIR/mcp.json；改动对新会话生效（已开会话需关闭重开）。
async function renderMcpTab(body) {
  let data = await api("/api/mcp");
  let servers = { ...(data.servers || {}) };
  const panel = el("div", "panel");
  panel.append(el("p", "hint", "管理 pi 的 MCP 服务器。改动对新会话生效：已打开的会话需关闭后重新打开才能连上新增的 MCP。"));
  const list = el("div", "");
  panel.append(list);

  async function save() {
    try {
      const res = await api("/api/mcp", { method: "PUT", body: JSON.stringify({ servers }) });
      servers = res.servers || {};
      renderList();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function renderList() {
    list.innerHTML = "";
    const names = Object.keys(servers);
    if (!names.length) list.append(el("p", "hint", "还没有 MCP 服务器，用下方表单添加。"));
    for (const name of names) {
      const cfg = servers[name];
      const isHttp = !!cfg.url;
      const card = el("div", "card");
      const pill = el("span", `status-pill ${cfg.enabled === false ? "off" : "ok"}`);
      pill.textContent = cfg.enabled === false ? "已禁用" : isHttp ? "HTTP" : "stdio";
      const title = el("h3", "", `🔌 ${name} `);
      title.append(pill);
      card.append(title);
      card.append(el("p", "hint", isHttp ? cfg.url : `${cfg.command} ${(cfg.args || []).join(" ")}`));
      const row = el("div", "row");
      const toggle = el("button", "", cfg.enabled === false ? "启用" : "禁用");
      toggle.onclick = async () => {
        if (cfg.enabled === false) delete cfg.enabled;
        else cfg.enabled = false;
        await save();
        toast("已更新（新会话生效）");
      };
      const del = el("button", "danger", "删除");
      del.onclick = async () => {
        if (!confirm(`删除 MCP「${name}」？`)) return;
        delete servers[name];
        await save();
        toast("已删除（新会话生效）");
      };
      row.append(toggle, del);
      card.append(row);
      list.append(card);
    }
  }
  renderList();

  // 添加表单
  const addCard = el("div", "card");
  addCard.innerHTML = "<h3>＋ 添加 MCP</h3>";
  const nameInput = el("input", "");
  nameInput.placeholder = "名称（字母/数字/_/-，如 my-server）";
  const kindSel = el("select", "");
  kindSel.innerHTML = `<option value="http">HTTP（远程 URL）</option><option value="command">命令行（本地 stdio，如 npx -y xxx-mcp）</option>`;
  const urlInput = el("input", "");
  urlInput.placeholder = "https://example.com/mcp";
  const cmdInput = el("input", "");
  cmdInput.placeholder = "npx -y some-mcp（命令与参数用空格分隔）";
  cmdInput.classList.add("hidden");
  kindSel.onchange = () => {
    const http = kindSel.value === "http";
    urlInput.classList.toggle("hidden", !http);
    cmdInput.classList.toggle("hidden", http);
  };
  const addBtn = el("button", "primary", "添加");
  addBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return toast("名称不合法（字母/数字/_/-）", true);
    if (servers[name]) return toast("同名服务器已存在", true);
    if (kindSel.value === "http") {
      const url = urlInput.value.trim();
      if (!/^https?:\/\//i.test(url)) return toast("URL 必须是 http(s) 地址", true);
      servers[name] = { type: "http", url };
    } else {
      const parts = cmdInput.value.trim().split(/\s+/);
      if (!parts[0]) return toast("填写命令", true);
      servers[name] = { command: parts[0], args: parts.slice(1) };
    }
    await save();
    nameInput.value = urlInput.value = cmdInput.value = "";
    toast("已添加（新会话生效）");
  };
  addCard.append(nameInput, kindSel, urlInput, cmdInput, addBtn);
  panel.append(addCard);
  body.innerHTML = "";
  body.append(panel);
}

// ---- Skills 管理 ----
// $PI_AGENT_DIR/skills/<name>/SKILL.md 的列表/查看/新建/编辑/删除；
// 新建/修改对新会话生效；对话框 ⚡ 按钮从这里读列表。
async function renderSkillsTab(body) {
  let data = await api("/api/skills");
  let skills = data.skills || [];
  const panel = el("div", "panel");
  panel.append(el("p", "hint", "管理 pi 的 Skills。新建/修改/删除对新会话生效；对话框的 ⚡ 按钮可把 /skill 直接填入输入框。"));

  const list = el("div", "");
  panel.append(list);
  function renderSkills() {
    list.innerHTML = "";
    if (!skills.length) list.append(el("p", "hint", "还没有 skill，用下方表单新建。"));
    for (const skill of skills) {
      const card = el("div", "card");
      const pill = el("span", "status-pill off");
      pill.textContent = `${Math.max(1, Math.round(skill.bytes / 1024))}KB`;
      const title = el("h3", "", `⚡ ${skill.name} `);
      title.append(pill);
      card.append(title);
      card.append(el("p", "hint", skill.description || "（无描述）"));
      const row = el("div", "row");
      const editBtn = el("button", "", "编辑");
      editBtn.onclick = async () => {
        try {
          const res = await api(`/api/skills?name=${encodeURIComponent(skill.name)}`);
          nameInput.value = skill.name;
          contentArea.value = res.content || "";
          contentArea.scrollIntoView({ block: "center" });
        } catch (error) {
          toast(error.message, true);
        }
      };
      const delBtn = el("button", "danger", "删除");
      delBtn.onclick = async () => {
        if (!confirm(`删除 skill「${skill.name}」？不可恢复。`)) return;
        try {
          await api(`/api/skills?name=${encodeURIComponent(skill.name)}`, { method: "DELETE" });
          skills = skills.filter((s) => s.name !== skill.name);
          renderSkills();
          toast("已删除");
        } catch (error) {
          toast(error.message, true);
        }
      };
      row.append(editBtn, delBtn);
      card.append(row);
      list.append(card);
    }
  }
  renderSkills();

  const formCard = el("div", "card");
  formCard.innerHTML = "<h3>＋ 新建 / 覆盖 Skill</h3>";
  const nameInput = el("input", "");
  nameInput.placeholder = "skill 名（字母/数字/_/-，如 my-skill）";
  const contentArea = el("textarea", "");
  contentArea.rows = 12;
  contentArea.placeholder = "SKILL.md 内容（开头可带 YAML frontmatter：description: 一句话说明）";
  contentArea.style.width = "100%";
  contentArea.style.marginTop = "8px";
  contentArea.style.fontFamily = "var(--mono)";
  contentArea.style.fontSize = "13px";
  const saveBtn = el("button", "primary", "保存");
  saveBtn.onclick = async () => {
    const name = nameInput.value.trim();
    try {
      const res = await api("/api/skills", { method: "PUT", body: JSON.stringify({ name, content: contentArea.value }) });
      data = await api("/api/skills");
      skills = data.skills || [];
      renderSkills();
      toast(`已保存 ${res.name}（新会话生效）`);
      nameInput.value = "";
      contentArea.value = "";
    } catch (error) {
      toast(error.message, true);
    }
  };
  formCard.append(nameInput, contentArea, saveBtn);
  panel.append(formCard);
  body.innerHTML = "";
  body.append(panel);
}

// ---- 定时任务（日报等周期性产出） ----
// 到点在指定项目开新会话执行 prompt，产出存为项目内 md（默认 定时任务/ 目录）；
// 配合文件树时间倒序，新日报自动置顶。设置页仅创建/启停/立即执行/删除（编辑=删了重建）。
async function renderSchedulerTab(body) {
  const [data, projects, modelsCfg] = await Promise.all([api("/api/scheduler"), api("/api/projects"), api("/api/models")]);
  let tasks = data.tasks || [];
  const panel = el("div", "panel");
  panel.append(el("p", "hint", "到点在指定项目开一个新会话执行提示词（每次新会话，互不污染上下文），产出保存为项目内的 Markdown。时间按服务器时区解释（设置 → 系统页可查）。配合文件树「时间倒序」（面板顶部 ⏱），新日报自动置顶。"));

  const list = el("div", "");
  panel.append(list);
  function fmtTime(ts) {
    return ts ? new Date(ts).toLocaleString() : "—";
  }
  function renderTasks() {
    list.innerHTML = "";
    if (!tasks.length) list.append(el("p", "hint", "还没有定时任务。用下方表单新建（如：每天 18:00 生成当日日报）。"));
    for (const task of tasks) {
      const card = el("div", "card");
      const pill = el("span", `status-pill ${task.running ? "ok" : task.enabled ? "off" : "err"}`);
      pill.textContent = task.running ? "● 执行中" : task.enabled ? "待触发" : "已停用";
      const title = el("h3", "", `⏰ ${task.name} `);
      title.append(pill);
      card.append(title);
      const project = projects.find((p) => p.id === task.projectId);
      const schedText =
        task.schedule.kind === "interval"
          ? `每 ${task.schedule.minutes} 分钟`
          : task.schedule.kind === "weekday"
            ? `工作日 ${task.schedule.time}`
            : task.schedule.kind === "monthly"
              ? `每月 ${task.schedule.day} 日 ${task.schedule.time}`
              : `每天 ${task.schedule.time}`;
      card.append(el("p", "hint", `${schedText} · 项目：${project?.name || "（项目已删除）"} · 模型：${task.model ? `${task.model.id}（${task.model.provider}）` : "默认"} · 产出：${task.outputDir}/${task.name}-YYYY-MM-DD.md`));
      card.append(el("p", "hint", `上次：${fmtTime(task.lastRunAt)}${task.lastResult?.rel ? ` → ${task.lastResult.rel}` : ""}${task.lastError ? ` · 错误：${task.lastError}` : ""}｜下次：${task.enabled ? fmtTime(task.nextRunAt) : "—"}`));
      const row = el("div", "row");
      const editBtn = el("button", "", "✏️ 编辑");
      editBtn.onclick = () => beginEditTask(task);
      const toggle = el("button", "", task.enabled ? "停用" : "启用");
      toggle.onclick = async () => {
        await api("/api/scheduler/task", { method: "POST", body: JSON.stringify({ ...task, enabled: !task.enabled }) });
        renderSettings();
      };
      const runBtn = el("button", "", "▶ 立即执行");
      runBtn.onclick = async () => {
        runBtn.disabled = true;
        runBtn.textContent = "执行中…（可能需要几分钟）";
        try {
          const res = await api("/api/scheduler/run", { method: "POST", body: JSON.stringify({ id: task.id }) });
          toast(res.ok === false ? `执行失败：${res.error}` : `已完成：${res.rel}`, res.ok === false);
        } catch (error) {
          toast(error.message, true);
        }
        renderSettings();
      };
      row.append(editBtn, toggle, runBtn);
      if (task.lastResult?.rel) {
        const openBtn = el("button", "", "📄 上次产出");
        openBtn.onclick = () => {
          const pr = projects.find((p) => p.id === task.projectId);
          if (pr) void openFilePreview(pr, task.lastResult.rel);
        };
        row.append(openBtn);
      }
      const del = el("button", "danger", "删除");
      del.onclick = async () => {
        if (!confirm(`删除定时任务「${task.name}」？`)) return;
        await api(`/api/scheduler/task?id=${encodeURIComponent(task.id)}`, { method: "DELETE" });
        renderSettings();
      };
      row.append(del);
      card.append(row);
      list.append(card);
    }
  }
  renderTasks();

  // 新建/编辑表单（点任务卡「✏️ 编辑」进入编辑态：回填字段，保存即修订，无需删重建）
  const form = el("div", "card");
  const formTitle = el("h3", "", "＋ 新建定时任务");
  form.append(formTitle);
  let editingId = null;
  const nameInput = el("input", "");
  nameInput.placeholder = "任务名（也是产出文件名，如：日报）";
  const projectSel = el("select", "");
  projectSel.innerHTML = projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("") || '<option value="">（先去添加项目）</option>';
  // 指定模型（峰谷价差择优）：选项来自 models.json；value 用数组下标。
  // 勿用 NUL 分隔符：innerHTML 构建的选项值经 HTML 解析会丢掉 NUL，split 后 id 为空
  // （v0.4.3 实测 bug：选非默认模型报「模型参数不合法」）。
  const modelChoices = [];
  const modelSel = el("select", "");
  {
    const opts = ['<option value="">默认（会话当前模型）</option>'];
    for (const [pname, prov] of Object.entries(modelsCfg.providers || {})) {
      for (const m of prov.models || []) {
        if (!m.id) continue;
        modelChoices.push({ provider: pname, id: m.id });
        opts.push(`<option value="${modelChoices.length - 1}">${escapeHtml(m.name || m.id)} · ${escapeHtml(pname)}/${escapeHtml(m.id)}</option>`);
      }
    }
    modelSel.innerHTML = opts.join("");
  }
  const kindSel = el("select", "");
  kindSel.innerHTML = `<option value="daily">每天</option><option value="weekday">工作日（周一至周五）</option><option value="monthly">每月指定日（月报）</option><option value="interval">间隔（分钟）</option>`;
  const timeInput = el("input", "");
  timeInput.type = "time";
  timeInput.value = "18:00";
  timeInput.classList.add("sched-time");
  const dayInput = el("input", "");
  dayInput.type = "number";
  dayInput.min = "1";
  dayInput.max = "31";
  dayInput.value = "1";
  dayInput.placeholder = "1-31";
  dayInput.title = "每月几号触发（1-31；当月没有该日则落到月末）";
  dayInput.classList.add("sched-day");
  dayInput.classList.add("hidden");
  const minutesInput = el("input", "");
  minutesInput.type = "number";
  minutesInput.min = "5";
  minutesInput.max = "1440";
  minutesInput.value = "60";
  minutesInput.placeholder = "60";
  minutesInput.classList.add("sched-day");
  minutesInput.classList.add("hidden");
  // 排期行：文字标签 + 输入框，拼成「每月 [几号] 日 [几点]」这种可读句式
  const lbWeekday = el("span", "sched-label", "工作日");
  const lbMonthly = el("span", "sched-label", "每月");
  const lbDay = el("span", "sched-label", "日");
  const lbEvery = el("span", "sched-label", "每");
  const lbMinutes = el("span", "sched-label", "分钟");
  for (const lb of [lbWeekday, lbMonthly, lbDay, lbEvery, lbMinutes]) lb.classList.add("hidden");
  const schedRow = el("div", "row");
  schedRow.append(lbMonthly, dayInput, lbDay, lbWeekday, timeInput, lbEvery, minutesInput, lbMinutes);
  kindSel.onchange = () => {
    const kind = kindSel.value;
    timeInput.classList.toggle("hidden", kind === "interval");
    dayInput.classList.toggle("hidden", kind !== "monthly");
    minutesInput.classList.toggle("hidden", kind !== "interval");
    lbMonthly.classList.toggle("hidden", kind !== "monthly");
    lbDay.classList.toggle("hidden", kind !== "monthly");
    lbWeekday.classList.toggle("hidden", kind !== "weekday");
    lbEvery.classList.toggle("hidden", kind !== "interval");
    lbMinutes.classList.toggle("hidden", kind !== "interval");
  };
  const promptArea = el("textarea", "");
  promptArea.rows = 5;
  promptArea.placeholder = "执行的提示词（如：阅读今天项目内的 git 变动与新文件，生成一份当日工作日报，用中文、分「今日完成/明日计划/风险」三节）";
  promptArea.style.width = "100%";
  promptArea.style.margin = "8px 0";
  const dirInput = el("input", "");
  dirInput.placeholder = "输出目录（默认：定时任务）";
  const addBtn = el("button", "primary", "添加任务");
  const cancelBtn = el("button", "", "取消编辑");
  cancelBtn.classList.add("hidden");
  addBtn.onclick = async () => {
    try {
      const existing = editingId ? tasks.find((t) => t.id === editingId) : null;
      await api("/api/scheduler/task", {
        method: "POST",
        body: JSON.stringify({
          id: editingId || undefined,
          name: nameInput.value.trim(),
          projectId: projectSel.value,
          schedule:
            kindSel.value === "interval"
              ? { kind: "interval", minutes: Number(minutesInput.value) }
              : kindSel.value === "monthly"
                ? { kind: "monthly", day: Number(dayInput.value), time: timeInput.value }
                : kindSel.value === "weekday"
                  ? { kind: "weekday", time: timeInput.value }
                  : { kind: "daily", time: timeInput.value },
          prompt: promptArea.value.trim(),
          outputDir: dirInput.value.trim() || "定时任务",
          model: modelSel.value !== "" ? modelChoices[Number(modelSel.value)] || null : null,
          enabled: existing ? existing.enabled : true, // 编辑保留原启停状态
        }),
      });
      toast(existing ? "已保存修改（下次触发按新排期重算）" : "任务已添加");
      renderSettings();
    } catch (error) {
      toast(error.message, true);
    }
  };
  cancelBtn.onclick = () => resetForm();

  function resetForm() {
    editingId = null;
    formTitle.textContent = "＋ 新建定时任务";
    addBtn.textContent = "添加任务";
    cancelBtn.classList.add("hidden");
    nameInput.value = "";
    promptArea.value = "";
    dirInput.value = "";
    modelSel.value = "";
    kindSel.value = "daily";
    kindSel.onchange();
    timeInput.value = "18:00";
    dayInput.value = "1";
    minutesInput.value = "60";
  }

  function beginEditTask(task) {
    editingId = task.id;
    formTitle.textContent = `✎ 编辑：${task.name}`;
    addBtn.textContent = "保存修改";
    cancelBtn.classList.remove("hidden");
    nameInput.value = task.name;
    projectSel.value = task.projectId;
    if (task.model) {
      const idx = modelChoices.findIndex((c) => c.provider === task.model.provider && c.id === task.model.id);
      modelSel.value = idx >= 0 ? String(idx) : ""; // 模型已从 models.json 删除则回退默认
    }
    kindSel.value = task.schedule.kind;
    kindSel.onchange(); // 联动显示对应输入框
    if (task.schedule.kind === "interval") minutesInput.value = task.schedule.minutes;
    else {
      timeInput.value = task.schedule.time;
      if (task.schedule.kind === "monthly") dayInput.value = task.schedule.day;
    }
    promptArea.value = task.prompt || "";
    dirInput.value = task.outputDir || "";
    form.scrollIntoView({ block: "center" });
    nameInput.focus();
  }

  form.append(nameInput, projectSel, modelSel, kindSel, schedRow, promptArea, dirInput, addBtn, cancelBtn);
  panel.append(form);
  body.innerHTML = "";
  body.append(panel);
}

// ---- 微信 ----
// 双账号槽位（两只手机）：每张卡独立扫码/退出/账号默认项目/绑定表；全局一个启用开关。
const lastLoginPhases = {}; // accountId -> phase（WS broadcast wechat:login 更新）

async function renderWechatTab(body) {
  const [status, projects] = await Promise.all([api("/api/wechat"), api("/api/projects")]);
  const panel = el("div", "panel");

  // 全局开关 + 全局默认项目
  const master = el("div", "card");
  master.innerHTML = "<h3>微信 iLink 接入</h3>";
  master.append(el("p", "hint", "扫码绑定微信号后，在微信里直接发消息即触发 agent 执行并回复。支持私聊文本、文件与图片：发 doc/xlsx/pptx/pdf 等文件（可附一句说明），agent 分析/修改后把成品文件发回给你；语音/视频暂不支持。协议限制无法主动推送（必须你先发消息）。支持两个微信号分别扫码，各自独立绑定会话与项目。"));
  const enableRow = el("div", "row");
  const enableBtn = el("button", status.enabled ? "danger" : "primary", status.enabled ? "停用桥接" : "启用桥接");
  enableBtn.onclick = async () => {
    await api("/api/wechat/enabled", { method: "POST", body: JSON.stringify({ enabled: !status.enabled }) });
    renderSettings();
  };
  enableRow.append(el("label", "", "桥接"), enableBtn);
  master.append(enableRow);

  const globalProjRow = el("div", "row");
  const globalSelect = el("select", "");
  globalSelect.innerHTML = `<option value="">（自动选第一个项目）</option>` + projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  globalSelect.value = status.defaultProjectId || "";
  globalSelect.onchange = async () => {
    await api("/api/wechat/default-project", { method: "POST", body: JSON.stringify({ projectId: globalSelect.value || null }) });
    toast("全局默认项目已更新");
  };
  globalProjRow.append(el("label", "", "默认项目"), globalSelect);
  master.append(globalProjRow);
  panel.append(master);

  for (const account of status.accounts || []) panel.append(accountCard(account, projects));
  body.innerHTML = "";
  body.append(panel);
}

function accountCard(account, projects) {
  const card = el("div", "card");
  card.innerHTML = `<h3>📱 微信账号 ${account.slot}</h3>`;
  const loggedIn = !!account.account && !account.account.needsRelogin;

  const statusRow = el("div", "row");
  const pill = el("span", `status-pill ${account.status === "connected" ? "ok" : account.errorMessage === "login-required" ? "err" : "off"}`);
  pill.textContent = account.status === "connected" ? "● 已连接" : account.errorMessage === "login-required" ? "● 需重新扫码" : "● 未登录";
  statusRow.append(el("label", "", "状态"), pill);
  card.append(statusRow);

  // 扫码 / 退出
  const loginRow = el("div", "row");
  const loginBtn = el("button", "primary", loggedIn && !account.account.needsRelogin ? "重新扫码" : "扫码登录");
  const qrBox = el("div", "qr-box");
  loginBtn.onclick = async () => {
    loginBtn.disabled = true;
    loginBtn.textContent = "正在获取二维码…";
    try {
      const result = await api("/api/wechat/login", { method: "POST", body: JSON.stringify({ accountId: account.id }) });
      qrBox.innerHTML = "";
      if (result.qrDataUrl) {
        const img = el("img");
        img.src = result.qrDataUrl;
        img.alt = `微信账号 ${account.slot} 登录二维码`;
        qrBox.append(img, el("p", "hint", `用第 ${account.slot} 个手机的微信「扫一扫」，在手机上确认。二维码 8 分钟内有效。`));
      }
      pollLoginState();
    } catch (error) {
      toast(error.message, true);
      loginBtn.disabled = false;
      loginBtn.textContent = "扫码登录";
    }
  };
  loginRow.append(el("label", "", "账号"), loginBtn);
  if (loggedIn) {
    const logoutBtn = el("button", "danger", "退出登录");
    logoutBtn.onclick = async () => {
      await api("/api/wechat/logout", { method: "POST", body: JSON.stringify({ accountId: account.id }) });
      renderSettings();
    };
    loginRow.append(logoutBtn);
  }
  card.append(loginRow, qrBox);

  async function pollLoginState() {
    // 轮询桥接登录相位（broadcast 也推，轮询简单可靠）
    const phase = lastLoginPhases[account.id] || "idle";
    if (phase === "confirmed") {
      toast(`微信账号 ${account.slot} 登录成功`);
      renderSettings();
      return;
    }
    if (phase === "expired" || phase === "error") {
      qrBox.innerHTML = `<p class="error">登录${phase === "expired" ? "已过期" : "失败"}</p>`;
      loginBtn.disabled = false;
      loginBtn.textContent = "重试";
      return;
    }
    setTimeout(pollLoginState, 2500);
  }

  // 账号级默认项目（优先于全局；两只手机可各绑不同项目）
  const projRow = el("div", "row");
  const sel = el("select", "");
  sel.innerHTML = `<option value="">（用全局默认项目）</option>` + projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  sel.value = account.defaultProjectId || "";
  sel.onchange = async () => {
    await api("/api/wechat/account-default-project", { method: "POST", body: JSON.stringify({ accountId: account.id, projectId: sel.value || null }) });
    toast(`账号 ${account.slot} 默认项目已更新`);
  };
  projRow.append(el("label", "", "默认项目"), sel);
  card.append(projRow);

  // 绑定表
  card.append(el("div", "list-label", "会话绑定"));
  const bindings = account.bindings || [];
  if (bindings.length) {
    const table = el("table", "simple");
    table.innerHTML = "<tr><th>微信对话</th><th>项目</th><th></th></tr>";
    for (const binding of bindings) {
      const projectName = projects.find((p) => p.id === binding.projectId)?.name || binding.projectId;
      const tr = el("tr", "");
      tr.innerHTML = `<td>${escapeHtml(binding.chatId)}</td><td>${escapeHtml(projectName)}</td>`;
      const td = el("td", "");
      const unbind = el("button", "danger", "解绑");
      unbind.onclick = async () => {
        await api("/api/wechat/bindings", { method: "DELETE", body: JSON.stringify({ accountId: account.id, chatId: binding.chatIdFull }) });
        renderSettings();
      };
      td.append(unbind);
      tr.append(td);
      table.append(tr);
    }
    card.append(table);
  } else {
    card.append(el("p", "hint", "暂无绑定。该微信号发第一条消息时自动绑定到默认项目的新会话。"));
  }
  card.append(el("p", "hint", "微信内可用命令：/new 重置会话 · /stop 停止任务 · /status 查看状态"));
  return card;
}

// ---- 系统 ----

async function renderSystemTab(body) {
  const system = await api("/api/system");
  const panel = el("div", "panel");

  const card = el("div", "card");
  card.innerHTML = `<h3>运行环境</h3>
    <table class="simple">
      <tr><th>PiNasDeck</th><td>v${escapeHtml(system.appVersion || "dev")}${system.appBuildDate && system.appBuildDate !== "unknown" ? `（构建于 ${escapeHtml(system.appBuildDate)}）` : ""}</td></tr>
      <tr><th>容器启动于</th><td>${system.appStartedAt ? new Date(system.appStartedAt).toLocaleString() : "—"}</td></tr>
      <tr><th>服务器时区</th><td>${escapeHtml(system.serverTz || "?")}（定时任务与用量统计按此时区解释）</td></tr>
      <tr><th>pi 版本</th><td>${escapeHtml(system.piVersion || "未安装")}</td></tr>
      <tr><th>最新版本</th><td>${escapeHtml(system.latestPiVersion || "查询失败（网络/镜像源）")}${system.updateAvailable ? ' <span class="status-pill err">可更新</span>' : ""}</td></tr>
      <tr><th>Node</th><td>${escapeHtml(system.nodeVersion)}</td></tr>
      <tr><th>平台</th><td>${escapeHtml(system.platform)}</td></tr>
      <tr><th>Workspace</th><td>${escapeHtml(system.workspaceRoot)}</td></tr>
    </table>`;
  panel.append(card);

  const updateCard = el("div", "card");
  updateCard.innerHTML = "<h3>在线更新 pi</h3><p class='hint'>在容器内直接升级 pi CLI（npm 全局安装）。运行中的会话进程不受影响，新会话使用新版本。<br>注意：容器重建后会回到镜像内置版本，届时再点一次即可。</p>";
  const updateBtn = el("button", "primary", system.updateAvailable ? "立即更新到最新版" : "强制更新到最新版");
  const logBox = el("pre", "log hidden");
  updateBtn.onclick = async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = "更新中…（1-3 分钟）";
    logBox.classList.remove("hidden");
    logBox.textContent = "";
    try {
      const res = await fetch("/api/system/update-pi", { method: "POST", headers: { authorization: `Bearer ${state.token}` } });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = JSON.parse(line.slice(6));
          if (payload.log) logBox.textContent += payload.log;
          if (payload.done) {
            toast(payload.ok ? "更新完成" : "更新失败，见日志", !payload.ok);
            updateBtn.disabled = false;
            updateBtn.textContent = "重新检查更新";
            renderSettings();
          }
          logBox.scrollTop = logBox.scrollHeight;
        }
      }
    } catch (error) {
      toast(error.message, true);
      updateBtn.disabled = false;
    }
  };
  updateCard.append(updateBtn, logBox);
  panel.append(updateCard);

  // 会话进程池（内存治理）：每个会话一个 pi 进程，超过并发上限时按最久未活动自动挂起
  const procCard = el("div", "card");
  procCard.innerHTML = "<h3>🧠 会话进程池</h3>";
  const procBox = el("div", "");
  procCard.append(procBox);
  panel.append(procCard);
  const loadProcs = async () => {
    try {
      const data = await api("/api/sessions/processes");
      procBox.innerHTML = "";
      procBox.append(el("p", "hint", `上限 ${data.limits.maxConcurrent} 个并发进程（超过时按最久未活动自动挂起，流式中的不挂）；空闲 ${Math.round(data.limits.idleKillMs / 60000)} 分钟回收。`));
      // 手动重启全部（重置配置读取：新模型/MCP/Skills 生效）
      const rRow = el("div", "row");
      const rBtn = el("button", "", "🔄 重启全部空闲进程");
      rBtn.title = "结束空闲进程（不碰会话文件），重开会话时 pi 重读 models.json/mcp.json/skills";
      rBtn.onclick = async () => {
        rBtn.disabled = true;
        try {
          const res = await api("/api/sessions/restart", { method: "POST", body: JSON.stringify({}) });
          toast(`已重启 ${res.restarted} 个${res.skipped ? `，跳过 ${res.skipped} 个运行中` : ""}`);
          void loadProcs();
        } catch (error) {
          toast(error.message, true);
        } finally {
          rBtn.disabled = false;
        }
      };
      rRow.append(rBtn);
      procBox.append(rRow);
      if (!data.processes.length) return procBox.append(el("p", "hint", "当前没有运行的会话进程。"));
      const table = el("table", "simple");
      table.innerHTML = "<tr><th>会话</th><th>状态</th><th>空闲</th><th></th></tr>";
      for (const p of data.processes) {
        const tr = el("tr", "");
        const name = (p.sessionFile || p.key).split(/[\\/]/).pop();
        tr.innerHTML = `<td title="${escapeHtml(p.cwd)}">${escapeHtml(name)}</td><td>${p.streaming ? "● 运行中" : "待命"}</td><td>${Math.round(p.idleMs / 1000)}s</td>`;
        const td = el("td", "");
        const btn = el("button", p.streaming ? "" : "", "挂起");
        btn.disabled = p.streaming;
        btn.title = p.streaming ? "运行中不能挂起" : "结束进程释放内存（会话文件保留，点开自动重启）";
        btn.onclick = async () => {
          const res = await api("/api/sessions/suspend", { method: "POST", body: JSON.stringify({ key: p.key }) });
          toast(res.suspended ? "已挂起（释放内存）" : `未挂起：${res.reason}`, !res.suspended);
          void loadProcs();
        };
        td.append(btn);
        const rBtn2 = el("button", "", "重启");
        rBtn2.disabled = p.streaming;
        rBtn2.title = p.streaming ? "运行中不能重启" : "重启该会话进程（重读配置）";
        rBtn2.style.marginLeft = "6px";
        rBtn2.onclick = async () => {
          const res = await api("/api/sessions/restart", { method: "POST", body: JSON.stringify({ key: p.key }) });
          toast(res.restarted ? "已重启，重开会话生效" : `未重启：运行中`, !res.restarted);
          void loadProcs();
        };
        td.append(rBtn2);
        tr.append(td);
        table.append(tr);
      }
      procBox.append(table);
    } catch (error) {
      procBox.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  };
  void loadProcs();

  // 更新说明卡：CHANGELOG.md 渲染（marked 已在前端）
  const changeCard = el("div", "card");
  changeCard.innerHTML = `<h3>📜 更新说明（当前 v${escapeHtml(system.appVersion || "dev")}）</h3>`;
  const changeBody = el("div", "md-body");
  changeBody.innerHTML = '<p class="hint">加载中…</p>';
  changeCard.append(changeBody);
  panel.append(changeCard);
  api("/api/changelog")
    .then((data) => {
      changeBody.innerHTML = renderMarkdown(data.changelog || "（暂无更新说明）");
    })
    .catch((error) => {
      changeBody.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    });

  body.innerHTML = "";
  body.append(panel);
}

// ---- 密码 ----

function renderSecurityTab(body) {
  const panel = el("div", "panel");
  const card = el("div", "card");
  card.innerHTML = "<h3>修改管理密码</h3>";
  const row1 = el("div", "row");
  const input1 = el("input", "");
  input1.type = "password";
  input1.placeholder = "新密码（至少 6 位）";
  row1.append(el("label", "", "新密码"), input1);
  const row2 = el("div", "row");
  const input2 = el("input", "");
  input2.type = "password";
  input2.placeholder = "再输一次";
  row2.append(el("label", "", "确认"), input2);
  const saveBtn = el("button", "primary", "保存");
  saveBtn.onclick = async () => {
    if (input1.value !== input2.value) return toast("两次输入不一致", true);
    if (input1.value.length < 6) return toast("密码至少 6 位", true);
    await api("/api/password", { method: "POST", body: JSON.stringify({ password: input1.value }) });
    toast("密码已更新");
    input1.value = input2.value = "";
  };
  card.append(row1, row2, saveBtn);
  panel.append(card);
  body.innerHTML = "";
  body.append(panel);
}

// ===== 文件树与文件预览 =====
// 文件树在屏幕右侧独立面板（PiDeck 式）：侧栏右上角 📁 一键开关，
// 项目行 📁 直接以该项目打开；面板内可切项目。懒加载：展开目录才请求，条目会话内缓存；
// 点文件在主区的「文件预览」视图里查看，右树保持打开。
// 只读接口：服务端限读前 1MiB，二进制只报元信息，路径越界拒绝。

$("fs-toggle-btn").addEventListener("click", () => {
  state.fsOpen = !state.fsOpen;
  if (state.fsOpen && !state.projects.some((p) => p.id === state.fsPanelProject)) {
    state.fsPanelProject = (state.projects.find((p) => p.id === state.activeProject?.id) || state.projects[0])?.id || null;
  }
  persistFsState();
  syncFsPanel();
});
$("fs-panel-close").addEventListener("click", () => {
  state.fsOpen = false;
  persistFsState();
  syncFsPanel();
});
$("fs-panel-refresh").addEventListener("click", () => {
  state.fsCache.clear();
  const project = currentFsProject();
  if (project) void renderFs(project);
});
$("fs-sort-btn").addEventListener("click", () => {
  state.fsSort = state.fsSort === "time" ? "name" : "time";
  localStorage.setItem("pnd-fs-sort", state.fsSort);
  syncFsPanel();
  toast(state.fsSort === "time" ? "文件树：时间倒序（新文件置顶）" : "文件树：名称排序");
});
$("fs-panel-project-select").addEventListener("change", (e) => {
  state.fsPanelProject = e.target.value || null;
  state.fsSelectedDir = "";
  persistFsState();
  syncFsPanel();
});

// ---- 上传：流式裸字节 POST（不 base64，大文件友好）；文件夹上传保留内部结构 ----
$("fs-upload-btn").addEventListener("click", () => $("fs-upload-input").click());
$("fs-upload-dir-btn").addEventListener("click", () => $("fs-upload-dir-input").click());
$("fs-upload-input").addEventListener("change", (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
});
$("fs-upload-dir-input").addEventListener("change", (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
});

function joinRel(dir, rel) {
  return dir ? `${dir}/${rel}` : rel;
}

// 多文件上传：3 路并发 + 持久进度卡（计数/进度条/当前文件/失败摘要）+ 可取消。
// 传完/取消后卡片停留 8 秒再隐（有失败则等到点击才隐）。
state.upload = null; // {active, cancelled, total, done, ok, fails:[], current, xhrs:Set}
let uploadCardTimer = null;
let uploadRenderAt = 0;

async function uploadFiles(files) {
  if (state.upload?.active) return toast("已有上传在进行中，请等它完成或先取消", true);
  const project = currentFsProject();
  if (!project) return toast("请先添加项目", true);
  if (!files.length) return;
  clearTimeout(uploadCardTimer);
  const dir = state.fsSelectedDir;
  const job = { active: true, cancelled: false, total: files.length, done: 0, ok: 0, fails: [], current: "", xhrs: new Set() };
  state.upload = job;
  renderUploadProgress();

  const queue = [...files];
  const worker = async () => {
    while (queue.length) {
      if (job.cancelled) return;
      const file = queue.shift();
      const rel = file.webkitRelativePath || file.name;
      job.current = rel;
      renderUploadProgress();
      try {
        await uploadOne(project, dir, file, job);
        job.ok++;
      } catch (error) {
        if (!job.cancelled) job.fails.push(`${rel}: ${error.message}`);
      }
      job.done++;
      renderUploadProgress();
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  job.active = false;
  state.fsCache.clear();
  syncFsPanel();
  renderUploadProgress();
  if (job.cancelled) toast(`已取消：完成 ${job.ok}/${job.total} 个`, true);
  else if (job.fails.length) toast(`上传完成 ${job.ok}/${job.total}，失败 ${job.fails.length} 个`, true);
  else toast(`已上传 ${job.ok} 个文件`);
  // 卡片停留：无失败 8 秒自动收；有失败等点击收（看得到失败原因）
  uploadCardTimer = setTimeout(() => {
    if (!state.upload?.active && !state.upload?.fails.length) {
      state.upload = null;
      renderUploadProgress();
    }
  }, 8000);
}

/** 单文件上传：XHR（fetch 无上传进度事件），返回 Promise。 */
function uploadOne(project, dir, file, job) {
  return new Promise((resolvePromise, reject) => {
    const xhr = new XMLHttpRequest();
    job.xhrs.add(xhr);
    xhr.open("POST", `/api/fs/upload?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(joinRel(dir, file.webkitRelativePath || file.name))}`);
    xhr.setRequestHeader("authorization", `Bearer ${state.token}`);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const now = Date.now();
      if (now - uploadRenderAt > 150) {
        uploadRenderAt = now;
        renderUploadProgress(`${(e.loaded / 1048576).toFixed(1)}/${(e.total / 1048576).toFixed(1)}MB`);
      }
    };
    xhr.onload = () => {
      job.xhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) return resolvePromise();
      try {
        reject(new Error(JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`));
      } catch {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => {
      job.xhrs.delete(xhr);
      reject(new Error("网络错误"));
    };
    xhr.onabort = () => {
      job.xhrs.delete(xhr);
      reject(new Error("已取消"));
    };
    xhr.send(file);
  });
}

$("upload-cancel-btn").addEventListener("click", () => {
  const job = state.upload;
  if (!job?.active) {
    state.upload = null;
    renderUploadProgress();
    return;
  }
  job.cancelled = true;
  for (const xhr of job.xhrs) xhr.abort(); // 在飞的中断；排队的不再取
  renderUploadProgress();
});
$("upload-progress").addEventListener("click", (e) => {
  if (e.target.closest("#upload-cancel-btn")) return;
  if (!state.upload?.active) {
    state.upload = null;
    renderUploadProgress();
  }
});

function renderUploadProgress(extra) {
  const job = state.upload;
  const card = $("upload-progress");
  if (!job) return card.classList.add("hidden");
  card.classList.remove("hidden");
  $("upload-cancel-btn").classList.toggle("hidden", !job.active);
  $("upload-progress-title").textContent = job.active ? (job.cancelled ? "正在取消…" : "⏳ 上传中") : job.cancelled ? "已取消" : "✅ 已完成";
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  $("upload-bar-fill").style.width = `${pct}%`;
  $("upload-progress-text").textContent = `${job.done}/${job.total} 个 · 成功 ${job.ok}${job.fails.length ? ` · 失败 ${job.fails.length}` : ""}${job.active && extra ? ` · ${extra}` : ""}`;
  $("upload-progress-current").textContent = job.active ? truncate(job.current, 70) : job.fails.length ? `失败：${job.fails.slice(0, 2).join("；")}${job.fails.length > 2 ? ` 等 ${job.fails.length} 条` : ""}` : "";
}

function isMobile() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function syncMobileBackdrop() {
  const anyOpen = $("sidebar").classList.contains("open") || (isMobile() && state.fsOpen);
  $("mobile-backdrop").classList.toggle("hidden", !anyOpen);
}

function closeMobileSidebar() {
  if ($("sidebar").classList.contains("open")) {
    $("sidebar").classList.remove("open");
    syncMobileBackdrop();
  }
}

$("mobile-nav-btn").addEventListener("click", () => {
  $("sidebar").classList.toggle("open");
  syncMobileBackdrop();
});
$("mobile-fs-btn").addEventListener("click", () => $("fs-toggle-btn").click());
$("mobile-backdrop").addEventListener("click", () => {
  $("sidebar").classList.remove("open");
  if (isMobile() && state.fsOpen) {
    state.fsOpen = false;
    persistFsState();
    syncFsPanel();
  }
  syncMobileBackdrop();
});

function currentFsProject() {
  return state.projects.find((p) => p.id === state.fsPanelProject) || state.projects.find((p) => p.id === state.activeProject?.id) || state.projects[0] || null;
}

/** 同步面板可见性/项目选择器/树内容（开关、切项目、项目列表变化时调用）。 */
function syncFsPanel() {
  const project = currentFsProject();
  state.fsOpen = state.fsOpen && !!project;
  // 切换面板项目时清空选中/多选（跨项目选中无意义）
  if (state.fsSelected && state.fsSelected.project !== project?.id) {
    state.fsSelected = null;
    state.fsMulti.clear();
  }
  $("fs-panel").classList.toggle("hidden", !state.fsOpen);
  $("fs-toggle-btn").classList.toggle("active", state.fsOpen);
  syncMobileBackdrop();
  if (!state.fsOpen || !project) return;
  state.fsPanelProject = project.id;
  persistFsState();
  const sel = $("fs-panel-project-select");
  sel.innerHTML = state.projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  sel.value = project.id;
  $("fs-sort-btn").textContent = state.fsSort === "time" ? "⏱" : "🔤";
  void renderFs(project);
}

function persistFsState() {
  localStorage.setItem("pnd-fs-open", state.fsOpen ? "1" : "0");
  localStorage.setItem("pnd-fs-panel-project", state.fsPanelProject || "");
  localStorage.setItem("pnd-fs-expanded", JSON.stringify(state.fsExpanded));
}

async function fsEntries(projectId, rel) {
  const sort = state.fsSort === "time" ? "time" : "name";
  const key = `${projectId}:${sort}:${rel}`;
  if (state.fsCache.has(key)) return state.fsCache.get(key);
  const data = await api(`/api/fs/tree?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(rel)}&sort=${sort}`);
  state.fsCache.set(key, data.entries);
  return data.entries;
}

async function renderFsNode(project, rel, depth, container, isCurrent) {
  const entries = await fsEntries(project.id, rel);
  if (!isCurrent()) return; // 等待期间已切换项目/重渲染
  const expandedList = state.fsExpanded[project.id] || [];
  const cutSet = fsClipboardCutSet(project);
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const row = el("div", "fs-row");
    row.style.paddingLeft = `${10 + depth * 14}px`;
    row.dataset.rel = childRel;
    row.dataset.type = entry.type;
    state.fsRowOrder.push({ rel: childRel, type: entry.type });
    applyFsRowSelection(row, project, childRel, cutSet);
    if (entry.type === "dir") {
      const expanded = expandedList.includes(childRel);
      row.append(el("span", `chevron${expanded ? " open" : ""}`, "▶"), el("span", "fs-name", `📁 ${entry.name}`));
      row.onclick = (ev) => {
        handleFsRowClick(ev, project, childRel, "dir");
        const arr = (state.fsExpanded[project.id] ||= []);
        const at = arr.indexOf(childRel);
        if (at >= 0) arr.splice(at, 1);
        else arr.push(childRel);
        persistFsState();
        renderFs(project);
      };
      row.append(makeDeleteButton(project, entry, childRel));
      container.append(row);
      if (expanded) await renderFsNode(project, childRel, depth + 1, container, isCurrent);
    } else {
      row.classList.add("fs-file");
      if (preview && preview.projectId === project.id && preview.rel === childRel) row.classList.add("active");
      const icon = /\.(png|jpe?g|gif|webp|ico|svg)$/i.test(entry.name) ? "🖼" : "📄";
      row.append(el("span", "", icon), el("span", "fs-name", entry.name), el("span", "sub", fmtSize(entry.size)));
      row.title = childRel;
      row.onclick = (ev) => {
        handleFsRowClick(ev, project, childRel, "file");
        // Ctrl/Shift 多选时不打开预览（对齐文件管理器习惯）
        if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey) openFilePreview(project, childRel);
      };
      row.append(makeDeleteButton(project, entry, childRel));
      container.append(row);
    }
  }
}

function applyFsRowSelection(row, project, rel, cutSet) {
  row.classList.toggle("selected", state.fsSelected?.project === project.id && state.fsSelected?.rel === rel);
  row.classList.toggle("multi-selected", state.fsMulti.has(rel));
  row.classList.toggle("cut", !!cutSet?.has(rel));
}

/** 行悬停 ✕：删除文件/目录（确认后真删，不可恢复）。 */
function makeDeleteButton(project, entry, childRel) {
  const del = el("span", "fs-del", "✕");
  del.title = entry.type === "dir" ? "删除目录（整个递归，不可恢复）" : "删除文件（不可恢复）";
  del.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(`删除${entry.type === "dir" ? "目录" : "文件"}「${childRel}」？${entry.type === "dir" ? "（含全部子文件）" : ""}\n不可恢复。`)) return;
    try {
      await api(`/api/fs?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(childRel)}`, { method: "DELETE" });
      toast("已删除");
      state.fsCache.clear();
      if (state.fsSelectedDir === childRel || state.fsSelectedDir.startsWith(`${childRel}/`)) state.fsSelectedDir = "";
      renderFs(project);
    } catch (error) {
      toast(error.message, true);
    }
  };
  return del;
}

async function renderFs(project) {
  const container = $("fs-panel-tree");
  const token = `${project.id}:${Date.now()}`;
  container.dataset.token = token;
  const isCurrent = () => container.dataset.token === token;
  container.innerHTML = "";
  state.fsRowOrder = [];
  try {
    await renderFsNode(project, "", 0, container, isCurrent);
    if (isCurrent() && !container.children.length) container.append(el("div", "hint", "（空目录）"));
  } catch (error) {
    if (isCurrent()) container.append(el("div", "error", `文件树加载失败: ${error.message}`));
  }
}

// ---- 文件预览视图 ----
let preview = null; // {project, rel, data, md}

async function openFilePreview(project, rel, opts = {}) {
  try {
    const data = await api(`/api/fs/file?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(rel)}`);
    const nav = opts.nav || "reset";
    // 已有同文件标签 → 直接激活（不重复开）
    const existing = state.tabs.find((t) => t.projectId === project.id && t.rel === rel);
    if (nav === "reset" && existing) {
      activateTab(existing);
      return;
    }
    // push/jump：导航发生在当前文件标签内部（Chrome 同页导航语义，历史随标签）
    if ((nav === "push" || nav === "jump") && preview && state.tabs.includes(preview)) {
      const tab = preview;
      if (state.noteEdit && !confirm("放弃未保存的修改？")) return;
      state.noteEdit = null;
      tab.rel = rel;
      tab.data = data;
      tab.md = /\.(md|markdown)$/i.test(rel) && state.previewMd;
      const h = tab.history;
      if (nav === "push" && h.stack[h.index] !== rel) {
        h.stack = h.stack.slice(0, h.index + 1);
        h.stack.push(rel);
        h.index++;
        if (h.stack.length > 100) {
          h.stack.shift();
          h.index--;
        }
      } else if (nav === "jump") {
        const i = h.stack.indexOf(rel);
        if (i >= 0) h.index = i;
      }
      persistTabs();
      activateTab(tab);
      return;
    }
    // 新标签（树点击 / 从零打开）
    if (state.noteEdit && preview && !confirm("放弃未保存的修改？")) return;
    state.noteEdit = null;
    const tab = { id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, projectId: project.id, rel, data, md: /\.(md|markdown)$/i.test(rel) && state.previewMd, history: { stack: [rel], index: 0 } };
    state.tabs.push(tab);
    if (state.tabs.length > 20) state.tabs.shift(); // 上限保护
    persistTabs();
    activateTab(tab);
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- 视图/标签切换 ----
function showWorkspaceView() {
  $("file-view").classList.add("hidden");
  $("settings-view").classList.add("hidden");
  if (state.activeSession) {
    $("chat-view").classList.remove("hidden");
    $("welcome-view").classList.add("hidden");
  } else {
    $("chat-view").classList.add("hidden");
    $("welcome-view").classList.remove("hidden");
  }
  state.activeTab = "workspace";
  renderTabBar();
}

function activateTab(tab) {
  if (state.activeTab !== "workspace" && preview && preview !== tab && state.noteEdit) {
    if (!confirm("放弃未保存的修改？")) return;
    state.noteEdit = null;
  }
  preview = tab;
  state.activeTab = tab.id;
  $("chat-view").classList.add("hidden");
  $("welcome-view").classList.add("hidden");
  $("settings-view").classList.add("hidden");
  $("file-view").classList.remove("hidden");
  renderFilePreview();
  renderTabBar();
  if (state.fsOpen && currentFsProject()) void renderFs(currentFsProject());
}

function activateWorkspaceTab() {
  showWorkspaceView();
  if (state.fsOpen && currentFsProject()) void renderFs(currentFsProject());
}

function closeTab(tab) {
  const idx = state.tabs.indexOf(tab);
  if (idx < 0) return;
  if (state.noteEdit && preview === tab && !confirm("放弃未保存的修改？")) return;
  if (state.noteEdit && preview === tab) state.noteEdit = null;
  state.tabs.splice(idx, 1);
  persistTabs();
  if (state.activeTab === tab.id) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    if (next) activateTab(next);
    else showWorkspaceView();
  } else {
    renderTabBar();
  }
}

function tabIcon(tab) {
  const n = (tab.data?.name || tab.rel || "").toLowerCase();
  if (/\.(md|markdown)$/.test(n)) return "📝";
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(n)) return "🖼";
  if (/\.pdf$/.test(n)) return "📕";
  if (/\.html?$/.test(n)) return "🌐";
  if (/\.(xlsx|xls|csv)$/.test(n)) return "📊";
  if (/\.(docx?|txt)$/.test(n)) return "📄";
  return "📦";
}

function renderTabBar() {
  const bar = $("tab-bar");
  const showBar = state.tabs.length > 0 && $("settings-view").classList.contains("hidden");
  bar.classList.toggle("hidden", !showBar);
  if (!showBar) return;
  bar.innerHTML = "";
  const wsTab = el("div", `tab-item${state.activeTab === "workspace" ? " active" : ""}`);
  wsTab.append(el("span", "tab-icon", "🏠"), el("span", "tab-label", "工作区"));
  wsTab.onclick = () => activateWorkspaceTab();
  bar.append(wsTab);
  for (const tab of state.tabs) {
    const item = el("div", `tab-item${state.activeTab === tab.id ? " active" : ""}`);
    item.title = tab.rel;
    const close = el("span", "tab-close", "✕");
    close.title = "关闭（或鼠标中键）";
    close.onclick = (e) => {
      e.stopPropagation();
      closeTab(tab);
    };
    item.append(el("span", "tab-icon", tabIcon(tab)), el("span", "tab-label", tab.data?.name || tab.rel.split("/").pop()), close);
    item.onclick = () => activateTab(tab);
    item.onauxclick = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab);
      }
    };
    bar.append(item);
  }
  bar.querySelector(".tab-item.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function persistTabs() {
  try {
    localStorage.setItem("pnd-tabs", JSON.stringify(state.tabs.map((t) => ({ projectId: t.projectId, rel: t.rel, history: t.history }))));
  } catch {
    /* 隐私模式无 localStorage */
  }
}

/** 刷新后恢复标签（逐个重取内容；文件已删的跳过）。 */
async function restoreTabs() {
  if (state.tabsRestored) return;
  state.tabsRestored = true;
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem("pnd-tabs") || "[]");
  } catch {
    return;
  }
  for (const item of saved.slice(0, 20)) {
    const project = state.projects.find((p) => p.id === item.projectId);
    if (!project) continue;
    try {
      const data = await api(`/api/fs/file?project=${encodeURIComponent(item.projectId)}&path=${encodeURIComponent(item.rel)}`);
      state.tabs.push({
        id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        projectId: item.projectId,
        rel: item.rel,
        data,
        md: /\.(md|markdown)$/i.test(item.rel) && state.previewMd,
        history: item.history?.stack?.length ? item.history : { stack: [item.rel], index: 0 },
      });
    } catch {
      /* 文件已删则跳过 */
    }
  }
  if (state.tabs.length) persistTabs();
  renderTabBar();
}

function fsRawUrl() {
  return `/api/fs/raw?project=${encodeURIComponent(preview.projectId)}&path=${encodeURIComponent(preview.data.path)}&token=${encodeURIComponent(state.token)}`;
}

function renderFilePreview() {
  if (!preview) return;
  const { data } = preview;
  $("file-title").textContent = data.path;
  $("file-meta").textContent = fmtSize(data.size);
  const mdBtn = $("file-md-btn");
  const isMd = /\.(md|markdown)$/i.test(data.path);
  mdBtn.classList.toggle("hidden", !isMd);
  mdBtn.classList.toggle("primary", !!preview.md);
  // 笔记导航/编辑按钮（仅 md；历史按钮按可用性置灰）
  $("note-back-btn").classList.toggle("hidden", !isMd);
  $("note-forward-btn").classList.toggle("hidden", !isMd);
  const isEditable = /\.(md|markdown|txt|json)$/i.test(data.path);
  $("note-edit-btn").classList.toggle("hidden", !isEditable);
  const isPdfFile = /\.pdf$/i.test(data.path);
  $("pdf-convert-btn").classList.toggle("hidden", !isPdfFile);
  const isHtmlFile = /\.html?$/i.test(data.path);
  $("html-scripts-btn").classList.toggle("hidden", !isHtmlFile);
  $("html-scripts-btn").textContent = { off: "▶ 脚本", scripts: "☁ 完全", full: "⏹ 关闭" }[preview.htmlTier || "off"];
  $("html-scripts-btn").classList.toggle("primary", (preview.htmlTier || "off") !== "off");
  $("note-back-btn").disabled = (preview.history?.index ?? 0) <= 0;
  $("note-forward-btn").disabled = (preview.history?.index ?? 0) >= (preview.history?.stack?.length ?? 1) - 1;
  const banner = $("file-banner");
  let bannerText = "";
  if (data.kind === "legacy-office") bannerText = "老格式 Office 文件（.doc/.xls/.ppt）无法直接预览，请转存为 .docx/.xlsx/.pptx 再上传";
  else if (/\.pdf$/i.test(data.path)) bannerText = "PDF 预览为浏览器渲染（不耗 token）；给 agent 分析前点右上「⤵MD」先转成文本（服务端提取，成本降一个量级，且缓存复用）";
  else if (/\.html?$/i.test(data.path)) {
    const tier = preview.htmlTier || "off";
    bannerText =
      tier === "full"
        ? "⚠ 完全模式：无沙箱，页面与本站同权（可访问登录态）；仅信任文件使用，点「⏹ 关闭」恢复隔离"
        : tier === "scripts"
          ? "脚本已允许：隔离沙箱 + 存储垫片（拿不到登录态），样式/脚本正常加载；仍不满足时点「☁ 完全」（将放弃隔离）"
          : "HTML 预览：样式已正常加载、脚本禁用；逐级点右上「▶ 脚本」开启";
  }
  else if (data.binary) bannerText = "二进制文件，无法预览";
  else if (data.truncated) bannerText = `文件较大，仅显示前 1MiB（共 ${fmtSize(data.size)}）`;
  banner.textContent = bannerText;
  banner.classList.toggle("hidden", !bannerText);
  const box = $("file-content");
  box.innerHTML = "";
  // 图片/PDF 走 /api/fs/raw 直连渲染（token 走 query；<img>/<iframe> 发不了 Authorization header）
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(data.path)) {
    const img = el("img", "preview-image");
    img.src = fsRawUrl();
    img.alt = data.name;
    box.append(img);
    return;
  }
  if (/\.pdf$/i.test(data.path)) {
    const frame = el("iframe", "embed-frame");
    frame.src = fsRawUrl();
    frame.title = data.name;
    box.append(frame);
    return;
  }
  // HTML 三档预览：禁用（默认）→ 脚本（沙箱+存储垫片）→ 完全（无沙箱，需确认）。
  // 路径式预览路由：相对 css/js/图片自动跟随（query 式 raw 端点做不到，页面会白屏）。
  if (/\.html?$/i.test(data.path)) {
    const frame = el("iframe", "embed-frame");
    const tier = preview.htmlTier || "off";
    if (tier !== "full") frame.setAttribute("sandbox", tier === "scripts" ? "allow-scripts" : "");
    frame.src = previewHtmlUrl(tier);
    frame.title = data.name;
    box.append(frame);
    return;
  }
  if (data.binary || data.kind === "legacy-office") return;
  if (preview.md) {
    const div = el("div", "md-body");
    div.innerHTML = renderNoteMarkdown(data.content);
    enhanceNoteDom(div);
    box.append(div);
    void loadBacklinks(box); // 入链面板异步追加（失败不阻断阅读）
  } else {
    box.append(el("pre", "file-pre", data.content));
  }
}

$("file-close-btn").addEventListener("click", () => {
  if (preview) closeTab(preview); // 关当前标签（Chrome ✕ 语义；内部处理未保存修改确认）
  else showWorkspaceView();
});
$("file-md-btn").addEventListener("click", () => {
  if (!preview) return;
  if (state.noteEdit && !confirm("放弃未保存的修改？")) return;
  state.noteEdit = null;
  preview.md = !preview.md;
  state.previewMd = preview.md;
  localStorage.setItem("pnd-preview-md", preview.md ? "1" : "0");
  renderFilePreview();
});
$("note-back-btn").addEventListener("click", () => {
  const h = preview?.history;
  if (h && h.index > 0) {
    h.index--;
    persistTabs();
    void navigateHistoryTo(h.stack[h.index]);
  }
});
$("note-forward-btn").addEventListener("click", () => {
  const h = preview?.history;
  if (h && h.index < h.stack.length - 1) {
    h.index++;
    persistTabs();
    void navigateHistoryTo(h.stack[h.index]);
  }
});
$("note-edit-btn").addEventListener("click", startNoteEdit);
$("html-scripts-btn").addEventListener("click", () => {
  if (!preview) return;
  const order = ["off", "scripts", "full"];
  const cur = preview.htmlTier || "off";
  const next = order[(order.indexOf(cur) + 1) % 3];
  if (next === "full" && !confirm("完全模式将放弃沙箱隔离：页面脚本可访问本站存储（含登录态）。仅对完全信任的文件使用。继续？")) return;
  preview.htmlTier = next === "off" ? null : next;
  renderFilePreview();
});

// PDF → Markdown：服务端提取（省一个量级 token），完成后直接打开产物
$("pdf-convert-btn").addEventListener("click", async () => {
  if (!preview) return;
  const project = state.projects.find((p) => p.id === preview.projectId);
  if (!project) return;
  try {
    $("pdf-convert-btn").disabled = true;
    const res = await api("/api/fs/convert", { method: "POST", body: JSON.stringify({ project: project.id, path: preview.data.path }) });
    state.fsCache.clear();
    toast(`已${res.cached ? "复用缓存" : "转换"}：${fmtSize(res.chars || 0)} 文本${res.pages ? `（${res.pages}/${res.total} 页，${res.engine}）` : ""}`);
    await openFilePreview(project, res.rel, { nav: "push" });
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("pdf-convert-btn").disabled = false;
  }
});

/** HTML 预览 URL：token 在路径里，相对资源（css/js/图片）自动同前缀。 */
function previewHtmlUrl(tier) {
  const base = `/preview/${encodeURIComponent(state.token)}/${encodeURIComponent(preview.projectId)}/${preview.data.path.split("/").map(encodeURIComponent).join("/")}`;
  return tier === "scripts" ? `${base}?shim=1` : base;
}

// ===== 主题（白天/夜间） =====
function applyThemeIcon() {
  $("theme-btn").textContent = document.documentElement.dataset.theme === "light" ? "🌙" : "🌞";
}
$("theme-btn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("pnd-theme", next);
  } catch {
    /* 隐私模式下无 localStorage */
  }
  applyThemeIcon();
});
applyThemeIcon();

async function navigateHistoryTo(rel) {
  const project = state.projects.find((p) => p.id === preview?.projectId);
  if (project) await openFilePreview(project, rel, { nav: "jump" });
}
$("file-copy-btn").addEventListener("click", async () => {
  if (!preview) return;
  try {
    await navigator.clipboard.writeText(preview.data.content);
    toast("已复制到剪贴板");
  } catch (error) {
    toast(`复制失败: ${error.message}`, true);
  }
});
$("file-download-btn").addEventListener("click", () => {
  if (!preview) return;
  const a = el("a");
  if (preview.data.binary || preview.data.kind === "legacy-office") {
    // 二进制（图片/PDF 等）从 raw 端点拉，token 走 query
    a.href = fsRawUrl();
  } else {
    // 文本内容本地成 blob，避免再请求一次
    a.href = URL.createObjectURL(new Blob([preview.data.content], { type: "text/plain;charset=utf-8" }));
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  a.download = preview.data.name;
  a.click();
});

// ===== Obsidian 式笔记：wiki 链接渲染 + 预览内导航 + 入链 + 编辑 =====
// 独立 marked 实例（不污染聊天区的全局渲染）；[[x|y]] 在解析前转成 pndwiki: 链接，
// renderer.link 覆写成 data-wiki 属性（DOMPurify 默认放行 data-*），点击拦截后应用内导航。
const { Marked } = window.marked;
const noteMarked = new Marked({
  gfm: true,
  renderer: {
    link({ href, title, text }) {
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      if (typeof href === "string" && href.startsWith("pndwiki:")) {
        return `<a data-wiki="${escapeHtml(decodeURIComponent(href.slice(8)))}" href="#"${t}>${text}</a>`;
      }
      return `<a href="${escapeHtml(href || "#")}"${t} rel="noopener">${text}</a>`;
    },
  },
});

/** 围栏代码块内的 [[ ]] 不转换：按 ``` 分段，奇数段是代码块。 */
function preprocessWikiLinks(src) {
  const parts = src.split(/(^```[\s\S]*?^```)/gm);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g, (m, target, alias) => `[${(alias || target).trim()}](pndwiki:${encodeURIComponent(target.trim())})`),
    )
    .join("");
}

function renderNoteMarkdown(text) {
  try {
    return DOMPurify.sanitize(noteMarked.parse(preprocessWikiLinks(text || "")));
  } catch {
    return escapeHtml(text || "");
  }
}

/** 渲染后增强：标题 id（marked v14 不产）、相对图片走 raw 端点。 */
function enhanceNoteDom(root) {
  const seen = new Map();
  root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    let slug = h.textContent.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\w\u4e00-\u9fa5-]/g, "") || "section";
    const n = (seen.get(slug) || 0) + 1;
    seen.set(slug, n);
    if (n > 1) slug = `${slug}-${n}`;
    h.id = slug;
  });
  root.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!/^(https?:|data:|\/)/i.test(src)) {
      img.src = `/api/fs/raw?project=${encodeURIComponent(preview.projectId)}&path=${encodeURIComponent(resolveRelDir(preview.rel, decodeURIComponent(src)))}&token=${encodeURIComponent(state.token)}`;
    }
  });
}

// ---- 链接点击拦截：wiki / 相对 md / 锚点 → 预览内导航；外链新开标签 ----
/** 定位并闪烁目标标题（id 或文本匹配）；找不到返回 false。 */
function scrollToHeading(text) {
  if (!text) return false;
  let decoded = String(text);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* 已是明文 */
  }
  const box = $("file-content");
  const target =
    box.querySelector(`#${CSS.escape(decoded)}`) ||
    [...box.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((h) => h.textContent.trim().toLowerCase() === decoded.toLowerCase());
  if (!target) return false;
  target.scrollIntoView({ block: "start" });
  target.classList.add("flash-heading");
  setTimeout(() => target.classList.remove("flash-heading"), 1600);
  return true;
}

$("file-content").addEventListener("click", async (e) => {
  if (!preview) return;
  // 带 data-wiki 的是 wikilink（渲染时 href="#"），必须排除出锚点分支，否则永远走不到 wiki 导航
  const anchor = e.target.closest("a[href^='#']:not([data-wiki])");
  if (anchor) {
    e.preventDefault();
    scrollToHeading((anchor.getAttribute("href") || "#").slice(1));
    return;
  }
  const a = e.target.closest("a");
  if (!a) return;
  const wiki = a.getAttribute("data-wiki");
  const href = a.getAttribute("href") || "";
  if (wiki !== null) {
    e.preventDefault();
    await navigateNote(wiki);
    return;
  }
  if (/^https?:/i.test(href)) {
    e.preventDefault();
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  // 相对 md 链接：带 #标题 片段时同文件直接滚锚点、跨文件打开后滚（之前片段被丢弃）
  const hashAt = href.indexOf("#");
  const file = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const hash = hashAt >= 0 ? href.slice(hashAt + 1) : "";
  if (file && /\.(md|markdown)$/i.test(decodeURIComponent(file))) {
    e.preventDefault();
    const decodedFile = decodeURIComponent(file);
    const candidate = resolveRelDir(preview.rel, decodedFile);
    if (candidate === preview.rel) {
      if (hash) scrollToHeading(hash);
      return;
    }
    await navigateNote(decodedFile + (hash ? `#${hash}` : ""));
  }
});

async function navigateNote(target) {
  const project = state.projects.find((p) => p.id === preview?.projectId);
  if (!project) return;
  // 分离 #标题 片段（[[文件#标题]] 常见于目录/引用；之前片段被丢弃导致只开文件不定位）
  const hashAt = String(target).indexOf("#");
  const filePart = hashAt >= 0 ? String(target).slice(0, hashAt) : String(target);
  const heading = hashAt >= 0 ? String(target).slice(hashAt + 1) : "";
  const index = await mdIndexFor(project.id);
  let rel = null;
  let ambiguous = 0;
  if (!filePart) rel = preview?.rel || null; // [[#标题]]：当前文件
  else if (/\.(md|markdown)$/i.test(filePart)) {
    // 链接型：先按当前文件目录解析相对路径，再试库内绝对/唯一后缀/basename 兜底
    const candidate = resolveRelDir(preview.rel, filePart);
    const hit = index.find((f) => f.toLowerCase() === candidate.toLowerCase());
    if (hit) rel = hit;
    else ({ rel, ambiguous } = resolveWikiTarget(filePart, index));
  } else {
    ({ rel, ambiguous } = resolveWikiTarget(filePart, index));
  }
  if (!rel) return toast(`找不到笔记：${target}`, true);
  if (ambiguous > 1) toast(`有 ${ambiguous} 个同名笔记，已打开路径最短的：${rel}`, true);
  if (rel === preview?.rel) {
    if (heading) scrollToHeading(heading);
    return;
  }
  await openFilePreview(project, rel, { nav: "push" });
  if (heading) scrollToHeading(heading);
}

async function mdIndexFor(projectId) {
  const cached = state.mdIndexCache.get(projectId);
  if (cached && Date.now() - cached.at < 30_000) return cached.files;
  try {
    const data = await api(`/api/fs/md-index?project=${encodeURIComponent(projectId)}`);
    state.mdIndexCache.set(projectId, { files: data.files || [], at: Date.now() });
    return data.files || [];
  } catch {
    return cached?.files || [];
  }
}

/** Obsidian 式解析：完整路径 → basename → 最短后缀优先（近似唯一后缀规则）。 */// links resolution (resolveWikiTarget/resolveRelDir) lives in web/note-utils.js

async function loadBacklinks(box) {
  if (!preview || !/\.(md|markdown)$/i.test(preview.rel)) return;
  try {
    const data = await api(`/api/fs/backlinks?project=${encodeURIComponent(preview.projectId)}&path=${encodeURIComponent(preview.rel)}`);
    if (!data.links?.length) return;
    const card = el("div", "backlinks-card");
    card.append(el("div", "list-label", `🔗 入链（${data.links.length}${data.truncated ? "+" : ""}）`));
    for (const link of data.links.slice(0, 50)) {
      const item = el("div", "backlink-item");
      item.append(el("div", "name", link.file), el("div", "hint", `第 ${link.line} 行：${link.snippet}`));
      item.onclick = () => {
        const project = state.projects.find((p) => p.id === preview.projectId);
        if (project) void openFilePreview(project, link.file, { nav: "push" });
      };
      card.append(item);
    }
    box.append(card);
  } catch {
    /* 入链失败不阻断阅读 */
  }
}

// ---- 编辑模式：全量拉取（防截断）+ mtime 冲突防护 + [[ 插入选择器 ----
let wikiPickerEl = null;

async function startNoteEdit() {
  if (!preview) return;
  try {
    const full = await api(`/api/fs/file?project=${encodeURIComponent(preview.projectId)}&path=${encodeURIComponent(preview.rel)}&full=1`);
    state.noteEdit = { mtimeMs: full.mtimeMs || null };
    $("note-edit-btn").classList.add("hidden");
    const box = $("file-content");
    box.innerHTML = "";
    const bar = el("div", "note-edit-bar");
    const saveBtn = el("button", "primary", "保存 (Ctrl+S)");
    const cancelBtn = el("button", "", "取消");
    bar.append(saveBtn, cancelBtn, el("span", "hint", "输入 [[ 插入笔记链接"));
    const editor = el("textarea", "note-editor");
    editor.value = full.content || "";
    editor.spellcheck = false;
    box.append(bar, editor);
    saveBtn.onclick = () => void saveNoteEdit();
    cancelBtn.onclick = () => {
      state.noteEdit = null;
      closeWikiPicker();
      renderFilePreview();
    };
    editor.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void saveNoteEdit();
      }
    });
    editor.addEventListener("input", () => void updateWikiPicker(editor));
    editor.addEventListener("blur", () => setTimeout(closeWikiPicker, 150));
    editor.focus();
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveNoteEdit() {
  const editor = $("file-content").querySelector(".note-editor");
  if (!editor || !preview) return;
  try {
    const res = await api("/api/fs/file", {
      method: "PUT",
      body: JSON.stringify({ project: preview.projectId, path: preview.rel, content: editor.value, expectedMtimeMs: state.noteEdit?.mtimeMs ?? null }),
    });
    state.noteEdit = null;
    closeWikiPicker();
    state.fsCache.clear();
    state.mdIndexCache.delete(preview.projectId);
    preview.data.content = editor.value;
    preview.data.size = new TextEncoder().encode(editor.value).length;
    preview.data.mtimeMs = res.mtimeMs;
    preview.data.truncated = false;
    renderFilePreview();
    if (state.fsOpen && currentFsProject()) void renderFs(currentFsProject());
    toast("已保存");
  } catch (error) {
    if (String(error.message || "").includes("被修改过")) {
      if (confirm("文件在打开后被修改过（可能别处正在编辑）。仍要覆盖吗？")) {
        state.noteEdit = { mtimeMs: null }; // 跳过冲突校验再存一次
        return saveNoteEdit();
      }
      return;
    }
    toast(error.message, true);
  }
}

async function updateWikiPicker(editor) {
  if (!preview?.md) return closeWikiPicker(); // [[ 插链仅 md；txt/json 编辑不弹
  const pos = editor.selectionStart;
  const before = editor.value.slice(0, pos);
  const open = before.lastIndexOf("[[");
  if (open < 0 || before.slice(open).includes("]]")) return closeWikiPicker();
  const query = before.slice(open + 2);
  if (/[\n\[\]]/.test(query)) return closeWikiPicker();
  const files = await mdIndexFor(preview.projectId);
  const q = query.toLowerCase();
  const matches = files
    .filter((f) => !q || f.replace(/\.md$/i, "").toLowerCase().includes(q))
    .slice(0, 20);
  if (!matches.length) return closeWikiPicker();
  if (!wikiPickerEl) {
    wikiPickerEl = el("div", "wiki-picker");
    $("file-content").append(wikiPickerEl);
  }
  wikiPickerEl.innerHTML = "";
  wikiPickerEl.classList.remove("hidden");
  for (const f of matches) {
    const item = el("div", "wiki-picker-item", f.replace(/\.md$/i, ""));
    item.onmousedown = (ev) => {
      ev.preventDefault();
      insertWiki(editor, f.replace(/\.md$/i, ""));
      closeWikiPicker();
    };
    wikiPickerEl.append(item);
  }
}

function insertWiki(editor, name) {
  const pos = editor.selectionStart;
  const before = editor.value.slice(0, pos);
  const open = before.lastIndexOf("[[");
  editor.value = `${editor.value.slice(0, open)}[[${name}]]${editor.value.slice(pos)}`;
  const caret = open + name.length + 4;
  editor.setSelectionRange(caret, caret);
  editor.focus();
}

function closeWikiPicker() {
  wikiPickerEl?.classList.add("hidden");
}

// ===== 文件管理器：选中/多选、右键菜单、剪贴板（复制/剪切/粘贴）、内联改名、快捷键 =====

function fsParentRel(rel) {
  const i = rel.lastIndexOf("/");
  return i > 0 ? rel.slice(0, i) : "";
}

function setFsSingleSelection(project, rel, type) {
  state.fsSelected = { project: project.id, rel, type };
  state.fsMulti.clear();
  state.fsAnchor = rel;
}

function toggleFsMulti(project, rel, type) {
  if (state.fsMulti.has(rel)) state.fsMulti.delete(rel);
  else state.fsMulti.add(rel);
  state.fsSelected = { project: project.id, rel, type };
}

function rangeFsSelect(project, rel, type) {
  const order = state.fsRowOrder;
  const anchorRel = state.fsAnchor || state.fsSelected?.rel;
  const anchorIdx = order.findIndex((r) => r.rel === anchorRel);
  const targetIdx = order.findIndex((r) => r.rel === rel);
  if (anchorIdx < 0 || targetIdx < 0) return setFsSingleSelection(project, rel, type);
  const [a, b] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
  state.fsMulti.clear();
  for (let i = a; i <= b; i++) {
    const it = order[i];
    if (it.rel !== state.fsSelected?.rel) state.fsMulti.add(it.rel);
  }
  state.fsSelected = { project: project.id, rel, type };
}

function handleFsRowClick(ev, project, rel, type) {
  if (ev.ctrlKey || ev.metaKey) toggleFsMulti(project, rel, type);
  else if (ev.shiftKey) rangeFsSelect(project, rel, type);
  else setFsSingleSelection(project, rel, type);
  // 上传目标 = 选中的目录；选中文件则取其所在目录
  if (state.fsSelected?.project === project.id) {
    state.fsSelectedDir = state.fsSelected.type === "dir" ? state.fsSelected.rel : fsParentRel(state.fsSelected.rel);
  }
}

function fsSelectionItems() {
  const items = [];
  if (state.fsSelected) items.push({ rel: state.fsSelected.rel, type: state.fsSelected.type });
  for (const [rel, type] of state.fsMulti) if (!items.some((it) => it.rel === rel)) items.push({ rel, type });
  return items;
}

function fsClipboardCutSet(project) {
  const clip = state.fsClipboard;
  if (!clip || clip.mode !== "cut" || clip.project !== project.id) return null;
  return new Set(clip.items.map((it) => it.rel));
}

function fsClipboardDropPrefixes(prefixes) {
  const clip = state.fsClipboard;
  if (!clip) return;
  clip.items = clip.items.filter((it) => !prefixes.some((p) => it.rel === p || it.rel.startsWith(p + "/")));
  if (!clip.items.length) state.fsClipboard = null;
}

function fsCopyCut(project, mode) {
  const items = fsSelectionItems();
  if (!items.length) return;
  state.fsClipboard = { mode, project: project.id, items: items.map((it) => ({ rel: it.rel, type: it.type })) };
  toast(`${mode === "cut" ? "✂️ 剪切" : "📋 复制"} ${items.length} 项${mode === "cut" ? "（选目标后 Ctrl+V 或右键粘贴）" : ""}`);
  void renderFs(project);
}

/** 粘贴：逐项传输；重名自动加 (1)/(2) 后缀（Windows 习惯）；剪切成功后清剪贴板。 */
async function fsPasteInto(project, targetDir) {
  const clip = state.fsClipboard;
  if (!clip?.items?.length) return;
  let ok = 0;
  const fails = [];
  for (const it of clip.items) {
    const base = it.rel.split("/").pop();
    let toRel = targetDir ? `${targetDir}/${base}` : base;
    if (clip.mode === "cut" && clip.project === project.id && it.rel === toRel) {
      ok++; // 剪切到原位：no-op
      continue;
    }
    let attempt = 0;
    for (;;) {
      try {
        await api(`/api/fs/${clip.mode === "cut" ? "move" : "copy"}`, {
          method: "POST",
          body: JSON.stringify({ fromProject: clip.project, fromPath: it.rel, toProject: project.id, toPath: toRel }),
        });
        ok++;
        break;
      } catch (error) {
        const msg = String(error.message || "");
        if (msg.includes("已存在") && attempt < 20) {
          attempt++;
          const dot = base.lastIndexOf(".");
          const stem = dot > 0 ? base.slice(0, dot) : base;
          const ext = dot > 0 ? base.slice(dot) : "";
          toRel = (targetDir ? `${targetDir}/` : "") + `${stem} (${attempt})${ext}`;
          continue;
        }
        fails.push(`${base}: ${msg}`);
        break;
      }
    }
  }
  if (clip.mode === "cut") state.fsClipboard = null;
  state.fsCache.clear();
  state.mdIndexCache.delete(project.id);
  syncFsPanel();
  if (fails.length) toast(`完成 ${ok}/${clip.items.length}，失败：${fails[0]}`, true);
  else toast(`${clip.mode === "cut" ? "已移动" : "已粘贴"} ${ok} 项`);
}

async function fsDeleteSelection(project) {
  const items = fsSelectionItems();
  if (!items.length) return;
  const label = items.length > 1 ? `${items.length} 项（目录将整目录删除）` : `「${items[0].rel}」`;
  if (!confirm(`删除 ${label}？不可恢复。`)) return;
  let ok = 0;
  const fails = [];
  for (const it of items) {
    try {
      await api(`/api/fs?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(it.rel)}`, { method: "DELETE" });
      ok++;
    } catch (error) {
      fails.push(`${it.rel}: ${error.message}`);
    }
  }
  state.fsSelected = null;
  state.fsMulti.clear();
  state.fsSelectedDir = "";
  fsClipboardDropPrefixes(items.map((it) => it.rel));
  if (preview && items.some((it) => preview.rel === it.rel || preview.rel.startsWith(it.rel + "/"))) {
    $("file-close-btn").click(); // 打开中的文件被删：关闭预览
  }
  state.fsCache.clear();
  syncFsPanel();
  if (fails.length) toast(`删除 ${ok}/${items.length}，失败：${fails[0]}`, true);
  else toast(`已删除 ${ok} 项`);
}

// ---- 内联改名（Windows 式：行内输入框，Enter 提交 / Esc 取消） ----
function beginInlineRename(project, rel, type) {
  const container = $("fs-panel-tree");
  const row = [...container.querySelectorAll(".fs-row")].find((r) => r.dataset.rel === rel);
  if (!row) return;
  const name = rel.split("/").pop();
  row.classList.add("renaming");
  const input = el("input", "fs-rename-input");
  input.value = name;
  row.append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    input.remove();
    if (!commit || !newName || newName === name) return void renderFs(project);
    try {
      const res = await api("/api/fs/rename", { method: "POST", body: JSON.stringify({ project: project.id, path: rel, newName }) });
      toast("已重命名");
      renameSideEffects(project, rel, res.path, type);
      state.fsCache.clear();
      syncFsPanel();
    } catch (error) {
      toast(error.message, true);
      renderFs(project);
    }
  };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
    ev.stopPropagation();
  };
  input.onblur = () => finish(true);
}

/** 改名后同步：打开中的预览、浏览历史、剪贴板项、选中态。 */
function renameSideEffects(project, oldRel, newRel, type) {
  state.fsSelected = null;
  state.fsMulti.clear();
  state.fsSelectedDir = "";
  if (preview && preview.projectId === project.id && preview.rel === oldRel) {
    preview.rel = newRel;
    preview.data.path = newRel;
    preview.data.name = newRel.split("/").pop();
    renderFilePreview();
  }
  // 标签内浏览历史同步改名（含子路径前缀映射）
  for (const t of state.tabs) {
    if (t.projectId !== project.id) continue;
    t.history.stack = t.history.stack.map((p) => (p === oldRel ? newRel : p.startsWith(oldRel + "/") ? newRel + p.slice(oldRel.length) : p));
  }
  persistTabs();
  const clip = state.fsClipboard;
  if (clip?.project === project.id) {
    clip.items = clip.items.map((it) => ({ ...it, rel: it.rel === oldRel ? newRel : it.rel.startsWith(oldRel + "/") ? newRel + it.rel.slice(oldRel.length) : it.rel }));
  }
  state.mdIndexCache.delete(project.id);
  void type;
}

async function fsNewFolder(project, dirRel) {
  const name = prompt("新文件夹名称：", "新建文件夹");
  if (!name?.trim()) return;
  try {
    await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ project: project.id, dirPath: dirRel, name: name.trim() }) });
    toast("已创建文件夹");
    state.fsCache.clear();
    syncFsPanel();
  } catch (error) {
    toast(error.message, true);
  }
}

async function fsNewFile(project, dirRel) {
  const name = prompt("新文件名（.md / .txt）：", "新笔记.md");
  if (!name?.trim()) return;
  const rel = dirRel ? `${dirRel}/${name.trim()}` : name.trim();
  try {
    await api("/api/fs/file", { method: "PUT", body: JSON.stringify({ project: project.id, path: rel, content: "" }) });
    toast("已创建文件");
    state.fsCache.clear();
    syncFsPanel();
    openFilePreview(project, rel);
  } catch (error) {
    toast(error.message, true);
  }
}

function fsDownloadEntry(project, rel) {
  const a = el("a");
  a.href = `/api/fs/raw?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(rel)}&token=${encodeURIComponent(state.token)}`;
  a.download = rel.split("/").pop();
  a.click();
}

// ---- 自绘右键菜单（桌面右键 / 移动端长按均触发 contextmenu） ----
function showFsContextMenu(x, y, items) {
  closeFsContextMenu();
  const menu = el("div", "fs-context-menu");
  for (const it of items) {
    if (it === "-") {
      menu.append(el("div", "fs-menu-sep"));
      continue;
    }
    const mi = el("div", "fs-menu-item", `${it.icon || ""} ${it.label}`);
    mi.onclick = () => {
      closeFsContextMenu();
      it.action();
    };
    menu.append(mi);
  }
  document.body.append(menu);
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
}

function closeFsContextMenu() {
  document.querySelector(".fs-context-menu")?.remove();
}

function fsMenuRow(e, project, rel, type) {
  const clip = state.fsClipboard;
  const count = fsSelectionItems().length;
  const pasteTarget = type === "dir" ? rel : fsParentRel(rel);
  const items = [];
  if (type === "file") items.push({ icon: "📂", label: "打开", action: () => openFilePreview(project, rel) });
  items.push({ icon: "✏️", label: "重命名", action: () => beginInlineRename(project, rel, type) });
  items.push({ icon: "📋", label: count > 1 ? `复制 ${count} 项` : "复制", action: () => fsCopyCut(project, "copy") });
  items.push({ icon: "✂️", label: count > 1 ? `剪切 ${count} 项` : "剪切", action: () => fsCopyCut(project, "cut") });
  if (clip) items.push({ icon: "📄", label: `粘贴到此${type === "dir" ? "目录" : "上级"}（${clip.items.length} 项）`, action: () => void fsPasteInto(project, pasteTarget) });
  items.push("-");
  items.push({
    icon: "⬆️",
    label: "上传到此",
    action: () => {
      state.fsSelectedDir = pasteTarget;
      persistFsState();
      void renderFs(project);
      $("fs-upload-input").click();
    },
  });
  if (type === "file") items.push({ icon: "⬇️", label: "下载", action: () => fsDownloadEntry(project, rel) });
  items.push({ icon: "📁", label: "新建文件夹", action: () => void fsNewFolder(project, pasteTarget) });
  items.push({ icon: "📝", label: "新建文件", action: () => void fsNewFile(project, pasteTarget) });
  items.push("-");
  items.push({ icon: "🗑", label: count > 1 ? `删除 ${count} 项` : "删除", action: () => void fsDeleteSelection(project) });
  showFsContextMenu(e.clientX, e.clientY, items);
}

function fsMenuBackground(e, project) {
  const clip = state.fsClipboard;
  const target = state.fsSelectedDir || "";
  const items = [];
  if (clip) items.push({ icon: "📄", label: `粘贴到${target ? "选中目录" : "根目录"}（${clip.items.length} 项）`, action: () => void fsPasteInto(project, target) });
  items.push({ icon: "📁", label: "新建文件夹", action: () => void fsNewFolder(project, target) });
  items.push({ icon: "📝", label: "新建文件", action: () => void fsNewFile(project, target) });
  items.push({ icon: "⬆️", label: "上传到此处", action: () => $("fs-upload-input").click() });
  showFsContextMenu(e.clientX, e.clientY, items);
}

$("fs-panel-tree").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const project = currentFsProject();
  if (!project) return;
  const row = e.target.closest(".fs-row");
  if (!row || !row.dataset.rel) return fsMenuBackground(e, project);
  const rel = row.dataset.rel;
  const type = row.dataset.type;
  const selected = (state.fsSelected?.project === project.id && state.fsSelected.rel === rel) || state.fsMulti.has(rel);
  if (!selected) {
    setFsSingleSelection(project, rel, type);
    if (state.fsSelected.type === "dir" || type === "file") state.fsSelectedDir = type === "dir" ? rel : fsParentRel(rel);
    void renderFs(project);
  }
  // 等选中态重渲染后再弹菜单（菜单文案依赖选择数量）
  setTimeout(() => fsMenuRow(e, project, rel, type), 0);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".fs-context-menu")) closeFsContextMenu();
});

// ---- 键盘快捷键（文件树面板上下文；输入框/编辑器聚焦时不动） ----
document.addEventListener("keydown", (e) => {
  if (!state.fsOpen) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || state.noteEdit) return;
  if (!state.fsSelected || state.fsSelected.project !== currentFsProject()?.id) return;
  const project = currentFsProject();
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === "Delete") {
    e.preventDefault();
    void fsDeleteSelection(project);
  } else if (e.key === "F2" && fsSelectionItems().length === 1) {
    e.preventDefault();
    beginInlineRename(project, state.fsSelected.rel, state.fsSelected.type);
  } else if (mod && key === "c") {
    e.preventDefault();
    fsCopyCut(project, "copy");
  } else if (mod && key === "x") {
    e.preventDefault();
    fsCopyCut(project, "cut");
  } else if (mod && key === "v") {
    e.preventDefault();
    void fsPasteInto(project, state.fsSelectedDir || "");
  }
});

// ===== Ctrl+K 全局搜索面板（会话内容 + 文件名） =====
// 比侧栏搜索强的地方：一个入口两类结果，键盘驱动（↑↓/Enter/Esc），不占侧栏空间。
state.palette = { items: [], index: 0, timer: null };

function openPalette() {
  $("palette").classList.remove("hidden");
  const input = $("palette-input");
  input.value = "";
  input.focus();
  state.palette.items = [];
  state.palette.index = 0;
  $("palette-results").innerHTML = '<div class="hint">输入关键词：会话标题/内容与当前项目文件名</div>';
}

function closePalette() {
  $("palette").classList.add("hidden");
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("palette").classList.contains("hidden") ? openPalette() : closePalette();
  } else if (e.key === "Escape" && !$("palette").classList.contains("hidden")) {
    closePalette();
  }
});

$("palette").addEventListener("click", (e) => {
  if (e.target.id === "palette") closePalette();
});

$("palette-input").addEventListener("input", () => {
  clearTimeout(state.palette.timer);
  const q = $("palette-input").value.trim();
  if (q.length < 2) {
    $("palette-results").innerHTML = '<div class="hint">至少输入 2 个字符</div>';
    state.palette.items = [];
    return;
  }
  state.palette.timer = setTimeout(() => void runPaletteSearch(q), 300);
});

$("palette-input").addEventListener("keydown", (e) => {
  const items = state.palette.items;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!items.length) return;
    state.palette.index = (state.palette.index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    renderPaletteResults();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = items[state.palette.index];
    if (item) {
      closePalette();
      item.run();
    }
  }
});

async function runPaletteSearch(q) {
  const box = $("palette-results");
  box.innerHTML = '<div class="hint">搜索中…</div>';
  const project = state.activeProject || state.projects[0];
  const [sessionsRes, filesRes] = await Promise.allSettled([
    api(`/api/search?q=${encodeURIComponent(q)}${state.showArchived ? "&archived=1" : ""}`),
    project ? api(`/api/fs/search?project=${encodeURIComponent(project.id)}&q=${encodeURIComponent(q)}`) : Promise.resolve({ files: [] }),
  ]);
  const items = [];
  const sessHits = sessionsRes.status === "fulfilled" ? sessionsRes.value.results || [] : [];
  for (const hit of sessHits.slice(0, 12)) {
    items.push({
      kind: "会话",
      title: hit.sessionName || "（无标题会话）",
      sub: `${hit.projectName} · ${hit.snippet || ""}`.slice(0, 130),
      run: () => openSearchHit(hit, q),
    });
  }
  const fileHits = filesRes.status === "fulfilled" ? filesRes.value.files || [] : [];
  for (const f of fileHits.slice(0, 20)) {
    items.push({ kind: "文件", title: f.name, sub: f.path, run: () => { const p = state.projects.find((x) => x.id === project.id); if (p) void openFilePreview(p, f.path); } });
  }
  state.palette.items = items;
  state.palette.index = 0;
  if (!items.length) box.innerHTML = '<div class="hint">没有匹配的会话或文件</div>';
  else renderPaletteResults();
}

function renderPaletteResults() {
  const box = $("palette-results");
  box.innerHTML = "";
  state.palette.items.forEach((item, i) => {
    const row = el("div", `palette-item${i === state.palette.index ? " active" : ""}`);
    row.append(el("span", "pi-kind", item.kind), el("span", "pi-title", item.title), el("span", "pi-sub", item.sub));
    row.onclick = () => {
      closePalette();
      item.run();
    };
    box.append(row);
  });
  box.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
}

// ===== 终端（容器内 bash；无 PTY） =====
// WS 消息：term-open / term-input / term-signal / term-close ↔ term-output
state.term = { opened: false, history: [], histIdx: -1 };

function stripAnsi(s) {
  // 去常见 SGR/控制序列（无 PTY 也偶有色码）
  return s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

function termAppend(text, kind) {
  const box = $("term-output");
  const span = el("span", kind === "err" ? "term-err" : kind === "sys" ? "term-sys" : "term-out");
  span.textContent = stripAnsi(text);
  box.append(span);
  box.scrollTop = box.scrollHeight;
}

function openTermView() {
  $("chat-view").classList.add("hidden");
  $("welcome-view").classList.add("hidden");
  $("settings-view").classList.add("hidden");
  $("file-view").classList.add("hidden");
  $("term-view").classList.remove("hidden");
  $("term-cwd").textContent = state.projects.length ? "工作区" : "";
  if (!state.term.opened) {
    state.term.opened = true;
    if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: "term-open" }));
    else termAppend("连接未就绪，请稍候重试…\n", "sys");
  }
  setTimeout(() => $("term-input").focus(), 50);
}

$("term-btn").addEventListener("click", openTermView);
$("term-close-btn").addEventListener("click", () => {
  $("term-view").classList.add("hidden");
  showWorkspaceView();
});
$("term-clear-btn").addEventListener("click", () => ($("term-output").innerHTML = ""));
$("term-restart-btn").addEventListener("click", () => {
  state.ws?.send(JSON.stringify({ type: "term-close" }));
  setTimeout(() => {
    state.ws?.send(JSON.stringify({ type: "term-open" }));
    termAppend("[已重启 shell]\n", "sys");
  }, 200);
});

$("term-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("term-input");
  const cmd = input.value;
  if (!cmd.trim()) return;
  state.term.history.push(cmd);
  state.term.histIdx = state.term.history.length;
  termAppend(`$ ${cmd}\n`, "sys");
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: "term-input", text: cmd }));
  input.value = "";
});

$("term-input").addEventListener("keydown", (e) => {
  const h = state.term.history;
  if (e.key === "ArrowUp" && h.length) {
    e.preventDefault();
    state.term.histIdx = Math.max(0, (state.term.histIdx < 0 ? h.length : state.term.histIdx) - 1);
    $("term-input").value = h[state.term.histIdx] || "";
  } else if (e.key === "ArrowDown" && h.length) {
    e.preventDefault();
    state.term.histIdx = Math.min(h.length, state.term.histIdx + 1);
    $("term-input").value = h[state.term.histIdx] || "";
  } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
    e.preventDefault();
    state.ws?.send(JSON.stringify({ type: "term-signal" }));
    termAppend("^C\n", "sys");
  }
});

// ===== 会话搜索 =====
// 侧栏顶部搜索框：防抖 400ms、关键词 ≥2 字符；点击结果打开会话，
// 命中的第一条消息滚动居中高亮（内容匹配定位，不依赖消息序号）。
let searchTimer = null;

$("search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("search-input").value.trim();
  if (q.length < 2) {
    $("search-results").classList.add("hidden");
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 400);
});
$("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("search-results").classList.add("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-box")) $("search-results").classList.add("hidden");
});

async function runSearch(q) {
  const box = $("search-results");
  box.innerHTML = '<div class="hint">搜索中…</div>';
  box.classList.remove("hidden");
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}${state.showArchived ? "&archived=1" : ""}`);
    box.innerHTML = "";
    if (!data.results.length) {
      box.append(el("div", "hint", "没有匹配的会话"));
      return;
    }
    for (const hit of data.results) {
      const item = el("div", "search-item");
      const title = el("div", "name", hit.sessionName || "（无标题会话）");
      const kindLabel = hit.kind === "session" ? " · 标题命中" : hit.role === "user" ? " · 👤" : " · 🤖";
      const meta = el("div", "sub", `${hit.projectName} · ${new Date(hit.sessionTimestamp).toLocaleString()}${kindLabel}`);
      const snippet = el("div", "search-snippet");
      snippet.innerHTML = highlightSnippet(hit.snippet, q);
      item.append(title, meta, snippet);
      item.onclick = () => {
        box.classList.add("hidden");
        $("search-input").value = "";
        openSearchHit(hit, q);
      };
      box.append(item);
    }
    if (data.truncated) box.append(el("div", "hint", `已达扫描上限（${data.filesScanned} 个会话），结果可能不全`));
  } catch (error) {
    box.innerHTML = "";
    box.append(el("div", "error", error.message));
  }
}

function highlightSnippet(snippet, q) {
  const at = snippet.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return escapeHtml(snippet);
  return `${escapeHtml(snippet.slice(0, at))}<mark>${escapeHtml(snippet.slice(at, at + q.length))}</mark>${escapeHtml(snippet.slice(at + q.length))}`;
}

async function openSearchHit(hit, q) {
  const project = state.projects.find((p) => p.id === hit.projectId);
  if (!project) return toast("项目不存在（可能已删除）", true);
  state.highlightQuery = q;
  await attachSession(project, { sessionFile: hit.sessionFile, id: hit.sessionId, name: hit.sessionName });
}

// ===== 工具 =====
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}
function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
function scrollBottom() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

// ===== 启动 =====
function boot() {
  $("main-view").classList.remove("hidden");
  connectWs();
  loadProjects();
  void restoreTabs(); // 刷新后恢复上次的文件标签（逐个重取，已删文件跳过）
  // 侧栏底部显示版本号（升级后核对：版本没变 = 升级没生效）
  api("/api/system")
    .then((s) => {
      $("app-version").textContent = `v${s.appVersion || "dev"}${s.appBuildDate && s.appBuildDate !== "unknown" ? ` · ${s.appBuildDate}` : ""}`;
    })
    .catch(() => {});
}

window.addEventListener("storage", () => {
  state.token = localStorage.getItem("pnd-token") || "";
});

tryBoot();
