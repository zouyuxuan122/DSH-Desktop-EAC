/**
 * MemoryPipelineManager: manages the L0→L1→L2→L3 memory extraction pipeline.
 *
 * ## Layered architecture
 *
 * - **L0 (capture)**: `auto-capture.ts` extracts new messages from each
 *   `agent_end` event, sanitizes them, and passes them to the pipeline via
 *   `notifyConversation(sessionKey, messages)`. Messages are buffered
 *   locally per-session — NO remote call happens at this stage.
 *
 * - **L1 (batch extraction / ingest)**: When the conversation count reaches
 *   `everyNConversations` OR the session goes idle for `l1IdleTimeoutSeconds`,
 *   the L1 Runner is invoked with all buffered messages. The runner receives
 *   `{ sessionKey, msg, bg_msg }` and is responsible for ingesting/extracting
 *   them (e.g. calling appendEvent, or running local extraction logic).
 *   `bg_msg` is reserved for background context; currently always empty.
 *
 * - **L2 (scene extraction)**: Per-session downward-only timer. After each
 *   L2 completion, the next fire time is set to `now + maxInterval`. When
 *   L1 completes (new memory event), the fire time is advanced (but never
 *   postponed) to `max(now + delay, lastL2 + minInterval)`. When the timer
 *   fires, if the session is cold (inactive > `sessionActiveWindowHours`),
 *   the timer is cancelled rather than triggering L2 — it will be re-armed
 *   by the next L1 event.
 *
 * - **L3 (persona generation)**: Global mutex (concurrency=1) + pending flag
 *   dedup. Triggered after L2 completes.
 *
 * ## Timer semantics
 *
 * L1 uses a **resettable timer** (classic idle/debounce): each conversation
 * resets the countdown to `l1IdleTimeoutSeconds`. When the timer fires,
 * buffered messages are flushed through L1.
 *
 * L2 uses a **downward-only timer**: the scheduled fire time can only be
 * moved earlier, never later. This ensures both the maxInterval guarantee
 * and the delay-after-L1 responsiveness, while minInterval acts as a floor.
 *
 * Both timer types are implemented via `ManagedTimer` to eliminate
 * repetitive clear→set→fire→clean boilerplate.
 *
 * ## Trigger paths for L1
 *   A. **Conversation threshold** (primary): when `conversation_count >=
 *      effectiveThreshold` in `notifyConversation()`, L1 is triggered
 *      immediately with all buffered messages. The effective threshold
 *      is influenced by warm-up mode (see below).
 *   B. **Idle timeout** (catch-up): when a session goes idle for
 *      `l1IdleTimeoutSeconds`, L1 fires with whatever messages have
 *      been buffered (below threshold).
 *   C. **Shutdown flush**: on graceful shutdown, all pending buffers
 *      are flushed through L1 then L2.
 *
 * ## Warm-up mode
 *
 * When `enableWarmup` is true (default), new sessions use an exponentially
 * increasing L1 trigger threshold instead of jumping straight to
 * `everyNConversations`. The sequence is: 1 → 2 → 4 → 8 → ... →
 * everyNConversations. This ensures early conversations are processed
 * quickly (first conversation triggers L1 immediately), while gradually
 * reducing processing frequency as the session matures.
 *
 * The `warmup_threshold` field in PipelineSessionState tracks the current
 * threshold. A value of 0 means warm-up is complete (graduated to
 * steady-state). The threshold doubles after each successful L1 run.
 *
 * ## Trigger paths for L2
 *   A. **Delay-after-L1**: L1 completes → timer advanced to
 *      `max(now + delay, lastL2 + min)` → fires → enqueue L2.
 *   B. **MaxInterval guarantee**: L2 completes → timer set to
 *      `now + maxInterval` → fires → enqueue L2 (if session active).
 *   C. **Shutdown flush**: all pending L2 timers are flushed.
 *
 * All queues use SerialQueue (concurrency=1) for serial execution.
 *
 * ## Design doc
 * See `docs/08-pipeline-refactor-design.md` for full architecture.
 */
import { SessionFilter } from "./session-filter.js";
import { ManagedTimer } from "./managed-timer.js";
import { SerialQueue } from "./serial-queue.js";
import { report } from "../core/report/reporter.js";
const TAG = "[memory-tdai] [pipeline]";
export class MemoryPipelineManager {
    // Config (converted to ms internally)
    l1IdleTimeoutMs;
    everyNConversations;
    enableWarmup;
    l2DelayAfterL1Ms;
    l2MinIntervalMs;
    l2MaxIntervalMs;
    sessionActiveWindowMs;
    /** Delay before retrying a failed L1 (ms). */
    L1_RETRY_DELAY_MS = 30_000; // 30 seconds
    /** Max consecutive L1 retries per session before giving up. */
    L1_MAX_RETRIES = 5;
    // Queues (named for diagnostics)
    l1Queue = new SerialQueue("L1");
    l2Queue = new SerialQueue("L2");
    l3Queue = new SerialQueue("L3");
    // L3 dedup flag
    l3Pending = false;
    l3Running = false;
    // Per-session state
    sessionStates = new Map();
    sessionTimers = new Map();
    // Per-session message buffer: messages accumulated since last L1 run
    messageBuffers = new Map();
    // Per-session L2 last run time (epoch ms, for minInterval floor)
    l2LastRunTime = new Map();
    // Callbacks
    l1Runner = null;
    l2Runner = null;
    l3Runner = null;
    persister = null;
    logger;
    // Unified session filter (internal sessions + excludeAgents)
    sessionFilter;
    // Lifecycle
    destroyed = false;
    /** Plugin instance ID for metric reporting (set externally after async init). */
    instanceId;
    // Session GC: runs periodically to evict cold sessions from memory
    /** Multiplier on sessionActiveWindowMs to determine GC eligibility. */
    SESSION_GC_INACTIVE_MULTIPLIER = 3;
    /** Run GC every N calls to notifyConversation. */
    SESSION_GC_EVERY_N_NOTIFICATIONS = 50;
    /** Counter for GC scheduling. */
    notifyCounter = 0;
    constructor(config, logger, sessionFilter) {
        this.l1IdleTimeoutMs = config.l1.idleTimeoutSeconds * 1000;
        this.everyNConversations = config.everyNConversations;
        this.enableWarmup = config.enableWarmup;
        this.l2DelayAfterL1Ms = config.l2.delayAfterL1Seconds * 1000;
        this.l2MinIntervalMs = config.l2.minIntervalSeconds * 1000;
        this.l2MaxIntervalMs = config.l2.maxIntervalSeconds * 1000;
        this.sessionActiveWindowMs = config.l2.sessionActiveWindowHours * 60 * 60 * 1000;
        this.logger = logger;
        this.sessionFilter = sessionFilter ?? new SessionFilter();
        this.logger?.debug?.(`${TAG} Initialized: everyNConversations=${config.everyNConversations}, ` +
            `warmup=${config.enableWarmup ? "enabled" : "disabled"}, ` +
            `l1IdleTimeout=${config.l1.idleTimeoutSeconds}s, ` +
            `l2DelayAfterL1=${config.l2.delayAfterL1Seconds}s, ` +
            `l2MinInterval=${config.l2.minIntervalSeconds}s, ` +
            `l2MaxInterval=${config.l2.maxIntervalSeconds}s, ` +
            `sessionActiveWindow=${config.l2.sessionActiveWindowHours}h`);
        // Wire up queue debug logging
        if (this.logger?.debug) {
            const debugFn = (msg) => this.logger?.debug?.(`${TAG} ${msg}`);
            this.l1Queue.setDebugLogger(debugFn);
            this.l2Queue.setDebugLogger(debugFn);
            this.l3Queue.setDebugLogger(debugFn);
        }
    }
    // ============================
    // Setup
    // ============================
    setL1Runner(runner) {
        this.l1Runner = runner;
    }
    setL2Runner(runner) {
        this.l2Runner = runner;
    }
    setL3Runner(runner) {
        this.l3Runner = runner;
    }
    setPersister(persister) {
        this.persister = persister;
    }
    /**
     * Restore session states from checkpoint and start the pipeline.
     * Sessions with pending counts will be immediately re-enqueued.
     */
    start(restoredStates) {
        if (this.destroyed)
            return;
        if (restoredStates) {
            let skipped = 0;
            for (const [sessionKey, state] of Object.entries(restoredStates)) {
                if (this.sessionFilter.shouldSkip(sessionKey)) {
                    skipped++;
                    continue;
                }
                // Backfill warmup_threshold for sessions persisted before warm-up feature.
                // Missing field → treat as graduated (warmup already complete).
                const patched = { ...state };
                if (patched.warmup_threshold == null) {
                    patched.warmup_threshold = 0;
                }
                this.sessionStates.set(sessionKey, patched);
            }
            this.logger?.info(`${TAG} Restored ${this.sessionStates.size} session state(s) from checkpoint` +
                (skipped > 0 ? ` (filtered ${skipped} internal)` : ""));
        }
        // Recovery: re-enqueue sessions with pending work
        this.recoverPendingSessions();
        this.logger?.info(`${TAG} Pipeline started`);
    }
    // ============================
    // L0→L1: Notify (called from auto-capture on agent_end)
    // ============================
    /**
     * Get the effective conversation threshold for a session, considering warm-up.
     *
     * When warm-up is enabled, new sessions start with threshold=1 and double
     * after each successful L1 run: 1 → 2 → 4 → 8 → ... → everyNConversations.
     * Once the threshold reaches everyNConversations, warm-up is considered complete
     * (warmup_threshold is set to 0) and the fixed config value is used.
     */
    getEffectiveThreshold(state) {
        if (!this.enableWarmup)
            return this.everyNConversations;
        // warmup_threshold === 0 means warm-up completed; use steady-state config
        if (state.warmup_threshold <= 0)
            return this.everyNConversations;
        return Math.min(state.warmup_threshold, this.everyNConversations);
    }
    /**
     * Advance the warm-up threshold for a session after a successful L1 run.
     * Doubles the threshold until it reaches everyNConversations, then marks
     * warm-up as complete (warmup_threshold = 0).
     */
    advanceWarmupThreshold(state) {
        if (!this.enableWarmup)
            return;
        if (state.warmup_threshold <= 0)
            return; // already graduated
        const next = state.warmup_threshold * 2;
        if (next >= this.everyNConversations) {
            // Graduated: switch to steady-state
            state.warmup_threshold = 0;
            this.logger?.debug?.(`${TAG} Warm-up graduated → using steady-state threshold ${this.everyNConversations}`);
        }
        else {
            state.warmup_threshold = next;
            this.logger?.debug?.(`${TAG} Warm-up advanced → next threshold ${next}`);
        }
    }
    /**
     * Notify the pipeline that a conversation round has ended for a session,
     * and buffer the captured messages for L1 batch processing.
     *
     * Two trigger paths start here:
     * - **Path A (threshold)**: if conversation_count >= effective threshold
     *   (warm-up or steady-state), trigger L1 immediately with all buffered messages.
     * - **Path B (idle)**: reset the L1 idle timer. When the timer fires (user
     *   stops chatting), L1 runs with whatever has been buffered.
     */
    async notifyConversation(sessionKey, messages) {
        if (this.destroyed)
            return;
        if (this.sessionFilter.shouldSkip(sessionKey))
            return;
        const state = this.getOrCreateState(sessionKey);
        state.conversation_count += 1;
        state.last_active_time = Date.now();
        // Reset L1 retry count on new conversation (environment may have recovered)
        const timers = this.getOrCreateTimers(sessionKey);
        timers.l1RetryCount = 0;
        // Buffer messages for L1
        const buffer = this.messageBuffers.get(sessionKey) ?? [];
        buffer.push(...messages);
        this.messageBuffers.set(sessionKey, buffer);
        const effectiveThreshold = this.getEffectiveThreshold(state);
        const warmupInfo = this.enableWarmup && state.warmup_threshold > 0
            ? ` (warmup: ${state.warmup_threshold})`
            : "";
        this.logger?.debug?.(`${TAG} [${sessionKey}] notify: conversation_count=${state.conversation_count}/${effectiveThreshold}${warmupInfo}, ` +
            `buffered_messages=${buffer.length} (+${messages.length} new)`);
        await this.persistStates();
        // Path A: conversation count reached effective threshold → trigger L1 batch
        if (state.conversation_count >= effectiveThreshold) {
            this.logger?.debug?.(`${TAG} [${sessionKey}] Conversation threshold reached (${state.conversation_count}>=${effectiveThreshold}${warmupInfo}), triggering L1`);
            this.enqueueL1(sessionKey);
            return; // skip idle timer reset — L1 is already triggered
        }
        // Path B: below threshold → reset L1 idle timer (catch residual later)
        timers.l1Idle.schedule(this.l1IdleTimeoutMs, () => this.onL1IdleTimeout(sessionKey));
        this.logger?.debug?.(`${TAG} [${sessionKey}] L1 idle timer reset (${this.l1IdleTimeoutMs / 1000}s)`);
        // Periodic GC: evict cold sessions from memory
        this.notifyCounter += 1;
        if (this.notifyCounter >= this.SESSION_GC_EVERY_N_NOTIFICATIONS) {
            this.notifyCounter = 0;
            this.gcStaleSessions();
        }
    }
    // ============================
    // Graceful shutdown
    // ============================
    /**
     * Per-session flush — scoped end-of-session handling.
     *
     * Semantically different from {@link destroy}:
     *   - ``destroy`` tears down the *whole* scheduler (meant for process
     *     shutdown such as OpenClaw's ``gateway_stop``).
     *   - ``flushSession`` only processes the one session identified by
     *     ``sessionKey`` and leaves every other session's timers, buffers
     *     and pipeline state untouched.  This is the correct semantic for
     *     the Gateway's ``POST /session/end`` endpoint and for Hermes'
     *     ``on_session_end`` callback, which fire when one conversation
     *     ends while the process keeps serving other concurrent sessions.
     *
     * What it does:
     *   1. Cancel the session's pending L1 idle timer (no further idle
     *      fires for this key).
     *   2. If the session's message buffer still holds work, enqueue an
     *      immediate L1 run for this session (``triggerReason="flush"``).
     *   3. Await the shared ``l1Queue`` so the caller observes L1
     *      completion before returning.  We do not selectively wait
     *      because L1 is already a single-consumer SerialQueue — waiting
     *      for ``onIdle`` is the cheapest correct signal.
     *
     * What it deliberately does NOT do:
     *   - Touch other sessions' timers / buffers / pipeline state.
     *   - Destroy the scheduler or any of its queues.
     *   - Reset global fields such as ``destroyed``.
     *
     * Unknown session keys are a no-op: the scheduler may legitimately
     * have evicted the session earlier via GC, or the session may never
     * have produced any captures.
     */
    async flushSession(sessionKey) {
        if (this.destroyed)
            return;
        if (this.sessionFilter.shouldSkip(sessionKey))
            return;
        const timers = this.sessionTimers.get(sessionKey);
        const buffer = this.messageBuffers.get(sessionKey);
        // Step 1: cancel the idle timer so it won't fire after we return.
        if (timers?.l1Idle.pending) {
            timers.l1Idle.cancel();
        }
        // Step 2: flush pending buffered messages through L1 if any.
        if (buffer && buffer.length > 0) {
            this.logger?.debug?.(`${TAG} [${sessionKey}] flushSession: enqueuing L1 for ${buffer.length} buffered message(s)`);
            this.enqueueL1(sessionKey, "flush");
        }
        // Step 3: wait for L1 to drain.  L1 is a single-consumer SerialQueue
        // so this is the cheapest correct signal; it will not starve other
        // sessions because any cross-session interleaving L1 work was either
        // already queued or will be queued concurrently by their own capture
        // paths.
        await this.l1Queue.onIdle();
        this.logger?.debug?.(`${TAG} [${sessionKey}] flushSession: complete`);
    }
    /**
     * Maximum time (ms) to wait for pipeline flush during destroy.
     * Must be shorter than the gateway_stop hook timeout (3 s) to leave
     * headroom for VectorStore / EmbeddingService cleanup that runs after.
     */
    DESTROY_TIMEOUT_MS = 2_000;
    /**
     * Graceful shutdown with timeout protection:
     * 1. Mark destroyed, stop accepting new work
     * 2. Attempt to flush pending L1/L2/L3 work within DESTROY_TIMEOUT_MS
     * 3. If flush times out or fails, persist current state for recovery on next startup
     * 4. Pending work is never lost — it will be recovered via checkpoint on next start()
     */
    async destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.logger?.info(`${TAG} Destroying pipeline (timeout=${this.DESTROY_TIMEOUT_MS}ms)...`);
        try {
            let timeoutId;
            await Promise.race([
                this._doFlush(),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error("destroy timeout")), this.DESTROY_TIMEOUT_MS);
                }),
            ]).finally(() => {
                if (timeoutId !== undefined)
                    clearTimeout(timeoutId);
            });
            this.logger?.info(`${TAG} Pipeline flushed successfully`);
        }
        catch (err) {
            this.logger?.warn(`${TAG} Pipeline flush timed out or failed: ${err instanceof Error ? err.message : String(err)}. ` +
                `Pending work will be recovered on next startup.`);
        }
        // Always persist state — whether flush succeeded, timed out, or failed.
        // This ensures pending work (buffered messages, L2 pending counts) is
        // saved to checkpoint and can be recovered by recoverPendingSessions().
        try {
            await this.persistStates();
        }
        catch (err) {
            this.logger?.error(`${TAG} Failed to persist states during destroy: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.logger?.info(`${TAG} Pipeline destroyed`);
    }
    /**
     * Internal: attempt to flush all pending pipeline work (L1 → L2 → L3).
     * Extracted from destroy() so it can be wrapped with a timeout.
     */
    async _doFlush() {
        // Step 1: Flush all L1 idle timers — only enqueue if there are buffered messages
        for (const [sessionKey, timers] of this.sessionTimers) {
            if (timers.l1Idle.pending) {
                timers.l1Idle.cancel(); // don't fire the idle callback directly
                const buffer = this.messageBuffers.get(sessionKey);
                if (buffer && buffer.length > 0) {
                    this.logger?.debug?.(`${TAG} [${sessionKey}] Flush: enqueuing L1 for ${buffer.length} buffered messages`);
                    this.enqueueL1(sessionKey, "flush");
                }
            }
        }
        // Step 2: Wait for L1 queue to drain
        this.logger?.debug?.(`${TAG} Waiting for L1 queue to drain (size=${this.l1Queue.size})`);
        await this.l1Queue.onIdle();
        // Step 3: Flush all L2 schedule timers
        for (const [sessionKey, timers] of this.sessionTimers) {
            if (timers.l2Schedule.pending) {
                this.logger?.debug?.(`${TAG} [${sessionKey}] Flush: triggering L2 schedule timer`);
                timers.l2Schedule.flush();
            }
        }
        // Step 4: Wait for all remaining queues to drain
        this.logger?.debug?.(`${TAG} Waiting for queues to drain (l2=${this.l2Queue.size}, l3=${this.l3Queue.size})`);
        await Promise.all([
            this.l2Queue.onIdle(),
            this.l3Queue.onIdle(),
        ]);
    }
    // ============================
    // Internal: L1 idle timeout handler
    // ============================
    onL1IdleTimeout(sessionKey) {
        const buffer = this.messageBuffers.get(sessionKey);
        const state = this.sessionStates.get(sessionKey);
        if ((!buffer || buffer.length === 0) && (!state || state.conversation_count === 0)) {
            this.logger?.debug?.(`${TAG} [${sessionKey}] L1 idle timeout but no pending messages or conversations`);
            return;
        }
        this.logger?.debug?.(`${TAG} [${sessionKey}] L1 idle timeout fired (buffered=${buffer?.length ?? 0}, conversations=${state?.conversation_count ?? 0})`);
        this.enqueueL1(sessionKey, "idle_timeout");
    }
    // ============================
    // Internal: L1 queue
    // ============================
    enqueueL1(sessionKey, triggerReason = "threshold") {
        const timers = this.getOrCreateTimers(sessionKey);
        // Don't double-queue
        if (timers.l1Queued) {
            this.logger?.debug?.(`${TAG} [${sessionKey}] L1 already queued, skipping`);
            return;
        }
        // Cancel idle timer if running (threshold beat it)
        timers.l1Idle.cancel();
        timers.l1Queued = true;
        this.logger?.debug?.(`${TAG} [${sessionKey}] Enqueuing L1 (queue=${this.l1Queue.name})`);
        // ── pipeline_l1_trigger metric ──
        const state = this.sessionStates.get(sessionKey);
        const buffer = this.messageBuffers.get(sessionKey);
        if (this.instanceId && this.logger) {
            report("pipeline_l1_trigger", {
                sessionKey,
                triggerReason,
                conversationCount: state?.conversation_count ?? 0,
                bufferedMessageCount: buffer?.length ?? 0,
            });
        }
        this.l1Queue.add(async () => {
            await this.runL1(sessionKey);
        }).catch((err) => {
            this.logger?.error(`${TAG} [${sessionKey}] L1 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        }).finally(() => {
            timers.l1Queued = false;
        });
    }
    /**
     * L1 runner: Takes all buffered messages for a session and passes them
     * to the L1Runner for batch processing (e.g. appendEvent, local extraction).
     *
     * After L1 completes successfully:
     * - conversation_count and message buffer are reset
     * - L2 timer is advanced (downward-only) to allow remote record generation
     *
     * If L1 fails, conversation_count and buffer are preserved for retry
     * on next idle timeout or threshold trigger.
     */
    async runL1(sessionKey) {
        const state = this.sessionStates.get(sessionKey);
        if (!state)
            return;
        // Drain the message buffer (take ownership, clear the shared ref)
        const buffer = this.messageBuffers.get(sessionKey) ?? [];
        this.messageBuffers.set(sessionKey, []);
        if (buffer.length === 0 && state.conversation_count === 0) {
            this.logger?.debug?.(`${TAG} [${sessionKey}] L1 skipped: no messages and no pending conversations`);
            return;
        }
        this.logger?.debug?.(`${TAG} [${sessionKey}] L1 running: messages=${buffer.length}, conversation_count=${state.conversation_count}`);
        if (!this.l1Runner) {
            this.logger?.warn(`${TAG} [${sessionKey}] No L1 runner set, skipping`);
            state.l2_pending_l1_count = state.conversation_count;
            state.conversation_count = 0;
            this.advanceWarmupThreshold(state);
            await this.persistStates();
            this.advanceL2Timer(sessionKey);
            return;
        }
        try {
            await this.l1Runner({
                sessionKey,
                msg: buffer,
                bg_msg: [], // reserved for future use
            });
            this.logger?.debug?.(`${TAG} [${sessionKey}] L1 complete: processed ${buffer.length} messages`);
        }
        catch (err) {
            this.logger?.error(`${TAG} [${sessionKey}] L1 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            // On failure: put messages back into the buffer for retry
            const currentBuffer = this.messageBuffers.get(sessionKey) ?? [];
            this.messageBuffers.set(sessionKey, [...buffer, ...currentBuffer]);
            this.logger?.debug?.(`${TAG} [${sessionKey}] L1 failure: restored ${buffer.length} messages to buffer (total=${buffer.length + currentBuffer.length})`);
            // Re-arm L1 idle timer for automatic retry (with max retry limit)
            const timers = this.getOrCreateTimers(sessionKey);
            timers.l1RetryCount += 1;
            if (timers.l1RetryCount <= this.L1_MAX_RETRIES) {
                timers.l1Idle.schedule(this.L1_RETRY_DELAY_MS, () => this.onL1IdleTimeout(sessionKey));
                this.logger?.debug?.(`${TAG} [${sessionKey}] L1 retry scheduled in ${this.L1_RETRY_DELAY_MS / 1000}s ` +
                    `(attempt ${timers.l1RetryCount}/${this.L1_MAX_RETRIES})`);
            }
            else {
                this.logger?.warn(`${TAG} [${sessionKey}] L1 max retries reached (${this.L1_MAX_RETRIES}), ` +
                    `giving up auto-retry. ${buffer.length + currentBuffer.length} messages remain buffered. ` +
                    `Will resume on next user conversation.`);
            }
            return; // don't advance state or trigger L2
        }
        // Success: reset retry count and advance state
        const timers = this.getOrCreateTimers(sessionKey);
        timers.l1RetryCount = 0;
        state.l2_pending_l1_count = state.conversation_count;
        state.conversation_count = 0;
        this.advanceWarmupThreshold(state);
        await this.persistStates();
        // Advance the L2 timer (downward-only) to fire after delay, respecting minInterval
        this.advanceL2Timer(sessionKey);
    }
    // ============================
    // Internal: L2 timer management (downward-only)
    // ============================
    /**
     * Advance the per-session L2 timer after an L1 event (new memory generated).
     *
     * Computes the desired fire time as:
     *   T_desired = max(now + l2DelayAfterL1, lastL2Time + l2MinInterval)
     *
     * The timer is only moved if T_desired is earlier than the current schedule
     * (downward-only semantics). If no timer is pending, it's set unconditionally.
     */
    advanceL2Timer(sessionKey) {
        if (this.destroyed)
            return;
        const timers = this.getOrCreateTimers(sessionKey);
        const now = Date.now();
        // Compute the floor: lastL2 + minInterval (rate-limit protection)
        const lastL2 = this.l2LastRunTime.get(sessionKey) ?? 0;
        const minIntervalFloor = lastL2 > 0 ? lastL2 + this.l2MinIntervalMs : 0;
        // Desired fire time: delay after L1, but no earlier than minInterval floor
        const desiredTime = Math.max(now + this.l2DelayAfterL1Ms, minIntervalFloor);
        const advanced = timers.l2Schedule.tryAdvanceTo(desiredTime, () => this.onL2TimerFired(sessionKey, "delay-after-l1"));
        if (advanced) {
            const delaySec = Math.round((desiredTime - now) / 1000);
            this.logger?.debug?.(`${TAG} [${sessionKey}] L2 timer advanced: firing in ${delaySec}s` +
                (timers.l2Schedule.scheduledTime > 0
                    ? ` (was ${Math.round((timers.l2Schedule.scheduledTime - now) / 1000)}s)`
                    : " (newly armed)"));
        }
        else {
            this.logger?.debug?.(`${TAG} [${sessionKey}] L2 timer not advanced: current schedule is already earlier`);
        }
    }
    /**
     * Arm the L2 timer for the maxInterval guarantee after L2 completes.
     * Sets T = now + l2MaxInterval (unconditional, replaces any pending timer).
     */
    armL2MaxInterval(sessionKey) {
        if (this.destroyed)
            return;
        const timers = this.getOrCreateTimers(sessionKey);
        const fireAt = Date.now() + this.l2MaxIntervalMs;
        timers.l2Schedule.scheduleAt(fireAt, () => this.onL2TimerFired(sessionKey, "max-interval"));
        this.logger?.debug?.(`${TAG} [${sessionKey}] L2 maxInterval timer armed: ${Math.round(this.l2MaxIntervalMs / 1000)}s`);
    }
    /**
     * Called when a per-session L2 timer fires.
     *
     * Checks session activity: if the session is cold (inactive > activeWindow),
     * the timer is NOT re-armed — it will be revived by the next L1 event.
     * Otherwise, enqueues L2.
     *
     * The `source` parameter distinguishes the trigger origin:
     * - "delay-after-l1": fired shortly after L1 completed — skip cold check
     *   because L1 completion itself proves recent activity.
     * - "max-interval": periodic timer — apply cold check normally.
     */
    onL2TimerFired(sessionKey, source) {
        const state = this.sessionStates.get(sessionKey);
        if (!state)
            return;
        const now = Date.now();
        // Cold session check: only applies to periodic (maxInterval) triggers.
        // Delay-after-L1 triggers are exempt because L1 just completed, proving
        // the session was recently active.
        if (source === "max-interval" && now - state.last_active_time >= this.sessionActiveWindowMs) {
            this.logger?.debug?.(`${TAG} [${sessionKey}] L2 timer fired but session is cold ` +
                `(inactive ${Math.round((now - state.last_active_time) / 3600_000)}h), timer stopped. ` +
                `Will re-arm on next L1 event.`);
            return; // timer not re-armed — advanceL2Timer() in runL1 will revive it
        }
        this.enqueueL2(sessionKey, `timer:${source}`);
    }
    // ============================
    // Internal: L2 queue
    // ============================
    enqueueL2(sessionKey, trigger) {
        const timers = this.getOrCreateTimers(sessionKey);
        // Cancel any pending L2 timer (we're about to run L2)
        timers.l2Schedule.cancel();
        // Conflict detection: warn if L2 is already queued
        if (timers.l2Queued) {
            this.logger?.warn(`${TAG} [${sessionKey}] L2 enqueue conflict on queue "${this.l2Queue.name}": ` +
                `task already queued/running (trigger=${trigger}), skipping`);
            return;
        }
        timers.l2Queued = true;
        this.logger?.debug?.(`${TAG} [${sessionKey}] Enqueuing L2 (trigger=${trigger}, queue=${this.l2Queue.name})`);
        this.l2Queue.add(async () => {
            await this.runL2(sessionKey);
        }).catch((err) => {
            this.logger?.error(`${TAG} [${sessionKey}] L2 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        }).finally(() => {
            timers.l2Queued = false;
        });
    }
    async runL2(sessionKey) {
        const state = this.sessionStates.get(sessionKey);
        if (!state)
            return;
        if (!this.l2Runner) {
            this.logger?.warn(`${TAG} [${sessionKey}] No L2 runner set, skipping`);
            return;
        }
        this.logger?.debug?.(`${TAG} [${sessionKey}] L2 running: l2_pending_l1_count=${state.l2_pending_l1_count}`);
        const cursor = state.last_extraction_updated_time || undefined;
        let result;
        try {
            result = await this.l2Runner(sessionKey, cursor);
        }
        catch (err) {
            this.logger?.error(`${TAG} [${sessionKey}] L2 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            // Even on failure, arm maxInterval so we retry eventually
            this.armL2MaxInterval(sessionKey);
            return;
        }
        // After L2: update state
        const now = Date.now();
        state.l2_pending_l1_count = 0;
        // Cold-start optimization: if this is the very first L2 run for this session
        // and it was skipped (no new records), do NOT update l2LastRunTime.
        // This prevents l2MinIntervalSeconds from blocking the next L2 trigger
        // when the first L1 extraction produces actual memories shortly after.
        const isFirstL2 = !this.l2LastRunTime.has(sessionKey);
        const wasSkipped = result?.skipped === true;
        if (isFirstL2 && wasSkipped) {
            this.logger?.info?.(`${TAG} [${sessionKey}] L2 cold-start skip: not updating l2LastRunTime ` +
                `(minInterval won't block next trigger)`);
            this.armL2MaxInterval(sessionKey);
            await this.persistStates();
            return;
        }
        state.last_extraction_time = new Date().toISOString();
        state.l2_last_extraction_time = new Date().toISOString();
        this.l2LastRunTime.set(sessionKey, now);
        // Advance cursor using the record timestamp returned by the runner
        if (result?.latestCursor) {
            state.last_extraction_updated_time = result.latestCursor;
        }
        else if (!state.last_extraction_updated_time) {
            // Cold-start guard: if runner returned void (e.g. extraction failure) and
            // last_extraction_updated_time is still empty, initialize it to now so
            // the next L2 run doesn't do a full table scan.
            state.last_extraction_updated_time = new Date().toISOString();
        }
        await this.persistStates();
        this.logger?.debug?.(`${TAG} [${sessionKey}] L2 complete`);
        // Arm the maxInterval timer for the next cycle
        this.armL2MaxInterval(sessionKey);
        // Trigger L3
        this.triggerL3();
    }
    // ============================
    // Internal: L3 queue (global, dedup)
    // ============================
    triggerL3() {
        if (this.destroyed)
            return;
        if (this.l3Running) {
            // L3 is in progress — mark pending so it runs again after current finishes
            this.l3Pending = true;
            this.logger?.debug?.(`${TAG} L3 already running, marking pending`);
            return;
        }
        this.logger?.debug?.(`${TAG} Triggering L3`);
        this.enqueueL3();
    }
    enqueueL3() {
        this.l3Running = true;
        this.l3Pending = false;
        this.logger?.debug?.(`${TAG} Enqueuing L3 (queue=${this.l3Queue.name})`);
        this.l3Queue.add(async () => {
            await this.runL3();
        }).catch((err) => {
            this.logger?.error(`${TAG} L3 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        }).finally(() => {
            this.l3Running = false;
            // If new L2 completions happened while L3 was running, run again
            if (this.l3Pending && !this.destroyed) {
                this.logger?.debug?.(`${TAG} L3 has pending work, re-running`);
                this.enqueueL3();
            }
        });
    }
    async runL3() {
        if (!this.l3Runner) {
            this.logger?.warn(`${TAG} No L3 runner set, skipping`);
            return;
        }
        this.logger?.debug?.(`${TAG} L3 running`);
        try {
            await this.l3Runner();
            this.logger?.debug?.(`${TAG} L3 complete`);
        }
        catch (err) {
            this.logger?.error(`${TAG} L3 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        }
    }
    // ============================
    // Internal: state management
    // ============================
    getOrCreateState(sessionKey) {
        let state = this.sessionStates.get(sessionKey);
        if (!state) {
            state = {
                conversation_count: 0,
                last_extraction_time: "",
                last_extraction_updated_time: "",
                last_active_time: Date.now(),
                l2_pending_l1_count: 0,
                warmup_threshold: this.enableWarmup ? 1 : 0,
                l2_last_extraction_time: "",
            };
            this.sessionStates.set(sessionKey, state);
            this.logger?.debug?.(`${TAG} [${sessionKey}] Created new session state`);
        }
        return state;
    }
    getOrCreateTimers(sessionKey) {
        let timers = this.sessionTimers.get(sessionKey);
        if (!timers) {
            const isDestroyed = () => this.destroyed;
            timers = {
                l1Idle: new ManagedTimer(`L1-idle:${sessionKey}`, isDestroyed),
                l2Schedule: new ManagedTimer(`L2-schedule:${sessionKey}`, isDestroyed),
                l1Queued: false,
                l2Queued: false,
                l1RetryCount: 0,
            };
            this.sessionTimers.set(sessionKey, timers);
        }
        return timers;
    }
    async persistStates() {
        if (!this.persister)
            return;
        // PipelineSessionState only contains pipeline-owned fields, so we can
        // safely persist the entire object without risk of overwriting runner state.
        const obj = {};
        for (const [k, v] of this.sessionStates) {
            obj[k] = { ...v };
        }
        try {
            this.logger?.debug?.(`Persisting states: ${JSON.stringify(obj)}`);
            await this.persister(obj);
        }
        catch (err) {
            this.logger?.error(`${TAG} Failed to persist states: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * Evict cold sessions from in-memory maps to prevent unbounded growth.
     *
     * A session is eligible for GC when:
     * 1. Inactive for > sessionActiveWindowMs * SESSION_GC_INACTIVE_MULTIPLIER
     * 2. No queued/running L1 or L2 tasks
     * 3. No buffered messages pending processing
     *
     * Evicted sessions can be fully restored from checkpoint on next
     * `notifyConversation()` (state) or `start()` (recovery).
     */
    gcStaleSessions() {
        const now = Date.now();
        const maxInactiveMs = this.sessionActiveWindowMs * this.SESSION_GC_INACTIVE_MULTIPLIER;
        let evictedCount = 0;
        for (const [sessionKey, state] of this.sessionStates) {
            if (now - state.last_active_time < maxInactiveMs)
                continue;
            // Safety: don't evict sessions with active work
            const timers = this.sessionTimers.get(sessionKey);
            if (timers?.l1Queued || timers?.l2Queued)
                continue;
            const buffer = this.messageBuffers.get(sessionKey);
            if (buffer && buffer.length > 0)
                continue;
            // Evict: cancel any pending timers, then remove from all maps
            if (timers) {
                timers.l1Idle.cancel();
                timers.l2Schedule.cancel();
            }
            this.sessionStates.delete(sessionKey);
            this.sessionTimers.delete(sessionKey);
            this.messageBuffers.delete(sessionKey);
            this.l2LastRunTime.delete(sessionKey);
            evictedCount++;
        }
        if (evictedCount > 0) {
            this.logger?.debug?.(`${TAG} Session GC: evicted ${evictedCount} cold session(s), ` +
                `${this.sessionStates.size} remaining`);
        }
    }
    /**
     * Recovery: re-enqueue sessions that have pending work from before restart.
     *
     * On restart, message buffers are empty (in-memory only). Sessions with
     * non-zero conversation_count had messages that were either:
     * 1. Already processed by L1 (l2_pending_l1_count > 0) → arm L2 timer
     * 2. Never reached L1 (conversation_count > 0, messages lost) → arm L2
     *    as best-effort recovery
     *
     * We arm L2 timers (with delay) rather than enqueuing immediately,
     * because the pipeline may be starting during management commands.
     */
    recoverPendingSessions() {
        for (const [sessionKey, state] of this.sessionStates) {
            if (state.conversation_count === 0 && state.l2_pending_l1_count === 0)
                continue;
            this.logger?.debug?.(`${TAG} [${sessionKey}] Recovery: conversation_count=${state.conversation_count}, ` +
                `l2_pending_l1_count=${state.l2_pending_l1_count}, arming L2 timer`);
            // Reset conversation_count since we can't recover the messages
            state.l2_pending_l1_count = Math.max(state.l2_pending_l1_count, state.conversation_count);
            state.conversation_count = 0;
            // Arm L2 timer with delay (gives the system time to fully start)
            this.advanceL2Timer(sessionKey);
        }
    }
    // ============================
    // Public accessors (for testing / status)
    // ============================
    /** Get the pipeline session state for a session (read-only copy). */
    getSessionState(sessionKey) {
        const state = this.sessionStates.get(sessionKey);
        return state ? { ...state } : undefined;
    }
    /** Get the buffered message count for a session. */
    getBufferedMessageCount(sessionKey) {
        return this.messageBuffers.get(sessionKey)?.length ?? 0;
    }
    /** Get all session keys being tracked. */
    getSessionKeys() {
        return Array.from(this.sessionStates.keys());
    }
    /** Whether the pipeline has been destroyed. */
    get isDestroyed() {
        return this.destroyed;
    }
    /** Queue sizes and running state for monitoring. */
    getQueueSizes() {
        return {
            l1: this.l1Queue.size,
            l2: this.l2Queue.size,
            l3: this.l3Queue.size,
            l1Pending: this.l1Queue.pending,
            l2Pending: this.l2Queue.pending,
            l3Pending: this.l3Queue.pending,
            l1Idle: this.l1Queue.idle,
            l2Idle: this.l2Queue.idle,
            l3Idle: this.l3Queue.idle,
        };
    }
}
