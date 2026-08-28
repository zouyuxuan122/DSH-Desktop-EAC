'use strict';

// junction 归属巡检（ADR 0002 L2 业务服务层；Wave 2 自 junction-patrol.js
// 类型化迁出，行为零变更）：原生 dsh（npx / 全局安装）启动时会把
// <home>/profiles/node_modules 的共享 junction 重新指向它自己的闭包 ——
// 桌面端正在运行的服务随后解析到错误版本（「设置命名空间不可用」的一大
// 根因），npx 缓存被清理后更是直接悬空。这里周期性检查：发现异动且外部
// dsh 进程已退出，就把指向修复回客户端闭包（原生 CLI 重启时会再次指回它
// 自己，互不纠缠：各自启动时各自纠正，运行中互不打扰）。

import path = require('node:path');
import cp = require('node:child_process');
import { ensureGuard } from './guard-box';
import { APP_ROOT } from './runtime-paths';
import type { GuardBoxCtx } from './guard-box';

const IS_WIN = process.platform === 'win32';

/** 注入接口：由宿主（Electron main / Tauri sidecar）在启动时提供。 */
export interface JunctionPatrolCtx extends Pick<GuardBoxCtx, 'log'> {
  isQuitting(): boolean;
  isRestartingServer(): boolean;
  getServerProc(): { pid: number } | null;
  showMainWindow(): void;
  notify(n: { title: string; body: string; icon?: string; onClick?: () => void }): void;
}

let ctx!: JunctionPatrolCtx;
export function init(d: JunctionPatrolCtx): void { ctx = d; }

interface GuardLike { junctionFindings(): unknown[]; repairJunctions(): { repaired: string[] }; }

export function startJunctionWatchdog(): void {
  if (!IS_WIN) return;
  let notified = false;
  const tick = async (): Promise<void> => {
    if (ctx.isQuitting() || ctx.isRestartingServer()) return;
    try {
      const g = ensureGuard() as GuardLike;
      const findings = g.junctionFindings();
      if (findings.length === 0) return;
      const ext = await detectExternalDsh();
      if (ext.running) {
        ctx.log('guard', '共享模块被外部 dsh 接管（PID ' + ext.pids.join(', ') + '），待其退出后自动修复');
        return;
      }
      const res = g.repairJunctions();
      if (res.repaired.length && !notified) {
        notified = true;
        try {
          ctx.notify({
            title: '已自动修复共享模块指向',
            body: '检测到原生 dsh 改写了共享模块目录，桌面端已恢复指向自身版本。原生 CLI 如有异常，重启它即可。',
            icon: path.join(APP_ROOT, 'assets', 'icon.png'),
            onClick: () => ctx.showMainWindow(),
          });
        } catch { /* 通知失败静默 */ }
      }
    } catch { /* 巡检失败静默 */ }
  };
  setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000).unref();
}

// 检测本机是否有其它 dsh 进程在跑（原生 CLI / 另一份安装）。Windows 下用
// CIM 查 node 进程命令行；超时或失败按「无外部进程」处理（宁可漏报）。
export function detectExternalDsh(): Promise<{ running: boolean; pids: number[] }> {
  return new Promise((resolve) => {
    if (!IS_WIN) { resolve({ running: false, pids: [] }); return; }
    const own = new Set<number>([process.pid]);
    const sp = ctx.getServerProc();
    if (sp && sp.pid) own.add(sp.pid);
    let out = '';
    try {
      out = cp.execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\'\'node.exe\'\'\' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
        { encoding: 'utf8', windowsHide: true, timeout: 12000 });
    } catch {
      resolve({ running: false, pids: [] });
      return;
    }
    try {
      const arr = out.trim() === '' ? [] : JSON.parse(out);
      const list = Array.isArray(arr) ? arr : [arr];
      const pids: number[] = [];
      for (const it of list) {
        const pid = Number(it && it.ProcessId);
        const cmd = String((it && it.CommandLine) || '');
        if (!Number.isFinite(pid) || own.has(pid)) continue;
        if (!/dsh|deepseek-ai/i.test(cmd)) continue;
        if (!/(\s|\/|\\)(web|plugin|run|tui)(\s|$)|bin\.(js|ts)/i.test(cmd)) continue;
        pids.push(pid);
      }
      resolve({ running: pids.length > 0, pids });
    } catch {
      resolve({ running: false, pids: [] });
    }
  });
}
