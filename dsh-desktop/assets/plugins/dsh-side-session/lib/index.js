// dsh-side-session — 服务端（cordis 插件）
//
// 职责：
//  1) 注册插件设置节（回答引擎 mode + mode2 的 key/model/endpoint）。
//  2) GET  /api/dsh-side-session/context?sessionId=  → 解析会话日志，返回
//     { title, files, transcript, truncated, provider, model }（仅回环）。
//  3) POST /api/dsh-side-session/ask                 → 组装「对话 + 涉及文件内容」
//     上下文，按 mode 调用模型并流式返回（SSE，OpenAI 格式）：
//       mode1：复用 dsh 全局 Key，代理 DeepSeek /chat/completions；
//       mode2：插件自带 Key，代理 /chat/completions；
//       mode3：纯服务端走 dsh 宿主 LLM 服务 ctx.llm.stream（不读任何 key）。
//
// 上下文捕获不依赖猜测会话事件类型：直接解析
// <DSH_HOME>/sessions/**/session.jsonl.zstd（与 dsh-file-changes 同源的
// zstd 帧扫描 + node:zlib.zstdDecompressSync 手法）。文件信息取自
// tool/code-dispatch* 事件（read/write/edit/grep/glob 的 file_path/path），
// 再在 /ask 时读取这些文件的【当前磁盘内容】注入上下文——这比 meta.diffs
// 更全：连 agent 读取过的文件也能纳入（符合「所有调用的文件」语义）。

import * as schem from "schemastery";
const z = schem.z || (schem.default && schem.default.z) || schem.default;
import { readFileSync, readdirSync, statSync, promises as fsp } from "node:fs";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import {
  normalizeReasoningEffort,
  shouldRetryWithoutReasoning,
} from "./reasoning-compat.js";

const NS = "dsh-side-session";
const CONTEXT_ROUTE = "/api/dsh-side-session/context";
const ASK_ROUTE = "/api/dsh-side-session/ask";

const DEFAULT_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_PROVIDER = "deepseek-official";

// 截断上限：三档上下文长度（1=标准 / 2=加长 / 3=完整），随设置动态生效
const CONTEXT_PRESETS = {
  "1": { msgs: 120, chars: 40 * 1024, filesInPrompt: 24, fileText: 24 * 1024, blockChars: 200 * 1024, filesTotal: 200 },
  "2": { msgs: 600, chars: 200 * 1024, filesInPrompt: 80, fileText: 64 * 1024, blockChars: 800 * 1024, filesTotal: 500 },
  "3": { msgs: 5000, chars: 2 * 1024 * 1024, filesInPrompt: 300, fileText: 256 * 1024, blockChars: 4 * 1024 * 1024, filesTotal: 1000 },
};
function ctxLen() {
  const key = String((lastSettings && lastSettings.contextLength) || "2");
  return CONTEXT_PRESETS[key] || CONTEXT_PRESETS["2"];
}
const MAX_FILE_TEXT = 24 * 1024; // 标准档单文件文本（兼容引用）
const MAX_FILES_IN_PROMPT = 24; // 标准档注入文件数（兼容引用）
const MAX_FILES_TOTAL = 200; // 标准档文件列表上限（兼容引用）
const MAX_FILE_BLOCK_CHARS = 200 * 1024; // 标准档文件内容合计（兼容引用）
const MAX_TRANSCRIPT_MSGS = 120; // 标准档消息数（兼容引用）
const MAX_TRANSCRIPT_CHARS = 40 * 1024; // 标准档字符上限（兼容引用）

// ---------------------------------------------------------------------------
// 设置节（与 Spec.txt 三模式对应）
// ---------------------------------------------------------------------------
const Config = z.object({
  mode: z
    .string()
    .default("3")
    .description(
      "回答引擎模式：1=复用 dsh 全局 Key；2=插件自带 Key；3=纯服务端走 dsh 宿主 LLM（ctx.llm，不读任何 key）"
    ),
  apiKey: z.string().role("secret").default("").description("mode=2 时使用的 API Key"),
  model: z.string().default(DEFAULT_MODEL).description("mode=2 时的模型名"),
  endpoint: z
    .string()
    .default(DEFAULT_BASE)
    .description("mode=2 时的 API 基址（自动拼接 /chat/completions）"),
  contextLength: z
    .string()
    .default("2")
    .description("上下文长度：1=标准（120 条/40K，省 token）；2=加长（600 条/200K，推荐）；3=完整（5000 条/2M，最接近通读，token 消耗大）"),
  animMs: z
    .number()
    .default(500)
    .description("浮窗弹出动画时长（毫秒，0=关闭动画）"),
});

function clamp(text, max) {
  return typeof text === "string" && text.length > max
    ? text.slice(0, max) + "\n…(已截断)"
    : text;
}

// ---------------------------------------------------------------------------
// dsh 全局凭据解析（取自 dsh-desktop/balance.js 的实测实现，逐行对齐）
// ---------------------------------------------------------------------------
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function readGlobalKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    const text = readFileSync(join(dshHome(), ".credentials.yaml"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)/);
      if (m) return m[1];
    }
  } catch {}
  return "";
}

// 锚定 agent-default-model 段取 model（与 balance.readActiveModel 行为一致，
// 但额外锚定命名空间以避免其他 model: 键误读）。
function readGlobalModel() {
  try {
    const text = readFileSync(join(dshHome(), "settings.yaml"), "utf8");
    // 仅锚定 agent-default-model 段内的 model: 行，避免误读其它命名空间的 model 键
    const anchored = text.match(/agent-default-model:[\s\S]*?^\s*model:\s*(\S+)/m);
    if (anchored) return anchored[1];
  } catch {}
  return DEFAULT_MODEL;
}

function readGlobalProvider() {
  try {
    const text = readFileSync(join(dshHome(), "settings.yaml"), "utf8");
    const NL = String.fromCharCode(10);
    const lines = text.split(NL);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "agent-default-model:") {
        for (let j = i + 1; j < lines.length; j++) {
          const nest = lines[j].trim();
          if (nest.startsWith("provider:")) return nest.slice("provider:".length).trim();
          if (nest && !(lines[j].startsWith(" ") || lines[j].startsWith(String.fromCharCode(9)))) break;
        }
        break;
      }
    }
  } catch {}
  return DEFAULT_PROVIDER;
}

function readGlobalReasoning() {
  try {
    const text = readFileSync(join(dshHome(), "settings.yaml"), "utf8");
    const NL = String.fromCharCode(10);
    const lines = text.split(NL);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "agent-default-model:") {
        for (let j = i + 1; j < lines.length; j++) {
          const nest = lines[j].trim();
          if (nest.startsWith("reasoningEffort:")) return nest.slice("reasoningEffort:".length).trim();
          if (nest && !(lines[j].startsWith(" ") || lines[j].startsWith(String.fromCharCode(9)))) break;
        }
        break;
      }
    }
  } catch {}
  return "";
}

function globalBase() {
  return (process.env.DEEPSEEK_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// zstd 多帧解压（兼容单帧 / 多帧拼接的 .zstd）
// ---------------------------------------------------------------------------
const ZSTD_MAGIC = 4247762216;

function scanFrame(buf, offset) {
  if (buf.length - offset < 4) return null;
  if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return null;
  let o = offset + 4;
  const desc = buf.readUInt8(o++);
  if ((desc & 24) !== 0) return null;
  const csf = desc >>> 6;
  const singleSeg = (desc & 32) !== 0;
  const checksum = (desc & 4) !== 0;
  const dictFlag = desc & 3;
  const dictBytes = dictFlag === 3 ? 4 : dictFlag;
  const contentSizeBytes = csf === 0 ? (singleSeg ? 1 : 0) : 1 << csf;
  let remaining = (singleSeg ? 0 : 1) + dictBytes + contentSizeBytes;
  if (buf.length - o < remaining) return null;
  o += remaining;
  for (;;) {
    if (buf.length - o < 3) return null;
    const bh = buf.readUIntLE(o, 3);
    o += 3;
    const last = (bh & 1) !== 0;
    const bt = (bh >>> 1) & 3;
    const bs = bh >>> 3;
    if (bt === 3) return null;
    const payload = bt === 1 ? 1 : bs;
    if (buf.length - o < payload) return null;
    o += payload;
    if (last) break;
  }
  if (checksum) o += 4;
  return { start: offset, end: o };
}

function decompressZstd(buf) {
  let offset = 0;
  let out = "";
  for (;;) {
    const f = scanFrame(buf, offset);
    if (!f) break;
    try {
      out += zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    } catch {
      break;
    }
    offset = f.end;
    if (offset >= buf.length) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 会话日志定位（扫描 <DSH_HOME>/sessions/**/session.jsonl.zstd，按文件头 id 匹配）
// ---------------------------------------------------------------------------
const sessionFileCache = new Map(); // sessionId -> 文件路径
function capMap(map, max) {
  if (map.size <= max) return;
  let extra = map.size - max;
  for (const key of map.keys()) {
    map.delete(key);
    if (--extra <= 0) break;
  }
}
const CACHE_MAX = 200;

function walkForSession(root, sessionId) {
  let found = "";
  const visit = (dir) => {
    if (found) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name === "session.jsonl.zstd") {
        try {
          const buf = readFileSync(p);
          const f = scanFrame(buf, 0);
          if (!f) return;
          const head = JSON.parse(
            zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8").split("\n", 1)[0]
          );
          if (head && head.id === sessionId) found = p;
        } catch {}
      }
    }
  };
  visit(root);
  return found;
}

function findSessionFile(sessionId) {
  if (!sessionId) return "";
  if (sessionFileCache.has(sessionId)) return sessionFileCache.get(sessionId);
  // 容错：客户端可能传入完整 id（session-<uuid>）或仅 uuid 部分，两种都试
  const cands = new Set([sessionId]);
  if (sessionId.startsWith("session-")) cands.add(sessionId.slice("session-".length));
  else cands.add("session-" + sessionId);
  let file = "";
  for (const c of cands) {
    file = walkForSession(join(dshHome(), "sessions"), c);
    if (file) break;
  }
  sessionFileCache.set(sessionId, file);
  capMap(sessionFileCache, CACHE_MAX);
  return file;
}

// ---------------------------------------------------------------------------
// 事件解析辅助
// ---------------------------------------------------------------------------
function extractRole(ev) {
  const t = ev && typeof ev.type === "string" ? ev.type : "";
  if (t === "user/message") return "user";
  if (t === "assistant/message") return "assistant";
  return "";
}

function extractText(ev) {
  const d = ev && ev.data;
  if (!d) return "";
  // user/message: data.content 为 [{ type:"text", text }]
  if (Array.isArray(d.content))
    return d.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  if (typeof d.content === "string") return d.content;
  // assistant/message: data.message.content 为 [{ type:"text"|"reasoning", text }]
  const mc = d.message && d.message.content;
  if (Array.isArray(mc))
    return mc
      .map((p) =>
        p && (p.type === "text" || p.type === "reasoning") && typeof p.text === "string"
          ? p.text
          : ""
      )
      .join("");
  if (typeof mc === "string") return mc;
  return "";
}

// ---------------------------------------------------------------------------
// 会话解析（文件 + transcript + provider/model + title）
// ---------------------------------------------------------------------------
const EMPTY = {
  title: "",
  files: [],
  transcript: [],
  truncated: false,
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
};

const parseCache = new Map(); // 文件 -> { mtimeMs, size, firstMagic, frameEnd, at, state }
// state = 增量累计状态；transcript 窗口与 seenFiles 上限的维护保证与「全量
// 解析的最近 N 条」语义完全一致（日志只追加，窗口 = 全量最近 N 条）。
const SEEN_FILES_MAX = 2000; // seenFiles 兜底上限（远大于任何档位的 filesTotal）

function freshParseState() {
  return { title: "", provider: "", model: "", reasoningEffort: "", seenFiles: new Map(), transcript: [] };
}

/** 逐行解析事件并累计进 state（增量与全量共用同一语义）。 */
function parseEventsInto(state, lines) {
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;

    // 标题
    if (ev.type === "session/title" && ev.data && typeof ev.data.title === "string")
      state.title = ev.data.title;
    else if (ev.type === "session" && typeof ev.title === "string") state.title = ev.title;

    // provider/model：取自 request/header（data.header.config）或 request/context
    // （data.provider/data.model），最后一次为准。
    if (ev.type === "request/header" && ev.data) {
      const cfg = (ev.data.config || (ev.data.header && ev.data.header.config)) || null;
      if (cfg) {
        if (cfg.provider) state.provider = String(cfg.provider);
        if (cfg.model) state.model = String(cfg.model);
        if (cfg.reasoningEffort !== undefined) state.reasoningEffort = String(cfg.reasoningEffort);
      }
    } else if (ev.type === "request/context" && ev.data) {
      if (ev.data.provider) state.provider = String(ev.data.provider);
      if (ev.data.model) state.model = String(ev.data.model);
      if (ev.data.reasoningEffort !== undefined) state.reasoningEffort = String(ev.data.reasoningEffort);
    }

    // 文件捕获：tool/code-dispatch* 事件
    if (ev.type === "tool/code-dispatch" || ev.type === "tool/code-dispatch-start") {
      const name = ev.data && ev.data.name;
      const args = (ev.data && ev.data.arguments) || {};
      if (name === "read" || name === "write" || name === "edit") {
        const p = typeof args.file_path === "string" ? args.file_path.trim() : "";
        if (p) {
          state.seenFiles.set(p, {
            path: p,
            op: name === "read" ? "read" : name === "edit" ? "edit" : "write",
          });
          if (state.seenFiles.size > SEEN_FILES_MAX) {
            state.seenFiles.delete(state.seenFiles.keys().next().value);
          }
        }
      } else if (
        (name === "grep" || name === "glob") &&
        typeof args.path === "string" &&
        args.path.trim() &&
        !state.seenFiles.has(args.path.trim())
      ) {
        state.seenFiles.set(args.path.trim(), { path: args.path.trim(), op: "search" });
      }
    }

    // transcript（窗口维护：只保留最近 L.msgs 条）
    const role = extractRole(ev);
    if (role === "user" || role === "assistant") {
      const text = extractText(ev);
      if (text) {
        state.transcript.push({ role, text });
        const L = ctxLen();
        if (state.transcript.length > L.msgs) state.transcript.shift();
      }
    }
  }
}

/**
 * 从字节偏移 from 起扫描完整 zstd 帧并解压（尾部半帧自动忽略，下次轮询
 * 续解）。返回 { text, end }：end 为最后一个完整帧的结束偏移。
 */
function decompressFrames(buf, from) {
  let offset = from;
  let out = "";
  for (;;) {
    const f = scanFrame(buf, offset);
    if (!f) break;
    try {
      out += zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    } catch {
      break;
    }
    offset = f.end;
    if (offset >= buf.length) break;
  }
  return { text: out, end: offset };
}

/** 把累计状态渲染为对外结果（按档位截断，与全量解析一致）。 */
function renderState(state) {
  const L = ctxLen();
  let transcript = state.transcript;
  let chars = transcript.reduce((n, m) => n + m.text.length, 0);
  if (chars > L.chars) {
    const kept = [];
    for (let i = transcript.length - 1; i >= 0; i--) {
      kept.unshift(transcript[i]);
      if (kept.reduce((n, m) => n + m.text.length, 0) > L.chars) {
        kept.shift();
        break;
      }
    }
    transcript = kept;
  }
  let files = [...state.seenFiles.values()];
  let truncated = false;
  if (files.length > L.filesTotal) {
    files = files.slice(files.length - L.filesTotal);
    truncated = true;
  }
  return {
    title: state.title,
    files,
    transcript,
    truncated,
    provider: state.provider || DEFAULT_PROVIDER,
    model: state.model || readGlobalModel(),
    reasoningEffort: state.reasoningEffort || "",
  };
}

/**
 * 会话解析（增量版）：大日志（实测 7MB 压缩 ≈ 20MB 文本）不再每次全量
 * 解压+逐行解析（约 600ms 同步阻塞，会拖慢同进程的聊天请求），而是只解
 * 自上次帧边界以来的新帧、累计进 state；文件被整体替换（首帧 magic 变化 /
 * 体积回退 / 帧边界失效）时自动回退全量解析。结果与全量解析逐字节等价。
 */
function parseSession(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return { ...EMPTY };
  let st;
  try {
    st = statSync(file);
  } catch {
    return { ...EMPTY };
  }
  const cached = parseCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return renderState(cached.state);

  const buf = readFileSync(file);
  const firstMagic = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
  let state = null;
  let frameEnd = buf.length;
  // 增量路径：同一文件（首帧 magic 相同）且缓存边界有效 → 只解新帧
  if (
    cached &&
    cached.firstMagic === firstMagic &&
    cached.frameEnd > 0 &&
    cached.frameEnd <= buf.length &&
    cached.size <= st.size
  ) {
    const inc = decompressFrames(buf, cached.frameEnd);
    if (inc.text) {
      state = cached.state;
      parseEventsInto(state, inc.text.split(/\r?\n/).filter(Boolean));
      frameEnd = inc.end;
    } else {
      // 无完整新帧（可能正在写半帧）：沿用旧状态，边界不动
      state = cached.state;
      frameEnd = cached.frameEnd;
    }
  }
  if (!state) {
    // 全量（无缓存 / 文件被替换 / 边界失效）
    let raw;
    try {
      raw = decompressZstd(buf);
    } catch {
      try {
        raw = buf.toString("utf8");
      } catch {
        return { ...EMPTY };
      }
    }
    state = freshParseState();
    parseEventsInto(state, raw.split(/\r?\n/).filter(Boolean));
    frameEnd = decompressFrames(buf, 0).end;
  }
  parseCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, firstMagic, frameEnd, at: Date.now(), state });
  capMap(parseCache, CACHE_MAX);
  return renderState(state);
}

/** 测试用：清空解析缓存。 */
function resetParseCacheForTest() {
  parseCache.clear();
}

// ---------------------------------------------------------------------------
// 文件上下文块：读取涉及文件的【当前磁盘内容】注入提问
// ---------------------------------------------------------------------------
function buildFileContext(sessionId) {
  const { files } = parseSession(sessionId);
  if (!files || files.length === 0) return "";
  const L = ctxLen();
  const picked = files.slice(0, L.filesInPrompt);
  const blocks = [];
  let total = 0;
  for (const f of picked) {
    if (total >= L.blockChars) break;
    let content = "";
    try {
      if (isAbsolute(f.path)) {
        // 先 stat：超大文件只读前 N KB；二进制跳过（避免 utf8 乱码注入）
        const st = statSync(f.path);
        if (st.isFile()) {
          const isBinary = (() => {
            const fd = fsp.openSync(f.path, "r");
            try {
              const buf = Buffer.alloc(4096);
              const n = fsp.readSync(fd, buf, 0, 4096, 0);
              for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
              return false;
            } finally {
              fsp.closeSync(fd);
            }
          })();
          if (isBinary) {
            content = `(二进制文件，${st.size} 字节，跳过内容注入)`;
          } else if (st.size > L.fileText) {
            const fd = fsp.openSync(f.path, "r");
            try {
              const buf = Buffer.alloc(L.fileText);
              const n = fsp.readSync(fd, buf, 0, L.fileText, 0);
              content = buf.toString("utf8", 0, n) + "\n…(文件过大，仅注入前 " + L.fileText + " 字节)";
            } finally {
              fsp.closeSync(fd);
            }
          } else {
            content = readFileSync(f.path, "utf8");
          }
        }
      }
    } catch {
      content = "(文件当前不存在于磁盘或无法读取)";
    }
    total += content.length;
    blocks.push(
      "### " + f.path + " [" + f.op + "]\n```\n" + content + "\n```"
    );
  }
  if (blocks.length === 0) return "";
  return (
    "## 当前会话涉及的文件（取当前磁盘内容；op: read=读取 / write=写入 / edit=编辑 / search=检索根目录）\n" +
    blocks.join("\n\n")
  );
}

// 将客户端消息拆分为「客户端 system」+「其余消息」，并拼上文件上下文块
function buildFinalPrompt(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const firstIsSystem = msgs.length && msgs[0] && msgs[0].role === "system";
  const clientSystem = firstIsSystem ? String(msgs[0].content || "") : "";
  const isBlank = (c) => {
    if (typeof c === "string") return c.trim().length === 0;
    if (Array.isArray(c)) return !c.some((p) => p && typeof p.text === "string" && p.text.trim().length > 0);
    return true;
  };
  const restAll = (firstIsSystem ? msgs.slice(1) : msgs).filter((m) => m && !isBlank(m.content));
  // 找到最后一条用户消息；它之前的全部临时会话消息作为「临时会话上下文」折叠进 system，
  // 避免把助手历史再以消息数组回灌给宿主 LLM（某些 provider 在多轮 assistant 回灌时
  // 会触发 DSH LLM 流协议 bug：finish chunk 缺 reason）。
  let lastUserIndex = -1;
  for (let i = restAll.length - 1; i >= 0; i--) {
    if (restAll[i] && restAll[i].role === "user") { lastUserIndex = i; break; }
  }
  const rest = lastUserIndex >= 0 ? [restAll[lastUserIndex]] : [];
  const textOf = (m) => {
    const c = m && m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
    return "";
  };
  const tempHistory = restAll.slice(0, lastUserIndex).map((m) => {
    const who = m.role === "assistant" ? "助手" : "用户";
    return "[" + who + "] " + textOf(m).slice(0, 4000);
  }).join("\n");
  const tempBlock = tempHistory
    ? "==== 临时会话上下文 ====\n" + tempHistory + "\n"

    : "";
  const fileBlock = buildFileContext(String(body.sessionId || "").trim());
  const system = (fileBlock ? fileBlock + "\n\n" : "") + (tempBlock ? tempBlock + "\n" : "") + clientSystem;
  return { system, rest };
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
function isLoopback(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(data.length),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// 路由：/context
// ---------------------------------------------------------------------------
async function handleContext(req, res) {
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
  try {
    const parsed = parseSession(sessionId);
    let updatedAt = 0;
    try {
      const file = findSessionFile(sessionId);
      if (file) updatedAt = statSync(file).mtimeMs;
    } catch {}
    if (url.searchParams.get("meta") === "1") {
      // 轻量轮询端点：只返回计数与指纹，避免每 2s 全量传输大 transcript
      sendJson(res, 200, {
        sessionId,
        title: parsed.title,
        msgs: parsed.transcript.length,
        files: parsed.files.length,
        truncated: parsed.truncated,
        provider: parsed.provider,
        model: parsed.model,
        updatedAt,
      });
      return;
    }
    sendJson(res, 200, { sessionId, ...parsed, updatedAt });
  } catch (err) {
    sendJson(res, 500, { error: String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------------------
// 路由：/ask（mode1 / mode2 流式代理；mode3 走 ctx.llm）
// ---------------------------------------------------------------------------
function officialMode1Model() {
  const m = (readGlobalModel() || "").trim();
  if (m === "deepseek-v4-pro" || m === "deepseek-v4-flash") return m;
  return DEFAULT_MODEL;
}

function resolveKeyForMode(mode, settings) {
  if (mode === "2") {
    const key = (settings && settings.apiKey ? String(settings.apiKey) : "").trim();
    const model = (settings && settings.model ? String(settings.model) : "") || DEFAULT_MODEL;
    const endpoint = (
      settings && settings.endpoint ? String(settings.endpoint) : ""
    ).replace(/\/+$/, "") || DEFAULT_BASE;
    return { key, model, base: endpoint, source: "plugin" };
  }
  return {
    key: readGlobalKey(),
    model: officialMode1Model(),
    base: globalBase(),
    source: "global",
  };
}

function hostErrorDetail(value) {
  if (!value) return "宿主 LLM 返回未知错误";
  if (typeof value === "string") return value;
  const failure = value.failure;
  return String(
    value.message ||
      value.detail ||
      value.error ||
      (failure && (failure.message || failure.detail || failure.code)) ||
      value.code ||
      JSON.stringify(value)
  );
}

function isRetryableHostError(value) {
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {}
  const detail = (hostErrorDetail(value) + " " + serialized).toLowerCase();
  return (
    detail.includes("overloaded") ||
    detail.includes("try again later") ||
    detail.includes("rate limit") ||
    detail.includes("too many requests") ||
    /(^|\D)429(\D|$)/.test(detail) ||
    /(^|\D)50[234](\D|$)/.test(detail)
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleAskMode3(req, res, body, sessionId) {
  if (!ctxRef || !ctxRef.llm || typeof ctxRef.llm.stream !== "function") {
    sendJson(res, 500, { error: "宿主 LLM 服务(ctx.llm)当前不可用" });
    return;
  }
  const { system, rest } = buildFinalPrompt(body);
  const parsed = parseSession(sessionId);
  const parsedProvider = parsed.provider || "";
  const parsedModel = parsed.model || "";
  const parsedReasoning = parsed.reasoningEffort || "";
  const globalProvider = readGlobalProvider();
  const provider = String(parsedProvider || body.provider || globalProvider || DEFAULT_PROVIDER);
  const model = String(parsedModel || body.model || readGlobalModel() || DEFAULT_MODEL);
  const llmMessages = rest.map((m) => ({
    role: m.role,
    content: [{ type: "text", text: String(m.content || "") }],
  }));

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  try {
    const llmOptions = { provider, model, system, messages: llmMessages };

    const globalReasoning = readGlobalReasoning();
    const reasoning = normalizeReasoningEffort(parsedReasoning || globalReasoning);
    if (reasoning !== undefined) llmOptions.reasoningEffort = reasoning;

    const maxAttempts = 3;
    let retriedWithoutReasoning = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let wroteText = false;
      let terminalError = null;
      try {
        const stream = ctxRef.llm.stream(llmOptions);
        for await (const chunk of stream) {
          if (!chunk) continue;
          if (chunk.type === "text-delta" && typeof chunk.text === "string") {
            wroteText = true;
            res.write(
              "data: " + JSON.stringify({ choices: [{ delta: { content: chunk.text } }] }) + "\n\n"
            );
          } else if (chunk.type === "error") {
            terminalError = chunk.error || chunk;
          } else if (chunk.type === "finish" && chunk.reason && chunk.reason.kind === "error") {
            terminalError = chunk.reason;
          }
        }
      } catch (err) {
        terminalError = err;
      }

      if (!terminalError) break;
      const canRetryWithoutReasoning =
        !retriedWithoutReasoning &&
        attempt < maxAttempts &&
        shouldRetryWithoutReasoning(terminalError, wroteText, llmOptions);
      if (canRetryWithoutReasoning) {
        delete llmOptions.reasoningEffort;
        retriedWithoutReasoning = true;
        continue;
      }
      const canRetry = !wroteText && attempt < maxAttempts && isRetryableHostError(terminalError);
      if (canRetry && !res.destroyed) {
        await wait(1000 * 2 ** (attempt - 1));
        continue;
      }
      res.write(
        "data: " +
          JSON.stringify({ error: "宿主 LLM 请求失败：" + hostErrorDetail(terminalError) }) +
          "\n\n"
      );
      break;
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    try {
      res.write(
        "data: " +
          JSON.stringify({ error: String((err && err.message) || err) }) +
          "\n\n"
      );
      res.write("data: [DONE]\n\n");
    } catch {}
    try {
      res.end();
    } catch {}
  }
}

async function handleAsk(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  const mode = String(body.mode || "1");
  const sessionId = String(body.sessionId || "").trim();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    sendJson(res, 400, { error: "messages 为空" });
    return;
  }

  if (mode === "3") {
    return handleAskMode3(req, res, body, sessionId);
  }

  const cfg = resolveKeyForMode(mode, body.pluginSettings || lastSettings);
  if (!cfg.key) {
    const msg =
      mode === "2"
        ? "插件 API Key 为空：请在临时会话面板「插件密钥」处填写，或在设置里配置 dsh-side-session.apiKey"
        : "DSH 全局 Key 为空：请先在 DSH 主程序配置 DeepSeek API Key（设置页或环境变量 DEEPSEEK_API_KEY）";
    sendJson(res, 400, { error: "no-key", message: msg });
    return;
  }

  const { system, rest } = buildFinalPrompt(body);
  const upstreamUrl = cfg.base + "/chat/completions";
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + cfg.key,
        "user-agent": "dsh-side-session",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: system }].concat(rest),
        stream: true,
      }),
    });
  } catch (err) {
    sendJson(res, 502, { error: "上游请求失败：" + String((err && err.message) || err) });
    return;
  }
  if (!upstream.ok) {
    const hint = await upstream.text().catch(() => "");
    sendJson(res, 502, {
      error: "上游返回 " + upstream.status + (hint ? "：" + hint.slice(0, 300) : ""),
    });
    return;
  }
  // 透传 SSE
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    try {
      res.write(
        "\ndata: " +
          JSON.stringify({ error: String((err && err.message) || err) }) +
          "\n\n"
      );
    } catch {}
    try {
      res.end();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------
let lastSettings = {};
let ctxRef = null;

const name = "@dsh-external/dsh-side-session";
const inject = ["settings", "webServer", "llm"];

function apply(ctx, config) {
  ctxRef = ctx;
  // 注册设置节（失败不阻断启动；重复注册 = 旧代 fiber 残留 → 摘除后重注册，热重载自愈）
  try {
    const scope = ctx.settings.register(NS, Config, { base: config || {} });
    lastSettings = scope.get();
    scope.watch(() => {
      lastSettings = scope.get();
    });
  } catch (err) {
    try {
      if (ctx.settings.registrations && ctx.settings.registrations.has(NS)) {
        ctx.settings.registrations.delete(NS);
        const scope = ctx.settings.register(NS, Config, { base: config || {} });
        lastSettings = scope.get();
        scope.watch(() => {
          lastSettings = scope.get();
        });
      }
    } catch (err2) {
      console.warn(
        "[dsh-side-session] 设置节注册失败（将使用默认配置）：" +
          String((err2 && err2.message) || err2)
      );
    }
  }

  const disposers = [];
  // 路由注册（重复 = 旧代 fiber 残留 → 摘除陈旧注册后重注册，热重载自愈）
  for (const route of [
    { kind: "exact", path: CONTEXT_ROUTE, handler: handleContext },
    { kind: "exact", path: ASK_ROUTE, handler: handleAsk },
  ]) {
    try {
      disposers.push(ctx.webServer.register(route));
    } catch (err) {
      try {
        const table = route.kind === "exact" ? ctx.webServer.exact : ctx.webServer.prefixes;
        if (table && table.has(route.path)) table.delete(route.path);
        disposers.push(ctx.webServer.register(route));
        console.warn("[dsh-side-session] 路由已摘除陈旧注册并重注册：" + route.path);
      } catch (err2) {
        console.warn(
          "[dsh-side-session] 路由注册失败（" + route.path + "）：" + String((err2 && err2.message) || err2)
        );
      }
    }
  }

  // 事件驱动的缓存失效：主对话有变化时清除该会话的解析缓存，
  // 让下一次 /context 立即重新解析日志（比 2s 轮询更及时）。
  // 数据源 = 日志解析（实测准确），不依赖未生效的自定义事件词汇猜测。
  try {
    disposers.push(
      ctx.effect(() => {
        const ds = [];
        if (typeof ctx.on === "function") {
          const invalidate = (s) => {
            const id = s && (typeof s === "string" ? s : s && s.id);
            if (!id) return;
            try {
              const file = findSessionFile(String(id));
              if (file) parseCache.delete(file);
            } catch {}
          };
          try {
            ds.push(ctx.on("session/event", invalidate));
            ds.push(ctx.on("agent/status", (e) => invalidate(e && e.agent)));
            ds.push(ctx.on("session/disposed", invalidate));
          } catch (err) {
            console.warn("[dsh-side-session] 事件订阅失败：" + String((err && err.message) || err));
          }
        }
        return () => { for (const d of ds) { try { d(); } catch {} } };
      }, "dsh-side-session: cache invalidation subscriptions")
    );
  } catch (err) {
    console.warn("[dsh-side-session] 事件订阅挂载失败：" + String((err && err.message) || err));
  }  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {}
    }
  };
}

export { apply, inject, name, parseSession, resetParseCacheForTest };
