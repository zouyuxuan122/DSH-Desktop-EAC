import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { configLinesFor, normalizeRowConfigIndent, healSoulMdPatchRow, healRowConfig, removeBundledRowDuplicates, bundlePatchEntryIds, collectBundleEntryIds } = require(join(root, 'patch-row-heal.js'));

// v2.0.0 实际写进用户 profile 的坏行：只有 id + name，没有 config。
const BROKEN_PATCH = [
  '# dsh web profile patch（由 DSH Desktop 维护）',
  '- insert:',
  '    - id: soul-md',
  "      name: 'dsh-soul-md'",
  '- insert:',
  '    - id: tdai-memory',
  "      name: 'dsh-tdai-memory'",
  '',
].join('\n');

test('healSoulMdPatchRow 补上缺失的 config.path（v2.0.0 存量坏行）', () => {
  const { patch, healed } = healSoulMdPatchRow(BROKEN_PATCH);
  assert.deepEqual(healed, ['soul-md']);
  assert.match(patch, /- id: soul-md\n\s*name: 'dsh-soul-md'\n\s*config:\n\s*path: "soul\.md"\n/);
  // 其他行不受影响
  assert.match(patch, /- id: tdai-memory\n\s*name: 'dsh-tdai-memory'\n/);
  assert.equal(patch.match(/- id: soul-md/g).length, 1, '不应重复插入行');
});

test('healSoulMdPatchRow 幂等：已有 config 的行不再改动', () => {
  const once = healSoulMdPatchRow(BROKEN_PATCH).patch;
  const twice = healSoulMdPatchRow(once);
  assert.deepEqual(twice.healed, []);
  assert.equal(twice.patch, once);
});

test('healSoulMdPatchRow 对无 soul-md 行 / 空内容安全', () => {
  assert.deepEqual(healSoulMdPatchRow('- insert:\n    - id: tool-vision\n').healed, []);
  assert.deepEqual(healSoulMdPatchRow('').healed, []);
});

test('configLinesFor 生成合法 patch YAML', () => {
  assert.equal(configLinesFor({ path: 'soul.md' }), '      config:\n        path: "soul.md"\n');
});

// 向导/插件管理写的是顶层行（`- id:` 在列 0），config 缩进必须跟着行走：
// 顶层行用 2/4，insert 块内行用 6/8，混用会让 dsh-app-boot 解析 patch 直接
// 报 YAMLException（bad indentation of a mapping entry）→ dsh web 退出 1。
test('configLinesFor 顶层行缩进（baseIndent=0 → 2/4）', () => {
  assert.equal(configLinesFor({ path: 'soul.md' }, 0), '  config:\n    path: "soul.md"\n');
});

test('healSoulMdPatchRow 给顶层行补 config 时用 2/4 缩进', () => {
  const patch = "- id: soul-md\n  name: 'dsh-soul-md'\n  disabled: true\n";
  const { patch: out, healed } = healSoulMdPatchRow(patch);
  assert.deepEqual(healed, ['soul-md']);
  assert.equal(out, "- id: soul-md\n  name: 'dsh-soul-md'\n  config:\n    path: \"soul.md\"\n  disabled: true\n");
});

// 存量坏行自愈：旧 build 把 6 空格 config 贴到顶层行上，YAML 直接解析失败。
test('normalizeRowConfigIndent 修复顶层行的缩进错位 config（存量坏行）', () => {
  const bad = "- id: soul-md\n  name: 'dsh-soul-md'\n      config:\n        path: \"soul.md\"\n  disabled: true\n";
  const out = normalizeRowConfigIndent(bad, 'soul-md');
  assert.equal(out, "- id: soul-md\n  name: 'dsh-soul-md'\n  config:\n    path: \"soul.md\"\n  disabled: true\n");
});

test('normalizeRowConfigIndent 幂等且不碰 insert 块内合法行', () => {
  const ok = '- insert:\n    - id: soul-md\n      name: \'dsh-soul-md\'\n      config:\n        path: "soul.md"\n';
  assert.equal(normalizeRowConfigIndent(ok, 'soul-md'), ok, 'insert 块内 6/8 缩进合法，不动');
  const topOk = "- id: soul-md\n  name: 'dsh-soul-md'\n  config:\n    path: \"soul.md\"\n";
  assert.equal(normalizeRowConfigIndent(topOk, 'soul-md'), topOk, '顶层 2/4 缩进合法，不动');
});

test('normalizeRowConfigIndent 不把长 id 兄弟误当目标行（前缀 bug 回归）', () => {
  // 传短 id dsh-pet 时不得碰 dsh-pet-settings 行（旧 \b 词边界会误命中）。
  const bad = "- id: dsh-pet-settings\n  name: 'dsh-pet-settings'\n    config:\n      x: 1\n";
  assert.equal(normalizeRowConfigIndent(bad, 'dsh-pet'), bad, '短 id 不得误改长 id 兄弟的 config 缩进');
  const fixed = normalizeRowConfigIndent(bad, 'dsh-pet-settings');
  assert.ok(fixed.includes('  config:\n    x: 1\n'), '正确 id 应修复错位缩进');
});

test('healRowConfig 不把长 id 兄弟当目标行补 config（前缀 bug 回归）', () => {
  // 启动自愈 healRowConfig(patch, 'dsh-pet', …) 若误命中 dsh-pet-settings，
  // 会把 dsh-pet 的 config（size/position）塞进设置插件行里改坏它。
  const t = '- insert:\n    - id: dsh-pet-settings\n      name: dsh-pet-settings\n';
  const r = healRowConfig(t, 'dsh-pet', { size: 260, position: 'bottom-right' });
  assert.equal(r.patch, t, '短 id 不得给长 id 兄弟补 config');
  const r2 = healRowConfig(t, 'dsh-pet-settings', { x: 1 });
  assert.ok(r2.patch.includes('config:\n        x: 1\n'), '正确 id 应正常补 config');
});

test('healRowConfig 给顶层 dsh-pet 行补 config 时用 2/4 缩进', () => {
  const patch = "- id: dsh-pet\n  name: 'dsh-pet'\n  disabled: true\n";
  const { patch: out, healed } = healRowConfig(patch, 'dsh-pet', { size: 260, position: 'bottom-right' });
  assert.ok(healed.includes('dsh-pet'));
  assert.equal(out, "- id: dsh-pet\n  name: 'dsh-pet'\n  config:\n    size: 260\n    position: \"bottom-right\"\n  disabled: true\n");
});

// 根因防回归：schema 的 path 必须有默认值（文件缺失 → fallback 空 → 不注册
// section，官方提示词原样使用），绝不能再变回 required 无默认。
test('dsh-soul-md schema: path 带默认值，不再是 required', () => {
  const src = readFileSync(join(root, 'assets', 'plugins', 'dsh-soul-md', 'index.js'), 'utf8');
  assert.match(src, /path:\s*z\.string\(\)\.default\(/, 'path 必须带 .default()');
  assert.doesNotMatch(src, /path:\s*z\.string\(\)\.required\(\)/, 'path 不能是 required 无默认');
});

// main.js 侧双保险：新增行必须显式写 config，且启动时 heal 存量坏行。
// Task 5：COMPANION_PLUGINS 表与 syncCompanionPlugins 迁 lib/
// plugin-registry-data.ts / lib/plugins.ts。
test('main.js: soul-md 行带 config + 启动时执行存量 heal', () => {
  const registrySrc = readFileSync(join(root, 'lib', 'plugin-registry-data.ts'), 'utf8');
  const pluginsSrc = readFileSync(join(root, 'lib', 'plugins.ts'), 'utf8');
  assert.match(registrySrc, /id:\s*'soul-md',[^\n]*config:\s*\{\s*path:\s*'soul\.md'\s*\}/);
  assert.match(pluginsSrc, /healSoulMdPatchRow\(patch\)/);
  assert.match(pluginsSrc, /block \+= configLinesFor\(p\.config\)/);
});

// 市场安装（dsh plugin add 登记 bundles）与 overlay 写行双挂载 →
// "duplicate loader entry id" 拖垮插件树。overlay 重复行必须被移除。
test('removeBundledRowDuplicates: 删 bundle 已登记的 overlay 行', () => {
  const patch = [
    '- insert:',
    '    - id: soul-md',
    "      name: 'dsh-soul-md'",
    '      config:',
    '        path: "soul.md"',
    '- insert:',
    '    - id: mobile-fix',
    "      name: 'dsh-web-mobile-fix'",
    '- insert:',
    '    - id: terminal',
    "      name: '@deepseek-ai/dsh-terminal'",
    '',
  ].join('\n');
  const rowIds = { 'soul-md': 'dsh-soul-md', 'mobile-fix': 'dsh-web-mobile-fix', terminal: '@deepseek-ai/dsh-terminal' };
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['dsh-web-mobile-fix']);
  assert.deepEqual(removed, ['mobile-fix']);
  assert.doesNotMatch(out, /mobile-fix/);
  assert.match(out, /- id: soul-md[\s\S]*path: "soul\.md"/, '相邻块的 config 完整保留');
  assert.match(out, /- id: terminal/);
});

test('removeBundledRowDuplicates: 无 bundle 登记时不动任何行', () => {
  const rowIds = { 'mobile-fix': 'dsh-web-mobile-fix' };
  const { patch: out, removed } = removeBundledRowDuplicates(BROKEN_PATCH, rowIds, []);
  assert.deepEqual(removed, []);
  assert.equal(out, BROKEN_PATCH);
});

test('removeBundledRowDuplicates: 非 uninstall 目标插件（tts 等）不受影响', () => {
  const patch = '- insert:\n    - id: tts\n      name: \'@dsh-external/dsh-plugin-tts\'\n';
  const rowIds = { 'mobile-fix': 'dsh-web-mobile-fix' };
  const { removed } = removeBundledRowDuplicates(patch, rowIds, ['@dsh-external/dsh-plugin-tts']);
  assert.deepEqual(removed, [], 'rowIds 不含 tts，即使 bundle 里有也不动');
});

// issue #16：git/fork/link 安装的 bundle 包名与 overlay 行包名不一致，
// 但 entry id 相同 —— 旧「按包名匹配」删不掉，必须按 id 去重。
test('removeBundledRowDuplicates: 按 bundle 声明的 entry id 去重（跨包名，issue #16）', () => {
  const patch = [
    '- insert:',
    '    - id: tool-vision',
    "      name: 'dsh-tool-vision'",
    '- insert:',
    '    - id: tdai-memory',
    "      name: 'dsh-tdai-memory'",
    '',
  ].join('\n');
  const rowIds = { 'tool-vision': 'dsh-tool-vision', 'tdai-memory': 'dsh-tdai-memory' };
  // bundle 是 git fork：包名 dsh-vision-local，但包内 patch 声明 id: tool-vision。
  const bundleEntryIds = new Set(['tool-vision']);
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['dsh-vision-local'], bundleEntryIds);
  assert.deepEqual(removed, ['tool-vision']);
  assert.doesNotMatch(out, /tool-vision/);
  assert.match(out, /- id: tdai-memory/, '无关行保留');
});

test('removeBundledRowDuplicates: bundleEntryIds 为空时退化为原有按包名行为', () => {
  const patch = '- insert:\n    - id: mobile-fix\n      name: \'dsh-web-mobile-fix\'\n';
  const rowIds = { 'mobile-fix': 'dsh-web-mobile-fix' };
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['dsh-web-mobile-fix'], new Set());
  assert.deepEqual(removed, ['mobile-fix']);
  assert.doesNotMatch(out, /mobile-fix/);
});

// 收集函数：从 bundle 包目录解析 patch 声明的 entry id（含 dsh.bundle.patch 指向）。
test('bundlePatchEntryIds / collectBundleEntryIds: 解析包内 patch 的 entry id', () => {
  const dir = join(root, 'tmp-test-patch-heal', 'node_modules');
  const pkgDir = join(dir, 'dsh-vision-local');
  const fs = require('node:fs');
  fs.mkdirSync(pkgDir, { recursive: true });
  try {
    fs.writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'dsh-vision-local',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }));
    fs.writeFileSync(join(pkgDir, 'cordis.patch.yml'),
      '- insert:\n    - id: tool-vision\n      name: \'dsh-vision-local\'\n');
    const ids = collectBundleEntryIds(['dsh-vision-local'], dir);
    assert.deepEqual([...ids], ['tool-vision']);
    assert.equal(bundlePatchEntryIds(pkgDir).has('tool-vision'), true);
  } finally {
    fs.rmSync(join(root, 'tmp-test-patch-heal'), { recursive: true, force: true, maxRetries: 5 });
  }
});

// V4：dsh-pet 无 config 行的存量修复（v3.1.0 全新安装即崩的根因）。
test('healRowConfig 给缺 config 的 dsh-pet 行补包默认 config', () => {
  const bad = "- insert:\n    - id: dsh-pet\n      name: 'dsh-pet'\n";
  const { patch, healed } = healRowConfig(bad, 'dsh-pet', { size: 260, position: 'bottom-right' });
  assert.ok(healed.includes('dsh-pet'));
  assert.match(patch, /id: dsh-pet\n\s+name: 'dsh-pet'\n\s+config:\n\s+size: 260\n\s+position: "bottom-right"/);
});

test('healRowConfig 幂等且不碰相邻行', () => {
  const bad = "- insert:\n    - id: navbar\n      name: 'n'\n- insert:\n    - id: dsh-pet\n      name: 'dsh-pet'\n";
  const once = healRowConfig(bad, 'dsh-pet', { size: 260, position: 'bottom-right' });
  const twice = healRowConfig(once.patch, 'dsh-pet', { size: 260, position: 'bottom-right' });
  assert.equal(twice.patch, once.patch, '二次 heal 不应再改动');
  assert.ok(once.patch.includes("id: navbar"));
});
