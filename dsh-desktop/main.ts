/**
 * main.ts — DSH Desktop 装配入口（Electron 主进程组合根）（Task 7.1 自
 * main.js 迁 TS；编译产物 main.js 即 package.json 的 main 入口）。
 *
 * 本文件只做装配：跨域 bridge 注入 + 应用生命周期接线。全部业务逻辑已按
 * 单一职责迁入 lib/（TypeScript，`npm run build` 原地编译为同名 .js）：
 *   基础层  state / log / proc / paths / bridge
 *   运行层  run-state / watchdog-boot / server / terminal / preview
 *   界面层  window / tray / ipc/* / onboarding
 *   插件层  plugin-registry-data / plugin-copy / plugin-manager-core /
 *           plugins / market-ops / market-modules / session-heal / guard
 *   更新层  update-flow（agent 流）/ client-update（客户端流）
 *   隔离层  supervisor/* / extension-host/* / recovery-center（VNext）
 *   其他    balance-ui / shortcuts / preflight / boot
 *
 * What it does:
 *   1. Boots the bundled dsh CLI ("dsh web") with a standalone Node runtime.
 *   2. Waits until the web UI answers HTTP on 127.0.0.1:<free-port>.
 *   3. Shows it in a native window; quits the server when the app exits.
 *   4. Checks for official @deepseek-ai/dsh releases and, with the user's
 *      consent, self-updates the agent (see lib/update-flow.ts).
 *
 * The dsh CLI is spawned with the bundled node.exe (vendor/node/node.exe in
 * dev, resources/node/node.exe when packaged) so that prebuilt native
 * modules (sharp, node-pty, koffi, ...) match the Node ABI they were
 * installed for. We deliberately never rebuild them against Electron.
 */

import { app } from 'electron';
import { spawn } from 'node:child_process';

// ── lib 装配表（bridge 注入需要运行期引用；保持 require 顺序稳定）──────
import { state } from './lib/state.js';
import { log } from './lib/log.js';
import { IS_WIN, killTreeAndWait } from './lib/proc.js';
import { bridge } from './lib/bridge.js';
import { closeAllFloatWindows, showBox } from './lib/window.js';
import { showMainWindow, getExitAction, askExitAction, trayHintOnce } from './lib/tray.js';
import { ensureGuard } from './lib/guard.js';
import { syncCompanionPlugins, healProfileModules, restoreKeptArtifacts } from './lib/plugins.js';
import { processPendingMarketOps } from './lib/market-ops.js';
import { runUpdateFlow, runClientUpdateFlow } from './lib/update-flow.js';
import { boot, fatal, handleBootFailure } from './lib/boot.js';
import { shutdownExtensionHosts } from './lib/extension-host/manager.js';
import * as structuredLogger from './logger.js';
import * as updaterReal from './updater.js';

// 跨域注入点装配（lib/bridge.ts 的默认实现只是警告占位；这里在模块加载期
// 指向真实实现 —— 装配早于任何事件回调，语义等价于原 main.js 闭包直调）。
bridge.showMainWindow = showMainWindow;
bridge.showBox = showBox;
bridge.ensureGuard = ensureGuard;
bridge.handleBootFailure = handleBootFailure;
bridge.processPendingMarketOps = processPendingMarketOps;
bridge.syncCompanionPlugins = syncCompanionPlugins;
bridge.healProfileModules = healProfileModules;
bridge.restoreKeptArtifacts = restoreKeptArtifacts;
bridge.getExitAction = getExitAction;
bridge.askExitAction = askExitAction;
bridge.trayHintOnce = trayHintOnce;
bridge.runUpdateFlow = runUpdateFlow;
bridge.runClientUpdateFlow = runClientUpdateFlow;

// ---------------------------------------------------------------------------
// App lifecycle（唯一留在入口的职责：单实例锁 + 退出清理）
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.deepseek.dsh.desktop');
  app.on('second-instance', () => {
    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      state.mainWindow.show();
      state.mainWindow.focus();
    }
  });
  app.on('before-quit', (event) => {
    // V4：退出必须等 dsh web 进程树真正死透再退（见 killTreeAndWait 注释）。
    // 首次事件里阻止默认退出，完成异步清理后 app.exit(0)；后续重复事件
    // （window-all-closed 触发的 app.quit 等）直接放行。
    if (state.shutdownInProgress) return;
    state.shutdownInProgress = true;
    event.preventDefault();
    state.quitting = true;
    state.forceQuit = true;
    const t0 = Date.now();
    log('boot', '正在退出，停止 dsh web 进程树…');
    const { markCleanExit } = require('./lib/run-state.js') as typeof import('./lib/run-state.js');
    markCleanExit();
    void (async () => {
      try {
        closeAllFloatWindows();
        // 正在跑的插件市场排队任务：直接强杀（它只是 pnpm 的转发器，
        // 标记文件的 attempts 机制会在下次启动重试）。
        if (state.marketOpChild && state.marketOpChild.pid && state.marketOpChild.exitCode === null) {
          try {
            spawn('taskkill', ['/pid', String(state.marketOpChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } catch {
            /* 已退出 */
          }
        }
        await killTreeAndWait(state.serverProc);
        // VNext Phase 2：树杀全部 SDK 插件 Host（Job 围栏下 Supervisor 崩溃
        // 也有 OS 兜底回收；此处覆盖正常退出路径）。
        await shutdownExtensionHosts();
        updaterReal.abort();
        if (state.sessionWatcher) state.sessionWatcher.stop();
      } catch (err) {
        log('boot', '退出清理异常: ' + String((err as Error)?.message));
      } finally {
        if (state.balanceTimer) clearInterval(state.balanceTimer);
        if (state.tray) {
          try {
            state.tray.destroy();
          } catch {
            /* 已销毁 */
          }
          state.tray = null;
        }
        log('boot', `退出清理完成（耗时 ${Date.now() - t0}ms）`);
        // 日志系统 flush：结构化 logger 先关（flush 缓冲区+结束 rotation stream），
        // 再关 desktop.log 纯文本，保证退出前两条通道都落盘。
        try {
          structuredLogger.close();
        } catch {
          /* 已关 */
        }
        try {
          if (state.desktopLog) state.desktopLog.end();
        } catch {
          /* 已关 */
        }
        app.exit(0);
      }
    })();
  });
  // 关闭窗口后常驻托盘；托盘不存在时才随窗口退出。
  app.on('window-all-closed', () => {
    if (!IS_WIN || !state.tray) app.quit();
  });
  app
    .whenReady()
    .then(boot)
    .catch((err: unknown) => fatal('应用初始化失败', err));
}
