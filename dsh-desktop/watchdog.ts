'use strict';

// DSH Desktop watchdog: keeps the packaged desktop app alive.
// (Wave 3 自 watchdog.js 类型化迁出，行为零变更.)
//
// The Electron main process launches this tiny Node process detached at boot.
// It polls the parent PID. If the parent disappears:
//   - cleanExit=true in <userData>/run-state.json  -> user quit, update, or
//     fatal-boot path marked the exit intentionally; watchdog exits quietly.
//   - a NEWER instance already took over the state file -> this watchdog exits.
//   - otherwise the app died unexpectedly -> relaunch <exe>.
//
// Guard rails: at most 5 relaunches per 10 minutes, and a 15s grace period
// after each launch so the new instance can write its run-state file first.

import fs = require('node:fs');
import path = require('node:path');
import { spawn } from 'node:child_process';

interface RunState {
  cleanExit?: boolean;
  pid?: number;
}

function arg(name: string, fallback: string): string {
  const prefix = '--' + name + '=';
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const watchedPid = Number(arg('pid', '0'));
const exe = arg('exe', '');
const stateFile = arg('state', '');
const logFile = arg('log', '');
const MAX_RESTARTS = 5;
const WINDOW_MS = 10 * 60 * 1000;
const GRACE_MS = 15 * 1000;
const POLL_MS = 2000;

let restartCount = 0;
let windowStart = 0;
let lastLaunchAt = 0;

function log(msg: string): void {
  if (!logFile) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logFile, line, 'utf8'); } catch { /* 尽力记录 */ }
}

function alive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && (err as NodeJS.ErrnoException).code === 'EPERM');
  }
}

function readState(): RunState | null {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}

function launchApp(): void {
  const now = Date.now();
  if (now - lastLaunchAt < GRACE_MS) return;
  if (restartCount === 0) windowStart = now;
  else if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    restartCount = 0;
  }
  if (restartCount >= MAX_RESTARTS) {
    log(`watchdog: too many restarts (${restartCount}/${MAX_RESTARTS}), giving up`);
    process.exit(0);
  }
  if (!exe || !fs.existsSync(exe)) {
    log('watchdog: app exe missing: ' + exe);
    process.exit(0);
  }
  restartCount += 1;
  lastLaunchAt = now;
  log(`watchdog: relaunching app (attempt ${restartCount}/${MAX_RESTARTS}): ${exe}`);
  try {
    const child = spawn(exe, [], {
      cwd: path.dirname(exe),
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    log('watchdog: spawn failed: ' + ((err as Error).message || err));
  }
}

function poll(): void {
  if (alive(watchedPid)) return;
  const state = readState();
  if (state && state.cleanExit === true) {
    log('watchdog: clean exit marker found, exiting');
    process.exit(0);
  }
  if (state && state.pid && state.pid !== watchedPid && alive(state.pid)) {
    log(`watchdog: newer instance pid=${state.pid} is running, exiting`);
    process.exit(0);
  }
  log(`watchdog: watched pid=${watchedPid} is gone without clean-exit marker`);
  launchApp();
}

if (!watchedPid || !exe || !stateFile) {
  log('watchdog: missing required arguments pid/exe/state');
  process.exit(0);
}

log(`watchdog: started pid=${process.pid} watching=${watchedPid} exe=${exe}`);
// 不能 unref：watchdog 本身只靠这个定时器保持存活。
setInterval(poll, POLL_MS);
