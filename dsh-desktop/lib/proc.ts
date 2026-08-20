/**
 * lib/proc.ts — 子进程工具与运行时定位（Task 1.3 自 main.js 提取，逻辑等价）。
 *
 * 职责：
 *   - 内置运行时定位：nodeExe() / npmCli()（vendor 目录 ↔ 打包 resources 目录）；
 *   - updater 上下文：updCtx() 及基于它的 dshBin / dshVersion / dshVersionSource；
 *   - 进程树回收：killTree（异步尽力）/ killTreeAndWait（退出路径专用、有界）、
 *     waitForProcExit（轮询 tasklist / kill-0）。
 *
 * 注意：killTreeAndWait 的「优雅 → 等待 → 强杀 → 再等待」时序是 V4 修复
 * 「退出后残留一对进程」的关键，勿改动节奏（详见函数内注释）。
 */

import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import * as updater from '../updater.js';
import { state } from './state.js';
import { log } from './log.js';

/** 是否运行在 Windows（进程回收策略分支依据）。 */
export const IS_WIN = process.platform === 'win32';

/** 内置 node.exe：打包后在 resources/node/，开发态在 vendor/node/。 */
export function nodeExe(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'node', 'node.exe');
  return path.resolve(__dirname, '..', 'vendor', 'node', 'node.exe');
}

/** 内置 npm CLI 入口：与 node.exe 同源的 vendor npm 分发。 */
export function npmCli(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js');
  return path.resolve(__dirname, '..', 'vendor', 'npm', 'bin', 'npm-cli.js');
}

/** 传给 updater 模块的共享上下文（Task 1.x 起由 lib 层统一提供）。 */
export function updCtx(): updater.UpdCtx {
  return { userDataDir: state.userDataDir, nodeExe, npmCli, log };
}

/**
 * 当前生效的 dsh bin：用户已批准安装的更新 overlay 优先；不存在则回退
 * 随应用分发的内置副本。
 */
export function dshBin(): string {
  const ov = updater.overlayBinPath(updCtx());
  if (ov !== null && fs.existsSync(ov)) return ov;
  return require.resolve('@deepseek-ai/dsh/lib/bin.js');
}

/** 当前生效的 dsh 版本（overlay 优先，无则内置版本；都取不到显示「未知」）。 */
export function dshVersion(): string {
  return updater.activeVersion(updCtx()) ?? '未知';
}

/** 版本来源描述：overlay（用户目录已更新）或内置。 */
export function dshVersionSource(): string {
  return updater.overlayVersion(updCtx()) !== null ? '用户目录（已更新）' : '内置';
}

/**
 * 尽力回收进程树（异步、不等待完成）。
 *
 * Windows：先优雅 taskkill（无 /F，给进程收尾机会，避免撕裂
 * session.jsonl.zstd），1500ms 后仍存活再 /T /F 强杀。
 * POSIX：对进程组发 SIGTERM，失败则对进程本身发。
 */
export function killTree(proc: ChildProcess | null): void {
  if (!proc || !proc.pid) return;
  try {
    if (IS_WIN) {
      // M2 修复：先优雅（无 /F）给进程收尾机会，短等待后仍存活再强杀。
      spawn('taskkill', ['/pid', String(proc.pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      const pid = proc.pid;
      setTimeout(() => {
        try {
          const alive = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
            encoding: 'utf8',
            windowsHide: true,
          });
          if (alive.includes(String(pid))) {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          }
        } catch {
          /* 进程已退出或查询失败 */
        }
      }, 1500);
    } else {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        proc.kill('SIGTERM');
      }
    }
  } catch (err) {
    log('killTree', String(err));
  }
}

/** killTreeAndWait 的可调参数（毫秒）。 */
export interface KillTreeAndWaitOpts {
  /** 优雅 taskkill 后的等待窗口。 */
  graceMs?: number;
  /** 强杀后的兜底等待窗口。 */
  hardMs?: number;
}

/**
 * 退出路径专用的有界同步回收（V4 修复「退出后残留一对进程」）。
 *
 * 旧实现在 before-quit 里调用 killTree —— 强杀补刀挂在 1500ms 的
 * setTimeout 上，而 Electron 在 before-quit 后数百毫秒内就退出，定时器
 * 随主进程湮灭；无 /F 的 taskkill 对控制台进程（node.exe 没有顶层窗口，
 * 无处投递 WM_CLOSE）基本无效。结果：dsh web 的 node.exe 连同它的
 * conhost.exe 每次退出都原样残留。
 *
 * 这里：优雅 taskkill → 等 graceMs → 仍存活则 taskkill /T /F → 再等
 * hardMs，全程有界，绝不无限阻塞退出。
 */
export async function killTreeAndWait(
  proc: ChildProcess | null,
  opts: KillTreeAndWaitOpts = {},
): Promise<void> {
  const { graceMs = 1200, hardMs = 4000 } = opts;
  if (!proc || !proc.pid || proc.exitCode !== null) return;
  const pid = proc.pid;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      await waitForProcExit(proc, graceMs);
      if (proc.exitCode !== null) return;
      try {
        const alive = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
          encoding: 'utf8',
          windowsHide: true,
        });
        // CSV 输出里 PID 带引号；查不到说明已退出。
        if (!alive.includes(`"${pid}"`)) return;
      } catch {
        return;
      }
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await waitForProcExit(proc, hardMs);
    } else {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* 已退出 */
        }
      }
      await waitForProcExit(proc, graceMs);
      if (proc.exitCode !== null) return;
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
      await waitForProcExit(proc, hardMs);
    }
  } catch (err) {
    log('killTree', String(err));
  }
}

/**
 * 等待一个子进程真正退出（taskkill 先优雅后强杀，锁住的 DLL 要等进程
 * 终止才释放）。轮询 tasklist / kill-0，超时后放行由调用方自行处理。
 */
export function waitForProcExit(proc: ChildProcess | null, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || !proc.pid) {
      resolve();
      return;
    }
    const pid = proc.pid;
    const started = Date.now();
    const isAlive = (): boolean => {
      if (proc.exitCode !== null) return false;
      if (!IS_WIN) {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }
      try {
        const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
          encoding: 'utf8',
          windowsHide: true,
        });
        return out.includes(`"${pid}"`);
      } catch {
        return false;
      }
    };
    const check = (): void => {
      if (!isAlive()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        log('service', `等待旧服务进程退出超时（PID ${pid}），继续`);
        resolve();
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}
