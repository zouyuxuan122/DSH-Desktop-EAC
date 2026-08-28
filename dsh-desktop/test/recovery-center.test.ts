// VNext 恢复中心回归（vnext-absorb Tauri 适配版）。
//
// 重构版为 Electron BrowserWindow + ipcMain，测试断言 lib/tray.ts / lib/boot.ts
// 等文件；本地 Tauri 三层架构下：
//   - 窗口由 Rust 壳创建（main.rs open_recovery_center_window + 托盘项），
//   - 页面经 http_serve /recovery-center 注入专用 preload（window.rc），
//   - 动作分发在 sidecar 的 rc.action 方法（lib/recovery-center/register.ts
//     handleRcAction）。
// 这里把「三入口/单通道/安全模式」的源码断言改为对本架构对应文件的断言，
// 保留注册表行为单元（与重构版同源）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf8');

test('恢复中心三入口（Tauri 版）：托盘菜单 / 启动失败链 / 环境变量直开', () => {
  const mainRs = read('..', 'tauri-shell', 'src', 'main.rs');
  const serverTs = read('..', 'tauri-shell', 'sidecar', 'server.ts');
  // 入口 1：Rust 托盘常驻菜单「恢复中心…」→ open_recovery_center_window。
  assert.ok(/MenuItem::with_id\(app, "recovery", ui_text\("恢复中心…", "Recovery Center\.\.\."\)/.test(mainRs), 'localized tray menu entry missing');
  assert.ok(/"recovery" => \{\s*\n\s*open_recovery_center_window\(app\)/.test(mainRs), 'tray item must open RC window');
  // 入口 3：DSH_DESKTOP_RECOVERY=1 直开恢复中心（Rust 侧）并跳过常规 boot（sidecar 侧）。
  assert.ok(/DSH_DESKTOP_RECOVERY/.test(mainRs), 'env entry missing in main.rs');
  assert.ok(/DSH_DESKTOP_RECOVERY === '1'/.test(serverTs), 'sidecar must short-circuit boot in recovery mode');
  // 入口 2（启动失败链）：boot.failed 通知存在（Rust 通知处理器可据此拉起恢复中心）。
  assert.ok(/boot\.failed/.test(serverTs), 'boot.failed notify missing');
  // 恢复中心不依赖 dsh web：rc.action 分发走 handleRcAction，restart 走注入 ctx。
  const rcSrc = read('lib', 'recovery-center', 'register.ts');
  assert.ok(/handleRcAction/.test(rcSrc), 'handleRcAction missing');
  assert.ok(!/from '\.\.\/desktop\/boot-server\.js'/.test(rcSrc) || /bootState/.test(rcSrc));
});

test('恢复中心页面与 preload 存在且不依赖 Web UI', () => {
  assert.ok(existsSync(join(root, 'assets', 'recovery-center.html')), 'recovery-center.html missing');
  const preload = read('assets', 'recovery-center-preload.js');
  assert.ok(preload.includes('rc.action'), 'preload must expose rc.action');
  assert.ok(!preload.includes("'dsh:"), 'recovery-center preload must not touch Web UI channels');
});

test('恢复中心单通道 rc.action：sidecar 方法分发 + 白名单动作', () => {
  const serverTs = read('..', 'tauri-shell', 'sidecar', 'server.ts');
  assert.ok(/'rc\.action'/.test(serverTs), 'sidecar must mount rc.action');
  assert.ok(/recoveryCenter\.handleRcAction/.test(serverTs), 'rc.action must dispatch to handleRcAction');
  const rcSrc = read('lib', 'recovery-center', 'register.ts');
  assert.ok(/case 'status'/.test(rcSrc), 'status action missing');
  assert.ok(/case 'safe-mode'/.test(rcSrc), 'safe-mode action missing');
  assert.ok(/case 'rollback-last-good'/.test(rcSrc), 'rollback action missing');
});

test('扩展注册表：档案登记/失败归因/隔离标记（与重构版同源行为单元）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-reg-'));
  try {
    // 用受控 DSH_HOME 跑编译产物（registry.js 仅依赖 state.dshHome/env，不触 Electron）。
    process.env.DSH_HOME = join(dir, 'home');
    delete require.cache[require.resolve(join(root, 'lib', 'state.js'))];
    delete require.cache[require.resolve(join(root, 'lib', 'supervisor', 'registry.js'))];
    const stateMod = require(join(root, 'lib', 'state.js')) as { state: { dshHome: string } };
    stateMod.state.dshHome = process.env.DSH_HOME as string;
    const reg = require(join(root, 'lib', 'supervisor', 'registry.js')) as {
      registryPath(): string;
      upsertLegacyPlugin(p: { id: string; source: 'builtin' | 'market'; enabled?: boolean }): void;
      recordStartFailure(id: string, error: string): void;
      clearStartFailure(id: string): void;
      setQuarantined(id: string, q: boolean): boolean;
      listRegistryEntries(): { id: string; risk: string; kind: string; source: string; state: string; lastError?: string; lastErrorAt?: string }[];
    };
    // 防呆：受控 home 未生效时宁可失败，也不得读写真实 ~/.dsh。
    assert.ok(reg.registryPath().startsWith(process.env.DSH_HOME as string), `受控 DSH_HOME 未生效: ${reg.registryPath()}`);

    reg.upsertLegacyPlugin({ id: 'dsh-pet', source: 'builtin' });
    reg.upsertLegacyPlugin({ id: 'cool-tool', source: 'market', enabled: true });
    let list = reg.listRegistryEntries();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, 'cool-tool');
    assert.equal(list[0]!.risk, 'legacy-cordis');
    assert.equal(list[0]!.kind, 'legacy');
    assert.equal(list[1]!.source, 'builtin');

    reg.recordStartFailure('dsh-pet', 'TypeError: cannot read fullRoot');
    list = reg.listRegistryEntries();
    const pet = list.find((p) => p.id === 'dsh-pet');
    assert.equal(pet!.state, 'failed');
    assert.ok(pet!.lastError!.includes('fullRoot'));
    assert.ok(pet!.lastErrorAt);

    reg.clearStartFailure('dsh-pet');
    list = reg.listRegistryEntries();
    assert.equal(list.find((p) => p.id === 'dsh-pet')!.state, 'installed');

    assert.ok(reg.setQuarantined('cool-tool', true));
    assert.equal(reg.listRegistryEntries().find((p) => p.id === 'cool-tool')!.state, 'quarantined');
    assert.ok(reg.setQuarantined('cool-tool', false));
    assert.equal(reg.listRegistryEntries().find((p) => p.id === 'cool-tool')!.state, 'installed');

    // 损坏注册表降级为空表（恢复中心必须永不因注册表损坏而不可用）。
    writeFileSync(reg.registryPath(), '{broken json');
    assert.deepEqual(reg.listRegistryEntries(), []);
  } finally {
    delete process.env.DSH_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('安全模式：非核心插件强制禁用（companion-sync 守卫 + 恢复中心动作）', () => {
  const syncSrc = read('lib', 'desktop', 'companion-sync.ts');
  assert.ok(/safeModeActive/.test(syncSrc), 'safe-mode guard missing in companion-sync');
  const rcSrc = read('lib', 'recovery-center', 'register.ts');
  assert.ok(/safeModePatch/.test(rcSrc), 'recovery-center safe-mode must patch to core-only rows');
  assert.ok(/safe-mode\.json/.test(rcSrc), 'safe-mode must persist state file');
});
