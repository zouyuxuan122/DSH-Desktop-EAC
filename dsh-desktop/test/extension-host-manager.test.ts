// VNext Phase 2 回归（Task 10.5 故障注入）：Extension Host Manager 全链路 ——
// init 握手/工具调用往返/外部 kill -9 重启/连续启动失败自动隔离/调用级超时/
// 事件循环卡死判死/权限门 deny-by-default/Rust 缺失降级/Supervisor 崩溃无孤儿
// （KILL_ON_JOB_CLOSE）/内存配额终结。钉住架构文档 §5/§8 与 spec F1/E。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stateMod = require(join(root, 'lib', 'state.js'));
const registry = require(join(root, 'lib', 'supervisor', 'registry.js'));
const installer = require(join(root, 'lib', 'supervisor', 'installer.js'));
const jobFence = require(join(root, 'lib', 'extension-host', 'job-fence.js'));
const { ExtensionHostManager } = require(join(root, 'lib', 'extension-host', 'manager.js'));

const IS_WIN = process.platform === 'win32';
const JOB_MODE = jobFence.fenceMode() === 'win32-job';

/** 受控 DSH_HOME（registry/incidents 均动态读取 state.dshHome）。 */
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'extmgr-'));
  stateMod.state.dshHome = home;
  return home;
}

/** 写一个 SDK 插件源目录并原子安装（返回安装结果）。 */
function installPlugin(home, id, indexJs, pkgExtra = {}) {
  const src = join(home, 'src', id);
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, 'package.json'),
    JSON.stringify({ name: id, version: '1.0.0', main: 'index.js', ...pkgExtra }, null, 2),
  );
  writeFileSync(join(src, 'index.js'), indexJs);
  return installer.installSdkPlugin(id, { srcDir: src, userConsented: true });
}

/** 短周期 Manager（心跳 150ms/超时 400ms/重启延迟 250ms）。 */
function fastManager(extra = {}) {
  return new ExtensionHostManager({
    nodeExe: process.execPath,
    hostBootstrapPath: join(root, 'host-bootstrap.js'),
    heartbeatIntervalMs: 150,
    heartbeatTimeoutMs: 400,
    initTimeoutMs: 8_000,
    restartDelayOverrideMs: 250,
    ...extra,
  });
}

/** 轮询直到条件满足（超时抛错）。 */
async function until(fn, timeoutMs = 15_000, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function entryOf(id) {
  return registry.readRegistry().plugins[id] ?? {};
}

/** pid 是否仍存活（tasklist / kill-0）。 */
function pidAlive(pid) {
  if (!IS_WIN) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').includes(`"${pid}"`);
}

// ---------------------------------------------------------------------------

test('Manager：init 握手 + 工具调用往返 + 状态机 running', async () => {
  const home = freshHome();
  assert.equal(
    installPlugin(home, 'healthy', `
      module.exports.activate = function (ctx) {
        ctx.registerTool('echo', (a) => ({ echo: a.msg }));
        ctx.registerTool('getpid', () => process.pid);
      };
    `).ok,
    true,
  );
  const mgr = fastManager();
  try {
    assert.equal(await mgr.startPlugin('healthy'), true);
    assert.equal(entryOf('healthy').state, 'running', 'init 成功后注册表应为 running');
    assert.deepEqual(
      mgr.toolMetas('healthy').map((t) => t.name).sort(),
      ['echo', 'getpid'],
    );
    const r = await mgr.invoke('healthy', 'echo', { msg: '你好' });
    assert.deepEqual(r, { echo: '你好' });
    const pid = await mgr.invoke('healthy', 'getpid');
    assert.ok(typeof pid === 'number' && pid > 0);
    assert.equal(mgr.runningIds().includes('healthy'), true);
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Manager：外部 kill -9 → crash/retrying → 自动重启恢复 running', async () => {
  const home = freshHome();
  assert.equal(
    installPlugin(home, 'victim', `
      module.exports.activate = function (ctx) {
        ctx.registerTool('getpid', () => process.pid);
      };
    `).ok,
    true,
  );
  const mgr = fastManager();
  try {
    assert.equal(await mgr.startPlugin('victim'), true);
    const pid1 = await mgr.invoke('victim', 'getpid');
    // kill -9（Windows: TerminateProcess）—— 不给 Host 任何收尾机会。
    process.kill(pid1, 'SIGKILL');
    await until(() => entryOf('victim').crashStreak >= 1, 10_000);
    assert.equal(entryOf('victim').state, 'retrying');
    // 同时等「新 pid + 状态回到 running」：invoke 在 init 握手完成前就可达
    // （hosts 表先行登记），单看 pid 会踩到 started 转移前的窗口。
    await until(async () => {
      const pid = await mgr.invoke('victim', 'getpid').catch(() => 0);
      return pid !== pid1 && entryOf('victim').state === 'running';
    }, 15_000);
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Manager：残留 running 态（上次会话异常退出）→ 崩溃对账 → 自动重启恢复', async () => {
  const home = freshHome();
  assert.equal(
    installPlugin(home, 'stale', `
      module.exports.activate = function (ctx) {
        ctx.registerTool('getpid', () => process.pid);
      };
    `).ok,
    true,
  );
  // 模拟上次会话异常终止：sidecar 被杀时插件正处 running，注册表留下 stale 标记。
  const reg = registry.readRegistry();
  reg.plugins['stale'].state = 'running';
  registry.writeRegistry(reg);
  const mgr = fastManager();
  try {
    assert.equal(entryOf('stale').state, 'running', '前置：残留 running');
    assert.equal(await mgr.startPlugin('stale'), true, '残留 running 应被对账并拉起');
    assert.equal(entryOf('stale').state, 'running', '对账后重启恢复 running');
    const pid = await mgr.invoke('stale', 'getpid');
    assert.ok(typeof pid === 'number' && pid > 0, 'Host 实际存活');
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Manager：连续启动失败 3 次 → 自动隔离并停手', async () => {
  const home = freshHome();
  assert.equal(
    installPlugin(home, 'badboot', `
      module.exports.activate = function () { throw new Error('activate 必炸'); };
    `).ok,
    true,
  );
  const mgr = fastManager();
  try {
    assert.equal(await mgr.startPlugin('badboot'), false, '首次启动即失败');
    // 退避被测试模式清空（250ms/次），阈值 3 次后应隔离并停止重试。
    await until(() => entryOf('badboot').state === 'quarantined', 20_000, 100);
    assert.equal(entryOf('badboot').crashStreak >= 3, true);
    assert.equal(mgr.runningIds().length, 0, '隔离后不得有 Host 存活');
    // 隔离后不再拉起：等两个重试周期仍为 quarantined。
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(entryOf('badboot').state, 'quarantined');
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Manager：调用级严格超时 —— 工具 hang 不回包时 invoke 拒绝且 Host 存活', async () => {
  const home = freshHome();
  assert.equal(
    installPlugin(home, 'slowpoke', `
      module.exports.activate = function (ctx) {
        ctx.registerTool('echo', (a) => ({ echo: a.msg }));
        ctx.registerTool('hang', () => new Promise(() => {}));
      };
    `).ok,
    true,
  );
  const mgr = fastManager();
  try {
    assert.equal(await mgr.startPlugin('slowpoke'), true);
    await assert.rejects(mgr.invoke('slowpoke', 'hang', undefined, 400), /超时/);
    // 卡死的只是这次调用：Host 与其他工具不受影响。
    const r = await mgr.invoke('slowpoke', 'echo', { msg: 'still-alive' });
    assert.deepEqual(r, { echo: 'still-alive' });
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Manager：事件循环死循环 → 心跳超时判死 → 重启恢复', async () => {
  const home = freshHome();
  assert.equal(
    installPlugin(home, 'spinner', `
      module.exports.activate = function (ctx) {
        ctx.registerTool('getpid', () => process.pid);
        ctx.registerTool('block', () => { const end = Date.now() + 5000; while (Date.now() < end) {} });
      };
    `).ok,
    true,
  );
  const mgr = fastManager();
  try {
    assert.equal(await mgr.startPlugin('spinner'), true);
    const pid1 = await mgr.invoke('spinner', 'getpid');
    void mgr.invoke('spinner', 'block', undefined, 20_000).catch(() => {});
    // 事件循环被堵 → ping 超时 → 判死 → crash(retrying) → 重启换新 pid。
    await until(() => entryOf('spinner').crashStreak >= 1, 15_000);
    await until(async () => {
      const pid = await mgr.invoke('spinner', 'getpid').catch(() => 0);
      return pid !== pid1 && entryOf('spinner').state === 'running';
    }, 20_000);
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('权限门：deny-by-default —— 未声明能力不可见，fs 限数据目录', async () => {
  const home = freshHome();
  assert.equal(
    installPlugin(home, 'minimal', `
      module.exports.activate = function (ctx) {
        ctx.registerTool('probe', () => ({
          net: typeof ctx.net, shell: typeof ctx.shell, env: typeof ctx.env, fs: typeof ctx.fs,
        }));
        ctx.registerTool('fs-escape', () => {
          try { ctx.fs.readFile('C:/Windows/win.ini'); return 'LEAK'; } catch { return 'DENIED'; }
        });
        ctx.registerTool('fs-data-ok', () => {
          ctx.fs.writeFile(ctx.dataDir + '/x.txt', 'ok');
          return ctx.fs.readFile(ctx.dataDir + '/x.txt');
        });
      };
    `).ok,
    true,
  );
  const mgr = fastManager();
  try {
    assert.equal(await mgr.startPlugin('minimal'), true);
    const probe = await mgr.invoke('minimal', 'probe');
    assert.deepEqual(probe, { net: 'undefined', shell: 'undefined', env: 'undefined', fs: 'object' });
    assert.equal(await mgr.invoke('minimal', 'fs-escape'), 'DENIED', '白名单外读取必须被拒');
    assert.equal(await mgr.invoke('minimal', 'fs-data-ok'), 'ok', '数据目录内读写可用');
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('降级路径：Rust 模块不可用时平台进程围栏仍可完整运行', async () => {
  jobFence._forceNativeUnavailableForTest(true);
  const home = freshHome();
  try {
    assert.equal(jobFence.fenceMode(), IS_WIN ? 'taskkill-fallback' : 'process-group');
    assert.equal(
      installPlugin(home, 'fenced', `
        module.exports.activate = function (ctx) {
          ctx.registerTool('echo', (a) => ({ echo: a.msg }));
          ctx.registerTool('getpid', () => process.pid);
        };
      `).ok,
      true,
    );
    const mgr = fastManager();
    assert.equal(mgr.fenceMode(), IS_WIN ? 'taskkill-fallback' : 'process-group');
    try {
      assert.equal(await mgr.startPlugin('fenced'), true);
      assert.equal(entryOf('fenced').state, 'running');
      const r = await mgr.invoke('fenced', 'echo', { msg: 'fallback' });
      assert.deepEqual(r, { echo: 'fallback' });
      const pid = await mgr.invoke('fenced', 'getpid');
      await mgr.stopPlugin('fenced');
      await until(() => !pidAlive(pid), 5_000, 100);
    } finally {
      await mgr.shutdownAll();
    }
  } finally {
    jobFence._forceNativeUnavailableForTest(false);
    rmSync(home, { recursive: true, force: true });
  }
});

test('内存围栏：插件超配额仅终结该 Host（win32-job 模式）', { skip: !IS_WIN || !JOB_MODE }, async () => {
  const home = freshHome();
  assert.equal(
    installPlugin(home, 'balloon', `
      module.exports.activate = function (ctx) {
        ctx.registerTool('getpid', () => process.pid);
        ctx.registerTool('balloon', () => {
          const keep = [];
          for (;;) keep.push(new Array(1e6).fill(0xdeadbeef));
        });
      };
    `).ok,
    true,
  );
  const mgr = fastManager({ memoryLimitBytes: 320 * 1024 * 1024 });
  try {
    assert.equal(await mgr.startPlugin('balloon'), true);
    void mgr.invoke('balloon', 'balloon', undefined, 30_000).catch(() => {});
    // 超配额 → OS 拒绝提交 → V8 fatal OOM → Host 退出 → crash 处置。
    await until(() => entryOf('balloon').crashStreak >= 1, 30_000, 200);
    assert.ok(['retrying', 'quarantined', 'running'].includes(String(entryOf('balloon').state)));
    // 核心测试进程不受影响（本断言能执行即证明）。
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Supervisor 崩溃无孤儿：Job 句柄随进程关闭整树回收（win32-job 模式）', { skip: !IS_WIN || !JOB_MODE }, async () => {
  const driver = spawn(process.execPath, [join(root, 'test', 'fixtures', 'vnext-orphans-driver.cjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let info = null;
  const line = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('driver 无输出超时: ' + buf)), 25_000);
    driver.stdout.on('data', (c) => {
      buf += c.toString();
      const m = buf.match(/ORPHANS (.+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    driver.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('driver 提前退出: ' + buf));
    });
  });
  try {
    info = JSON.parse(await line);
    assert.ok(info.hostPid && info.grandchildPid, 'driver 必须报告 host/grandchild pid: ' + JSON.stringify(info));
    assert.equal(pidAlive(info.hostPid), true, 'Host 应存活');
    assert.equal(pidAlive(info.grandchildPid), true, '孙进程应存活');
    // 模拟 Supervisor 崩溃：只杀 driver 本体（无 /T 树杀、无清理回调）。
    const killed = spawnSync('taskkill', ['/PID', String(driver.pid), '/F'], { windowsHide: true });
    assert.equal(killed.status, 0, 'taskkill driver 失败');
    // KILL_ON_JOB_CLOSE：OS 应回收 Host 及其派生的孙进程。
    await until(() => !pidAlive(info.hostPid), 10_000, 150);
    await until(() => !pidAlive(info.grandchildPid), 10_000, 150);
  } finally {
    if (driver.exitCode === null) {
      try {
        spawnSync('taskkill', ['/PID', String(driver.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* 已退出 */
      }
    }
  }
});
