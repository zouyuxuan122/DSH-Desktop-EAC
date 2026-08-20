import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/**
 * dsh-skin-switch — host half.
 *
 * Runs inside the `dsh web` process. Exposes the `skinSwitch` Typert Remote
 * that the Settings → 皮肤 tab drives: it lists the built-in skins the
 * desktop shell synced into the web profile (packages that ship skin.json)
 * and toggles their activation rows in cordis.patch.yml (mutually exclusive).
 *
 * Activation model: the desktop shell inserts one row per skin at boot
 * (`ui-skin-*`, `disabled: true` by default — "no skin" is the default
 * skin). Switching rewrites those rows: the chosen skin loses `disabled:
 * true`, every other row gains it. Rows the switcher does not own (other
 * plugins, the upstream skin center) are left untouched. A service restart
 * is required for the new row set to take effect.
 */

// 桌面端 v4 起默认运行在专属 profile（web-desktop），main.js 通过
// DSH_DESKTOP_PROFILE 环境变量把实际 profile 名传给 dsh web 子进程（与
// dsh-dock-settings / dsh-webui-market 的 host 半边同一约定）。皮肤行必须
// 读写服务实际使用的 profile，否则 apply 写进旧 web profile、重启后皮肤
// 不变。独立 CLI 安装（无该变量或值非法）仍用原生 web profile。
function profileName() {
	const p = process.env.DSH_DESKTOP_PROFILE;
	return p && /^[A-Za-z0-9_-]+$/.test(p) ? p : "web";
}
const SKIN_SCOPES = ["@linxin666", "@dsh-external"];

// 与客户端(client.js)一致的 strict 描述符：插件由桌面端拷贝进 web
// profile，其 @deepseek-ai/dsh-typert-protocol 与 agent（dsh-api-gateway）
// 不是同一个模块实例，SRC 标记（Remote 装饰器）跨实例不可见，端点无法被
// typert gateway claim（表现为 HTTP 404）。这里把端点显式注册进 host 侧
// typert local store（与生成代码同一注册路径），claim 与分发均与模块
// 实例无关。
const REMOTE_PACKAGE = "@deepseek-ai/dsh-skin-switch";
const looseCodec = () => ({
	mode: "strict",
	typeSymbol: "@deepseek-ai/dsh-skin-switch/types#Json",
	schema: { parse: (value) => value }
});
const descriptor = (method, parameters) => ({
	id: `@deepseek-ai/dsh-skin-switch#skinSwitch/${method}`,
	service: "skinSwitch",
	namespace: "skinSwitch",
	method,
	invocation: { kind: "direct" },
	parameters: parameters.map((name) => ({ name, wire: name, source: "json", codec: looseCodec() })),
	result: looseCodec()
});
const REMOTE_INVOCATIONS = [
	descriptor("list", []),
	descriptor("apply", ["id"]),
	descriptor("reset", [])
];
const SKIN_ROW_RE = /^ui-skin-[\w-]+$/;
// 皮肤预览图静态路由：GET /api/dsh-skins/preview/<id>/light|dark
const PREVIEW_ROUTE = "/api/dsh-skins/preview";
const PREVIEW_THEMES = ["light", "dark"];
const PREVIEW_EXTS = [".png", ".webp"];

/** The harness home the host booted with (same rule dsh itself uses). */
function homeDir() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** The profile directory the service actually runs on: $DSH_HOME/profiles/<profileName>. */
function profileDir() {
	return join(homeDir(), "profiles", profileName());
}

function patchPath() {
	return join(profileDir(), "cordis.patch.yml");
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Scan the profile's node_modules for skin packages: web client packages
 * that ship a skin.json manifest (the desktop shell copies these in from
 * assets/skins). The row id is the skin.json wiring.id (ui-skin-*).
 */
function installedSkins() {
	const dir = profileDir();
	const skins = [];
	for (const scope of SKIN_SCOPES) {
		const scopeDir = join(dir, "node_modules", ...scope.split("/"));
		if (!existsSync(scopeDir)) continue;
		for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const pkgDir = join(scopeDir, entry.name);
			const pkgPath = join(pkgDir, "package.json");
			const skinPath = join(pkgDir, "skin.json");
			if (!existsSync(pkgPath) || !existsSync(skinPath)) continue;
			try {
				const pkg = readJson(pkgPath);
				if (pkg.dsh?.client?.platform !== "web") continue;
			const manifest = readJson(skinPath);
			const rowId = manifest.wiring?.id ?? manifest.id;
			if (typeof rowId !== "string" || !SKIN_ROW_RE.test(rowId)) continue;
			skins.push({
				id: rowId,
				skinId: typeof manifest.id === "string" ? manifest.id : rowId,
				packageName: pkg.name,
				name: typeof manifest.name === "string" ? manifest.name : "",
				nameEn: typeof manifest.nameEn === "string" ? manifest.nameEn : "",
				tagline: typeof manifest.tagline === "string" ? manifest.tagline : "",
				description: typeof manifest.description === "string" ? manifest.description : "",
				tags: Array.isArray(manifest.tags) ? manifest.tags.filter((tag) => typeof tag === "string") : [],
				accent: typeof manifest.accent === "string" ? manifest.accent : "",
				author: typeof manifest.author === "string" ? manifest.author : "",
				order: Number.isFinite(manifest.order) ? manifest.order : 99,
				preview: {
					light: PREVIEW_ROUTE + "/" + rowId + "/light",
					dark: PREVIEW_ROUTE + "/" + rowId + "/dark"
				}
			});
			} catch {}
		}
	}
	skins.sort((a, b) => a.order - b.order);
	return skins;
}

/** Read the patch text; empty file and missing file both mean "no patch yet". */
function readPatchText() {
	if (!existsSync(patchPath())) return "";
	try { return readFileSync(patchPath(), "utf8"); } catch { return ""; }
}

/**
 * Current activation state per skin row: an id is active when its row has no
 * `disabled: true` child line. Only rows belonging to the roster are tracked
 * (other ui-skin-* rows, e.g. an upstream skin center, are not ours).
 */
function readSkinStates() {
	const roster = new Set(installedSkins().map((skin) => skin.id));
	const states = {};
	let current = null;
	for (const line of readPatchText().split(/\r?\n/)) {
		const m = line.match(/^\s{4}- id: (ui-skin-[\w-]+)\s*$/);
		if (m) {
			current = roster.has(m[1]) ? m[1] : null;
			if (current !== null) states[current] = false;
			continue;
		}
		if (current !== null && /^\s{6}disabled:\s*true\s*$/.test(line)) states[current] = true;
	}
	return states;
}

/**
 * Rewrite the activation rows for the given roster: the skin with `activeId`
 * (or none when null) loses `disabled: true`, every other roster skin gains
 * it. Patch blocks whose rows are all roster skins are dropped and re-appended
 * below; blocks that share lines with foreign rows (other plugins, an
 * upstream skin center) are kept, with only the roster lines removed.
 */
function rewriteSkinRows(skins, activeId) {
	const rosterIds = new Set(skins.map((skin) => skin.id));
	const text = readPatchText();
	const out = [];
	let pending = null;
	const flush = () => {
		if (pending === null) return;
		const { lines } = pending;
		const rows = [];
		for (const line of lines) {
			const m = line.match(/^\s+- id: (ui-skin-[\w-]+)\s*$/);
			if (m) rows.push(m[1]);
		}
		const allOurs = rows.length > 0 && rows.every((id) => rosterIds.has(id));
		if (!allOurs) {
			for (let i = 0; i < lines.length; i++) {
				const m = lines[i].match(/^\s+- id: (ui-skin-[\w-]+)\s*$/);
				if (m && rosterIds.has(m[1])) {
					if (i + 1 < lines.length && /^\s{6}disabled:\s*true\s*$/.test(lines[i + 1])) i++;
					continue;
				}
				out.push(lines[i]);
			}
		}
		pending = null;
	};
	for (const line of text.split(/\r?\n/)) {
		if (/^- insert:\s*$/.test(line.trim())) { flush(); pending = { lines: [line] }; }
		else if (pending !== null) pending.lines.push(line);
		else if (line.trim() !== "") out.push(line);
	}
	flush();
	let append = "";
	for (const skin of skins) {
		append += `- insert:\n    - id: ${skin.id}\n      name: '${skin.packageName}'\n`;
		if (skin.id !== activeId) append += `      disabled: true\n`;
	}
	let body = out.join("\n");
	let final;
	if (/^\s*\[\]\s*$/m.test(body)) final = append;
	else if (body.trim() === "") final = append;
	else final = body.replace(/\s+$/, "\n") + "\n" + append;
	writeFileSync(patchPath(), final);
}

/** Only loopback clients may fetch previews (the web UI runs on localhost). */
function isLoopback(req) {
	const ra = req.socket && req.socket.remoteAddress;
	return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

/** Resolve <id>/<theme> to a bundled preview file inside the profile's skin package. */
function previewFile(id, theme) {
	if (!SKIN_ROW_RE.test(String(id ?? "")) || !PREVIEW_THEMES.includes(theme)) return null;
	const skin = installedSkins().find((entry) => entry.id === id);
	if (!skin) return null;
	const pkgRoot = normalize(join(profileDir(), "node_modules", ...skin.packageName.split("/")));
	for (const ext of PREVIEW_EXTS) {
		const file = normalize(join(pkgRoot, "preview", theme + ext));
		if (!file.startsWith(pkgRoot + sep)) continue;
		if (existsSync(file) && statSync(file).isFile()) return file;
	}
	return null;
}

/** GET /api/dsh-skins/preview/<id>/<light|dark> — bundled preview image bytes. */
function handlePreviewRoute(req, res) {
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
	let pathname = "/";
	try {
		pathname = new URL(req.url, "http://127.0.0.1").pathname;
	} catch {
		pathname = "/";
	}
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length !== 5 || segments[0] !== "api" || segments[1] !== "dsh-skins" || segments[2] !== "preview") {
		res.writeHead(404);
		res.end("not found");
		return;
	}
	const file = previewFile(decodeURIComponent(segments[3]), segments[4]);
	if (!file) {
		res.writeHead(404);
		res.end("not found");
		return;
	}
	try {
		const data = readFileSync(file);
		res.writeHead(200, {
			"content-type": file.endsWith(".webp") ? "image/webp" : "image/png",
			"cache-control": "public, max-age=86400",
			"content-length": String(data.length)
		});
		res.end(data);
	} catch {
		res.writeHead(404);
		res.end("not found");
	}
}

class SkinSwitchGateway extends TypertRemoteService {
	static inject = ["webServer", "typert"];

	constructor(ctx) {
		super(ctx, "skinSwitch");
		// Apply the @Remote markers without decorator syntax (the host runs
		// plain ESM on Node 22). Marker state lives on the prototype and
		// re-marking is an idempotent no-op, so this is safe per instance.
		for (const name of ["list", "apply", "reset"]) {
			const decorator = Remote(name);
			decorator(SkinSwitchGateway.prototype[name], {
				name,
				private: false,
				static: false,
				addInitializer: (initializer) => initializer.call(this)
			});
		}
		// 预览图静态路由：仅回环可达，卸载插件时随上下文一并注销。
		if (ctx.webServer && typeof ctx.webServer.register === "function") {
			const disposer = ctx.webServer.register({ kind: "prefix", path: PREVIEW_ROUTE, handler: handlePreviewRoute });
			ctx.on("dispose", () => { try { disposer(); } catch {} });
		}
		// 把端点显式注册进 host typert local store（见文件头说明）。失败只
		// 告警不抛错：若端点已被其他来源注册，claim 同样可用。
		const typert = ctx.typert;
		if (typert && typeof typert.register === "function") {
			try {
				const dispose = typert.register({
					package: REMOTE_PACKAGE,
					face: "host",
					model: "src",
					schemas: [],
					invocations: REMOTE_INVOCATIONS
				});
				ctx.on("dispose", () => { try { dispose(); } catch {} });
			} catch (error) {
				ctx.logger?.warn?.("dsh-skin-switch: typert local registration failed: " + String((error && error.message) || error));
			}
		}
	}

	/** The built-in skins and which one is currently active (null = 默认皮肤). */
	list() {
		const skins = installedSkins();
		const states = readSkinStates();
		const active = skins.filter((skin) => !states[skin.id]);
		return { skins, activeId: active.length > 0 ? active[0].id : null };
	}

	/** Activate one skin, deactivating every other roster skin. */
	apply(id) {
		const skins = installedSkins();
		if (!SKIN_ROW_RE.test(String(id ?? "")) || !skins.some((skin) => skin.id === id)) {
			return { ok: false, id: String(id ?? ""), error: "未知皮肤: " + String(id ?? "") };
		}
		rewriteSkinRows(skins, id);
		return { ok: true, id, needsRestart: true };
	}

	/** Restore the default look: deactivate every roster skin. */
	reset() {
		const skins = installedSkins();
		rewriteSkinRows(skins, null);
		return { ok: true, id: null, needsRestart: true };
	}
}

export default SkinSwitchGateway;
export { SkinSwitchGateway, installedSkins, readSkinStates, rewriteSkinRows, previewFile };
