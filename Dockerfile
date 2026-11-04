# PiNasDeck — pi Agent 的 NAS Web 工作台
# 多架构（amd64/arm64）：node:24-bookworm-slim 官方多架构镜像，无原生编译依赖。
FROM node:24-bookworm-slim

# Debian apt 源换为中科大镜像（国内 NAS 构建提速；海外使用可删掉这两行 RUN）
RUN (sed -i 's@deb.debian.org@mirrors.ustc.edu.cn@g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true) \
  && (sed -i 's@deb.debian.org@mirrors.ustc.edu.cn@g' /etc/apt/sources.list 2>/dev/null || true)

# pi 运行所需的基础工具（内置 bash 工具会用到）；python3 供 agent 脚本类任务使用
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git ripgrep ca-certificates tini python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

# 全局安装 pi CLI。默认锁定 1.5.0（与 RPC/扩展 UI 协议冒烟一致）；
# 可 --build-arg PI_VERSION=x.y.z 覆盖，或 PI_VERSION=latest 跟最新。
# NPM_REGISTRY 默认走 npmmirror（国内稳定）；想用官方源：--build-arg NPM_REGISTRY=https://registry.npmjs.org
ARG PI_VERSION=1.5.0
ARG NPM_REGISTRY=https://registry.npmmirror.com
# 构建时间由 upgrade.sh 传入（docker build --build-arg BUILD_DATE=…），显示在设置→系统页
ARG BUILD_DATE=unknown
ENV PND_BUILD_DATE=${BUILD_DATE}
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} --registry=${NPM_REGISTRY} \
  && npm cache clean --force

# agent 办公文件处理 venv（微信文件分析/修改链路的处理约定用 /opt/agent-venv/bin/python；
# PEP668 禁止全局 pip，venv 是正道；源用阿里云 PyPI 镜像）
# 拆两层：大包（pandas/numpy）单独一层，失败重试不用重装小包；
# --only-binary 禁止源码构建（NAS 无编译链，遇到无轮子的包直接报错好过卡死）；
# --retries 网络抖动自动重试（NAS 上 docker daemon 断连/内存压力常见）。
RUN python3 -m venv /opt/agent-venv \
  && /opt/agent-venv/bin/pip install --no-cache-dir --retries 5 --only-binary=:all: \
    -i https://mirrors.aliyun.com/pypi/simple \
    openpyxl python-docx python-pptx pypdf pdfplumber
RUN /opt/agent-venv/bin/pip install --no-cache-dir --retries 5 --only-binary=:all: \
    -i https://mirrors.aliyun.com/pypi/simple \
    pandas matplotlib

# 时区：定时任务 HH:MM 与用量按天/月统计按此解释；基础镜像通常已带 tzdata，缺才装
RUN if [ ! -f /usr/share/zoneinfo/Asia/Shanghai ]; then \
      apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app

# 先装依赖（利用层缓存）
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-fund --no-audit --registry=${NPM_REGISTRY}

COPY server/ ./server/
COPY web/ ./web/
COPY CHANGELOG.md ./CHANGELOG.md
# 内置 pi 扩展（free-search 免 key 搜索等），启动时同步到 /data/.pi/agent/extensions
COPY extensions/ /app/extensions/

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8080 \
    # HOME 指向 /data：pi 默认读 $HOME/.pi/agent，统一后服务端与 pi 读写同一份 models.json/会话/信任配置 \
    HOME=/data \
    DATA_DIR=/data \
    PI_AGENT_DIR=/data/.pi/agent \
    SESSION_DIR=/data/sessions \
    WORKSPACE_ROOT=/workspace \
    WEB_ROOT=/app/web \
    EXTENSIONS_SOURCE=/app/extensions \
    # 国内网络可配置 npm 镜像源（在线更新 pi 时使用）
    NPM_INSTALL_REGISTRY=""

# /data        应用数据（配置、会话、pi 的 .pi/agent：models.json、auth.json、trust.json）
# /workspace   用户项目目录（挂载 NAS 共享文件夹）
VOLUME ["/data", "/workspace"]

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini：正确转发信号、回收僵尸进程（pi 子进程会再 spawn shell/git）
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
