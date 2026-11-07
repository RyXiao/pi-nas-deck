# PiNasDeck 开发上下文

跑在 NAS Docker 里的 pi Agent Web 工作台：多项目、流式聊天、附件、模型切换、
命令/skills 菜单、免费联网搜索（free-search 扩展）、微信 iLink 桥接。
前端为无构建步骤的原生 SPA（刻意不引入框架/打包器，保持镜像轻量、ARM 友好）。

## 架构速览

```
浏览器 SPA (web/)  ←HTTP API + WebSocket→  server/index.js
  ├─ lib/sessionManager.js  项目 CRUD、会话扫描（读 jsonl 头部 cwd 归属）、
  │                         进程池（空闲 30min 回收）、归档 meta（session-meta.json）、
  │                         全文搜索（/api/search：流式扫描，≤300 文件/10s 预算，
  │                         每会话 ≤5 命中，按 mtime 倒序）、进程池 LRU 治理
  │                         （PI_MAX_CONCURRENT，默认 4；超限挂起最久未活动，流式不挂）
  ├─ lib/piProcess.js       每会话 spawn 一个 `pi --mode rpc --approve --session-dir`
  │                         JSONL 自实现 LF 分帧（禁用 readline：U+2028 问题）
  ├─ lib/modelsConfig.js    models.json 读写、连接测试、pi 在线更新（npm i -g）
  ├─ lib/usageStats.js      用量聚合：内置 usage-logger 扩展写 analytics/pnd-usage.jsonl
  │                         （优先；防与第三方 pi-tracker 双计，回退 usage.jsonl），
  │                         位置数组 + 恒等式 total=in+out+cache 校验 → 日/月×模型×项目
  ├─ lib/mcpConfig.js       mcp.json 读写（结构校验 + 原子写；改动新会话生效）
  ├─ lib/skillsManager.js   skills/<name>/SKILL.md 增删改查（名字白名单防穿越）
  ├─ lib/scheduler.js       定时任务：daily/interval，产出写回项目 md（纯函数可测）
  ├─ lib/pdfConvert.js      PDF→md：spawn 镜像 venv（PND_PYTHON 可覆盖），侧文件缓存
  ├─ lib/extensions.js      内置扩展同步：/app/extensions → $PI_AGENT_DIR/extensions
  │                         （free-search 搜索、usage-logger 用量、ask-choice 选择题）
  ├─ lib/auth.js            单用户密码 + HMAC token（30 天）
  └─ wechat/                iLink(ClawBot) 协议移植自 PiDeck（MIT）：
      ilinkProtocol/Client  扫码登录、getupdates 长轮询收信、sendmessage 回信、
                            文件/图片 CDN 收发（getuploadurl + AES-128-ECB，ilinkMedia.js）
      bridge.js             双账号槽位（a1/a2，v1 配置自动迁移）、账号内绑定 chat→会话、
                            文件链路（inbox 下载→prompt→out 成品回传）、/new /stop /status
      wechatText.js         Markdown 降级纯文本、1500 字分片
```

## 关键集成事实（踩过的坑，勿回退）

- **HOME 派生**：pi 只认 `$HOME/.pi/agent`。index.js 启动时从 `PI_AGENT_DIR`
  （标准 `.../.pi/agent` 结构）派生 HOME，保证服务端与 pi 读写同一份配置。
- **会话文件延迟创建**：pi 新会话先返回 sessionFile 路径、首次写入才落盘。
  listSessions 为运行中未落盘的进程合成「（新会话，尚未发消息）」条目。
- **进程 key 迁移**：attach 后用 get_state 的 sessionFile 替换 `new:*` 临时 key。
- **斜杠命令必须走 prompt**：follow_up/steer 不接受扩展命令（pi 协议限制）。
- **文件 API（/api/fs/tree、file、upload、rename、mkdir、copy、move、DELETE）**：路径必须落在项目根内
  （`..` 分段直接拒、resolve 后带分隔符比对防前缀兄弟目录、file/upload/delete/move 再加
  realpath 校验防 symlink 逃逸；禁删项目根；copy/move 预算 ≤2GB/20000 文件、
  目录不可移入自身子树，move 优先 rename、EXDEV 降级 copy+rm；PUT file 支持新建 .md/.txt）；上传是流式裸字节（streamToDisk 带背压、
  500MB 上限、tmp+rename 落盘，绕开 JSON body 70MB 限制，在通用路由分发之前拦截）；
  预览限读前 1MiB，首 8KB 含 NUL 判二进制；/api/fs/raw 是图片/PDF 直连流（token 走 query，
  <img>/<iframe> 发不了 header），content-type 白名单；docx 走 lib/docx.js 零依赖 zip 读取
  提取正文（≤50MB，store/deflate 两种条目），.doc/.xls/.ppt 返回 legacy-office 提示转新格式。
  笔记库：/api/fs/md-index（全部 .md 清单，跳过点开头目录，≤5000）、
  /api/fs/backlinks（入链扫描，≤300 文件/10s 预算，行号+摘要）、
  /api/fs/changed-since（轮次产出：turnStart 后新增/修改的文件，≤20000 文件/3s 预算）、PUT /api/fs/file
  （.md/.txt/.json 保存：原子写 + expectedMtimeMs 冲突防护 409；编辑模式 full=1
  全量读 ≤10MiB 防截断）。
  归档/搜索的 jsonl 扫描同样用 LF 分帧流式读
  （同 piProcess 的理由：勿用 readline，U+2028 会截断 JSON 字符串）；_readHeader 只 fd 限读 64KB。
- **图片走 prompt.images 字段**（base64 内联，不落盘）；其他文件上传到
  /data/uploads 后把绝对路径附在消息文本里让 agent read。
- **微信 iLink**：context_token 回信（不能主动推送）、run_id 必带、errcode -14
  需暂停 1 小时重扫、get_qrcode_status 是长轮询（超时=没变化，继续等）。
  配置 v2：`{version:2, enabled, defaultProjectId, accounts:[{id:a1|a2, 凭据, cursor,
  defaultProjectId, bindings}]}`；v1 单账号配置启动时自动迁移为 a1；绑定与默认项目
  归属账号，退出登录只清凭据保留绑定。文件链路：收到的文件/图片存
  DATA_DIR/wechat-files/inbox（用后即删），agent 成品写 wechat-files/out（回传后即删）；
  prompt 约定 agent 用 /opt/agent-venv/bin/python（镜像预烤 openpyxl/python-docx/
  python-pptx/pypdf/pdfplumber/pandas/matplotlib）；CDN 字段逐字对齐腾讯官方包
  @tencent-weixin/openclaw-weixin@2.4.10，aes_key 两种编码（裸16字节/hex串）都兼容。
- **信任**：spawn 带 `--approve` 跳过项目信任交互确认。
- **MCP/Skills 变更时机**：pi 子进程启动时读 mcp.json 与 skills，所以网页上改完
  只对「新会话」生效，已打开的会话要关闭重开（UI 提示里也写了）。
- **选择题（ask_user_choice）**：用 pi 官方 RPC 扩展 UI 子协议
  （docs/rpc-extension-ui.md：ctx.ui.select → extension_ui_request → 客户端回
  extension_ui_response；WS 新增 ui-response 通道单向写 stdin，PiProcess.send 不等响应）。
  网页端渲染选项/确认/输入卡片；带 timeout 由 pi 侧自动解决，轮次结束时未作答卡片统一收尾。
  （v0.4.3~0.5.0 曾用 .pnd-ask 文件握手，已废弃；早期结论「pi 无交互协议」有误——
  rpc-extension-ui.md 文档一直存在，当时漏查）

## 约定

- 前端零构建：原生 JS + marked/DOMPurify（web/vendor/ 已 vendor，勿引 CDN）。
- 后端依赖极简：仅 ws + qrcode。新增依赖先考虑零依赖实现。
- 数据布局：一切可变数据在 DATA_DIR（auth/projects/wechat/uploads/session-meta
  与 .pi/agent、sessions）；容器卷挂载点 /data、/workspace。
- 端口：默认 8080（PORT 环境变量）。测试端口用 18080 避免冲突。

## 开发循环

1. 本地跑（数据隔离，不动真实 ~/.pi）：
   `DATA_DIR=$PWD/test-data SESSION_DIR=$PWD/test-data/sessions PI_AGENT_DIR=$PWD/test-data/.pi/agent WORKSPACE_ROOT=$PWD/test-workspace node server/index.js`
2. 打部署包（README 有完整命令），tar 排除 node_modules/test-*。
3. 微信媒体链路离线回归：`node tests/wechat-media.test.mjs`（本地替身 iLink+CDN
   服务，验证上传/下载/AES 加解密/sendmessage 字段，不碰真实微信服务器）。
4. NAS 升级：上传包 → `tar -xzf 包 -C /tmp upgrade.sh` → `sudo bash /tmp/upgrade.sh 包`
   （层缓存使常规升级 build 仅 10～30 秒；Dockerfile 变更时 2～6 分钟）。

## 部署环境备注

- NAS：绿联 DH4300 Plus（ARM64）、UGOS Pro，构建/维护需 sudo。
- **目录大小写坑（实测）**：原部署在大写 `/volume1/Docker/pi-nas-deck`（容器
  compose working_dir 标签为证），而 UGOS 上传/文件侧看到的可能是小写 `docker`
  ——同一台 NAS 上两个目录都存在。upgrade.sh 已改为自动从容器标签探测部署目录
  （第 2 参数 / PND_DIR 可显式覆盖）；文档示例不再强调大小写，以
  `docker inspect pi-nas-deck --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'`
  的输出为准。
- Debian/npm 源已在国内化（USTC / npmmirror，见 Dockerfile）。
- python3/python3-pip/python3-venv 已打进镜像（PEP668：pip 全局安装受限，
  建议 agent 用 venv）。
