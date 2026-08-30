// test/config.test.ts — normalizeConfig 纯函数测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULTS } from '../src/config';

test('缺省配置回退默认值', () => {
  const { config, errors } = normalizeConfig({});
  assert.deepEqual(config, DEFAULTS);
  assert.deepEqual(errors, []);
});

test('合法配置原样通过', () => {
  const { config, errors } = normalizeConfig({
    port: 3080,
    autoStart: false,
    stopOnExit: false,
    profile: 'web',
    dshHome: 'C:\\custom\\dsh',
    syncBuiltinPlugins: false,
    extraArgs: ['--foo', 'bar'],
    patchOverlays: ['C:\\patch.yml'],
    openInBrowser: true,
    workspaceRootIndex: 1,
  });
  assert.equal(config.port, 3080);
  assert.equal(config.profile, 'web');
  assert.equal(config.dshHome, 'C:\\custom\\dsh');
  assert.equal(config.syncBuiltinPlugins, false);
  assert.deepEqual(config.extraArgs, ['--foo', 'bar']);
  assert.deepEqual(config.patchOverlays, ['C:\\patch.yml']);
  assert.equal(config.openInBrowser, true);
  assert.equal(config.workspaceRootIndex, 1);
  assert.deepEqual(errors, []);
});

test('非法端口回退默认并记录错误', () => {
  const { config, errors } = normalizeConfig({ port: -1 });
  assert.equal(config.port, DEFAULTS.port);
  assert.ok(errors.some((e) => e.includes('dshEac.port')));
});

test('非法 profile 回退默认并记录错误', () => {
  const { config, errors } = normalizeConfig({ profile: 'nope' });
  assert.equal(config.profile, DEFAULTS.profile);
  assert.ok(errors.some((e) => e.includes('dshEac.profile')));
});

test('非法 workspaceRootIndex 回退默认并记录错误', () => {
  const { config, errors } = normalizeConfig({ workspaceRootIndex: -3 });
  assert.equal(config.workspaceRootIndex, DEFAULTS.workspaceRootIndex);
  assert.ok(errors.some((e) => e.includes('dshEac.workspaceRootIndex')));
});

test('非字符串 dshHome 静默回退空串（不记错误）', () => {
  const { config, errors } = normalizeConfig({ dshHome: 123 as unknown as string });
  assert.equal(config.dshHome, '');
  assert.deepEqual(errors, []);
});

test('extraArgs 过滤非字符串项', () => {
  const { config } = normalizeConfig({ extraArgs: ['ok', 42 as unknown as string, 'also'] });
  assert.deepEqual(config.extraArgs, ['ok', 'also']);
});

test('host 固定为回环地址（安全边界）', () => {
  const { config } = normalizeConfig({});
  assert.equal(config.host, '127.0.0.1');
});

// —— resolveRepoRoot（仓库根解析：env → <extensionPath>/runtime → dirname）——

import { resolveRepoRoot } from '../src/config';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eac-root-'));
  return dir;
}

test('resolveRepoRoot：DSH_EAC_REPO_ROOT 环境变量最高优先', () => {
  const dir = makeSandbox();
  try {
    const env = { DSH_EAC_REPO_ROOT: join(dir, 'x') };
    // 无论 extensionPath 下是否已有 runtime，env 一律生效
    const result = resolveRepoRoot(join(dir, 'pkg'), env);
    assert.equal(result, join(dir, 'x'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRepoRoot：内置 IDE 模式解析 <extensionPath>/runtime（含 desktop-core.js）', () => {
  const dir = makeSandbox();
  try {
    const extPath = join(dir, 'pkg');
    mkdirSync(join(extPath, 'runtime'), { recursive: true });
    writeFileSync(join(extPath, 'runtime', 'desktop-core.js'), 'x');
    const result = resolveRepoRoot(extPath, {});
    assert.equal(result, join(extPath, 'runtime'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRepoRoot：runtime 存在但缺 desktop-core.js 不算（判据不满足）', () => {
  const dir = makeSandbox();
  try {
    const extPath = join(dir, 'pkg');
    mkdirSync(join(extPath, 'runtime'), { recursive: true });
    const result = resolveRepoRoot(extPath, {});
    assert.equal(result, dirname(extPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRepoRoot：开发仓库模式回退 dirname(extensionPath)', () => {
  const dir = makeSandbox();
  try {
    const extPath = join(dir, 'pkg');
    mkdirSync(extPath, { recursive: true });
    const result = resolveRepoRoot(extPath, {});
    assert.equal(result, dirname(extPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
