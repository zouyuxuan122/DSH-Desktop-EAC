import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { buildMigrationPrompt, resolvePersonaPath } from "./logic.js";

/**
 * dsh-easy-setup — host half.
 *
 * Runs inside the `dsh web` process and exposes the `easySetup` Typert
 * Remote the settings page drives:
 *
 *   - readPersona / writePersona — edit the soul.md the dsh-soul-md plugin
 *     renders (path resolved exactly like the plugin does: settings.yaml
 *     user overlay → cordis.patch.yml composition layer → <home>/soul.md).
 *     Writes land on disk; the plugin's watcher hot-reloads the section.
 *   - migrationPrompt — the instruction the one-click migration flow copies
 *     into a fresh session whose workspace is a Codex / Claude Code folder.
 *
 * Same strict-descriptor registration as dsh-plugin-marketplace: the
 * companion copy is not the same module instance as the host's typert
 * packages, so SRC markers stay invisible across instances and the endpoint
 * must be registered into the host-side typert local store explicitly.
 */

const REMOTE_PACKAGE = "@deepseek-ai/dsh-easy-setup";

const looseCodec = () => ({
	mode: "strict",
	typeSymbol: "@deepseek-ai/dsh-easy-setup/types#Json",
	schema: { parse: (value) => value }
});
const descriptor = (method, parameters) => ({
	id: `@deepseek-ai/dsh-easy-setup#easySetup/${method}`,
	service: "easySetup",
	namespace: "easySetup",
	method,
	invocation: { kind: "direct" },
	parameters: parameters.map((name) => ({ name, wire: name, source: "json", codec: looseCodec() })),
	result: looseCodec()
});
const REMOTE_INVOCATIONS = [
	descriptor("readPersona", []),
	descriptor("writePersona", ["content"]),
	descriptor("migrationPrompt", []),
	descriptor("listCards", []),
	descriptor("saveCard", ["name", "content"]),
	descriptor("deleteCard", ["name"])
];

/** The harness home the host booted with (same rule dsh itself uses). */
function homeDir() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function readText(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** The soul.md path, resolved through the same layers dsh-soul-md reads. */
function personaPath() {
	const home = homeDir();
	return resolvePersonaPath({
		home,
		settingsText: readText(join(home, "settings.yaml")),
		patchText: readText(join(home, "profiles", "web", "cordis.patch.yml"))
	});
}

/** Saved persona-card library: <home>/persona-cards/*.md, name from filename. */
function cardsDir() {
	return join(homeDir(), "persona-cards");
}

const CARD_NAME_RE = /^[\w\-. \u4e00-\u9fa5]{1,40}$/;

class EasySetupGateway extends TypertRemoteService {
	static inject = ["typert"];

	constructor(ctx) {
		super(ctx, "easySetup");
		for (const name of ["readPersona", "writePersona", "migrationPrompt", "listCards", "saveCard", "deleteCard"]) {
			const decorator = Remote(name);
			decorator(EasySetupGateway.prototype[name], {
				name,
				private: false,
				static: false,
				addInitializer: (initializer) => initializer.call(this)
			});
		}
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
				ctx.logger?.warn?.("dsh-easy-setup: typert local registration failed: " + String((error && error.message) || error));
			}
		}
	}

	/** Current persona card: path + contents (empty when the file is absent). */
	readPersona() {
		const path = personaPath();
		const exists = existsSync(path);
		return { ok: true, path, exists, content: exists ? readText(path) : "" };
	}

	/**
	 * Overwrite the persona card. Creates parent directories on demand so a
	 * first-time persona (or a path configured before any file existed)
	 * saves without friction; dsh-soul-md hot-reloads it within ~300ms.
	 */
	writePersona(content) {
		const text = String(content ?? "");
		const path = personaPath();
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text, "utf8");
			return { ok: true, path, bytes: Buffer.byteLength(text, "utf8") };
		} catch (error) {
			return { ok: false, path, error: String((error && error.message) || error) };
		}
	}

	/** The ready-made instruction for the one-click migration session. */
	migrationPrompt() {
		return { ok: true, prompt: buildMigrationPrompt({ home: homeDir() }) };
	}

	/** Saved cards: [{ name, file, content }], newest first. */
	listCards() {
		const dir = cardsDir();
		const cards = [];
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const file = join(dir, entry.name);
				cards.push({
					name: entry.name.replace(/\.md$/, ""),
					file,
					mtime: statSync(file).mtimeMs,
					content: readText(file).slice(0, 20000)
				});
			}
			cards.sort((a, b) => b.mtime - a.mtime);
		} catch { /* 目录不存在 → 空列表 */ }
		return { ok: true, cards };
	}

	/** Save (create/overwrite) a named card in the library. */
	saveCard(name, content) {
		const n = String(name ?? "").trim();
		if (!CARD_NAME_RE.test(n)) return { ok: false, error: "bad card name" };
		const text = String(content ?? "");
		try {
			mkdirSync(cardsDir(), { recursive: true });
			const file = join(cardsDir(), n.replace(/[\\/:*?"<>|]/g, "_") + ".md");
			writeFileSync(file, text, "utf8");
			return { ok: true, file };
		} catch (error) {
			return { ok: false, error: String((error && error.message) || error) };
		}
	}

	/** Remove a named card from the library (never touches the live soul.md). */
	deleteCard(name) {
		const n = String(name ?? "").trim();
		if (!CARD_NAME_RE.test(n)) return { ok: false, error: "bad card name" };
		try {
			const file = join(cardsDir(), n.replace(/[\\/:*?"<>|]/g, "_") + ".md");
			if (!existsSync(file)) return { ok: false, error: "not found" };
			rmSync(file);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: String((error && error.message) || error) };
		}
	}
}

export function apply(ctx) {
	ctx.plugin(EasySetupGateway);
}
