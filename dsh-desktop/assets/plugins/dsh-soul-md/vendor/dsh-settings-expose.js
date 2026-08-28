/**
 * dsh-host-apiproxy exposes only namespaces listed in its hard-coded
 * WEB_SETTINGS_NAMESPACES allowlist to the Web settings client. A namespace
 * registered by a third-party plugin answers `settings-not-exposed` even
 * though it is registered — upstream explicitly defers letting plugins
 * expose their own configuration.
 *
 * This module idempotently patches that allowlist in the dsh installation
 * actually loaded by the host process, so the plugin's settings section
 * becomes visible in the Web UI without manual edits. A dsh update
 * overwrites the file; the next plugin start re-patches it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

/**
 * Ensure `nsName` is present in dsh-host-apiproxy's WEB_SETTINGS_NAMESPACES.
 * No-op when already exposed or when the file cannot be located/patched.
 * @param {import("cordis").Context} ctx
 * @param {string} nsName - settings namespace short name (e.g. "soul-md").
 * @param {{info?: Function, warn?: Function}} logger - dsh logger.
 */
export function ensureSettingsNamespaceExposed(ctx, nsName, logger) {
  void ctx;
  try {
    const target = findApiproxyIndex();
    if (!target) {
      logger?.warn?.(`[settings-expose] could not locate dsh-host-apiproxy; add "${nsName}" to WEB_SETTINGS_NAMESPACES in dsh-host-apiproxy/lib/index.js to get a Web settings section`);
      return;
    }
    let src;
    try {
      src = readFileSync(target, "utf8");
    } catch (error) {
      logger?.warn?.(`[settings-expose] cannot read ${target}: ${String(error)}`);
      return;
    }
    const body = src.match(/const WEB_SETTINGS_NAMESPACES = \[([\s\S]*?)\];/)?.[1] ?? "";
    if (body.includes(`"${nsName}"`)) return; // already exposed (manual or previous patch)
    const patched = src.replace(/(const WEB_SETTINGS_NAMESPACES = \[[\s\S]*?)(\n\s*\];)/, (_, pre, post) => {
      const trailingComma = /,\s*$/.test(pre) ? "" : ",";
      const sep2 = pre.trimEnd().endsWith("[") ? "" : trailingComma;
      return `${pre}${sep2}\n\t"${nsName}"${post}`;
    });
    if (patched === src) {
      logger?.warn?.(`[settings-expose] allowlist pattern not found in ${target}; add "${nsName}" to WEB_SETTINGS_NAMESPACES manually`);
      return;
    }
    writeFileSync(target, patched, "utf8");
    logger?.info?.(`[settings-expose] added "${nsName}" to WEB_SETTINGS_NAMESPACES (${target}) — restart dsh web for the settings section to appear`);
  } catch (error) {
    logger?.warn?.(`[settings-expose] failed: ${String(error)}`);
  }
}

function findApiproxyIndex() {
  // 1) The host process has already loaded dsh-host-apiproxy: read the real
  //    module path from the CommonJS module cache (any install layout).
  try {
    const Module = createRequire(import.meta.url)("module");
    const cache = Module._cache ?? {};
    for (const key of Object.keys(cache)) {
      if (key.includes(`${sep}dsh-host-apiproxy${sep}`) && key.endsWith(`${sep}index.js`)) return key;
    }
  } catch { /* fall through */ }
  // 2) Fallback: sibling of @deepseek-ai/dsh-settings (dsh's nested layout).
  try {
    const require = createRequire(import.meta.url);
    const settingsEntry = require.resolve("@deepseek-ai/dsh-settings");
    const candidate = join(dirname(dirname(dirname(settingsEntry))), "dsh-host-apiproxy", "lib", "index.js");
    if (existsSync(candidate)) return candidate;
  } catch { /* fall through */ }
  return "";
}
