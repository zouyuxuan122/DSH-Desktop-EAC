/**
 * Embedding Service: converts text to vector embeddings.
 *
 * Supports two providers:
 * - "openai": OpenAI-compatible embedding APIs (OpenAI, Azure OpenAI, self-hosted)
 * - "local": node-llama-cpp with embeddinggemma-300m GGUF model (fully offline)
 *
 * When no remote embedding is configured, automatically falls back to local provider.
 *
 * Design:
 * - Single `embed()` for one text, `embedBatch()` for multiple.
 * - `getDimensions()` returns configured vector dimensions.
 * - Throws on failure; callers decide fallback strategy.
 */
/**
 * Error thrown when embed() / embedBatch() is called before the local
 * embedding model has finished downloading and loading.
 * Callers should catch this and fall back to keyword-only mode.
 */
export class EmbeddingNotReadyError extends Error {
    constructor(message) {
        super(message ?? "Local embedding model is not ready yet (still downloading or loading)");
        this.name = "EmbeddingNotReadyError";
    }
}
const TAG = "[memory-tdai][embedding]";
// ============================
// Local (node-llama-cpp) implementation
// ============================
/** Default model: Google's embeddinggemma-300m, quantized Q8_0 (~300MB) */
const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
/** embeddinggemma-300m outputs 768-dimensional vectors */
const LOCAL_DIMENSIONS = 768;
/**
 * embeddinggemma-300m has a 256-token context window.
 * As a safe heuristic, we limit input to ~600 chars for CJK text
 * (CJK characters typically tokenize to 1-2 tokens each,
 *  so 600 chars ≈ 200-400 tokens, keeping well within 256-token limit
 *  after accounting for special tokens).
 * For Latin text, ~800 chars is a safe limit (~200 tokens).
 * We use 512 chars as a conservative universal limit.
 */
const LOCAL_MAX_INPUT_CHARS = 512;
/**
 * Sanitize NaN/Inf values and L2-normalize the vector.
 * Matches OpenClaw's own sanitizeAndNormalizeEmbedding().
 */
function sanitizeAndNormalize(vec) {
    const arr = Array.from(vec).map((v) => (Number.isFinite(v) ? v : 0));
    const magnitude = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
    if (magnitude < 1e-10) {
        return new Float32Array(arr);
    }
    return new Float32Array(arr.map((v) => v / magnitude));
}
const defaultImportLlama = () => import("node-llama-cpp");
export class LocalEmbeddingService {
    modelPath;
    modelCacheDir;
    logger;
    importLlama;
    // Initialization state machine
    initState = "idle";
    initPromise = null;
    initError = null;
    embeddingContext = null;
    constructor(config, logger, importLlama) {
        this.modelPath = config?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
        this.modelCacheDir = config?.modelCacheDir?.trim();
        this.logger = logger;
        this.importLlama = importLlama ?? defaultImportLlama;
    }
    getDimensions() {
        return LOCAL_DIMENSIONS;
    }
    getProviderInfo() {
        return { provider: "local", model: this.modelPath };
    }
    /**
     * Whether the local model is fully loaded and ready to serve requests.
     */
    isReady() {
        return this.initState === "ready" && this.embeddingContext !== null;
    }
    /**
     * Start background warmup: download model (if needed) and load into memory.
     * Does NOT block the caller — returns immediately.
     * Safe to call multiple times (idempotent); re-triggers on "failed" state.
     */
    startWarmup() {
        if (this.initState === "initializing" || this.initState === "ready") {
            return; // already in progress or done
        }
        this.logger?.info(`${TAG} Starting background warmup for local embedding model...`);
        this.initState = "initializing";
        this.initError = null;
        this.initPromise = this._doInitialize()
            .then(() => {
            this.initState = "ready";
            this.logger?.info(`${TAG} Background warmup complete — local embedding ready`);
        })
            .catch((err) => {
            this.initState = "failed";
            this.initError = err instanceof Error ? err : new Error(String(err));
            this.logger?.error(`${TAG} Background warmup failed: ${this.initError.message}. ` +
                `embed() calls will throw EmbeddingNotReadyError until retried.`);
        });
    }
    /**
     * Get embedding for a single text.
     * @throws {EmbeddingNotReadyError} if model is not yet ready.
     */
    async embed(text, _options) {
        this.assertReady();
        const truncated = this.truncateInput(text);
        const embedding = await this.embeddingContext.getEmbeddingFor(truncated);
        return sanitizeAndNormalize(embedding.vector);
    }
    /**
     * Get embeddings for multiple texts.
     * @throws {EmbeddingNotReadyError} if model is not yet ready.
     */
    async embedBatch(texts, _options) {
        if (texts.length === 0)
            return [];
        this.assertReady();
        const results = [];
        for (const text of texts) {
            const truncated = this.truncateInput(text);
            const embedding = await this.embeddingContext.getEmbeddingFor(truncated);
            results.push(sanitizeAndNormalize(embedding.vector));
        }
        return results;
    }
    /**
     * Release the node-llama-cpp embedding context and model resources.
     * Safe to call multiple times (idempotent).
     */
    close() {
        if (this.embeddingContext) {
            try {
                const ctx = this.embeddingContext;
                ctx.dispose?.();
            }
            catch {
                // best-effort cleanup
            }
            this.embeddingContext = null;
            this.initPromise = null;
            this.initState = "idle";
            this.initError = null;
            this.logger?.info(`${TAG} Local embedding resources released`);
        }
    }
    /**
     * Assert the model is ready. Throws EmbeddingNotReadyError if not.
     */
    assertReady() {
        if (this.initState === "ready" && this.embeddingContext) {
            return;
        }
        if (this.initState === "failed") {
            throw new EmbeddingNotReadyError(`Local embedding model initialization failed: ${this.initError?.message ?? "unknown error"}. ` +
                `Call startWarmup() to retry.`);
        }
        if (this.initState === "initializing") {
            throw new EmbeddingNotReadyError("Local embedding model is still loading (download/initialization in progress). Please try again later.");
        }
        // "idle" — startWarmup() was never called
        throw new EmbeddingNotReadyError("Local embedding model warmup has not been started. Call startWarmup() first.");
    }
    /**
     * Truncate input text to stay within the model's context window.
     * embeddinggemma-300m has a 256-token limit; we use a character-based
     * heuristic (LOCAL_MAX_INPUT_CHARS) as a safe proxy.
     */
    truncateInput(text) {
        if (text.length <= LOCAL_MAX_INPUT_CHARS)
            return text;
        this.logger?.debug?.(`${TAG} Input truncated from ${text.length} to ${LOCAL_MAX_INPUT_CHARS} chars (model context limit)`);
        return text.slice(0, LOCAL_MAX_INPUT_CHARS);
    }
    /**
     * Internal: perform the actual model download + load.
     * Called by startWarmup(), runs in background.
     */
    async _doInitialize() {
        // Track partially-initialized resources for cleanup on failure
        let model;
        try {
            this.logger?.debug?.(`${TAG} Loading node-llama-cpp for local embedding...`);
            // Dynamic import — node-llama-cpp is a peer dependency of OpenClaw
            const { getLlama, resolveModelFile, LlamaLogLevel } = await this.importLlama();
            const llama = await getLlama({ logLevel: LlamaLogLevel.error });
            this.logger?.debug?.(`${TAG} Llama instance created`);
            const resolvedPath = await resolveModelFile(this.modelPath, this.modelCacheDir || undefined);
            this.logger?.debug?.(`${TAG} Model resolved: ${resolvedPath}`);
            model = await llama.loadModel({ modelPath: resolvedPath });
            this.logger?.debug?.(`${TAG} Model loaded, creating embedding context...`);
            this.embeddingContext = await model.createEmbeddingContext();
            this.logger?.info(`${TAG} Local embedding ready (model=${this.modelPath}, dims=${LOCAL_DIMENSIONS})`);
        }
        catch (err) {
            // Clean up partially-initialized resources to prevent leaks
            if (model?.dispose) {
                try {
                    model.dispose();
                }
                catch { /* best-effort */ }
            }
            this.embeddingContext = null;
            throw err;
        }
    }
    /**
     * Wait for ongoing warmup to complete (used internally by tests).
     * Returns immediately if already ready or idle.
     */
    async waitForReady() {
        if (this.initPromise) {
            await this.initPromise;
        }
    }
}
// ============================
// OpenAI-compatible implementation
// ============================
/** Max texts per batch (OpenAI limit is 2048, we use a safe value) */
const MAX_BATCH_SIZE = 256;
/**
 * Max retries for embedding API calls (transient errors: network, 429, DNS).
 * Total attempts = MAX_RETRIES + 1. Exponential backoff: 500ms × attempt.
 */
const MAX_RETRIES = 3;
/** Default timeout per API call in milliseconds */
const DEFAULT_API_TIMEOUT_MS = 10_000;
/**
 * Custom error class for embedding API errors that carries HTTP status code.
 * Used to distinguish non-retryable client errors (4xx except 429) from
 * retryable server errors (5xx) and rate limits (429).
 */
class EmbeddingApiError extends Error {
    httpStatus;
    constructor(message, httpStatus) {
        super(message);
        this.name = "EmbeddingApiError";
        this.httpStatus = httpStatus;
    }
    /** Returns true for 4xx errors that should NOT be retried (excluding 429). */
    isClientError() {
        return this.httpStatus >= 400 && this.httpStatus < 500 && this.httpStatus !== 429;
    }
}
// ============================
// Shared HTTP helpers (provider-agnostic)
// ============================
/**
 * Truncate every text to `maxInputChars` (when set), emitting one warning
 * per text that exceeded the limit. Returns the input array untouched when
 * no limit is configured.
 */
function truncateEmbeddingInputs(texts, maxInputChars, logger) {
    if (!maxInputChars)
        return texts;
    return texts.map((text) => {
        if (text.length <= maxInputChars)
            return text;
        logger?.warn?.(`${TAG} Input truncated from ${text.length} to ${maxInputChars} chars (maxInputChars limit)`);
        return text.slice(0, maxInputChars);
    });
}
/**
 * POST a remote embedding request with the project's standard timeout +
 * retry behaviour, returning the parsed JSON body. Provider-specific
 * services own body construction and response shape — this helper handles
 * fetch, abort-on-timeout, exponential backoff, and the `EmbeddingApiError`
 * non-retry rule for 4xx responses (except 429).
 */
async function postEmbeddingRequest(params) {
    const { fetchUrl, headers, body, timeoutMs } = params;
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const resp = await fetch(fetchUrl, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (!resp.ok) {
                    const errBody = await resp.text().catch(() => "(unable to read body)");
                    const err = new EmbeddingApiError(`Embedding API error: HTTP ${resp.status} ${resp.statusText} — ${errBody.slice(0, 500)}`, resp.status);
                    // Don't retry 4xx client errors (except 429 rate limit).
                    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
                        throw err;
                    }
                    lastError = err;
                    continue;
                }
                return await resp.json();
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        catch (err) {
            // Non-retryable errors (4xx client errors) — rethrow immediately
            if (err instanceof EmbeddingApiError && err.isClientError()) {
                throw err;
            }
            lastError = err instanceof Error ? err : new Error(String(err));
            // AbortError = timeout, retry
            if (attempt < MAX_RETRIES) {
                // Exponential backoff: 500ms, 1000ms
                const delay = 500 * (attempt + 1);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    throw lastError ?? new Error("Embedding API call failed after retries");
}
export class OpenAIEmbeddingService {
    baseUrl;
    apiKey;
    model;
    dims;
    sendDimensions;
    providerName;
    proxyUrl;
    maxInputChars;
    timeoutMs;
    logger;
    constructor(config, logger) {
        if (!config.apiKey) {
            throw new Error("EmbeddingService: apiKey is required for remote provider");
        }
        if (!config.baseUrl) {
            throw new Error("EmbeddingService: baseUrl is required for remote provider");
        }
        if (!config.model) {
            throw new Error("EmbeddingService: model is required for remote provider");
        }
        if (!config.dimensions || config.dimensions <= 0) {
            throw new Error("EmbeddingService: dimensions is required for remote provider (must be a positive integer)");
        }
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.dims = config.dimensions;
        this.sendDimensions = config.sendDimensions ?? true;
        this.providerName = config.provider || "openai";
        this.proxyUrl = config.proxyUrl?.trim() || undefined;
        this.maxInputChars = config.maxInputChars && config.maxInputChars > 0 ? config.maxInputChars : undefined;
        this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_API_TIMEOUT_MS;
        this.logger = logger;
    }
    getDimensions() {
        return this.dims;
    }
    getProviderInfo() {
        return { provider: this.providerName, model: this.model };
    }
    /** Remote embedding is always ready (stateless HTTP). */
    isReady() {
        return true;
    }
    /** No-op for remote embedding (no local model to warm up). */
    startWarmup() {
        // nothing to do — remote API is stateless
    }
    async embed(text, options) {
        const [result] = await this.embedBatch([text], options);
        return result;
    }
    async embedBatch(texts, options) {
        if (texts.length === 0)
            return [];
        // Truncate texts exceeding maxInputChars limit
        const processedTexts = this.maxInputChars
            ? texts.map((t) => this.truncateInput(t))
            : texts;
        // Split into sub-batches if needed
        if (processedTexts.length > MAX_BATCH_SIZE) {
            const results = [];
            for (let i = 0; i < processedTexts.length; i += MAX_BATCH_SIZE) {
                const chunk = processedTexts.slice(i, i + MAX_BATCH_SIZE);
                const chunkResults = await this._callApi(chunk, options?.timeoutMs);
                results.push(...chunkResults);
            }
            return results;
        }
        return this._callApi(processedTexts, options?.timeoutMs);
    }
    /**
     * Truncate input text to stay within the configured maxInputChars limit.
     * Logs a warning when truncation occurs.
     */
    truncateInput(text) {
        if (!this.maxInputChars || text.length <= this.maxInputChars)
            return text;
        this.logger?.warn?.(`${TAG} Input truncated from ${text.length} to ${this.maxInputChars} chars (maxInputChars limit)`);
        return text.slice(0, this.maxInputChars);
    }
    async _callApi(texts, timeoutOverride) {
        const body = {
            input: texts,
            model: this.model,
        };
        if (this.sendDimensions) {
            body.dimensions = this.dims;
        }
        // Determine fetch URL and headers based on proxy mode.
        const useProxy = this.providerName === "qclaw" && !!this.proxyUrl;
        const fetchUrl = useProxy ? this.proxyUrl : `${this.baseUrl}/embeddings`;
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
        };
        if (useProxy) {
            headers["Remote-URL"] = `${this.baseUrl}/embeddings`;
            this.logger?.debug?.(`${TAG} [qclaw-proxy] Forwarding embedding request via proxy: ${fetchUrl}, Remote-URL: ${headers["Remote-URL"]}`);
        }
        const json = (await postEmbeddingRequest({
            fetchUrl,
            headers,
            body,
            timeoutMs: timeoutOverride ?? this.timeoutMs,
        }));
        if (!json.data || !Array.isArray(json.data)) {
            throw new Error("Embedding API returned unexpected format: missing 'data' array");
        }
        // Sort by index to ensure correct order, then sanitize+normalize for consistency with local provider.
        const sorted = [...json.data].sort((a, b) => a.index - b.index);
        return sorted.map((d) => sanitizeAndNormalize(d.embedding));
    }
}
// ============================
// ZeroEntropy embedding service
// ============================
/**
 * ZeroEntropy native embedding adapter.
 *
 * Reuses {@link OpenAIEmbeddingConfig} for the wire-config shape (baseUrl /
 * apiKey / model / dimensions / sendDimensions are identical), but the wire
 * format diverges in three places, so we keep this provider on its own class
 * instead of branching {@link OpenAIEmbeddingService}:
 *
 * 1. Endpoint is `${baseUrl}/models/embed` (not `/embeddings`).
 * 2. Request body requires `input_type` (`"query"` or `"document"`).
 *    `dimensions` is optional — for `zembed-1` the accepted values are the
 *    Matryoshka set [2560, 1280, 640, 320, 160, 80, 40]; any other value is
 *    rejected by the server. The config's `sendDimensions` flag (default
 *    true) controls whether it is forwarded, matching the OpenAI path.
 * 3. Response envelope is `{ results: [{ embedding }] }` and preserves
 *    input order via array position rather than an `index` field.
 *
 * Everything else (timeout, retry, batching, char-cap truncation,
 * sanitize+normalize) is shared via the module-level
 * `postEmbeddingRequest` / `truncateEmbeddingInputs` helpers. See
 * https://docs.zeroentropy.dev/api-reference/models/embed and issue #68.
 */
export class ZeroEntropyEmbeddingService {
    baseUrl;
    apiKey;
    model;
    dims;
    sendDimensions;
    maxInputChars;
    timeoutMs;
    logger;
    constructor(config, logger) {
        if (!config.apiKey) {
            throw new Error("ZeroEntropyEmbeddingService: apiKey is required");
        }
        if (!config.baseUrl) {
            throw new Error("ZeroEntropyEmbeddingService: baseUrl is required");
        }
        if (!config.model) {
            throw new Error("ZeroEntropyEmbeddingService: model is required");
        }
        if (!config.dimensions || config.dimensions <= 0) {
            throw new Error("ZeroEntropyEmbeddingService: dimensions is required (must be a positive integer)");
        }
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.dims = config.dimensions;
        this.sendDimensions = config.sendDimensions ?? true;
        this.maxInputChars = config.maxInputChars && config.maxInputChars > 0 ? config.maxInputChars : undefined;
        this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_API_TIMEOUT_MS;
        this.logger = logger;
    }
    getDimensions() {
        return this.dims;
    }
    getProviderInfo() {
        return { provider: "zeroentropy", model: this.model };
    }
    /** Remote embedding is always ready (stateless HTTP). */
    isReady() {
        return true;
    }
    /** No-op for remote embedding (no local model to warm up). */
    startWarmup() {
        // nothing to do — remote API is stateless
    }
    async embed(text, options) {
        const [result] = await this.embedBatch([text], options);
        return result;
    }
    async embedBatch(texts, options) {
        if (texts.length === 0)
            return [];
        const processedTexts = truncateEmbeddingInputs(texts, this.maxInputChars, this.logger);
        if (processedTexts.length > MAX_BATCH_SIZE) {
            const results = [];
            for (let i = 0; i < processedTexts.length; i += MAX_BATCH_SIZE) {
                const chunk = processedTexts.slice(i, i + MAX_BATCH_SIZE);
                const chunkResults = await this._callApi(chunk, options?.timeoutMs);
                results.push(...chunkResults);
            }
            return results;
        }
        return this._callApi(processedTexts, options?.timeoutMs);
    }
    async _callApi(texts, timeoutOverride) {
        // ZeroEntropy rejects requests without `input_type`. We default to
        // "query" because the recall hot path is the only caller of embed()
        // that returns a Float32Array; capture-side batches eventually feed
        // the same vector store, and ZeroEntropy's symmetry between "query"
        // and "document" makes a single type safe across both directions.
        const body = {
            input: texts,
            model: this.model,
            input_type: "query",
        };
        if (this.sendDimensions) {
            // ZeroEntropy's docs list `dimensions` as optional. For zembed-1 the
            // accepted set is [2560, 1280, 640, 320, 160, 80, 40] (Matryoshka);
            // any other value is rejected server-side. We forward the user's
            // configured value verbatim — clamping silently would surprise users
            // who deliberately picked a smaller dim for storage savings.
            body.dimensions = this.dims;
        }
        const fetchUrl = `${this.baseUrl}/models/embed`;
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
        };
        const json = (await postEmbeddingRequest({
            fetchUrl,
            headers,
            body,
            timeoutMs: timeoutOverride ?? this.timeoutMs,
        }));
        if (!json.results || !Array.isArray(json.results)) {
            throw new Error("ZeroEntropy embedding API returned unexpected format: missing 'results' array");
        }
        // ZeroEntropy preserves input order via array position (no `index` field).
        return json.results.map((r) => sanitizeAndNormalize(r.embedding));
    }
}
// ============================
// Factory
// ============================
/**
 * Create an EmbeddingService from config.
 *
 * Strategy:
 * - If config has provider != "local" with valid apiKey, model, and dimensions → use remote OpenAI-compatible embedding
 * - If config has provider="local" → use node-llama-cpp local embedding
 * - If config is undefined or missing required fields → fall back to local embedding
 *
 * NOTE: For local providers, `startWarmup()` is NOT called here.
 * The caller is responsible for calling `startWarmup()` at the right time
 * (e.g. on first conversation) to avoid triggering model download during
 * short-lived CLI commands like `gateway stop` or `agents list`.
 */
export function createEmbeddingService(config, logger) {
    // ZeroEntropy speaks a non-OpenAI wire format and has its own service class.
    if (config && config.provider === "zeroentropy" && "apiKey" in config && config.apiKey) {
        logger?.debug?.(`${TAG} Using ZeroEntropy embedding (model=${config.model})`);
        return new ZeroEntropyEmbeddingService(config, logger);
    }
    // Remote OpenAI-compatible provider: any provider value other than "local"
    if (config && config.provider !== "local" && "apiKey" in config && config.apiKey) {
        logger?.debug?.(`${TAG} Using remote embedding (provider=${config.provider}, model=${config.model})`);
        return new OpenAIEmbeddingService(config, logger);
    }
    // Explicit local config
    if (config && config.provider === "local") {
        const localConfig = config;
        logger?.debug?.(`${TAG} Using local embedding (node-llama-cpp, model=${localConfig.modelPath ?? DEFAULT_LOCAL_MODEL})`);
        return new LocalEmbeddingService(localConfig, logger);
    }
    // Fallback: no config or empty apiKey → use local
    logger?.debug?.(`${TAG} No remote embedding configured, falling back to local embedding (node-llama-cpp)`);
    return new LocalEmbeddingService(undefined, logger);
}
// ============================
// NoopEmbeddingService (for server-side embedding backends)
// ============================
/**
 * No-op embedding service for backends with built-in server-side embedding
 * (e.g., TCVDB with Collection-level embedding config).
 *
 * All embed() calls return an empty Float32Array because the server generates
 * vectors automatically from the text field during upsert/search.
 */
export class NoopEmbeddingService {
    embed(_text) {
        return Promise.resolve(new Float32Array(0));
    }
    embedBatch(texts) {
        return Promise.resolve(texts.map(() => new Float32Array(0)));
    }
    getDimensions() {
        return 0;
    }
    getProviderInfo() {
        return { provider: "noop", model: "server-side" };
    }
    isReady() {
        return true;
    }
    startWarmup() {
        // no-op
    }
}
