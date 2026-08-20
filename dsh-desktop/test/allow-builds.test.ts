import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 防呆（v4.2，用户反馈问题 2）：pnpm v10+ 默认封锁依赖构建脚本
// （prepare/install/postinstall），git 源插件安装必被拦：
//   dsh plugin add github:X 失败 → 只打印 "allowBuilds 加白名单" 提示。
// 本测试覆盖 pnpm 封锁提示的多形态解析与 pnpm-workspace.yaml 的行级编辑。

const mod = await import(pathToFileURL(join('assets', 'plugins', 'dsh-webui-market', 'lib', 'allow-builds.mjs')).href);
const { parseBlockedBuildKeys, readAllowBuilds, ensureAllowBuilds } = mod;

function tmp() {
  const t = mkdtempSync(join(tmpdir(), 'ab-'));
  return { root: t, rm: () => rmSync(t, { recursive: true, force: true }) };
}

test('parseBlockedBuildKeys：Ignored build scripts 单行列表', () => {
  const out = 'Ignored build scripts: esbuild, koffi. Run "pnpm approve-builds" to pick which dependencies should be allowed.';
  assert.deepEqual(parseBlockedBuildKeys(out), ['esbuild', 'koffi']);
});

test('parseBlockedBuildKeys：Ignored build scripts on（pnpm 新版措辞）', () => {
  const out = 'Ignored build scripts on: dsh-better-sidebar, foo-bar';
  assert.deepEqual(parseBlockedBuildKeys(out), ['dsh-better-sidebar', 'foo-bar']);
});

test('parseBlockedBuildKeys：带 ERR_PNPM_IGNORED_BUILDS 前缀与换行续行', () => {
  const out = [
    'ERR_PNPM_IGNORED_BUILDS Ignored build scripts:',
    '  esbuild, meow-memory. Run "pnpm approve-builds" to pick which',
    '  dependencies should be allowed.',
  ].join('\n');
  assert.deepEqual(parseBlockedBuildKeys(out), ['esbuild', 'meow-memory']);
});

test('parseBlockedBuildKeys：prepare/install script of "x" 形态', () => {
  const a = 'prepare script of "meow-memory" is blocked';
  assert.deepEqual(parseBlockedBuildKeys(a), ['meow-memory']);
  const b = 'install script of \'@sanqi-normal/dsh-webui-market\' was not executed';
  assert.deepEqual(parseBlockedBuildKeys(b), ['@sanqi-normal/dsh-webui-market']);
});

test('parseBlockedBuildKeys：scoped 包名与尾标点清理', () => {
  const out = 'Ignored build scripts: @deepseek-ai/dsh-base, esbuild.';
  assert.deepEqual(parseBlockedBuildKeys(out), ['@deepseek-ai/dsh-base', 'esbuild']);
});

test('parseBlockedBuildKeys：无关输出返回空数组', () => {
  assert.deepEqual(parseBlockedBuildKeys('all good, pnpm install succeeded in 3s'), []);
  assert.deepEqual(parseBlockedBuildKeys(''), []);
  assert.deepEqual(parseBlockedBuildKeys('Ignored build scripts: none. Run "pnpm approve-builds"'), []);
});

test('ensureAllowBuilds：文件不存在时创建 allowBuilds 块', () => {
  const t = tmp();
  try {
    const p = join(t.root, 'pnpm-workspace.yaml');
    const r = ensureAllowBuilds(p, ['esbuild', 'koffi']);
    assert.equal(r.wrote, true);
    assert.deepEqual(r.added, ['esbuild', 'koffi']);
    assert.equal(r.existed, false);
    const text = readFileSync(p, 'utf8');
    assert.ok(text.includes('allowBuilds:'));
    assert.ok(text.includes('  - esbuild'));
    assert.ok(text.includes('  - koffi'));
    assert.deepEqual(readAllowBuilds(p), ['esbuild', 'koffi']);
  } finally { t.rm(); }
});

test('ensureAllowBuilds：已存在 allowBuilds 块时只补缺失键，幂等', () => {
  const t = tmp();
  try {
    const p = join(t.root, 'pnpm-workspace.yaml');
    writeFileSync(p, 'packages:\n  - ./*\n\nallowBuilds:\n  - esbuild\n');
    const r1 = ensureAllowBuilds(p, ['esbuild', 'koffi']);
    assert.equal(r1.wrote, true);
    assert.deepEqual(r1.added, ['koffi']);
    assert.equal(r1.existed, true);
    const r2 = ensureAllowBuilds(p, ['esbuild', 'koffi']);
    assert.equal(r2.wrote, false);
    assert.deepEqual(r2.added, []);
    assert.deepEqual(readAllowBuilds(p), ['esbuild', 'koffi']);
    assert.ok(!/esbuild.*esbuild/s.test(readFileSync(p, 'utf8')), '不得重复写入已有键');
  } finally { t.rm(); }
});

test('ensureAllowBuilds：旧版 onlyBuiltDependencies 块同样兼容', () => {
  const t = tmp();
  try {
    const p = join(t.root, 'pnpm-workspace.yaml');
    writeFileSync(p, 'packages:\n  - ./*\n\nonlyBuiltDependencies:\n  - esbuild\n');
    const r = ensureAllowBuilds(p, ['koffi']);
    assert.equal(r.wrote, true);
    assert.deepEqual(r.added, ['koffi']);
    assert.deepEqual(readAllowBuilds(p), ['esbuild', 'koffi']);
  } finally { t.rm(); }
});

test('ensureAllowBuilds：inline 列表 [a, b] 归一化为块列表', () => {
  const t = tmp();
  try {
    const p = join(t.root, 'pnpm-workspace.yaml');
    writeFileSync(p, 'packages:\n  - ./*\n\nallowBuilds: [esbuild]\n');
    const r = ensureAllowBuilds(p, ['koffi', 'esbuild']);
    assert.equal(r.wrote, true);
    assert.deepEqual(r.added, ['koffi']);
    assert.ok(/allowBuilds:\n  - esbuild\n  - koffi/.test(readFileSync(p, 'utf8')));
  } finally { t.rm(); }
});

test('ensureAllowBuilds：无 section 时追加到文件末尾', () => {
  const t = tmp();
  try {
    const p = join(t.root, 'pnpm-workspace.yaml');
    writeFileSync(p, 'packages:\n  - ./*\n');
    const r = ensureAllowBuilds(p, ['esbuild']);
    assert.equal(r.wrote, true);
    const text = readFileSync(p, 'utf8');
    assert.ok(text.trimEnd().endsWith('allowBuilds:\n  - esbuild'));
  } finally { t.rm(); }
});

test('ensureAllowBuilds：拒绝危险键名（YAML 注入防呆）', () => {
  const t = tmp();
  try {
    const p = join(t.root, 'pnpm-workspace.yaml');
    const r = ensureAllowBuilds(p, ['esbuild', 'x\n- pwn']);
    assert.deepEqual(r.added, ['esbuild']);
    assert.ok(!readFileSync(p, 'utf8').includes('pwn'));
  } finally { t.rm(); }
});

test('readAllowBuilds：不存在的文件返回空数组', () => {
  const t = tmp();
  try {
    assert.deepEqual(readAllowBuilds(join(t.root, 'nope.yaml')), []);
  } finally { t.rm(); }
});