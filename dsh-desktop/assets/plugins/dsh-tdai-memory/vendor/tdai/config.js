/**
 * Plugin configuration types and parser (v3).
 *
 * Config is organized into flat functional groups:
 *   capture, extraction, persona, pipeline, recall, embedding
 *
 * Minimal config (zero config): {} — all fields have sensible defaults.
 */
import { normalizeDisableThinking } from "./utils/no-think-fetch.js";
// ============================
// Parser
// ============================
/**
 * Parse plugin config from raw user input.
 * All fields have sensible defaults — minimal config is just {}.
 */
export function parseConfig(raw) {
    const c = raw ?? {};
    // --- Capture (L0) ---
    const captureGroup = obj(c, "capture");
    // --- Retention days validation (from capture.l0l1RetentionDays) ---
    const rawRetentionDays = num(captureGroup, "l0l1RetentionDays") ?? 0;
    const allowAggressiveCleanup = bool(captureGroup, "allowAggressiveCleanup") ?? false;
    let retentionDays;
    if (rawRetentionDays <= 0) {
        retentionDays = undefined;
    }
    else if (rawRetentionDays >= 3) {
        retentionDays = rawRetentionDays;
    }
    else if (allowAggressiveCleanup) {
        retentionDays = rawRetentionDays;
    }
    else {
        retentionDays = undefined;
    }
    // --- Extraction (L1) ---
    const extractionGroup = obj(c, "extraction");
    // --- Persona (L2/L3) ---
    const personaGroup = obj(c, "persona");
    // --- Pipeline ---
    const pipelineGroup = obj(c, "pipeline");
    // --- Recall ---
    const recallGroup = obj(c, "recall");
    // --- Embedding ---
    const embeddingGroup = obj(c, "embedding");
    let embeddingConfigError;
    // Embedding config: determine provider based on user input and apiKey availability
    const embeddingApiKey = str(embeddingGroup, "apiKey") ?? "";
    const embeddingBaseUrl = str(embeddingGroup, "baseUrl") ?? "";
    const embeddingProviderRaw = str(embeddingGroup, "provider") ?? "none";
    const embeddingModelRaw = str(embeddingGroup, "model") ?? "";
    const embeddingDimensionsRaw = num(embeddingGroup, "dimensions");
    const embeddingProxyUrl = str(embeddingGroup, "proxyUrl");
    // provider="none" → embedding disabled (default for zero-config users)
    // provider="local" → no longer exposed to users; treated as disabled at entry level
    // provider="qclaw" → requires proxyUrl for local proxy forwarding
    // Any other value → remote mode (requires apiKey, baseUrl, model, dimensions)
    let embeddingProvider;
    let embeddingEnabled = bool(embeddingGroup, "enabled") ?? true;
    if (embeddingProviderRaw === "none") {
        // Explicitly disabled (default): no embedding, no vector search
        embeddingProvider = "none";
        embeddingEnabled = false;
    }
    else if (embeddingProviderRaw === "local") {
        // Local embedding is not exposed to users; treat as disabled at entry level.
        // Internal LocalEmbeddingService code is preserved but not reachable from config.
        embeddingProvider = "none";
        embeddingEnabled = false;
        embeddingConfigError =
            "Local embedding provider is not available in user config. " +
                "Please configure a remote embedding provider (e.g. openai, deepseek). Embedding has been disabled.";
    }
    else if (embeddingProviderRaw === "qclaw") {
        // qclaw provider: requires proxyUrl for local proxy forwarding
        const missingFields = [];
        if (!embeddingProxyUrl)
            missingFields.push("proxyUrl");
        if (!embeddingBaseUrl)
            missingFields.push("baseUrl");
        if (!embeddingApiKey)
            missingFields.push("apiKey");
        if (!embeddingModelRaw)
            missingFields.push("model");
        if (embeddingDimensionsRaw == null || embeddingDimensionsRaw <= 0)
            missingFields.push("dimensions");
        if (missingFields.length > 0) {
            const errorMsg = `Embedding provider 'qclaw' requires 'proxyUrl', 'baseUrl', 'apiKey', 'model', and 'dimensions' to be set. ` +
                `Missing: ${missingFields.join(", ")}. Embedding has been disabled.`;
            embeddingConfigError = errorMsg;
            embeddingEnabled = false;
            embeddingProvider = embeddingProviderRaw;
        }
        else {
            embeddingProvider = embeddingProviderRaw;
        }
    }
    else {
        // Remote mode — validate all required fields
        const missingFields = [];
        if (!embeddingApiKey)
            missingFields.push("apiKey");
        if (!embeddingBaseUrl)
            missingFields.push("baseUrl");
        if (!embeddingModelRaw)
            missingFields.push("model");
        if (embeddingDimensionsRaw == null || embeddingDimensionsRaw <= 0)
            missingFields.push("dimensions");
        if (missingFields.length > 0) {
            // Configuration error: disable embedding and log detailed error
            // This does NOT throw — the plugin continues running without vector search
            const errorMsg = `Remote embedding provider '${embeddingProviderRaw}' requires 'apiKey', 'baseUrl', 'model', and 'dimensions' to be set. ` +
                `Missing: ${missingFields.join(", ")}. Embedding has been disabled.`;
            // We store the error message so the caller (index.ts) can log it
            embeddingConfigError = errorMsg;
            embeddingEnabled = false;
            embeddingProvider = embeddingProviderRaw; // preserve original for error context
        }
        else {
            embeddingProvider = embeddingProviderRaw;
        }
    }
    // When provider="none", dimensions=0 signals VectorStore to skip vec0 table
    // creation entirely (deferred until a real embedding provider is configured).
    // This avoids creating vec0 tables with a placeholder dimension that would
    // mismatch if the user later enables a different-dimensional provider.
    const defaultDimensions = embeddingProvider === "none" ? 0 :
        embeddingDimensionsRaw ?? 0;
    const defaultModel = embeddingProvider === "none" ? "" : embeddingModelRaw;
    const cleanTime = normalizeCleanTime(str(captureGroup, "cleanTime")) ?? "03:00";
    // --- BM25 (local @tencentdb-agent-memory/tcvdb-text encoder) ---
    const bm25Group = obj(c, "bm25");
    // --- Store backend ---
    const storeBackendRaw = str(c, "storeBackend") ?? "sqlite";
    const storeBackend = storeBackendRaw === "tcvdb" ? "tcvdb" : "sqlite";
    // --- TCVDB config ---
    const tcvdbGroup = obj(c, "tcvdb");
    const memoryCleanup = {
        retentionDays,
        enabled: retentionDays != null,
        cleanTime,
    };
    // --- Offload ---
    const offloadGroup = obj(c, "offload");
    const offloadMode = (() => {
        const raw = optStr(offloadGroup, "mode");
        if (raw === "local" || raw === "backend" || raw === "collect")
            return raw;
        return optStr(offloadGroup, "backendUrl") ? "backend" : "local";
    })();
    const offload = {
        enabled: bool(offloadGroup, "enabled") ?? false,
        mode: offloadMode,
        model: optStr(offloadGroup, "model"),
        temperature: num(offloadGroup, "temperature") ?? 0.2,
        disableThinking: normalizeDisableThinking(boolOrStr(offloadGroup, "disableThinking")),
        forceTriggerThreshold: num(offloadGroup, "forceTriggerThreshold") ?? 4,
        dataDir: optStr(offloadGroup, "dataDir"),
        defaultContextWindow: num(offloadGroup, "defaultContextWindow") ?? 200000,
        maxPairsPerBatch: num(offloadGroup, "maxPairsPerBatch") ?? 20,
        l2NullThreshold: num(offloadGroup, "l2NullThreshold") ?? 4,
        l2TimeoutSeconds: num(offloadGroup, "l2TimeoutSeconds") ?? 300,
        mildOffloadRatio: num(offloadGroup, "mildOffloadRatio") ?? 0.5,
        aggressiveCompressRatio: num(offloadGroup, "aggressiveCompressRatio") ?? 0.85,
        mmdMaxTokenRatio: num(offloadGroup, "mmdMaxTokenRatio") ?? 0.2,
        backendUrl: optStr(offloadGroup, "backendUrl"),
        backendApiKey: optStr(offloadGroup, "backendApiKey"),
        backendTimeoutMs: num(offloadGroup, "backendTimeoutMs") ?? 120000,
        offloadRetentionDays: normalizeOffloadRetentionDays(num(offloadGroup, "offloadRetentionDays") ?? 0),
        logMaxSizeMb: num(offloadGroup, "logMaxSizeMb") ?? 50,
        userId: optStr(offloadGroup, "userId"),
    };
    return {
        timezone: str(c, "timezone") ?? "system",
        capture: {
            enabled: bool(captureGroup, "enabled") ?? true,
            excludeAgents: strArray(captureGroup, "excludeAgents") ?? [],
            l0l1RetentionDays: retentionDays ?? 0,
            allowAggressiveCleanup,
        },
        extraction: {
            enabled: bool(extractionGroup, "enabled") ?? true,
            enableDedup: bool(extractionGroup, "enableDedup") ?? true,
            maxMemoriesPerSession: num(extractionGroup, "maxMemoriesPerSession") ?? 20,
            model: optStr(extractionGroup, "model"),
        },
        persona: {
            triggerEveryN: num(personaGroup, "triggerEveryN") ?? 50,
            maxScenes: num(personaGroup, "maxScenes") ?? 15,
            backupCount: num(personaGroup, "backupCount") ?? 3,
            sceneBackupCount: num(personaGroup, "sceneBackupCount") ?? 10,
            model: optStr(personaGroup, "model"),
        },
        pipeline: {
            everyNConversations: num(pipelineGroup, "everyNConversations") ?? 5,
            enableWarmup: bool(pipelineGroup, "enableWarmup") ?? true,
            l1IdleTimeoutSeconds: num(pipelineGroup, "l1IdleTimeoutSeconds") ?? 600,
            l2DelayAfterL1Seconds: num(pipelineGroup, "l2DelayAfterL1Seconds") ?? 10,
            l2MinIntervalSeconds: num(pipelineGroup, "l2MinIntervalSeconds") ?? 900,
            l2MaxIntervalSeconds: num(pipelineGroup, "l2MaxIntervalSeconds") ?? 3600,
            sessionActiveWindowHours: num(pipelineGroup, "sessionActiveWindowHours") ?? 24,
        },
        recall: {
            enabled: bool(recallGroup, "enabled") ?? true,
            maxResults: num(recallGroup, "maxResults") ?? 5,
            maxCharsPerMemory: num(recallGroup, "maxCharsPerMemory") ?? 0,
            maxTotalRecallChars: num(recallGroup, "maxTotalRecallChars") ?? 0,
            scoreThreshold: num(recallGroup, "scoreThreshold") ?? 0.3,
            strategy: validateStrategy(str(recallGroup, "strategy")) ?? "hybrid",
            timeoutMs: num(recallGroup, "timeoutMs") ?? 5000,
        },
        embedding: {
            enabled: embeddingEnabled,
            provider: embeddingProvider,
            baseUrl: embeddingBaseUrl,
            apiKey: embeddingApiKey,
            model: str(embeddingGroup, "model") ?? defaultModel,
            dimensions: num(embeddingGroup, "dimensions") ?? defaultDimensions,
            sendDimensions: bool(embeddingGroup, "sendDimensions") ?? true,
            conflictRecallTopK: num(embeddingGroup, "conflictRecallTopK") ?? 5,
            proxyUrl: embeddingProxyUrl,
            maxInputChars: num(embeddingGroup, "maxInputChars") ?? 5000,
            timeoutMs: num(embeddingGroup, "timeoutMs") ?? 10_000,
            recallTimeoutMs: num(embeddingGroup, "recallTimeoutMs") ?? undefined,
            captureTimeoutMs: num(embeddingGroup, "captureTimeoutMs") ?? undefined,
            modelCacheDir: optStr(embeddingGroup, "modelCacheDir"),
            configError: embeddingConfigError,
        },
        storeBackend,
        tcvdb: {
            url: str(tcvdbGroup, "url") ?? "",
            username: str(tcvdbGroup, "username") ?? "root",
            apiKey: str(tcvdbGroup, "apiKey") ?? "",
            database: str(tcvdbGroup, "database") ?? "",
            alias: str(tcvdbGroup, "alias") ?? "",
            embeddingModel: str(tcvdbGroup, "embeddingModel") ?? "bge-large-zh",
            timeout: num(tcvdbGroup, "timeout") ?? 10000,
            caPemPath: str(tcvdbGroup, "caPemPath") || undefined,
        },
        bm25: {
            enabled: bool(bm25Group, "enabled") ?? true,
            language: (str(bm25Group, "language") === "en" ? "en" : "zh"),
        },
        memoryCleanup,
        report: {
            enabled: bool(obj(c, "report"), "enabled") ?? false,
            type: str(obj(c, "report"), "type") ?? "local",
        },
        llm: (() => {
            const llmGroup = obj(c, "llm");
            return {
                enabled: bool(llmGroup, "enabled") ?? false,
                baseUrl: str(llmGroup, "baseUrl") ?? "https://api.openai.com/v1",
                apiKey: str(llmGroup, "apiKey") ?? "",
                model: str(llmGroup, "model") ?? "gpt-4o",
                maxTokens: num(llmGroup, "maxTokens") ?? 4096,
                timeoutMs: num(llmGroup, "timeoutMs") ?? 120_000,
                disableThinking: normalizeDisableThinking(boolOrStr(llmGroup, "disableThinking")),
            };
        })(),
        offload,
    };
}
// ============================
// Helper functions
// ============================
/** Get sub-object by key, or empty object if missing. */
function obj(c, key) {
    const v = c[key];
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function str(src, key) {
    const v = src[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function optStr(src, key) {
    const v = src[key];
    return typeof v === "string" ? v : undefined;
}
function num(src, key) {
    const v = src[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(src, key) {
    const v = src[key];
    return typeof v === "boolean" ? v : undefined;
}
/** Read a field that may be boolean or string. */
function boolOrStr(src, key) {
    const v = src[key];
    if (typeof v === "boolean")
        return v;
    if (typeof v === "string" && v.trim())
        return v.trim();
    return undefined;
}
function strArray(src, key) {
    const v = src[key];
    if (!Array.isArray(v))
        return undefined;
    return v.filter((item) => typeof item === "string" && item.trim().length > 0);
}
const VALID_STRATEGIES = ["embedding", "keyword", "hybrid"];
/**
 * Validate recall strategy against whitelist.
 * Returns the strategy if valid, undefined otherwise (caller falls back to default).
 */
function validateStrategy(value) {
    if (!value)
        return undefined;
    return VALID_STRATEGIES.includes(value)
        ? value
        : undefined;
}
/**
 * Normalize a cleanup time string.
 *
 * The input must follow "HH:MM" or "H:MM" format (24-hour clock).
 * If the time is valid, it returns the normalized format "HH:MM"
 * with leading zeros added when necessary.
 * If the format is invalid or the time is out of range
 * (hour: 0–23, minute: 0–59), it returns undefined.
 *
 * Examples:
 * normalizeCleanTime("3:05")  -> "03:05"
 * normalizeCleanTime("03:05") -> "03:05"
 * normalizeCleanTime("23:59") -> "23:59"
 *
 * normalizeCleanTime("24:00") -> undefined   // hour out of range
 * normalizeCleanTime("12:60") -> undefined   // minute out of range
 * normalizeCleanTime("3:5")   -> undefined   // minute must have two digits
 * normalizeCleanTime("abc")   -> undefined   // invalid format
 */
function normalizeCleanTime(input) {
    if (!input)
        return undefined;
    const trimmed = input.trim();
    const m = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (!m)
        return undefined;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isInteger(hh) || !Number.isInteger(mm))
        return undefined;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59)
        return undefined;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
/**
 * Normalize offload retention days.
 *
 * - `<= 0` → 0 (disabled)
 * - `(0, 3)` → 0 (invalid, force disabled)
 * - `>= 3` → as-is
 */
function normalizeOffloadRetentionDays(value) {
    if (value <= 0)
        return 0;
    if (value < 3)
        return 0;
    return value;
}
