/**
 * L1 Memory Writer: writes extracted memories to JSONL files.
 *
 * File naming: records/YYYY-MM-DD.jsonl (daily shards, all sessions merged).
 * Each record includes sessionKey for traceability.
 *
 * Write strategy:
 * - JSONL is the append-only persistent store (source of truth for backup/recovery).
 * - VectorStore (SQLite) is the primary retrieval engine.
 * - On update/merge, old records are deleted from VectorStore in real-time;
 *   JSONL is append-only and cleaned up periodically by memory-cleaner.
 *
 * Supports store (append), update, merge, and skip operations.
 *
 * v3: Aligned with Kenty's prompt output format — 3 memory types (persona/episodic/instruction),
 * numeric priority, scene_name, source_message_ids, metadata, timestamps.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { formatLocalDate } from "../../utils/time.js";
const TAG = "[memory-tdai][l1-writer]";
// ============================
// Core functions
// ============================
/**
 * Generate a unique memory ID.
 */
export function generateMemoryId() {
    return `m_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}
/**
 * Write a memory record according to the dedup decision.
 *
 * - store: append new record
 * - update: remove target records + append updated record
 * - merge: remove target records + append merged record
 * - skip: do nothing
 *
 * v3: supports multi-target removal for update/merge.
 * v3.1: optional VectorStore + EmbeddingService for dual-write (JSONL + vector).
 */
export async function writeMemory(params) {
    const { memory, decision, baseDir, sessionKey, sessionId, logger, vectorStore, embeddingService } = params;
    if (decision.action === "skip") {
        logger?.debug?.(`${TAG} Skipping memory: ${memory.content.slice(0, 50)}...`);
        return null;
    }
    const now = new Date().toISOString();
    // Determine final content, type, priority based on action
    let finalContent;
    let finalType;
    let finalPriority;
    let finalTimestamps;
    if (decision.action === "merge" || decision.action === "update") {
        finalContent = decision.merged_content ?? memory.content;
        finalType = decision.merged_type ?? memory.type;
        finalPriority = decision.merged_priority ?? memory.priority;
        finalTimestamps = decision.merged_timestamps ?? [now];
    }
    else {
        // store
        finalContent = memory.content;
        finalType = memory.type;
        finalPriority = memory.priority;
        finalTimestamps = [now];
    }
    const record = {
        id: decision.record_id || generateMemoryId(),
        content: finalContent,
        type: finalType,
        priority: finalPriority,
        scene_name: memory.scene_name,
        source_message_ids: memory.source_message_ids,
        metadata: memory.metadata,
        timestamps: finalTimestamps,
        createdAt: now,
        updatedAt: now,
        sessionKey,
        sessionId: sessionId || "",
    };
    const recordsDir = path.join(baseDir, "records");
    await fs.mkdir(recordsDir, { recursive: true });
    const shardDate = formatLocalDate(new Date());
    const filePath = path.join(recordsDir, `${shardDate}.jsonl`);
    if ((decision.action === "update" || decision.action === "merge") && decision.target_ids.length > 0) {
        // Remove target records from VectorStore (real-time deletion for retrieval accuracy).
        // JSONL is append-only — old records remain in files and are cleaned up periodically
        // by memory-cleaner (which reconciles against VectorStore as source of truth).
        if (vectorStore) {
            try {
                await vectorStore.deleteL1Batch(decision.target_ids);
                logger?.debug?.(`${TAG} VectorStore: deleted ${decision.target_ids.length} target record(s) for ${decision.action}`);
            }
            catch (err) {
                logger?.warn?.(`${TAG} VectorStore delete failed for ${decision.action}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
        logger?.debug?.(`${TAG} ${decision.action} memory: removed [${decision.target_ids.join(",")}] from VectorStore → ${record.id}: ${finalContent.slice(0, 80)}...`);
    }
    else {
        // store: append a new line
        await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
        logger?.debug?.(`${TAG} Stored memory ${record.id}: ${finalContent.slice(0, 80)}...`);
    }
    // === Vector Store dual-write ===
    if (vectorStore) {
        try {
            logger?.debug?.(`${TAG} [vec-dual-write] START id=${record.id}, contentLen=${record.content.length}, ` +
                `content="${record.content.slice(0, 80)}..."`);
            let embedding;
            if (embeddingService) {
                try {
                    embedding = await embeddingService.embed(record.content);
                    logger?.debug?.(`${TAG} [vec-dual-write] Embedding OK: dims=${embedding.length}, ` +
                        `norm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`);
                }
                catch (embedErr) {
                    // Embedding failed — pass undefined to upsert() which writes
                    // metadata + FTS only, skipping the vec0 table.
                    logger?.warn(`${TAG} [vec-dual-write] Embedding FAILED for id=${record.id}, ` +
                        `will write metadata only: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`);
                }
            }
            const upsertOk = await vectorStore.upsertL1(record, embedding);
            logger?.debug?.(`${TAG} [vec-dual-write] upsert result=${upsertOk} id=${record.id}`);
        }
        catch (err) {
            // Vector write failure should NOT block the main JSONL write
            logger?.warn?.(`${TAG} [vec-dual-write] FAILED (JSONL already written) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    else {
        logger?.debug?.(`${TAG} [vec-dual-write] SKIPPED id=${record.id}: vectorStore=${!!vectorStore}`);
    }
    return record;
}
// ============================
// Helpers
// ============================
