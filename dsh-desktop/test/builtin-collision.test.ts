import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// 防呆（v4.2，用户反馈问题 5）：更新后插件树变化无提示。这里覆盖其前半 —
// 用户曾从市场安装过与内置插件同名的包（如 dsh-tool-vision），内置插件树
// 更新后 syncCompanionPlugins 用拷贝覆盖 node_modules，市场安装的包与
// 内置行并存 → duplicate loader entry。迁移：把市场版依赖/行从 profile
// 移除（保留用户自建 link: 本地链接），让内置版干净接管，并报告移除了什么。

const require = createRequire(import.meta.url);
const { removeMarketDuplicate, stripPatchRows, patchHasForeignRows } = require('../builtin-collision.js');

const PATCH_TPL = [
  '- id: dsh-tool-vision',
  "  name: 'dsh-tool-vision'",
  '  config:',
  '    vision: true',
  '- insert:',
  '    - id: mkt-1',
  "      name: 'dsh-pet'",
  '    - id: mkt-2',
  "      name: 'dsh-tool-vision'",
  "      config:",
  "        extra: 1",
  '- id: soul-md',
  "  name: 'soul-md'",
  '',
].join('\n');

function makeProfile(root, over = {}) {
  const profile = join(root, 'profiles', 'web-desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: {
      'dsh-tool-vision': 'github:someone/dsh-tool-vision',
      'meow-memory': 'github:zhang-meow/meow-memory',
      'local-link': 'link:../local-link',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-tool-vision'] } },
  }, null, 2) + '\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), over.patch || PATCH_TPL);
  return profile;
}

test('removeMarketDuplicate：移除市场版依赖、bundle 与 patch 行（含 insert 内层）', () => {
  const t = mkdtempSync(join(tmpdir(), 'bc-'));
  try {
    const profile = makeProfile(t);
    const r = removeMarketDuplicate(profile, 'dsh-tool-vision');
    assert.equal(r.ok, true);
    assert.deepEqual(r.removedDep, ['dsh-tool-vision']);
    assert.deepEqual(r.removedBundles, ['dsh-tool-vision']);
    assert.deepEqual(r.removedRows, ['dsh-tool-vision', 'mkt-2']);
    // 依赖：市场版被移除，其他依赖原样
    const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies['dsh-tool-vision'], undefined);
    assert.equal(pkg.dependencies['meow-memory'], 'github:zhang-meow/meow-memory');
    assert.equal(pkg.dependencies['local-link'], 'link:../local-link');
    assert.ok(!pkg.dsh.profile.bundles.includes('dsh-tool-vision'));
    // patch：内置同名列被移除（sync 会立即重写回内置行），无关行保留
    const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
    assert.ok(!patch.includes('mkt-2'), 'insert 内层的市场重复行应被移除');
    assert.ok(!/^- id: dsh-tool-vision\b/m.test(patch), '顶层市场重复行应被移除');
    assert.ok(patch.includes("name: 'dsh-pet'"), '无关 insert 行保留');
    assert.ok(patch.includes('- id: soul-md'), '无关顶层行保留');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('removeMarketDuplicate：link:/file: 依赖保留（用户自建本地链接不动）', () => {
  const t = mkdtempSync(join(tmpdir(), 'bc-'));
  try {
    const profile = makeProfile(t, { patch: '- id: other\n  name: other\n' });
    // 内置名对应的依赖是 link: —— 用户 fork 本地开发，不能删；bundle 也
    // 不含它（避免测试误伤）
    const pkgFile = join(profile, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    pkg.dependencies['dsh-tool-vision'] = 'link:../dsh-tool-vision';
    pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base'];
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    const r = removeMarketDuplicate(profile, 'dsh-tool-vision');
    assert.deepEqual(r.removedDep, [], 'link: 依赖不得移除');
    assert.equal(r.changed, false);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('removeMarketDuplicate：无重复时幂等（changed=false）', () => {
  const t = mkdtempSync(join(tmpdir(), 'bc-'));
  try {
    const profile = makeProfile(t, { patch: '- id: meow-memory\n  name: meow-memory\n' });
    // 完全没有 dsh-tool-vision 的任何残留
    const pkgFile = join(profile, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    delete pkg.dependencies['dsh-tool-vision'];
    pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base'];
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    const r = removeMarketDuplicate(profile, 'dsh-tool-vision');
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.deepEqual(r.removedDep, []);
    assert.deepEqual(r.removedRows, []);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('removeMarketDuplicate：profile 缺失文件时静默成功', () => {
  const t = mkdtempSync(join(tmpdir(), 'bc-'));
  try {
    const r = removeMarketDuplicate(join(t, 'nope'), 'dsh-tool-vision');
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

// patchHasForeignRows（v4.4）：应用自写的行不得算市场残留 —— 否则首次向导
// 的取消勾选会在同一启动里被剥离后按注册表默认回写（dsh-dafeiyu 等默认
// 启用插件被静默重新启用），且每次启动产生「剥离-回写」空转与孤儿行堆积。

test('patchHasForeignRows：sync 的 insert 内层行不算市场残留', () => {
  const patch = [
    '- insert:',
    "    - id: dsh-dafeiyu",
    "      name: 'dsh-dafeiyu'",
    '- insert:',
    "    - id: dsh-pet",
    "      name: 'dsh-pet'",
    '      disabled: true',
  ].join('\n');
  assert.equal(patchHasForeignRows(patch, 'dsh-dafeiyu'), false, 'insert 内层行是 sync 自写形');
  assert.equal(patchHasForeignRows(patch, 'dsh-pet'), false);
});

test('patchHasForeignRows：插件管理/向导的「关闭」标记顶层行不算市场残留', () => {
  const patch = [
    '# 插件管理（设置页「插件」栏）：关闭 dsh-dafeiyu',
    '- id: dsh-dafeiyu',
    "  name: 'dsh-dafeiyu'",
    '  disabled: true',
    '',
  ].join('\n');
  assert.equal(patchHasForeignRows(patch, 'dsh-dafeiyu'), false, '带关闭标记的顶层行是 togglePluginInPatch 写形');
});

test('patchHasForeignRows：真正的市场顶层行（无标记）算残留', () => {
  const patch = [
    '- insert:',
    "    - id: dsh-pet",
    "      name: 'dsh-pet'",
    '      disabled: true',
    '- id: dsh-dafeiyu',
    "  name: 'dsh-dafeiyu'",
    '',
  ].join('\n');
  assert.equal(patchHasForeignRows(patch, 'dsh-dafeiyu'), true, '顶层裸行无关闭标记 = 市场安装残留');
  assert.equal(patchHasForeignRows(patch, 'dsh-pet'), false, 'insert 内层行不算');
});

test('patchHasForeignRows：name 命中（id 不同）的市场行算残留', () => {
  const patch = [
    '- id: mkt-2',
    "  name: 'dsh-tool-vision'",
    '',
  ].join('\n');
  assert.equal(patchHasForeignRows(patch, 'dsh-tool-vision'), true);
});

test('patchHasForeignRows：无关行与空 patch 不算残留', () => {
  assert.equal(patchHasForeignRows('- id: soul-md\n  name: soul-md\n', 'dsh-dafeiyu'), false);
  assert.equal(patchHasForeignRows('', 'dsh-dafeiyu'), false);
  assert.equal(patchHasForeignRows('# 只有注释\n', 'dsh-dafeiyu'), false);
});

test('stripPatchRows：自写行的保护在 dupPreCheck 层，迁移命中时仍全量剥离', () => {
  // strip 语义不变（v4.2+ 一直如此）：迁移一旦触发，顶层+内层同名行都剥。
  // v4.4 修复点在调用侧 —— dupPreCheck 用 patchHasForeignRows 先排除自写行，
  // 自写行根本走不到 removeMarketDuplicate。
  const patch = [
    '# 插件管理（设置页「插件」栏）：关闭 dsh-dafeiyu',
    '- id: dsh-dafeiyu',
    "  name: 'dsh-dafeiyu'",
    '  disabled: true',
    '- id: mkt-2',
    "  name: 'dsh-tool-vision'",
    '',
  ].join('\n');
  const { patch: out, removed } = stripPatchRows(patch, 'dsh-dafeiyu', 'dsh-dafeiyu');
  assert.deepEqual(removed, ['dsh-dafeiyu'], '带标记的自写行也剥（strip 层不做区分）');
  assert.ok(!/- id: dsh-dafeiyu\b/.test(out), '自写行被移除（迁移语义不变）');
  assert.ok(/- id: mkt-2\b/.test(out), '无关行保留');
});