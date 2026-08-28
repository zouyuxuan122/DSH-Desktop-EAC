// @deepseek-ai/dsh-openclaw-bridge
// OpenClaw 网关 -> DSH 会话桥接插件（微信官方 ClawBot 插件的 DSH 侧端点）。
//
// 本插件在 DSH 的 webServer 服务上注册两条路由：
//   POST /openclaw-bridge/v1/chat/completions    OpenAI 兼容的对话端点（stream 与非 stream）
//   GET  /openclaw-bridge/health                 健康检查
//
// 设计要点：
//  - 会话映射：OpenClaw 端配置的 model 名 -> 一个常驻 DSH Agent（跨轮记忆与工具状态连续）；
//  - 注入 API：与官方 dsh-headless 一次性驱动器相同的核心调用链
//    （agents.create + agent.followup + agent.whenIdle + session.events）；
//  - 历史去重：OpenClaw 每轮回放完整 messages，本插件只注入"尚未注入过"的用户消息，
//    已注入计数随 history 压缩自动重置；
//  - 隔离：每个映射会话有独立工作目录 ~/.dsh/openclaw-bridge/workspace/<key>；
//  - 安全：回环地址免 token；非回环必须携带 Bearer token
//    （环境变量 OPENCLAW_BRIDGE_TOKEN，缺省时自动生成并持久化到
//    ~/.dsh/openclaw-bridge/token.txt）。

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

// 版本号随 package.json 走，避免硬编码漂移。
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
// 版本号自动跟随 package.json，不再硬编码。
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { createWechatClient } from "./wechat.js";
import { OpenAiCompatAdapter, PROVIDER_ID } from "./openai-compat.js";

const name = "@deepseek-ai/dsh-openclaw-bridge";
const inject = ["webServer", "agents", "sessions", "agentDefaultModel", "llm"];

// ---- 设置节（DSH 设置页的 ClawBot 栏）----
// 命名空间 "openclaw-bridge"：用户在设置页保存的配置经 settings 服务热生效。
const NS = settingsNamespace("openclaw-bridge");
const Config = z.object({
  // "provider/model" 或仅 "model"（provider 缺省时沿用 DSH 默认模型的 provider）；
  // 留空 = 使用 DSH 设置的默认模型。
  model: z.string().default(""),
  // 桥接 Bearer token；留空 = 环境变量 OPENCLAW_BRIDGE_TOKEN 或
  // ~/.dsh/openclaw-bridge/token.txt 自动生成值。
  token: z.string().default(""),
  // 微信会话的工作目录（绝对路径）；留空 = 使用隔离的桥接工作区。
  // 远程办公时把它指到你的真实项目目录（如 C:\Users\you\Desktop\work）。
  workspace: z.string().default(""),
  // 微信用户白名单（逗号分隔的 from_user_id，形如 xxx@im.wechat）；
  // 留空 = 允许所有给你发消息的人驱动 agent。
  allowlist: z.string().default(""),
  // 第三方 OpenAI 兼容端点（别家公司的模型）。customBaseURL 非空时，
  // 接收模型改走通用适配器（provider "openclaw-custom"，需 customModel）。
  customBaseURL: z.string().default(""),
  customApiKey: z.string().default(""),
  customModel: z.string().default(""),
});
let liveConfig = () => ({}); // 取配置的 getter；setSource 会被替换为 settings scope 读取器

const CHAT_ROUTE = "/openclaw-bridge/v1/chat/completions";
const HEALTH_ROUTE = "/openclaw-bridge/health";
const WECHAT_STATUS_ROUTE = "/openclaw-bridge/wechat/status";
const WECHAT_LOGIN_ROUTE = "/openclaw-bridge/wechat/login";
const WECHAT_VERIFY_ROUTE = "/openclaw-bridge/wechat/verify";
const WECHAT_LOGOUT_ROUTE = "/openclaw-bridge/wechat/logout";
const MAX_BODY = 4 * 1024 * 1024;
const MAX_AGENTS = 16;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 100;

// ---- 鉴权 token（设置 > 环境变量 > 自动生成并持久化） ----
// EAC 修复：尊重 DSH_HOME 环境变量（上游硬编码 homedir —— 桌面端自定义
// DSH_HOME / 测试隔离环境下桥接数据会写错位置；与本文件 sessions 扫描处
// 的解析保持一致）。
const BRIDGE_HOME = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "openclaw-bridge");

// ---- key -> 常驻会话映射持久化（跨重启记忆连续） ----
// 旧版把 key -> agent 的映射只放在内存 pool 里：DSH 桌面端重启后 pool 清空，
// 每个 key（微信用户 / model 名）都会用新随机 id 新建会话，之前的对话记忆
// （上下文）随之丢失，旧会话文件成为孤儿。现在把 key -> sessionId 落盘到
// ~/.dsh/openclaw-bridge/session-map.json：重启后按映射 resume 原会话；
// 映射缺失（升级前的老用户）时按工作区目录扫描会话日志，自动恢复最近的
// 会话（会话日志头部带顶层 cwd 字段，与 dsh-side-session 同源的 zstd 帧
// 扫描手法，只解压首个帧即可读头，成本可忽略）。
const SESSION_MAP_FILE = join(BRIDGE_HOME, "session-map.json");
const SESSION_MAP_MAX = 200;

function loadSessionMap() {
  try {
    if (existsSync(SESSION_MAP_FILE)) {
      const parsed = JSON.parse(readFileSync(SESSION_MAP_FILE, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return {};
}

let sessionMap = loadSessionMap();

function saveSessionMap() {
  try {
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(sessionMap, null, 2) + "\n");
  } catch (err) {
    console.warn("[openclaw-bridge] 会话映射持久化失败: " + String(err?.message || err));
  }
}

/** 记录/更新 key 的常驻会话；超过上限时按 createdAt 淘汰最旧条目。 */
function sessionMapSet(key, sessionId, cwd) {
  sessionMap[key] = {
    sessionId: String(sessionId || ""),
    cwd: String(cwd || ""),
    createdAt: new Date().toISOString(),
  };
  const keys = Object.keys(sessionMap);
  if (keys.length > SESSION_MAP_MAX) {
    const sorted = keys.slice().sort((a, b) =>
      String(sessionMap[a].createdAt || "").localeCompare(String(sessionMap[b].createdAt || ""))
    );
    for (const k of sorted.slice(0, keys.length - SESSION_MAP_MAX)) delete sessionMap[k];
  }
  saveSessionMap();
}

function sessionMapDelete(key) {
  if (key in sessionMap) {
    delete sessionMap[key];
    saveSessionMap();
  }
}

/** 测试用：读取当前映射快照 / 重置映射（含删文件）。 */
function sessionMapSnapshot() {
  return { ...sessionMap };
}
function sessionMapReset() {
  sessionMap = {};
  try {
    if (existsSync(SESSION_MAP_FILE)) writeFileSync(SESSION_MAP_FILE, "{}\n");
  } catch {}
}

// ---- 会话日志头部读取（zstd 单帧扫描 + 首行解析）----
const ZSTD_MAGIC = 4247762216; // 28 B5 2F FD little-endian

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

/** 读会话日志头部事件（只解压首个 zstd 帧；失败返回 null）。 */
function sessionLogHead(file) {
  try {
    const buf = readFileSync(file);
    const f = scanFrame(buf, 0);
    if (!f) return null;
    const firstLine = zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8").split("\n", 1)[0];
    const head = JSON.parse(firstLine);
    return head && typeof head === "object" ? head : null;
  } catch {
    return null;
  }
}

function normPath(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}

/**
 * 扫描 <DSH_HOME>/sessions 下 cwd 匹配的会话，返回最近（按日志 mtime）的 id。
 * 用于升级后首次启动的自动恢复：映射文件缺失时把老会话找回来。
 */
function findLatestSessionForCwd(cwd) {
  const target = normPath(cwd);
  if (!target) return null;
  const root = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
  let best = null; // { id, mtime }
  const visit = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      const logFile = join(p, "session.jsonl.zstd");
      if (existsSync(logFile)) {
        try {
          const head = sessionLogHead(logFile);
          if (head && typeof head.cwd === "string" && normPath(head.cwd) === target) {
            const st = statSync(logFile);
            if (!best || st.mtimeMs > best.mtime) best = { id: String(head.id || ""), mtime: st.mtimeMs };
          }
        } catch {}
        continue; // 会话目录不嵌套
      }
      visit(p);
    }
  };
  visit(root);
  return best && best.id ? best.id : null;
}

let bridgeToken = String(process.env.OPENCLAW_BRIDGE_TOKEN || "").trim();
if (!bridgeToken) {
  const tokenFile = join(BRIDGE_HOME, "token.txt");
  try {
    mkdirSync(BRIDGE_HOME, { recursive: true });
    if (existsSync(tokenFile)) {
      bridgeToken = readFileSync(tokenFile, "utf8").trim();
    } else {
      bridgeToken = randomBytes(24).toString("hex");
      writeFileSync(tokenFile, bridgeToken);
      console.log("[openclaw-bridge] generated bridge token: " + tokenFile);
    }
  } catch {
    // 持久化失败时仅回环可用
  }
}

/** 生效 token：设置节 token > 环境变量/文件 token。 */
function effectiveToken() {
  const cfg = liveConfig() || {};
  const t = String(cfg.token || "").trim();
  return t || bridgeToken;
}

/** 生效模型选择：自定义 OpenAI 兼容端点 > 设置节 model 覆盖 > DSH 默认模型。 */
function resolveSelection(defaultModel) {
  const fallback = defaultModel.currentSelection();
  const cfg = liveConfig() || {};
  const customBase = String(cfg.customBaseURL || "").trim();
  if (customBase) {
    const customModel = String(cfg.customModel || "").trim();
    return { provider: "openclaw-custom", model: customModel || "" };
  }
  const override = String(cfg.model || "").trim();
  if (!override) return fallback;
  const slash = override.indexOf("/");
  if (slash > 0) {
    const provider = override.slice(0, slash);
    const model = override.slice(slash + 1);
    if (provider && model) return { provider, model };
  } else if (fallback) {
    return { provider: fallback.provider, model: override };
  }
  return fallback;
}

// ---- 小工具 ----
function isLoopback(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function authorized(req) {
  if (isLoopback(req)) return true;
  const token = effectiveToken();
  if (!token) return false;
  const auth = String(req.headers["authorization"] || "");
  if (auth === "Bearer " + token) return true;
  return String(req.headers["x-openclaw-bridge-token"] || "") === token;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

function writeSse(res, payload) {
  try {
    res.write("data: " + JSON.stringify(payload) + "\n\n");
  } catch {
    // 客户端已断开
  }
}

function openAiError(status, message, type = "invalid_request_error") {
  return { error: { message, type, code: status } };
}

function chatId() {
  return "chatcmpl-" + randomUUID().replace(/-/g, "");
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(httpError(504, message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** OpenAI messages 里 content 可能是 string 或 part 数组，只取文本。 */
function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p && typeof p === "object" && (p.type === "text" || p.type === "input_text")) {
          return p.text || "";
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

/** model 名 -> 安全 key（杜绝路径穿越：纯点/空 key 归位 default）。 */
function sanitizeKey(model) {
  let key = String(model || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!key || /^\.+$/.test(key)) key = "default";
  return key;
}

function workspaceFor(key) {
  const dir = join(BRIDGE_HOME, "workspace", key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- agent 池：key -> 常驻 agent 记录 ----
const pool = new Map(); // key -> { key, agent, chain, lastUserCount, lastText, sessions }

async function ensureAgent(ctx, key, cwdOverride) {
  let rec = pool.get(key);
  if (rec) return rec;
  if (pool.size >= MAX_AGENTS) throw httpError(429, "bridge agent limit reached (" + MAX_AGENTS + ")");
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const defaultModel = ctx.get("agentDefaultModel");
  if (!agents || !sessions || !defaultModel) throw httpError(503, "DSH core agent services unavailable");
  const selection = resolveSelection(defaultModel);
  if (!selection) throw httpError(503, "no model configured (set one in Settings > ClawBot or DSH default model)");
  if (selection.provider === PROVIDER_ID && !selection.model) {
    throw httpError(400, "customBaseURL is set but customModel is empty — fill the model name in Settings > ClawBot");
  }
  let cwd = workspaceFor(key);
  if (cwdOverride && String(cwdOverride).trim()) {
    cwd = String(cwdOverride).trim();
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      throw httpError(400, "workspace is not a valid directory: " + cwd);
    }
  }
  rec = { key, agent: null, chain: Promise.resolve(), lastUserCount: 0, lastText: "", sessions, ready: null };
  pool.set(key, rec);
  // S1 修复：并发首建竞态——ready 缓存 in-flight 创建 Promise，
  // 第二个并发请求 await rec.ready 而非直接触碰 null agent。
  rec.ready = (async () => {
    let agent = null;
    // 1) 映射命中 → resume 原会话（跨重启记忆连续）
    const mapped = sessionMap[key];
    if (mapped && mapped.sessionId) {
      try {
        const resumed = await agents.resume({
          resumeSessionId: mapped.sessionId,
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: (agentCtx) => {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 });
          },
        });
        agent = resumed.agent;
        console.log("[openclaw-bridge] resumed session for key '" + key + "' (" + mapped.sessionId + ")");
      } catch (err) {
        console.warn("[openclaw-bridge] 恢复映射会话失败（降级重建）: " + String(err?.message || err));
        sessionMapDelete(key);
      }
    }
    // 2) 无映射/恢复失败 → 按工作区扫描最近会话（老用户升级路径，自动找回）
    if (!agent) {
      try {
        const latestId = findLatestSessionForCwd(cwd);
        if (latestId) {
          const resumed = await agents.resume({
            resumeSessionId: latestId,
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => {
              installModelSelection(agentCtx, { current: selection, assembled: void 0 });
            },
          });
          agent = resumed.agent;
          console.log("[openclaw-bridge] recovered latest session for key '" + key + "' (" + latestId + ")");
        }
      } catch (err) {
        console.warn("[openclaw-bridge] 扫描恢复会话失败（降级新建）: " + String(err?.message || err));
      }
    }
    // 3) 都没有 → 新建会话并记录映射
    if (!agent) {
      const sessionId = SessionId("session-" + randomUUID());
      const created = await agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: void 0 });
        },
      });
      agent = created.agent;
      console.log("[openclaw-bridge] created session for key '" + key + "'");
    }
    sessionMapSet(key, agent && agent.session ? agent.session.id : "", cwd);
    await agent.whenIdle();
    rec.agent = agent;
    console.log("[openclaw-bridge] agent ready for key '" + key + "' (cwd: " + cwd + ")");
  })();
  try {
    await rec.ready;
  } catch (err) {
    pool.delete(key);
    throw err;
  }
  return rec;
}

/** 等待记录的 agent 就绪（含并发首建的 in-flight 创建）。 */
async function readyRec(rec) {
  if (rec && rec.ready) await rec.ready;
  return rec;
}

// ---- 微信用户 -> 会话绑定（/attach 接管已有 DSH 会话） ----
const wxBinds = new Map(); // from_user_id -> rec（可能指向池外会话）

/** 包装一个已有的 live agent 为可驱动记录（/attach 用）。 */
function wrapAgent(ctx, agent) {
  return {
    key: "attached",
    agent,
    chain: Promise.resolve(),
    lastUserCount: 0,
    lastText: "",
    sessions: ctx.get("sessions"),
    ready: Promise.resolve(),
  };
}

/** 按会话 id 取活体 agent，否则从持久化恢复（与 dsh-host-apiproxy ensureSession 同构）。 */
async function attachRec(ctx, sessionId) {
  const agents = ctx.get("agents");
  if (!agents) throw new Error("agents service unavailable");
  const live = agents.get ? agents.get(sessionId) : void 0;
  if (live !== void 0) return wrapAgent(ctx, live);
  const defaultModel = ctx.get("agentDefaultModel");
  const selection = defaultModel ? resolveSelection(defaultModel) : void 0;
  if (!selection) throw new Error("no model configured");
  const persistence = ctx.get("sessionPersistence");
  if (persistence) {
    const stored = (await persistence.list()).find((header) => header && header.id === sessionId);
    if (stored !== void 0) {
      const { agent } = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: void 0 });
        },
      });
      return wrapAgent(ctx, agent);
    }
  }
  throw new Error("session not found: " + sessionId);
}

/** 取 firstSeq 之后最后一条 assistant 文本（与 dsh-headless 的 summarize 同构）。 */
function lastAssistantText(agent, firstSeq) {
  let text = "";
  for (const event of agent.session.events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data?.message?.content || [])
        .filter((b) => b && b.type === "text")
        .map((b) => b.text || "")
        .join("");
      if (joined) text = joined;
    }
  }
  return text;
}

/**
 * 注入本轮新用户消息并驱动到 idle；emit 存在时按 100ms 轮询事件流推送增量文本。
 */
async function runTurn(rec, toInject, emit) {
  await readyRec(rec);
  const agent = rec.agent;
  await agent.whenIdle(); // 吸收上一轮超时后仍在跑的回合
  if (toInject.length === 0) return { text: rec.lastText, reason: { kind: "skipped" } };
  const firstSeq = agent.session.seq;
  let timer = null;
  let emitted = 0;
  if (emit) {
    timer = setInterval(() => {
      const text = lastAssistantText(agent, firstSeq);
      if (text.length > emitted) {
        emit(text.slice(emitted));
        emitted = text.length;
      }
    }, POLL_MS);
  }
  try {
    for (const text of toInject) {
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        })
      );
      await withTimeout(agent.whenIdle(), TURN_TIMEOUT_MS, "agent turn exceeded " + TURN_TIMEOUT_MS + "ms");
    }
    await rec.sessions.flush(agent.session);
  } finally {
    if (timer) clearInterval(timer);
  }
  let text = lastAssistantText(agent, firstSeq);
  if (emit && text.length > emitted) emit(text.slice(emitted));
  let reason;
  for (const event of agent.session.events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/end") reason = event.data?.reason;
  }
  if (reason && reason.kind === "error") {
    const err = new Error((reason.error && reason.error.message) || "agent turn failed");
    err.status = 502;
    throw err;
  }
  rec.lastText = text;
  return { text, reason };
}

// ---- 微信指令 ----
const HELP_TEXT = [
  "/help —— 查看指令",
  "/new —— 开启新会话（丢弃当前绑定）",
  "/list —— 列出可接管的 DSH 会话（live + 已持久化）",
  "/attach <会话id> —— 接管一个已有的 DSH 会话，之后的消息都进入该会话",
  "其余消息 —— 发给当前绑定的会话（默认每个微信用户一个独立会话）",
].join("\n");

async function handleWechatCommand(ctx, m, text, replyTo) {
  const from = String(m.from || "");
  const parts = text.slice(1).split(/\s+/).filter(Boolean);
  const cmd = (parts[0] || "").toLowerCase();
  const arg = parts[1] || "";

  if (cmd === "help") {
    await replyTo(HELP_TEXT);
    return;
  }

  if (cmd === "new") {
    wxBinds.delete(from);
    const nk = "wx-" + sanitizeKey(from);
    pool.delete(nk);
    sessionMapDelete(nk); // 同时清除持久化映射，下次消息不再 resume 旧会话
    await replyTo("已开启新会话，下一条消息开始全新上下文。");
    return;
  }

  if (cmd === "list") {
    const agents = ctx.get("agents");
    const persistence = ctx.get("sessionPersistence");
    const rows = [];
    if (agents && agents.list) {
      for (const agent of agents.list()) {
        const session = agent && agent.session;
        if (!session) continue;
        rows.push("live  " + session.id + "  (" + (session.meta?.cwd || "?") + ")");
      }
    }
    if (persistence) {
      const stored = await persistence.list();
      for (const header of stored) {
        if (agents && agents.get && agents.get(header.id)) continue; // 已在 live 列表
        rows.push("saved " + header.id + "  (" + (header.meta?.cwd || header.cwd || "?") + ")");
      }
    }
    if (rows.length === 0) {
      await replyTo("没有可列出的会话。");
    } else {
      await replyTo("可用会话（/attach <id> 接管）：\n" + rows.slice(0, 15).join("\n") + (rows.length > 15 ? "\n…（仅显示前 15 条）" : ""));
    }
    return;
  }

  if (cmd === "attach") {
    if (!arg) {
      await replyTo("用法：/attach <会话id>（id 用 /list 查看）");
      return;
    }
    const rec = await attachRec(ctx, arg);
    wxBinds.set(from, rec);
    // 持久化接管关系：重启后该微信用户仍回到被接管的会话（记忆连续）。
    sessionMapSet("wx-" + sanitizeKey(from), arg, (rec.agent && rec.agent.session && rec.agent.session.meta && rec.agent.session.meta.cwd) || "");
    await replyTo("已接管会话 " + arg + "，之后的消息都进入该会话。");
    return;
  }

  await replyTo("未知指令：" + cmd + "。发送 /help 查看可用指令。");
}

// ---- 路由 ----
async function handleChat(ctx, req, res) {
  if (req.method === "GET") {
    sendJson(res, 405, openAiError(405, "use POST " + CHAT_ROUTE));
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, openAiError(405, "method not allowed"));
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, openAiError(401, "missing or invalid bridge token", "authentication_error"));
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, openAiError(400, "invalid JSON body"));
    return;
  }
  const model = typeof body.model === "string" && body.model ? body.model : "default";
  const key = sanitizeKey(model);
  const stream = body.stream === true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userTexts = messages
    .filter((m) => m && m.role === "user")
    .map((m) => textOf(m.content))
    .filter((t) => t.length > 0);

  let rec;
  try {
    rec = await ensureAgent(ctx, key);
  } catch (err) {
    sendJson(res, err.status || 503, openAiError(err.status || 503, String(err?.message || err), "server_error"));
    return;
  }

  // 历史去重：OpenClaw 每轮回放完整 messages，只注入尚未注入的用户消息。
  // M3 修复：计数在回合成功后才推进，失败重试不会静默返回旧答案。
  const expectedCount = userTexts.length;
  const toInject = expectedCount >= rec.lastUserCount ? userTexts.slice(rec.lastUserCount) : userTexts.slice();

  const id = chatId();
  const created = Math.floor(Date.now() / 1000);
  const task = () =>
    runTurn(
      rec,
      toInject,
      stream
        ? (delta) =>
            writeSse(res, {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })
        : null
    ).then((result) => {
      rec.lastUserCount = expectedCount; // 成功后才推进去重计数
      return result;
    });
  const work = rec.chain.then(task, task);
  rec.chain = work.then(
    () => {},
    () => {}
  );

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    work.then(
      () => {
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
      },
      (err) => {
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: String(err?.message || err) }, finish_reason: "error" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
      }
    );
    return;
  }

  try {
    const result = await work;
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    sendJson(res, err.status || 500, openAiError(err.status || 500, String(err?.message || err), "server_error"));
  }
}

function handleHealth(ctx, req, res) {
  sendJson(res, 200, {
    ok: true,
    service: name,
    version: PLUGIN_VERSION,
    agents: [...pool.keys()],
    workspace: join(BRIDGE_HOME, "workspace"),
    servicesReady: Boolean(ctx.get("agents") && ctx.get("agentDefaultModel")),
    tokenConfigured: Boolean(effectiveToken()),
    model: (liveConfig() || {}).model || "(default)",
  });
}

function apply(ctx, config) {
  liveConfig = () => config || {};
  // 通用 OpenAI 兼容 provider：每次调用经 liveConfig() 读 baseURL/key/model，热生效
  const customAdapter = new OpenAiCompatAdapter(() => {
    const cfg = liveConfig() || {};
    return { baseURL: cfg.customBaseURL, apiKey: cfg.customApiKey, model: cfg.customModel };
  });
  const customRegistration = ctx.llm.registerAdapter([PROVIDER_ID], customAdapter);
  installSettingsSection(ctx, NS, Config, config || {}, {
    setSource: (source) => {
      liveConfig = source; // source 是 () => scope.get() 的取值函数
    },
    onChange: () => {
      // 新映射会话（新 model 名）会使用新配置；已有会话保持连续性。
      // 日志脱敏：token/apiKey 不回显明文。
      const cfg = liveConfig() || {};
      const redacted = { ...cfg };
      if (redacted.token) redacted.token = "***";
      if (redacted.customApiKey) redacted.customApiKey = "***";
      console.log("[openclaw-bridge] settings updated: " + JSON.stringify(redacted));
    },
  });
  const disposeChat = ctx.webServer.register({ kind: "exact", path: CHAT_ROUTE, handler: (req, res) => handleChat(ctx, req, res) });
  const disposeHealth = ctx.webServer.register({
    kind: "exact",
    path: HEALTH_ROUTE,
    handler: (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: "health is loopback-only" });
        return;
      }
      return handleHealth(ctx, req, res);
    },
  });

  // ---- 微信 iLink 渠道（直连，不经 OpenClaw） ----
  const wechat = createWechatClient({
    sessionFile: join(BRIDGE_HOME, "wechat-session.json"),
    onState: (s) => {
      console.log("[openclaw-bridge] wechat: " + JSON.stringify(s));
    },
    onMessage: async (m) => {
      const from = String(m.from || "");
      const text = String(m.text || "").trim();
      if (!text) return;

      // 白名单：设置后只允许列出的微信用户驱动 agent（其他消息静默忽略，省配额）
      const allow = String((liveConfig() || {}).allowlist || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allow.length > 0 && !allow.includes(from)) {
        console.log("[openclaw-bridge] wechat: message from non-allowlisted user ignored: " + from);
        return;
      }

      const replyTo = async (t) => {
        try {
          await wechat.sendText(from, String(t).slice(0, 2000), m.contextToken);
        } catch {
          // 发送失败也忽略
        }
      };

      // 指令：/help /new /list /attach
      if (text.startsWith("/")) {
        try {
          await handleWechatCommand(ctx, m, text, replyTo);
        } catch (err) {
          console.error("[openclaw-bridge] wechat command failed: " + String(err?.message || err));
          await replyTo("指令执行出错：" + String(err?.message || err).slice(0, 400));
        }
        return;
      }

      // 普通消息 → 该用户的绑定会话（默认映射或 /attach 接管的会话）
      const key = "wx-" + sanitizeKey(from);
      try {
        let rec = wxBinds.get(from);
        if (!rec) {
          const ws = String((liveConfig() || {}).workspace || "").trim();
          rec = await ensureAgent(ctx, key, ws || undefined);
          wxBinds.set(from, rec);
        }
        const task = () => runTurn(rec, [text], null);
        const work = rec.chain.then(task, task);
        rec.chain = work.then(
          () => {},
          () => {}
        );
        const result = await work;
        const reply = (result.text || "").trim() || "（本轮没有文本回复）";
        const send = await wechat.sendText(from, reply, m.contextToken);
        console.log(
          "[openclaw-bridge] wechat reply to " + key + ": ok=" + send.ok +
            (send.errmsg ? " errmsg=" + send.errmsg : "") + (send.ret !== void 0 ? " ret=" + send.ret : "")
        );
      } catch (err) {
        console.error("[openclaw-bridge] wechat turn failed: " + String(err?.message || err));
        await replyTo("处理出错：" + String(err?.message || err).slice(0, 500));
      }
    },
  });

  const wechatOnly = (handler) => (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: "wechat control routes are loopback-only" });
      return;
    }
    return handler(req, res); // 返回 Promise 让调用方正确 await/捕获
  };

  const disposeWxStatus = ctx.webServer.register({
    kind: "exact",
    path: WECHAT_STATUS_ROUTE,
    handler: wechatOnly((req, res) => sendJson(res, 200, wechat.status())),
  });
  const disposeWxLogin = ctx.webServer.register({
    kind: "exact",
    path: WECHAT_LOGIN_ROUTE,
    handler: wechatOnly(async (req, res) => {
      try {
        await wechat.startLogin();
        sendJson(res, 200, wechat.status());
      } catch (err) {
        sendJson(res, 502, { error: String(err?.message || err) });
      }
    }),
  });
  const disposeWxVerify = ctx.webServer.register({
    kind: "exact",
    path: WECHAT_VERIFY_ROUTE,
    handler: wechatOnly(async (req, res) => {
      try {
        const body = JSON.parse(await readBody(req));
        const ok = wechat.submitVerify(body && body.code);
        sendJson(res, ok ? 200 : 400, wechat.status());
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
      }
    }),
  });
  const disposeWxLogout = ctx.webServer.register({
    kind: "exact",
    path: WECHAT_LOGOUT_ROUTE,
    handler: wechatOnly((req, res) => {
      wechat.logout();
      sendJson(res, 200, wechat.status());
    }),
  });

  const port = ctx.webServer.port || "?";
  console.log(
    "[openclaw-bridge] mounted on http://127.0.0.1:" + port + CHAT_ROUTE +
      " | health: http://127.0.0.1:" + port + HEALTH_ROUTE +
      " | wechat: http://127.0.0.1:" + port + WECHAT_STATUS_ROUTE +
      " | workspace: " + join(BRIDGE_HOME, "workspace") +
      " | token: " + (bridgeToken ? "enabled" : "unavailable (loopback-only)")
  );
  return () => {
    disposeChat();
    disposeHealth();
    disposeWxStatus();
    disposeWxLogin();
    disposeWxVerify();
    disposeWxLogout();
    wechat.dispose();
    customRegistration();
  };
}

export {
  Config, apply, inject, name, PROVIDER_ID, OpenAiCompatAdapter,
  // 会话映射持久化（测试与诊断用）
  sessionMapSnapshot, sessionMapReset, sessionMapSet, sessionMapDelete, findLatestSessionForCwd,
};
