#!/usr/bin/env bash
# PiNasDeck 升级脚本
# 用法（在 NAS 的 SSH 里执行）：
#   bash /tmp/upgrade.sh /volume1/docker/pi-nas-deck-deploy.tar.gz [部署目录]
# 部署目录缺省自动探测（读运行中容器的 compose working_dir 标签），
# 探不到时可用第 2 参数或 PND_DIR 环境变量显式指定。
# 效果：替换程序代码 → 重建镜像（有缓存，通常十几秒）→ 重建容器
#       配置/密码/workspace 映射自动保留；数据卷（会话/API Key/微信绑定）完全不动
set -e

PKG="${1:?用法: bash upgrade.sh /volume1/docker/pi-nas-deck-deploy.tar.gz [部署目录]}"

# 部署目录解析优先级：第 2 参数 > PND_DIR 环境变量 > 容器标签自动探测 > 默认路径
DIR="${2:-${PND_DIR:-}}"
if [ -z "$DIR" ]; then
  DIR=$(docker inspect pi-nas-deck --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null || true)
fi
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  DIR="/volume1/docker/pi-nas-deck"
fi

[ -f "$PKG" ] || { echo "❌ 找不到部署包: $PKG"; exit 1; }
[ -d "$DIR" ] || { echo "❌ 找不到部署目录: $DIR"; echo "   请显式指定：bash upgrade.sh $PKG /你的部署目录"; exit 1; }
[ -f "$DIR/docker-compose.yml" ] || {
  echo "❌ $DIR 下没有 docker-compose.yml，自动探测的目录可能不对。"
  echo "   查实际目录：docker inspect pi-nas-deck --format '{{ index .Config.Labels \"com.docker.compose.project.working_dir\" }}'"
  echo "   然后重跑：bash upgrade.sh $PKG /查到的目录"
  exit 1
}

echo "==> 部署目录: $DIR（不对就用第 2 参数显式指定）"

echo "==> 备份当前配置（docker-compose.yml / .env）"
cp "$DIR/docker-compose.yml" /tmp/pnd-compose.backup.yml
[ -f "$DIR/.env" ] && cp "$DIR/.env" /tmp/pnd-env.backup

echo "==> 移出旧版本（保留备份）"
rm -rf "${DIR}.old"
mv "$DIR" "${DIR}.old"
mkdir -p "$DIR"

echo "==> 解压新版本"
tar -xzf "$PKG" -C "$DIR"

echo "==> 恢复你的配置"
cp /tmp/pnd-compose.backup.yml "$DIR/docker-compose.yml"
[ -f /tmp/pnd-env.backup ] && cp /tmp/pnd-env.backup "$DIR/.env"

cd "$DIR"
echo "==> 构建镜像（层缓存生效，通常 10～30 秒；如 Dockerfile 有变更则 2～6 分钟）"
docker build --build-arg BUILD_DATE="$(date '+%Y-%m-%d %H:%M')" -t pi-nas-deck:latest .

echo "==> 重建容器（数据卷不动）"
docker compose up -d --force-recreate 2>/dev/null || docker-compose up -d --force-recreate

echo "==> 启动确认："
docker logs --tail 5 pi-nas-deck

echo ""
echo "✅ 升级完成。旧版本备份在 ${DIR}.old"
echo "   确认新版运行正常后可删除：rm -rf ${DIR}.old"
echo "   如果本次升级说明中提到 docker-compose.yml 有新增配置项，请手动合并（当前用的是你原有的 compose）。"
