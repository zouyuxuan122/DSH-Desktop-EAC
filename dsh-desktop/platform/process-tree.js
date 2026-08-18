'use strict';

// 平台进程树边界：Windows taskkill / tasklist 与 POSIX 进程组信号的唯一实现。
//
// 这是 architecture-refactor-plan.md 里 platform/process-tree-win|linux 的
// 第一步：先以单一模块 + 依赖注入收敛实现（后续 TypeScript 化时再按平台
// 拆文件）。main.js 只在这里实例化一次，把 killTree / killTreeAndWait /
// waitForProcExit 注入给 web-service-supervisor、shutdown-coordinator、
// 服务重启与市场排队任务，不再各自实现或直接拼 shell。
//
// 所有依赖可注入（platform / spawn / execSync / process.kill / log / 定时器），
// 默认值与 main.js 原实现逐行一致；测试用 fake child process 驱动，不依赖
// 真实进程树。

const { spawn, execSync } = require('node:child_process');

/**
 * 子进程句柄（main.js 里 spawn 的 dsh web / 市场任务进程的最小形状）。
 * @typedef {object} ChildProc
 * @property {number} pid
 * @property {number | null} exitCode
 * @property {boolean} [killed]
 * @property {(signal: NodeJS.Signals | number) => void} kill
 */

/**
 * @typedef {object} KillOpts
 * @property {number} [graceMs]
 * @property {number} [hardMs]
 */

/**
 * @typedef {object} ProcessTreeDeps
 * @property {string} [platform] 覆盖 process.platform（测试注入）
 * @property {(cmd: string, args: string[], opts: object) => unknown} [spawnImpl]
 * @property {(cmd: string, opts: object) => string} [execSyncImpl]
 * @property {(pid: number, signal: NodeJS.Signals | number) => void} [killSignal]
 * @property {(tag: string, msg: string) => void} [log]
 * @property {(fn: () => void, ms: number) => { unref: () => unknown }} [setTimer]
 */

/**
 * @typedef {object} ProcessTree
 * @property {(proc: ChildProc | null | undefined) => void} killTree
 * @property {(proc: ChildProc | null | undefined, opts?: KillOpts) => Promise<void>} killTreeAndWait
 * @property {(proc: ChildProc | null | undefined, timeoutMs: number) => Promise<void>} waitForProcExit
 * @property {(pid: number) => boolean} pidAliveWin
 */

/**
 * @param {ProcessTreeDeps} [deps]
 * @returns {ProcessTree}
 */
function createProcessTree(deps = {}) {
  const {
    platform = process.platform,
    spawnImpl = spawn,
    execSyncImpl = execSync,
    /** @type {(pid: number, signal: NodeJS.Signals | number) => void} */
    killSignal = (pid, signal) => process.kill(pid, signal),
    log = () => {},
  } = deps;
  // TS7 对「可选声明类型 + setTimeout 默认值」的解构会求并出 undefined，
  // 这里显式解析（运行时空操作，与原先 destructure 默认完全等价）。
  /** @type {(fn: () => void, ms: number) => { unref: () => unknown }} */
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));

  const IS_WIN = platform === 'win32';

  // Windows tasklist PID 存活探测（killTree 与 waitForProcExit 共用）。
  // CSV 输出里 PID 总是带引号（"app.exe","1234",...），带引号匹配避免裸
  // 子串误命中（如 PID 234 误匹配内存列 "1,234 K"）。查询失败视为已退出。
  /** @param {number} pid */
  function pidAliveWin(pid) {
    try {
      const out = execSyncImpl(
        'tasklist /FI "PID eq ' + pid + '" /FO CSV /NH',
        { encoding: 'utf8', windowsHide: true }
      );
      return out.includes('"' + pid + '"');
    } catch { return false; }
  }

  /** @param {ChildProc | null | undefined} proc */
  function killTree(proc) {
    if (!proc || !proc.pid) return;
    try {
      if (IS_WIN) {
        // M2 修复：先优雅（无 /F）给进程收尾机会（避免撕裂 session.jsonl.zstd），
        // 短等待后仍存活再强杀。
        spawnImpl('taskkill', ['/pid', String(proc.pid), '/T'], { windowsHide: true, stdio: 'ignore' });
        const pid = proc.pid;
        setTimer(() => {
          if (pidAliveWin(pid)) {
            spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          }
        }, 1500);
      } else {
        try { killSignal(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
        const pid = proc.pid;
        setTimer(() => {
          try { killSignal(-pid, 'SIGKILL'); } catch {
            try { killSignal(pid, 'SIGKILL'); } catch {}
          }
        }, 1500).unref();
      }
    } catch (err) {
      log('killTree', String(err));
    }
  }

  // V4 修复「退出后残留一对进程」：退出路径专用的有界同步回收。
  // 旧实现在 before-quit 里调用 killTree —— 强杀补刀挂在 1500ms 的
  // setTimeout 上，而 Electron 在 before-quit 后数百毫秒内就退出，定时器
  // 随主进程湮灭；无 /F 的 taskkill 对控制台进程（node.exe 没有顶层窗口，
  // 无处投递 WM_CLOSE）基本无效。结果是 dsh web 的 node.exe 连同它的
  // conhost.exe 每次退出都原样残留（用户实测三次，三次成对）。
  // 这里：优雅 taskkill → 等待 graceMs → 仍存活则 taskkill /T /F → 再等
  // hardMs，全程有界，绝不无限阻塞退出。
  /**
   * @param {ChildProc | null | undefined} proc
   * @param {KillOpts} [opts]
   * @returns {Promise<void>}
   */
  async function killTreeAndWait(proc, { graceMs = 1200, hardMs = 4000 } = {}) {
    if (!proc || !proc.pid || proc.exitCode !== null) return;
    const pid = proc.pid;
    try {
      if (IS_WIN) {
        spawnImpl('taskkill', ['/pid', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' });
        await waitForProcExit(proc, graceMs);
        if (proc.exitCode !== null) return;
        try {
          const alive = execSyncImpl(
            'tasklist /FI "PID eq ' + pid + '" /FO CSV /NH',
            { encoding: 'utf8', windowsHide: true }
          );
          if (!alive.includes('"' + pid + '"')) return;
        } catch { return; }
        spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await waitForProcExit(proc, hardMs);
      } else {
        try { killSignal(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
        await waitForProcExit(proc, graceMs);
        if (proc.exitCode !== null) return;
        try { killSignal(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
        await waitForProcExit(proc, hardMs);
      }
    } catch (err) {
      log('killTree', String(err));
    }
  }

  // 等待一个子进程真正退出。Windows 轮询 tasklist，POSIX 用 signal 0
  // 探测进程组；超时后放行由调用方自行处理。
  /**
   * @param {ChildProc | null | undefined} proc
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  function waitForProcExit(proc, timeoutMs) {
    return new Promise((resolve) => {
      if (!proc || !proc.pid) return resolve();
      const pid = proc.pid;
      const started = Date.now();
      const isAlive = () => {
        if (proc.exitCode !== null) return false;
        if (IS_WIN) return pidAliveWin(pid);
        // 先探进程组（dsh web 以 setpgid 启动），组不在再退回主 PID：
        // 组存活说明子进程尚在收尾，避免过早放行。
        try { killSignal(-pid, 0); return true; } catch {
          try { killSignal(pid, 0); return true; } catch { return false; }
        }
      };
      const check = () => {
        if (!isAlive()) return resolve();
        if (Date.now() - started >= timeoutMs) {
          log('service', '等待旧服务进程退出超时（PID ' + pid + '），继续');
          return resolve();
        }
        setTimer(check, 200);
      };
      check();
    });
  }

  return { killTree, killTreeAndWait, waitForProcExit, pidAliveWin };
}

module.exports = { createProcessTree };
