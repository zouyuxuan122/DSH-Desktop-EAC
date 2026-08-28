// TDD regression tests for the client self-update helper.
//
// Installed builds use a hidden PowerShell helper that waits for the exact
// Electron PID, force-stops only that PID after a bounded timeout, and then
// invokes the existing backup/rollback/install CMD in the hidden console.
// Portable builds keep the existing CMD backup/replace/rollback flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildApplyScript,
  buildInstalledApplyScript,
  buildInstalledPowerShellArgs,
  buildSpawnCommandLine,
} from '../client-updater.js';

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(
  SYSTEM_ROOT,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

function waitForExit(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`file was not created within ${timeoutMs}ms: ${file}`);
}

function startSleepingPowerShell(seconds = 60) {
  return spawn(POWERSHELL, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Sleep -Seconds ${seconds}`,
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

function runInstalledHelper({
  script,
  actionScript,
  setup,
  oldExe,
  appPid,
  log,
  userDataDir,
  dshHome,
  installDir,
  profileDir,
  currentVersion = '4.4.0',
  newVersion = '4.4.1',
  waitTimeoutSeconds = 20,
  env = process.env,
}) {
  return spawn(POWERSHELL, buildInstalledPowerShellArgs(script, {
    actionScript,
    newExe: setup,
    oldExe,
    userDataDir,
    dshHome,
    installDir,
    profileDir,
    currentVersion,
    newVersion,
    appPid,
    logPath: log,
    waitTimeoutSeconds,
  }), {
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
}

function writeInstalledScripts(dir, {
  setup,
  oldExe,
  userDataDir = dir,
  dshHome = dir,
  installDir = dir,
  profileDir = dir,
  currentVersion = '4.4.0',
  newVersion = '4.4.1',
  nodeExe = '',
} = {}) {
  const actionScript = path.join(dir, 'apply-update.cmd');
  const script = path.join(dir, 'apply-update.ps1');
  fs.writeFileSync(actionScript, buildApplyScript({
    newExe: setup,
    oldExe,
    portable: false,
    userDataDir,
    dshHome,
    installDir,
    profileDir,
    currentVersion,
    newVersion,
    nodeExe,
  }).join('\r\n') + '\r\n');
  fs.writeFileSync(script, buildInstalledApplyScript().join('\r\n') + '\r\n', 'ascii');
  return { script, actionScript };
}

test('installed helper and action avoid the console utilities that caused the hang', () => {
  const helper = buildInstalledApplyScript().join('\n');
  const action = buildApplyScript({
    newExe: 'C:\\updates\\setup.exe',
    oldExe: 'C:\\Programs\\app\\app.exe',
    portable: false,
  }).join('\n');

  for (const content of [helper, action]) {
    assert.doesNotMatch(content, /\bping(?:\.exe)?\b/i);
    assert.doesNotMatch(content, /\bfind(?:\.exe)?\b/i);
    assert.doesNotMatch(content, /\btasklist(?:\.exe)?\b/i);
    assert.doesNotMatch(content, /\btaskkill(?:\.exe)?\b/i);
  }
  assert.match(helper, /Get-Process -Id \$AppPid/);
  assert.match(helper, /Stop-Process -Id \$AppPid -Force/);
  assert.doesNotMatch(helper, /-Name\b|MainModule|ProcessName/i);
});

test('installed helper has bounded waits and synchronously invokes the hidden action', () => {
  const helper = buildInstalledApplyScript().join('\n');
  const action = buildApplyScript({
    newExe: 'C:\\updates\\setup.exe',
    oldExe: 'C:\\Programs\\app\\app.exe',
    portable: false,
  }).join('\n');

  assert.match(helper, /AddSeconds\(\$WaitTimeoutSeconds\)/);
  assert.match(helper, /\$i -lt 25/);
  assert.match(helper, /& \$ActionScriptPath \$SetupPath \$OldExePath/);
  assert.match(helper, /\$LASTEXITCODE/);
  assert.match(helper, /waiting for app exit/);
  assert.match(helper, /update action exit code/);
  assert.match(action, /call "%SETUP%" \/S/);
  assert.match(action, /setup exit code %errorlevel%/);
  assert.match(action, /update applied/);
});

test('installed failure paths keep artifacts and relaunch the old executable', () => {
  const helperLines = buildInstalledApplyScript();
  const catchIdx = helperLines.lastIndexOf('} catch {');
  assert.ok(catchIdx >= 0, 'helper must have a catch block');
  const helperFailure = helperLines.slice(catchIdx).join('\n');
  const actionLines = buildApplyScript({
    newExe: 'C:\\updates\\setup.exe',
    oldExe: 'C:\\Programs\\app\\app.exe',
    portable: false,
  });
  const failedIdx = actionLines.indexOf(':failed');
  assert.ok(failedIdx >= 0, 'action must have a failed label');
  const actionFailure = actionLines.slice(failedIdx).join('\n');

  assert.match(helperFailure, /Start-Process -FilePath \$OldExePath/);
  assert.doesNotMatch(helperFailure, /Remove-Item -LiteralPath \$ScriptPath/);
  assert.match(actionFailure, /start "" "%OLD%"/i);
  assert.doesNotMatch(actionFailure, /del "%SETUP%"/i);
  assert.doesNotMatch(actionFailure, /del "%~f0"/i);
});

test('installed success paths remove Setup, relaunch the new app, and both helper scripts', () => {
  const helper = buildInstalledApplyScript().join('\n');
  const actionLines = buildApplyScript({
    newExe: 'C:\\updates\\setup.exe',
    oldExe: 'C:\\Programs\\app\\app.exe',
    portable: false,
  });
  const successIdx = actionLines.indexOf(':success');
  const failedIdx = actionLines.indexOf(':failed');
  assert.ok(successIdx >= 0 && failedIdx > successIdx, 'action success block must precede failure');
  const actionSuccess = actionLines.slice(successIdx, failedIdx).join('\n');

  assert.match(helper, /Remove-Item -LiteralPath \$ScriptPath/);
  assert.match(actionSuccess, /del "%SETUP%"/i);
  assert.match(actionSuccess, /del "%~f0"/i);
  // issue #167：/S 静默安装成功后必须主动拉起新版本（旧实现只删 Setup +
  // 自删批处理，finish 页不渲染导致永不自动重开）——与失败路径拉起旧版对称。
  assert.match(actionSuccess, /start "" "%INST%\\dsh-eac-shell\.exe"/i);
  assert.match(actionSuccess, /start "" "%INST%\\Deepseek Harness EAC\.exe"/i);
});

test('installed PowerShell arguments preserve paths and request a hidden non-interactive window', () => {
  const script = 'C:\\用户 A\\Deepseek Harness EAC\\updates\\apply-update.ps1';
  const setup = 'C:\\用户 A\\Deepseek Harness EAC\\updates\\Setup x64.exe';
  const oldExe = 'C:\\Program Files\\Deepseek Harness EAC\\Deepseek Harness EAC.exe';
  const actionScript = 'C:\\用户 A\\Deepseek Harness EAC\\updates\\apply-update.cmd';
  const log = 'C:\\用户 A\\Deepseek Harness EAC\\updates\\apply-update.log';
  const args = buildInstalledPowerShellArgs(script, {
    actionScript,
    newExe: setup,
    oldExe,
    userDataDir: 'C:\\用户 A\\Deepseek Harness EAC',
    dshHome: 'C:\\用户 A\\.dsh',
    installDir: 'C:\\Program Files\\Deepseek Harness EAC',
    profileDir: 'C:\\用户 A\\.dsh\\profiles\\web-desktop',
    currentVersion: '4.4.0',
    newVersion: '4.4.1',
    appPid: 4321,
    logPath: log,
  });

  assert.deepEqual(args.slice(0, 7), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
  ]);
  assert.equal(args[args.indexOf('-File') + 1], script);
  assert.equal(args[args.indexOf('-ActionScriptPath') + 1], actionScript);
  assert.equal(args[args.indexOf('-SetupPath') + 1], setup);
  assert.equal(args[args.indexOf('-OldExePath') + 1], oldExe);
  assert.equal(args[args.indexOf('-CurrentVersion') + 1], '4.4.0');
  assert.equal(args[args.indexOf('-NewVersion') + 1], '4.4.1');
  assert.equal(args[args.indexOf('-AppPid') + 1], '4321');
  assert.equal(args[args.indexOf('-LogPath') + 1], log);
  assert.equal(args[args.indexOf('-WaitTimeoutSeconds') + 1], '20');
});

test('installed PowerShell arguments reject an invalid app PID', () => {
  const input = {
    actionScript: 'C:\\updates\\apply-update.cmd',
    newExe: 'C:\\updates\\setup.exe',
    oldExe: 'C:\\Program Files\\app.exe',
    userDataDir: 'C:\\userData',
    dshHome: 'C:\\Users\\u\\.dsh',
    installDir: 'C:\\Program Files',
    profileDir: 'C:\\Users\\u\\.dsh\\profiles\\web-desktop',
    currentVersion: '4.4.0',
    newVersion: '4.4.1',
    logPath: 'C:\\updates\\apply-update.log',
  };
  for (const appPid of [undefined, null, 0, -1, 1.5, '42']) {
    assert.throws(
      () => buildInstalledPowerShellArgs('C:\\updates\\apply-update.ps1', { ...input, appPid }),
      /PID/
    );
  }
});

test('buildApplyScript keeps installed backup/rollback and portable replacement semantics', () => {
  const installed = buildApplyScript({
    newExe: 'C:\\updates\\setup.exe',
    oldExe: 'C:\\app.exe',
    portable: false,
  }).join('\n');
  assert.match(installed, /SKIP_BACKUP/);
  assert.match(installed, /rolling back 4 directories/);
  assert.doesNotMatch(installed, /force-killing leftover app processes/);

  const portable = buildApplyScript({
    newExe: 'C:\\updates\\new.exe',
    oldExe: 'D:\\portable\\app.exe',
    portable: true,
  }).join('\n');
  assert.match(portable, /OLD%\.bak/);
  assert.match(portable, /copy\s+\/y\s+"%NEW%"\s+"%OLD%"/i);
  assert.match(portable, /gtr\s+\d+/);
  assert.match(portable, /apply-update\.log/);
});

test('all generated helper-script lines are ASCII without embedded newlines', () => {
  const variants = [
    buildInstalledApplyScript(),
    buildApplyScript({
      newExe: 'C:\\updates\\setup.exe',
      oldExe: 'C:\\Programs\\app.exe',
      portable: false,
      nodeExe: 'C:\\Programs\\node.exe',
    }),
    buildApplyScript({
      newExe: 'C:\\updates\\new.exe',
      oldExe: 'D:\\portable\\app.exe',
      portable: true,
    }),
  ];
  for (const lines of variants) {
    for (const line of lines) {
      assert.ok(/^[\x20-\x7E]*$/.test(line), 'non-ASCII line: ' + JSON.stringify(line));
      assert.doesNotMatch(line, /\r|\n/, 'embedded newline: ' + JSON.stringify(line));
    }
  }
});

// Portable update regression: cmd /s strips the outer pair and leaves every
// path argument quoted, including paths containing spaces.
test('portable spawn command line wraps the whole argument row in an outer quote pair', () => {
  const script = 'C:\\Users\\a b\\AppData\\Roaming\\Deepseek Harness EAC\\updates\\apply-update.cmd';
  const args = [
    'C:\\Users\\a b\\AppData\\Roaming\\Deepseek Harness EAC\\updates\\portable-x64.exe',
    'C:\\Users\\a b\\Desktop\\Deepseek Harness EAC.exe',
  ];
  const line = buildSpawnCommandLine(script, args);
  assert.equal(line, '"' + [script, ...args].map((arg) => `"${arg}"`).join(' ') + '"');
});

// ---------------------------------------------------------------------------
// v4.4（PR79 集成回归）：安装版 4 目录备份分支。
//
// PR79 的 manifest.json 生成用了裸 `node -e` —— 但目标用户机器普遍没有
// 系统 Node（本应用自带 Node 运行时正是为此），detached cmd 里 `node`
// 解析失败 errorlevel 9009 → BAD=2 → 「backup failed, aborting update」
// → 永远回滚重弹旧版，更新死循环（与 v3.0.1 applyUpdate 自举陷阱同类：
// 更新通道自身的缺陷无法借更新修复）。修复 = applyUpdate 把应用自带
// nodeExe 在生成脚本时安全内联，脚本用带引号的 "%NODEEXE%" 调用；
// nodeExe 缺失/不存在时降级 SKIP_BACKUP（回到 v4.3 无备份语义），
// 绝不裸调 PATH 上的 node。
// ---------------------------------------------------------------------------

const FULL_BACKUP_OPTS = {
  newExe: 'C:\\updates\\setup.exe',
  oldExe: 'C:\\Programs\\app\\app.exe',
  portable: false,
  userDataDir: 'C:\\userData',
  dshHome: 'C:\\Users\\u\\.dsh',
  installDir: 'C:\\Programs\\app',
  profileDir: 'C:\\Users\\u\\.dsh\\profiles\\web-desktop',
  currentVersion: '4.3.0',
  newVersion: '4.4.0',
  nodeExe: 'C:\\Programs\\app\\resources\\node\\node.exe',
};

test('backup branch must not invoke bare `node` from PATH (inlines %NODEEXE% or skips backup)', () => {
  const joined = buildApplyScript(FULL_BACKUP_OPTS).join('\n');
  // batch 直接引用只到 %9 —— `%~10` 被解析为 `%~1` 后跟字面量 `0`
  // （v4.4 实测 NODEEXE 接成了 "<第1参>0" → 文件不存在 → 备份被静默
  // 跳过）。（shift 接第 10 参曾被判定「脚本静默死亡」，2x2 矩阵探针
  // shift × 结尾 CRLF 共 32 轮已证伪 —— 纯属当年探针自身缺陷；但内联
  // 设计无需第 10 参，本断言锁定内联方案不变。）nodeExe 由脚本生成器
  // 直接内联进脚本体（% 转义为 %%），不经命令行参数传递。
  assert.doesNotMatch(joined, /%~10/, 'must never reference %~10 (batch parses it as %~1 + "0")');
  assert.doesNotMatch(joined, /^\s*shift\s*$/m, 'must not rely on shift (inline design needs no 10th arg; shift itself proven innocent by 2x2 matrix probe)');
  const escaped = FULL_BACKUP_OPTS.nodeExe.replace(/%/g, '%%');
  assert.ok(joined.includes(`set "NODEEXE=${escaped}"`),
    'must inline the node exe path into the script body');
  assert.ok(joined.includes('"%NODEEXE%" -e'), 'manifest step must invoke the passed node exe');
  // 绝不允许裸 `node -e`（依赖 PATH —— 用户机器没有系统 Node）
  assert.doesNotMatch(joined, /(^|[^"%\w])node\s+-e/, 'must not invoke bare `node` from PATH');

  // nodeExe 缺失：降级 SKIP_BACKUP（v4.3 语义），同样不允许裸 node
  const noNode = buildApplyScript({ ...FULL_BACKUP_OPTS, nodeExe: '' }).join('\n');
  assert.match(noNode, /if "%NODEEXE%"=="" set SKIP_BACKUP=1/,
    'missing nodeExe must fall back to SKIP_BACKUP, never PATH node');
  assert.doesNotMatch(noNode, /(^|[^"%\w])node\s+-e/);
});

// 端到端（无系统 Node 的用户机器）：4 目录备份 + manifest.json + /S 静默
// 安装 + .backup-ts marker + 成功清理，全程 PATH 剥掉 node。
test('backup flow e2e: 4-dir backup + manifest + /S setup + marker, node stripped from PATH', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apply-bk-'));
  let appProc;
  try {
    const ud = path.join(dir, 'userdata');
    const dsh = path.join(dir, 'dshhome');
    const inst = path.join(dir, 'install');
    const prof = path.join(dir, 'profile');
    for (const d of [ud, path.join(ud, 'updates'), dsh, path.join(dsh, 'profiles', 'web-desktop'), inst, prof]) {
      fs.mkdirSync(d, { recursive: true });
    }
    // 各目录放真实样本文件，证明备份内容完整
    fs.writeFileSync(path.join(ud, 'settings.json'), '{"skin":"miku"}');
    fs.writeFileSync(path.join(dsh, 'settings.yaml'), 'model: deepseek-chat\n');
    fs.writeFileSync(path.join(dsh, 'profiles', 'web-desktop', 'cordis.patch.yml'), '- id: dsh-pet\n');
    fs.writeFileSync(path.join(prof, 'package.json'), '{}');
    fs.writeFileSync(path.join(inst, 'app.exe'), 'OLD-APP-BYTES');
    fs.writeFileSync(path.join(inst, 'resources.txt'), 'RES');

    // 伪装存活应用（PowerShell 助手须精确结束）+ 伪装 Setup（写标记退出 0）
    const fakeExeName = 'fake-dsh-eac-bk.exe';
    const fakeAppExe = path.join(dir, fakeExeName);
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe'), fakeAppExe);
    appProc = spawn(fakeAppExe, ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    const appExited = new Promise((r) => appProc.once('exit', r));
    const marker = path.join(dir, 'setup-ran.ok');
    const fakeSetup = path.join(dir, 'fake-setup.cmd');
    fs.writeFileSync(fakeSetup, `@echo off\r\necho ran> "${marker}"\r\nexit /b 0\r\n`);

    const { script, actionScript } = writeInstalledScripts(dir, {
      setup: fakeSetup,
      oldExe: fakeAppExe,
      userDataDir: ud, dshHome: dsh, installDir: inst, profileDir: prof,
      currentVersion: '4.3.0', newVersion: '4.4.0',
      nodeExe: process.execPath,
    });
    await new Promise((r) => setTimeout(r, 500)); // 等伪装应用真正跑起来

    // PATH 剥掉 node（保留系统工具），模拟普通用户机器
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const cleanEnv = {
      ...process.env,
      PATH: `${sysRoot}\\System32;${sysRoot};${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\`,
    };
    const run = runInstalledHelper({
      script,
      actionScript,
      setup: fakeSetup,
      oldExe: fakeAppExe,
      appPid: appProc.pid,
      log: path.join(dir, 'apply-update.log'),
      userDataDir: ud,
      dshHome: dsh,
      installDir: inst,
      profileDir: prof,
      currentVersion: '4.3.0',
      newVersion: '4.4.0',
      env: cleanEnv,
    });
    const code = await new Promise((resolve, reject) => {
      const killer = setTimeout(() => {
        try { run.kill(); } catch { /* already gone */ }
        reject(new Error('backup apply-update script did not exit within 60s (hang regression)'));
      }, 60000);
      run.on('exit', (c) => { clearTimeout(killer); resolve(c); });
    });

    assert.equal(code, 0, 'script must exit 0 on the success path');
    assert.ok(fs.existsSync(marker), 'the setup must have been executed');
    const log = fs.readFileSync(path.join(dir, 'apply-update.log'), 'utf8');
    assert.match(log, /running setup \/S/, 'setup must be invoked silently with /S');
    assert.match(log, /writing manifest\.json/, 'manifest phase must run');

    // 恰好一个带 manifest 的备份目录，4 个子目录内容齐全
    const backupsRoot = path.join(ud, 'backups');
    const withManifest = fs.readdirSync(backupsRoot).filter((e) => fs.existsSync(path.join(backupsRoot, e, 'manifest.json')));
    assert.equal(withManifest.length, 1, 'exactly one backup dir with manifest.json, got ' + withManifest.join(','));
    const ts = withManifest[0];
    const manifest = JSON.parse(fs.readFileSync(path.join(backupsRoot, ts, 'manifest.json'), 'utf8'));
    assert.equal(manifest.oldVersion, '4.3.0');
    assert.equal(manifest.newVersion, '4.4.0');
    assert.equal(String(manifest.installLocation.actual).toLowerCase(), inst.toLowerCase());
    assert.ok(fs.existsSync(path.join(backupsRoot, ts, 'userdata', 'settings.json')), 'userData must be backed up');
    assert.ok(fs.existsSync(path.join(backupsRoot, ts, 'dsh', 'settings.yaml')), 'dsh home must be backed up');
    assert.ok(fs.existsSync(path.join(backupsRoot, ts, 'profile', 'package.json')), 'profile must be backed up');
    assert.ok(fs.existsSync(path.join(backupsRoot, ts, 'install', 'app.exe')), 'install dir must be backed up');

    // 成功 marker：内容 = 备份目录时间戳
    const markerTs = fs.readFileSync(path.join(ud, 'updates', '.backup-ts'), 'utf8').trim();
    assert.ok(markerTs.length > 0, '.backup-ts marker must be written on success');
    assert.ok(fs.existsSync(path.join(ud, 'backups', markerTs, 'manifest.json')),
      `marker ts (${markerTs}) must match the backup dir`);

    if (appProc.exitCode === null) await Promise.race([appExited, new Promise((r) => setTimeout(r, 2000))]);
    assert.ok(appProc.exitCode !== null, 'the live fake app must have been force-killed');
    assert.ok(!fs.existsSync(fakeSetup), 'success path must delete the installer');
    assert.ok(!fs.existsSync(actionScript), 'success path must self-delete the action script');
    assert.ok(!fs.existsSync(script), 'success path must self-delete the PowerShell helper');
  } finally {
    if (appProc?.exitCode === null) {
      try { appProc.kill(); } catch { /* best effort */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// 失败路径端到端：Setup 退出 1 → 从备份 robocopy /MIR 回滚 4 目录 →
// 被删掉的安装文件被恢复 → 不写 marker → 拉起旧版 → 脚本退出 1。
test('backup flow e2e: setup failure rolls back the 4 directories from the backup', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apply-rb-'));
  let appProc;
  try {
    const ud = path.join(dir, 'userdata');
    const dsh = path.join(dir, 'dshhome');
    const inst = path.join(dir, 'install');
    const prof = path.join(dir, 'profile');
    for (const d of [ud, path.join(ud, 'updates'), dsh, inst, prof]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(ud, 'settings.json'), '{"a":1}');
    fs.writeFileSync(path.join(inst, 'app.exe'), 'OLD-APP-BYTES');
    fs.writeFileSync(path.join(inst, 'doomed.txt'), 'WILL-BE-DELETED-BY-SETUP');

    const fakeExeName = 'fake-dsh-eac-rb.exe';
    const fakeAppExe = path.join(dir, fakeExeName);
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe'), fakeAppExe);
    appProc = spawn(fakeAppExe, ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    const appExited = new Promise((r) => appProc.once('exit', r));

    // 伪装 Setup：写标记 → 删安装目录文件（模拟半途失败）→ 退出 1
    const marker = path.join(dir, 'setup-ran.ok');
    const fakeSetup = path.join(dir, 'fake-setup.cmd');
    fs.writeFileSync(fakeSetup, `@echo off\r\necho ran> "${marker}"\r\ndel "${path.join(inst, 'doomed.txt')}"\r\ndel "${path.join(inst, 'app.exe')}"\r\nexit /b 1\r\n`);

    const { script, actionScript } = writeInstalledScripts(dir, {
      setup: fakeSetup,
      oldExe: fakeAppExe,
      userDataDir: ud, dshHome: dsh, installDir: inst, profileDir: prof,
      currentVersion: '4.3.0', newVersion: '4.4.0',
      nodeExe: process.execPath,
    });
    await new Promise((r) => setTimeout(r, 500));

    const run = runInstalledHelper({
      script,
      actionScript,
      setup: fakeSetup,
      oldExe: fakeAppExe,
      appPid: appProc.pid,
      log: path.join(dir, 'apply-update.log'),
      userDataDir: ud,
      dshHome: dsh,
      installDir: inst,
      profileDir: prof,
      currentVersion: '4.3.0',
      newVersion: '4.4.0',
    });
    const code = await new Promise((resolve, reject) => {
      const killer = setTimeout(() => {
        try { run.kill(); } catch { /* already gone */ }
        reject(new Error('rollback apply-update script did not exit within 60s (hang regression)'));
      }, 60000);
      run.on('exit', (c) => { clearTimeout(killer); resolve(c); });
    });

    assert.equal(code, 1, 'failure path must exit 1');
    assert.ok(fs.existsSync(marker), 'the setup must have been executed');
    const log = fs.readFileSync(path.join(dir, 'apply-update.log'), 'utf8');
    assert.match(log, /rolling back 4 directories/, 'rollback phase must run');
    assert.match(log, /rollback OK/, 'rollback must succeed');
    // 被删除的安装文件必须从备份恢复
    assert.ok(fs.existsSync(path.join(inst, 'app.exe')), 'deleted install file must be restored from backup');
    assert.ok(fs.existsSync(path.join(inst, 'doomed.txt')), 'second deleted install file must be restored from backup');
    // 失败不写成功 marker，不删安装包（诊断保留）
    assert.ok(!fs.existsSync(path.join(ud, 'updates', '.backup-ts')), 'no success marker on failure');
    assert.ok(fs.existsSync(fakeSetup), 'failure path must keep the installer for diagnosis');
    assert.ok(fs.existsSync(actionScript), 'failure path must keep the action script');
    assert.ok(fs.existsSync(script), 'failure path must keep the PowerShell helper');
    if (appProc.exitCode === null) await Promise.race([appExited, new Promise((r) => setTimeout(r, 2000))]);
    assert.ok(appProc.exitCode !== null, 'the live fake app must have been force-killed');
  } finally {
    if (appProc?.exitCode === null) {
      try { appProc.kill(); } catch { /* best effort */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('installed helper waits for graceful app exit before running the update action', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installed-graceful-'));
  let appProc;
  try {
    const runningMarker = path.join(dir, 'app-running.flag');
    const setupMarker = path.join(dir, 'setup-result.txt');
    const appScript = path.join(dir, 'fake-app.ps1');
    const setup = path.join(dir, 'fake-setup.cmd');
    const oldExe = path.join(dir, 'old-app.cmd');
    const log = path.join(dir, 'apply-update.log');

    fs.writeFileSync(appScript, [
      `Set-Content -LiteralPath '${runningMarker.replaceAll("'", "''")}' -Value running`,
      'Start-Sleep -Milliseconds 1200',
      `Remove-Item -LiteralPath '${runningMarker.replaceAll("'", "''")}' -Force`,
    ].join('\r\n'));
    fs.writeFileSync(setup, [
      '@echo off',
      `if exist "${runningMarker}" (echo too-early>"${setupMarker}") else (echo ran>"${setupMarker}")`,
      'exit /b 0',
    ].join('\r\n'));
    fs.writeFileSync(oldExe, '@echo off\r\nexit /b 0\r\n');
    const { script, actionScript } = writeInstalledScripts(dir, { setup, oldExe });

    appProc = spawn(POWERSHELL, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      appScript,
    ], { stdio: 'ignore', windowsHide: true });
    await waitForFile(runningMarker);

    const helper = runInstalledHelper({
      script,
      actionScript,
      setup,
      oldExe,
      appPid: appProc.pid,
      log,
      userDataDir: dir,
      dshHome: dir,
      installDir: dir,
      profileDir: dir,
      waitTimeoutSeconds: 5,
    });
    assert.equal(await waitForExit(helper), 0);
    assert.equal(fs.readFileSync(setupMarker, 'utf8').trim(), 'ran');
    assert.ok(!fs.existsSync(setup), 'successful Setup must be deleted');
    assert.ok(!fs.existsSync(actionScript), 'successful action must delete itself');
    assert.ok(!fs.existsSync(script), 'successful PowerShell helper must delete itself');
    const logText = fs.readFileSync(log, 'utf8');
    assert.match(logText, /running hidden update action/);
    assert.match(logText, /running setup \/S/);
    assert.match(logText, /setup exit code 0/);
    assert.match(logText, /update applied/);
  } finally {
    if (appProc?.exitCode === null) {
      try { appProc.kill(); } catch { /* best effort */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installed helper timeout stops only the requested PID', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installed-timeout-'));
  let target;
  let sibling;
  try {
    target = startSleepingPowerShell();
    sibling = startSleepingPowerShell();
    const setupMarker = path.join(dir, 'setup-ran.txt');
    const setup = path.join(dir, 'fake-setup.cmd');
    const oldExe = path.join(dir, 'old-app.cmd');
    const log = path.join(dir, 'apply-update.log');

    fs.writeFileSync(setup, `@echo off\r\necho ran>"${setupMarker}"\r\nexit /b 0\r\n`);
    fs.writeFileSync(oldExe, '@echo off\r\nexit /b 0\r\n');
    const { script, actionScript } = writeInstalledScripts(dir, { setup, oldExe });

    const helper = runInstalledHelper({
      script,
      actionScript,
      setup,
      oldExe,
      appPid: target.pid,
      log,
      userDataDir: dir,
      dshHome: dir,
      installDir: dir,
      profileDir: dir,
      waitTimeoutSeconds: 1,
    });
    assert.equal(await waitForExit(helper), 0);
    await waitForExit(target, 3000);

    assert.ok(fs.existsSync(setupMarker), 'Setup must run after the target exits');
    assert.equal(sibling.exitCode, null, 'sibling process must not be killed');
    assert.match(fs.readFileSync(log, 'utf8'), /stopping exact PID/);
  } finally {
    for (const child of [target, sibling]) {
      if (child?.exitCode === null) {
        try { child.kill(); } catch { /* best effort */ }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installed helper keeps artifacts and relaunches the old app when Setup fails', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installed-failure-'));
  try {
    const oldAppMarker = path.join(dir, 'old-app-ran.txt');
    const setup = path.join(dir, 'failing-setup.cmd');
    const oldExe = path.join(dir, 'old-app.cmd');
    const log = path.join(dir, 'apply-update.log');

    fs.writeFileSync(setup, '@echo off\r\nexit /b 7\r\n');
    fs.writeFileSync(oldExe, `@echo off\r\necho ran>"${oldAppMarker}"\r\nexit /b 0\r\n`);
    const { script, actionScript } = writeInstalledScripts(dir, { setup, oldExe });

    const alreadyExited = spawn(POWERSHELL, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'exit 0',
    ], { stdio: 'ignore', windowsHide: true });
    const exitedPid = alreadyExited.pid;
    await waitForExit(alreadyExited);

    const helper = runInstalledHelper({
      script,
      actionScript,
      setup,
      oldExe,
      appPid: exitedPid,
      log,
      userDataDir: dir,
      dshHome: dir,
      installDir: dir,
      profileDir: dir,
      waitTimeoutSeconds: 1,
    });
    assert.equal(await waitForExit(helper), 1);
    await waitForFile(oldAppMarker);

    assert.ok(fs.existsSync(setup), 'failed Setup must be kept for diagnosis');
    assert.ok(fs.existsSync(actionScript), 'failed action must be kept for diagnosis');
    assert.ok(fs.existsSync(script), 'failed PowerShell helper must be kept for diagnosis');
    const logText = fs.readFileSync(log, 'utf8');
    assert.match(logText, /setup exit code 7/);
    assert.match(logText, /update action exit code 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
