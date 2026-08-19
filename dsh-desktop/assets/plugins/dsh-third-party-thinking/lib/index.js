// @deepseek-ai/dsh-third-party-thinking 宿主半边
// 让接入的第三方模型也能在使用时调整「思考强度」（reasoning effort）。
//
// 官方「思考强度」控件只在模型元数据携带 reasoning 时出现在模型选择器
// （dsh-client-ui-model-selection）。官方 DeepSeek 模型由 dsh-llm-deepseek
// 提供该元数据；pi-ai 模型由自身声明；而 OpenAI 兼容的第三方适配器
// （openclaw-bridge 等）默认不声明，因此控件被隐藏。
//
// 本插件在 ctx.llm 适配器层做通用注入（不修改任何官方 @deepseek-ai 包）：
//   1. 目录注入：包装非官方适配器的 resolveModel / listModels，为未声明
//      reasoning 的模型注入官方形状的 reasoning 元数据
//      （efforts: [off, high, max]，defaultEffort: high），使思考强度控件出现。
//   2. wire 翻译：包装 stream，在向第三方 provider 的出站 chat/completions
//      请求体注入档位字段（off 省略，high/max 对应值），字段名可配置。
//
// 豁免：DeepSeek 官方适配器与 pi-ai 适配器具备原生 reasoning 机制，跳过注入，
// 以免破坏其原生验证路径。

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

const name = "@deepseek-ai/dsh-third-party-thinking";
const inject = ["llm", "settings"];

const NS = settingsNamespace("dsh-third-party-thinking");
const Config = z.object({
	// 默认关闭：百炼等严格校验请求体的第三方 API 会直接拒绝
	// reasoning_effort，只有确认 provider 支持时才应开启。
	enabled: z.boolean().default(false),
	// 留空表示「只显示档位控件，不注入任何请求字段」。
	wireField: z.string().default("reasoning_effort")
});

// 取配置的 getter；setSource 会被替换为 settings scope 读取器（热生效）。
let liveConfig = () => ({ enabled: false, wireField: "reasoning_effort" });

// 具备原生 reasoning 机制的适配器（注入会破坏其原生验证路径）。
const NATIVE_REASONING_CLASSES = new Set(["DeepSeekAdapter"]);
const DEEPSEEK_PROVIDER = "deepseek-official";

// 官方思考强度档位形状。
const INJECTED_EFFORTS = [
	{ id: "off", name: "Off" },
	{ id: "high", name: "High" },
	{ id: "max", name: "Max" }
];

/** 为未声明 reasoning 的模型注入官方形状元数据；已声明则保留。 */
function injectReasoning(model) {
	if (!model || model.reasoning !== void 0) return model;
	const cfg = liveConfig() || {};
	if (cfg.enabled === false) return model;
	return { ...model, reasoning: { efforts: INJECTED_EFFORTS, defaultEffort: "high" } };
}

/** 是否需要跳过（原生 reasoning 适配器）。 */
function isNativeReasoningAdapter(adapter, provider) {
	const cls = adapter && adapter.constructor ? adapter.constructor.name : "";
	return NATIVE_REASONING_CLASSES.has(cls);
}

/**
 * 包装 stream：向第三方 provider 的出站 chat/completions 请求体注入档位。
 * 采用**限定范围**的 fetch 拦截：仅在本流执行期间临时替换 globalThis.fetch，
 * 对「/chat/completions 的 POST JSON 请求体」注入档位字段；命中 DeepSeek 宿主
 * 的请求（/deepseek/i）与 model 不匹配的请求一律跳过，降低并发污染风险。
 */
function wrapStream(adapter) {
	return async function* (...args) {
		const options = args[0];
		const cfg = liveConfig() || {};
		const enabled = cfg.enabled === true;
		const wireField = String(cfg.wireField ?? "reasoning_effort").trim();
		const effort = options && options.reasoningEffort;
		// "off" 是选择器语义，不是 OpenAI-compatible wire 值。必须在
		// adapter.stream 之前删除，否则严格 provider 会在 fetch 前直接拒绝。
		if (typeof effort === "string" && effort.toLowerCase() === "off") {
			delete options.reasoningEffort;
		}
		if (!enabled || effort === void 0 || effort === "off" || wireField === "") {
			yield* adapter.stream.apply(adapter, args);
			return;
		}
		const model = options && options.model;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input && input.url;
			const method = String((init && init.method) || (input && typeof input !== "string" && input.method) || "GET").toUpperCase();
			const isChat = typeof url === "string" && /\/chat\/completions(\?|$)/i.test(url);
			const isDeepSeek = typeof url === "string" && /deepseek/i.test(url);
			if (isChat && !isDeepSeek && method === "POST" && init && typeof init.body === "string") {
				try {
					const body = JSON.parse(init.body);
					if (body && Array.isArray(body.messages) && (!body.model || !model || body.model === model)) {
						body[wireField] = effort;
						init = { ...init, body: JSON.stringify(body) };
					}
				} catch {
					// 非 JSON 请求体，跳过
				}
			}
			return originalFetch(input, init);
		};
		try {
			yield* adapter.stream.apply(adapter, args);
		} finally {
			globalThis.fetch = originalFetch;
		}
	};
}

/** 包装一个适配器：保留原型链，仅覆盖 resolveModel / listModels / stream。 */
function wrapAdapter(adapter) {
	if (adapter && adapter.__dshThirdPartyThinkingWrapped) return adapter;
	const wrapped = Object.create(adapter);
	wrapped.__dshThirdPartyThinkingWrapped = true;
	wrapped.resolveModel = async (provider, model, signal) => injectReasoning(await adapter.resolveModel(provider, model, signal));
	wrapped.listModels = async (provider) => (await adapter.listModels(provider)).map((m) => injectReasoning(m));
	wrapped.stream = wrapStream(adapter);
	return wrapped;
}

function apply(ctx, config) {
	liveConfig = () => config || {};
	// settings 已在本插件 inject 中声明，apply 时服务必在；直接同步注册并
	// try/catch：存储的 dsh-third-party-thinking 配置节非法会让 register()
	// 抛异常 → 插件 fiber 失败 → dsh fail-loud 启动崩溃。降级为组合配置继续运行。
	try {
		const scope = ctx.settings.register(NS, Config, { base: config || {} });
		liveConfig = () => scope.get();
		scope.watch(() => {
			const cfg = liveConfig() || {};
			console.log("[dsh-third-party-thinking] settings updated: " + JSON.stringify({ enabled: cfg.enabled, wireField: cfg.wireField }));
		});
	} catch (error) {
		console.warn("[dsh-third-party-thinking] settings section unavailable (invalid stored config); falling back to composition config: " + ((error && error.message) || error));
	}

	// 枚举 ctx.llm.adapters，为每个非原生 reasoning 适配器注入目录与 wire 包装。
	const applyWrap = () => {
		try {
			if (!ctx.llm || !ctx.llm.adapters) return;
			let wrappedCount = 0;
			for (const [provider, registration] of ctx.llm.adapters) {
				if (!registration || !registration.adapter) continue;
				if (registration.adapter.__dshThirdPartyThinkingWrapped) continue;
				if (isNativeReasoningAdapter(registration.adapter, provider)) continue;
				registration.adapter = wrapAdapter(registration.adapter);
				wrappedCount++;
			}
			if (wrappedCount > 0) {
				console.log("[dsh-third-party-thinking] wrapped " + wrappedCount + " third-party adapter(s) for reasoning effort");
			}
		} catch (error) {
			console.warn("[dsh-third-party-thinking] adapter wrap failed: " + ((error && error.message) || error));
		}
	};

	applyWrap();
	return ctx.on("llm/adapters-updated", applyWrap);
}

export { Config, apply, inject, name };