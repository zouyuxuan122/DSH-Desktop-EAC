import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
//#region src/host/balance.ts
/**
* 余额查询（host 半侧）：把「当前服务商」映射到对应的余额/用量接口并抓取。
*
* 设计：
* - 数据源按「服务商 provider id」寻址（来源 = agentDefaultModel.currentSelection().provider）；
* - 只登记有公开查询接口的服务商；未登记（如 opencode/Zen 暂无官方余额 API）→ 显式
*   `unsupported`，由上层决定不显示，绝不静默伪造 0 余额；
* - key 由调用方经 DSH 官方 credentialRef 解析后注入（不直接读 .credentials.yaml）；
* - 网络超时 + 重试（实测该环境对境外端点间歇性超时）。
*/
/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 2e4;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;
/** 已知可查询余额的服务商（只登记有公开 API 的；opencode/Zen 暂无官方余额 API，不在此表） */
const BALANCE_PROVIDERS = [{
	ids: ["opencode-go"],
	ref: "OPENCODE_GO_API_KEY",
	kind: "opencode"
}, {
	ids: ["deepseek-official"],
	ref: "DEEPSEEK_API_KEY",
	kind: "deepseek"
}];
/** provider id → 唯一匹配定义；未匹配返回 undefined（= 不支持查询） */
function matchBalanceProvider(provider) {
	return BALANCE_PROVIDERS.find((p) => p.ids.includes(provider));
}
/** fetch 一次，带超时；失败抛错（调用方决定是否重试） */
async function fetchOnce(url, key) {
	return fetch(url, {
		headers: {
			Authorization: "Bearer " + key,
			"User-Agent": "dsh-pet-balance"
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
}
/** fetch + 重试；全败抛最后错误 */
async function fetchWithRetry(url, key) {
	let last;
	for (let i = 0; i <= RETRIES; i++) try {
		return await fetchOnce(url, key);
	} catch (e) {
		last = e;
		if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
	}
	throw last instanceof Error ? last : new Error(String(last));
}
/** 数字兜底校验：数值化失败或非有限数 → throw（数据异常显式报错，不静默当 0） */
function num(value, what) {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return n;
}
/** 字符串兜底校验：非空字符串，否则 throw */
function str(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return value;
}
/** 抓取 OpenCode Go 用量（/zen/go/v1/usage） */
async function fetchOpencode(key, provider) {
	const res = await fetchWithRetry("https://opencode.ai/zen/go/v1/usage", key);
	if (!res.ok) throw new Error("opencode usage HTTP " + res.status);
	const usage = (await res.json())?.usage;
	if (!usage || typeof usage !== "object") throw new Error("dsh-pet: opencode usage 响应缺少 usage");
	const u = usage;
	const rolling = u.rolling, weekly = u.weekly, monthly = u.monthly;
	if (!rolling || !weekly || !monthly) throw new Error("dsh-pet: opencode usage 响应缺少窗口");
	return {
		ok: true,
		provider,
		kind: "opencode",
		data: {
			rolling: num(rolling.percent, "rolling.percent"),
			weekly: num(weekly.percent, "weekly.percent"),
			monthly: num(monthly.percent, "monthly.percent"),
			rollingResetsAt: str(rolling.resetsAt, "rolling.resetsAt"),
			weeklyResetsAt: str(weekly.resetsAt, "weekly.resetsAt"),
			monthlyResetsAt: str(monthly.resetsAt, "monthly.resetsAt")
		}
	};
}
/** 抓取 DeepSeek 余额（/user/balance） */
async function fetchDeepseek(key, provider) {
	const res = await fetchWithRetry("https://api.deepseek.com/user/balance", key);
	if (!res.ok) throw new Error("deepseek balance HTTP " + res.status);
	const infos = (await res.json())?.balance_infos;
	if (!Array.isArray(infos) || infos.length === 0) throw new Error("dsh-pet: deepseek balance 响应缺少 balance_infos");
	const first = infos[0];
	return {
		ok: true,
		provider,
		kind: "deepseek",
		data: {
			currency: str(first.currency, "currency"),
			total: str(first.total_balance, "total_balance"),
			granted: str(first.granted_balance, "granted_balance"),
			toppedUp: str(first.topped_up_balance, "topped_up_balance")
		}
	};
}
/**
* 按当前服务商查询余额。
* @param provider agentDefaultModel.currentSelection().provider
* @param resolveKey 凭证解析：ref 名 → key（由调用方注入 ctx.credentials.resolve）
* @returns 结构化结果：成功 / 不支持 / 缺凭证 / 抓取失败（失败带 message，绝不返回伪造数字）
*/
async function queryBalance(provider, resolveKey) {
	const match = matchBalanceProvider(provider);
	if (!match) return {
		ok: false,
		provider,
		reason: "unsupported"
	};
	const rc = await resolveKey(match.ref);
	if (!rc) return {
		ok: false,
		provider,
		reason: "credential-missing",
		message: "缺少凭证 " + match.ref
	};
	try {
		return match.kind === "opencode" ? await fetchOpencode(rc, provider) : await fetchDeepseek(rc, provider);
	} catch (e) {
		return {
			ok: false,
			provider,
			reason: "fetch-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
}
//#endregion
//#region src/host/index.ts
/**
* dsh-pet 宿主半侧（host half）—— 宠物插件的"后端"部分
*
* 职责：在 DSH Web 服务器上注册 `/dsh-pet-7340/` 前缀路由，把宠物动画 WebM / 配置 JSONC
* 流式返回给浏览器。源文件（src/host/index.ts）由 tsdown 构建为 lib/index.js。
*
* 路由：
*   /dsh-pet-7340/thumb/<动画名>.webm  → $DSH_HOME/dsh-pet/main-animation/（用户目录，优先）→ 插件包内 assets/thumb/
*   /dsh-pet-7340/config.jsonc        → 插件包内 assets/config.jsonc（默认值，只读）
*   /dsh-pet-7340/config              → 用户覆盖配置（pets / animations / animationWeights，JSON）
*                                GET 读取、PUT 保存、DELETE 恢复默认（删除用户层）
*   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径（设置页展示用）
*
* 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内。
*
* TODO(类型)：peer 依赖类型包本地暂不可解析，ctx/req/res 暂用 any；
*             依赖可解析后替换为 DSH 官方类型。
*/
/** 插件行 id（与 cordis.patch.yml 一致） */
const name = "pet";
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ commands（/balance 斜杠命令） */
const inject = [
	"webServer",
	"agentDefaultModel",
	"credentials",
	"commands"
];
/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** 路由前缀 */
const ROUTE_PREFIX = "/dsh-pet-7340";
/** 不同扩展名对应的 Content-Type 映射 */
const MIME = {
	".webm": "video/webm",
	".mp4": "video/mp4",
	".png": "image/png",
	".json": "application/json; charset=utf-8",
	".jsonc": "application/json; charset=utf-8",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2"
};
/**
* 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
* @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
*/
function resolveAsset(root, rel) {
	if (rel.length === 0) return void 0;
	const candidate = normalize(join(root, rel));
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	if (candidate !== root && !candidate.startsWith(rootWithSep)) return void 0;
	return candidate;
}
/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root, rel) {
	const candidate = resolveAsset(root, rel);
	return candidate && existsSync(candidate) ? candidate : void 0;
}
/** 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。 */
async function sendFile(res, file, contentType) {
	const { size } = await stat(file);
	res.writeHead(200, {
		"content-type": contentType,
		"content-length": size,
		"cache-control": "public, max-age=3600"
	});
	const stream = createReadStream(file);
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}
/** 支持的角落白名单（与 client 端一致） */
const CORNERS = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
];
/** 发送 JSON 响应 */
function sendJson(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** 收集请求体（文本） */
function readBody(req) {
	return new Promise((resolve2, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
/** 校验并归一化用户配置：只接受 { pets: [...] }，可选顶层 notificationsEnabled（布尔） */
function sanitizeUserConfig(raw) {
	const o = raw && typeof raw === "object" ? raw : {};
	const arr = Array.isArray(o.pets) ? o.pets : null;
	if (!arr || !arr.length) return null;
	const out = [];
	for (const p of arr) {
		if (!p || typeof p !== "object") return null;
		const pp = p;
		const id = String(pp.id ?? "");
		if (!id || id.length > 64 || /[\\/:\x00-\x1f]/.test(id)) return null;
		const size = Number(pp.size);
		if (!Number.isFinite(size) || size <= 0) return null;
		const balanceEnabled = pp.balanceEnabled;
		if (typeof balanceEnabled !== "boolean") return null;
		const pos = pp.position && typeof pp.position === "object" ? pp.position : {};
		const corner = String(pos.corner ?? "");
		if (!CORNERS.includes(corner)) return null;
		const marginX = Number(pos.marginX);
		const marginY = Number(pos.marginY);
		if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
		out.push({
			id,
			size,
			balanceEnabled,
			position: {
				corner,
				marginX,
				marginY
			}
		});
	}
	const ne = o.notificationsEnabled;
	if (ne !== void 0 && typeof ne !== "boolean") return null;
	const outConfig = { pets: out };
	if (ne !== void 0) outConfig.notificationsEnabled = ne;
	return outConfig;
}
/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由。 */
function apply(ctx) {
	const thumbRoot = join(PACKAGE_ROOT, "assets", "thumb");
	const userRoot = join(resolveDshHome(), "dsh-pet");
	const userConfigPath = join(userRoot, "main-config.json");
	const thumbUserRoot = join(userRoot, "main-animation");
	let balanceTriggerCount = 0;
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const rest = decodeURIComponent(url.pathname.slice(14));
			if (rest === "config") {
				if (req.method === "GET") {
					try {
						const raw = await readFile(userConfigPath, "utf8");
						sendJson(res, 200, JSON.parse(raw));
					} catch {
						sendJson(res, 200, {});
					}
					return;
				}
				if (req.method === "PUT") {
					try {
						const body = await readBody(req);
						const clean = sanitizeUserConfig(JSON.parse(body));
						if (!clean) {
							sendJson(res, 400, { error: "invalid pet config: expected { pets:[{id,size,balanceEnabled,position:{corner,marginX,marginY}}] }（可选顶层 notificationsEnabled 布尔）" });
							return;
						}
						await mkdir(userRoot, { recursive: true });
						await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
						sendJson(res, 200, { ok: true });
					} catch {
						sendJson(res, 400, { error: "invalid JSON body" });
					}
					return;
				}
				if (req.method === "DELETE") {
					try {
						await rm(userConfigPath, { force: true });
					} catch {}
					sendJson(res, 200, { ok: true });
					return;
				}
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			if (rest === "config/meta") {
				sendJson(res, 200, {
					user: userConfigPath,
					default: join(PACKAGE_ROOT, "assets", "config.jsonc"),
					animations: thumbUserRoot
				});
				return;
			}
			if (rest === "balance") {
				if (req.method !== "GET") {
					sendJson(res, 405, { error: "method not allowed" });
					return;
				}
				try {
					sendJson(res, 200, await queryBalance(ctx.agentDefaultModel.currentSelection().provider, async (ref) => {
						return (await ctx.credentials.resolve(credentialRef(ref)))?.value;
					}));
				} catch (e) {
					sendJson(res, 500, {
						ok: false,
						provider: "unknown",
						reason: "fetch-error",
						message: e instanceof Error ? e.message : String(e)
					});
				}
				return;
			}
			if (rest === "balance/trigger") {
				const body = JSON.stringify({ count: balanceTriggerCount });
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-cache, no-store",
					"content-length": Buffer.byteLength(body)
				});
				res.end(body);
				return;
			}
			if (rest === "config.jsonc") {
				const cfgFile = join(PACKAGE_ROOT, "assets", "config.jsonc");
				if (!existsSync(cfgFile)) {
					res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
					res.end("dsh-pet: config.jsonc not found");
					return;
				}
				await sendFile(res, cfgFile, MIME[".jsonc"] ?? "application/octet-stream");
				return;
			}
			const [scope, ...nameParts] = rest.split("/");
			if (scope === "font") {
				const fontFile = resolveExisting(join(PACKAGE_ROOT, "assets", "fonts"), nameParts.join("/"));
				if (fontFile === void 0) {
					res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
					res.end("dsh-pet: font not found");
					return;
				}
				const ext = fontFile.slice(fontFile.lastIndexOf(".")).toLowerCase();
				await sendFile(res, fontFile, MIME[ext] ?? "application/octet-stream");
				return;
			}
			if (scope === "pic") {
				const picFile = resolveExisting(join(PACKAGE_ROOT, "assets", "pic"), nameParts.join("/"));
				if (picFile === void 0) {
					res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
					res.end("dsh-pet: pic not found");
					return;
				}
				const ext = picFile.slice(picFile.lastIndexOf(".")).toLowerCase();
				await sendFile(res, picFile, MIME[ext] ?? "application/octet-stream");
				return;
			}
			if (scope !== "thumb") {
				res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-pet: expected /dsh-pet-7340/thumb/<file>");
				return;
			}
			const fileName = nameParts.join("/");
			const file = resolveExisting(thumbUserRoot, fileName) ?? resolveExisting(thumbRoot, fileName);
			if (file === void 0) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-pet: asset not found");
				return;
			}
			const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
			await sendFile(res, file, MIME[ext] ?? "application/octet-stream");
		}
	}), "dsh-pet: /dsh-pet-7340 asset route");
	ctx.effect(() => ctx.commands.register({
		name: "balance",
		description: "手动触发桌宠余额动画（立即显示余额气泡）",
		handler: () => {
			balanceTriggerCount += 1;
			return {
				kind: "success",
				text: "已触发桌宠余额动画"
			};
		}
	}), "dsh-pet: /balance command");
}
//#endregion
export { apply, inject, name };
