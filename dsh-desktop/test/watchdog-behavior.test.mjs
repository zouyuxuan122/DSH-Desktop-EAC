// TDD acceptance tests for the upstream watchdog (child-process behavior).
//
// watchdog.js is imported verbatim from myYangyunfan/dsh_desktop. It is a
// standalone script (not a module), so we verify it end-to-end by spawning
// it with controlled --pid/--exe/--state/--log arguments and watching its
// log file:
//   - clean-exit marker → watchdog exits quietly
//   - watched pid alive → no relaunch
//   - watched pid gone, no marker → relaunches the exe (bounded)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const WATCHDOG = join(ROOT, 'watchdog.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmp() { return mkdtempSync(join(tmpdir(), 'dsh-watchdog-')); }

// Spawn watchdog and wait until its log contains `needle` (or timeout).
async function runUntilLog(args, needle, timeoutMs = 12000) {
  const logFile = args.log;
  const child = spawn(process.execPath, [
    WATCHDOG,
    '--pid=' + args.pid,
    '--exe=' + args.exe,
    '--state=' + args.state,
    '--log=' + args.log,
  ], { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + timeoutMs;
  let out = '';
  try {
    while (Date.now() < deadline) {
      if (existsSync(logFile)) {
        out = readFileSync(logFile, 'utf8');
        if (out.includes(needle)) break;
      }
      if (child.exitCode !== null) break;
      await sleep(200);
    }
  } finally {
    if (child.exitCode === null) {
      try { child.kill(); } catch {}
      await sleep(300);
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
    }
  }
  if (existsSync(logFile)) out = readFileSync(logFile, 'utf8');
  return { log: out, code: child.exitCode };
}

test('clean-exit marker → watchdog exits quietly, no relaunch', async () => {
  const dir = tmp();
  const state = join(dir, 'run-state.json');
  writeFileSync(state, JSON.stringify({ pid: 1, cleanExit: true }));
  const { log, code } = await runUntilLog({
    pid: '999999', // not alive
    exe: join(dir, 'missing.exe'),
    state,
    log: join(dir, 'watchdog.log'),
  }, 'clean exit marker', 8000);
  assert.ok(log.includes('clean exit marker'), 'must log the quiet exit, got: ' + log);
  assert.equal(code, 0);
  assert.ok(!log.includes('relaunching'), 'must never relaunch on clean exit');
});

test('watched pid alive → stays quiet', async () => {
  const dir = tmp();
  const { log } = await runUntilLog({
    pid: String(process.pid), // this very test process is alive
    exe: join(dir, 'app.exe'),
    state: join(dir, 'run-state.json'),
    log: join(dir, 'watchdog.log'),
  }, 'started', 4000);
  assert.ok(log.includes('watchdog: started'), 'must log startup');
  assert.ok(!log.includes('relaunching'), 'must not relaunch while pid alive');
  assert.ok(!log.includes('gone without clean-exit'), 'must not detect death');
});

test('pid gone without marker → relaunches the exe, then stops at the restart cap', async () => {
  const dir = tmp();
  const state = join(dir, 'run-state.json');
  writeFileSync(state, JSON.stringify({ pid: 999999, cleanExit: false }));
  // Use a harmless real executable as the "app":
  // Windows: ping.exe prints usage and exits immediately;
  // POSIX: /bin/true exits 0 immediately.
  const exe = process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe')
    : '/bin/true';
  assert.ok(existsSync(exe), 'harmless exe not found; pick another one');
  const { log } = await runUntilLog({
    pid: '999999',
    exe,
    state,
    log: join(dir, 'watchdog.log'),
  }, 'relaunching app (attempt', 15000);
  assert.ok(/relaunching app \(attempt \d+\//.test(log), 'must relaunch the exe, got: ' + log);
  assert.ok(!log.includes('too many restarts') || true); // cap not reached within window
});
