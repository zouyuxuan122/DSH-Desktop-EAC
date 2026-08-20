/**
 * OpenClawLLMRunner — wraps the existing CleanContextRunner as a host-neutral LLMRunner.
 *
 * This is a compatibility bridge: TDAI Core modules (L1 extractor, L2 scene extractor,
 * L3 persona generator, L1 dedup) can depend on the `LLMRunner` interface, while
 * OpenClaw continues to use its native `runEmbeddedPiAgent` mechanism under the hood.
 *
 * Usage:
 *   const factory = new OpenClawLLMRunnerFactory({ config, agentRuntime, logger });
 *   const runner = factory.createRunner({ modelRef: "openai/gpt-4o", enableTools: true });
 *   const result = await runner.run({ prompt: "...", taskId: "l1-extraction" });
 */
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
const TAG = "[memory-tdai] [openclaw-runner]";
// ============================
// OpenClawLLMRunner
// ============================
/**
 * LLMRunner implementation backed by CleanContextRunner.
 *
 * Each instance is configured with a fixed model + tools setting.
 * Create via `OpenClawLLMRunnerFactory.createRunner()`.
 */
export class OpenClawLLMRunner {
    runner;
    constructor(runner) {
        this.runner = runner;
    }
    async run(params) {
        return this.runner.run({
            prompt: params.prompt,
            systemPrompt: params.systemPrompt,
            taskId: params.taskId,
            timeoutMs: params.timeoutMs,
            maxTokens: params.maxTokens,
            workspaceDir: params.workspaceDir,
            instanceId: params.instanceId,
        });
    }
}
/**
 * Factory that creates OpenClawLLMRunner instances.
 *
 * Encapsulates the OpenClaw-specific dependencies (config, agentRuntime)
 * so that callers only need to specify model + tools.
 */
export class OpenClawLLMRunnerFactory {
    config;
    agentRuntime;
    logger;
    constructor(opts) {
        this.config = opts.config;
        this.agentRuntime = opts.agentRuntime;
        this.logger = opts.logger;
    }
    createRunner(opts) {
        const enableTools = opts?.enableTools ?? false;
        const modelRef = opts?.modelRef;
        this.logger?.debug?.(`${TAG} Creating OpenClawLLMRunner: model=${modelRef ?? "(default)"}, tools=${enableTools}`);
        const cleanRunner = new CleanContextRunner({
            config: this.config,
            modelRef,
            enableTools,
            agentRuntime: this.agentRuntime,
            logger: this.logger,
        });
        return new OpenClawLLMRunner(cleanRunner);
    }
}
