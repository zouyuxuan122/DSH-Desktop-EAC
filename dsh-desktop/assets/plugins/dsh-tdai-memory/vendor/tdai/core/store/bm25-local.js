/**
 * Local BM25 Sparse Vector Encoder.
 *
 * Pure TypeScript replacement for the Python sidecar BM25 client.
 * Uses @tencentdb-agent-memory/tcvdb-text package for tokenization (jieba-wasm) and BM25 encoding.
 *
 * Two operations (same contract as the old BM25Client):
 * - `encodeTexts(texts)` — encode documents for upsert (TF-based)
 * - `encodeQueries(texts)` — encode queries for search (IDF-based)
 */
import { BM25Encoder } from "@tencentdb-agent-memory/tcvdb-text";
const TAG = "[memory-tdai][bm25-local]";
// ============================
// Implementation
// ============================
export class BM25LocalEncoder {
    encoder;
    logger;
    constructor(language = "zh", logger) {
        this.logger = logger;
        this.encoder = BM25Encoder.default(language);
        logger?.debug?.(`${TAG} Initialized BM25 local encoder (language=${language})`);
    }
    /**
     * Encode document texts for upsert (TF-based BM25 scoring).
     * Returns one SparseVector per input text.
     */
    encodeTexts(texts) {
        if (texts.length === 0)
            return [];
        try {
            return this.encoder.encodeTexts(texts);
        }
        catch (err) {
            this.logger?.warn(`${TAG} encodeTexts failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
    /**
     * Encode query texts for search (IDF-based BM25 scoring).
     * Returns one SparseVector per input text.
     */
    encodeQueries(texts) {
        if (texts.length === 0)
            return [];
        try {
            return this.encoder.encodeQueries(texts);
        }
        catch (err) {
            this.logger?.warn(`${TAG} encodeQueries failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
}
// ============================
// Factory
// ============================
/**
 * Create a BM25LocalEncoder if BM25 is enabled in config.
 * Returns undefined if disabled — callers should check before using.
 */
export function createBM25Encoder(config, logger) {
    if (!config.enabled) {
        logger?.debug?.(`${TAG} BM25 sparse encoding disabled`);
        return undefined;
    }
    return new BM25LocalEncoder(config.language ?? "zh", logger);
}
