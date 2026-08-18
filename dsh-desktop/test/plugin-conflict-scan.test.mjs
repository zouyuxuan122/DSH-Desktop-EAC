import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 防呆（v4.2，用户反馈问题 3）：两个插件互相影响（同名 patch 行 /
// 同一 settings 命名空间 / 核心依赖版本错位）装完才发现。本测试覆盖
// 安装前的轻量冲突预检：refuse（会直接拒绝安装）/ warn（弹窗提醒），
// 只读不写，skipCheck 仍可绕过 refuse（风险自负）。

const mod = await import(pathToFileURL(join('assets', 'plugins', 'dsh-webui-market', 'lib', 'plugin-conflict-scan.mjs')).href);
const { parsePatchRows, scanCandidate, collectProfileState } = mod;

const EMPTY_PROFILE = { builtinNames: [], bundles: [], dependencies: {}, patchRows: [], installed: [] };

const CANDIDATE = (over = {}) => ({
  name: 'dsh-pet',
  spec: 'github:owner/dsh-pet',
  manifest: { name: 'dsh-pet', dependencies: {} },
  patchText: '- id: dsh-pet\n  name: dsh-pet\n',
  ...over,
});

function issuesOf(candidate, profile) {
  const v = scanCandidate(candidate, profile);
  return v;
}

test('parsePatchRows：解析顶层与 insert 内层的 id/name 行', () => {
  const text = [
    '- id: dsh-tool-vision',
    "  name: 'dsh-tool-vision'",
    '- insert:',
    '    - id: mkt-1',
    "      name: 'dsh-pet'",
    '',
  ].join('\n');
  assert.deepEqual(parsePatchRows(text), [
    { id: 'dsh-tool-vision', name: 'dsh-tool-vision' },
    { id: 'mkt-1', name: 'dsh-pet' },
  ]);
});

test('scanCandidate：无冲突 → ok', () => {
  const v = issuesOf(CANDIDATE(), EMPTY_PROFILE);
  assert.equal(v.level, 'ok');
  assert.deepEqual(v.issues, []);
});

test('scanCandidate：patch 行 id 与现有行重复 → refuse', () => {
  const v = issuesOf(CANDIDATE(), { ...EMPTY_PROFILE, patchRows: [{ id: 'dsh-pet', name: 'dsh-pet' }] });
  assert.equal(v.level, 'refuse');
  assert.ok(v.issues.some((i) => i.code === 'PATCH_DUP_ID' && i.severity === 'refuse'));
});

test('scanCandidate：patch 行 name 与现有行 name 重复 → refuse', () => {
  const v = issuesOf(
    CANDIDATE({ patchText: '- id: other-id\n  name: dsh-pet\n' }),
    { ...EMPTY_PROFILE, patchRows: [{ id: 'mkt-9', name: 'dsh-pet' }] }
  );
  assert.equal(v.level, 'refuse');
  assert.ok(v.issues.some((i) => i.code === 'PATCH_DUP_NAME'));
});

test('scanCandidate：包名撞内置插件 → refuse', () => {
  const v = issuesOf(CANDIDATE({ name: 'dsh-tool-vision' }), { ...EMPTY_PROFILE, builtinNames: ['dsh-tool-vision'] });
  assert.equal(v.level, 'refuse');
  assert.ok(v.issues.some((i) => i.code === 'BUILTIN_COLLISION'));
});

test('scanCandidate：包名已在 bundle 里 → refuse', () => {
  const v = issuesOf(CANDIDATE({ name: 'api-gateway' }), { ...EMPTY_PROFILE, bundles: ['api-gateway'] });
  assert.equal(v.level, 'refuse');
  assert.ok(v.issues.some((i) => i.code === 'BUNDLE_COLLISION'));
});

test('scanCandidate：同名依赖不同 spec → warn（重复安装提醒）', () => {
  const v = issuesOf(CANDIDATE(), { ...EMPTY_PROFILE, dependencies: { 'dsh-pet': 'github:other/dsh-pet' } });
  assert.equal(v.level, 'warn');
  assert.ok(v.issues.some((i) => i.code === 'DEP_REINSTALL'));
});

test('scanCandidate：settings 命名空间与已装插件冲突 → warn', () => {
  const cand = CANDIDATE({ manifest: { name: 'dsh-pet', dsh: { settings: { key: 'dsh-pet' } } } });
  const v = issuesOf(cand, {
    ...EMPTY_PROFILE,
    installed: [{ name: 'dsh-other', manifest: { dsh: { settings: { key: 'dsh-pet' } } } }],
  });
  assert.equal(v.level, 'warn');
  assert.ok(v.issues.some((i) => i.code === 'SETTINGS_NS_CLASH'));
});

test('scanCandidate：核心共享依赖版本冲突 → warn（轻量版）', () => {
  const cand = CANDIDATE({ manifest: { name: 'dsh-pet', dependencies: { koffi: '^3.1.0' } } });
  const v = issuesOf(cand, {
    ...EMPTY_PROFILE,
    installed: [{ name: 'dsh-other', manifest: { dependencies: { koffi: '^2.9.0' } } }],
  });
  assert.equal(v.level, 'warn');
  assert.ok(v.issues.some((i) => i.code === 'CORE_DEP_CLASH'));
});

test('scanCandidate：refuse 优先级高于 warn', () => {
  const v = issuesOf(CANDIDATE({ name: 'api-gateway' }), {
    ...EMPTY_PROFILE,
    bundles: ['api-gateway'],
    dependencies: { 'dsh-pet': 'github:other/dsh-pet' },
  });
  assert.equal(v.level, 'refuse');
});

test('collectProfileState：读取真实 profile 形态（temp 目录）', () => {
  const t = mkdtempSync(join(tmpdir(), 'scan-'));
  try {
    const profile = join(t, 'profiles', 'web-desktop');
    mkdirSync(join(profile, 'node_modules', 'meow-memory'), { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      dependencies: { 'meow-memory': 'github:zhang-meow/meow-memory' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2) + '\n');
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: dsh-tool-vision\n  name: dsh-tool-vision\n');
    writeFileSync(join(profile, '.dsh-builtin-plugins.json'), JSON.stringify({ names: ['dsh-tool-vision'] }));
    writeFileSync(join(profile, 'node_modules', 'meow-memory', 'package.json'),
      JSON.stringify({ name: 'meow-memory', dsh: { settings: { key: 'meow-memory' } } }));
    const st = collectProfileState(profile);
    assert.deepEqual(st.builtinNames, ['dsh-tool-vision']);
    assert.deepEqual(st.bundles, ['@deepseek-ai/dsh-base']);
    assert.deepEqual(Object.keys(st.dependencies), ['meow-memory']);
    assert.deepEqual(st.patchRows, [{ id: 'dsh-tool-vision', name: 'dsh-tool-vision' }]);
    assert.equal(st.installed[0].name, 'meow-memory');
    assert.equal(st.installed[0].manifest.dsh.settings.key, 'meow-memory');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('collectProfileState：目录不存在/文件缺失 → 空状态不抛错', () => {
  const t = mkdtempSync(join(tmpdir(), 'scan-'));
  try {
    const st = collectProfileState(join(t, 'nope'));
    assert.deepEqual(st, { builtinNames: [], bundles: [], dependencies: {}, patchRows: [], installed: [] });
  } finally { rmSync(t, { recursive: true, force: true }); }
});