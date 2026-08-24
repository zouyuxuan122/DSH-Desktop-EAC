// @deepseek-ai/dsh-openclaw-bridge/lib/openai-compat.js
// 通用 OpenAI 兼容 LlmAdapter：让第三方公司的 OpenAI 兼容端点
// （one-api 聚合 / SiliconFlow / Ollama / Moonshot 等）直接驱动 DSH agent，
// 含完整工具调用与流式。模板：@deepseek-ai/dsh-llm-deepseek 的 DeepSeekAdapter
// （dsh-llm-deepseek/lib/index.js），协议见 dsh-llm/lib/index.js 的 LlmAdapter。
import {
  LlmAdapter,
  LlmError,
  EMPTY_RESPONSE_CODE,
  QUOTA_EXCEEDED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  attributionHeaders,
  assertUsableApiKey,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";

export const PROVIDER_ID = "openclaw-custom";

// ---------- 文本序列化（与 deepseek 版同构） ----------
function flattenText(blocks) {
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function assertTextOnly(blocks, pkg) {
  if (contentHasImage(blocks)) {
    throw new LlmError(pkg + ": the OpenAI-compatible adapter does not support image content.", "UNSUPPORTED_CONTENT");
  }
}

function serializeAssistant(message) {
  const text = flattenText(message.content);
  const toolCalls = message.content
    .filter((b) => b.type === "tool-call")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: b.arguments } }));
  return { role: "assistant", content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
}

function serializeMessages(messages, pkg) {
  const wire = [];
  for (const message of messages) {
    assertTextOnly(message.content, pkg);
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((b) => b.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: "user", content: text });
    for (const result of toolResults) {
      wire.push({ role: "tool", tool_call_id: result.toolCallId, content: flattenText(result.content) || "(no output)" });
    }
  }
  return wire;
}

function serializeRequest(options, pkg) {
  const messages = [];
  if (options.system !== void 0) messages.push({ role: "system", content: options.system });
  messages.push(...serializeMessages(options.messages, pkg));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== void 0 && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== void 0 ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== void 0 ? { stop: options.stop } : {}),
  };
}

// ---------- 错误/完成映射 ----------
function mapFinishReason(reason) {
  switch (reason) {
    case "stop":
      return { kind: "stop" };
    case "tool_calls":
      return { kind: "tool-calls" };
    case "length":
      return { kind: "max-tokens" };
    default:
      return { kind: "error", failure: { message: "model stopped: " + reason, code: reason.toUpperCase() } };
  }
}

function mapUsage(usage) {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== void 0 ? { reasoningTokens: reasoning } : {}),
  };
}

function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return "AUTH";
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return "HTTP_" + status;
}

function providerRetryAfterMs(value) {
  if (value === null) return void 0;
  if (/^\d+$/.test(value)) {
    const d = Number(value) * 1000;
    return Number.isFinite(d) && d > 0 ? d : void 0;
  }
  const d = Date.parse(value) - Date.now();
  return Number.isFinite(d) && d > 0 ? d : void 0;
}

// ---------- 手写 SSE 解析（零依赖；兼容 \r\n 帧边界） ----------
const SSE_FRAME = /\r?\n\r?\n/;

async function* parseSse(body, pkg) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let m;
      while ((m = buffer.match(SSE_FRAME)) !== null) {
        const rawEvent = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const data = rawEvent
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data === "") continue;
        if (data === "[DONE]") {
          yield "[DONE]";
          return;
        }
        yield data;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已释放
    }
  }
  throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}

// ---------- SSE → StreamChunk 状态机（delta-only，BlockAssembler 自动拼块） ----------
async function* translate(payloads) {
  let textIndex = -1;
  const toolBlocks = new Map();
  let nextIndex = 0;
  let pendingFinish = null;
  let pendingUsage = null;

  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason:
          reason.kind === "stop" && nextIndex === 0
            ? { kind: "error", failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE } }
            : reason,
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError("malformed SSE payload: " + payload.slice(0, 120), "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (textIndex < 0) textIndex = nextIndex++;
        yield { type: "text-delta", index: textIndex, text: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = { index: nextIndex++, id: "", name: "", arguments: "" };
          toolBlocks.set(call.index, block);
        }
        if (call.id) block.id = call.id;
        if (call.function?.name) block.name = call.function.name;
        const args = call.function?.arguments ?? "";
        block.arguments += args;
        yield {
          type: "tool-call-delta",
          index: block.index,
          ...(block.id ? { id: block.id } : {}),
          ...(block.name ? { name: block.name } : {}),
          argumentsDelta: args,
        };
      }
      if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
}

// ---------- 适配器 ----------
export class OpenAiCompatAdapter extends LlmAdapter {
  /** @param getConfig () => { baseURL, apiKey, model } —— 每次 stream() 调用时求值，热生效 */
  constructor(getConfig, pkg = "dsh-openclaw-bridge") {
    super();
    this.getConfig = getConfig;
    this.pkg = pkg;
    this.retryPolicy = resolveRetryPolicy(void 0, pkg + ': provider "' + PROVIDER_ID + '" retryPolicy');
  }

  providerInfo(provider) {
    return { id: provider, name: "OpenClaw Custom (OpenAI-compatible)" };
  }

  providerRetryPolicy(_provider) {
    return this.retryPolicy;
  }

  listModels(_provider) {
    return Promise.resolve([]);
  }

  resolveModel(provider, model, _signal) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ["text"] });
  }

  async *stream(options) {
    const cfg = this.getConfig() || {};
    const baseURL = String(cfg.baseURL || "").trim().replace(/\/+$/, "");
    if (!baseURL) throw new LlmError(this.pkg + ': no baseURL configured for provider "' + PROVIDER_ID + '"', "MISSING_CREDENTIAL");
    const apiKey = String(cfg.apiKey || "").trim();
    const usableKey = apiKey ? assertUsableApiKey(apiKey, this.pkg, "openclaw-custom apiKey") : "";

    const body = JSON.stringify(serializeRequest(options, this.pkg));
    const headers = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...attributionHeaders(),
      ...(usableKey ? { authorization: "Bearer " + usableKey } : {}),
    };

    let response;
    try {
      response = await fetch(baseURL + "/chat/completions", {
        method: "POST",
        headers,
        body,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError(this.pkg + ": request aborted by caller", "ABORTED", { cause: error });
      throw new LlmError(this.pkg + ": request to " + baseURL + " failed", "TRANSPORT", { cause: error });
    }
    if (!response.ok) {
      let message = "OpenAI-compatible API error (HTTP " + response.status + ")";
      let providerError;
      try {
        providerError = (await response.json()).error;
        if (providerError?.message) message = providerError.message;
      } catch {
        // 非 JSON 错误体
      }
      const retryAfter = providerRetryAfterMs(response.headers.get("retry-after"));
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {}),
      });
    }
    if (!response.body) throw new LlmError(this.pkg + ": API returned no response body", "EMPTY_RESPONSE");
    yield* translate(parseSse(response.body, this.pkg));
  }
}
