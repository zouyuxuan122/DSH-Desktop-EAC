'use strict';

// Per-profile state for plugins shipped by the desktop shell. The source copy
// under assets/plugins is immutable from the user's point of view; only the
// profile copy is removed. Keeping this state beside the profile makes the
// choice independent from the native CLI's web profile.

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = '.dsh-builtin-plugin-state.json';
const VERSION = 1;
const STATES = new Set(['installed', 'disabled', 'uninstalled']);

function statePath(profileDir) {
  return path.join(profileDir, STATE_FILE);
}

function normalize(raw) {
  const out = { version: VERSION, plugins: {} };
  if (!raw || typeof raw !== 'object') return out;
  const plugins = raw.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return out;
  for (const [id, value] of Object.entries(plugins)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) continue;
    if (!value || typeof value !== 'object' || !STATES.has(value.state)) continue;
    out.plugins[id] = {
      state: value.state,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
    };
    if (out.plugins[id].updatedAt === undefined) delete out.plugins[id].updatedAt;
  }
  return out;
}

function loadBuiltinPluginState(profileDir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(statePath(profileDir), 'utf8')));
  } catch {
    return { version: VERSION, plugins: {} };
  }
}

function saveBuiltinPluginState(profileDir, state) {
  const normalized = normalize(state);
  const file = statePath(profileDir);
  fs.mkdirSync(profileDir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true, maxRetries: 3 });
    fs.renameSync(tmp, file);
  }
  return normalized;
}

function setBuiltinPluginState(profileDir, id, state) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(id || ''))) throw new TypeError('非法插件 id: ' + id);
  if (!STATES.has(state)) throw new TypeError('非法插件状态: ' + state);
  const next = loadBuiltinPluginState(profileDir);
  next.plugins[id] = { state, updatedAt: new Date().toISOString() };
  return saveBuiltinPluginState(profileDir, next);
}

function clearBuiltinPluginState(profileDir, id) {
  const next = loadBuiltinPluginState(profileDir);
  delete next.plugins[id];
  if (Object.keys(next.plugins).length === 0) {
    try { fs.rmSync(statePath(profileDir), { force: true, maxRetries: 3 }); } catch {}
    return next;
  }
  return saveBuiltinPluginState(profileDir, next);
}

module.exports = {
  STATE_FILE,
  loadBuiltinPluginState,
  saveBuiltinPluginState,
  setBuiltinPluginState,
  clearBuiltinPluginState,
};
