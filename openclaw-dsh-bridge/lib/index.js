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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const BRIDGE_HOME = join(homedir(), ".dsh", "openclaw-bridge");
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
    const { agent } = await agents.create({
      sessionId: SessionId("session-" + randomUUID()),
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: void 0 });
      },
    });
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
    pool.delete("wx-" + sanitizeKey(from));
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

export { Config, apply, inject, name, PROVIDER_ID, OpenAiCompatAdapter };
