/**
 * Checkpoint management for tracking memory processing progress.
 *
 * ## Split-state design
 *
 * Per-session state is split into two independent namespaces to prevent
 * the PipelineManager and L0/L1 runners from overwriting each other's fields:
 *
 * - **runner_states** (`RunnerSessionState`): owned by CheckpointManager methods
 *   (markL1*, advanceSession*). Contains L0 capture cursor, L1 cursor, scene name.
 *
 * - **pipeline_states** (`PipelineSessionState`): owned exclusively by
 *   PipelineManager via `mergePipelineStates()`. Contains conversation_count,
 *   extraction times, L2 tracking fields.
 *
 * Each side only reads/writes its own namespace, eliminating the split-brain
 * overwrite bug where pipeline persistStates() could clobber runner-written fields.
 *
 * ## Concurrency safety
 *
 * All mutating methods (read-modify-write) are serialized via a per-file async lock.
 * Multiple CheckpointManager instances sharing the same file path automatically share
 * the same lock, so callers can freely `new CheckpointManager()` without coordination.
 * Writes use atomic tmp+rename to prevent corruption on crash.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
const DEFAULT_RUNNER_STATE = {
    last_captured_timestamp: 0,
    last_l1_cursor: 0,
    last_scene_name: "",
};
const DEFAULT_PIPELINE_STATE = {
    conversation_count: 0,
    last_extraction_time: "",
    last_extraction_updated_time: "",
    last_active_time: 0,
    l2_pending_l1_count: 0,
    warmup_threshold: 0, // 0 = graduated (safe default for old sessions missing this field)
    l2_last_extraction_time: "",
};
const DEFAULT_CHECKPOINT = {
    last_captured_timestamp: 0,
    total_processed: 0,
    last_persona_at: 0,
    last_persona_time: "",
    request_persona_update: false,
    persona_update_reason: "",
    memories_since_last_persona: 0,
    scenes_processed: 0,
    runner_states: {},
    pipeline_states: {},
    l0_conversations_count: 0,
    total_memories_extracted: 0,
};
const noopLogger = { info() { } };
// ============================
// Per-file async lock
// ============================
// Keyed by resolved file path. Multiple CheckpointManager instances pointing
// to the same file automatically share the same lock — callers don't need to
// coordinate instance creation.
const fileLocks = new Map();
/**
 * Serialize async critical sections per file path.
 * Under no contention the overhead is a single resolved-promise await.
 */
async function withFileLock(filePath, fn) {
    // Chain after whatever is currently queued for this path
    const prev = fileLocks.get(filePath) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    fileLocks.set(filePath, gate);
    await prev;
    try {
        return await fn();
    }
    finally {
        release();
        // Clean up the map entry if we're the tail of the chain
        if (fileLocks.get(filePath) === gate) {
            fileLocks.delete(filePath);
        }
    }
}
export class CheckpointManager {
    filePath;
    logger;
    constructor(dataDir, logger) {
        this.filePath = path.join(dataDir, ".metadata", "recall_checkpoint.json");
        this.logger = logger ?? noopLogger;
    }
    // ============================
    // Low-level I/O (internal)
    // ============================
    async readRaw() {
        try {
            const raw = await fs.readFile(this.filePath, "utf-8");
            const parsed = JSON.parse(raw);
            // Merge with defaults for backward compat (old checkpoints lack new fields).
            // structuredClone avoids shallow-copy pitfall: without it, the nested
            // runner_states/pipeline_states objects in DEFAULT_CHECKPOINT would be
            // shared across all callers and mutated in place — corrupting the default.
            const cp = { ...structuredClone(DEFAULT_CHECKPOINT), ...parsed };
            // Migrate from old session_states format (pre-split)
            const oldStates = parsed.session_states;
            if (oldStates && !parsed.runner_states && !parsed.pipeline_states) {
                cp.runner_states = {};
                cp.pipeline_states = {};
                for (const [key, state] of Object.entries(oldStates)) {
                    cp.runner_states[key] = {
                        ...DEFAULT_RUNNER_STATE,
                        last_captured_timestamp: state.last_captured_timestamp ?? 0,
                        last_l1_cursor: state.last_l1_cursor ?? 0,
                        last_scene_name: state.last_scene_name ?? "",
                    };
                    cp.pipeline_states[key] = {
                        ...DEFAULT_PIPELINE_STATE,
                        conversation_count: state.conversation_count ?? 0,
                        last_extraction_time: state.last_extraction_time ?? "",
                        last_extraction_updated_time: state.last_extraction_updated_time ?? "",
                        last_active_time: state.last_active_time ?? 0,
                        l2_pending_l1_count: state.l2_pending_l1_count ?? 0,
                        l2_last_extraction_time: state.l2_last_extraction_time ?? "",
                    };
                }
            }
            else {
                // Ensure per-session states have all fields with defaults
                if (cp.runner_states) {
                    for (const [key, state] of Object.entries(cp.runner_states)) {
                        cp.runner_states[key] = { ...DEFAULT_RUNNER_STATE, ...state };
                    }
                }
                if (cp.pipeline_states) {
                    for (const [key, state] of Object.entries(cp.pipeline_states)) {
                        cp.pipeline_states[key] = { ...DEFAULT_PIPELINE_STATE, ...state };
                    }
                }
            }
            return cp;
        }
        catch {
            return structuredClone(DEFAULT_CHECKPOINT);
        }
    }
    /** Atomic write: write to tmp file, then rename into place. */
    async writeRaw(checkpoint) {
        const dir = path.dirname(this.filePath);
        await fs.mkdir(dir, { recursive: true });
        const tmp = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
        await fs.writeFile(tmp, JSON.stringify(checkpoint, null, 2), "utf-8");
        await fs.rename(tmp, this.filePath);
    }
    // ============================
    // Locked read-modify-write helper
    // ============================
    /**
     * Execute a mutating operation under the per-file lock.
     * `fn` receives the current checkpoint and may modify it in place;
     * the updated checkpoint is atomically written back.
     */
    async mutate(fn) {
        return withFileLock(this.filePath, async () => {
            const cp = await this.readRaw();
            await fn(cp);
            await this.writeRaw(cp);
            return cp;
        });
    }
    // ============================
    // Public API — read-only
    // ============================
    /**
     * Read the current checkpoint (unlocked snapshot).
     *
     * NOTE: This does NOT acquire the file lock. The returned snapshot may be
     * stale if a concurrent `mutate()` is in progress. This is acceptable for
     * read-only uses (status display, deciding whether to run a pipeline step).
     *
     * For read-then-write patterns, always use `mutate()` instead — it acquires
     * the lock and re-reads from disk inside the critical section, ensuring the
     * update is based on the latest state.
     */
    async read() {
        return this.readRaw();
    }
    /** Write a full checkpoint (acquires lock + atomic write). */
    async write(checkpoint) {
        return withFileLock(this.filePath, () => this.writeRaw(checkpoint));
    }
    // ============================
    // Public API — mutating (all serialized via file lock)
    // ============================
    // ============================
    // Persona methods (L3)
    // ============================
    async markPersonaGenerated(totalProcessed) {
        await this.mutate((cp) => {
            cp.last_persona_at = totalProcessed;
            cp.last_persona_time = new Date().toISOString();
            cp.memories_since_last_persona = 0;
            cp.request_persona_update = false;
            cp.persona_update_reason = "";
        });
    }
    async clearPersonaRequest() {
        await this.mutate((cp) => {
            cp.request_persona_update = false;
            cp.persona_update_reason = "";
        });
    }
    async setPersonaUpdateRequest(reason) {
        await this.mutate((cp) => {
            cp.request_persona_update = true;
            cp.persona_update_reason = reason;
        });
    }
    async incrementScenesProcessed() {
        const cp = await this.mutate((cp) => {
            cp.scenes_processed += 1;
        });
        this.logger.info(`[checkpoint] incrementScenesProcessed: scenes_processed=${cp.scenes_processed}`);
    }
    // ============================
    // Per-session helpers — runner state (L0/L1 owned)
    // ============================
    /**
     * Get or create runner session state for a session.
     */
    getRunnerState(cp, sessionKey) {
        if (!cp.runner_states) {
            cp.runner_states = {};
        }
        let state = cp.runner_states[sessionKey];
        if (!state) {
            state = { ...DEFAULT_RUNNER_STATE };
            cp.runner_states[sessionKey] = state;
        }
        return state;
    }
    // ============================
    // Per-session helpers — pipeline state (PipelineManager owned)
    // ============================
    /**
     * Get or create pipeline session state for a session.
     */
    getPipelineState(cp, sessionKey) {
        if (!cp.pipeline_states) {
            cp.pipeline_states = {};
        }
        let state = cp.pipeline_states[sessionKey];
        if (!state) {
            state = { ...DEFAULT_PIPELINE_STATE, last_active_time: Date.now() };
            cp.pipeline_states[sessionKey] = state;
        }
        return state;
    }
    /**
     * Get all pipeline states from checkpoint.
     */
    getAllPipelineStates(cp) {
        return cp.pipeline_states ?? {};
    }
    /**
     * Merge pipeline session states into the checkpoint (used by pipeline persister).
     * Acquires the file lock so this is safe against concurrent mutations.
     *
     * This writes ONLY to `pipeline_states`, never touching `runner_states`.
     * This is the core guarantee that eliminates the split-brain overwrite bug.
     */
    async mergePipelineStates(states) {
        await this.mutate((cp) => {
            if (!cp.pipeline_states)
                cp.pipeline_states = {};
            for (const [key, pState] of Object.entries(states)) {
                cp.pipeline_states[key] = {
                    ...cp.pipeline_states[key],
                    ...pState,
                };
            }
        });
    }
    // ============================
    // L1-specific methods
    // ============================
    /**
     * Mark L1 extraction completed: reset sinceL1 counter, advance L1 cursor,
     * and optionally save the last scene name for cross-batch continuity.
     *
     * @param cursorRecordedAtMs - The max recorded_at epoch ms of processed L0 messages.
     *   This becomes the new `last_l1_cursor` value (recorded_at semantics, not conversation timestamp).
     */
    async markL1ExtractionComplete(sessionKey, memoriesExtracted, cursorRecordedAtMs, lastSceneName) {
        await this.mutate((cp) => {
            const state = this.getRunnerState(cp, sessionKey);
            if (cursorRecordedAtMs) {
                state.last_l1_cursor = cursorRecordedAtMs;
            }
            if (lastSceneName !== undefined) {
                state.last_scene_name = lastSceneName;
            }
            cp.total_memories_extracted += memoriesExtracted;
            cp.memories_since_last_persona += memoriesExtracted;
        });
        this.logger.info(`[checkpoint] markL1ExtractionComplete session=${sessionKey}: ` +
            `extracted=${memoriesExtracted}, cursor=${cursorRecordedAtMs ?? "(unchanged)"}, ` +
            `lastScene="${lastSceneName ?? "(unchanged)"}"`);
    }
    // ============================
    // Atomic capture (race-condition fix)
    // ============================
    /**
     * Atomically read the per-session cursor, execute the capture callback,
     * and advance the cursor — all within a single file-lock critical section.
     *
     * This eliminates the race window that existed when `read()` (unlocked) and
     * `advanceSessionCapturedTimestamp()` (locked) were separate calls:
     * two concurrent `agent_end` events could both read the same stale cursor
     * and record duplicate messages.
     *
     * The callback receives `afterTimestamp` (the current per-session cursor)
     * and must return either:
     *   - `{ maxTimestamp, messageCount }` to advance the cursor, or
     *   - `null` to leave the cursor unchanged (nothing captured).
     *
     * L0 conversation count is also incremented inside the lock when messages
     * are captured, removing the need for a separate `incrementL0ConversationCount()` call.
     *
     * @param sessionKey   Per-session identifier
     * @param pluginStartTimestamp  Cold-start floor (used when no cursor exists yet)
     * @param fn  Async callback that performs the actual capture (recordConversation, etc.)
     */
    async captureAtomically(sessionKey, pluginStartTimestamp, fn) {
        await this.mutate(async (cp) => {
            // Read the per-session cursor inside the lock
            const state = this.getRunnerState(cp, sessionKey);
            let afterTimestamp = state.last_captured_timestamp || 0;
            // Cold-start guard (same logic that was previously in auto-capture.ts)
            // Subtract 1ms from the plugin-start floor: the very first turn may be
            // flushed in the same millisecond the plugin started, and the L0 filter
            // is strict `timestamp > cursor` — an identical timestamp would drop
            // the first turn entirely.
            if (afterTimestamp === 0 && pluginStartTimestamp && pluginStartTimestamp > 0) {
                afterTimestamp = pluginStartTimestamp - 1;
            }
            const result = await fn(afterTimestamp);
            if (result) {
                // Advance per-session cursor (runner-owned)
                state.last_captured_timestamp = result.maxTimestamp;
                // Global stats (aggregate only — not used for filtering)
                cp.last_captured_timestamp = Math.max(cp.last_captured_timestamp, result.maxTimestamp);
                cp.total_processed += result.messageCount;
                // Increment L0 conversation count (was a separate mutate() call before)
                cp.l0_conversations_count += 1;
            }
        });
    }
}
