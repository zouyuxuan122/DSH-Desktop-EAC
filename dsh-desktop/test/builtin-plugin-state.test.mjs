import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = await import('../builtin-plugin-state.js');

test('内置插件卸载状态按 profile 原子持久化并可恢复', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-builtin-state-'));
  const profile = join(root, 'profiles', 'web-desktop');
  mkdirSync(profile, { recursive: true });
  try {
    assert.deepEqual(state.loadBuiltinPluginState(profile), { version: 1, plugins: {} });
    state.setBuiltinPluginState(profile, 'better-sidebar', 'uninstalled');
    const saved = state.loadBuiltinPluginState(profile);
    assert.equal(saved.plugins['better-sidebar'].state, 'uninstalled');
    assert.ok(readFileSync(join(profile, state.STATE_FILE), 'utf8').includes('better-sidebar'));

    state.clearBuiltinPluginState(profile, 'better-sidebar');
    assert.deepEqual(state.loadBuiltinPluginState(profile), { version: 1, plugins: {} });
    assert.equal(existsSync(join(profile, state.STATE_FILE)), false, '无状态时应清理状态文件');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('损坏或非法状态会降级为干净状态', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-builtin-state-invalid-'));
  try {
    const bad = join(root, state.STATE_FILE);
    mkdirSync(root, { recursive: true });
    writeFileSync(bad, JSON.stringify({
      version: 99,
      plugins: {
        '../escape': { state: 'uninstalled' },
        good: { state: 'uninstalled', updatedAt: 'x' },
        bad: { state: 'unknown' },
      },
    }));
    const result = state.loadBuiltinPluginState(root);
    assert.equal(result.plugins.good.state, 'uninstalled');
    assert.equal(result.plugins['../escape'], undefined);
    assert.equal(result.plugins.bad, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
