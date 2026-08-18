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
const { removeMarketDuplicate } = require('../builtin-collision.js');

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