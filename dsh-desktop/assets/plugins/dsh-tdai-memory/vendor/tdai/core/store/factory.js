/**
 * Store Factory — creates the appropriate storage backend and embedding service
 * based on plugin configuration.
 *
 * Supports:
 * - "sqlite" (default): local SQLite + sqlite-vec + FTS5
 * - "tcvdb": Tencent Cloud VectorDB (server-side embedding + hybridSearch)
 */
import path from "node:path";
import { VectorStore } from "./sqlite.js";
import { TcvdbMemoryStore } from "./tcvdb.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import { createBM25Encoder } from "./bm25-local.js";
const TAG = "[memory-tdai][factory]";
/**
 * Create the storage backend, embedding service, and optional BM25 encoder
 * based on plugin configuration.
 *
 * @param config       Fully resolved plugin config.
 * @param options.dataDir    Plugin data directory.
 * @param options.logger     Logger instance.
 */
export function createStoreBundle(config, options) {
    const { logger } = options;
    // ── BM25 local encoder ──
    const bm25Encoder = createBM25Encoder(config.bm25, logger);
    switch (config.storeBackend) {
        case "tcvdb": {
            const tcvdbCfg = config.tcvdb;
            if (!tcvdbCfg.url || !tcvdbCfg.apiKey) {
                throw new Error(`${TAG} TCVDB backend requires tcvdb.url and tcvdb.apiKey`);
            }
            if (!tcvdbCfg.database) {
                throw new Error(`${TAG} TCVDB backend requires tcvdb.database — please set a unique database name in your openclaw.json plugin config`);
            }
            const database = tcvdbCfg.database;
            const store = new TcvdbMemoryStore({
                url: tcvdbCfg.url,
                username: tcvdbCfg.username,
                apiKey: tcvdbCfg.apiKey,
                database,
                embeddingModel: tcvdbCfg.embeddingModel,
                timeout: tcvdbCfg.timeout,
                caPemPath: tcvdbCfg.caPemPath,
                logger,
                bm25Encoder: bm25Encoder ?? undefined,
            });
            logger?.debug?.(`${TAG} Store created: backend=tcvdb, database=${database}, model=${tcvdbCfg.embeddingModel}, ` +
                `bm25=${bm25Encoder ? "enabled" : "disabled"}`);
            return {
                store,
                embedding: new NoopEmbeddingService(),
                bm25Encoder,
                storeSnapshot: {
                    type: "tcvdb",
                    tcvdbUrl: tcvdbCfg.url,
                    tcvdbDatabase: database,
                    tcvdbAlias: tcvdbCfg.alias || undefined,
                },
            };
        }
        case "sqlite":
        default: {
            // ── Embedding service (only when enabled) ──
            let embeddingService;
            if (config.embedding.enabled && config.embedding.provider !== "local" && config.embedding.apiKey) {
                embeddingService = createEmbeddingService({
                    provider: config.embedding.provider,
                    baseUrl: config.embedding.baseUrl,
                    apiKey: config.embedding.apiKey,
                    model: config.embedding.model,
                    dimensions: config.embedding.dimensions,
                    sendDimensions: config.embedding.sendDimensions,
                    maxInputChars: config.embedding.maxInputChars,
                }, logger);
            }
            // dimensions from config (0 when provider="none" → vec0 deferred)
            const dims = config.embedding.dimensions;
            const dbPath = path.join(options.dataDir, "vectors.db");
            const store = new VectorStore(dbPath, dims, logger);
            logger?.debug?.(`${TAG} Store created: backend=sqlite, dbPath=${dbPath}, dimensions=${dims}, ` +
                `embedding=${embeddingService ? "enabled" : "disabled"}, ` +
                `bm25=${bm25Encoder ? "enabled" : "disabled"}`);
            return {
                store,
                embedding: embeddingService,
                bm25Encoder,
                storeSnapshot: {
                    type: "sqlite",
                    sqlitePath: path.relative(options.dataDir, dbPath),
                },
            };
        }
    }
}
