/**
 * dsh-tool-vision — external vision model for DeepSeek Harness.
 *
 * Two capabilities:
 *
 * 1. `inspect_image` tool — sends an image (local file, or http(s) URL) to
 *    any OpenAI-compatible chat/completions endpoint that supports
 *    `image_url` content parts, and returns the vision model's text answer.
 *
 * 2. Image bridge — pasted images are bridged to text hints before they
 *    enter a text-only model's request:
 *
 *    - New images are bridged on the `agent/pre-step` waterfall (the only
 *      seam where the harness lets a plugin replace the messages that enter
 *      a step — they become the durable `user/message` log, so the
 *      `llm/stream` request-reconstruction invariant stays satisfied).
 *    - Images already logged before the plugin was installed (or before a
 *      server restart) are repaired lazily with a surface `replace`, one
 *      event at a time, on the first pre-step of the session.
 *
 *    The bridged hint points at an exported local copy of the image, which
 *    the agent hands to `inspect_image`. Models listed in
 *    `multimodalModels` (or whose resolved `inputModalities` include
 *    "image") receive image blocks directly and are never bridged.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import os from "node:os";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { ensureSettingsNamespaceExposed } from "./vendor/dsh-settings-expose.js";

/** Cordis plugin name. */
const name = "tool-vision";
/** The tool registry, the llm seam (model capability lookup), and the attachment store. */
const inject = ["tools", "llm", "attachments"];
/** Settings namespace owned by this plugin (Web UI settings section). */
const NS = settingsNamespace("tool-vision");

const DEFAULT_DESCRIPTION =
  "Analyze an image using an external vision-capable model through an OpenAI-compatible API. " +
  "Provide the path to a local image file (absolute, or relative to the current workspace) or an http(s) URL, " +
  "optionally with a specific question. Returns the vision model's textual description or answer. " +
  "Use this whenever you need to read, describe, or extract information from image content, " +
  "since the main model is text-only.";

/** Runtime schema for the tool-vision row. */
const Config = z.object({
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com/v1 or https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseURL: z.string().default("https://api.openai.com/v1"),
  /** API key; takes precedence over apiKeyEnv. Rendered as a write-only secret in the Web UI. */
  apiKey: z.string().default("").role("secret"),
  /** Environment variable holding the API key. */
  apiKeyEnv: z.string().default("VISION_API_KEY"),
  /** Vision model id served by the endpoint. */
  model: z.string().default("gpt-4o-mini"),
  /** Max output tokens for the vision call. */
  maxTokens: z.number().default(4096),
  /** Per-request timeout in milliseconds. */
  timeoutMs: z.number().default(60000),
  /** Largest local image accepted, in bytes. */
  maxImageBytes: z.number().default(10 * 1024 * 1024),
  /** Tool description shown to the model; overrides the default. */
  description: z.string().default(DEFAULT_DESCRIPTION),
  /** Bridge pasted images to text hints on models that cannot see images. */
  bridgeTextOnly: z.boolean().default(true),
  /** Export directory for bridged images; empty = system temp. */
  bridgeExportDir: z.string().default(""),
  /** Model ids that receive image blocks directly (never bridged). */
  multimodalModels: z.array(z.string()).default([]),
  /**
   * Last-chance guard on the `llm/stream` waterfall: when a request for a
   * non-whitelisted model still carries image blocks (bridge disabled, images
   * logged before the plugin was active, forks, other adapters), downgrade
   * them to inspect_image hints right before adapter dispatch instead of
   * letting the adapter throw UNSUPPORTED_CONTENT and fail the whole turn.
   */
  requestGuard: z.boolean().default(true),
});

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const EXT_BY_MEDIA = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** True when any message carries an image content block. */
function hasImageBlock(messages) {
  return (messages ?? []).some((m) =>
    Array.isArray(m?.content) && m.content.some((b) => b?.type === "image"),
  );
}

/** Deep-freeze an acyclic JSON-safe value in place (the harness freezes every durable message). */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** Export one attachment to disk; returns the file path (cached per process). */
const exportedPaths = new Map();
async function exportImage(attachment, ctx, dir) {
  const cached = exportedPaths.get(attachment.attachmentId);
  if (cached) return cached;
  const { data } = await ctx.attachments.readImage(attachment);
  const ext = EXT_BY_MEDIA[attachment.mediaType] ?? ".img";
  const safeName = attachment.name
    ? attachment.name
        .replace(/\.[^.]+$/, "")
        .replace(/[^\w\-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40)
    : "";
  const base = (safeName ? `${safeName}_` : "") + attachment.attachmentId.slice(0, 12);
  const path = join(dir, `${base}${ext}`);
  await writeFile(path, data);
  exportedPaths.set(attachment.attachmentId, path);
  return path;
}

/**
 * Replace image content blocks with text hints pointing at exported files.
 * Non-image messages are returned as-is (same reference); bridged messages
 * are fresh, deep-frozen objects with the original identity and source.
 * Exported for unit testing; `ctx` only needs `attachments`.
 */
async function bridgeMessages(messages, ctx, dir) {
  const next = [];
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content) || !content.some((b) => b?.type === "image")) {
      next.push(message);
      continue;
    }
    const blocks = [];
    for (const block of content) {
      if (block?.type !== "image") {
        blocks.push(block);
        continue;
      }
      const path = await exportImage(block.attachment, ctx, dir);
      const name = block.attachment.name ? ` (${block.attachment.name})` : "";
      blocks.push({
        type: "text",
        text:
          `[User sent an image${name}, exported to: ${path}. ` +
          `You cannot see images directly. Call the inspect_image tool with path="${path}" ` +
          `now to have the external vision model analyze it, then answer using its result.]`,
      });
    }
    next.push(deepFreeze({ ...message, content: blocks }));
  }
  return next;
}

/**
 * Whether the session's current model may receive image blocks directly.
 * Uses the last logged request header first, then the agent's own options,
 * and consults ONLY the `multimodalModels` whitelist — never the model's
 * declared `inputModalities`, because profiles routinely declare
 * `input: [text, image]` on text-only models to pass the harness's prompt
 * admission check (that declaration says nothing about whether the upstream
 * endpoint really accepts `image_url` parts).
 * Returns true when bridging is disabled (nothing would be bridged anyway).
 */
async function currentModelAcceptsImage(agent, config) {
  if (!config.bridgeTextOnly) return true;
  const header = agent?.session?.requestHeader?.();
  const model = header?.config?.model ?? agent?.options?.model;
  if (!model) return false;
  return config.multimodalModels.includes(model);
}

/**
 * Lazily bridge image blocks that are already part of the session log
 * (pasted before the plugin was active, or before a restart). Each affected
 * event is rewritten once with a surface `replace`, which swaps the durable
 * derivation (and the transcript) to the text hint. Events that are no
 * longer on the surface (already shadowed) are skipped and remembered.
 * `repaired` tracks per-session state: a `Set` of handled seqs plus a
 * monotonic scan cursor.
 */
async function repairLoggedImages(ctx, session, exportDir, repaired) {
  const events = session.events;
  for (let index = repaired.cursor; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "user/message" || repaired.set.has(event.seq)) {
      repaired.set.add(event.seq);
      continue;
    }
    const content = event.data?.content;
    if (!Array.isArray(content) || !content.some((b) => b?.type === "image")) {
      repaired.set.add(event.seq);
      continue;
    }
    const [bridged] = await bridgeMessages([event.data], ctx, exportDir);
    try {
      session.append("user/message", bridged, {
        surfaceOp: { op: "replace", start: event.seq, end: event.seq },
        sourceEventSeqs: [event.seq],
      });
      ctx.logger.info(`[tool-vision] bridged logged image at seq ${event.seq} (${session.id})`);
    } catch (error) {
      ctx.logger.debug(`[tool-vision] skip repair of seq ${event.seq}: ${String(error)}`);
    }
    repaired.set.add(event.seq);
  }
  repaired.cursor = events.length;
}

/**
 * Install the pre-step bridge at the root level. Agent-scoped waterfalls
 * admit untagged (root) listeners, so one listener serves every agent —
 * including sessions resumed after a server restart, which never re-fire
 * `session/created` for per-agent attachments. Runs before every proposed
 * step: new pasted images are bridged into the durable log, and stuck
 * logged images are repaired, before the model request is derived from it.
 */
function attachPreStepBridge(ctx, getConfig, exportDir) {
  const repairedBySession = new Map();
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (!agent?.session) return decision;
    try {
      const acceptsImage = await currentModelAcceptsImage(agent, getConfig());
      if (!acceptsImage) {
        let repaired = repairedBySession.get(agent.session.id);
        if (!repaired) {
          repaired = { set: new Set(), cursor: 0 };
          repairedBySession.set(agent.session.id, repaired);
        }
        await repairLoggedImages(ctx, agent.session, exportDir, repaired).catch((error) => {
          ctx.logger.warn(`[tool-vision] logged-image repair failed: ${String(error)}`);
        });
      }
      if (acceptsImage) return decision;
      const messages = await bridgeMessages(decision.messages, ctx, exportDir);
      if (messages.every((message, index) => message === decision.messages[index])) return decision;
      return { ...decision, messages };
    } catch (error) {
      ctx.logger.warn(`[tool-vision] pre-step bridge failed: ${String(error)}`);
      return decision;
    }
  });
}

function resolveApiKey(config) {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv) {
    const fromEnv = process.env[config.apiKeyEnv];
    if (fromEnv) return fromEnv;
  }
  return process.env.OPENAI_API_KEY ?? "";
}

/** Turn a tool argument into an image_url payload: local file -> data URL, http(s) -> as-is. */
async function toImageUrl(target, cwd, config) {
  if (/^https?:\/\//i.test(target)) return { url: target, note: target };
  const abs = isAbsolute(target) ? target : resolvePath(cwd, target);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`image not found: ${abs}`);
  if (info.size > config.maxImageBytes) {
    throw new Error(
      `image too large: ${abs} (${info.size} bytes, limit ${config.maxImageBytes})`,
    );
  }
  const mime = MIME_BY_EXT[extname(abs).toLowerCase()];
  if (!mime) {
    throw new Error(
      `unsupported image extension: ${abs} (supported: ${Object.keys(MIME_BY_EXT).join(", ")})`,
    );
  }
  const data = await readFile(abs);
  return { url: `data:${mime};base64,${data.toString("base64")}`, note: abs };
}

/** One OpenAI-compatible chat/completions call with an image_url content part. */
async function callVision(config, imageUrl, question, detail, signal) {
  const key = resolveApiKey(config);
  if (!key) {
    throw new Error(
      `vision API key missing: set the plugin config (apiKey / apiKeyEnv) or the OPENAI_API_KEY environment variable`,
    );
  }
  const base = config.baseURL.endsWith("/") ? config.baseURL : `${config.baseURL}/`;
  const endpoint = new URL("chat/completions", base);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`vision request timed out after ${config.timeoutMs}ms`)),
    config.timeoutMs,
  );
  const onSignalAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onSignalAbort, { once: true });
  }
  const content = [
    { type: "text", text: question || "Describe this image in detail, including all key visual elements, text, and context you can see." },
    { type: "image_url", image_url: detail ? { url: imageUrl, detail } : { url: imageUrl } },
  ];
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content }],
        max_tokens: config.maxTokens,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detailText = body?.error?.message ?? response.statusText;
      throw new Error(
        `vision endpoint returned ${response.status}: ${detailText} (endpoint ${endpoint})`,
      );
    }
    // Reasoning models (mimo-v2.5, deepseek-r1, ...) spend the token budget on
    // `reasoning_content` first; when the final `content` is empty or was cut
    // off by max_tokens, fall back to the reasoning text so the answer is
    // still useful.
    const message = body?.choices?.[0]?.message;
    let answer = message?.content ?? "";
    if (!answer.trim()) answer = message?.reasoning_content ?? "";
    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("vision endpoint returned an empty response");
    }
    return answer.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onSignalAbort);
  }
}

/**
 * Last-chance guard on the `llm/stream` waterfall (config `requestGuard`).
 * Any image block still riding a request for a non-whitelisted model at
 * adapter-dispatch time would make the adapter throw UNSUPPORTED_CONTENT
 * (DeepSeek chat-completions is text-only; pi-ai gates on declared input
 * modalities) and fail the entire turn. Downgrade those blocks to the same
 * inspect_image hint the pre-step bridge uses. The durable log is untouched —
 * only this outgoing request is rewritten, so a whitelisted-model switch
 * later still sees the original images.
 */
function attachRequestGuard(ctx, getConfig, exportDir) {
  // llm/stream 监听器必须返回「流」：waterfall 上游对监听器返回值做
  // yield*。async 函数返回 Promise，yield* Promise 会以
  // "yield* (intermediate value) is not async iterable" 炸掉整个 turn。
  // 因此监听器保持同步、立即返回一个 async generator；桥接逻辑在生成器
  // 内部进行。下游委托放在 try/catch 之外：若放在里面，下游流自身的
  // 错误会被守卫捕获并再次 next()，造成双重请求。
  ctx.on("llm/stream", (options, next) => {
    return (async function* () {
      let downstream;
      try {
        const config = getConfig();
        if (config.requestGuard && typeof options?.model === "string"
          && !config.multimodalModels.includes(options.model)
          && hasImageBlock(options.messages)) {
          const messages = await bridgeMessages(options.messages, ctx, exportDir);
          if (messages.some((message, index) => message !== options.messages[index])) {
            ctx.logger.info(
              `[tool-vision] request guard downgraded image blocks for model "${options.model}"`,
            );
            downstream = next({ ...options, messages });
          }
        }
      } catch (error) {
        // The guard must never break the call: fall through with the original
        // options (the adapter's own error, if any, is the status quo ante).
        ctx.logger.warn(`[tool-vision] request guard failed: ${String(error)}`);
      }
      yield* downstream ?? next();
    })();
  });
}

function apply(ctx, config) {
  // ── settings-backed configuration ─────────────────────────────────────────
  // The composition entry stays the `base` layer; a registered `tool-vision`
  // settings section (Web UI section, settings.yaml) overlays it live, so
  // edits hot-apply without a restart. `installSettingsSection` hands
  // `setSource` a GETTER (`() => scope.get()`), not the config object — keep
  // it and call it at use time, or `getConfig()` would return a function and
  // every `cfg.*` read would be undefined (apiKey included).
  let current = config;
  let sourceGetter = null;
  const getConfig = () => (sourceGetter ? sourceGetter() : current);
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (getter) => {
      sourceGetter = getter;
    },
    onChange: () => {},
  });

  // dsh-host-apiproxy hard-codes which settings namespaces the Web client may
  // see; without this, the settings section answers `settings-not-exposed`
  // on any stock install. Patch the allowlist idempotently (self-heals after
  // dsh updates overwrite the file).
  ensureSettingsNamespaceExposed(ctx, "tool-vision", ctx.logger);

  // ── image bridge: pasted images become inspect_image hints on text-only models ──
  if (getConfig().bridgeTextOnly) {
    const exportDir = getConfig().bridgeExportDir || join(os.tmpdir(), "dsh-vision-bridge");
    mkdir(exportDir, { recursive: true }).catch(() => {});
    // Root-level listener: agent-scoped waterfalls admit untagged listeners,
    // so one registration serves every agent (new and resumed alike) and the
    // agent is read from the fused payload.
    attachPreStepBridge(ctx, getConfig, exportDir);
    // Last-chance guard at adapter dispatch (see attachRequestGuard): the
    // export dir is shared so both paths emit the same cached file paths.
    attachRequestGuard(ctx, getConfig, exportDir);
  } else if (getConfig().requestGuard) {
    // Bridge off but guard on: the guard still protects text-only requests.
    const exportDir = getConfig().bridgeExportDir || join(os.tmpdir(), "dsh-vision-bridge");
    mkdir(exportDir, { recursive: true }).catch(() => {});
    attachRequestGuard(ctx, getConfig, exportDir);
  }

  ctx.tools.register(defineTool({
    name: "inspect_image",
    description: getConfig().description,
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the image file (absolute, or relative to the current workspace) or an http(s) URL.",
      },
      question: {
        type: "string",
        description: "Optional specific question about the image. Omit for a general detailed description.",
      },
      detail: {
        type: "string",
        enum: ["auto", "low", "high"],
        description: "Optional image resolution hint for the vision API (auto by default).",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const cfg = getConfig();
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
      const { url, note } = await toImageUrl(args.path, cwd, cfg);
      const answer = await callVision(cfg, url, args.question, args.detail, exec.signal);
      return note === url ? answer : `${answer}\n\n(image: ${note})`;
    },
  }));
}

export {
  Config,
  DEFAULT_DESCRIPTION,
  EXT_BY_MEDIA,
  apply,
  attachPreStepBridge,
  attachRequestGuard,
  bridgeMessages,
  currentModelAcceptsImage,
  deepFreeze,
  exportImage,
  hasImageBlock,
  inject,
  name,
  repairLoggedImages,
};
