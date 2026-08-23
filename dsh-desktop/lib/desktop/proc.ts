'use strict';

// 子进程回收与环境构造（ADR 0002 L2 业务服务层；Wave 1 自 proc.js 类型化迁出，
// 行为零变更）。依赖通过 init() 注入，保持本模块与 Electron/UI 零耦合。

import cp = require('node:child_process');
import type { ChildProcess } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

/** 注入接口：由宿主（Electron main / Tauri sidecar）在启动时提供。 */
export interface ProcCtx {
  log(tag: string, msg: string): void;
  getDshHome(): string | null;
  getDesktopProfile(): string;
}

let ctx!: ProcCtx;
export function init(d: ProcCtx): void { ctx = d; }

export function killTree(proc: ChildProcess | null | undefined): void {
  if (!proc || !proc.pid) return;
  try {
    if (IS_WIN) {
      // M2 修复：先优雅（无 /F）给进程收尾机会（避免撕裂 session.jsonl.zstd），
      // 短等待后仍存活再强杀。
      cp.spawn('taskkill', ['/pid', String(proc.pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      const pid = proc.pid;
      setTimeout(() => {
        try {
          const query = 'tasklist /FI "PID eq ' + pid + '" /FO CSV /NH';
          const alive = cp.execSync(query, { encoding: 'utf8', windowsHide: true });
          if (alive.includes(String(pid))) {
            cp.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          }
        } catch { /* 进程已退出或查询失败 */ }
      }, 1500);
    } else {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
    }
  } catch (err) {
    ctx.log('killTree', String(err));
  }
}

// V4 修复「退出后残留一对进程」：退出路径专用的有界同步回收。
// 优雅 taskkill → 等待 graceMs → 仍存活则 taskkill /T /F → 再等 hardMs，
// 全程有界，绝不无限阻塞退出。
export async function killTreeAndWait(
  proc: ChildProcess | null | undefined,
  { graceMs = 1200, hardMs = 4000 }: { graceMs?: number; hardMs?: number } = {},
): Promise<void> {
  if (!proc || !proc.pid || proc.exitCode !== null) return;
  const pid = proc.pid;
  try {
    if (IS_WIN) {
      cp.spawn('taskkill', ['/pid', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      await waitForProcExit(proc, graceMs);
      if (proc.exitCode !== null) return;
      try {
        const alive = cp.execSync(
          'tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
        if (!alive.includes('"' + pid + '"')) return;
      } catch { return; }
      cp.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await waitForProcExit(proc, hardMs);
    } else {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { /* 已退出 */ } }
      await waitForProcExit(proc, graceMs);
      if (proc.exitCode !== null) return;
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* 已退出 */ } }
      await waitForProcExit(proc, hardMs);
    }
  } catch (err) {
    ctx.log('killTree', String(err));
  }
}

// Environment for the dsh child: drop harness/session leftovers so the
// desktop instance boots clean, keep everything else (proxy, API keys, ...).
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_SHELL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
    delete env[k];
  }
  const dshHome = ctx.getDshHome();
  if (dshHome) env.DSH_HOME = dshHome;
  // 桌面端标记 + 实际 profile：配套插件的 host 半边（插件市场 / Skills 与
  // MCP 等）据此把安装/读写落到桌面专属 profile，而不是原生的 web profile。
  env.DSH_DESKTOP = '1';
  env.DSH_DESKTOP_PROFILE = ctx.getDesktopProfile();
  env.NO_COLOR = '1';
  return env;
}

// 等待一个子进程真正退出（taskkill 先优雅后强杀，锁住的 DLL 要等进程
// 终止才释放）。轮询 tasklist，超时后放行由调用方自行处理。
export function waitForProcExit(proc: ChildProcess | null | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || !proc.pid) { resolve(); return; }
    const pid = proc.pid;
    const started = Date.now();
    const isAlive = (): boolean => {
      if (proc.exitCode !== null) return false;
      if (!IS_WIN) {
        try { process.kill(pid, 0); return true; } catch { return false; }
      }
      try {
        const out = cp.execSync(
          'tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
        return out.includes('"' + pid + '"');
      } catch { return false; }
    };
    const check = (): void => {
      if (!isAlive()) { resolve(); return; }
      if (Date.now() - started >= timeoutMs) {
        ctx.log('service', '等待旧服务进程退出超时（PID ' + pid + '），继续');
        resolve();
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}
