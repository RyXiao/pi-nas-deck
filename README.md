# PiNasDeck 🥧

**跑在 NAS Docker 里的 pi Agent Web 工作台** —— 多项目、流式聊天、AI API 管理、微信即聊即用。

PiDeck（桌面版）的 Web 移植思路：后端为每个会话 spawn 一个 `pi --mode rpc` 子进程（与 PiDeck 架构一致），
前端为浏览器 SPA。pi 的 Agent 能力、会话文件、模型配置全部由 pi 原生提供，本程序只做壳。

微信 iLink 接入移植自 [PiDeck](https://github.com/ayuayue/PiDeck)（MIT 协议）的 `src/main/wechat` 模块，
走腾讯官方 iLink（ClawBot）通道，扫码绑定，无 hook 无注入。

## 功能

- ✅ **多项目工作区**：挂载的目录任意添加为项目，会话按项目隔离（树形分组、箭头展开/收起）
- ✅ **文件树 + 文件管理**：屏幕右侧常驻树形面板（PiDeck 式，侧栏右上角 📁 一键开关，项目行 📁 直接以该项目打开，面板内可切项目），懒加载，点文件主区就地预览（Markdown 渲染、图片/PDF 直连渲染、**HTML 沙箱渲染**、docx 提取正文、老格式提示转新格式；限读前 1MiB、二进制/截断提示、可复制下载）；支持上传文件/文件夹（流式，单文件 ≤500MB，目录自动创建，3 路并发 + 右下角进度卡：计数/进度条/当前文件/失败摘要，可随时取消且不留半截文件）与删除文件/目录（悬停 ✕，递归删需确认）；**Windows 式管理**：右键菜单、内联改名（F2）、多选批量删/复制/剪切/粘贴（Ctrl/Shift 点选）、快捷键（Del/Ctrl+C/X/V）、剪贴板粘贴（重名自动加后缀、跨项目粘贴、剪切项半透明）、新建文件/文件夹；复制/移动有递归炸弹与预算护栏（≤2GB/20000 文件）；NAS 文件管理器看不到容器内文件时用它管
- ✅ **内置 pi 1.5.0**：镜像显式锁定 pi@1.5.0（RPC 与扩展 UI 协议已冒烟验证），构建可 `--build-arg PI_VERSION=` 覆盖
- ✅ **本轮产出文件**：每轮回答下方自动列出该轮新增/修改的文件（含脚本产出），点击直接打开
- ✅ **选择题**：模型可通过 `ask_user_choice` 向你出选择题（pi 1.5 原生 extension_ui 协议），聊天里点按钮作答；也支持确认/输入对话卡
- ✅ **多会话编排可视化**：模型调 pi-subagents 的 subagent 工具时，聊天里显示子代理卡片（名/任务/状态/实时输出）
- ✅ **Ctrl+K 全局搜索**：一个入口搜会话（标题+内容）与当前项目文件名，键盘驱动
- ✅ **内存治理**：进程池并发上限（默认 4，超限按 LRU 自动挂起，流式不打断），系统页可看/手动挂起
- ✅ **用量成本换算**：按 models.json 的 cost 算每天/每月花费（未配价明确标注，不偷算 0）
- ✅ **Obsidian 式笔记**：md 预览内 `[[笔记]]`/`[[目标|别名]]`/相对链接全部可点、预览内导航（后退/前进历史）、标题锚点、底部自动入链面板；✎ 编辑（全量拉取防截断、Ctrl+S 原子保存、mtime 冲突防护、`[[` 弹笔记搜索选择器插链）；右树高亮当前文件
- ✅ **PDF 省 token 管线**：预览页一键「⤵MD」服务端转文本（pdfplumber/pypdf，缓存复用）；微信收到 PDF 自动先转再给 agent——不再按页截图耗视觉 token
- ✅ **定时任务（日报）**：设置 → ⏰ 定时——每天/每 N 分钟在指定项目开新会话执行提示词，产出自动存为项目内 Markdown
- ✅ **文件树时间倒序**：面板 🔤/⏱ 切换，新文件/新日报自动置顶
- ✅ **移动端适配**：手机浏览器访问时侧栏/文件树变左右抽屉（左上 ☰ / 右上 📁 浮动按钮唤出，遮罩点击收起，选完会话自动收抽屉），聊天区全宽
- ✅ **会话全文搜索**：侧栏搜索框跨项目搜历史内容（中文子串匹配），点击结果打开会话并高亮命中消息
- ✅ **流式聊天**：Markdown 渲染、工具调用状态、思考过程折叠、停止按钮
- ✅ **附件上传**：图片直接内联给模型看图；任意文件上传后由 agent 读取（📎 按钮 / 拖拽）
- ✅ **模型切换**：会话内下拉框实时切换可用模型（get_available_models / set_model）
- ✅ **命令 / skills 菜单**：输入框敲 `/` 弹出全部命令、prompt 模板与技能，↑↓ 选择、Enter 插入
- ✅ **内置免费搜索**：free-search 扩展随镜像分发（免 API key，web_search/web_fetch），启动自动同步启用
- ✅ **会话管理**：历史恢复、关闭（杀进程保留记录）、归档/恢复、删除；断线重连自动重挂
- ✅ **AI API 管理**：可视化编辑 models.json（OpenAI 兼容 / Anthropic），一键测试连接
- ✅ **用量统计**：设置页按日/月查看 token 用量（× 模型 × 项目，含条形占比图）；数据来自镜像内置的 usage-logger 扩展（发第一条消息即开始记录，也兼容第三方 pi-tracker 的历史记录）
- ✅ **MCP 管理**：设置页增删/启停 MCP 服务器（HTTP 远程 / stdio 命令行），直接读写 pi 的 mcp.json；对话框 🔌 按钮一键引用
- ✅ **Skills 管理**：设置页新建/编辑/删除 SKILL.md（列表带描述与大小）；对话框 ⚡ 按钮一键插入 /skill 命令
- ✅ **微信接入**：两个微信号分别扫码绑定（两只手机），各自独立会话与账号默认项目；支持发文件（doc/xlsx/pptx/pdf）给 agent 分析/修改，成品文件自动发回微信；文本私聊
- ✅ **pi 在线更新**：设置页一键升级 pi CLI，不用重建镜像
- ✅ **登录认证**：单用户密码 + 30 天 token

## 快速开始（本地开发）

前提：Node.js ≥ 20。不需要 Docker；若要测聊天，本机需已装 pi CLI
（`npm i -g @earendil-works/pi-coding-agent`）并配好模型。

```bash
# 在项目根目录（macOS / Linux / Git Bash）
cd server && npm install && cd ..
mkdir -p test-workspace/demo-project && echo hi > test-workspace/demo-project/README.md

DATA_DIR=$PWD/test-data \
SESSION_DIR=$PWD/test-data/sessions \
PI_AGENT_DIR=$PWD/test-data/.pi/agent \
WORKSPACE_ROOT=$PWD/test-workspace \
node server/index.js
# 打开 http://localhost:8080，密码看启动日志或 INITIAL_PASSWORD 环境变量
```

PowerShell 等价写法：

```powershell
cd server; npm install; cd ..
$env:DATA_DIR="$PWD\test-data"; $env:SESSION_DIR="$PWD\test-data\sessions"
$env:PI_AGENT_DIR="$PWD\test-data\.pi\agent"; $env:WORKSPACE_ROOT="$PWD\test-workspace"
node server\index.js
```

说明：数据全部隔离在 `test-data/`，不碰本机 `~/.pi/agent` 的真实配置；
`PI_AGENT_DIR` 用 `.../.pi/agent` 标准结构时服务端会自动派生 HOME 给 pi 子进程。

## 打部署包（给 NAS 升级用）

```bash
# 在项目根目录（包名 = 版本号 + 当日日期，版本取自 server/package.json）
VER=$(node -p "require('./server/package.json').version")
DATE=$(date +%Y%m%d)
tar -czf pi-nas-deck-v${VER}-${DATE}.tar.gz \
  --exclude='server/node_modules' --exclude='test-data' --exclude='test-workspace' \
  Dockerfile docker-compose.yml upgrade.sh README.md AGENTS.md CHANGELOG.md docs server tests web extensions
```

NAS 侧升级：把包传到 NAS 的 docker 共享文件夹，然后（见 docs/DEPLOY.md「升级新版本」）：

```bash
tar -xzf /volume1/docker/pi-nas-deck-deploy.tar.gz -C /tmp upgrade.sh
sudo bash /tmp/upgrade.sh /volume1/docker/pi-nas-deck-deploy.tar.gz
# 部署目录自动探测（读运行中容器的 compose 标签）；探不到时把目录作为第 2 参数传入
```

## 部署

见 [docs/DEPLOY.md](docs/DEPLOY.md)（绿联 NAS UGOS Pro 完整步骤）。

## 架构

```
浏览器 SPA (web/)
   │ HTTP API + WebSocket
   ▼
Node 服务端 (server/index.js)
   ├─ SessionManager：项目 CRUD、会话扫描、空闲进程回收、会话全文搜索
   ├─ pi 进程池：每会话一个 `pi --mode rpc --approve` 子进程（JSONL stdio）
   ├─ models.json 管理 / 连接测试 / pi 在线更新
   └─ WeChatBridge：iLink 长轮询收信 → 绑定会话 → prompt → 回信
```

## 数据布局（容器内）

| 路径 | 内容 |
|---|---|
| `/data/auth.json` | 管理密码哈希、token 密钥 |
| `/data/projects.json` | 项目列表 |
| `/data/wechat.json` | 微信账号、游标、绑定 |
| `/data/.pi/agent/` | pi 的配置（models.json、auth.json、trust.json） |
| `/data/sessions/` | pi 会话文件（JSONL） |
| `/workspace/` | 你的项目目录（挂载） |

## 协议限制（微信）

- 仅私聊；支持文本、文件、图片；不支持群聊、语音、视频
- 不能主动推送：必须用户先发消息（带 context_token 才能回信）
- 会话失效（errcode -14）后需重新扫码，1 小时内不得重试（微信风控要求）
- 文件上限 100MB（CDN 媒体限制）；单轮最多回传 5 个成品文件

## License

MIT。微信 iLink 模块移植自 PiDeck（MIT）。
