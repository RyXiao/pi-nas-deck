// Skills 管理：$PI_AGENT_DIR/skills/<name>/SKILL.md 的增删改查。
// pi 的 skill = 目录 + SKILL.md（可带 YAML frontmatter 描述）；这里只管 SKILL.md 本体，
// 目录内其他附属文件不动（删除时整目录移除）。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export function skillsDir(piAgentDir) {
  return join(piAgentDir, "skills");
}

function safeSkillDir(piAgentDir, name) {
  if (!SKILL_NAME_RE.test(name)) throw new Error("skill 名只能用字母/数字/中划线/下划线（≤64 字符）");
  return join(skillsDir(piAgentDir), name);
}

/** 列出全部 skill：名称、首行描述（frontmatter description 或首个正文行）、大小、mtime。 */
export function listSkills(piAgentDir) {
  const dir = skillsDir(piAgentDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
    const mdPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(mdPath)) continue;
    let stat;
    try {
      stat = statSync(mdPath);
    } catch {
      continue;
    }
    let description = "";
    try {
      description = extractDescription(readFileSync(mdPath, "utf8"));
    } catch {
      /* 读失败就不带描述 */
    }
    out.push({ name: entry.name, description, bytes: stat.size, updatedAt: stat.mtime.toISOString() });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getSkill(piAgentDir, name) {
  const mdPath = join(safeSkillDir(piAgentDir, name), "SKILL.md");
  if (!existsSync(mdPath)) throw new Error(`skill 不存在: ${name}`);
  return readFileSync(mdPath, "utf8");
}

/** 创建或覆盖一个 skill（只写 SKILL.md）。 */
export function saveSkill(piAgentDir, name, content) {
  if (typeof content !== "string" || !content.trim()) throw new Error("SKILL.md 内容不能为空");
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) throw new Error("SKILL.md 不能超过 2MB");
  const dir = safeSkillDir(piAgentDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
  return { name };
}

export function deleteSkill(piAgentDir, name) {
  const dir = safeSkillDir(piAgentDir, name);
  if (!existsSync(dir)) throw new Error(`skill 不存在: ${name}`);
  rmSync(dir, { recursive: true, force: true });
  return { name };
}

/** 从 SKILL.md 提取一行描述：优先 frontmatter 的 description，其次首个非空正文行。 */
function extractDescription(content) {
  let text = content;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end > 0) {
      const frontmatter = text.slice(3, end);
      const m = frontmatter.match(/^description:\s*(.+)$/m);
      if (m) return cleanLine(m[1]);
      text = text.slice(end + 4);
    }
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return cleanLine(trimmed);
  }
  return "";
}

function cleanLine(line) {
  return line.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}
