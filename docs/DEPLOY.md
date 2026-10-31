# PiNasDeck — 绿联 NAS（UGOS Pro）部署指南

零 Docker 经验也可照做。推荐路线：**把源码传到 NAS → NAS 上直接构建 → 启动**。
NAS 上构建的好处是架构自动匹配（x86/ARM 都行），不需要在电脑上装 Docker。

---

## 第 0 步：准备

你需要三样东西：

| 东西 | 说明 |
|---|---|
| NAS 的 IP 地址 | 绿联客户端或路由器里查，如 `192.168.1.100` |
| NAS 管理员密码 | 登录网页管理界面用的那个 |
| 部署包 | `pi-nas-deck-deploy.tar.gz`（约 86KB，已打好） |

> 不需要提前确认 NAS 是 x86 还是 ARM——NAS 上原生构建自动匹配。

## 第 1 步：把部署包放进 NAS

1. 在 Windows 按 `Win + R`，输入 `\\NAS的IP`，回车
2. 输入 NAS 用户名密码（SMB 访问）
3. 打开 `Docker` 共享文件夹（没有就在文件管理器里新建一个）
4. 把 `pi-nas-deck-deploy.tar.gz` 拖进去

## 第 2 步：开启 SSH

1. 打开 NAS 网页管理界面（浏览器输入 NAS 的 IP）
2. 找到 **SSH** 开关（一般在「设置 → 服务」或「设置 → 安全」里，不同版本位置略有差异）
3. 打开它，端口保持默认 `22`

## 第 3 步：SSH 连上 NAS

在电脑上打开 PowerShell 或 Windows 终端：

```bash
ssh root@NAS的IP
```

- 如果提示用户名不对，换成你的管理员用户名：`ssh 你的用户名@NAS的IP`，登录后执行 `sudo -i` 切到 root
- 首次连接问 `yes/no`，输入 `yes`
- 密码是 NAS 管理员密码（输入时不显示，盲打回车即可）

看到类似 `root@NAS:~#` 的提示符就是成功了。

## 第 4 步：解压并修改配置

逐行复制执行（`#` 后面是注释，不用输入）：

```bash
# 建目录并解压（如果你把包放在别的共享文件夹，改第一行的路径）
mkdir -p /volume1/docker/pi-nas-deck
tar -xzf /volume1/docker/pi-nas-deck-deploy.tar.gz -C /volume1/docker/pi-nas-deck

# 进入目录
cd /volume1/docker/pi-nas-deck

# 确认解压成功：应能看到 Dockerfile、docker-compose.yml 等
ls
```

**准备工作目录**（你的项目文件以后放这里）：

1. 回到 NAS 网页管理界面 → 文件管理器
2. 在根目录新建共享文件夹，命名 `AIWorkspace`（对应路径 `/volume1/AIWorkspace`）
3. 在它里面随便建一个子文件夹，如 `myproject`（之后当作测试项目用）

回到 SSH，把 compose 里的工作目录改成你的：

```bash
# 把 /volume1/workspace 替换成 /volume1/AIWorkspace（如果你用了别的名字，对应改）
sed -i 's|/volume1/workspace|/volume1/AIWorkspace|' docker-compose.yml

# 检查一下，volumes 段应显示 - /volume1/AIWorkspace:/workspace
cat docker-compose.yml
```

**设置管理密码**：

```bash
# 把 MyPass123 换成你想要的登录密码
echo 'INITIAL_PASSWORD=MyPass123' > .env
```

## 第 5 步：构建镜像

```bash
docker build -t pi-nas-deck:latest .
```

- 首次构建会下载基础镜像和依赖，NAS 上大约 **5～20 分钟**（取决于机型和网络）
- 基础镜像（node:24）国内拉取如果报错/超时：去 NAS 网页管理界面 → Docker → 设置 → **镜像加速**，添加一个加速地址（如 `docker.m.daocloud.io`），然后重新执行本步
- 看到 `Successfully tagged pi-nas-deck:latest` 即构建成功

## 第 6 步：启动容器

```bash
docker compose up -d
```

- 如果提示 `compose` 命令不存在，换：`docker-compose up -d`
- 如果两个都没有，用下面的命令替代（效果完全一样）：

```bash
docker run -d --name pi-nas-deck --restart unless-stopped \
  -p 8080:8080 \
  --env-file .env \
  -e NPM_INSTALL_REGISTRY=https://registry.npmmirror.com \
  -v pnd-data:/data \
  -v /volume1/AIWorkspace:/workspace \
  pi-nas-deck:latest
```

确认它在跑：

```bash
docker logs pi-nas-deck
```

应看到：

```
[extensions] 已同步内置扩展: free-search
PiNasDeck 已启动: http://0.0.0.0:8080
```

## 第 7 步：浏览器验收

1. 电脑/手机浏览器打开 `http://NAS的IP:8080`
2. 用第 4 步设置的密码登录
3. **⚙️ 设置 → 模型 / API** → 「＋ 添加供应商」：
   - baseUrl：你的 API 地址（如 `https://api.deepseek.com/v1` 或中转站地址，注意一般要带 `/v1`）
   - API Key：你的密钥
   - 模型 ID：一行一个（如 `deepseek-chat`）
   - 点 **🔌 测试连接**，显示 ✅ 后点 **保存**
4. 左侧「＋ 添加项目」→ 目录选 `/workspace/myproject`
5. 「＋ 新会话」→ 发一句「你好」→ 应看到流式回复
6. 输入框敲 `/` → 应弹出命令和技能菜单
7. （可选）⚙️ 设置 → 微信 → 启用 → 扫码绑定

全部通过即部署完成。以后日常使用只需浏览器开网页，NAS 上无需任何操作。

---

## 第 8 步（强烈推荐）：装 Tailscale，从此任何网络都能访问 NAS

适用于：NAS 与电脑不在同一局域网、NAS 无公网 IP。装完后所有局域网操作
（Web/SSH/SMB）改用 NAS 的虚拟 IP `100.x.x.x`，其余不变。

1. NAS 网页管理 → 应用中心 → 搜 `Tailscale` → 安装并登录（有就用这个最简单）
2. 应用中心没有时，SSH 执行（Docker 方式）：

```bash
docker run -d --name=tailscale --network=host \
  --cap-add=NET_ADMIN --cap-add SYS_MODULE \
  -v /volume1/docker/tailscale:/var/lib/tailscale \
  -v /dev/net/tun:/dev/net/tun \
  -e TS_STATE_DIR=/var/lib/tailscale \
  --restart unless-stopped tailscale/tailscale:latest

docker logs tailscale 2>&1 | grep -A1 "https://login"
# 打开日志中的链接完成登录，NAS 即入网
```

3. 电脑安装 https://tailscale.com/download/windows ，登录**同一账号**
4. 查看 NAS 虚拟 IP：`docker exec tailscale tailscale ip -4`（形如 `100.x.x.x`）

之后远程使用：`http://100.x.x.x:8080`（Web）、`ssh root@100.x.x.x`、`\\100.x.x.x`（SMB）。
无需任何端口映射，比公网暴露安全得多。

凑不到同一局域网时的兑底：绿联官方远程（绿联云 APP/客户端）可远程挂载 SMB
传文件、用客户端远程终端 SSH 应急操作。

---

## 日常维护

| 操作 | 方法 |
|---|---|
| 看日志 | `docker logs -f pi-nas-deck`（SSH）或 Docker 界面 → 容器 → 日志 |
| 重启容器 | `docker restart pi-nas-deck` 或 Docker 界面操作 |
| 升级 pi | 网页里 ⚙️ → 系统 / 更新 → 在线更新（容器重建后再点一次即可） |
| 升级本程序 | 见下方「升级新版本」两行命令 |
| 备份 | 重点备份数卷 `pnd-data`（含配置、API Key、会话）；AIWorkspace 是你自己的文件 |
| 彻底卸载 | `docker rm -f pi-nas-deck`；再 `docker volume rm pnd-data`（会删数据，慎用） |

## 升级新版本

拿到新部署包后，在 NAS 的 SSH 里执行两行（总耗时通常半分钟）：

> 示例里的路径大小写以你 NAS 实际为准（UGOS 上部署目录可能是 `Docker` 也可能是
> `docker`）。新脚本会自动从运行中容器的 compose 标签探测部署目录，探测失败时把
> 目录作为第 2 参数传入即可：`bash upgrade.sh <包> <部署目录>`。

```bash
# 1. 新包上传到 /volume1/docker/ 下（不要放进部署目录里）
# 2. 执行（部署目录自动探测，探不到时把目录作为第 2 参数传入）：
tar -xzf /volume1/docker/pi-nas-deck-deploy.tar.gz -C /tmp upgrade.sh
bash /tmp/upgrade.sh /volume1/docker/pi-nas-deck-deploy.tar.gz
```

脚本自动完成：备份配置 → 替换代码 → 重建镜像（层缓存生效，通常 10～30 秒；
Dockerfile 有变更时 2～6 分钟）→ 重建容器。**配置、密码、workspace 映射、
数据卷（会话/API Key/微信绑定）全部保留**。旧版本备份在 `pi-nas-deck.old`，
确认新版正常后 `rm -rf /volume1/docker/pi-nas-deck.old`。

若新版本的升级说明提到 docker-compose.yml 有新增配置项，需手动合并到你的
compose 文件（脚本默认沿用你原有的 compose 以保护你的自定义配置）。

## 常见问题

**Q：`docker: command not found`**
确认 Docker 应用已在 NAS 上安装并启用，再试。仍不行说明该 UGOS 版本的 docker 路径特殊，执行 `find / -name docker -type f 2>/dev/null` 找到路径后用全路径执行。

**Q：`permission denied`**
命令前加 `sudo `，或先执行 `sudo -i`。

**Q：构建时 apt 或 npm 超时**
NAS 网络问题。检查 NAS 能否上网；npm 已默认走 npmmirror 一般不超时；基础镜像走 Docker 镜像加速。

**Q：页面打不开**
`docker logs pi-nas-deck` 看启动日志；确认 IP 和端口；如有防火墙放行 8080。换端口：把 compose 里 `"8080:8080"` 改成 `"8090:8080"` 后重建容器。

**Q：聊天报「pi 启动超时」或没有模型**
去设置页检查模型配置和「测试连接」。

**Q：忘记管理密码**
SSH 执行：

```bash
docker exec pi-nas-deck rm /data/auth.json
docker restart pi-nas-deck
docker logs pi-nas-deck | grep -A2 密码
```

新随机密码会打印在日志里，登录后到设置页改掉。

**Q：微信提示「需重新扫码」**
微信侧会话失效（长期未用/风控）。重新扫一次即可；失效后 1 小时内别反复重试（微信协议要求）。

## 安全提示

- 本程序仅在局域网使用，**不要**在路由器上做端口映射暴露公网
- 容器内的 agent 可以执行命令、读写 `/workspace` 下的文件，管理密码是唯一防线，请设置强密码
- API Key 存在 `pnd-data` 卷里，备份该卷时注意保密
