/**
 * Tencent Cloud VectorDB HTTP Client.
 *
 * Thin wrapper around the VectorDB HTTP API. Handles authentication, timeouts,
 * retries (5xx / timeout), and error normalization.
 *
 * API docs: https://cloud.tencent.com/document/product/1709
 */
import fs from "node:fs";
import { request as undiciRequest, Agent as UndiciAgent } from "undici";
export class TcvdbApiError extends Error {
    apiCode;
    constructor(path, code, msg) {
        super(`VectorDB ${path}: code=${code}, msg=${msg}`);
        this.name = "TcvdbApiError";
        this.apiCode = code;
    }
}
// ============================
// Client
// ============================
const TAG = "[memory-tdai][tcvdb-client]";
const MAX_RETRIES = 2;
export class TcvdbClient {
    baseUrl;
    authHeader;
    database;
    timeout;
    logger;
    /** undici dispatcher for HTTPS + custom CA. */
    dispatcher;
    constructor(config, logger) {
        this.baseUrl = config.url.replace(/\/+$/, "");
        this.authHeader = `Bearer account=${config.username}&api_key=${config.apiKey}`;
        this.database = config.database;
        this.timeout = config.timeout;
        this.logger = logger;
        // Log connection info at construction time.
        this.logger?.debug?.(`${TAG} url=${this.baseUrl} db=${this.database} timeout=${this.timeout}${this.baseUrl.startsWith("https://") ? ` https=true caPemPath=${config.caPemPath ?? "(none)"}` : ""}`);
        // For HTTPS with a custom CA certificate, create a dedicated undici Agent.
        // We use undici.request() instead of global fetch because fetch's
        // `dispatcher` option is unreliable across Node versions.
        if (this.baseUrl.startsWith("https://") && config.caPemPath) {
            try {
                const ca = fs.readFileSync(config.caPemPath, "utf-8");
                this.dispatcher = new UndiciAgent({ connect: { ca } });
                this.logger?.debug?.(`${TAG} HTTPS enabled with CA from ${config.caPemPath}`);
            }
            catch (err) {
                this.logger?.error(`${TAG} Failed to load CA PEM from ${config.caPemPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    // ── Generic request ─────────────────────────────────────
    /**
     * Send a POST request to VectorDB API.
     * Handles auth, timeout, retries (5xx/timeout), and error unwrapping.
     */
    async request(path, body) {
        let lastError;
        const t0 = performance.now();
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const tAttempt = performance.now();
            try {
                this.logger?.debug?.(`${TAG} → ${path} attempt=${attempt} body=${JSON.stringify(body).slice(0, 500)}`);
                const { statusCode, body: respBody } = await undiciRequest(`${this.baseUrl}${path}`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": this.authHeader,
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(this.timeout),
                    ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
                });
                const text = await respBody.text();
                const json = JSON.parse(text);
                const attemptMs = Math.round(performance.now() - tAttempt);
                this.logger?.debug?.(`${TAG} ← ${path} status=${statusCode} code=${json.code} attemptMs=${attemptMs} attempt=${attempt}`);
                if (json.code !== 0) {
                    const err = new TcvdbApiError(path, json.code, json.msg);
                    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500)
                        throw err;
                    lastError = err;
                    continue;
                }
                // Always log completion at info level (one line per request)
                const totalMs = Math.round(performance.now() - t0);
                this.logger?.info(`${TAG} ${path} ${totalMs}ms${attempt > 0 ? ` (${attempt + 1} attempts)` : ""}`);
                return json;
            }
            catch (err) {
                const attemptMs = Math.round(performance.now() - tAttempt);
                if (err instanceof TcvdbApiError && err.apiCode !== 0)
                    throw err;
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt < MAX_RETRIES) {
                    const delay = 500 * (attempt + 1);
                    this.logger?.debug?.(`${TAG} ${path} retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms (lastAttemptMs=${attemptMs}, error=${lastError.message})`);
                    await new Promise((r) => setTimeout(r, delay));
                }
            }
        }
        const totalMs = Math.round(performance.now() - t0);
        this.logger?.debug?.(`${TAG} ✗ ${path} totalMs=${totalMs} attempts=${MAX_RETRIES + 1} error=${lastError?.message}`);
        throw lastError ?? new Error(`${TAG} ${path} failed after retries`);
    }
    // ── Database operations ─────────────────────────────────
    async createDatabase(dbName) {
        const name = dbName ?? this.database;
        // SDK pattern: list first, create only if not found
        const listResp = await this.request("/database/list", {});
        const exists = (listResp.databases ?? []).includes(name);
        if (exists) {
            this.logger?.debug?.(`${TAG} Database already exists: ${name}`);
            return false;
        }
        await this.request("/database/create", { database: name });
        this.logger?.info(`${TAG} Database created: ${name}`);
        return true;
    }
    // ── Collection operations ───────────────────────────────
    async createCollection(params) {
        const name = String(params.collection ?? "");
        // SDK pattern: try describe first, create only if not found (code 15302)
        try {
            await this.describeCollection(name);
            this.logger?.debug?.(`${TAG} Collection already exists: ${name}`);
            return;
        }
        catch (err) {
            if (!(err instanceof TcvdbApiError && err.apiCode === 15302)) {
                throw err; // unexpected error
            }
            // 15302 = collection not found → proceed to create
        }
        try {
            await this.request("/collection/create", {
                database: this.database,
                ...params,
            });
            this.logger?.info(`${TAG} Collection created: ${name}`);
        }
        catch (err) {
            // 15202 = collection already exists — race between describe and create.
            // Semantically identical to "describe found it", so treat as success.
            if (err instanceof TcvdbApiError && err.apiCode === 15202) {
                this.logger?.debug?.(`${TAG} Collection already exists (race): ${name}`);
                return;
            }
            throw err;
        }
    }
    async describeCollection(collection) {
        const resp = await this.request("/collection/describe", {
            database: this.database,
            collection,
        });
        return resp.collection;
    }
    // ── Document operations ─────────────────────────────────
    async upsert(collection, documents) {
        await this.request("/document/upsert", {
            database: this.database,
            collection,
            buildIndex: true,
            documents,
        });
    }
    async search(collection, searchParams) {
        return this.request("/document/search", {
            database: this.database,
            collection,
            readConsistency: "strongConsistency",
            search: searchParams,
        });
    }
    async hybridSearch(collection, searchParams) {
        return this.request("/document/hybridSearch", {
            database: this.database,
            collection,
            readConsistency: "strongConsistency",
            search: searchParams,
        });
    }
    async query(collection, queryParams) {
        return this.request("/document/query", {
            database: this.database,
            collection,
            readConsistency: "strongConsistency",
            query: queryParams,
        });
    }
    async deleteDoc(collection, params) {
        await this.request("/document/delete", {
            database: this.database,
            collection,
            ...params,
        });
    }
    /**
     * Count documents matching an optional filter.
     * Uses the dedicated /document/count endpoint.
     */
    async count(collection, filter) {
        const query = {};
        if (filter)
            query.filter = filter;
        const resp = await this.request("/document/count", {
            database: this.database,
            collection,
            readConsistency: "strongConsistency",
            query,
        });
        return resp.count ?? 0;
    }
    // ── Convenience getters ─────────────────────────────────
    getDatabase() {
        return this.database;
    }
}
