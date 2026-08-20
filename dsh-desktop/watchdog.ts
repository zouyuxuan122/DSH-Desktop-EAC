/**
 * watchdog.ts — 桌面端看门狗进程（Task 7.1 自 watchdog.js 迁 TS）。
 *
 * Electron 主进程在 boot 时以 detached 方式拉起这个微型 Node 进程
 * （编译产物 watchdog.js，由 node 直接执行）。它轮询父进程 PID：
 *   - <userData>/run-state.json 里 cleanExit=true → 用户主动退出/更新/
 *     fatal-boot 路径已标记为有意退出，看门狗静默退场；
 *   - 状态文件已被更新的实例接管 → 本看门狗退场；
 *   - 否则应用意外死亡 → 重新拉起 <exe>。
 *
 * 护栏：10 分钟内最多重启 5 次；每次拉起后 15s 宽限期（等新实例先写完
 * 自己的 run-state 文件）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

/** 从 argv 取 --name=value 参数（缺失返回 fallback）。 */
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

/** run-state.json 的最小形状。 */
interface RunState {
  cleanExit?: boolean;
  pid?: number;
}

function log(msg: string): void {
  if (!logFile) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* 日志写失败静默 */
  }
}

function alive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readState(): RunState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as RunState;
  } catch {
    return null;
  }
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
    log('watchdog: spawn failed: ' + String((err as Error).message || err));
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
