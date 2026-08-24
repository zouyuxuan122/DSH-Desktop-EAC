#!/usr/bin/env node

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  COMPAT_MATRIX,
  compareVersions,
  findCompatEntry,
  formatRange,
} from "./lib/compat.mjs";

const PLUGIN_SPEC = "@tencent-weixin/openclaw-weixin";
const CHANNEL_ID = "openclaw-weixin";
/** Only OpenClaw 2026.3.22–2026.3.23 need node_modules/openclaw symlink for jiti. */
const SYMLINK_OPENCLAW_MIN = "2026.3.22";
const SYMLINK_OPENCLAW_MAX = "2026.3.23";
/**
 * OpenClaw 2026.5.2 到 2026.5.12 之前的版本里，channel-catalog-registry 调
 * discoverOpenClawPlugins 时漏传 installRecords，导致 npm 装的第三方插件
 * 不被 CLI catalog 收录（`channels add/login` 报 Unsupported channel）。
 * 我们通过把 plugin 同时软链到 ~/.openclaw/extensions/<id> 让它走 global
 * 发现路径，绕开 ledger。OpenClaw 2026.5.12 已修复 channel 识别问题。
 */
const EXT_SYMLINK_OPENCLAW_MIN = "2026.5.2";
const EXT_SYMLINK_OPENCLAW_MAX = "2026.5.12";

const LEGACY_TAG_ALIASES = {
  legacy: "compat-host-gte2026.3.0-lt2026.3.22",
};

const COMPAT_MATRIX_DIST_TAG_PAD = Math.max(...COMPAT_MATRIX.map((e) => e.distTag.length));

// ── helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`\x1b[36m[openclaw-weixin]\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m[openclaw-weixin]\x1b[0m ${msg}`);
}

function run(cmd, { silent = true } = {}) {
  const stdio = silent ? ["pipe", "pipe", "pipe"] : "inherit";
  const result = spawnSync(cmd, { shell: true, stdio });
  if (result.status !== 0) {
    const err = new Error(`Command failed with exit code ${result.status}: ${cmd}`);
    err.stderr = silent ? (result.stderr || "").toString() : "";
    throw err;
  }
  return silent ? (result.stdout || "").toString().trim() : "";
}

function which(bin) {
  const cmd = process.platform === "win32" ? `where ${bin}` : `which ${bin}`;
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

// ── version detection ───────────────────────────────────────────────────────

function getOpenclawVersion() {
  try {
    const raw = run("openclaw --version");
    const match = raw.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function selectPluginTag(openclawVersion) {
  const entry = findCompatEntry(openclawVersion);
  if (entry) return entry;

  error(`当前 OpenClaw 版本 ${openclawVersion} 不在任何已知兼容范围内`);
  console.log("\n  已知兼容矩阵:");
  for (const e of COMPAT_MATRIX) {
    console.log(
      `    ${e.distTag.padEnd(COMPAT_MATRIX_DIST_TAG_PAD)}  OpenClaw ${formatRange(e.openclawRange)}`,
    );
  }
  console.log();
  return null;
}

// ── symlink ──────────────────────────────────────────────────────────────────

/**
 * Resolve the host openclaw package root from the `openclaw` binary.
 * e.g. /Users/x/.nvm/versions/node/v22/lib/node_modules/openclaw
 */
function resolveHostOpenclawRoot() {
  const bin = which("openclaw");
  if (!bin) return null;
  try {
    // Follow symlinks to the real binary, then go up to the package root.
    const real = fs.realpathSync(bin);
    // binary is at <root>/openclaw.mjs or <root>/dist/index.js etc.
    // Walk up until we find a package.json with name "openclaw".
    let dir = path.dirname(real);
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
        if (pkg.name === "openclaw") return dir;
      } catch {}
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

/**
 * Resolve the plugin extensions directory.
 * Default: ~/.openclaw/extensions/openclaw-weixin
 */
function resolvePluginExtDir() {
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "extensions", "openclaw-weixin");
}

/**
 * Create a symlink from the plugin's node_modules/openclaw to the host
 * openclaw package root. This lets jiti resolve openclaw/plugin-sdk/*
 * without openclaw being a runtime dependency.
 */
function hostVersionNeedsOpenclawSymlink(hostVersion) {
  if (!hostVersion) return false;
  const geMin = compareVersions(hostVersion, SYMLINK_OPENCLAW_MIN);
  const leMax = compareVersions(hostVersion, SYMLINK_OPENCLAW_MAX);
  return (
    !Number.isNaN(geMin) &&
    !Number.isNaN(leMax) &&
    geMin >= 0 &&
    leMax <= 0
  );
}

function ensureOpenclawSymlink(hostVersion) {
  if (!hostVersionNeedsOpenclawSymlink(hostVersion)) {
    return;
  }

  const hostRoot = resolveHostOpenclawRoot();
  if (!hostRoot) {
    error("无法定位宿主 openclaw 包根目录，跳过 symlink 创建");
    return;
  }

  const pluginDir = resolvePluginExtDir();
  if (!fs.existsSync(pluginDir)) {
    // Plugin not in extensions dir (might be a -l link install); skip.
    return;
  }

  const nmDir = path.join(pluginDir, "node_modules");
  const linkPath = path.join(nmDir, "openclaw");

  // Check if already correct
  try {
    const existing = fs.readlinkSync(linkPath);
    if (fs.realpathSync(existing) === fs.realpathSync(hostRoot)) {
      return;
    }
    // Wrong target — remove and recreate
    fs.unlinkSync(linkPath);
  } catch {
    // Not a symlink or doesn't exist — fine
  }

  fs.mkdirSync(nmDir, { recursive: true });
  fs.symlinkSync(hostRoot, linkPath);
  log(`已创建 symlink: node_modules/openclaw → ${hostRoot}`);
}

// ── extensions symlink (host 5.2 catalog bug workaround) ────────────────────

function hostVersionNeedsExtSymlink(hostVersion) {
  if (!hostVersion) return false;
  const geMin = compareVersions(hostVersion, EXT_SYMLINK_OPENCLAW_MIN);
  const ltMax = compareVersions(hostVersion, EXT_SYMLINK_OPENCLAW_MAX);
  return (
    !Number.isNaN(geMin) &&
    !Number.isNaN(ltMax) &&
    geMin >= 0 &&
    ltMax < 0
  );
}

function resolveNpmInstalledPluginRoot() {
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  const dir = path.join(stateDir, "npm", "node_modules", PLUGIN_SPEC);
  try {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  } catch {}
  return null;
}

/**
 * Make ~/.openclaw/extensions/openclaw-weixin a symlink pointing to the
 * npm-installed plugin root.  This lets host 5.2's CLI catalog (which scans
 * the global extensions root) discover the plugin even though
 * channel-catalog-registry forgets to forward installRecords to discovery.
 */
function ensurePluginExtSymlink(hostVersion) {
  if (!hostVersionNeedsExtSymlink(hostVersion)) {
    return;
  }

  const npmRoot = resolveNpmInstalledPluginRoot();
  if (!npmRoot) {
    return;
  }

  const linkPath = resolvePluginExtDir();
  let linkDirReal;
  try {
    linkDirReal = fs.realpathSync(npmRoot);
  } catch {
    return;
  }

  // Already correct?
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const existingReal = fs.realpathSync(linkPath);
      if (existingReal === linkDirReal) return;
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // doesn't exist — fine
  }

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(npmRoot, linkPath, "dir");
    log(`已创建 symlink: extensions/${CHANNEL_ID} → ${npmRoot}`);
  } catch (err) {
    error(
      `创建 extensions symlink 失败 (${err?.message ?? err})；CLI 可能仍会报 Unsupported channel。`,
    );
  }
}

// ── installed plugin detection ───────────────────────────────────────────────

/**
 * Read the openclaw config and return the dist-tag that was used to install
 * the plugin.  OpenClaw stores `plugins.installs.<id>.spec` as the raw
 * install spec (e.g. "@tencent/openclaw-weixin@latest").  We extract the
 * trailing tag/version after the last "@".
 * Returns the tag string, or null if not installed / unreadable.
 */
function getInstalledPluginTag() {
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const spec = config?.plugins?.installs?.[CHANNEL_ID]?.spec;
    if (!spec) return null;
    const atIdx = spec.lastIndexOf("@");
    const raw = atIdx > 0 ? spec.slice(atIdx + 1) : "latest";
    return LEGACY_TAG_ALIASES[raw] || raw;
  } catch {
    return null;
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

function install() {
  // 1. Check openclaw is installed
  if (!which("openclaw")) {
    error("未找到 openclaw，请先安装：");
    console.log("  npm install -g openclaw");
    console.log("  详见 https://docs.openclaw.ai/install");
    process.exit(1);
  }
  log("已找到本地安装的 openclaw");

  // 2. Detect host version and select compatible plugin
  const hostVersion = getOpenclawVersion();
  if (!hostVersion) {
    error("无法获取 openclaw 版本号，请确认 `openclaw --version` 正常工作");
    process.exit(1);
  }
  log(`检测到 OpenClaw 版本: ${hostVersion}`);

  const compat = selectPluginTag(hostVersion);
  if (!compat) {
    process.exit(1);
  }

  const pluginInstallSpec = `${PLUGIN_SPEC}@${compat.distTag}`;
  log(`匹配 dist-tag: ${compat.distTag}`);

  // 3. If already installed with a different dist-tag, uninstall first
  //    so the fresh install picks up the correct dist-tag.
  //    If the installed spec is a pinned version number, skip entirely.
  const installedTag = getInstalledPluginTag();
  if (installedTag !== null && /^\d+\.\d+\.\d+/.test(installedTag)) {
    log(`本地已安装插件为固定版本 ${installedTag}，跳过升级`);
    return;
  }
  if (installedTag !== null && installedTag !== compat.distTag) {
    log(`本地已安装插件为 @${installedTag}，与目标 @${compat.distTag} 不一致，先卸载旧版本...`);
    try {
      run(`echo y | openclaw plugins uninstall "${CHANNEL_ID}"`);
      log("旧版本已卸载");
    } catch (uninstallErr) {
      error("旧版本卸载失败，请手动执行：");
      if (uninstallErr.stderr) console.error(uninstallErr.stderr);
      console.log(`  openclaw plugins uninstall "${CHANNEL_ID}"`);
      process.exit(1);
    }
  }

  // 4. Install plugin via openclaw
  log(`正在安装插件 ${pluginInstallSpec}...`);
  try {
    const installOut = run(`openclaw plugins install "${pluginInstallSpec}"`);
    if (installOut) log(installOut);
  } catch (installErr) {
    if (installErr.stderr && installErr.stderr.includes("already exists")) {
      log("检测到本地已安装，正在更新...");
      try {
        const updateOut = run(`openclaw plugins update "${CHANNEL_ID}"`);
        if (updateOut) log(updateOut);
      } catch (updateErr) {
        error("插件更新失败，请手动执行：");
        if (updateErr.stderr) console.error(updateErr.stderr);
        console.log(`  openclaw plugins update "${CHANNEL_ID}"`);
        process.exit(1);
      }
    } else {
      error("插件安装失败，请手动执行：");
      if (installErr.stderr) console.error(installErr.stderr);
      console.log(`  openclaw plugins install "${pluginInstallSpec}"`);
      process.exit(1);
    }
  }

  // 5. Symlink host openclaw into plugin's node_modules (2026.3.22–2026.3.23 only)
  //    so jiti can resolve openclaw/plugin-sdk/* without a runtime dependency.
  ensureOpenclawSymlink(hostVersion);

  // 5b. Symlink npm-installed plugin into ~/.openclaw/extensions/<id>
  //     (>=2026.5.2 <2026.5.12) so the CLI catalog can discover this channel despite
  //     the channel-catalog-registry installRecords bug.
  ensurePluginExtSymlink(hostVersion);

  // 6. Login (interactive QR scan)
  log("插件就绪，开始首次连接...");
  try {
    run(`openclaw channels login --channel ${CHANNEL_ID}`, { silent: false });
  } catch {
    console.log();
    error("首次连接未完成，可稍后手动重试：");
    console.log(`  openclaw channels login --channel ${CHANNEL_ID}`);
  }

  // 7. Restart gateway so it picks up the new account
  log("正在重启 OpenClaw Gateway...");
  try {
    run(`openclaw gateway restart`, { silent: false });
  } catch {
    error("重启失败，可手动执行：");
    console.log(`  openclaw gateway restart`);
  }
}

function help() {
  console.log(`
  用法: npx -y @tencent-weixin/openclaw-weixin-cli <命令>

  命令:
    install   自动检测 OpenClaw 版本，安装兼容的微信插件并扫码连接
    help      显示帮助信息

  兼容矩阵:`);
  for (const e of COMPAT_MATRIX) {
    console.log(
      `    ${e.distTag.padEnd(COMPAT_MATRIX_DIST_TAG_PAD)}  OpenClaw ${formatRange(e.openclawRange)}`,
    );
  }
  console.log();
}

// ── main ─────────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "install":
    install();
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    if (command) {
      error(`未知命令: ${command}`);
    }
    help();
    process.exit(command ? 1 : 0);
}
