/**
 * tdai-recall-inject — agent-plane recall injection row for dsh-tdai-memory.
 *
 * Mounted INSIDE an agent preset (agent.cordis.yml), this row listens on the
 * `system-prompt/assemble` waterfall in the preset's scope, so it runs for
 * every assembly of every agent joined to that preset (agent -> preset scope
 * chain). It asks the `tdaiMemory` service (provided by the root-level
 * dsh-tdai-memory plugin) for relevant long-term memories and appends them
 * as dynamic context sections (user-role snapshots):
 *
 *   - tdai:recall  — relevant L1 memories for the current user message
 *   - tdai:profile — stable persona / scene navigation context
 *
 * The recall call is bounded by `recall.timeoutMs`; failures degrade to no
 * injection and never break the assembly.
 */
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name. */
const name = "tdai-recall-inject";
/** Services consumed: the prompt registry and the memory core service. */
const inject = ["systemPrompt", "tdaiMemory"];

/** Runtime schema for the recall-inject row. */
const Config = z.object({
  /** Skip recall when the user message is shorter than this. */
  minUserTextChars: z.number().default(1),
  /** Per-session cache TTL for identical user text (ms). */
  cacheTtlMs: z.number().default(30_000),
});

function apply(ctx, config) {
  const cache = new Map();

  ctx.on("system-prompt/assemble", async (assembly, context) => {
    try {
      const agent = context?.agent;
      if (!agent) return assembly;
      const session = agent.session;
      if (!session) return assembly;
      const lastUser = [...session.deriveMessages()].reverse().find((m) => m.role === "user");
      if (!lastUser) return assembly;
      const text = extractText(lastUser.content);
      if (!text || text.length < config.minUserTextChars) return assembly;

      const now = Date.now();
      const cached = cache.get(session.id);
      if (cached && cached.text === text && now - cached.ts < config.cacheTtlMs) {
        return injectRecall(assembly, cached.result);
      }
      const result = await ctx.tdaiMemory
        .handleBeforeRecall(text, session.id)
        .catch(() => null);
      cache.set(session.id, { text, result: result ?? {}, ts: now });
      return injectRecall(assembly, result ?? {});
    } catch {
      return assembly;
    }
  });
}

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function injectRecall(assembly, result) {
  const extras = [];
  if (result.prependContext) extras.push({ name: "tdai:recall", order: 1000, text: result.prependContext });
  if (result.appendSystemContext) extras.push({ name: "tdai:profile", order: 1001, text: result.appendSystemContext });
  if (extras.length === 0) return assembly;
  return { ...assembly, contexts: [...assembly.contexts, ...extras] };
}

export { Config, apply, inject, name };
