// docx 文本提取：零依赖最小 zip 读取 + word/document.xml 去标签。
// docx 是 zip（word/document.xml 存正文）；zip 中央目录在文件尾，必须完整读取。
// 只支持 store(0) 与 deflate(8) 两种压缩方式（docx 实际只用这两种）。
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** 从 docx Buffer 提取纯文本；非 zip / 缺 document.xml 时抛错。 */
export function extractDocxText(buffer) {
  const entries = readZipEntries(buffer, ["word/document.xml"]);
  const xml = entries.get("word/document.xml");
  if (!xml) throw new Error("docx 缺少 word/document.xml");
  return docxXmlToText(xml.toString("utf8"));
}

/** 只解析指定条目（names 为空则全部），返回 name -> Buffer。 */
function readZipEntries(buffer, names) {
  const want = names && names.length ? new Set(names) : null;
  // 找 EOCD：从尾部回扫最多 64KB（zip 注释上限）
  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 docx（zip）文件");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CDIR_SIG) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;
    if (want && !want.has(name)) continue;
    // 本地头：文件名/扩展字段长度可与中央目录不同，须以本地头为准计算数据起点
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error("zip 本地头损坏");
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buffer.subarray(dataStart, dataStart + compSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    else throw new Error(`不支持的 zip 压缩方式: ${method}`);
    if (want && out.size === want.size) break;
  }
  return out;
}

/** document.xml → 纯文本：段落换行、tab 保留、去全部标签、解实体。 */
export function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&") // &amp; 必须最后解，防二次解码
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
