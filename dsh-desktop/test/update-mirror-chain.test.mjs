// Tests for the V4.2 update-engine additions:
//   - registryChain() dedupes and orders the npm mirror chain (user's current
//     registry first, then npmmirror, then npmjs);
//   - applyUpdate() falls back to the next mirror on failure and reports the
//     switch through onProgress, keeps the staging dir clean, and only throws
//     after the whole chain is exhausted;
//   - npm stall detection rejects with a stall message when a spawned npm
//     produces no output for stallMs.
//
// The npm path is faked with a node script so no real npm is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const updater = await import(new URL('../updater.js', import.meta.url));

test('registryChain: current registry first, mirrors appended, deduped', () => {
  assert.deepEqual(updater.registryChain(null), updater.NPM_MIRRORS);
  assert.deepEqual(updater.registryChain('https://registry.npmjs.org'), ['https://registry.npmjs.org', 'https://registry.npmmirror.com']);
  assert.deepEqual(updater.registryChain('https://registry.npmmirror.com/'), ['https://registry.npmmirror.com', 'https://registry.npmjs.org']);
  assert.deepEqual(updater.registryChain('https://MIRROR.example.com'), ['https://MIRROR.example.com', ...updater.NPM_MIRRORS]);
});

// 伪造 npm：按 argv 里的 registry 决定成败，行为全部用脚本模拟，不跑真 npm。
function makeFakeNpmCli(dir, behavior) {
  const cli = path.join(dir, 'fake-npm.js');
  fs.writeFileSync(cli, `
    const args = process.argv.slice(2);
    if (args[0] === 'config') { process.stdout.write('https://registry.npmjs.org\\n'); process.exit(0); }
    const reg = args.find((a) => a.startsWith('--registry='));
    const key = reg ? reg.slice('--registry='.length).replace(/\\/+$/, '') : '(default)';
    const behavior = ${JSON.stringify(behavior)};
    const out = behavior[key] || behavior['(default)'];
    if (out === 'ok') {
      const prefixArg = args[args.indexOf('--prefix') + 1];
      const fs = require('node:fs');
      const path = require('node:path');
      const bin = path.join(prefixArg || '.', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, 'module.exports = {};\\n');
      process.stdout.write('0.1.0-rc.9\\n');
      process.exit(0);
    }
    if (out === 'stall') { setTimeout(() => process.exit(0), 20000); return; }
    if (out === 'fail') { process.stderr.write('EINTEGRITY fetch failed\\n'); process.exit(1); }
    process.stdout.write('0.1.0-rc.9\\n');
    process.exit(0);
  `);
  return cli;
}

function makeCtx(cli, userDataDir) {
  const logs = [];
  const ctx = {
    userDataDir,
    log: (tag, msg) => logs.push(`[${tag}] ${msg}`),
    nodeExe: () => process.execPath,
    npmCli: () => cli,
  };
  return { ctx, logs };
}

// 子进程被杀后可能仍短暂持有 cwd 句柄（Windows），清理时重试几次。
function rmRetry(dir) {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

test('applyUpdate: first registry fails -> automatically switches to mirror and succeeds', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-mirror-'));
  const cli = makeFakeNpmCli(userDataDir, { '(default)': 'fail', 'https://registry.npmmirror.com': 'ok' });
  const { ctx, logs } = makeCtx(cli, userDataDir);
  const events = [];
  const res = await updater.applyUpdate(ctx, '0.1.0-rc.9', { onProgress: (ev) => events.push(ev) });
  assert.equal(res.version, '0.1.0-rc.9');
  const mirrorEv = events.find((e) => e.stage === 'mirror');
  assert.ok(mirrorEv, '应上报镜像源切换');
  assert.equal(mirrorEv.registry, 'https://registry.npmmirror.com');
  assert.ok(events.some((e) => e.stage === 'done'), '成功阶段应上报');
  assert.ok(logs.some((l) => l.includes('自动切换镜像源')), '日志应记录切换');
  assert.ok(fs.existsSync(path.join(userDataDir, 'agent', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')));
  rmRetry(userDataDir);
});

test('applyUpdate: whole chain exhausted -> throws with all sources listed, staging cleaned', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-mirror-'));
  const cli = makeFakeNpmCli(userDataDir, { '(default)': 'fail' });
  const { ctx } = makeCtx(cli, userDataDir);
  await assert.rejects(
    updater.applyUpdate(ctx, '0.1.0-rc.9', { onProgress: () => {} }),
    (err) => /已尝试镜像源：/.test(err.message) && err.message.includes('npmjs') && err.message.includes('npmmirror')
  );
  assert.ok(!fs.existsSync(path.join(userDataDir, 'agent-staging')), '失败后 staging 应清理');
  rmRetry(userDataDir);
});

test('npm stall: no output within stallMs kills the process and reports stall', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-stall-'));
  const cli = makeFakeNpmCli(userDataDir, { '(default)': 'stall' });
  const { ctx } = makeCtx(cli, userDataDir);
  await assert.rejects(
    updater.applyUpdate(ctx, '0.1.0-rc.9', { onProgress: () => {}, stallMs: 700 }),
    /下载停滞/
  );
  rmRetry(userDataDir);
});

test('checkLatest: falls back to mirror when the default source fails', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-check-'));
  const cli = makeFakeNpmCli(userDataDir, { '(default)': 'fail', 'https://registry.npmmirror.com': 'ok' });
  const { ctx, logs } = makeCtx(cli, userDataDir);
  const v = await updater.checkLatest(ctx);
  assert.equal(v, '0.1.0-rc.9');
  assert.ok(logs.some((l) => l.includes('版本检查成功（镜像源')));
  rmRetry(userDataDir);
});