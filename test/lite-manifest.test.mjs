import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// v4Lite 项目清单测试：把「裁剪后的目标状态」钉死在这里，防止任何人
// （或任何合并）把已移除的功能/插件/皮肤/壳层模块悄悄带回来。
// 皮肤与插件都以「目录 + 注册表精确相等」校验，多一个少一个都红。

const root = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const KEEP_SKINS = [
  'blue-fantasy', 'dragon-heir', 'miku', 'minecraft', 'qq98',
  'ths', 'trading', 'whale-song', 'xp',
].sort();

const KEEP_PLUGIN_DIRS = [
  'dsh-auto-compact', 'dsh-balance', 'dsh-better-sidebar', 'dsh-composer-dynamic-island', 'dsh-market',
  'dsh-offpeak', 'dsh-plugin-manager', 'dsh-plugin-marketplace',
  'dsh-plugin-shield', 'dsh-skin-switch', 'dsh-undo-savepoint', 'dsh-webui-market',
].sort();

// main.js COMPANION_PLUGINS 里保留的注册 id（含新补登记的 plugin-marketplace
// 与 4.5.0 新增的 dsh-market）。
const KEEP_PLUGIN_IDS = [
  'auto-compact', 'balance', 'better-sidebar', 'composer-dynamic-island', 'dsh-market', 'dsh-market-plugin',
  'dsh-undo', 'offpeak', 'plugin-manager', 'plugin-marketplace', 'plugin-shield',
  'skin-switch',
].sort();

// 壳层与脚本中禁止再出现的引用（移除功能的残留）。
const FORBIDDEN_TOKENS = [
  'session-watcher', 'client-updater', 'clientUpdater',
  'SessionWatcher', 'notifyOnTurnEnd', 'openclaw', 'zat-market', 'zat-dsh-engine',
  'maid-atelier', 'eac-desktop-tips', 'easy-setup', 'tool-vision', 'soul-md',
  'tdai-memory', 'mobile-fix', 'message-rewind', 'dsh-pet', 'dock-settings',
  'font-custom', 'change-review', 'float-window', 'dsh-navbar', 'session-manager',
  'conversation-tweaks', 'prompt-custom', 'third-party-thinking', 'side-session',
  'dafeiyu', 'file-drop', 'image-paste', 'settings-nav-custom',
  'settings-groups', 'patch-session-manage', 'plugin-wizard', 'onboard:',
  'pluginOnboardingDone',
];

const FORBIDDEN_FILES = [
  'session-watcher.js', 'client-updater.js',
  'scripts/check-client-latest.js', 'scripts/sim-client-update.js',
  'scripts/test-watcher.js', 'scripts/update-check-probe.js',
  'scripts/analyze-session-log.js', 'scripts/inspect-session.js',
  'scripts/repair-session-log.js', 'scripts/tmp-dbg-chat.cjs',
  'scripts/tmp-dbg2.cjs', 'scripts/tmp-instrument.cjs',
  'scripts/onboarding.js', 'assets/onboarding.html', 'assets/onboarding-preload.js',
];

// 移除功能的测试文件（随功能一并删除，防止遗留测试被带回来）。
const FORBIDDEN_TESTS = [
  'client-update-platform.test.mjs',
  'client-updater-apply.test.mjs', 'client-updater-asset.test.mjs',
  'client-updater-hash.test.mjs', 'client-updater-nospace.test.mjs',
  'client-updater-resume.test.mjs', 'desktop-extras.test.mjs',
  'easy-setup.test.mjs', 'file-drop-core.test.mjs', 'image-paste-core.test.mjs',
  'pricing-window.test.mjs', 'settings-groups-core.test.mjs',
  'settings-nav-core.test.mjs', 'tool-vision-stream-guard.test.mjs',
  'update-mirror-chain.test.mjs', 'widget-theme.test.mjs',
  'onboarding-selection.test.mjs',
];

test('皮肤：assets/skins 恰为 9 款（无 maid-atelier）', () => {
  const dirs = readdirSync(join(root, 'assets', 'skins'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(dirs, KEEP_SKINS);
  for (const name of KEEP_SKINS) {
    const dir = join(root, 'assets', 'skins', name);
    assert.ok(existsSync(join(dir, 'package.json')), name + ' 缺 package.json');
    assert.ok(existsSync(join(dir, 'skin.json')), name + ' 缺 skin.json');
  }
});

test('皮肤：dsh-skin-switch 不再引用 maid-atelier', () => {
  const pkg = read('assets/plugins/dsh-skin-switch/package.json');
  const client = read('assets/plugins/dsh-skin-switch/lib/client.js');
  assert.ok(!/maid/i.test(pkg));
  assert.ok(!/maid-atelier|srcMaid|licMaid|creditMaid|noticeMaid|repoMaid/.test(client));
});

test('插件：assets/plugins 恰为保留的 12 个目录', () => {
  const dirs = readdirSync(join(root, 'assets', 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(dirs, KEEP_PLUGIN_DIRS);
  for (const name of KEEP_PLUGIN_DIRS) {
    assert.ok(existsSync(join(root, 'assets', 'plugins', name, 'package.json')), name + ' 缺 package.json');
  }
});

test('插件：main.js COMPANION_PLUGINS 注册表恰为保留的 12 个 id', () => {
  const main = read('main.js');
  const m = main.match(/const COMPANION_PLUGINS = \[([\s\S]*?)\];/);
  assert.ok(m, 'main.js 中找不到 COMPANION_PLUGINS 定义');
  const ids = [...m[1].matchAll(/id: '([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(ids, KEEP_PLUGIN_IDS);
});

test('插件：核心组（CORE_PLUGIN_IDS）为 v4Lite 清单，选择向导已整体移除', () => {
  const main = read('main.js');
  const core = main.match(/const CORE_PLUGIN_IDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(core, 'main.js 中找不到 CORE_PLUGIN_IDS 定义');
  const ids = (s) => [...s[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(ids(core), ['plugin-manager', 'plugin-shield']);
  for (const rel of ['scripts/onboarding.js', 'assets/onboarding.html', 'assets/onboarding-preload.js', 'assets/plugins/dsh-plugin-wizard']) {
    assert.ok(!existsSync(join(root, rel)), rel + ' 仍存在');
  }
});

test('壳层：main.js / preload.js 无已移除功能的残留引用', () => {
  const main = read('main.js');
  const preload = read('preload.js');
  for (const token of FORBIDDEN_TOKENS) {
    assert.ok(!main.includes(token), 'main.js 仍含 ' + token);
    assert.ok(!preload.includes(token), 'preload.js 仍含 ' + token);
  }
});

test('壳层：被移除的模块/脚本/调试文件不存在', () => {
  for (const rel of FORBIDDEN_FILES) {
    assert.ok(!existsSync(join(root, rel)), rel + ' 仍存在');
  }
});

test('壳层：AIO 技能由脱敏 profile seed 清单和外部离线资产声明', () => {
  assert.ok(!existsSync(join(root, 'assets', 'skills')), '旧 assets/skills 不应残留');
  const seedPackage = JSON.parse(read('distribution/profile-seed/profiles/web-desktop/package.json'));
  assert.ok(seedPackage.dependencies?.['dsh-usage-skill'], 'profile seed 清单应声明 dsh-usage-skill');
  const stage = read('tauri-app/scripts/stage.ts');
  assert.match(stage, /DSH_PROFILE_SEED_DIR/, 'staging 应支持注入审核后的离线 seed');
});

test('测试：已移除功能的测试文件不存在', () => {
  for (const name of FORBIDDEN_TESTS) {
    assert.ok(!existsSync(join(root, 'test', name)), 'test/' + name + ' 仍存在');
  }
});

test('打包：electron-builder.yml 仅 Windows x64、不再打包已移除模块、命名 AIO v1', () => {
  const yml = read('electron-builder.yml');
  assert.ok(!yml.includes('client-updater.js'));
  assert.ok(!yml.includes('session-watcher.js'));
  assert.ok(yml.includes('productName: DSHEAC AIO'));
  assert.ok(yml.includes('appId: com.deepseek.dsh.desktop.aio'));
  assert.ok(yml.includes('artifactName: DSHEAC-AIO-v1-Setup-${arch}.${ext}'));
  const winArch = yml.match(/win:\s*\r?\n(?:  [^\n]*\r?\n)*?    -\s*target: (\w+)\s*\r?\n\s*arch:\s*\r?\n\s*-\s*(\w+)/);
  assert.ok(winArch, 'win 目标应显式声明 arch');
  assert.equal(winArch[2], 'x64');
  assert.ok(!yml.includes('linux:'));
  assert.ok(!yml.includes('mac'));
});

test('打包：package.json 使用 AIO v1 发布标识、无客户端自更新脚本', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'dsh-desktop-aio');
  assert.equal(pkg.productName, 'DSHEAC AIO');
  assert.equal(pkg.version, '1.0.0');
  assert.ok(!JSON.stringify(pkg.scripts).includes('client-update'));
  assert.ok(!JSON.stringify(pkg.scripts).includes('check-client-latest'));
});

test('保留：核心壳层模块齐全', () => {
  for (const rel of [
    'balance.js', 'updater.js', 'plugin-updater.js', 'plugin-guard.js', 'profile-module-heal.js',
    'builtin-collision.js', 'plugin-manager-state.js', 'patch-row-heal.js',
    'preset-sync.js', 'error-detail.js', 'bundle-integrity.js', 'stable-port.js',
    'koffi-preflight.js', 'renderer-recovery.js', 'watchdog.js',
  ]) {
    assert.ok(existsSync(join(root, rel)), rel + ' 缺失');
  }
});
