// 离线集成测试：本地替身 iLink API + CDN，验证文件上传/下载/AES 加解密/sendmessage 全链路。
// 运行：node .tmp-media-test.mjs（不访问真实微信服务器）
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { IlinkClient } from "../server/wechat/ilinkClient.js";
import { UPLOAD_MEDIA_TYPE, aesEcbPaddedSize, encryptAesEcb, parseAesKey } from "../server/wechat/ilinkMedia.js";
import { collectNewFiles } from "../server/wechat/bridge.js";

const captured = { uploadReq: null, cdnBody: null, uploadQuery: null, sendBodies: [] };
const cdnStore = new Map(); // encrypted_query_param -> ciphertext

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://stub");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.method === "POST" && url.pathname === "/ilink/bot/getuploadurl") {
      captured.uploadReq = JSON.parse(body.toString());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ret: 0, upload_param: "UPPARAM123" }));
    } else if (req.method === "POST" && url.pathname === "/c2c/upload") {
      captured.cdnBody = body;
      captured.uploadQuery = { param: url.searchParams.get("encrypted_query_param"), filekey: url.searchParams.get("filekey") };
      cdnStore.set("DLPARAM456", Buffer.from(body));
      res.writeHead(200, { "x-encrypted-param": "DLPARAM456" });
      res.end("ok");
    } else if (req.method === "GET" && url.pathname === "/c2c/download") {
      const ct = cdnStore.get(url.searchParams.get("encrypted_query_param"));
      if (!ct) {
        res.writeHead(404);
        return res.end("nope");
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(ct);
    } else if (req.method === "POST" && url.pathname === "/ilink/bot/sendmessage") {
      captured.sendBodies.push(JSON.parse(body.toString()));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ret: 0, message_id: "srv-1" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok -", label);
}
const md5 = (buf) => createHash("md5").update(buf).digest("hex");

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const cdnBase = `${base}/c2c`;

const client = new IlinkClient({ baseUrl: base });
const session = { botToken: "tok", baseUrl: base, ilinkBotId: "b1", ilinkUserId: "u1" };

// ---- 1. 上传链路 ----
const dir = mkdtempSync(join(tmpdir(), "pnd-media-"));
const filePath = join(dir, "报告.docx");
const plaintext = Buffer.concat([Buffer.from("PK-fake-docx-"), randomBytes(1000)]);
writeFileSync(filePath, plaintext);

const uploaded = await client.uploadLocalFile(session, { filePath, toUserId: "user@im.wechat", mediaType: UPLOAD_MEDIA_TYPE.FILE, cdnBaseUrl: cdnBase });
assert(captured.uploadReq.media_type === 3, "getuploadurl media_type=FILE(3)");
assert(/^[0-9a-f]{32}$/.test(captured.uploadReq.filekey) && /^[0-9a-f]{32}$/.test(captured.uploadReq.aeskey), "filekey/aeskey 均为 hex32");
assert(captured.uploadReq.rawsize === plaintext.length && captured.uploadReq.rawfilemd5 === md5(plaintext), "rawsize/rawfilemd5 正确");
assert(captured.uploadReq.filesize === aesEcbPaddedSize(plaintext.length), "filesize 为 PKCS7 补齐尺寸");
assert(captured.uploadReq.no_need_thumb === true, "no_need_thumb");
assert(captured.uploadQuery?.param === "UPPARAM123" && captured.uploadQuery?.filekey === captured.uploadReq.filekey, "CDN 上传 URL 查询参数");
assert(captured.cdnBody?.length === aesEcbPaddedSize(plaintext.length) && !captured.cdnBody.equals(plaintext), "CDN 收到的是补齐尺寸的密文");
assert(uploaded.downloadEncryptedQueryParam === "DLPARAM456", "download 参数取自 x-encrypted-param 响应头");

// ---- 2. 入站下载：文件条目（aes_key = base64(utf8(hex))，官方文件编码）----
const fileItem = { type: 4, file_item: { file_name: "报告.docx", media: { encrypt_query_param: "DLPARAM456", aes_key: Buffer.from(uploaded.aeskeyHex).toString("base64") } } };
const got = await client.downloadInboundMedia(fileItem, { cdnBaseUrl: cdnBase });
assert(got.fileName === "报告.docx", "入站文件名保留");
assert(got.buffer.equals(plaintext), "下载解密 == 上传明文（完整往返）");

// ---- 3. 入站下载：图片条目（aes_key = base64(裸16字节)，官方图片编码）----
const imgKey = randomBytes(16);
const imgPlain = Buffer.from("PNGDATA-12345678");
cdnStore.set("IMG1", encryptAesEcb(imgPlain, imgKey));
const img = await client.downloadInboundMedia({ type: 2, image_item: { media: { encrypt_query_param: "IMG1", aes_key: imgKey.toString("base64") } } }, { cdnBaseUrl: cdnBase });
assert(img.buffer.equals(imgPlain), "图片裸 16 字节 key 编码兼容");

// ---- 4. 发文件：逐条 sendmessage + file_item 字段 ----
await client.sendFile(session, { toUserId: "user@im.wechat", contextToken: "ctx", text: "处理完成", fileName: "报告_modified.docx", uploaded, runId: "r1", clientId: "c1" });
assert(captured.sendBodies.length === 2, "两次 sendmessage（文本项 + 文件项）");
const textMsg = captured.sendBodies[0].msg;
const fileMsg = captured.sendBodies[1].msg;
assert(textMsg.item_list[0].text_item.text === "处理完成" && textMsg.context_token === "ctx" && textMsg.run_id === "r1", "文本项/context_token/run_id");
const fi = fileMsg.item_list[0];
assert(fi.type === 4 && fi.file_item.file_name === "报告_modified.docx" && fi.file_item.len === String(plaintext.length), "file_item 名称与长度");
assert(fi.file_item.media.encrypt_query_param === "DLPARAM456" && fi.file_item.media.encrypt_type === 1, "file_item.media 参数");
assert(parseAesKey(fi.file_item.media.aes_key).equals(Buffer.from(uploaded.aeskeyHex, "hex")), "aes_key 编码往返（base64(hex) → 16字节）");

// ---- 5. parseAesKey 拒绝坏 key ----
let threw = false;
try {
  parseAesKey(Buffer.from("short").toString("base64"));
} catch {
  threw = true;
}
assert(threw, "parseAesKey 拒绝非法长度");

// ---- 6. collectNewFiles：只回传新、非空、非超限的文件 ----
const outDir = join(dir, "out");
mkdirSync(outDir);
writeFileSync(join(outDir, "old.txt"), "old");
utimesSync(join(outDir, "old.txt"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
const since = Date.now();
await new Promise((r) => setTimeout(r, 10));
writeFileSync(join(outDir, "成品.xlsx"), "xlsx-bytes");
writeFileSync(join(outDir, "empty.txt"), "");
writeFileSync(join(outDir, "huge.bin"), "");
truncateSync(join(outDir, "huge.bin"), 51 * 1024 * 1024); // 稀疏文件超 50MB 上限
mkdirSync(join(outDir, "subdir"));
const names = collectNewFiles(outDir, since).map((f) => f.name);
assert(names.length === 1 && names[0] === "成品.xlsx", `新品筛选正确（实际: ${JSON.stringify(names)}）`);

console.log("\nALL MEDIA TESTS PASSED");
server.close();
process.exit(0);
