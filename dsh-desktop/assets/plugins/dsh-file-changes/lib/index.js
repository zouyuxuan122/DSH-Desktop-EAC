import { z } from "zod";
import { opendir, stat, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, extname } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Socket } from "node:net";
import { zstdDecompressSync } from "node:zlib";

const execFileP = promisify(execFile);

// 会话文件更改投影：纯函数折叠 tool/result 事件中已持久化的
// meta.diffs（每个元素 = { path, oldText, newText }，来自 ctx.fs 写前锁内全文）。
// 零写入、零格式变更 —— 只读复用官方已落盘的数据，因此对 dsh 升级完全稳定。
//
// 另外提供四组 webServer 路由（均仅接受回环地址请求）：
//   GET /api/dsh-files/list?path=...     —— 一层目录列表（「全部文件」树）
//   GET /dsh-files/static/<绝对路径>     —— 静态文件服务（HTML 站内侧边预览，
//                                           相对资源引用随 URL 路径自然解析）
//   GET /api/dsh-files/ports             —— 本机回环监听端口（端口预览候选）
//   GET /api/dsh-files/check?url=...     —— 检查回环 URL 是否在线（HTTP 状态）
//   GET /api/dsh-files/session-cwd?sessionId=... —— 按会话 ID 查会话日志头的
//                                           cwd（客户端视图确定项目根目录用）

const MAX_TEXT = 256 * 1024; // 单侧文本上限，防止投影体积失控
const MAX_CHANGES = 2000;   // 单会话变更记录上限

const fileChangesSchema = z.object({
  changes: z.array(z.object({
    seq: z.number().int().nonnegative(),
    time: z.number(),
    path: z.string(),
    op: z.string(),
    oldText: z.string(),
    newText: z.string()
  })),
  truncated: z.boolean().optional()
});

function clamp(text) {
  return typeof text === "string" && text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

const fileChangesProjectionDefinition = {
  key: "fileChanges",
  // dsh 0.1.0-rc.6 requires stateVersion (non-negative integer) and a
  // `view` that shapes the raw state into the schema-validated value.
  stateVersion: 0,
  schema: fileChangesSchema,
  init: () => ({ changes: [], truncated: false }),
  view: (state) => state,
  apply: (state, event) => {
    if (event.type !== "tool/result") return state;
    const diffs = event.data?.meta?.diffs;
    if (!Array.isArray(diffs) || diffs.length === 0) return state;
    const additions = [];
    for (const d of diffs) {
      const path = typeof d?.path === "string" ? d.path.trim() : "";
      if (!path) continue;
      const oldText = typeof d.oldText === "string" ? d.oldText : "";
      const newText = typeof d.newText === "string" ? d.newText : "";
      const op = oldText === "" && newText !== "" ? "create"
        : newText === "" && oldText !== "" ? "delete"
        : "edit";
      additions.push({
        seq: event.seq,
        time: typeof event.time === "number" ? event.time : 0,
        path,
        op,
        oldText: clamp(oldText),
        newText: clamp(newText)
      });
    }
    if (additions.length === 0) return state;
    const merged = [...state.changes, ...additions];
    if (merged.length <= MAX_CHANGES) return { changes: merged, truncated: state.truncated };
    return { changes: merged.slice(-MAX_CHANGES), truncated: true };
  }
};

// ---------------------------------------------------------------------------
// 项目文件树：GET /api/dsh-files/list?path=<绝对路径>
// 返回该目录的一层子项：{ path, entries: [{ name, dir, size, mtime }] }
// ---------------------------------------------------------------------------

const LIST_ROUTE = "/api/dsh-files/list";

function isLoopback(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(data.length)
  });
  res.end(data);
}

/** 读一层目录：目录在前、文件在后，各自按名称排序；附带文件大小与修改时间。 */
async function listOneLevel(dirPath) {
  const handle = await opendir(dirPath);
  const entries = [];
  try {
    for await (const d of handle) {
      entries.push({ name: d.name, dir: d.isDirectory() });
    }
  } finally {
    // for-await 结束时 Node 会自动关闭句柄；显式 close 只兜底提前退出的情况。
    try { await handle.close(); } catch {}
  }
  const out = [];
  for (const e of entries) {
    let size = 0;
    let mtime = 0;
    try {
      const st = await stat(join(dirPath, e.name));
      if (st.isDirectory() && !e.dir) e.dir = true; // 符号链接指向目录
      else if (st.isFile() && e.dir) e.dir = false; // 符号链接指向文件
      size = st.isFile() ? st.size : 0;
      mtime = st.mtimeMs;
    } catch {
      // 不可 stat 的条目（如损坏的符号链接）仍显示，只是没有大小/时间。
    }
    out.push({ name: e.name, dir: e.dir, size, mtime });
  }
  out.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return out;
}

async function handleListRoute(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    sendJson(res, 400, { error: "bad request URL" });
    return;
  }
  const dirPath = (url.searchParams.get("path") || "").trim();
  if (!dirPath || !isAbsolute(dirPath)) {
    sendJson(res, 400, { error: "path must be an absolute path" });
    return;
  }
  try {
    const entries = await listOneLevel(dirPath);
    sendJson(res, 200, { path: dirPath, entries });
  } catch (err) {
    const code = err && (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "EACCES" || err.code === "EPERM") ? 404 : 500;
    sendJson(res, code, { error: String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------------------
// 静态文件服务：GET /dsh-files/static/<绝对路径>
// 路径直接嵌入 URL，HTML 的相对资源引用（./css、../img）随浏览器 URL 解析，
// 因此站内预览与本地 file:// 行为一致。
// ---------------------------------------------------------------------------

const STATIC_PREFIX = "/dsh-files/static/";

const MIME = {
  ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
  ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".json": "application/json", ".map": "application/json",
  ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".pdf": "application/pdf", ".xml": "application/xml"
};

const TEXT_MIME = /^(text\/|application\/(json|javascript|xhtml\+xml|xml)|image\/svg)/;

function mimeFor(p) {
  return MIME[extname(p).toLowerCase()] || "application/octet-stream";
}

/** 从 /dsh-files/static/<path> 的 pathname 还原绝对路径；非法/不支持返回空串。 */
function pathFromStaticUrl(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname.slice(STATIC_PREFIX.length));
  } catch {
    return "";
  }
  // 浏览器把 "//server" 折叠成 "/server"；仅恢复盘符路径（UNC 预览不支持）。
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  if (!isAbsolute(p)) return "";
  return p;
}

async function handleStaticRoute(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url, "http://127.0.0.1").pathname;
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const p = pathFromStaticUrl(pathname);
  if (!p) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  try {
    const st = await stat(p);
    if (!st.isFile()) {
      res.writeHead(404);
      res.end("not a file");
      return;
    }
    const data = await readFile(p);
    const mime = mimeFor(p);
    res.writeHead(200, {
      "content-type": TEXT_MIME.test(mime) ? mime + "; charset=utf-8" : mime,
      "content-length": String(data.length),
      "cache-control": "no-store"
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (err) {
    const code = err && (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM") ? 404 : 500;
    res.writeHead(code);
    res.end(code === 404 ? "not found" : "internal error");
  }
}

// ---------------------------------------------------------------------------
// 端口探测：GET /api/dsh-files/ports —— 本机回环监听端口（预览候选）
// ---------------------------------------------------------------------------

const COMMON_DEV_PORTS = [3000, 3001, 3005, 3006, 4200, 4321, 5000, 5001, 5173, 5174, 5500, 6006, 8000, 8080, 8081, 8787, 8888, 9000, 1313];

let portsCache = { at: 0, value: null };

function probePort(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const sock = new Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.connect(port, "127.0.0.1");
  });
}

async function findListeningPorts() {
  const ports = [];
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileP("netstat", ["-ano", "-p", "TCP"], {
        windowsHide: true,
        timeout: 4000,
        maxBuffer: 4 * 1024 * 1024
      });
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+([^\s:]+(?:\[[^\]]+\])?):(\d+)\s+\S+\s+LISTENING/i);
        if (!m) continue;
        const host = m[1].replace(/^\[|\]$/g, "");
        if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "::") {
          ports.push(parseInt(m[2], 10));
        }
      }
    } catch {}
  } else {
    try {
      const { stdout } = await execFileP("ss", ["-ltn"], { timeout: 4000, maxBuffer: 1024 * 1024 });
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/LISTEN\b.*?:(\d+)\s*$/);
        if (m && /(127\.0\.0\.|\[::1\]|\*:|0\.0\.0\.0:)/.test(line)) {
          ports.push(parseInt(m[1], 10));
        }
      }
    } catch {}
  }
  if (ports.length === 0) {
    const results = await Promise.all(COMMON_DEV_PORTS.map((p) => probePort(p).then((ok) => (ok ? p : 0))));
    for (const p of results) if (p) ports.push(p);
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

async function handlePortsRoute(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  const now = Date.now();
  if (portsCache.value !== null && now - portsCache.at < 1500) {
    sendJson(res, 200, { ports: portsCache.value });
    return;
  }
  try {
    const found = await findListeningPorts();
    // 预览只关心开发端口：过滤系统低端口，常见开发端口若在监听则保留。
    const dev = found.filter((p) => p >= 1024 || COMMON_DEV_PORTS.includes(p));
    portsCache = { at: Date.now(), value: dev };
    sendJson(res, 200, { ports: dev });
  } catch (err) {
    sendJson(res, 500, { error: String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------------------
// 在线检查：GET /api/dsh-files/check?url=http://127.0.0.1:3000/
// ---------------------------------------------------------------------------

async function handleCheckRoute(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    sendJson(res, 400, { error: "bad request URL" });
    return;
  }
  const targetStr = (url.searchParams.get("url") || "").trim();
  let target;
  try {
    target = new URL(targetStr);
  } catch {
    sendJson(res, 400, { error: "invalid url" });
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    sendJson(res, 400, { error: "only http(s) targets" });
    return;
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    sendJson(res, 400, { error: "only loopback targets" });
    return;
  }
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(2500), redirect: "manual" });
    sendJson(res, 200, { ok: true, status: r.status });
  } catch (err) {
    const cause = err && err.cause && err.cause.code ? err.cause.code : "";
    sendJson(res, 200, { ok: false, error: cause || String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------------------
// 会话 cwd 查询：GET /api/dsh-files/session-cwd?sessionId=...
// 客户端视图（文件树 / 终端）用它确定项目根目录——不依赖页面内部 hooks。
// 数据源与会话监视器一致：<DSH_HOME>/sessions/**/session.jsonl.zstd 的文件头。
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = 4247762216;

function scanFirstZstdFrame(buffer) {
  let offset = 0;
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return null;
  offset += 4;
  if (offset === buffer.length) return null;
  const descriptor = buffer.readUInt8(offset++);
  if ((descriptor & 24) !== 0) return null;
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (buffer.length - offset < remainingHeaderBytes) return null;
  offset += remainingHeaderBytes;
  for (;;) {
    if (buffer.length - offset < 3) return null;
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) return null;
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (buffer.length - offset < payloadBytes) return null;
    offset += payloadBytes;
    if (lastBlock) break;
  }
  if (checksum) offset += 4;
  return { start: 0, end: offset };
}

const sessionCwdCache = new Map(); // sessionId -> cwd（会话 cwd 基本不迁移）

function dshSessionsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
}

function findSessionCwd(sessionId) {
  if (!sessionId) return "";
  if (sessionCwdCache.has(sessionId)) return sessionCwdCache.get(sessionId);
  let cwd = "";
  try {
    const walk = (dir) => {
      if (cwd) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (cwd) return;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "session.jsonl.zstd") {
          try {
            const buf = readFileSync(p);
            const frame = scanFirstZstdFrame(buf);
            if (!frame) return;
            const text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString("utf8");
            const header = JSON.parse(text.split("\n", 1)[0]);
            if (header && header.id === sessionId) cwd = String(header.cwd || "");
          } catch {}
        }
      }
    };
    walk(dshSessionsRoot());
  } catch {}
  sessionCwdCache.set(sessionId, cwd);
  return cwd;
}

async function handleSessionCwdRoute(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    sendJson(res, 400, { error: "bad request URL" });
    return;
  }
  const sessionId = (url.searchParams.get("sessionId") || "").trim();
  if (!sessionId) {
    sendJson(res, 400, { error: "sessionId is required" });
    return;
  }
  sendJson(res, 200, { sessionId, cwd: findSessionCwd(sessionId) });
}

const name = "dsh-file-changes";
const inject = ["sessionProjections", "webServer"];

function apply(ctx) {
  ctx.sessionProjections.register(fileChangesProjectionDefinition);
  const disposers = [
    ctx.webServer.register({ kind: "exact", path: LIST_ROUTE, handler: handleListRoute }),
    ctx.webServer.register({ kind: "exact", path: "/api/dsh-files/ports", handler: handlePortsRoute }),
    ctx.webServer.register({ kind: "exact", path: "/api/dsh-files/check", handler: handleCheckRoute }),
    ctx.webServer.register({ kind: "exact", path: "/api/dsh-files/session-cwd", handler: handleSessionCwdRoute }),
    // 注意：prefix 不能带尾部斜杠（webserver 按 prefix + "/" 匹配）。
    ctx.webServer.register({ kind: "prefix", path: STATIC_PREFIX.replace(/\/+$/, ""), handler: handleStaticRoute })
  ];
  return () => { for (const d of disposers) d(); };
}

export { apply, inject, name };
