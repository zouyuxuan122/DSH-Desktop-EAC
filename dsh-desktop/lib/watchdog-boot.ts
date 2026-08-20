/**
 * lib/watchdog-boot.ts — 看门狗与 junction 巡检启动（Task 2.2 自 main.js 提取）。
 *
 *   1) startWatchdog：拉起独立 watchdog.js 进程轮询父 PID（仅安装版）；
 *   2) startJunctionWatchdog：周期巡检共享 junction 归属，被原生 dsh 改写
 *      且外部进程已退出时修复回客户端闭包；
 *   3) detectExternalDsh：CIM 查询本机其它 dsh 进程。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { app, Notification } from 'electron';
import { state } from './state.js';
import { log } from './log.js';
import { IS_WIN, nodeExe } from './proc.js';
import { runStatePath } from './run-state.js';
import { bridge } from './bridge.js';

/** 启动看门狗（仅安装版 + Windows：开发模式重启会与调试流程互相干扰）。 */
export function startWatchdog(): void {
  if (!app.isPackaged || !IS_WIN) return;
  const watchdogJs = path.join(__dirname, '..', 'watchdog.js');
  if (!fs.existsSync(watchdogJs)) return;
  try {
    const child = spawn(
      nodeExe(),
      [
        watchdogJs,
        '--pid=' + process.pid,
        '--exe=' + process.execPath,
        '--state=' + runStatePath(),
        '--log=' + path.join(state.logsDir, 'watchdog.log'),
      ],
      {
        cwd: path.dirname(process.execPath),
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    child.unref();
    log('watchdog', `看门狗已启动 pid=${child.pid}`);
  } catch (err) {
    log('watchdog', '看门狗启动失败: ' + String((err as Error).message));
  }
}

// ---------------------------------------------------------------------------
// junction 归属巡检：原生 dsh（npx / 全局安装）启动时会把 <home>/profiles/
// node_modules 的共享 junction 重新指向它自己的闭包 —— 桌面端正在运行的
// 服务随后解析到错误版本（「设置命名空间不可用」的一大根因），npx 缓存
// 被清理后更是直接悬空。这里周期性检查：发现异动且外部 dsh 进程已退出，
// 就把指向修复回客户端闭包（原生 CLI 重启时会再次指回它自己，互不纠缠：
// 各自启动时各自纠正，运行中互不打扰）。
// ---------------------------------------------------------------------------
export function startJunctionWatchdog(): void {
  if (!IS_WIN) return;
  let notified = false;
  const tick = async (): Promise<void> => {
    if (state.quitting || state.restartingServer) return;
    try {
      const g = bridge.ensureGuard();
      const findings = g.junctionFindings();
      if (findings.length === 0) return;
      const ext = await detectExternalDsh();
      if (ext.running) {
        log('guard', '共享模块被外部 dsh 接管（PID ' + ext.pids.join(', ') + '），待其退出后自动修复');
        return;
      }
      const res = g.repairJunctions();
      if (res.repaired.length && !notified) {
        notified = true;
        try {
          const n = new Notification({
            title: '已自动修复共享模块指向',
            body: '检测到原生 dsh 改写了共享模块目录，桌面端已恢复指向自身版本。原生 CLI 如有异常，重启它即可。',
            icon: path.join(__dirname, '..', 'assets', 'icon.png'),
          });
          n.on('click', () => bridge.showMainWindow());
          n.show();
        } catch {
          /* 通知失败不影响修复 */
        }
      }
    } catch {
      /* 巡检失败静默 */
    }
  };
  setInterval(() => {
    void tick().catch(() => {});
  }, 5 * 60 * 1000).unref();
}

/** 外部 dsh 进程检测结果。 */
export interface ExternalDshResult {
  running: boolean;
  pids: number[];
}

// 检测本机是否有其它 dsh 进程在跑（原生 CLI / 另一份安装）。Windows 下用
// CIM 查 node 进程命令行；超时或失败按「无外部进程」处理（宁可漏报）。
export function detectExternalDsh(): Promise<ExternalDshResult> {
  return new Promise((resolve) => {
    if (!IS_WIN) {
      resolve({ running: false, pids: [] });
      return;
    }
    const own = new Set<number>([process.pid]);
    if (state.serverProc && state.serverProc.pid) own.add(state.serverProc.pid);
    let out = '';
    try {
      out = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\'\'node.exe\'\'\' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
        { encoding: 'utf8', windowsHide: true, timeout: 12000 },
      );
    } catch {
      resolve({ running: false, pids: [] });
      return;
    }
    try {
      const arr = out.trim() === '' ? [] : (JSON.parse(out) as unknown);
      const list = Array.isArray(arr) ? arr : [arr];
      const pids: number[] = [];
      for (const it of list) {
        const item = it as { ProcessId?: unknown; CommandLine?: unknown } | null;
        const pid = Number(item && item.ProcessId);
        const cmd = String((item && item.CommandLine) || '');
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
