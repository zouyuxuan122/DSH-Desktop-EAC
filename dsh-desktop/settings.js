'use strict';

// 应用设置存储（<userData>/settings.json）。
//
// 端口、托盘、余额价格、更新跳过状态等全应用设置都读写这里。此前这组
// 函数住在 updater.js 里，导致「agent 自更新引擎」与「全局设置存储」耦合
// 在一起（改余额价格显示也要碰更新器）；剥离为独立模块后，updater.js
// 只保留更新逻辑，其余模块按需引用。

const path = require('node:path');
const fs = require('node:fs');

const CURRENT_SCHEMA_VERSION = 1;
const EXIT_ACTIONS = new Set(['ask', 'minimize', 'quit']);
const SHORTCUT_POLICIES = new Set(['auto', 'never']);

/**
 * settings 模块的运行上下文（main.js 注入）。
 * @typedef {object} SettingsCtx
 * @property {string} userDataDir
 * @property {(tag: string, message: string) => void} [log]
 */

/**
 * 应用设置对象（已知字段具名 + 未知历史字段透传）。
 * @typedef {Record<string, unknown> & {
 *   schemaVersion?: number,
 *   exitAction?: string,
 *   closeToTray?: boolean,
 *   notifyOnTurnEnd?: boolean,
 *   shareWebProfile?: boolean,
 *   shortcutPolicy?: string,
 *   webPort?: number
 * }} SettingsShape
 */

/**
 * @param {SettingsCtx} ctx
 * @returns {string}
 */
function settingsPath(ctx) { return path.join(ctx.userDataDir, 'settings.json'); }

/**
 * @param {SettingsCtx | null | undefined} ctx
 * @param {string} message
 */
function logSettings(ctx, message) {
  try {
    if (ctx && typeof ctx.log === 'function') ctx.log('settings', message);
  } catch {
    // Logging must not make settings recovery fail.
  }
}

/** @returns {SettingsShape} */
function defaultSettings() {
  return { schemaVersion: CURRENT_SCHEMA_VERSION };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {SettingsShape}
 */
function migrateSettings(value) {
  const input = isPlainObject(value) ? value : {};
  /** @type {SettingsShape} */
  const settings = { ...input };
  // typeof 守卫保持「非整数视为 0」的原语义，同时让 TS 收窄类型。
  const rawVersion = settings.schemaVersion;
  const version = (typeof rawVersion === 'number' && Number.isInteger(rawVersion)) ? rawVersion : 0;

  // Version 0 only had closeToTray. Keep the legacy field for older desktop
  // versions, but make the new three-state field canonical for this version.
  if ((!settings.exitAction || !EXIT_ACTIONS.has(settings.exitAction) || version < 1) &&
      typeof settings.closeToTray === 'boolean') {
    settings.exitAction = settings.closeToTray ? 'minimize' : 'quit';
  }
  settings.schemaVersion = CURRENT_SCHEMA_VERSION;
  return validateSettings(settings);
}

/**
 * @param {SettingsShape} value
 * @returns {SettingsShape}
 */
function validateSettings(value) {
  const settings = { ...value };
  if (typeof settings.schemaVersion !== 'number' ||
      !Number.isInteger(settings.schemaVersion) || settings.schemaVersion < 1) {
    settings.schemaVersion = CURRENT_SCHEMA_VERSION;
  }

  if (settings.exitAction != null && !EXIT_ACTIONS.has(settings.exitAction)) {
    delete settings.exitAction;
  }
  if (settings.closeToTray != null && typeof settings.closeToTray !== 'boolean') {
    delete settings.closeToTray;
  }
  if (settings.notifyOnTurnEnd != null && typeof settings.notifyOnTurnEnd !== 'boolean') {
    delete settings.notifyOnTurnEnd;
  }
  if (settings.shareWebProfile != null && typeof settings.shareWebProfile !== 'boolean') {
    delete settings.shareWebProfile;
  }
  if (settings.shortcutPolicy != null && !SHORTCUT_POLICIES.has(settings.shortcutPolicy)) {
    delete settings.shortcutPolicy;
  }
  if (settings.webPort != null &&
      (!Number.isInteger(settings.webPort) || settings.webPort < 0 || settings.webPort > 65535)) {
    delete settings.webPort;
  }
  return settings;
}

/** @param {SettingsCtx} ctx */
function settingsTempPrefix(ctx) {
  return path.basename(settingsPath(ctx)) + '.tmp-';
}

/**
 * @param {SettingsCtx} ctx
 * @param {string} target
 * @returns {SettingsShape | null}
 */
function recoverInterruptedWrite(ctx, target) {
  if (fs.existsSync(target)) return null;
  let candidates;
  try {
    candidates = fs.readdirSync(path.dirname(target))
      .filter((name) => name.startsWith(settingsTempPrefix(ctx)))
      .map((name) => path.join(path.dirname(target), name))
      .filter((file) => fs.statSync(file).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!isPlainObject(parsed)) continue;
      fs.renameSync(candidate, target);
      logSettings(ctx, '已从中断写入临时文件恢复 settings.json');
      return parsed;
    } catch {
      // Leave an invalid temp file for diagnostics; a later save can clean it.
    }
  }
  return null;
}

/**
 * @param {SettingsCtx} ctx
 * @param {string} target
 * @returns {string | null}
 */
function preserveCorruptSettings(ctx, target) {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const evidence = `${target}.corrupt-${suffix}.json`;
  try {
    fs.copyFileSync(target, evidence);
    logSettings(ctx, `settings.json 损坏，原文件已保留: ${evidence}`);
    return evidence;
  } catch (err) {
    logSettings(ctx, `settings.json 损坏且无法保留原文件: ${(/** @type {Error} */ (err)).message}`);
    return null;
  }
}

/**
 * @param {SettingsCtx} ctx
 * @returns {SettingsShape}
 */
function loadSettings(ctx) {
  const target = settingsPath(ctx);
  try {
    const recovered = recoverInterruptedWrite(ctx, target);
    if (recovered) return migrateSettings(recovered);
    if (!fs.existsSync(target)) return defaultSettings();
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error('settings.json 顶层必须是对象');
    return migrateSettings(parsed);
  } catch (err) {
    if (fs.existsSync(target)) preserveCorruptSettings(ctx, target);
    logSettings(ctx, `加载 settings 失败，使用默认设置: ${(/** @type {Error} */ (err)).message}`);
    return defaultSettings();
  }
}

/**
 * @param {SettingsCtx} ctx
 * @param {SettingsShape} s
 * @returns {boolean}
 */
function saveSettings(ctx, s) {
  const target = settingsPath(ctx);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let backup = null;
  try {
    const settings = migrateSettings(s);
    const content = JSON.stringify(settings, null, 2) + '\n';
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeSync(fd, content, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // POSIX rename replaces atomically. Windows does not allow rename over an
    // existing file, so move the old file aside and restore it if replacement
    // fails; both files remain in the same directory/filesystem.
    if (process.platform === 'win32' && fs.existsSync(target)) {
      backup = `${target}.bak-${process.pid}-${Date.now()}`;
      fs.renameSync(target, backup);
    }
    fs.renameSync(temp, target);
    if (backup) fs.rmSync(backup, { force: true });
    return true;
  } catch (err) {
    try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch {}
    if (backup && !fs.existsSync(target) && fs.existsSync(backup)) {
      try { fs.renameSync(backup, target); } catch (rollbackErr) {
        logSettings(ctx, `保存 settings 失败且回滚失败: ${(/** @type {Error} */ (rollbackErr)).message}`);
      }
    }
    logSettings(ctx, '保存 settings 失败: ' + (/** @type {Error} */ (err)).message);
    return false;
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  defaultSettings,
  settingsPath,
  loadSettings,
  saveSettings,
  migrateSettings,
  validateSettings,
};
