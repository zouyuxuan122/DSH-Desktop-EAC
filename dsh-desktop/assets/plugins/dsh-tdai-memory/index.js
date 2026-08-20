/**
 * dsh-tdai-memory — TencentDB Agent Memory ported into DeepSeek Harness.
 *
 * Reuses the host-neutral core of `tdai-memory-openclaw-plugin`
 * (TdaiCore: L0 conversation capture -> L1 structured facts -> L2 scenes ->
 * L3 persona; vector recall; memory/conversation search) through a thin
 * DshHostAdapter. The existing data directory (~/.memory-tencentdb/memory-tdai)
 * is reused as-is, so previously accumulated memories stay available.
 *
 * Wiring:
 *  - `session/event` (turn/start, turn/end) -> L0 capture + pipeline trigger
 *  - `system-prompt/assemble` waterfall -> per-turn recall injection
 *    (relevant L1 memories + L3 persona + L2 scene navigation)
 *  - tools `tdai_memory_search` / `tdai_conversation_search`
 *  - LLM calls (L1/L2/L3 extraction) go through the standalone OpenAI-
 *    compatible runner (config `llm`, falls back to TDAI_LLM_* env vars)
 *  - embeddings through the configurable OpenAI-compatible endpoint
 *    (defaults to the local Qwen3-Embedding-0.6B service on :8088)
 */
import os from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { TdaiCore } from "./vendor/tdai/core/tdai-core.js";
import { parseConfig } from "./vendor/tdai/config.js";
import { StandaloneHostAdapter } from "./vendor/tdai/adapters/standalone/host-adapter.js";
import { ensureSettingsNamespaceExposed } from "./vendor/dsh-settings-expose.js";

/** Cordis plugin name. */
const name = "tdai-memory";
/** Services this row injects. */
const inject = ["sessions", "systemPrompt", "tools"];
/** Settings namespace owned by this plugin (Web UI settings section). */
const NS = settingsNamespace("tdai-memory");

/** Runtime schema for the tdai-memory row. */
const Config = z.object({
  /** TDAI data directory; default: ~/.memory-tencentdb/memory-tdai. */
  dataDir: z.string().default(""),
  /** LLM used for L1/L2/L3 extraction (OpenAI-compatible). Falls back to TDAI_LLM_* env. */
  llm: z.object({
    baseUrl: z.string().default(""),
    apiKey: z.string().default("").role("secret"),
    model: z.string().default(""),
    maxTokens: z.number().default(4096),
    timeoutMs: z.number().default(120000),
  }),
  /** Embedding endpoint (OpenAI-compatible /v1/embeddings). */
  embedding: z.object({
    baseUrl: z.string().default("http://127.0.0.1:8088/v1"),
    apiKey: z.string().default("").role("secret"),
    model: z.string().default("Qwen3-Embedding-0.6B"),
    dimensions: z.number().default(1024),
    sendDimensions: z.boolean().default(false),
  }),
  /** Capture conversations into L0. */
  captureEnabled: z.boolean().default(true),
  /** L1 extraction pipeline (facts from conversations). */
  extraction: z.object({
    enabled: z.boolean().default(true),
    /** Conflict detection before storing; extra LLM call, disable if flaky.
     *  Off by default: dedup LLM output parsing is flaky (README matches). */
    enableDedup: z.boolean().default(false),
  }),
  /** Recall injection settings. */
  recall: z.object({
    enabled: z.boolean().default(true),
    maxResults: z.number().default(5),
    scoreThreshold: z.number().default(0.3),
    timeoutMs: z.number().default(3000),
  }),
  /** Register the two search tools. */
  toolsEnabled: z.boolean().default(true),
});

/** Extract plain text from a dsh message content (block array or string). */
function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function apply(ctx, config) {
  // ── build-once state (rebuildable) ───────────────────────────────────────
  // TdaiCore is built from the RESOLVED settings value (composition entry as
  // base, `tdai-memory` settings section / settings.yaml as user layer), so
  // keys stored in settings.yaml (llm.apiKey etc.) are honored. The settings
  // inject callback that drives `installSettingsSection`'s setSource is
  // scheduled by cordis as a plugin start — it ALWAYS runs after any 0ms
  // timer — so the no-settings fallback below cannot be allowed to win the
  // race. Instead of racing, we let the fallback build from the entry config
  // first (guaranteeing a working core even without settings), and REBUILD
  // from the resolved settings when the settings mount arrives. The fallback
  // is a one-shot; the settings build always wins afterwards.
  let core = null;
  let tdaiConfig = null;
  let dataDir = "";
  let builtOnce = false;

  /** turn id of the last turn/end per session (capture trigger). */
  const lastTurnEnd = new Map();
  /** turn ids already captured per session (dedup across flushes). */
  const capturedTurns = new Map();
  /** turn/start timestamp per session (L0 capture cursor floor). */
  const turnStarts = new Map();
  /** session keys seen this process (for final L1 flush on teardown). */
  const seenSessions = new Set();
  /** recall cache per session: same user text within TTL reuses the result. */
  const recallCache = new Map();
  const RECALL_CACHE_TTL_MS = 30_000;

  // One-shot mode (dsh --profile headless): the process exits right after
  // flush, so L1 must finish inside the flush listener. In web mode the
  // long-lived process runs the pipeline in the background instead.
  const isOneShot = process.argv.some((arg) => arg === "headless");

  // Verbose tdai-internal logging goes to the console only when explicitly
  // enabled; routine diagnostics use the dsh logger.
  const verbose = !!process.env.DSH_TDAI_DEBUG;
  const log = (level, m) => {
    if (verbose) console.error(`[tdai-memory] ${m}`);
    else if (level === "warn") ctx.logger.warn(`[tdai-memory] ${m}`);
    else if (level === "error") ctx.logger.error(`[tdai-memory] ${m}`);
  };
  const logger = {
    debug: (m) => log("debug", m),
    info: (m) => log("info", m),
    warn: (m) => log("warn", m),
    error: (m) => log("error", m),
  };

  // ── core construction (rebuildable) ──────────────────────────────────────
  async function build(cfg) {
    if (cfg?.llm?.apiKey) {
      log("debug", `build: using settings config (apiKey=${cfg.llm.apiKey.slice(0, 6)}…)`);
    }
    // Tear down the previous core, if any (first build has none).
    const previous = core;
    if (previous) {
      await previous.destroy().catch((error) => {
        log("warn", `previous core destroy failed: ${String(error)}`);
      });
    }
    dataDir = cfg.dataDir || join(os.homedir(), ".memory-tencentdb", "memory-tdai");
    const nextConfig = parseConfig({
      timezone: "system",
      storeBackend: "sqlite",
      capture: { enabled: cfg.captureEnabled },
      extraction: { enabled: cfg.extraction.enabled, enableDedup: cfg.extraction.enableDedup },
      recall: { ...cfg.recall },
      embedding: {
        enabled: true,
        provider: "openai",
        baseUrl: cfg.embedding.baseUrl,
        apiKey: cfg.embedding.apiKey,
        model: cfg.embedding.model,
        dimensions: cfg.embedding.dimensions,
        sendDimensions: cfg.embedding.sendDimensions,
        timeoutMs: 10000,
      },
      llm: {
        enabled: true,
        baseUrl: cfg.llm.baseUrl || process.env.TDAI_LLM_BASE_URL || "",
        apiKey: cfg.llm.apiKey || process.env.TDAI_LLM_API_KEY || "",
        model: cfg.llm.model || process.env.TDAI_LLM_MODEL || "deepseek-v4-flash",
        maxTokens: cfg.llm.maxTokens,
        timeoutMs: cfg.llm.timeoutMs,
      },
    });
    const nextHostAdapter = new StandaloneHostAdapter({
      dataDir,
      llmConfig: {
        baseUrl: nextConfig.llm.baseUrl,
        apiKey: nextConfig.llm.apiKey,
        model: nextConfig.llm.model,
        maxTokens: nextConfig.llm.maxTokens,
        timeoutMs: nextConfig.llm.timeoutMs,
      },
      logger,
      defaultUserId: "dsh-user",
      platform: "dsh",
    });
    const nextCore = new TdaiCore({ hostAdapter: nextHostAdapter, config: nextConfig, instanceId: "dsh" });
    // Publish before initialize so concurrent flush listeners already use the
    // new core; initialize() only sets up stores/pipeline.
    tdaiConfig = nextConfig;
    core = nextCore;
    await nextCore.initialize();
    const key = nextConfig.llm.apiKey || "";
    log("info", `initialized (dataDir=${dataDir}, llm=${nextConfig.llm.model}, apiKey=${key ? `${key.slice(0, 6)}…` : "<empty>"}, embedding=${nextConfig.embedding.model})`);
  }

  // ── capture: triggered on session/flush (awaitable; runs before process
  //    exit in headless, and at every request boundary in web) ─────────────
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/start") {
      turnStarts.set(session.id, event.time);
    } else if (event.type === "turn/end") {
      lastTurnEnd.set(session.id, event.data.turn);
    }
  });

  ctx.on("session/flush", async (session) => {
    try {
      const turnId = lastTurnEnd.get(session.id);
      if (turnId === undefined || capturedTurns.get(session.id) === turnId) return;
      capturedTurns.set(session.id, turnId);
      seenSessions.add(session.id);
      const startedAt = turnStarts.get(session.id) ?? Date.now();
      await captureTurn(session, startedAt);
      if (isOneShot) {
        // Run pending L1 extraction to completion before the process exits.
        await core?.handleSessionEnd(session.id).catch((error) => {
          ctx.logger.warn(`[tdai-memory] L1 flush failed: ${String(error)}`);
        });
      }
    } catch (error) {
      ctx.logger.warn(`[tdai-memory] capture failed: ${String(error)}`);
    }
  });

  async function captureTurn(session, startedAt) {
    if (!tdaiConfig?.capture.enabled) return;
    const derived = session.deriveMessages();
    const lastUserIdx = derived.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx < 0) return;
    const messages = derived
      .slice(lastUserIdx)
      .map((m) => {
        const text = extractText(m.content);
        if (!text) return null;
        return {
          id: m.id ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          role: m.role === "assistant" ? "assistant" : "user",
          content: text,
          timestamp: Date.now(),
        };
      })
      .filter(Boolean);
    if (messages.length === 0) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const result = await core.handleTurnCommitted({
      userText: lastUser?.content ?? "",
      assistantText: "",
      messages,
      sessionKey: session.id,
      startedAt,
    });
    ctx.logger.debug(`[tdai-memory] captured turn: l0=${result.l0RecordedCount} notified=${result.schedulerNotified} vectors=${result.l0VectorsWritten}`);
  }

  // ── recall injection ────────────────────────────────────────────────────
  // The prompt assembly runs inside the agent's own context (scope = agent),
  // so the waterfall listener must be registered on `agent.ctx` — root-level
  // listeners never see agent-scoped assemblies. Agents appear right after
  // their session is announced, so defer one tick and attach there.
  ctx.on("session/created", (session) => {
    setTimeout(() => {
      try {
        const agents = ctx.get("agents");
        const agent = agents?.get?.(session.id);
        if (!agent?.ctx) return;
        agent.ctx.on("system-prompt/assemble", async (assembly, context) => {
          try {
            if (!tdaiConfig?.recall.enabled) return assembly;
            const lastUser = [...session.deriveMessages()].reverse().find((m) => m.role === "user");
            if (!lastUser) return assembly;
            const text = extractText(lastUser.content);
            if (!text) return assembly;
            const now = Date.now();
            const cached = recallCache.get(session.id);
            if (cached && cached.text === text && now - cached.ts < RECALL_CACHE_TTL_MS) {
              return injectRecall(assembly, cached.result);
            }
            const result = await Promise.race([
              core.handleBeforeRecall(text, session.id),
              new Promise((resolve) => setTimeout(() => resolve(null), tdaiConfig.recall.timeoutMs + 1000)),
            ]).catch(() => null);
            recallCache.set(session.id, { text, result: result ?? {}, ts: now });
            return injectRecall(assembly, result ?? {});
          } catch (error) {
            ctx.logger.warn(`[tdai-memory] recall failed: ${String(error)}`);
            return assembly;
          }
        });
      } catch (error) {
        ctx.logger.warn(`[tdai-memory] recall attach failed: ${String(error)}`);
      }
    }, 0);
  });

  function injectRecall(assembly, result) {
    const extras = [];
    if (result.prependContext) extras.push({ name: "tdai:recall", order: 1000, text: result.prependContext });
    if (result.appendSystemContext) extras.push({ name: "tdai:profile", order: 1001, text: result.appendSystemContext });
    if (extras.length === 0) return assembly;
    return { ...assembly, contexts: [...assembly.contexts, ...extras] };
  }

  // ── tools ────────────────────────────────────────────────────────────────
  if (config.toolsEnabled) {
    ctx.tools.register(defineTool({
      name: "tdai_memory_search",
      description:
        "Search structured long-term memories (facts, preferences, and experiences extracted from past conversations). " +
        "Use this to recall what the user told you or what happened in earlier sessions.",
      parameters: {
        query: { type: "string", required: true, description: "The memory to search for." },
        limit: { type: "integer", description: "Maximum results (default 5)." },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args) {
        const result = await core.searchMemories({ query: args.query, limit: args.limit ?? 5 });
        return result.text;
      },
    }));
    ctx.tools.register(defineTool({
      name: "tdai_conversation_search",
      description:
        "Search raw past conversation logs (L0) by keyword. Use this to look up exact quotes or details " +
        "that structured memory search does not cover.",
      parameters: {
        query: { type: "string", required: true, description: "Text to find in past conversations." },
        limit: { type: "integer", description: "Maximum results (default 5)." },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args) {
        const result = await core.searchConversations({ query: args.query, limit: args.limit ?? 5 });
        return result.text;
      },
    }));
  }

  // ── settings-backed configuration ─────────────────────────────────────────
  // The composition entry stays the base layer; a registered `tdai-memory`
  // settings section overlays it (settings.yaml). `installSettingsSection`
  // hands `setSource` a GETTER (`() => scope.get()`), not the config object —
  // we must call it to obtain the resolved settings. The settings mount
  // (cordis inject) always arrives after our fallback timer, so the fallback
  // builds the core from the entry config first (one-shot) and the settings
  // build REBUILDS the core with the resolved values (apiKey included).
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (getter) => {
      builtOnce = true;
      void build(getter());
    },
    onChange: () => {
      ctx.logger.warn("[tdai-memory] settings updated; restart to apply (TdaiCore is built at startup)");
    },
  });

  // dsh-host-apiproxy hard-codes which settings namespaces the Web client may
  // see; without this, the settings section answers `settings-not-exposed`
  // on any stock install. Patch the allowlist idempotently (self-heals after
  // dsh updates overwrite the file).
  ensureSettingsNamespaceExposed(ctx, "tdai-memory", ctx.logger);

  // Fallback when no settings service ever mounts: build from the entry
  // config. One-shot — if the settings mount arrives later, its build
  // supersedes this one. Delayed past the 0ms window so headless/web boots
  // are never blocked on this timer.
  setTimeout(() => {
    if (!builtOnce) {
      builtOnce = true;
      void build(config);
    }
  }, 500);

  // ── lifecycle ────────────────────────────────────────────────────────────
  ctx.effect(() => {
    return async () => {
      // Final flush: run pending L1 extraction for every session seen this
      // process and wait for it to finish (headless exits right after the
      // tree disposes, so this is what makes extraction complete in one-shot
      // runs). Unknown keys are tolerated as no-ops.
      for (const sessionKey of seenSessions) {
        await core?.handleSessionEnd(sessionKey).catch((error) => {
          ctx.logger.warn(`[tdai-memory] final L1 flush failed for ${sessionKey}: ${String(error)}`);
        });
      }
      await core?.destroy().catch((error) => {
        ctx.logger.warn(`[tdai-memory] destroy failed: ${String(error)}`);
      });
    };
  }, "tdai-memory.cleanup()");
}

export { Config, apply, inject, name };
