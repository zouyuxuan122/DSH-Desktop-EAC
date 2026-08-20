/**
 * StandaloneHostAdapter — HostAdapter for the TDAI Gateway (Hermes sidecar).
 *
 * Does NOT depend on OpenClaw. Context is constructed from Gateway config
 * and per-request parameters (session_id, user_id, etc.).
 */
import { StandaloneLLMRunnerFactory } from "./llm-runner.js";
// ============================
// StandaloneHostAdapter
// ============================
export class StandaloneHostAdapter {
    hostType = "standalone";
    dataDir;
    logger;
    runnerFactory;
    defaultUserId;
    platform;
    constructor(opts) {
        this.dataDir = opts.dataDir;
        this.logger = opts.logger;
        this.defaultUserId = opts.defaultUserId ?? "default_user";
        this.platform = opts.platform ?? "gateway";
        this.runnerFactory = new StandaloneLLMRunnerFactory({
            config: opts.llmConfig,
            logger: opts.logger,
        });
    }
    getRuntimeContext() {
        return {
            userId: this.defaultUserId,
            sessionId: "",
            sessionKey: "",
            platform: this.platform,
            workspaceDir: this.dataDir,
            dataDir: this.dataDir,
        };
    }
    /**
     * Build a RuntimeContext for a specific request.
     * Used by Gateway route handlers to scope each request to the correct user/session.
     */
    buildRuntimeContextForRequest(params) {
        return {
            userId: params.userId ?? this.defaultUserId,
            sessionId: params.sessionId ?? "",
            sessionKey: params.sessionKey ?? params.sessionId ?? "",
            platform: params.platform ?? this.platform,
            workspaceDir: this.dataDir,
            dataDir: this.dataDir,
        };
    }
    getLogger() {
        return this.logger;
    }
    getLLMRunnerFactory() {
        return this.runnerFactory;
    }
}
