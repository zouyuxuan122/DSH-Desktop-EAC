/**
 * dsh-soul-md — soul.md-style persona injection for DeepSeek Harness.
 *
 * Reads a markdown persona card (soul.md) and registers it as the
 * `soul:persona` system-prompt section (order 0 by default), so the agent
 * keeps roleplaying through the card while working normally. The section is
 * registered on the GLOBAL prompt layer, so every agent in the process sees
 * it; unlike `dsh-persona` this row is NOT scope-only, and it never collides
 * with the deployment persona because it uses its own section name.
 *
 * The file is re-read on change (default: fs.watch + 300ms debounce), and the
 * section is re-registered so edits to soul.md reach the next assembled
 * prompt without a restart. `{{model}}` / `{{cwd}}` style prompt variables
 * are resolved at render time like any other section text.
 *
 * Configuration is settings-backed: the composition entry stays the base
 * layer and a registered `soul-md` settings section (Web UI section,
 * settings.yaml) overlays it live, hot-applying without a restart.
 */
import { readFileSync, watch } from "node:fs";
import { isAbsolute, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { ensureSettingsNamespaceExposed } from "./vendor/dsh-settings-expose.js";

/** Cordis plugin name. */
const name = "soul-md";
/** The prompt registry this row contributes to. */
const inject = ["systemPrompt"];
/** Settings namespace owned by this plugin (Web UI settings section). */
const NS = settingsNamespace("soul-md");

/** Section name; deliberately distinct from the registry-owned `deployment:persona`. */
const SECTION_NAME = "soul:persona";

/** Runtime schema for the soul-md row. */
const Config = z.object({
  /**
   * Path to the soul.md persona card. Absolute, or relative to the dsh home.
   * Defaults to "<dsh home>/soul.md": when the file is missing the row falls
   * back to empty text and registers NO prompt section, so the stock official
   * system prompt is used untouched. MUST keep a default — a required field
   * with no default fails config validation when the profile patch row
   * carries no config, which takes down the whole plugin tree (dsh web exits
   * with code 1, the app shows "启动失败").
   */
  path: z.string().default("soul.md"),
  /** Text used when the file is missing or unreadable. Empty means no section. */
  fallback: z.string().default(""),
  /** Prompt section order; 0 renders right after the deployment persona slot. */
  order: z.number().default(0),
  /** Treat the rendered card as the complete system prompt (advanced). */
  complete: z.boolean().default(false),
  /** Hot-reload the section when the file changes. */
  watch: z.boolean().default(true),
  /** Debounce for file-change reloads, in milliseconds. */
  debounceMs: z.number().default(300),
});

function apply(ctx, config) {
  let current = config;
  let active = null;
  let timer = undefined;
  let watcher = undefined;

  const fileOf = () =>
    isAbsolute(current.path) ? current.path : join(resolveDshHome(), current.path);

  const register = (text) => {
    if (active) {
      // systemPrompt.section() returns the Cordis effect DISPOSER (a
      // function), not an object — call it, don't call .dispose() on it.
      active();
      active = null;
    }
    if (text) {
      active = ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: current.order,
        text,
        ...(current.complete ? { complete: true } : {}),
      });
    }
  };

  const refresh = () => {
    let text;
    try {
      text = readFileSync(fileOf(), "utf8");
    } catch {
      text = current.fallback;
    }
    register(text);
  };

  const stopWatch = () => {
    clearTimeout(timer);
    timer = undefined;
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
      watcher = undefined;
    }
  };

  const startWatch = () => {
    stopWatch();
    if (!current.watch) return;
    try {
      watcher = watch(fileOf(), { persistent: false }, () => {
        clearTimeout(timer);
        timer = setTimeout(refresh, current.debounceMs);
      });
    } catch {
      // File missing at startup: the fallback is registered; reloads are best-effort.
    }
  };

  ctx.effect(() => {
    refresh();
    startWatch();
    return () => {
      stopWatch();
      if (active) {
        active(); // disposer function, not an object
        active = null;
      }
    };
  }, "soul-md.section()");

  // ── settings-backed configuration ─────────────────────────────────────────
  // NOTE: `installSettingsSection` hands `setSource` a GETTER
  // (`() => scope.get()`), not the config object. Keep it and re-read it on
  // settings change, so `current.*` below always sees resolved values and
  // hot-reloads (watch) keep working.
  let sourceGetter = null;
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (getter) => {
      sourceGetter = getter;
    },
    onChange: () => {
      try {
        if (sourceGetter) current = sourceGetter();
        refresh();
        startWatch();
      } catch (error) {
        ctx.logger.warn(`[soul-md] settings change refresh failed: ${String(error)}`);
      }
    },
  });

  // dsh-host-apiproxy hard-codes which settings namespaces the Web client may
  // see; without this, the settings section answers `settings-not-exposed`
  // on any stock install. Patch the allowlist idempotently (self-heals after
  // dsh updates overwrite the file).
  ensureSettingsNamespaceExposed(ctx, "soul-md", ctx.logger);
}

export { Config, NS, SECTION_NAME, apply, inject, name };
