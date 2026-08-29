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
  assert.match(source, /['"]--no-open['"]/);
  assert.deepEqual(childProcessSpawnOptions('linux'), { detached: true });
  assert.deepEqual(childProcessSpawnOptions('win32'), { detached: false });
});

test('credential compatibility preserves the string version required by credentials-local', () => {
  const source = readFileSync(join(root, 'lib', 'desktop', 'boot-server.ts'), 'utf8');
  assert.match(source, /version: "1"/);
  assert.doesNotMatch(source, /\$1version: 1/);
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
