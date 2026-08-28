// @deepseek-ai/dsh-prompt-custom
// 服务端半边：在 DSH 设置页注册「自定义提示词」命名空间 dsh-prompt，
// 并对每个新建 agent 向其作用域注入提示词节，覆盖/追加官方内核的默认 persona。
//
// 注入方式：
//   - mode = "replace"：注册与预设 persona 同名的 deployment:persona（order 0），
//     在 agent 作用域遮蔽（shadow）预设 persona，实现整体替换。
//   - mode = "append"：注册新节 dsh:custom-prompt（order 1），紧随 persona 之后追加。
//
// 不修改任何官方包，仅通过官方 systemPrompt.section() 与 dsh-settings 能力注入。
// 设置保存后「新创建的会话/agent」立即生效；运行中会话保持原提示词（与官方 preset 语义一致）。
//
// 另提供一个 webServer 路由 GET /api/dsh-prompt-custom/preview，返回渲染后的官方
// system prompt 全文（只读），供客户端设置页「预览官方提示词」入口对照编辑自定义提示词。

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { PERSONA_SECTION, PERSONA_ORDER, renderPrompt } from "@deepseek-ai/dsh-system-prompt";

const name = "@deepseek-ai/dsh-prompt-custom";
const inject = ["settings", "systemPrompt", "webServer"];

const NS = settingsNamespace("dsh-prompt");
const Config = z.object({
	enabled: z.boolean().default(false),
	mode: z.union([z.const("replace"), z.const("append")]).default("append"),
	text: z.string().default("")
});

// 取配置的 getter；setSource 会被替换为 settings scope 读取器（热生效）。
let liveConfig = () => ({ enabled: false, mode: "append", text: "" });

// ---------------------------------------------------------------------------
// 预览官方提示词：GET /api/dsh-prompt-custom/preview
// 用 renderPrompt 渲染 ctx.systemPrompt.assemble({}) 的结果（不含本插件的自定义节），
// 供客户端设置页对照编辑。渲染缺变量等异常时降级为「拼接原始节文本」而非抛错。
// ---------------------------------------------------------------------------

const PREVIEW_ROUTE = "/api/dsh-prompt-custom/preview";

function isLoopback(req) {
	const ra = req.socket && req.socket.remoteAddress;
	return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function sendJson(res, status, body) {
	const data = Buffer.from(JSON.stringify(body), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": String(data.length)
	});
	res.end(data);
}

async function renderOfficialPrompt(ctx) {
	let assembly;
	try {
		assembly = await ctx.systemPrompt.assemble({});
	} catch (error) {
		return { ok: false, message: "系统提示词组装失败：" + ((error && error.message) || error) };
	}
	try {
		return { ok: true, text: renderPrompt(assembly) };
	} catch (error) {
		// 容错：缺变量/变量无值导致渲染抛错时，退化为拼接各节原始文本，保留 {{var}} 占位。
		const text = (assembly.sections || [])
			.map((s) => (typeof s.text === "string" ? s.text : String(s.text)))
			.filter((t) => t && t.trim())
			.join("\n\n");
		return {
			ok: true,
			text,
			message: "部分变量未能替换，已保留原文：" + ((error && error.message) || error)
		};
	}
}

async function handlePreviewRoute(ctx, req, res) {
	if (req.method !== "GET") {
		res.writeHead(405, { allow: "GET" });
		res.end();
		return;
	}
	if (!isLoopback(req)) {
		res.writeHead(403);
		res.end("forbidden");
		return;
	}
	try {
		sendJson(res, 200, await renderOfficialPrompt(ctx));
	} catch (error) {
		sendJson(res, 500, { ok: false, message: String((error && error.message) || error) });
	}
}

function apply(ctx, config) {
	liveConfig = () => config || {};
	// settings 已在本插件 inject 中声明，apply 时服务必在；直接同步注册并
	// try/catch：存储的 dsh-prompt 配置节非法会让 register() 抛异常 → 插件
	// fiber 失败 → dsh fail-loud 启动崩溃。降级为组合配置继续运行（不阻断启动）。
	try {
		const scope = ctx.settings.register(NS, Config, { base: config || {} });
		liveConfig = () => scope.get();
		scope.watch(() => {
			const cfg = liveConfig() || {};
			console.log("[dsh-prompt-custom] settings updated: " + JSON.stringify({ enabled: cfg.enabled, mode: cfg.mode }));
		});
	} catch (error) {
		console.warn("[dsh-prompt-custom] settings section unavailable (invalid stored config); falling back to composition config: " + ((error && error.message) || error));
	}

	// 每个 agent 创建时，向 agent 作用域注册提示词节。
	// 注册随 agent 纤维自动销毁，无泄漏。
	ctx.on("agent/created", ({ agent }) => {
		const cfg = liveConfig() || {};
		if (!cfg.enabled || !String(cfg.text || "").trim()) return;
		const text = String(cfg.text).trim();
		if (cfg.mode === "replace") {
			agent.ctx.systemPrompt.section({ name: PERSONA_SECTION, order: PERSONA_ORDER, text });
		} else {
			agent.ctx.systemPrompt.section({ name: "dsh:custom-prompt", order: PERSONA_ORDER + 1, text });
		}
	});

	// 预览官方提示词路由（回环地址限定）。
	return ctx.webServer.register({
		kind: "exact",
		path: PREVIEW_ROUTE,
		handler: (req, res) => handlePreviewRoute(ctx, req, res)
	});
}

export { Config, apply, inject, name };