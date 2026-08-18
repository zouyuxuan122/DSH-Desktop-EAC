'use strict';

// dsh web 的生命周期边界。
//
// 这个模块只管理服务进程、端口选择、就绪探测和启动状态；窗口、插件市场
// 和应用退出由 main.js 的其他协调器负责。所有主进程依赖通过工厂参数注入，
// 便于用 fake child process / fake HTTP server 做组件测试，也避免新模块读取
// main.js 的隐式全局状态。

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

/**
 * 子进程句柄（真实 child_process.ChildProcess，含 stdout/stderr/on 事件面）。
 * @typedef {import('node:child_process').ChildProcess} ChildProc
 */

/**
 * 服务状态机取值。
 * @typedef {'booting' | 'running' | 'restarting' | 'failed' | 'stopping' | 'stopped'} ServiceState
 */

/**
 * watchServerProc 选项。
 * @typedef {object} WatchOpts
 * @property {number} [expectedPort]
 * @property {number} [unsafePortRetries]
 * @property {string[]} [overlays]
 * @property {boolean} [firstBoot]
 */

/**
 * supervisor 依赖（main.js 注入；可变状态一律以 getter 函数传入）。
 * @typedef {object} SupervisorDeps
 * @property {{ isPackaged: boolean }} app
 * @property {(cmd: string, args: string[], opts: object) => ChildProc} spawn
 * @property {() => string} nodeExe
 * @property {() => string} dshBin
 * @property {() => NodeJS.ProcessEnv} childEnv
 * @property {() => string} desktopProfile
 * @property {() => string} desktopProfileDir
 * @property {() => string} userDataDir
 * @property {() => string} getLogsDir
 * @property {(ctx: object) => Promise<number>} chooseStableWebPort
 * @property {() => object} stablePortCtx
 * @property {(url: string) => number} restrictedPortOf
 * @property {(url: string) => number} [overrideAnnouncedPort]
 * @property {(ctx: object) => { webPort?: number }} loadSettings
 * @property {(ctx: object, s: { webPort?: number }) => boolean} saveSettings
 * @property {() => object} updCtx
 * @property {(proc: ChildProc | null | undefined) => void} killTree
 * @property {(proc: ChildProc | null | undefined, timeoutMs: number) => Promise<void>} waitForProcExit
 * @property {() => boolean} isQuitting
 * @property {() => boolean} isRestarting
 * @property {(proc: ChildProc | null) => void} onProcessChanged
 * @property {(info: { code: number | null, signal: NodeJS.Signals | null, proc: ChildProc, logPath: string }) => void} onUnexpectedExit
 * @property {(tag: string, msg: string) => void} log
 * @property {typeof fs} [fsImpl]
 * @property {typeof http} [httpImpl]
 * @property {typeof path} [pathImpl]
 */

const SERVICE_STATES = new Set([
  'booting',
  'running',
  'restarting',
  'failed',
  'stopping',
  'stopped',
]);

/**
 * @param {SupervisorDeps} deps
 */
function createWebServiceSupervisor(deps) {
  const {
    app,
    spawn,
    nodeExe,
    dshBin,
    childEnv,
    desktopProfile,
    desktopProfileDir,
    userDataDir,
    getLogsDir,
    chooseStableWebPort,
    stablePortCtx,
    restrictedPortOf,
    overrideAnnouncedPort,
    loadSettings,
    saveSettings,
    updCtx,
    killTree,
    waitForProcExit,
    isQuitting,
    isRestarting,
    onProcessChanged,
    onUnexpectedExit,
    log,
    fsImpl = fs,
    httpImpl = http,
    pathImpl = path,
  } = deps;

  /** @type {ChildProc | null} */
  let serverProc = null;
  /** @type {ServiceState} */
  let state = 'stopped';
  /** @type {string | null} */
  let currentUrl = null;

  /** @param {ServiceState} next */
  function setState(next) {
    if (!SERVICE_STATES.has(next)) throw new Error('未知 dsh 服务状态: ' + next);
    state = next;
  }

  /** @param {ChildProc | null} next */
  function setProcess(next) {
    serverProc = next;
    if (typeof onProcessChanged === 'function') onProcessChanged(next);
  }

  /** @param {ChildProc | null | undefined} [proc] */
  function isAlive(proc = serverProc) {
    return !!proc && proc.exitCode === null && !proc.killed;
  }

  function logPath() {
    return pathImpl.join(getLogsDir(), 'dsh-web.log');
  }

  /**
   * @param {number} unsafePortRetries
   * @param {string[]} overlays
   * @returns {Promise<string>}
   */
  async function start(unsafePortRetries = 4, overlays = []) {
    if (isAlive() && !isQuitting()) {
      log('dsh', 'startServer 重入：先终结旧进程再启动');
      killTree(serverProc);
      setProcess(null);
    }

    setState(isRestarting() ? 'restarting' : 'booting');
    const webPort = await chooseStableWebPort(stablePortCtx());
    const nodeBin = nodeExe();
    const bin = dshBin();
    if (!fsImpl.existsSync(nodeBin)) {
      setState('failed');
      throw new Error(
        '找不到内置 Node 运行时: ' + nodeBin + '\n' +
        (app.isPackaged ? '安装包可能不完整，请重新安装。' : '开发模式请先运行: npm run fetch-node')
      );
    }

    const out = fsImpl.createWriteStream(logPath(), { flags: 'a' });
    log('dsh', `启动: "${nodeBin}" "${bin}" web --host 127.0.0.1 --port ${webPort}`);
    const patchArgs = overlays
      .filter((p) => typeof p === 'string' && p && fsImpl.existsSync(p))
      .flatMap((p) => ['--patch', p]);
    const proc = spawn(nodeBin, [
      '--use-system-ca', bin, '--profile', desktopProfile(),
      '--host', '127.0.0.1', '--port', String(webPort), ...patchArgs,
    ], {
      cwd: userDataDir,
      env: childEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    setProcess(proc);
    const firstBoot = !fsImpl.existsSync(pathImpl.join(desktopProfileDir(), 'node_modules'));
    return watchServerProc(proc, out, {
      expectedPort: webPort,
      unsafePortRetries,
      overlays,
      firstBoot,
    });
  }

  /**
   * @param {ChildProc} proc
   * @param {import('node:fs').WriteStream} out
   * @param {WatchOpts} [opts]
   * @returns {Promise<string>}
   */
  function watchServerProc(proc, out, opts = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let handedOff = false;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let bootTimer = null;

      /** @param {Function} fn @param {unknown} value @param {ServiceState} [nextState] */
      const finish = (fn, value, nextState) => {
        if (nextState) setState(nextState);
        if (!settled) {
          settled = true;
          fn(value);
        }
        if (bootTimer) {
          clearTimeout(bootTimer);
          bootTimer = null;
        }
      };
      /** @param {string} url */
      const resolveReady = (url) => {
        currentUrl = url;
        finish(resolve, url, 'running');
      };
      /** @param {Error} err */
      const rejectStart = (err) => finish(reject, err, 'failed');

      /** @param {Buffer} chunk */
      const onData = (chunk) => {
        out.write(chunk);
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          const match = line.match(/dsh web:\s+(https?:\/\/\S+)/);
          if (!match) continue;
          // 正则已整体匹配，捕获组必然存在（noUncheckedIndexedAccess 需要断言）。
          const url = /** @type {string} */ (match[1]);
          let blocked = restrictedPortOf(url);
          const forcedPort = typeof overrideAnnouncedPort === 'function'
            ? overrideAnnouncedPort(url)
            : 0;
          if (forcedPort) blocked = forcedPort;
          // undefined 等价 0 次重试（watchServerProc 缺省调用），保持原语义。
          const retriesLeft = typeof opts.unsafePortRetries === 'number' ? opts.unsafePortRetries : 0;
          if (blocked && retriesLeft > 0) {
            handedOff = true;
            setState('restarting');
            log('dsh', `端口 ${blocked} 属于 Chromium 受限端口（ERR_UNSAFE_PORT），重启服务换端口（剩余重试 ${retriesLeft} 次）`);
            killTree(proc);
            setTimeout(() => {
              if (isQuitting()) return rejectStart(new Error('应用正在退出'));
              start(retriesLeft - 1, opts.overlays || []).then(resolveReady, rejectStart);
            }, 600);
            return;
          }

          try {
            const actual = Number(new URL(url).port) || 0;
            if (opts.expectedPort != null && actual > 0 && actual !== opts.expectedPort) {
              const ctx = updCtx();
              const settings = loadSettings(ctx);
              settings.webPort = actual;
              saveSettings(ctx, settings);
            }
          } catch (err) {
            log('dsh', '保存服务实际端口失败: ' + (/** @type {Error} */ (err)).message);
          }
          resolveReady(url);
        }
      };

      if (proc.stdout) proc.stdout.on('data', onData);
      if (proc.stderr) proc.stderr.on('data', (chunk) => out.write(chunk));
      proc.on('error', rejectStart);
      proc.on('exit', (code, signal) => {
        out.end();
        log('dsh', `进程退出 code=${code} signal=${signal}`);
        const intentional = isRestarting() || serverProc !== proc;
        if (serverProc === proc) setProcess(null);
        if (!handedOff) rejectStart(new Error(`dsh web 启动失败（退出码 ${code}）。日志: ${logPath()}`));
        if (!isQuitting() && !intentional && !handedOff && currentUrl) {
          setState('failed');
          if (typeof onUnexpectedExit === 'function') {
            onUnexpectedExit({ code, signal, proc, logPath: logPath() });
          }
        }
      });

      if (opts.expectedPort && restrictedPortOf(`http://127.0.0.1:${opts.expectedPort}`) === 0) {
        const probeUrl = `http://127.0.0.1:${opts.expectedPort}`;
        (async () => {
          while (!settled) {
            const ok = await new Promise((res) => {
              const req = httpImpl.get(probeUrl + '/', { timeout: 2500 }, (response) => {
                response.resume();
                res(!!response.statusCode && response.statusCode < 500);
              });
              req.on('error', () => res(false));
              req.on('timeout', () => { req.destroy(); res(false); });
            }).catch(() => false);
            if (ok) {
              resolveReady(probeUrl);
              return;
            }
            await new Promise((res) => setTimeout(res, 350));
          }
        })();
      }

      const bootTimeoutMs = opts.firstBoot ? 180000 : 60000;
      bootTimer = setTimeout(
        () => rejectStart(new Error(`等待 dsh web 启动超时（${Math.round(bootTimeoutMs / 1000)} 秒）`)),
        bootTimeoutMs
      );
      bootTimer.unref?.();
    });
  }

  /**
   * @param {string} url
   * @param {number} [timeoutMs]
   * @returns {Promise<string>}
   */
  function waitUntilUp(url, timeoutMs = 120000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const retry = () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error('Web UI 未在预期时间内就绪'));
        } else {
          setTimeout(tick, 300);
        }
      };
      const tick = () => {
        const req = httpImpl.get(url + '/', { timeout: 3000 }, (response) => {
          response.resume();
          if (response.statusCode && response.statusCode < 500) resolve(url);
          else retry();
        });
        req.on('error', retry);
        req.on('timeout', () => { req.destroy(); retry(); });
      };
      tick();
    });
  }

  /**
   * @param {{ graceMs?: number, hardMs?: number }} [opts]
   * @returns {Promise<void>}
   */
  async function stop({ graceMs = 1200, hardMs = 4000 } = {}) {
    const proc = serverProc;
    if (!proc || proc.exitCode !== null) {
      setProcess(null);
      setState('stopped');
      return;
    }
    setState('stopping');
    killTree(proc);
    if (typeof waitForProcExit === 'function') await waitForProcExit(proc, graceMs + hardMs);
    if (serverProc === proc) setProcess(null);
    setState('stopped');
  }

  return {
    start,
    waitUntilUp,
    stop,
    isAlive,
    getProcess: () => serverProc,
    getUrl: () => currentUrl,
    getState: () => state,
  };
}

module.exports = { SERVICE_STATES, createWebServiceSupervisor };
