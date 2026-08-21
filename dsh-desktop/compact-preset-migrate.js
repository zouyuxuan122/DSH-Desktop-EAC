'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const OLD_ENGINE = '@deepseek-ai/dsh-compaction-basic';
const NEW_ENGINE = 'dsh-compact/engine';
const MANAGED_PRESETS = Object.freeze([
  'anchored-standard',
  'router-standard',
  'v4-flash-godmode-opencode-go',
  'warmupbetter',
  'warmupbetter-replay',
  'whoami-standard',
  'zero-anchored-standard',
]);

function replaceCompactionEngine(text) {
  if (typeof text !== 'string' || text === '') return { text, changed: false };
  const lines = text.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*-\s*id:\s*compaction-basic\s*(?:#.*)?$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[ \t]*-\s*id:/.test(lines[j])) break;
      const match = /^([ \t]*name:\s*)(['"])@deepseek-ai\/dsh-compaction-basic\2(\s*(?:#.*)?)$/.exec(lines[j]);
      if (!match) continue;
      lines[j] = `${match[1]}${match[2]}${NEW_ENGINE}${match[2]}${match[3]}`;
      changed = true;
      break;
    }
  }
  return { text: changed ? lines.join(text.includes('\r\n') ? '\r\n' : '\n') : text, changed };
}

function migratePresetFile(file, log = () => {}) {
  let before;
  try { before = fs.readFileSync(file, 'utf8'); } catch { return { status: 'missing', file }; }
  try { yaml.load(before); } catch (error) {
    log(`跳过无法解析的 preset: ${file}: ${error.message}`);
    return { status: 'invalid', file, error: error.message };
  }
  const replaced = replaceCompactionEngine(before);
  if (!replaced.changed) return { status: 'kept', file };
  try { yaml.load(replaced.text); } catch (error) {
    log(`跳过迁移后无法解析的 preset: ${file}: ${error.message}`);
    return { status: 'invalid-result', file, error: error.message };
  }
  const backup = file + '.bak';
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    const temp = file + `.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, replaced.text, 'utf8');
    fs.renameSync(temp, file);
    return { status: 'migrated', file, backup };
  } catch (error) {
    log(`迁移 preset 失败: ${file}: ${error.message}`);
    return { status: 'failed', file, error: error.message };
  }
}

function migrateManagedCompactPresets(presetsRoot, log = () => {}) {
  return MANAGED_PRESETS.map((name) => migratePresetFile(
    path.join(presetsRoot, name, 'agent.cordis.yml'),
    log,
  ));
}

module.exports = {
  MANAGED_PRESETS,
  NEW_ENGINE,
  OLD_ENGINE,
  migrateManagedCompactPresets,
  migratePresetFile,
  replaceCompactionEngine,
};
