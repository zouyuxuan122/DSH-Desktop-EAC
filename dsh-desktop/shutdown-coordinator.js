'use strict';

// 统一应用退出、客户端重启和封装更新接管。
//
// 任何会终止 dsh web 的应用级路径都应经过这里，确保看门狗先收到 cleanExit
// 标记，并且子进程树在重启/更新交接前完成有界清理。平台差异由注入的
// terminateChildTree 实现承担，协调器本身不执行 taskkill 或 POSIX shell。

/**
 * @typedef {import('node:child_process').ChildProcess} ChildProc
 */

/**
 * 协调器依赖（main.js 注入；全部为稳定引用或 getter）。
 * @typedef {object} CoordinatorDeps
 * @property {{ relaunch(): void, exit(code?: number): void, quit(): void }} app
 * @property {(tag: string, msg: string) => void} log
 * @property {() => void} markCleanExit
 * @property {(v: boolean) => void} setQuitting
 * @property {(v: boolean) => void} setForceQuit
 * @property {() => ChildProc | null} getServerProcess
 * @property {(proc: ChildProc | null) => Promise<void>} stopServerProcess
 * @property {(child: ChildProc) => void} terminateChildTree
 * @property {() => ChildProc | null} getMarketOpChild
 * @property {() => void} closeAllFloatWindows
 * @property {() => void} abortUpdater
 * @property {() => void} stopSessionWatcher
 * @property {() => void} clearBalanceTimer
 * @property {() => void} destroyTray
 * @property {(ctx: object, pending: { version: string, path: string }) => Promise<void>} applyClientUpdate
 */

/**
 * @param {CoordinatorDeps} deps
 */
function createShutdownCoordinator(deps) {
  const {
    app,
    log,
    markCleanExit,
    setQuitting,
    setForceQuit,
    getServerProcess,
    stopServerProcess,
    terminateChildTree,
    getMarketOpChild,
    closeAllFloatWindows,
    abortUpdater,
    stopSessionWatcher,
    clearBalanceTimer,
    destroyTray,
    applyClientUpdate,
  } = deps;

  let shutdownInProgress = false;

  async function stopRuntime() {
    closeAllFloatWindows();
    const marketChild = getMarketOpChild();
    if (marketChild && marketChild.pid && marketChild.exitCode === null) {
      try { terminateChildTree(marketChild); } catch (err) {
        log('boot', '终止插件市场任务失败: ' + (/** @type {Error} */ (err)).message);
      }
    }
    await stopServerProcess(getServerProcess());
    abortUpdater();
    stopSessionWatcher();
    clearBalanceTimer();
    destroyTray();
  }

  async function restartApp({ force = false } = {}) {
    setQuitting(true);
    if (force) setForceQuit(true);
    markCleanExit();
    await stopRuntime();
    app.relaunch();
    app.exit(0);
  }

  /**
   * @param {object} ctx
   * @param {{ version: string, path: string }} pendingUpdate
   */
  async function restartWithClientUpdate(ctx, pendingUpdate) {
    setQuitting(true);
    setForceQuit(true);
    markCleanExit();
    await stopRuntime();
    await applyClientUpdate(ctx, pendingUpdate);
    setTimeout(() => app.exit(0), 400);
  }

  /** @param {{ preventDefault(): void }} event */
  function beforeQuit(event) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    event.preventDefault();
    setQuitting(true);
    setForceQuit(true);
    const started = Date.now();
    log('boot', '正在退出，停止 dsh web 进程树…');
    markCleanExit();
    stopRuntime()
      .catch((err) => log('boot', '退出清理异常: ' + err.message))
      .finally(() => {
        log('boot', `退出清理完成（耗时 ${Date.now() - started}ms）`);
        app.exit(0);
      });
  }

  return {
    restartApp,
    restartWithClientUpdate,
    beforeQuit,
    isShuttingDown: () => shutdownInProgress,
  };
}

module.exports = { createShutdownCoordinator };
