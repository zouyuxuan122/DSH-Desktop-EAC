/**
 * lib/ipc/recovery.ts — 恢复域 IPC（Task 4 自 registerChromeIpc 拆分）。
 *
 * dsh:renderer-heartbeat（preload 5s 心跳）/ chrome:recovery-state /
 * chrome:recovery-reload / chrome:recovery-restart / chrome:export-logs
 * （诊断 zip 一键导出）。恢复页面（assets/recovery.html）的按钮与状态
 * 读取，全部校验来源必须是主窗。
 */

import { app, ipcMain, shell } from 'electron';
import * as structuredLogger from '../../logger.js';
import { state } from '../state.js';
import { log } from '../log.js';
import { killTree } from '../proc.js';
import { markCleanExit } from '../run-state.js';
import { startAndShowGuarded } from '../server.js';
import { fromMainWindow } from './sender.js';

/** 注册恢复域全部 channel（清单见文件头；boot 时经 lib/ipc/index.ts 统一调用）。 */
export function registerRecoveryIpc(): void {
  // Renderer 心跳：preload 每 5s 上报一次，恢复状态机用它兜底判定
  // 「挂起但 Chromium 未发出 unresponsive」的场景。
  ipcMain.on('dsh:renderer-heartbeat', (event) => {
    if (state.recovery) state.recovery.noteHeartbeat(event.sender.id);
  });

  ipcMain.handle('chrome:recovery-state', (event) => {
    if (!fromMainWindow(event)) return null;
    return {
      appVersion: app.getVersion(),
      logsDir: state.logsDir,
      crashDumpsDir: app.getPath('crashDumps'),
      state: state.recovery && state.mainWindow ? state.recovery.stateOf(state.mainWindow) : null,
    };
  });

  ipcMain.handle('chrome:recovery-reload', async (event) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    // 服务进程已退出时先重启服务（可能换新端口），再恢复加载。
    if (!state.serverProc || state.serverProc.exitCode !== null || state.serverProc.killed) {
      try {
        await startAndShowGuarded();
      } catch (err) {
        return { ok: false, error: String((err as Error).message) };
      }
    }
    if (state.recovery && state.mainWindow) state.recovery.retryNow(state.mainWindow);
    return { ok: true };
  });

  ipcMain.handle('chrome:recovery-restart', (event) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    log('recovery', '用户在恢复页面选择重启客户端');
    state.quitting = true;
    state.forceQuit = true;
    markCleanExit();
    killTree(state.serverProc);
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  // 一键导出诊断日志 zip（AC-8）：调用 structuredLogger.buildDiagnosticsZip，
  // 打包 logs + configs + updater meta + 最新备份 manifest，PII 二次脱敏后
  // 在文件管理器中选中 zip 文件，方便用户拖到反馈/GitHub issue 里。
  ipcMain.handle('chrome:export-logs', async (event) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    try {
      const zipPath = await structuredLogger.buildDiagnosticsZip({
        logsDir: state.logsDir,
        userDataDir: state.userDataDir,
        dshHome: state.dshHome,
      });
      shell.showItemInFolder(zipPath);
      return { ok: true, zipPath };
    } catch (err) {
      log('boot', '导出诊断日志失败: ' + String((err as Error).message));
      return { ok: false, error: String((err as Error).message) };
    }
  });
}
