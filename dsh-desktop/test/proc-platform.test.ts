import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  childProcessSpawnOptions,
  init,
  killTreeAndWait,
  childEnv,
} from '../lib/desktop/proc.js';

const root = join(fileURLToPath(new URL('..', import.meta.url)));

test('boot-server uses platform process-group options and suppresses browser launch', () => {
  const source = readFileSync(join(root, 'lib', 'desktop', 'boot-server.ts'), 'utf8');
  assert.match(source, /\.\.\.childProcessSpawnOptions\(\)/);
  // --no-open 必须在：内核 openBrowser 默认 true → 每轮启动弹系统浏览器。
  // 历史：5.3.0 期间的 spike 内核不认该参数（传了启动必死），PR #249 移除并钉死
  // 「不得出现」；最终 vendored alpha.1 的 dsh-web-app 恢复了 --no-open
  // （boot-smoke 实证：传参正常启动且不再弹浏览器），钉子翻转为「必须存在」，
  // 防止再丢。内核若再变更参数语义，此测试会红，届时按新内核契约重评。
  assert.match(source, /['"]--no-open['"]/);
  assert.deepEqual(childProcessSpawnOptions('linux'), { detached: true });
  assert.deepEqual(childProcessSpawnOptions('win32'), { detached: false });
});

test('credential compatibility normalizes to the digit version read by the local kernel', () => {
  // 本仓库 vendored 内核 parseCredentialsDocument: `fields["version"] !== 1`
  // 即拒（字符串 "1" 一样死，装机实测「declares version "1"」启动必死）。
  // PR #256 的字符串方向与本地内核相反，合并时曾误采——此钉子防回归。
  const source = readFileSync(join(root, 'lib', 'desktop', 'boot-server.ts'), 'utf8');
  assert.match(source, /\$1version: 1/);
  assert.doesNotMatch(source, /\$1version: "1"/);
});

test('POSIX DSH process-group termination reaps a spawned descendant', { skip: process.platform === 'win32' }, async () => {
  init({ log: () => {}, getDshHome: () => null, getDesktopProfile: () => 'desktop' });
  const script = [
    'const {spawn}=require("node:child_process")',
    'const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"})',
    'process.stdout.write(String(c.pid)+"\\n")',
    'setInterval(()=>{},1000)',
  ].join(';');
  const child = spawn(process.execPath, ['-e', script], {
    ...childProcessSpawnOptions('linux'),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const descendantPid = await new Promise<number>((resolve, reject) => {
    let value = '';
    child.stdout.on('data', (chunk) => {
      value += chunk.toString();
      const pid = Number(value.trim());
      if (Number.isInteger(pid) && pid > 0) resolve(pid);
    });
    setTimeout(() => reject(new Error('descendant pid timeout')), 3000);
  });
  try {
    await killTreeAndWait(child, { graceMs: 100, hardMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  } finally {
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already reaped */ }
  }
});

test('childEnv 注入 DSH_PERMISSION_MODE=danger-full-access（issue #196）', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-perm-'));
  try {
    writeFileSync(
      join(temp, 'settings.yaml'),
      [
        'permission:',
        '  defaultPreset: danger-full-access',
        '',
      ].join('\n'),
      'utf8'
    );
    init({ log: () => {}, getDshHome: () => temp, getDesktopProfile: () => 'desktop' });
    const env = childEnv();
    assert.equal(env.DSH_PERMISSION_MODE, 'danger-full-access');
    assert.equal(env.DSH_DESKTOP, '1');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('childEnv 未设置完全访问时不注入 DSH_PERMISSION_MODE（保持默认 workspace-write）', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-perm-'));
  try {
    writeFileSync(
      join(temp, 'settings.yaml'),
      [
        'permission:',
        '  defaultPreset: workspace-write',
        '',
      ].join('\n'),
      'utf8'
    );
    init({ log: () => {}, getDshHome: () => temp, getDesktopProfile: () => 'desktop' });
    const env = childEnv();
    assert.equal(env.DSH_PERMISSION_MODE, undefined);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
