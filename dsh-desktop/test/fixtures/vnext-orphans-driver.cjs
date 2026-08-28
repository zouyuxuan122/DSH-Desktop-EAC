// VNext Phase 2 孤儿回收测试的 Supervisor 替身（仅测试用）。
//
// 行为：装一个「会派生孙进程」的 SDK 插件 → 拉起 Host → 让插件 spawn 一个
// 60 秒的 ping 孙进程 → 打印两行 PID 到 stdout → 挂住等测试进程 kill 自己
// （模拟 Supervisor 崩溃，不给任何清理机会）。随后若 Job 围栏生效
// （KILL_ON_JOB_CLOSE），OS 应自动回收 Host 与孙进程。
'use strict';

const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = join(__dirname, '..', '..');
const state = require(join(root, 'lib', 'state.js')).state;
const home = mkdtempSync(join(tmpdir(), 'orph-'));
state.dshHome = home;

const installer = require(join(root, 'lib', 'supervisor', 'installer.js'));
const src = join(home, 'src');
mkdirSync(src, { recursive: true });
writeFileSync(
  join(src, 'package.json'),
  JSON.stringify({ name: 'spawner', version: '1.0.0', main: 'index.js' }),
);
// 注意：插件用裸 require('node:child_process') 派生孙进程 —— 这正是权限门
// 「诚实边界」的写照（SDK 面未授权 shell 不可见，但硬沙箱在 Phase 4）。
// 本测试钉的是 OS 级围栏：即便插件越过 SDK 面派生子进程，Job 也能整树回收。
writeFileSync(
  join(src, 'index.js'),
  [
    "const { spawn } = require('node:child_process');",
    'module.exports.activate = function (ctx) {',
    "  ctx.registerTool('getpid', () => process.pid);",
    "  ctx.registerTool('spawn-grandchild', () => {",
    "    const c = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });",
    '    return c.pid;',
    '  });',
    '};',
  ].join('\n'),
);

const r = installer.installSdkPlugin('spawner', { srcDir: src, userConsented: true });
if (!r.ok) {
  console.log('ORPHANS ' + JSON.stringify({ error: 'install: ' + r.error }));
} else {
  const { ExtensionHostManager } = require(join(root, 'lib', 'extension-host', 'manager.js'));
  const mgr = new ExtensionHostManager({
    nodeExe: process.execPath,
    hostBootstrapPath: join(root, 'host-bootstrap.js'),
  });
  mgr.startPlugin('spawner')
    .then(async (ok) => {
      if (!ok) throw new Error('startPlugin failed');
      const hostPid = await mgr.invoke('spawner', 'getpid');
      const grandchildPid = await mgr.invoke('spawner', 'spawn-grandchild');
      console.log('ORPHANS ' + JSON.stringify({ hostPid, grandchildPid }));
    })
    .catch((e) => console.log('ORPHANS ' + JSON.stringify({ error: String(e && e.message) })));
}
// 挂住：等测试杀掉本进程（模拟 Supervisor 崩溃，无清理机会）。
setInterval(() => {}, 60_000);
