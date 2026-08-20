// VNext Phase 0（恢复中心）回归：三入口接线、扩展注册表档案、安全模式、
// 市场覆盖围栏。源码断言钉住架构文档 §9 Phase 0 交付标准：
// 「任意 plugin tree 启动失败时，用户必定能打开 Recovery Center 并关闭问题插件」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

test('恢复中心三入口：托盘 / 启动失败链 / 环境变量直开', () => {
  const traySrc = read('lib', 'tray.ts');
  const bootSrc = read('lib', 'boot.ts');
  const rcSrc = read('lib', 'recovery-center', 'register.ts');
  // 入口 1：托盘常驻菜单。
  assert.ok(/恢复中心….*openRecoveryCenter/.test(traySrc.replace(/\n\s*/g, ' ')), 'tray menu entry missing');
  // 入口 2：handleBootFailure 与 fatal 的失败对话框首按钮。
  assert.ok((bootSrc.match(/打开恢复中心/g) || []).length >= 3, `failure dialogs must offer recovery center, found ${(bootSrc.match(/打开恢复中心/g) || []).length}`);
  // 入口 3：DSH_DESKTOP_RECOVERY=1 直开并跳过常规 boot。
  assert.ok(/DSH_DESKTOP_RECOVERY === '1'/.test(bootSrc), 'env entry missing');
  assert.ok(/openRecoveryCenter\(\);\s*\n\s*return;/.test(bootSrc), 'env entry must skip normal boot chain');
  // 恢复中心不依赖 dsh web：rc 模块不得 import server 的启动族（restartWebServiceCore 除外，用于中心内重试）。
  assert.ok(!/from '\.\.\/server\.js'/.test(rcSrc) || /restartWebServiceCore/.test(rcSrc));
});

test('恢复中心页面与 preload 存在且不依赖 Web UI', () => {
  assert.ok(existsSync(join(root, 'assets', 'recovery-center.html')), 'recovery-center.html missing');
  const preload = read('assets', 'recovery-center-preload.js');
  assert.ok(preload.includes('rc:action'), 'preload must expose rc:action only');
  assert.ok(!preload.includes('dsh:'), 'recovery-center preload must not touch Web UI channels');
});

test('恢复中心 IPC 单通道 rc:action，来源校验为恢复中心窗口自身', () => {
  const rcSrc = read('lib', 'recovery-center', 'register.ts');
  assert.ok(rcSrc.includes("ipcMain.handle('rc:action'"), 'rc:action missing');
  assert.ok(/fromRecoveryWindow/.test(rcSrc), 'sender check missing');
});

test('扩展注册表：档案登记/失败归因/隔离标记（Phase 0 行为单元）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-reg-'));
  try {
    // 用受控 DSH_HOME 跑编译产物（registry.js 仅依赖 state.dshHome/env，不触 Electron）。
    process.env.DSH_HOME = join(dir, 'home');
    delete require.cache[require.resolve(join(root, 'lib', 'state.js'))];
    delete require.cache[require.resolve(join(root, 'lib', 'supervisor', 'registry.js'))];
    const stateMod = require(join(root, 'lib', 'state.js'));
    stateMod.state.dshHome = process.env.DSH_HOME;
    const reg = require(join(root, 'lib', 'supervisor', 'registry.js'));
    // 防呆：受控 home 未生效时宁可失败，也不得读写真实 ~/.dsh。
    assert.ok(reg.registryPath().startsWith(process.env.DSH_HOME), `受控 DSH_HOME 未生效: ${reg.registryPath()}`);

    reg.upsertLegacyPlugin({ id: 'dsh-pet', source: 'builtin' });
    reg.upsertLegacyPlugin({ id: 'cool-tool', source: 'market', enabled: true });
    let list = reg.listRegistryEntries();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'cool-tool');
    assert.equal(list[0].risk, 'legacy-cordis');
    assert.equal(list[0].kind, 'legacy');
    assert.equal(list[1].source, 'builtin');

    reg.recordStartFailure('dsh-pet', 'TypeError: cannot read fullRoot');
    list = reg.listRegistryEntries();
    const pet = list.find((p) => p.id === 'dsh-pet');
    assert.equal(pet.state, 'failed');
    assert.ok(pet.lastError.includes('fullRoot'));
    assert.ok(pet.lastErrorAt);

    reg.clearStartFailure('dsh-pet');
    list = reg.listRegistryEntries();
    assert.equal(list.find((p) => p.id === 'dsh-pet').state, 'installed');

    assert.ok(reg.setQuarantined('cool-tool', true));
    assert.equal(reg.listRegistryEntries().find((p) => p.id === 'cool-tool').state, 'quarantined');
    assert.ok(reg.setQuarantined('cool-tool', false));
    assert.equal(reg.listRegistryEntries().find((p) => p.id === 'cool-tool').state, 'installed');

    // 损坏注册表降级为空表（恢复中心必须永不因注册表损坏而不可用）。
    writeFileSync(reg.registryPath(), '{broken json');
    assert.deepEqual(reg.listRegistryEntries(), []);
  } finally {
    delete process.env.DSH_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('安全模式：非核心插件强制禁用（新行与既有启用行）', () => {
  const pluginsSrc = read('lib', 'plugins.ts');
  assert.ok(/DSH_DESKTOP_SAFE_MODE === '1'/.test(pluginsSrc), 'safe-mode flag missing');
  assert.ok(/disabledBySafeMode/.test(pluginsSrc), 'safe-mode must force-disable non-core new rows');
  assert.ok(/安全模式：已禁用插件/.test(pluginsSrc), 'safe-mode must rewrite existing enabled rows');
});

test('市场覆盖围栏：市场同名包由内置接管（builtin-collision 预检路径保持）', () => {
  const pluginsSrc = read('lib', 'plugins.ts');
  assert.ok(/patchHasForeignRows/.test(pluginsSrc), 'market residue precheck missing');
  assert.ok(/removeMarketDuplicate/.test(pluginsSrc), 'builtin takeover missing');
  assert.ok(/builtin-migrate:/.test(pluginsSrc), 'guard snapshot before migration missing');
});

test('启动失败归因落扩展注册表（Phase 0.3）', () => {
  const bootSrc = read('lib', 'boot.ts');
  assert.ok(/recordStartFailure\(blame\.rowId/.test(bootSrc), 'boot-failure attribution must land in registry');
  assert.ok(/archivePluginProfiles\(\);/.test(bootSrc), 'boot must archive plugin profiles');
});
