import { createRequire } from "node:module";
import { mkdir, open, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import z from "schemastery";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SettingsConflictError, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { chmodSync, existsSync } from "node:fs";
import { userInfo } from "node:os";
import * as nodePty from "node-pty";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/prefs-shared.ts
/**
* Shared "Side card" preference vocabulary (types + constants), consumed by
* BOTH halves: the host registers the schemastery schema over these values
* (config.ts) and the client reads/writes them through the settings RPC
* (client/prefs.ts, client/SideCardSection.tsx). Kept free of schemastery so
* the browser bundle never pulls the schema runtime in.
*/
/** The user-settings namespace holding the side card preferences. */
const SIDEBAR_PREFS_NS = "dsh-better-sidebar";
//#endregion
//#region src/config.ts
/**
* Serializable configuration and defaults for the sidebar host half. Loader
* schema validation normally fills defaults; {@link resolveSidebarConfig}
* applies the same defaults for direct callers that bypass the Loader.
* @module dsh-better-sidebar/config
*/
/** Schemastery schema for the plugin configuration. */
const Config = z.object({
	readLimit: z.number().step(1).min(1).default(524288),
	mediaLimit: z.number().step(1).min(1).default(20971520),
	listLimit: z.number().step(1).min(1).default(1e3),
	terminalsPerSession: z.number().step(1).min(1).default(3),
	reconnectGraceMs: z.number().step(1).min(0).default(3e4)
});
/**
* Apply direct-call defaults after Loader schema validation has normally run.
*
* @param config - Deployment-provided sidebar host settings.
* @returns Complete settings consumed by the host half.
*/
function resolveSidebarConfig(config) {
	return {
		readLimit: config?.readLimit ?? 524288,
		mediaLimit: config?.mediaLimit ?? 20971520,
		listLimit: config?.listLimit ?? 1e3,
		terminalsPerSession: config?.terminalsPerSession ?? 3,
		reconnectGraceMs: config?.reconnectGraceMs ?? 3e4
	};
}
/** Schemastery schema for the user-facing preferences (validated by the settings service). */
const PrefsSchema = z.object({
	openByDefault: z.boolean().default(true),
	defaultWidthPercent: z.number().step(1).min(20).max(60).default(30),
	autoOpenSubagent: z.boolean().default(true),
	autoOpenJobs: z.boolean().default(true),
	agentTerminalTools: z.boolean().default(false),
	bottomPanelAutoTerminal: z.boolean().default(true),
	terminalFontFamily: z.string().default(""),
	terminalFontSize: z.number().step(1).min(9).max(32).default(13),
	interceptOpenPath: z.boolean().default(true),
	titleBarCompat: z.boolean().default(false),
	titleBarStripPx: z.number().step(1).min(0).max(120).default(40),
	htmlViewerNoSandbox: z.boolean().default(false),
	htmlViewerDefaultUnsafe: z.boolean().default(false),
	browserNoSandbox: z.boolean().default(false),
	browserInterceptLinks: z.boolean().default(true),
	browserInterceptHttp: z.boolean().default(true),
	browserInterceptHttps: z.boolean().default(false),
	tabsEnabled: z.dict(z.boolean()).default({}),
	viewersEnabled: z.dict(z.boolean()).default({}),
	pluginSettings: z.dict(z.dict(z.any())).default({})
});
//#endregion
//#region src/wire.ts
/** One API failure with its wire code and HTTP status. */
var SidebarError = class extends Error {
	code;
	status;
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
};
/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20;
/** Read and parse the JSON request body (bounded; malformed → bad-request). */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new SidebarError("bad-request", "request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new SidebarError("bad-request", "request body is not valid JSON");
	}
}
/** Write a JSON response with the given status. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}
/** Write the success envelope. */
function writeOk(res, value) {
	writeJson(res, 200, {
		ok: true,
		value
	});
}
/** Write the failure envelope for any thrown value (unknown → internal 500). */
function writeError(res, error) {
	if (error instanceof SidebarError) {
		writeJson(res, error.status, {
			ok: false,
			error: {
				code: error.code,
				message: error.message
			}
		});
		return;
	}
	writeJson(res, 500, {
		ok: false,
		error: {
			code: "internal",
			message: error instanceof Error ? error.message : String(error)
		}
	});
}
/** Narrow an unknown payload value to a string, else throw bad-request. */
function requireString(payload, key) {
	const value = payload?.[key];
	if (typeof value !== "string" || value === "") throw new SidebarError("bad-request", `missing or invalid "${key}"`);
	return value;
}
//#endregion
//#region src/fs-tree.ts
/**
* Single-level directory listing for the sidebar explorer. Streams the level
* with opendir, sorts directories first then names (case-insensitive), and
* marks POSIX-hidden entries (dot-prefixed) for dimmed display. Symlinks are
* reported as files without probing their target — the explorer shows what
* dirent says, keeping the read cheap for arbitrarily large levels.
*/
/** Directory-first, case-insensitive name ordering (VSCode explorer order). */
function compareEntries(a, b) {
	if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
	return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
}
/**
* List one directory level.
* @param path - absolute directory path.
* @param maxEntries - row bound of one level (extra rows flag `truncated`).
* @returns the sorted listing.
* @throws {SidebarError} fs-error when the level is unreadable or not a directory.
*/
async function listDirectory(path, maxEntries = 1e3) {
	let level;
	try {
		level = await opendir(path);
	} catch (error) {
		throw new SidebarError("fs-error", `cannot list "${path}": ${messageOf(error)}`, 400);
	}
	const rows = [];
	let overflow = 0;
	try {
		for await (const dirent of level) {
			if (rows.length >= maxEntries) {
				overflow += 1;
				continue;
			}
			rows.push({
				name: dirent.name,
				path: join(path, dirent.name),
				isDir: dirent.isDirectory(),
				hidden: dirent.name.startsWith(".")
			});
		}
	} catch (error) {
		throw new SidebarError("fs-error", `cannot list "${path}": ${messageOf(error)}`, 400);
	}
	rows.sort(compareEntries);
	return {
		path,
		entries: rows,
		truncated: overflow > 0
	};
}
/** The root row label of a listing: the last path segment (or the full path at the filesystem root). */
function rootLabel(path) {
	const base = basename(path);
	return base !== "" ? base : path;
}
/** Parent of a path, or undefined at the filesystem root (the explorer's "up" target). */
function parentOf(path) {
	const parent = dirname(path);
	return parent === path ? void 0 : parent;
}
/** Normalize a caller-supplied path to an absolute, resolved path or throw fs-error. */
function requireAbsolute(path) {
	if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) throw new SidebarError("fs-error", `"${path}" is not an absolute path`, 400);
	return resolve(path);
}
/**
* Whether `target` lies under `base` (or equals it), tolerant of separator
* style and — on Windows, where the filesystem is case-insensitive — of
* letter case. The media route uses this instead of a raw `startsWith` so a
* case-mismatched or mixed-separator path can never be misclassified
* (e.g. `C:\Users\Me` vs `c:/users/me/file.png`).
* @param platform - filesystem semantics; injectable so both branches are
* unit-testable on any host.
*/
function isWithin(base, target, platform = process.platform) {
	const norm = (value) => value.replace(/[\\/]+/g, "/").replace(/\/$/, "");
	const b = norm(base);
	const t = norm(target);
	if (platform === "win32") {
		const lb = b.toLowerCase();
		const lt = t.toLowerCase();
		return lt === lb || lt.startsWith(`${lb}/`);
	}
	return t === b || t.startsWith(`${b}/`);
}
/** Message text of an unknown thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Decode a route pathname into the session + absolute file path. Rejects
* a wrong prefix (404), an empty or double-slash path, malformed percent
* encoding, and a missing sessionId or file path (400). The caller still
* must bound the decoded path with requireAbsolute + isWithin(cwd) — a
* decoded `..` segment resolves outside the cwd and is refused there.
*/
function decodeHtmlUrl(pathname) {
	if (!pathname.startsWith("/sidebar/html/")) return {
		ok: false,
		status: 404,
		message: "not an html route"
	};
	const rest = pathname.slice(14);
	if (rest === "" || rest.includes("//")) return {
		ok: false,
		status: 400,
		message: "invalid html route path"
	};
	let segments;
	try {
		segments = rest.split("/").map((segment) => decodeURIComponent(segment));
	} catch {
		return {
			ok: false,
			status: 400,
			message: "malformed URL encoding"
		};
	}
	const [sessionId, ...pathSegments] = segments;
	if (sessionId === void 0 || sessionId === "" || pathSegments.length === 0 || pathSegments.some((segment) => segment === "")) return {
		ok: false,
		status: 400,
		message: "sessionId and file path are required"
	};
	const first = pathSegments[0] ?? "";
	return {
		ok: true,
		ref: {
			sessionId,
			path: /^[A-Za-z]:$/.test(first) ? pathSegments.join("/") : `/${pathSegments.join("/")}`
		}
	};
}
//#endregion
//#region src/browser-probe.ts
/**
* Pure helpers for the `browser.probe` route (sidebar browser): the host
* fetches the response HEADERS of a URL the user is browsing and the client
* decides whether the target site forbids being embedded (X-Frame-Options /
* CSP frame-ancestors are exactly the signals the browser enforces when it
* refuses an iframe load). Kept dependency-free so the parser is
* unit-testable.
*/
/**
* Extract the `frame-ancestors` source list of a Content-Security-Policy
* header, or undefined when the directive is absent (or empty). The
* directive is the only one with a source list; sources are space-separated
* tokens (`'none'`, `'self'`, `*`, or origins).
*/
function extractFrameAncestors(csp) {
	if (csp === null) return void 0;
	for (const directive of csp.split(";")) {
		const parts = directive.trim().split(/\s+/);
		if (parts[0] === "frame-ancestors") {
			const sources = parts.slice(1).filter((source) => source !== "");
			return sources.length === 0 ? void 0 : sources;
		}
	}
}
//#endregion
//#region src/trust-fence.ts
function header(headers, name) {
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return;
	}
}
/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === void 0) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
	});
}
/**
* Decide whether one sidebar request may reach the plugin routes.
* @param request - node HTTP request facts (headers).
* @param trustedHosts - non-loopback authorities this deployment serves.
* @returns true when the Host is ours (loopback or trusted) and browser markers are same-origin.
*/
function isTrustedApiRequest(request, trustedHosts) {
	const host = header(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion
//#region src/bundle-route.ts
/**
* Lazy chunk route: serves the client bundle's chunk scripts
* (/sidebar/bundle/<name>.js). The official /plugins/<id>/client.js route
* cannot serve arbitrary file names, so the plugin serves its own split
* bundles (lib/client-<name>.js) here; the client injects the script on
* first use of the feature that needs it (see src/client/chunk-loader.ts).
*
* Caching contract: every response carries `cache-control: no-cache` plus an
* ETag (content hash, memoized per file by mtime/size) and honors
* If-None-Match — the browser revalidates each fetch, but a 304 avoids
* re-downloading multi-MB chunks that did not change (page refresh, HMR
* re-activation). Same browser-trust fence as every other /sidebar route;
* only allowlisted chunk names are servable (no path traversal).
*/
/** The chunk names the client may request (mirror of src/client/chunk-loader.ts). */
const CHUNK_NAMES = ["terminal", "editor"];
/** Directory of this host-half module (lib/ — the chunk scripts live next to it). */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
/** sha1 content hash shortened to 12 hex chars (same shape as the client-modules rev). */
function shortHash(input) {
	return createHash("sha1").update(input).digest("hex").slice(0, 12);
}
/** ETag memo: recompute the content hash only when the file's stat changed. */
const etags = /* @__PURE__ */ new Map();
/**
* The chunk file's ETag (quoted hash), or undefined when the file is
* missing. Hash is recomputed only when mtime/size changed (hashing a
* multi-MB chunk per request is wasteful).
*/
async function etagOf(name, chunkDir) {
	const path = join(chunkDir, `client-${name}.js`);
	const key = `${chunkDir}:${name}`;
	try {
		const info = await stat(path);
		const memo = etags.get(key);
		if (memo !== void 0 && memo.mtimeMs === info.mtimeMs && memo.size === info.size) return memo.etag;
		const etag = `"${shortHash(await readFile(path))}"`;
		etags.set(key, {
			mtimeMs: info.mtimeMs,
			size: info.size,
			etag
		});
		return etag;
	} catch {
		return;
	}
}
/**
* Build the /sidebar/bundle route handler. `fence` is the shared browser-
* trust check every /sidebar route applies; `chunkDir` is the directory the
* chunk scripts live in (overridable for tests).
*/
function createBundleRouteHandler(fence, chunkDir = LIB_DIR) {
	return async (req, res) => {
		if (!fence(req)) {
			res.writeHead(403);
			res.end("forbidden");
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405);
			res.end();
			return;
		}
		const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
		const name = /^\/sidebar\/bundle\/([a-z0-9-]+)\.js$/.exec(pathname)?.[1];
		if (name === void 0 || !CHUNK_NAMES.includes(name)) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const etag = await etagOf(name, chunkDir);
		if (etag === void 0) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		if (req.headers["if-none-match"] === etag) {
			res.writeHead(304, {
				"cache-control": "no-cache",
				etag
			});
			res.end();
			return;
		}
		try {
			const body = await readFile(join(chunkDir, `client-${name}.js`));
			res.writeHead(200, {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "no-cache",
				etag
			});
			res.end(body);
		} catch {
			res.writeHead(404);
			res.end("not found");
		}
	};
}
/** Register the /sidebar/bundle route (disposed with the fiber). */
function registerBundleRoute(ctx, fence) {
	return ctx.webServer.register({
		kind: "prefix",
		path: "/sidebar/bundle",
		handler: createBundleRouteHandler(fence)
	});
}
//#endregion
//#region src/git.ts
/**
* Git operations for the sidebar source-control panel. Everything goes
* through the system `git` binary spawned per request (no library, no state),
* with porcelain-parseable output formats (`-z` NUL framing, unit separators)
* so parsing never depends on locale or color config. All commands run with
* `-C <cwd>` on the session's working directory and `--no-pager` /
* `-c color.ui=false` so output stays machine-readable.
*
* Commits use the user's git global identity untouched (never sets
* user.name/user.email).
*/
/** One git failure (stderr text as the message). */
var GitCommandError = class extends Error {
	code;
	command;
	constructor(message, code = "git-error", command) {
		super(message);
		this.code = code;
		this.command = command;
	}
};
/** Parse porcelain v1 -z output into entries (rename/copy pairs collapse to one row). */
function parsePorcelainZ(output) {
	const tokens = output.split("\0");
	const entries = [];
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		index += 1;
		if (token === "") continue;
		const xy = token.slice(0, 2);
		const rest = token.slice(3);
		entries.push({
			path: rest,
			xy
		});
		if ((xy[0] === "R" || xy[0] === "C") && tokens[index] !== void 0 && tokens[index] !== "") index += 1;
	}
	return entries;
}
/** Parse `git log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D` rows. */
function parseLogLines(output) {
	const rows = [];
	for (const line of output.split("\n")) {
		if (line === "") continue;
		const [hash, subject, author, date, hashFull, refs] = line.split("");
		if (hash === void 0 || subject === void 0) continue;
		rows.push({
			hash,
			subject,
			author: author ?? "",
			date: date ?? "",
			hashFull: hashFull ?? hash,
			refs: refs ?? ""
		});
	}
	return rows;
}
/** Run one git command; resolves with stdout, rejects with GitCommandError. */
function runGit(cwd, args, timeoutMs = 3e4) {
	const full = [
		"-C",
		cwd,
		"--no-pager",
		"-c",
		"color.ui=false",
		...args
	];
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", full, {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				GIT_OPTIONAL_LOCKS: "0"
			}
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new GitCommandError(`git ${args[0] ?? ""} timed out after ${timeoutMs}ms`, "git-error", args.join(" ")));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new GitCommandError(`cannot run git: ${error.message}`, "git-error", args.join(" ")));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise(stdout);
			else reject(new GitCommandError(stderr.trim() || `git exited with ${String(code)}`, "git-error", args.join(" ")));
		});
	});
}
/** Whether the directory is inside a git work tree (exit-0 `git rev-parse`). */
async function isGitRepo(cwd) {
	try {
		return (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
	} catch {
		return false;
	}
}
/** The repository top level containing `cwd` (`git rev-parse --show-toplevel`). */
async function repoRoot(cwd) {
	return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
}
/** The current branch name (`git rev-parse --abbrev-ref HEAD`; 'HEAD' when detached). */
async function currentBranch(cwd) {
	return (await runGit(cwd, [
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	])).trim();
}
/** Working-tree status (untracked included). */
async function status(cwd) {
	if (!await isGitRepo(cwd)) return {
		isRepo: false,
		entries: []
	};
	const [branch, raw] = await Promise.all([currentBranch(cwd).catch(() => "HEAD"), runGit(cwd, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=normal"
	])]);
	return {
		isRepo: true,
		branch,
		entries: parsePorcelainZ(raw)
	};
}
/** Diff text of the worktree (unstaged) or the index (staged). */
async function diff(cwd, path, staged) {
	const args = [
		"diff",
		"--no-ext-diff",
		"--no-color",
		"-U3"
	];
	if (staged) args.push("--cached");
	if (path !== void 0) args.push("--", path);
	return runGit(cwd, args);
}
/** Stage paths (all when path is undefined). */
async function stage(cwd, path) {
	await runGit(cwd, [
		"add",
		"-A",
		...path !== void 0 ? ["--", path] : []
	]);
}
/** Unstage paths (all when path is undefined). */
async function unstage(cwd, path) {
	await runGit(cwd, [
		"reset",
		"-q",
		...path !== void 0 ? ["--", path] : []
	]);
}
/** Commit the staged changes with a message (global identity untouched). */
async function commit(cwd, message) {
	await runGit(cwd, [
		"commit",
		"-m",
		message
	]);
}
/** Branch names (current first). */
async function branches(cwd) {
	const [current, raw] = await Promise.all([currentBranch(cwd).catch(() => "HEAD"), runGit(cwd, [
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads"
	])]);
	const names = raw.split("\n").filter((line) => line !== "");
	return {
		current,
		names: names.includes(current) ? names : [current, ...names]
	};
}
/** Switch to an existing branch. */
async function checkout(cwd, branch) {
	await runGit(cwd, ["checkout", branch]);
}
/** Recent commit history (newest first), lazily pageable via skip/count. */
async function log(cwd, count = 30, skip = 0) {
	return parseLogLines(await runGit(cwd, [
		"log",
		"-n",
		String(count),
		"--skip",
		String(skip),
		"--decorate=short",
		"--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D"
	]));
}
/**
* Content of a file at a revision (`git show <rev>:<path>`), or null when the
* revision has no such path (a new/untracked file has no HEAD side).
*/
async function show(cwd, rev, path) {
	try {
		return await runGit(cwd, ["show", `${rev}:${path}`]);
	} catch {
		return null;
	}
}
/** Full patch text of one commit (`git show` with the commit header suppressed).
*  Merge commits show their diff against the first parent (`-m --first-parent`
*  is a no-op for regular commits), so a history click always has content. */
async function commitDiff(cwd, hash) {
	return runGit(cwd, [
		"show",
		"--no-ext-diff",
		"--no-color",
		"--format=",
		"-m",
		"--first-parent",
		hash
	]);
}
/** Discard the worktree changes of one path (`git checkout -- <path>`; the index is untouched). */
async function discard(cwd, path) {
	await runGit(cwd, [
		"checkout",
		"--",
		path
	]);
}
/** Revert one commit onto the current branch with an auto-generated message. */
async function revert(cwd, hash) {
	await runGit(cwd, [
		"revert",
		"--no-edit",
		hash
	]);
}
/** Cherry-pick one commit onto the current branch. */
async function cherryPick(cwd, hash) {
	await runGit(cwd, ["cherry-pick", hash]);
}
//#endregion
//#region src/pty-manager.ts
/**
* PTY session table for the sidebar terminals. One node-pty process per
* `${sessionId}:${tabId}` key; processes survive WebSocket disconnects
* (page refresh, tab switch) and reconnect to the same process by key.
* Output is mirrored into a bounded transcript ring (capped bytes) so a new
* connection replays history before live data. Sessions die only when the
* tab is closed or the plugin tears down.
*/
/** Per-terminal transcript bound (bytes kept for replay). */
const TRANSCRIPT_LIMIT$1 = 1 << 20;
/**
* Restore the executable bit pnpm strips from node-pty's prebuilt
* spawn-helper (the macOS helper that forks and sets up the pty). Without it
* every spawn fails with `posix_spawnp failed`. Idempotent; mirrors
* @deepseek-ai/dsh-terminal-bash's ensure-spawn-helper postinstall, run at
* plugin activation so link-installed deployments get the fix too.
*/
function ensureSpawnHelper() {
	if (process.platform === "win32") return;
	try {
		const entry = createRequire(import.meta.url).resolve("node-pty");
		const packageRoot = dirname(dirname(entry));
		const candidates = [join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), join(packageRoot, "build", "Release", "spawn-helper")];
		for (const helper of candidates) if (existsSync(helper)) chmodSync(helper, 493);
	} catch {}
}
/**
* The terminal registry. `maxPerSession` bounds concurrent processes per
* conversation (the client caps tabs at the same number).
*/
var PtyManager = class {
	shell;
	maxPerSession;
	sessions = /* @__PURE__ */ new Map();
	pendingCloses = /* @__PURE__ */ new Map();
	constructor(shell, maxPerSession) {
		this.shell = shell;
		this.maxPerSession = maxPerSession;
	}
	/** All live terminal keys of one session. */
	keysOf(sessionId) {
		const keys = [];
		for (const handle of this.sessions.values()) if (handle.sessionId === sessionId) keys.push(handle.key);
		return keys;
	}
	/**
	* Open (or reuse) the terminal for a session/tab key. A handle whose
	* process already exited is replaced with a fresh spawn (reconnecting a
	* dead terminal must yield a live shell, not an input sink), and so is a
	* live handle whose spawn cwd differs from the now-authoritative one (the
	* first connect of a page load can arrive before the session hydrates, so
	* it fell back to the process cwd — reconnecting with the real cwd must
	* restart the shell in the right directory). Reopening also cancels any
	* pending scheduled close (a reconnect within the grace window keeps the
	* process alive).
	* @param sessionId - conversation id.
	* @param tabId - client tab id.
	* @param cwd - initial working directory (the session's cwd).
	* @param cols - initial terminal width.
	* @param rows - initial terminal height.
	* @returns the live handle.
	* @throws {SidebarError} pty-error when the per-session cap is reached.
	*/
	open(sessionId, tabId, cwd, cols, rows) {
		const key = `${sessionId}:${tabId}`;
		this.cancelClose(key);
		const existing = this.sessions.get(key);
		if (existing !== void 0 && !existing.exited && existing.cwd === cwd) return existing;
		if (existing !== void 0) this.close(key);
		for (const [candidate, handle] of [...this.sessions]) if (handle.sessionId === sessionId && handle.exited) this.close(candidate);
		if (this.keysOf(sessionId).length >= this.maxPerSession) throw new SidebarError("pty-error", `terminal limit reached (${this.maxPerSession}) for this session`, 400);
		const handle = {
			key,
			sessionId,
			tabId,
			cwd,
			pty: nodePty.spawn(this.shell, shellSpawnArgs(), {
				name: "xterm-256color",
				cols: Math.max(2, Math.floor(cols)),
				rows: Math.max(2, Math.floor(rows)),
				cwd,
				env: { ...process.env }
			}),
			transcript: "",
			exited: false
		};
		handle.pty.onData((data) => {
			handle.transcript += data;
			if (handle.transcript.length > TRANSCRIPT_LIMIT$1) handle.transcript = handle.transcript.slice(handle.transcript.length - TRANSCRIPT_LIMIT$1);
		});
		handle.pty.onExit(({ exitCode }) => {
			handle.exited = true;
			handle.exitCode = exitCode;
		});
		this.sessions.set(key, handle);
		return handle;
	}
	/**
	* Schedule the terminal's destruction after `delayMs`. A tab close sends
	* delay 0 (release the quota immediately); a bare socket drop (refresh,
	* crash) uses the grace period so a quick reconnect keeps the process.
	* `open()` cancels any pending close.
	*/
	scheduleClose(key, delayMs) {
		if (this.sessions.get(key) === void 0) return;
		this.cancelClose(key);
		const timer = setTimeout(() => {
			this.close(key);
		}, delayMs);
		this.pendingCloses.set(key, timer);
	}
	/** Cancel a pending scheduled close (the terminal is being reopened). */
	cancelClose(key) {
		const timer = this.pendingCloses.get(key);
		if (timer !== void 0) {
			clearTimeout(timer);
			this.pendingCloses.delete(key);
		}
	}
	/** Resolve a live handle by key, or undefined. */
	get(key) {
		return this.sessions.get(key);
	}
	/** Close a terminal and drop its state (the owning tab was closed). */
	close(key) {
		this.cancelClose(key);
		const handle = this.sessions.get(key);
		if (handle === void 0) return;
		this.sessions.delete(key);
		try {
			handle.pty.kill();
		} catch {}
	}
	/** Close every terminal (plugin teardown). */
	disposeAll() {
		for (const timer of this.pendingCloses.values()) clearTimeout(timer);
		this.pendingCloses.clear();
		for (const key of [...this.sessions.keys()]) this.close(key);
	}
};
/**
* The interactive shell for this platform, resolved like a terminal
* emulator: an explicit `$SHELL` on the dsh process wins (deployment
* override), then the account's login shell from passwd, then `/bin/bash`.
* The passwd step matters because service managers and container inits
* often start dsh without `SHELL`, and the tab should still open the
* user's login shell (e.g. zsh) instead of silently degrading to bash.
* Windows short-circuits to `powershell.exe` before any resolution.
*/
function defaultShell() {
	if (process.platform === "win32") return "powershell.exe";
	const envShell = process.env.SHELL;
	if (envShell !== void 0 && envShell.trim() !== "") return envShell;
	try {
		const loginShell = userInfo().shell;
		if (typeof loginShell === "string" && loginShell.trim() !== "") return loginShell;
	} catch {}
	return "/bin/bash";
}
/**
* Spawn arguments that make the shell behave like a terminal-emulator tab:
* POSIX shells start as login shells (`-l`) so they read the profile files
* (`~/.profile`, `~/.zprofile`); Windows PowerShell takes no login flag.
*/
function shellSpawnArgs() {
	return process.platform === "win32" ? [] : ["-l"];
}
//#endregion
//#region src/agent-pty.ts
/**
* Agent-owned terminal registry: a uuid-keyed table of long-lived PTY
* sessions created by the model through the `terminal_create` tool. Each
* handle survives across tool calls (and across WebSocket disconnects from
* the sidebar view) until the model calls `terminal_close` or the user
* closes the corresponding sidebar tab — tmux semantics, scoped per agent
* session.
*
* This is a parallel registry to {@link PtyManager}: UI tabs are keyed by
* `${sessionId}:${tabId}` and capped per session, while agent terminals are
* keyed by uuid and uncapped (the model is trusted to close unused ones).
* Both registries share the same shell resolver and spawn-helper fix.
*/
/** Per-agent-terminal transcript bound (bytes kept for replay and reads). */
const TRANSCRIPT_LIMIT = 1 << 20;
/** POSIX signals the registry forwards to a live pty. */
const ALLOWED_SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGKILL",
	"SIGHUP",
	"SIGTSTP"
];
/** Largest pty dimension the registry accepts (mirrors the tool contract). */
const TERMINAL_DIM_MAX = 1024;
/** Clamp one cols×rows pair into the supported pty range (flooring decimals). */
function clampDims(cols, rows) {
	const clamp = (value) => Math.min(TERMINAL_DIM_MAX, Math.max(2, Math.floor(value)));
	return {
		cols: clamp(cols),
		rows: clamp(rows)
	};
}
/** Map a POSIX signal number to its conventional name (best-effort). */
const SIGNAL_NAMES = {
	1: "SIGHUP",
	2: "SIGINT",
	3: "SIGQUIT",
	4: "SIGILL",
	6: "SIGABRT",
	9: "SIGKILL",
	11: "SIGSEGV",
	13: "SIGPIPE",
	14: "SIGALRM",
	15: "SIGTERM",
	17: "SIGCHLD",
	18: "SIGCONT",
	19: "SIGSTOP",
	20: "SIGTSTP"
};
/** Convert a raw signal number to a name (or null when absent/unknown). */
function signalNameOf(signal) {
	if (signal === null || signal === void 0) return null;
	return SIGNAL_NAMES[signal] ?? `signal ${signal}`;
}
/** Locate the first occurrence of `needle` in `transcript`, returning its line/column. */
function locateNeedle(transcript, needle) {
	if (needle === "") return void 0;
	const idx = transcript.indexOf(needle);
	if (idx === -1) return void 0;
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < idx; i += 1) if (transcript.charCodeAt(i) === 10) {
		line += 1;
		lineStart = i + 1;
	}
	return {
		line,
		column: idx - lineStart
	};
}
/** Snapshot projection of a handle (drops the pty reference and transcript). */
function snapshotOf(handle) {
	const out = {
		uuid: handle.uuid,
		title: handle.title,
		command: handle.command,
		exited: handle.exited
	};
	if (handle.exited) {
		out.exitCode = handle.exitCode ?? null;
		out.exitSignal = signalNameOf(handle.exitSignal);
	}
	return out;
}
/**
* The agent terminal registry. The constructor takes the resolved shell
* binary (the same `defaultShell()` the UI-tab registry uses) and runs the
* spawn-helper chmod fix once at construction so the first agent terminal
* does not race a lazy fixer.
*/
var AgentPtyRegistry = class {
	shell;
	sessions = /* @__PURE__ */ new Map();
	changeListeners = /* @__PURE__ */ new Set();
	constructor(shell) {
		this.shell = shell;
		ensureSpawnHelper();
	}
	/**
	* Spawn one agent terminal: start the shell in `cwd`, then write
	* `command + '\n'` to stdin so the command runs in the fresh shell. The
	* terminal stays alive after the command exits — the model can send more
	* input through `terminal_send` until it calls `terminal_close` or the
	* user closes the sidebar tab. An empty `command` spawns a bare shell.
	* @returns the new handle's uuid (the model-facing opaque id).
	*/
	create(sessionId, title, command, cwd, cols = 80, rows = 24) {
		const uuid = randomUUID();
		const dims = clampDims(cols, rows);
		const pty = nodePty.spawn(this.shell, shellSpawnArgs(), {
			name: "xterm-256color",
			cols: dims.cols,
			rows: dims.rows,
			cwd,
			env: { ...process.env }
		});
		const handle = {
			uuid,
			sessionId,
			title,
			command,
			cwd,
			pty,
			transcript: "",
			exited: false
		};
		pty.onData((data) => {
			handle.transcript += data;
			if (handle.transcript.length > TRANSCRIPT_LIMIT) handle.transcript = handle.transcript.slice(handle.transcript.length - TRANSCRIPT_LIMIT);
		});
		pty.onExit(({ exitCode, signal }) => {
			handle.exited = true;
			handle.exitCode = exitCode;
			handle.exitSignal = signal;
			this.notify();
		});
		if (command !== "") try {
			pty.write(`${command}\r`);
		} catch {}
		this.sessions.set(uuid, handle);
		this.notify();
		return uuid;
	}
	/** All live agent terminals belonging to one conversation. */
	list(sessionId) {
		const out = [];
		for (const handle of this.sessions.values()) if (handle.sessionId === sessionId) out.push(snapshotOf(handle));
		return out;
	}
	/** Resolve a live handle by uuid, or throw `not-found`. */
	expect(uuid) {
		const handle = this.sessions.get(uuid);
		if (handle === void 0) throw new SidebarError("not-found", `agent terminal "${uuid}" not found`, 404);
		return handle;
	}
	/**
	* Resolve a live handle that belongs to `sessionId`, or throw `not-found`.
	* The model-facing tools call this before every uuid-keyed operation: a
	* uuid from another session is indistinguishable from an unknown one, so a
	* model can never reach (or probe) a terminal it does not own.
	*/
	assertOwned(uuid, sessionId) {
		const handle = this.expect(uuid);
		if (handle.sessionId !== sessionId) throw new SidebarError("not-found", `agent terminal "${uuid}" not found`, 404);
		return handle;
	}
	/** Resolve a handle's snapshot, or undefined if it does not exist. */
	snapshot(uuid) {
		const handle = this.sessions.get(uuid);
		return handle === void 0 ? void 0 : snapshotOf(handle);
	}
	/** Write raw text to a terminal's stdin (tmux `send-keys` semantics). */
	send(uuid, text) {
		const handle = this.expect(uuid);
		if (handle.exited) throw new SidebarError("bad-request", `agent terminal "${uuid}" has exited`, 400);
		handle.pty.write(text);
	}
	/**
	* Read one bounded page of the retained transcript. `offset` is a 0-based
	* line index from the start of the retained transcript (default 0);
	* `count` caps the page size (default 500). A negative `offset` reads
	* from the end (e.g. -50 reads the last 50 lines). Returns `totalLines`
	* so the model can paginate.
	*/
	read(uuid, offset, count) {
		const lines = this.expect(uuid).transcript.split("\n");
		const totalLines = lines.length;
		const pageSize = Math.max(1, Math.min(count ?? 500, 500));
		let start;
		if (offset === void 0 || offset === 0) start = 0;
		else if (offset < 0) start = Math.max(0, totalLines + offset);
		else start = Math.min(offset, totalLines);
		const end = Math.min(start + pageSize, totalLines);
		return {
			text: lines.slice(start, end).join("\n"),
			totalLines,
			lineBegin: start,
			lineEnd: end
		};
	}
	/**
	* Resize a terminal's pty, clamped to the 2..1024 sane range.
	* @returns the dimensions actually applied (the caller echoes these, so the
	* reported value always matches the pty).
	*/
	resize(uuid, cols, rows) {
		const handle = this.expect(uuid);
		const dims = clampDims(cols, rows);
		if (!handle.exited) handle.pty.resize(dims.cols, dims.rows);
		return dims;
	}
	/**
	* Wait for `needle` to appear in a terminal's transcript, or for the
	* terminal to exit, or for the timeout to elapse — whichever happens
	* first. The wait polls the live transcript every ~50ms and short-circuits
	* on `signal` abort (re-thrown as the abort reason so the tool layer
	* surfaces cancellation).
	*
	* The match scans the FULL retained transcript on each poll, not just the
	* delta since the last poll — a needle that scrolled past the most recent
	* chunk but is still within the ~1 MiB bound is still a match. The
	* returned line/column locate the FIRST occurrence (oldest), which is what
	* a user watching the terminal would have seen first.
	*
	* The implementation uses polling (not pty onData subscription) because
	* node-pty's onData fires before the registry's own onData listener
	* updates the transcript (listener order is not guaranteed), and on
	* Windows ConPTY output can arrive in bursts with batching delays that
	* make event-driven wakeups unreliable. A 50ms poll is fast enough for
	* interactive use and simple enough to be obviously correct.
	* @param uuid - terminal to watch.
	* @param needle - substring to search for (case-sensitive, verbatim).
	* @param timeoutMs - max wait; default 10000 (10s). Clamped to ≥100ms.
	* @param signal - caller-owned cancellation; aborts the wait re-throwing.
	* @returns one of `found` / `timeout` / `exited`.
	*/
	async waitFor(uuid, needle, timeoutMs = 1e4, signal) {
		if (needle === "") throw new SidebarError("bad-request", "needle must be a non-empty string", 400);
		const handle = this.expect(uuid);
		const timeout = Math.max(100, Math.floor(timeoutMs));
		const start = Date.now();
		const deadline = start + timeout;
		if (handle.exited) return {
			kind: "exited",
			needle,
			exitCode: handle.exitCode ?? null,
			exitSignal: signalNameOf(handle.exitSignal)
		};
		const firstHit = locateNeedle(handle.transcript, needle);
		if (firstHit !== void 0) return {
			kind: "found",
			needle,
			line: firstHit.line,
			column: firstHit.column,
			elapsedMs: Date.now() - start
		};
		while (true) {
			if (signal?.aborted) signal.throwIfAborted();
			if (handle.exited) return {
				kind: "exited",
				needle,
				exitCode: handle.exitCode ?? null,
				exitSignal: signalNameOf(handle.exitSignal)
			};
			const hit = locateNeedle(handle.transcript, needle);
			if (hit !== void 0) return {
				kind: "found",
				needle,
				line: hit.line,
				column: hit.column,
				elapsedMs: Date.now() - start
			};
			if (Date.now() >= deadline) return {
				kind: "timeout",
				needle,
				timeoutMs: timeout,
				totalLines: handle.transcript.split("\n").length
			};
			await new Promise((resolve) => {
				const t = setTimeout(resolve, 50);
				if (typeof t === "object" && "unref" in t) t.unref();
			});
		}
	}
	/**
	* Send a POSIX signal to a terminal's foreground process.
	*
	* Two delivery paths, by signal kind:
	* - **Interactive control signals** (SIGINT, SIGTSTP) are delivered by
	*   writing the corresponding control character to the pty stdin. This is
	*   how a real terminal sends Ctrl+C / Ctrl+Z: the byte hits the kernel
	*   line discipline (POSIX ISIG mode) or the ConPTY input pipeline
	*   (Windows), which translates it into a SIGINT/SIGTSTP for the
	*   foreground process group. This works on every platform — calling
	*   `node-pty.kill('SIGINT')` throws on Windows and is fragile on POSIX,
	*   but writing `\x03` is universally correct.
	* - **Termination signals** (SIGKILL, SIGTERM, SIGHUP) use `pty.kill()`,
	*   which maps to the platform's process-termination path (POSIX
	*   `kill(2)`, Windows `TerminateProcess`). These cannot be faked with
	*   control characters.
	*/
	signal(uuid, signal) {
		const handle = this.expect(uuid);
		if (handle.exited) return;
		if (signal === "SIGINT" || signal === "SIGTSTP") {
			const ctrlByte = signal === "SIGINT" ? "" : "";
			try {
				handle.pty.write(ctrlByte);
			} catch {}
			return;
		}
		try {
			handle.pty.kill(signal);
		} catch {
			try {
				handle.pty.kill();
			} catch {}
		}
	}
	/**
	* Close a terminal and drop its state. Idempotent: a second close of the
	* same uuid is a no-op. Returns true iff a live handle was actually
	* dropped.
	*/
	close(uuid) {
		const handle = this.sessions.get(uuid);
		if (handle === void 0) return false;
		this.sessions.delete(uuid);
		try {
			handle.pty.kill();
		} catch {}
		this.notify();
		return true;
	}
	/** Resolve a live handle by uuid (for the WS attach path). */
	get(uuid) {
		return this.sessions.get(uuid);
	}
	/**
	* Subscribe to registry changes (create / close / exit). The sidebar push
	* endpoint uses this to forward snapshots to the connected view. Returns
	* the unsubscribe function.
	*/
	subscribe(listener) {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}
	/** Close every agent terminal (plugin teardown). */
	disposeAll() {
		for (const uuid of [...this.sessions.keys()]) this.close(uuid);
	}
	/** Fire every change listener (callers wrap in try/catch if needed). */
	notify() {
		for (const listener of [...this.changeListeners]) try {
			listener();
		} catch {}
	}
};
//#endregion
//#region src/tools.ts
/**
* Eight model-facing tools for the agent-owned sidebar terminals (tmux
* semantics: spawn-and-detach, send-keys, read, wait-for, resize, signal,
* close, list). Each tool binds to the calling agent's session through
* `exec.agent.session.id`, so the model never passes a sessionId — the
* agent identity is the scope.
*
* Conventions (per plugin-development-guide.md §3):
*   C1 — parameters schema-validated before `execute` runs.
*   C4 — `execute` returns one canonical JSON value; `render` is a separate
*        pure text projection.
*   C6 — `exec.signal.throwIfAborted()` before any spawn.
*   C10 — no UI/transport vocabulary in the canonical value.
*/
/** Maximum UTF-8 bytes of one `terminal_read` result text. */
const READ_BYTE_LIMIT = 262144;
/**
* Bound a string to a byte limit, marking truncation. Truncation never
* splits a multi-byte UTF-8 sequence: when the byte cap lands inside one,
* the walk-back retreats to the sequence's leading byte so the retained
* prefix decodes cleanly (a split would decode to U+FFFD).
* @internal exported for the unit tests, like {@link snapshotOf}.
*/
function boundBytes(text, maxBytes) {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return {
		text,
		truncated: false
	};
	let end = maxBytes;
	while (end > 0 && ((buf[end] ?? 0) & 192) === 128) end -= 1;
	return {
		text: buf.subarray(0, end).toString("utf8"),
		truncated: true
	};
}
/** Pure text projection helper (the canonical value is already structured). */
function textRender(fn) {
	return (_args, value) => [{
		type: "text",
		text: fn(value)
	}];
}
/** Extract the calling agent or throw the canonical "no agent" error. */
function requireAgent(agent) {
	if (agent === void 0) throw new Error("sidebar terminal tools require an initiating agent");
	return agent;
}
/** Resolve the calling agent's session id (the registry scope + ownership key). */
function sessionIdOf(exec) {
	return requireAgent(exec.agent).session.id;
}
/**
* Register the eight terminal tools against the host tool registry. The
* `resolveCwd` callback threads the live session cwd (authoritative from the
* session store, falling back to the process cwd) so a freshly-created
* terminal lands in the right directory without the model passing it.
* Every uuid-keyed tool first asserts the terminal belongs to the calling
* session (`registry.assertOwned`), so one agent can never reach another
* session's terminals.
* @param ctx - host plugin context (carries the tools service).
* @param registry - the agent-owned terminal registry.
* @param resolveCwd - live cwd resolver for one session id.
* @returns a disposer that unregisters all eight tools (the caller gates
* registration on the side-card setting and calls this to turn them off).
*/
function registerTools(ctx, registry, resolveCwd) {
	const disposers = [];
	const register = (tool) => {
		disposers.push(ctx.tools.register(tool));
	};
	register(defineTool({
		name: "terminal_create",
		description: "Open a persistent terminal in the sidebar and run a command in it. Spawns an interactive shell, writes the command + Enter to its stdin, and returns a uuid handle. The terminal stays alive after the command exits — send more input with terminal_send (set submit=true to run a command), read output with terminal_read, send Ctrl+C with terminal_signal(signal=\"SIGINT\"), and close it with terminal_close when done. Use this for interactive shells, REPLs, long-running dev servers, or any work that needs persistent terminal state across tool calls. The terminal appears as a new tab in the right sidebar (titled with the `title` you provide) so the user can watch and interact with it.",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "Short human-readable label for the terminal tab (e.g. \"dev server\", \"python repl\")."
			},
			command: {
				type: "string",
				required: true,
				description: "Shell command to run in the freshly spawned shell. The host appends an Enter key automatically — do NOT include a trailing newline. Pass \"\" to open a bare shell with no command."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					uuid: {
						type: "string",
						required: true,
						description: "Opaque handle for the new terminal. Pass to terminal_send / terminal_read / terminal_resize / terminal_signal / terminal_close."
					},
					title: {
						type: "string",
						required: true,
						description: "The title you provided (echoed for confirmation)."
					}
				}
			},
			render: textRender((v) => `Opened terminal "${v.title}" (uuid: ${v.uuid}). The sidebar tab appears automatically; use terminal_read to see output and terminal_send (with submit=true) to run more commands.`)
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const sessionId = sessionIdOf(exec);
			const cwd = resolveCwd(sessionId);
			const uuid = registry.create(sessionId, args.title, args.command, cwd, 80, 24);
			return Promise.resolve({
				uuid,
				title: args.title
			});
		}
	}));
	register(defineTool({
		name: "terminal_list",
		description: "List every terminal the current agent has opened in this session. Returns each terminal's uuid, title, the command it was started with, and whether the top-level process has exited (with exit code/signal if so). Use this to recover state after a long sequence of tool calls or to find a terminal you forgot to close.",
		parameters: {},
		output: {
			schema: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						uuid: {
							type: "string",
							required: true
						},
						title: {
							type: "string",
							required: true
						},
						command: {
							type: "string",
							required: true
						},
						exited: {
							type: "boolean",
							required: true
						},
						exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
						exitSignal: { oneOf: [{ type: "string" }, { type: "null" }] }
					}
				}
			},
			render: (_args, value) => {
				const list = value;
				if (list.length === 0) return [{
					type: "text",
					text: "No agent terminals open in this session."
				}];
				return [{
					type: "text",
					text: `Agent terminals in this session:\n${list.map((t) => {
						const status = t.exited ? `exited (code ${t.exitCode ?? "?"}, signal ${t.exitSignal ?? "none"})` : "running";
						return `  ${t.uuid}  "${t.title}"  [${status}]  $ ${t.command}`;
					}).join("\n")}`
				}];
			}
		},
		execute: (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			return Promise.resolve(registry.list(sessionId));
		}
	}));
	register(defineTool({
		name: "terminal_send",
		description: "Send raw text (keystrokes) to a terminal opened with terminal_create — tmux send-keys semantics. The text is written verbatim to the pty stdin. To submit a command, set submit=true (appends an Enter key); do NOT put \"\\n\" or \"\\r\" in the text yourself. To send Ctrl+C (interrupt the running command), use the terminal_signal tool with signal=\"SIGINT\" — do NOT try to send the control character \"\\u0003\" as text. Use terminal_signal with signal=\"SIGTSTP\" for Ctrl+Z (suspend) as well. This tool does NOT wait for the command to finish or for output to settle — pair with terminal_read to observe the result. Throws if the terminal has exited.",
		parameters: {
			uuid: {
				type: "string",
				required: true,
				description: "Terminal uuid from terminal_create or terminal_list."
			},
			text: {
				type: "string",
				required: true,
				description: "UTF-8 text to write to the terminal stdin (verbatim, no shell escaping). Do not include trailing newlines — use the submit flag instead."
			},
			submit: {
				type: "boolean",
				description: "Append an Enter key (carriage return) after the text to submit a command. Default: false. Set to true when sending a command to run; leave false for partial input or control sequences."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					uuid: {
						type: "string",
						required: true
					},
					bytes: {
						type: "integer",
						required: true,
						description: "Number of UTF-8 bytes written (including the Enter key if submit was true)."
					}
				}
			},
			render: textRender((v) => `Sent ${v.bytes} byte(s) to terminal ${v.uuid}.`)
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const sessionId = sessionIdOf(exec);
			registry.assertOwned(args.uuid, sessionId);
			const payload = args.submit === true ? `${args.text}\r` : args.text;
			registry.send(args.uuid, payload);
			return Promise.resolve({
				uuid: args.uuid,
				bytes: Buffer.byteLength(payload, "utf8")
			});
		}
	}));
	register(defineTool({
		name: "terminal_read",
		description: "Read a bounded page of retained output from an agent terminal without sending input. The host keeps up to ~1 MiB of scrollback; this tool returns up to 500 lines per call. Use `offset` to paginate forward ( 0-based from the start of the retained transcript ) or backward ( negative reads from the end, e.g. -50 reads the last 50 lines ). Returns `totalLines` so you know how much scrollback remains. Output is bounded to 256 KiB per call; longer pages are truncated with the `truncated` flag.",
		parameters: {
			uuid: {
				type: "string",
				required: true,
				description: "Terminal uuid from terminal_create or terminal_list."
			},
			offset: {
				type: "number",
				description: "0-based line offset from the start of the retained transcript (default 0). Negative reads from the end (e.g. -50 = last 50 lines)."
			},
			count: {
				type: "number",
				description: "Maximum lines to return (default 500, hard cap 500)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true,
						description: "The slice of transcript for the requested page."
					},
					totalLines: {
						type: "integer",
						required: true,
						description: "Total lines in the retained transcript."
					},
					lineBegin: {
						type: "integer",
						required: true,
						description: "0-based index of the first line in `text` (inclusive)."
					},
					lineEnd: {
						type: "integer",
						required: true,
						description: "0-based index of the last line in `text` (exclusive)."
					},
					truncated: {
						type: "boolean",
						required: true,
						description: "Whether `text` was truncated to fit the 256 KiB read cap."
					}
				}
			},
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: `${`[lines ${v.lineBegin}..${v.lineEnd} of ${v.totalLines}${v.truncated ? "; truncated to 256KiB" : ""}]`}\n${v.text}`
				}];
			}
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const sessionId = sessionIdOf(exec);
			registry.assertOwned(args.uuid, sessionId);
			const result = registry.read(args.uuid, args.offset, args.count);
			const bounded = boundBytes(result.text, READ_BYTE_LIMIT);
			return Promise.resolve({
				text: bounded.text,
				totalLines: result.totalLines,
				lineBegin: result.lineBegin,
				lineEnd: result.lineEnd,
				truncated: bounded.truncated
			});
		}
	}));
	register(defineTool({
		name: "terminal_wait_for",
		description: "Block until a substring appears in a terminal's retained transcript, or until the timeout elapses, or until the terminal exits — whichever happens first. Use this to synchronize on command completion cues ( e.g. a shell prompt, \"done\", \"Listening on\", \"Build successful\" ) without busy-polling terminal_read. The wait scans the FULL retained transcript (up to ~1 MiB) on every poll, so a needle that scrolled past the most recent chunk is still a match. Returns `found` with the line/column of the first occurrence, `timeout` if the needle did not appear in time, or `exited` if the terminal process died before the needle appeared. Default timeout is 10 seconds; raise it for long-running commands ( dev servers, test suites ). The wait is cooperative: a tool-call cancel ( or agent turn end ) aborts it immediately.",
		parameters: {
			uuid: {
				type: "string",
				required: true,
				description: "Terminal uuid from terminal_create or terminal_list."
			},
			needle: {
				type: "string",
				required: true,
				description: "Substring to wait for (case-sensitive, verbatim). Must be non-empty."
			},
			timeout_ms: {
				type: "number",
				description: "Maximum wait in milliseconds (default 10000, i.e. 10s). Clamped to a minimum of 100ms."
			}
		},
		output: {
			schema: { oneOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "found"
						},
						needle: {
							type: "string",
							required: true
						},
						line: {
							type: "integer",
							required: true,
							description: "0-based line index in the retained transcript where the needle first appeared."
						},
						column: {
							type: "integer",
							required: true,
							description: "0-based column index within that line where the match starts."
						},
						elapsedMs: {
							type: "integer",
							required: true,
							description: "Wall-clock milliseconds from wait start to match."
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "timeout"
						},
						needle: {
							type: "string",
							required: true
						},
						timeoutMs: {
							type: "integer",
							required: true,
							description: "The configured timeout that elapsed."
						},
						totalLines: {
							type: "integer",
							required: true,
							description: "Total lines retained when the timeout fired. Call terminal_read to inspect the tail."
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "exited"
						},
						needle: {
							type: "string",
							required: true
						},
						exitCode: {
							oneOf: [{ type: "integer" }, { type: "null" }],
							description: "Exit code, if known."
						},
						exitSignal: {
							oneOf: [{ type: "string" }, { type: "null" }],
							description: "Exit signal name, if killed by a signal."
						}
					}
				}
			] },
			render: (_args, value) => {
				const v = value;
				if (v.kind === "found") return [{
					type: "text",
					text: `Found "${v.needle}" at line ${v.line}, column ${v.column} (after ${v.elapsedMs}ms).`
				}];
				if (v.kind === "timeout") return [{
					type: "text",
					text: `Timed out after ${v.timeoutMs}ms waiting for "${v.needle}". Call terminal_read to inspect the transcript.`
				}];
				const exitInfo = v.exitCode !== void 0 && v.exitCode !== null ? ` (exit code ${v.exitCode})` : "";
				return [{
					type: "text",
					text: `Terminal exited before "${v.needle}" appeared${exitInfo}.`
				}];
			}
		},
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			const sessionId = sessionIdOf(exec);
			registry.assertOwned(args.uuid, sessionId);
			const timeoutMs = args.timeout_ms ?? 1e4;
			return await registry.waitFor(args.uuid, args.needle, timeoutMs, exec.signal);
		}
	}));
	register(defineTool({
		name: "terminal_resize",
		description: "Resize an agent terminal's pty ( cols × rows ). The host clamps both to a 2..1024 sane range. Most shells redraw their prompt and any full-screen TUI on the next output frame. No-op if the terminal has exited. Returns the dimensions actually applied.",
		parameters: {
			uuid: {
				type: "string",
				required: true,
				description: "Terminal uuid from terminal_create or terminal_list."
			},
			cols: {
				type: "integer",
				required: true,
				description: "New column count ( clamped to 2..1024 )."
			},
			rows: {
				type: "integer",
				required: true,
				description: "New row count ( clamped to 2..1024 )."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					uuid: {
						type: "string",
						required: true
					},
					cols: {
						type: "integer",
						required: true
					},
					rows: {
						type: "integer",
						required: true
					}
				}
			},
			render: textRender((v) => `Resized terminal ${v.uuid} to ${v.cols}×${v.rows}.`)
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const sessionId = sessionIdOf(exec);
			registry.assertOwned(args.uuid, sessionId);
			const dims = registry.resize(args.uuid, args.cols, args.rows);
			return Promise.resolve({
				uuid: args.uuid,
				...dims
			});
		}
	}));
	register(defineTool({
		name: "terminal_signal",
		description: "Send a POSIX signal to an agent terminal's foreground process — this is how you send Ctrl+C, Ctrl+Z, etc. Use signal=\"SIGINT\" for Ctrl+C (interrupt the running command), signal=\"SIGTERM\" to request termination, signal=\"SIGKILL\" to force-kill the pty, signal=\"SIGHUP\" to hang up (many shells exit), signal=\"SIGTSTP\" for Ctrl+Z (suspend). Do NOT try to send control characters (like \"\\u0003\") through terminal_send — use this tool instead. On Windows, only SIGKILL and SIGTERM are effective — others are accepted but may no-op. No-op if the terminal has already exited. Use terminal_close to dispose of the terminal entirely.",
		parameters: {
			uuid: {
				type: "string",
				required: true,
				description: "Terminal uuid from terminal_create or terminal_list."
			},
			signal: {
				type: "string",
				required: true,
				enum: ALLOWED_SIGNALS,
				description: "Signal to deliver: SIGINT (Ctrl+C) | SIGTERM | SIGKILL | SIGHUP | SIGTSTP (Ctrl+Z)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					uuid: {
						type: "string",
						required: true
					},
					signal: {
						type: "string",
						required: true
					}
				}
			},
			render: textRender((v) => `Sent ${v.signal} to terminal ${v.uuid}.`)
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const sessionId = sessionIdOf(exec);
			registry.assertOwned(args.uuid, sessionId);
			registry.signal(args.uuid, args.signal);
			return Promise.resolve({
				uuid: args.uuid,
				signal: args.signal
			});
		}
	}));
	register(defineTool({
		name: "terminal_close",
		description: "Close an agent terminal and release its process. The uuid becomes invalid for all subsequent tool calls. Idempotent: closing an already-closed uuid is a no-op. The corresponding sidebar tab is removed automatically when the host pushes the updated terminal list. Always close terminals you no longer need — the host keeps the pty alive until you do.",
		parameters: { uuid: {
			type: "string",
			required: true,
			description: "Terminal uuid from terminal_create or terminal_list."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					uuid: {
						type: "string",
						required: true
					},
					closed: {
						type: "boolean",
						required: true,
						description: "Whether a live terminal was actually dropped (false if the uuid was already gone)."
					}
				}
			},
			render: textRender((v) => v.closed ? `Closed terminal ${v.uuid}.` : `Terminal ${v.uuid} was already closed.`)
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const sessionId = sessionIdOf(exec);
			registry.assertOwned(args.uuid, sessionId);
			const closed = registry.close(args.uuid);
			return Promise.resolve({
				uuid: args.uuid,
				closed
			});
		}
	}));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
//#endregion
//#region src/jobs-routes.ts
/**
* Extract the plain text of a finalized tool result: the text blocks inside
* the 'tool-result' block, joined with newlines. Error results and
* non-text blocks contribute nothing.
*/
function resultText(message) {
	if (!Array.isArray(message.content)) return void 0;
	const parts = [];
	for (const block of message.content) {
		if (block === null || typeof block !== "object") continue;
		const candidate = block;
		if (candidate.type !== "tool-result") continue;
		const inner = candidate.content;
		if (!Array.isArray(inner)) continue;
		for (const item of inner) {
			if (item === null || typeof item !== "object") continue;
			const textItem = item;
			if (textItem.type === "text" && typeof textItem.text === "string") parts.push(textItem.text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : void 0;
}
/** Whether a tool/result is an error result (the inner block's isError flag). */
function resultIsError(message) {
	if (!Array.isArray(message.content)) return false;
	return message.content.some((block) => {
		if (block === null || typeof block !== "object") return false;
		return block.type === "tool-result" && block.isError === true;
	});
}
/** Whether a job_output result carries no new output — the controller's
*  model-facing "(no new output)" body, noise for the human pane. */
function isNoNewOutput(text) {
	return text.startsWith("(no new output)");
}
/** Extract the job_output trace of one raw session event (undefined = unrelated). */
function traceOf(event) {
	if (event.type === "tool/call") {
		const data = event.data;
		if (data.name !== "job_output" || typeof data.callId !== "string") return void 0;
		let jobId;
		try {
			const args = JSON.parse(typeof data.arguments === "string" ? data.arguments : "");
			if (typeof args.job_id === "string") jobId = args.job_id;
		} catch {}
		if (jobId === void 0) return void 0;
		return {
			seq: event.seq,
			kind: "call",
			callId: data.callId,
			jobId
		};
	}
	if (event.type === "tool/result") {
		const message = event.data.message;
		if (message === void 0) return void 0;
		const callId = message.source?.callId;
		if (typeof callId !== "string") return void 0;
		return {
			seq: event.seq,
			kind: "result",
			callId,
			text: resultText(message),
			isError: resultIsError(message)
		};
	}
}
/** Per-session cap of mirrored live traces (a bounded, lossy ring). */
const MIRROR_MAX_ENTRIES = 200;
/**
* The live job_output mirror: subscribes to the session append feed and
* caches the job_output traces the session store's own log can lag behind
* (after a host restart the store session stays frozen at its rehydration
* boundary, so `session.events` misses everything appended since — the very
* reads the pane exists to show). Zero DSH writes: the api-proxy pushes the
* same feed to browsers.
*/
function createJobOutputMirror(ctx) {
	const perSession = /* @__PURE__ */ new Map();
	const callIds = /* @__PURE__ */ new Map();
	if (typeof ctx.on !== "function") return { entries: () => [] };
	const dispose = ctx.on("session/event", (session, event) => {
		const sessionId = session?.id;
		if (typeof sessionId !== "string") return;
		if (event.type === "tool/call") {
			const trace = traceOf(event);
			if (trace?.kind !== "call") return;
			let ids = callIds.get(sessionId);
			if (ids === void 0) callIds.set(sessionId, ids = /* @__PURE__ */ new Set());
			ids.add(trace.callId);
			push(sessionId, trace);
		} else if (event.type === "tool/result") {
			const trace = traceOf(event);
			if (trace?.kind !== "result") return;
			if (!callIds.get(sessionId)?.has(trace.callId)) return;
			push(sessionId, trace);
		}
	});
	ctx.effect(() => dispose, "dsh-better-sidebar: job-output event mirror");
	const push = (sessionId, trace) => {
		let list = perSession.get(sessionId);
		if (list === void 0) perSession.set(sessionId, list = []);
		list.push(trace);
		if (list.length > MIRROR_MAX_ENTRIES) {
			const removed = list.splice(0, list.length - MIRROR_MAX_ENTRIES);
			const ids = callIds.get(sessionId);
			if (ids !== void 0) {
				for (const entry of removed) if (entry.kind === "call") ids.delete(entry.callId);
				if (ids.size === 0) callIds.delete(sessionId);
			}
		}
	};
	return { entries: (sessionId) => perSession.get(sessionId) ?? [] };
}
/**
* Build the jobs routes bound to the plugin context. `output` merges the
* owner session's own event log with the live job_output mirror; `kill`
* reads the jobs/agents services lazily and degrades to a 503 when the
* deployment lacks the registry.
* @param ctx - host plugin context.
* @param outputLimit - response cap for one output replay in bytes; longer
*   texts are sliced and flagged `truncated` (mirrors the fs.read cap).
*/
function buildJobsApi(ctx, outputLimit) {
	const jobs = ctx.get("jobs");
	const agents = ctx.get("agents");
	const mirror = createJobOutputMirror(ctx);
	/** The live caller whose session id the registry fence compares against. */
	const callerOf = (sessionId) => agents?.get(sessionId);
	/** Registry refusals become a 404 job-error; unknown and foreign ids are indistinguishable. */
	const registryError = (error) => new SidebarError("job-error", error instanceof Error ? error.message : String(error), 404);
	return {
		output(payload) {
			const sessionId = requireString(payload, "sessionId");
			const id = requireString(payload, "id");
			const bySeq = /* @__PURE__ */ new Map();
			for (const event of ctx.sessions.get(sessionId)?.events ?? []) {
				const trace = traceOf(event);
				if (trace !== void 0) bySeq.set(trace.seq, trace);
			}
			for (const trace of mirror.entries(sessionId)) bySeq.set(trace.seq, trace);
			const jobOf = /* @__PURE__ */ new Map();
			const parts = [];
			let read = false;
			for (const trace of [...bySeq.values()].sort((left, right) => left.seq - right.seq)) if (trace.kind === "call") {
				if (trace.jobId !== void 0) jobOf.set(trace.callId, trace.jobId);
			} else if (jobOf.get(trace.callId) === id) {
				read = true;
				if (trace.isError !== true && trace.text !== void 0 && !isNoNewOutput(trace.text)) parts.push(trace.text);
			}
			const text = parts.join("\n");
			return {
				text: text.length > outputLimit ? text.slice(0, outputLimit) : text,
				truncated: text.length > outputLimit,
				read
			};
		},
		kill(payload) {
			if (jobs === void 0) throw new SidebarError("job-error", "the background-job registry is not mounted in this deployment", 503);
			const sessionId = requireString(payload, "sessionId");
			const id = requireString(payload, "id");
			const record = payload;
			const reason = typeof record?.reason === "string" && record.reason !== "" ? record.reason : "user requested via sidebar";
			try {
				return {
					ok: true,
					outcome: jobs.kill(id, callerOf(sessionId), reason)
				};
			} catch (error) {
				throw registryError(error);
			}
		}
	};
}
//#endregion
//#region src/index.ts
/**
* dsh-better-sidebar host half: the /sidebar JSON API (explorer listing, file
* read/write, git), the /sidebar/file media route (images), the /sidebar/html
* preview route, the /sidebar/bundle lazy-chunk route (client code splits),
* and the terminal WebSocket upgrade. Every route passes the same
* browser-trust fence as the /api gateway — Host-header loopback or the
* web runtime's `trustedHosts` (LAN IP literals sampled at boot plus
* `--trusted-host` authorities), read per request from the live service
* value so the fence tracks the same trust source the /api gateway derives
* its list from.
*
* All operations are conversation-scoped: requests carry a sessionId, the
* session's authoritative cwd comes from the session store, and terminal
* processes are keyed by session.
*/
/** Plugin identity for cordis.yml rows. */
const name = "dsh-better-sidebar";
/** Services required before mounting: the webserver routes, the session store, the web runtime's trusted hosts, and the tool registry. */
const inject = [
	"webServer",
	"sessions",
	"webRuntime",
	"tools"
];
/** Content types for the media route, by extension. */
const MEDIA_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".avif": "image/avif",
	".pdf": "application/pdf",
	".html": "text/html",
	".htm": "text/html"
};
/** Content type served by /sidebar/file (binary-safe fallback for unknowns). */
function mediaTypeForPath(path) {
	return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
/**
* Resolve a session's authoritative working directory. The attached session
* header wins; while the session is still hydrating from persistence (the
* web client attaches the current conversation a moment after page load, so
* the very first sidebar requests can arrive detached) the caller's own
* list-summary cwd is used; the process cwd is the last resort (blank
* sessions have no cwd anywhere yet). Never throws for a missing cwd, so
* explorer/git/terminal work from first paint instead of surfacing
* "session ... has no working directory".
*/
function sessionCwdOf(ctx, sessionId, clientCwd) {
	const headerCwd = ctx.sessions.get(sessionId)?.header.cwd;
	if (headerCwd !== void 0 && headerCwd !== "") return headerCwd;
	if (clientCwd !== void 0 && clientCwd !== "") try {
		return requireAbsolute(clientCwd);
	} catch {
		throw new SidebarError("bad-request", `invalid working directory "${clientCwd}"`);
	}
	return process.cwd();
}
/**
* Resolve a path that a git command reported — `git status`/`git diff`
* print paths RELATIVE TO THE REPO TOP LEVEL, which may sit above the
* session cwd (a session inside a subdirectory of a repository). Absolute
* paths pass through; relative ones join the repo root (falling back to the
* cwd when the root cannot be resolved, e.g. a bare directory).
*/
async function resolveGitPath(cwd, raw) {
	if (isAbsolute(raw)) return requireAbsolute(raw);
	const root = await repoRoot(cwd).catch(() => cwd);
	return requireAbsolute(join(root, raw));
}
/** How many leading bytes a binary read returns for client-side detect sniffing. */
const READ_HEAD_LIMIT = 4096;
/** Text read of a file with the size cap; binary detection via NUL probe.
*  Binary reads also return the first {@link READ_HEAD_LIMIT} bytes (base64)
*  so the client can re-match viewers by content (`detect`). */
async function readText(path, readLimit) {
	const info = await stat(path).catch((error) => {
		throw new SidebarError("fs-error", `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400);
	});
	if (info.isDirectory()) throw new SidebarError("fs-error", `"${path}" is a directory`, 400);
	const size = info.size;
	const truncated = size > readLimit;
	const handle = await open(path, "r").catch((error) => {
		throw new SidebarError("fs-error", `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400);
	});
	try {
		const buffer = Buffer.alloc(Math.min(size, readLimit));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const slice = buffer.subarray(0, bytesRead);
		const binary = slice.includes(0);
		const head = binary ? slice.subarray(0, Math.min(slice.length, READ_HEAD_LIMIT)).toString("base64") : void 0;
		return {
			content: binary ? "" : slice.toString("utf8"),
			truncated,
			binary,
			size,
			head
		};
	} finally {
		await handle.close();
	}
}
/** Build the API method table bound to the plugin context, pty manager, agent pty registry, and resolved config. */
function buildApi(ctx, ptyManager, agentPtyRegistry, resolved, getSettings) {
	const cwdOf = (payload) => {
		const sessionId = requireString(payload, "sessionId");
		const record = payload;
		return {
			sessionId,
			cwd: sessionCwdOf(ctx, sessionId, typeof record?.cwd === "string" && record.cwd !== "" ? record.cwd : void 0)
		};
	};
	const jobsApi = buildJobsApi(ctx, resolved.readLimit);
	return {
		"session.cwd": (payload) => {
			const { sessionId, cwd } = cwdOf(payload);
			return {
				sessionId,
				cwd,
				root: rootLabel(cwd),
				parent: parentOf(cwd) ?? null
			};
		},
		"fs.tree": async (payload) => {
			const { cwd } = cwdOf(payload);
			return listDirectory(payload.path === void 0 ? cwd : requireAbsolute(requireString(payload, "path")), resolved.listLimit);
		},
		"fs.read": async (payload) => {
			const { cwd } = cwdOf(payload);
			const { content, truncated, binary, size, head } = await readText(await resolveGitPath(cwd, requireString(payload, "path")), resolved.readLimit);
			if (binary) return {
				kind: "binary",
				size,
				truncated,
				head
			};
			return {
				kind: "text",
				content,
				truncated
			};
		},
		"fs.write": async (payload) => {
			const { cwd } = cwdOf(payload);
			const path = requireAbsolute(requireString(payload, "path"));
			const content = requireString(payload, "content");
			const tmp = `${path}.dsh-sidebar-tmp-${process.pid}`;
			try {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(tmp, content, "utf8");
				await rename(tmp, path);
			} catch (error) {
				await rm(tmp, { force: true }).catch(() => {});
				throw new SidebarError("fs-error", `cannot write "${path}": ${error instanceof Error ? error.message : String(error)}`, 400);
			}
			return { ok: true };
		},
		"git.status": async (payload) => {
			const { cwd } = cwdOf(payload);
			return status(cwd);
		},
		"git.diff": async (payload) => {
			const { cwd } = cwdOf(payload);
			const record = payload;
			return { diff: await diff(cwd, record.path === void 0 ? void 0 : await resolveGitPath(cwd, requireString(payload, "path")), record.staged === true) };
		},
		"git.stage": async (payload) => {
			const { cwd } = cwdOf(payload);
			await stage(cwd, payload.path === void 0 ? void 0 : requireString(payload, "path"));
			return { ok: true };
		},
		"git.unstage": async (payload) => {
			const { cwd } = cwdOf(payload);
			await unstage(cwd, payload.path === void 0 ? void 0 : requireString(payload, "path"));
			return { ok: true };
		},
		"git.commit": async (payload) => {
			const { cwd } = cwdOf(payload);
			await commit(cwd, requireString(payload, "message"));
			return { ok: true };
		},
		"git.branch": async (payload) => {
			const { cwd } = cwdOf(payload);
			return branches(cwd);
		},
		"git.checkout": async (payload) => {
			const { cwd } = cwdOf(payload);
			await checkout(cwd, requireString(payload, "branch"));
			return { ok: true };
		},
		"git.log": async (payload) => {
			const { cwd } = cwdOf(payload);
			const record = payload;
			return log(cwd, typeof record.count === "number" && Number.isInteger(record.count) && record.count > 0 ? record.count : void 0, typeof record.skip === "number" && Number.isInteger(record.skip) && record.skip >= 0 ? record.skip : void 0);
		},
		"git.commit-diff": async (payload) => {
			const { cwd } = cwdOf(payload);
			return { diff: await commitDiff(cwd, requireString(payload, "hash")) };
		},
		"git.discard": async (payload) => {
			const { cwd } = cwdOf(payload);
			await discard(cwd, await resolveGitPath(cwd, requireString(payload, "path")));
			return { ok: true };
		},
		"git.revert": async (payload) => {
			const { cwd } = cwdOf(payload);
			await revert(cwd, requireString(payload, "hash"));
			return { ok: true };
		},
		"git.cherry-pick": async (payload) => {
			const { cwd } = cwdOf(payload);
			await cherryPick(cwd, requireString(payload, "hash"));
			return { ok: true };
		},
		"git.show": async (payload) => {
			const { cwd } = cwdOf(payload);
			const path = await resolveGitPath(cwd, requireString(payload, "path"));
			return { content: await show(cwd, requireString(payload, "rev"), path) };
		},
		"pty.close": (payload) => {
			const sessionId = requireString(payload, "sessionId");
			const tab = requireString(payload, "tab");
			ptyManager.close(`${sessionId}:${tab}`);
			return { ok: true };
		},
		"agent-pty.close": (payload) => {
			const uuid = requireString(payload, "uuid");
			agentPtyRegistry.close(uuid);
			return { ok: true };
		},
		"jobs.output": (payload) => jobsApi.output(payload),
		"jobs.kill": (payload) => jobsApi.kill(payload),
		"settings.get": () => {
			return getSettings()?.get() ?? {
				value: void 0,
				revision: void 0
			};
		},
		"settings.update": async (payload) => {
			const settings = getSettings();
			if (settings === void 0) throw new SidebarError("settings-rejected", "the settings service is not mounted in this deployment", 503);
			const record = payload;
			const patch = record?.patch;
			if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new SidebarError("bad-request", "patch must be a plain object");
			const expectedRevision = typeof record?.expectedRevision === "number" ? record.expectedRevision : void 0;
			try {
				return await settings.update(patch, expectedRevision);
			} catch (error) {
				if (error instanceof SettingsConflictError) throw new SidebarError("settings-conflict", error.message, 409);
				throw new SidebarError("settings-rejected", error instanceof Error ? error.message : String(error), 400);
			}
		},
		"browser.probe": async (payload) => {
			const raw = requireString(payload, "url");
			let parsed;
			try {
				parsed = new URL(raw);
			} catch {
				throw new SidebarError("bad-request", "invalid url", 400);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SidebarError("bad-request", "only http/https urls can be probed", 400);
			if (isLoopbackHostname(parsed.hostname)) throw new SidebarError("bad-request", "local addresses are not probed", 400);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 8e3);
			try {
				let response = await fetch(parsed, {
					method: "HEAD",
					redirect: "follow",
					signal: controller.signal
				});
				if (response.status === 405 || response.status === 501) response = await fetch(parsed, {
					method: "GET",
					redirect: "follow",
					signal: controller.signal
				});
				const frameAncestors = extractFrameAncestors(response.headers.get("content-security-policy"));
				const xFrameOptions = response.headers.get("x-frame-options");
				return {
					reachable: true,
					url: response.url,
					status: response.status,
					...xFrameOptions !== null ? { xFrameOptions } : {},
					...frameAncestors !== void 0 ? { frameAncestors } : {}
				};
			} catch {
				return { reachable: false };
			} finally {
				clearTimeout(timer);
			}
		}
	};
}
/**
* Plugin body: mount the fenced routes and the pty lifecycle.
* @param ctx - host plugin context (webServer, sessions, webRuntime).
* @param config - deployment-provided limits; the Loader validates against
* {@link Config} and fills defaults, direct callers get them from
* {@link resolveSidebarConfig}.
*/
function apply(ctx, config) {
	ensureSpawnHelper();
	const resolved = resolveSidebarConfig(config);
	const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);
	const ptyManager = new PtyManager(defaultShell(), resolved.terminalsPerSession);
	const agentPtyRegistry = new AgentPtyRegistry(defaultShell());
	let settingsFace;
	let toolsDisposers = null;
	const syncToolsGate = (scope) => {
		if (scope.get().agentTerminalTools) {
			if (toolsDisposers === null) toolsDisposers = registerTools(ctx, agentPtyRegistry, (sessionId) => sessionCwdOf(ctx, sessionId));
		} else if (toolsDisposers !== null) {
			toolsDisposers();
			toolsDisposers = null;
			agentPtyRegistry.disposeAll();
		}
	};
	ctx.inject(["settings"], (sctx) => {
		const ns = settingsNamespace(SIDEBAR_PREFS_NS);
		const scope = sctx.settings.register(ns, PrefsSchema);
		const viewOf = () => {
			const descriptor = sctx.settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
			return descriptor === void 0 ? {
				value: void 0,
				revision: void 0
			} : {
				value: descriptor.value,
				revision: descriptor.revision
			};
		};
		settingsFace = {
			get: viewOf,
			update: async (patch, expectedRevision) => {
				await sctx.settings.update(ns, patch, expectedRevision);
				return viewOf();
			}
		};
		syncToolsGate(scope);
		scope.watch(() => {
			syncToolsGate(scope);
		});
	});
	const api = buildApi(ctx, ptyManager, agentPtyRegistry, resolved, () => settingsFace);
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/sidebar/api",
		handler: async (req, res) => {
			if (!fence(req)) {
				writeJson(res, 403, {
					ok: false,
					error: {
						code: "forbidden",
						message: "forbidden"
					}
				});
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, {
					ok: false,
					error: {
						code: "method-error",
						message: "method not allowed"
					}
				});
				return;
			}
			const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
			const method = pathname.startsWith("/sidebar/api/") ? pathname.slice(13) : void 0;
			if (method === void 0 || method.includes("/")) {
				writeError(res, new SidebarError("not-found", "unknown sidebar API method", 404));
				return;
			}
			try {
				const payload = await readJsonBody(req);
				const handler = api[method];
				if (handler === void 0) throw new SidebarError("not-found", `unknown sidebar API method "${method}"`, 404);
				writeOk(res, await handler(payload));
			} catch (error) {
				writeError(res, error);
			}
		}
	}), "dsh-better-sidebar: /sidebar/api routes");
	ctx.effect(() => registerBundleRoute(ctx, fence), "dsh-better-sidebar: /sidebar/bundle chunk route");
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/sidebar/file",
		handler: async (req, res) => {
			if (!fence(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method !== "GET") {
				res.writeHead(405);
				res.end();
				return;
			}
			try {
				const url = new URL(req.url ?? "/", "http://dsh.internal");
				const sessionId = url.searchParams.get("sessionId");
				const raw = url.searchParams.get("path");
				if (sessionId === null || raw === null) throw new SidebarError("bad-request", "sessionId and path are required");
				const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get("cwd") ?? void 0);
				const path = requireAbsolute(raw);
				if (!isWithin(cwd, path)) throw new SidebarError("fs-error", "media path outside the session working directory", 403);
				const info = await stat(path);
				if (!info.isFile() || info.size > resolved.mediaLimit) throw new SidebarError("fs-error", "not a file or too large", 400);
				const type = mediaTypeForPath(path);
				const body = await readFile(path);
				const headers = {
					"content-type": type,
					"cache-control": "no-cache"
				};
				if (url.searchParams.get("download") === "1") headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`;
				res.writeHead(200, headers);
				res.end(body);
			} catch (error) {
				writeError(res, error);
			}
		}
	}), "dsh-better-sidebar: /sidebar/file media route");
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/sidebar/html",
		handler: async (req, res) => {
			if (!fence(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method !== "GET") {
				res.writeHead(405);
				res.end();
				return;
			}
			try {
				const decoded = decodeHtmlUrl(new URL(req.url ?? "/", "http://dsh.internal").pathname);
				if (!decoded.ok) {
					writeError(res, new SidebarError("bad-request", decoded.message, decoded.status));
					return;
				}
				const { sessionId, path } = decoded.ref;
				const cwd = sessionCwdOf(ctx, sessionId);
				const absolute = requireAbsolute(path);
				if (!isWithin(cwd, absolute)) throw new SidebarError("fs-error", "html path outside the session working directory", 403);
				const info = await stat(absolute);
				if (!info.isFile() || info.size > resolved.mediaLimit) throw new SidebarError("fs-error", "not a file or too large", 400);
				const type = mediaTypeForPath(absolute);
				const body = await readFile(absolute);
				res.writeHead(200, {
					"content-type": type,
					"cache-control": "no-cache",
					"x-content-type-options": "nosniff",
					"referrer-policy": "no-referrer",
					"content-security-policy": "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'"
				});
				res.end(body);
			} catch (error) {
				writeError(res, error);
			}
		}
	}), "dsh-better-sidebar: /sidebar/html preview route");
	const wss = new WebSocketServer({ noServer: true });
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: "/sidebar/ws/terminal",
		handler: (req, socket, head) => {
			if (!fence(req)) {
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				attachTerminal(ctx, ptyManager, agentPtyRegistry, ws, req, resolved);
			});
		}
	}), "dsh-better-sidebar: terminal WebSocket");
	const agentListWss = new WebSocketServer({ noServer: true });
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: "/sidebar/ws/agent-terminals",
		handler: (req, socket, head) => {
			if (!fence(req)) {
				socket.destroy();
				return;
			}
			agentListWss.handleUpgrade(req, socket, head, (ws) => {
				attachAgentList(agentPtyRegistry, ws, req);
			});
		}
	}), "dsh-better-sidebar: agent-terminals push WebSocket");
	ctx.effect(() => () => {
		toolsDisposers?.();
		ptyManager.disposeAll();
		agentPtyRegistry.disposeAll();
		wss.close();
		agentListWss.close();
	}, "dsh-better-sidebar: teardown");
}
/** Push the live agent-terminal list for one session to a connected sidebar view. */
async function attachAgentList(registry, ws, req) {
	try {
		const sessionId = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("sessionId");
		if (sessionId === null) {
			ws.close(1008, "sessionId is required");
			return;
		}
		const send = () => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(registry.list(sessionId)));
		};
		send();
		const unsubscribe = registry.subscribe(send);
		ws.on("close", () => {
			unsubscribe();
		});
		ws.on("error", () => {
			unsubscribe();
		});
	} catch (error) {
		ws.close(1011, error instanceof Error ? error.message : String(error));
	}
}
/**
* Wire one terminal socket to its pty: replay transcript, pump both ways.
* Two attach modes share the wire protocol:
* - `?uuid=...` attaches to an agent-owned terminal (created by the
*   `terminal_create` tool). The close frame kills the pty immediately
*   (the agent's terminal closes when the user closes the sidebar tab); a
*   bare socket drop (refresh, tab switch) leaves the pty alive for the
*   reconnect grace, exactly like UI-tab terminals.
* - `?tab=...&sessionId=...` attaches to a UI-tab terminal (the user
*   created it from the + menu). The close frame schedules a 0-ms close
*   (the host's reconnect grace keeps the shell alive across a refresh).
*/
async function attachTerminal(ctx, ptyManager, agentPtyRegistry, ws, req, resolved) {
	try {
		const url = new URL(req.url ?? "/", "http://dsh.internal");
		const uuid = url.searchParams.get("uuid");
		if (uuid !== null) {
			const handle = agentPtyRegistry.get(uuid);
			if (handle === void 0) {
				ws.close(1011, `agent terminal "${uuid}" not found`);
				return;
			}
			pumpAgentTerminal(agentPtyRegistry, handle, ws);
			return;
		}
		const sessionId = url.searchParams.get("sessionId");
		const tabId = url.searchParams.get("tab");
		if (sessionId === null || tabId === null) {
			ws.close(1008, "either ?uuid or ?sessionId+?tab are required");
			return;
		}
		const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get("cwd") ?? void 0);
		const handle = ptyManager.open(sessionId, tabId, cwd, 80, 24);
		if (handle.transcript !== "") ws.send(handle.transcript);
		const onData = (data) => {
			if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4194304) ws.send(data);
		};
		const onExit = ({ exitCode }) => {
			onData(`\r\n[process exited with code ${String(exitCode)}]\r\n`);
		};
		const dataSub = handle.pty.onData(onData);
		const exitSub = handle.pty.onExit(onExit);
		ws.on("message", (data) => {
			const text = data.toString("utf8");
			let control = null;
			try {
				const parsed = JSON.parse(text);
				if (parsed !== null && typeof parsed === "object") control = parsed;
			} catch {}
			if (control !== null && control.type === "close") {
				ptyManager.scheduleClose(handle.key, 0);
				return;
			}
			if (handle.exited) return;
			if (control !== null && control.type === "resize" && typeof control.cols === "number" && typeof control.rows === "number") {
				const dims = clampDims(control.cols, control.rows);
				handle.pty.resize(dims.cols, dims.rows);
			} else handle.pty.write(text);
		});
		ws.on("close", () => {
			dataSub.dispose();
			exitSub.dispose();
			ptyManager.scheduleClose(handle.key, resolved.reconnectGraceMs);
		});
	} catch (error) {
		ws.close(1011, error instanceof Error ? error.message : String(error));
	}
}
/**
* Pump one agent terminal's pty to a connected view. The close frame kills
* the pty immediately (the agent's terminal closes when the user closes the
* sidebar tab); a bare socket drop leaves the pty alive — the agent owns
* the lifetime, and only `terminal_close`, a `{type:'close'}` frame, or
* plugin teardown kills it.
*/
function pumpAgentTerminal(registry, handle, ws) {
	if (handle.transcript !== "") ws.send(handle.transcript);
	const onData = (data) => {
		if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4194304) ws.send(data);
	};
	const onExit = ({ exitCode }) => {
		onData(`\r\n[process exited with code ${String(exitCode)}]\r\n`);
	};
	const dataSub = handle.pty.onData(onData);
	const exitSub = handle.pty.onExit(onExit);
	ws.on("message", (data) => {
		if (handle.exited) return;
		const text = data.toString("utf8");
		let control = null;
		try {
			const parsed = JSON.parse(text);
			if (parsed !== null && typeof parsed === "object") control = parsed;
		} catch {}
		if (control !== null && control.type === "close") {
			registry.close(handle.uuid);
			return;
		}
		if (control !== null && control.type === "resize" && typeof control.cols === "number" && typeof control.rows === "number") {
			const dims = clampDims(control.cols, control.rows);
			handle.pty.resize(dims.cols, dims.rows);
		} else if (control === null) handle.pty.write(text);
	});
	ws.on("close", () => {
		dataSub.dispose();
		exitSub.dispose();
	});
}
//#endregion
export { Config, apply, inject, mediaTypeForPath, name };
