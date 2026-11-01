// 内置扩展同步：把镜像自带的扩展（/app/extensions/*）同步到 pi 的 extensions 目录。
// 幂等：目标缺失才复制，已存在则按 mtime 比较、源文件更新才覆盖。
// 这样容器重建/镜像升级后，web_search 等内置能力自动补齐，无需用户手动拷贝。
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function syncBuiltinExtensions(sourceDir, targetDir) {
  if (!sourceDir || !existsSync(sourceDir)) return { synced: [], skipped: [] };
  mkdirSync(targetDir, { recursive: true });
  const synced = [];
  const skipped = [];
  for (const name of readdirSync(sourceDir)) {
    const src = join(sourceDir, name);
    if (!statSync(src).isDirectory()) continue;
    const dest = join(targetDir, name);
    try {
      if (!existsSync(dest)) {
        cpSync(src, dest, { recursive: true });
        synced.push(name);
        continue;
      }
      // 已存在：任一源文件比目标新则整体覆盖（扩展通常是一组文件）
      if (sourceNewer(src, dest)) {
        cpSync(src, dest, { recursive: true, force: true });
        synced.push(name);
      } else {
        skipped.push(name);
      }
    } catch (error) {
      console.warn(`[extensions] 同步 ${name} 失败:`, error.message);
    }
  }
  if (synced.length) console.log(`[extensions] 已同步内置扩展: ${synced.join(", ")}`);
  return { synced, skipped };
}

function sourceNewer(srcDir, destDir) {
  const newest = (dir) => {
    let max = 0;
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else max = Math.max(max, statSync(full).mtimeMs);
      }
    };
    walk(dir);
    return max;
  };
  return newest(srcDir) > newest(destDir);
}
