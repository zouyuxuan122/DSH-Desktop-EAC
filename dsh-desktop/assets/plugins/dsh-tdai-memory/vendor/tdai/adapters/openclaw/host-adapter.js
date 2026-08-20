/**
 * OpenClawHostAdapter — translates OpenClaw's plugin API into TDAI Core's
 * unified HostAdapter interface.
 *
 * This is the "thin shell" that keeps OpenClaw-specific dependencies
 * (OpenClawPluginApi, pluginConfig, resolveStateDir, event system)
 * confined to the adapter layer while TDAI Core remains host-neutral.
 *
 * Usage (in index.ts):
 *   const adapter = new OpenClawHostAdapter({ api, pluginDataDir, config });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedConfig });
 */
import { OpenClawLLMRunnerFactory } from "./llm-runner.js";
// ============================
// OpenClawHostAdapter
// ============================
export class OpenClawHostAdapter {
    hostType = "openclaw";
    api;
    pluginDataDir;
    openclawConfig;
    runnerFactory;
    constructor(opts) {
        this.api = opts.api;
        this.pluginDataDir = opts.pluginDataDir;
        this.openclawConfig = opts.openclawConfig;
        this.runnerFactory = new OpenClawLLMRunnerFactory({
            config: opts.openclawConfig,
            agentRuntime: opts.api.runtime.agent,
            logger: opts.api.logger,
        });
    }
    /**
     * Build a RuntimeContext from the current OpenClaw session.
     *
     * In OpenClaw, sessionKey and sessionId come from the event/ctx objects
     * passed to hooks. This method returns a context with sensible defaults;
     * callers can override sessionKey/sessionId per-hook invocation using
     * `buildRuntimeContextForSession()`.
     */
    getRuntimeContext() {
        return {
            userId: "default_user",
            sessionId: "",
            sessionKey: "",
            platform: "openclaw",
            workspaceDir: process.cwd(),
            dataDir: this.pluginDataDir,
        };
    }
    /**
     * Build a RuntimeContext for a specific session (used per-hook).
     *
     * This is an OpenClaw-specific convenience that merges session-level
     * identifiers from hook ctx into the base context.
     */
    buildRuntimeContextForSession(sessionKey, sessionId) {
        return {
            ...this.getRuntimeContext(),
            sessionKey,
            sessionId: sessionId ?? "",
        };
    }
    getLogger() {
        return this.api.logger;
    }
    getLLMRunnerFactory() {
        return this.runnerFactory;
    }
    // -- OpenClaw-specific accessors (for index.ts bridge) --------------------
    /** Get the raw OpenClaw plugin API (for legacy callers during migration). */
    getPluginApi() {
        return this.api;
    }
    /** Get the OpenClaw config object (for legacy callers during migration). */
    getOpenClawConfig() {
        return this.openclawConfig;
    }
    /** Get the resolved plugin data directory. */
    getPluginDataDir() {
        return this.pluginDataDir;
    }
}
