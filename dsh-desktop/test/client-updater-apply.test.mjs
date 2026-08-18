// TDD regression tests for the apply-update.cmd script generation (issue #8).
//
// Bug: the installer-branch script waited for the app process to exit with NO
// timeout and NO force-kill. Tray apps keep the process alive after the window
// closes, so :wait never ended, the new Setup never ran, and the 174 MB
// installer plus script leaked forever in updates\. Users saw "重启以应用"
// do nothing in a loop.
//
// The fix, tested here:
//   1. bounded wait (~30s) then force-kill via taskkill /F /T
//   2. every phase appends to a log file next to the script
//   3. the Setup exit code is checked; on failure the old app is relaunched
//      and the installer + log are KEPT for diagnosis (no silent residue loop)
//   4. cleanup only happens on success
//   5. script lines are CRLF-joined pure ASCII

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApplyScript, buildSpawnCommandLine } from '../client-updater.js';

const CTX = { userDataDir: 'C:\\userData' };

// 黑窗卡死反馈（v3.0.1/v4.0.0 存量用户）：安装版分支用
// tasklist | find 管道轮询旧进程是否退出。detached 控制台下该管道偶发挂死
// （find 等不到写端 EOF），脚本停在等待循环里永远走不到运行 Setup ——
// 用户看到一个纯黑 cmd 窗口反复弹出且无反应；主进程 spawn 本脚本约 0.4s
// 后 app.exit(0)，且 spawn 前 killTreeAndWait 已等完 dsh web 进程树，
// 轮询检测本就是冗余保险。修复 = 去掉检测：固定短等待 → 无条件兜底强杀
// → 线性推进到 Setup，全程无管道、无回跳循环，总时长有界（约 6s）。
test('installer branch is hang-proof: no tasklist|find pipe, no wait loop, bounded linear flow', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: false });
  const joined = lines.join('\n');

  // 不得再出现管道式进程检测（挂死根源）
  assert.doesNotMatch(joined, /tasklist/i, 'must not use tasklist detection');
  assert.doesNotMatch(joined, /\bfind\b/i, 'must not pipe into find.exe');
  // 不得存在回跳等待循环：脚本必须线性推进到 Setup
  assert.doesNotMatch(joined, /goto\s+:?wait/i, 'no wait loop may exist');
  // 兜底强杀必须在运行 Setup 之前
  const killIdx = lines.findIndex((l) => /taskkill\s+\/F\s+\/T\s+\/IM/.test(l));
  const setupIdx = lines.findIndex((l) => /^call "%SETUP%"/.test(l.trim()));
  assert.ok(killIdx >= 0, 'must force-kill leftover app processes');
  assert.ok(setupIdx > killIdx, 'setup must run after the force-kill');
  // 延时只能用自终止的 ping -n，且次数必须小而有界
  const pings = [...joined.matchAll(/ping\s+-n\s+(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(pings.length >= 1, 'settle delays expected');
  for (const n of pings) assert.ok(n > 0 && n <= 10, 'ping delays must be small and bounded, got ' + n);
});

test('script writes a log file and records the setup exit code', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: false });
  const joined = lines.join('\n');
  assert.match(joined, /apply-update\.log/, 'must reference a log file');
  // log lines are appended with >>
  const logLines = lines.filter((l) => l.includes('>>'));
  assert.ok(logLines.length >= 3, 'must log wait/kill/run phases, got ' + logLines.length);
  // setup exit code recorded into the log
  assert.match(joined, /errorlevel/i);
  const exitLogLine = lines.find((l) => /exit code/.test(l));
  assert.ok(exitLogLine, 'must have an exit-code log line');
  assert.match(exitLogLine, />>\s*"%LOG%"/, 'exit code must be appended to the log');
});

test('on setup failure the old app is relaunched and artifacts are kept', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: false });
  const joined = lines.join('\n');
  const failIdx = lines.findIndex((l) => /^:failed$/i.test(l.trim()));
  assert.ok(failIdx >= 0, 'must have a :failed label');
  const afterFail = lines.slice(failIdx).join('\n');
  assert.match(afterFail, /start\s+""\s+"%OLD%"/i, 'failed update must relaunch the old app');
  // and must NOT delete the setup in the failure path
  assert.doesNotMatch(afterFail, /del\s+"%SETUP%"/i, 'failure path must keep the installer for diagnosis');
});

test('cleanup of setup+script only happens on the success path', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: false });
  const successIdx = lines.findIndex((l) => /^:success$/i.test(l.trim()));
  assert.ok(successIdx >= 0, 'must have a :success label');
  const afterSuccess = lines.slice(successIdx).join('\n');
  assert.match(afterSuccess, /del\s+"%SETUP%"/i, 'success path must delete the installer');
  assert.match(afterSuccess, /del\s+"%~f0"/i, 'success path must delete the script itself');
});

test('portable branch keeps backup/replace/restore semantics and gains the same bounded wait', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\new.exe', oldExe: 'D:\\portable\\app.exe', portable: true });
  const joined = lines.join('\n');
  assert.match(joined, /OLD%\.bak/, 'portable branch must still back up the old exe');
  assert.match(joined, /copy\s+\/y\s+"%NEW%"\s+"%OLD%"/i, 'portable branch must still replace in place');
  assert.match(joined, /gtr\s+\d+/, 'portable wait must be bounded too');
  assert.match(joined, /apply-update\.log/, 'portable branch must log too');
});

test('all generated lines are ASCII with no bare CRLF inside line content', () => {
  for (const variant of [true, false]) {
    const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: variant });
    for (const line of lines) {
      assert.ok(/^[\x20-\x7E]*$/.test(line), 'non-ASCII line in script: ' + JSON.stringify(line));
      assert.doesNotMatch(line, /\r|\n/, 'embedded newline in line: ' + JSON.stringify(line));
    }
  }
});

// v2.0.x 回归（蓝七反馈“点立即重启没反应”）：spawn('cmd.exe', ['/c', script,
// ...args]) 让 Node 给含空格参数加引号，cmd /c 剥掉首尾引号后路径在空格处
// 断开（'C:\...\Deepseek' is not recognized），且 stdio:'ignore' 吞掉报错 →
// apply-update.cmd 静默不执行。修复 = /d /s /c + windowsVerbatimArguments +
// 整行外层再包一对引号（/s 剥外层后还原标准参数行）。
test('spawn command line wraps the whole arg row in an extra outer quote pair', () => {
  const script = 'C:\\Users\\a b\\AppData\\Roaming\\Deepseek Harness EAC\\updates\\apply-update.cmd';
  const args = [
    'C:\\Users\\a b\\AppData\\Roaming\\Deepseek Harness EAC\\updates\\Deepseek-Harness-EAC-Setup-x64.exe',
    'Deepseek Harness EAC.exe',
  ];
  const line = buildSpawnCommandLine(script, args);
  // 期望形式：""script" "arg1" "arg2"" —— /s 剥外层后还原为每参数带引号的标准行
  assert.equal(line, '"' + [script, ...args].map((a) => `"${a}"`).join(' ') + '"');
});

// 端到端验证「能正常更新」：用生成的真实脚本 + 伪装存活应用（复制的
// ping.exe 改名后跑 60s）+ 伪装 Setup（写标记文件退出 0），走生产同款
// spawn 路径（cmd /d /s /c + 整行引用）。断言：强杀残留进程 → Setup 被
// 执行 → 成功路径清理（删安装包 + 自删）→ 日志完整 → 全程有界不挂死。
test('installer script end-to-end: kills a live fake app, runs the setup, cleans up on success', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apply-'));
  try {
    const fakeExeName = 'fake-dsh-eac-test.exe';
    const fakeAppExe = path.join(dir, fakeExeName);
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe'), fakeAppExe);
    const appProc = spawn(fakeAppExe, ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    const appExited = new Promise((r) => appProc.once('exit', r));

    const marker = path.join(dir, 'setup-ran.ok');
    const fakeSetup = path.join(dir, 'fake-setup.cmd');
    fs.writeFileSync(fakeSetup, `@echo off\r\necho ran> "${marker}"\r\nexit /b 0\r\n`);
    const script = path.join(dir, 'apply-update.cmd');
    fs.writeFileSync(script, buildApplyScript({ newExe: fakeSetup, oldExe: 'C:\\Programs\\app\\app.exe', portable: false }).join('\r\n'));
    await new Promise((r) => setTimeout(r, 500)); // 等伪装应用真正跑起来

    const t0 = Date.now();
    const line = buildSpawnCommandLine(script, [fakeSetup, fakeExeName, 'C:\\Programs\\app\\app.exe']);
    const run = spawn('cmd.exe', ['/d', '/s', '/c', line], {
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    const code = await new Promise((resolve, reject) => {
      const killer = setTimeout(() => {
        try { run.kill(); } catch { /* already gone */ }
        reject(new Error('apply-update script did not exit within 45s (hang regression)'));
      }, 45000);
      run.on('exit', (c) => { clearTimeout(killer); resolve(c); });
    });

    assert.equal(code, 0, 'script must exit 0 on the success path');
    assert.ok(fs.existsSync(marker), 'the setup must have been executed');
    if (appProc.exitCode === null) await Promise.race([appExited, new Promise((r) => setTimeout(r, 2000))]);
    assert.ok(appProc.exitCode !== null, 'the live fake app must have been force-killed');
    assert.ok(!fs.existsSync(fakeSetup), 'success path must delete the installer');
    assert.ok(!fs.existsSync(script), 'success path must self-delete the script');
    const log = fs.readFileSync(path.join(dir, 'apply-update.log'), 'utf8');
    assert.match(log, /apply-update start/);
    assert.match(log, /running setup/);
    assert.match(log, /update applied/);
    assert.ok(Date.now() - t0 < 20000, 'whole flow must stay bounded and quick, took ' + (Date.now() - t0) + 'ms');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
