/**
 * lib/extension-host/job-fence.ts — 进程围栏（VNext Phase 2，Task 10.4）。
 *
 * 三档实现，对外同一 `FenceHandle` 接口：
 *   1. `win32-job`（首选）：Node `child_process.spawn` 持有 stdio 管道（可靠
 *      流）+ Rust 原生模块（native/supervisor/index.node）把进程绑入 Win32
 *      Job Object —— KILL_ON_JOB_CLOSE（Supervisor 崩溃时 OS 自动回收全部
 *      插件进程）+ 内存/CPU 硬限额；
 *   2. `taskkill-fallback`（降级）：纯 spawn + `taskkill /T /F` 树回收。
 *      **没有**崩溃自动回收保证 —— 降级时打显式警告，恢复中心可据此提示
 *      用户重建原生模块。
 *   3. `process-group`（POSIX）：独立进程组 + 负 PGID 强杀整组；同时由
 *      host-bootstrap 监听 Supervisor owner pipe EOF，在父进程崩溃时主动
 *      SIGTERM 自身进程组。它仍没有 Job Object 的硬资源限额或不可逃逸保证。
 *
 * 实现注记（与 spec「原子 spawn-into-job」的偏差）：Node 26 的 libuv 在
 * Windows 上已不使用 CRT fd 表，原生侧自建管道无法交还 Node 流（EBADF），
 * 故采用「Node spawn + Rust assignToJob」混合围栏。spawn 与 assign 之间的
 * 毫秒级窗口由协议层闭合：host-bootstrap 收到 Supervisor 的 `init` 请求前
 * 不加载任何插件代码（见 host-bootstrap.ts），插件代码不可能在围栏外执行。
 *
 * 失败语义（spec F1.1「缺失/失败优雅降级」）：require .node 的任何异常
 * （未构建、平台不符、ABI 不匹配）都只影响本模块的一次性探测结果，
 * 绝不外抛——插件宿主照常可用，只是围栏弱化。
 */

import path = require('node:path');
import cp = require('node:child_process');
import type { Writable, Readable } from 'node:stream';
import { log } from '../log.js';

/** Rust 原生模块的最小类型面（与 native/supervisor/src/job.rs 对应）。 */
interface NativeSupervisor {
  createJob(opts?: {
    killOnClose?: boolean;
    processMemoryLimitBytes?: number;
    jobMemoryLimitBytes?: number;
    cpuRatePercent?: number;
  }): number;
  /** 把已存在的进程（pid）绑入 Job（assign 失败时调用方须杀进程）。 */
  assignToJob(jobId: number, pid: number): void;
  terminateJob(jobId: number, exitCode?: number): void;
  jobAlive(jobId: number): boolean;
  closeJob(jobId: number): void;
  sha256Stream(path: string): string;
}

export type FenceMode = 'win32-job' | 'taskkill-fallback' | 'process-group';

/** 围栏单进程句柄：stdio 流 + 树级强杀。 */
export interface FenceHandle {
  readonly mode: FenceMode;
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** 进程退出事件（等价 child.exit，供 Manager 感知崩溃）。 */
  onExit(cb: (code: number | null) => void): void;
  /** 强杀整棵进程树（含孙进程），幂等。 */
  kill(): Promise<void>;
  /** 主进程是否仍在运行。 */
  alive(): boolean;
  /** 释放围栏资源（Job 句柄/子进程引用；KILL_ON_JOB_CLOSE 下即回收）。 */
  dispose(): void;
}

/** 围栏实例：一个 Job（或降级通道）可容纳一次宿主启动。 */
export interface Fence {
  readonly mode: FenceMode;
  /** 在围栏内拉起进程（stdio 即 RPC 传输层）。 */
  launch(exe: string, args: string[], cwd?: string): FenceHandle;
  /** 释放围栏资源（launch 失败/未用时的 Job 句柄回收）。 */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 原生模块探测与加载
// ---------------------------------------------------------------------------

let nativeCache: NativeSupervisor | null | undefined;
/** 测试注入：强制视为「原生模块不可用」（验证降级路径端到端）。 */
let forceUnavailableForTest = false;

/** 加载 Rust 围栏模块；缺失/失败返回 null（缓存，只警告一次）。 */
export function loadNativeSupervisor(): NativeSupervisor | null {
  if (forceUnavailableForTest) return null;
  if (process.platform !== 'win32') return null;
  if (nativeCache !== undefined) return nativeCache;
  const file = path.join(__dirname, '..', '..', 'native', 'supervisor', 'index.node');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as NativeSupervisor;
    if (typeof mod.createJob !== 'function' || typeof mod.assignToJob !== 'function') {
      throw new Error('导出面不完整');
    }
    nativeCache = mod;
  } catch (err) {
    log('warn', `job-fence: Rust 围栏模块不可用，降级 taskkill 树回收（无崩溃自动回收保证） file=${file} error=${String((err as Error).message ?? err)}`);
    nativeCache = null;
  }
  return nativeCache;
}

/** 强制原生模块不可用/恢复（仅测试用：验证当前平台的降级围栏）。 */
export function _forceNativeUnavailableForTest(unavailable: boolean): void {
  forceUnavailableForTest = unavailable;
}

// ---------------------------------------------------------------------------
// Win32 Job 围栏实现（Node spawn + Rust assign）
// ---------------------------------------------------------------------------

class JobFenceHandle implements FenceHandle {
  readonly mode = 'win32-job' as const;
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly native: NativeSupervisor;
  private readonly jobId: number;
  private readonly child: cp.ChildProcessWithoutNullStreams;
  private disposed = false;

  constructor(native: NativeSupervisor, jobId: number, child: cp.ChildProcessWithoutNullStreams) {
    this.native = native;
    this.jobId = jobId;
    this.child = child;
    this.pid = child.pid ?? -1;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
  }

  onExit(cb: (code: number | null) => void): void {
    this.child.once('exit', (code) => cb(code));
  }

  async kill(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      // TerminateJobObject 回收整棵树（含插件可能派生的孙进程）。
      this.native.terminateJob(this.jobId, 1);
    } catch {
      // Job 已回收（进程自退出触发）等场景：兜底 taskkill。
      await killProcessTree(this.pid, 'taskkill-fallback');
    }
    this.stdin.destroy();
    try {
      this.native.closeJob(this.jobId);
    } catch {
      /* 句柄已关 */
    }
  }

  alive(): boolean {
    if (this.disposed) return false;
    return this.child.exitCode === null && !this.child.killed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stdin.destroy();
    try {
      // KILL_ON_JOB_CLOSE：关句柄即让 OS 回收 Job 内全部进程 ——
      // Supervisor 退出路径上即便进程仍活着也不会遗留孤儿。
      this.native.closeJob(this.jobId);
    } catch {
      /* 句柄已关 */
    }
  }
}

class JobFence implements Fence {
  readonly mode = 'win32-job' as const;
  private readonly native: NativeSupervisor;
  private readonly jobId: number;
  /** 已用 Job 标记（一 Job 一进程，二次 launch 是编程错误）。 */
  private used = false;

  constructor(
    native: NativeSupervisor,
    opts: { memoryLimitBytes?: number; cpuRatePercent?: number },
  ) {
    this.native = native;
    const jobOpts: Parameters<NativeSupervisor['createJob']>[0] = { killOnClose: true };
    if (opts.memoryLimitBytes !== undefined) jobOpts.processMemoryLimitBytes = opts.memoryLimitBytes;
    if (opts.cpuRatePercent !== undefined) jobOpts.cpuRatePercent = opts.cpuRatePercent;
    this.jobId = native.createJob(jobOpts);
  }

  launch(exe: string, args: string[], cwd?: string): FenceHandle {
    if (this.used) throw new Error('JobFence 一次只承载一个进程');
    this.used = true;
    const child = cp.spawn(exe, args, { cwd, stdio: 'pipe', windowsHide: true });
    if (child.pid === undefined) {
      // spawn 同步失败（exe 不存在等）：清理并抛出，走 start-failed 路径。
      child.kill();
      this.native.closeJob(this.jobId);
      throw new Error(`围栏 spawn 失败: ${exe}`);
    }
    try {
      // spawn 后立即绑入 Job（毫秒级窗口；host-bootstrap 在 init 前不跑插件代码）。
      this.native.assignToJob(this.jobId, child.pid);
    } catch (err) {
      // 绑定失败：绝不允许「无围栏裸奔」—— 杀掉进程、关 Job、抛错。
      child.kill();
      this.native.closeJob(this.jobId);
      throw new Error(`围栏 assign 失败（进程已回收）: ${String((err as Error).message)}`);
    }
    return new JobFenceHandle(this.native, this.jobId, child);
  }

  dispose(): void {
    try {
      this.native.closeJob(this.jobId);
    } catch {
      /* 句柄已关 */
    }
  }
}

// ---------------------------------------------------------------------------
// 降级实现：spawn + taskkill /T /F
// ---------------------------------------------------------------------------

function killProcessTree(pid: number, mode: Exclude<FenceMode, 'win32-job'>): Promise<void> {
  return new Promise((resolve) => {
    if (mode === 'process-group') {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
      }
      resolve();
      return;
    }
    const tk = cp.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    tk.once('exit', () => resolve());
    tk.once('error', () => resolve());
  });
}

class FallbackFenceHandle implements FenceHandle {
  readonly mode: Exclude<FenceMode, 'win32-job'>;
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly child: cp.ChildProcessWithoutNullStreams;
  private killed = false;

  constructor(child: cp.ChildProcessWithoutNullStreams, mode: Exclude<FenceMode, 'win32-job'>) {
    this.child = child;
    this.mode = mode;
    this.pid = child.pid ?? -1;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
  }

  onExit(cb: (code: number | null) => void): void {
    this.child.once('exit', (code) => cb(code));
  }

  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    await killProcessTree(this.pid, this.mode);
    this.stdin.destroy();
  }

  alive(): boolean {
    return !this.killed && this.child.exitCode === null && !this.child.killed;
  }

  dispose(): void {
    this.killed = true;
    this.stdin.destroy();
  }
}

class FallbackFence implements Fence {
  readonly mode: Exclude<FenceMode, 'win32-job'> = process.platform === 'win32'
    ? 'taskkill-fallback'
    : 'process-group';

  launch(exe: string, args: string[], cwd?: string): FenceHandle {
    const child = cp.spawn(exe, args, {
      cwd,
      stdio: 'pipe',
      windowsHide: true,
      detached: this.mode === 'process-group',
    });
    if (child.pid === undefined) {
      child.kill();
      throw new Error(`围栏 spawn 失败: ${exe}`);
    }
    return new FallbackFenceHandle(child, this.mode);
  }

  dispose(): void {
    /* 降级通道无 OS 级资源 */
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export interface FenceOptions {
  /** 单插件宿主内存硬上限（字节，仅 win32-job 模式生效）。 */
  memoryLimitBytes?: number;
  /** CPU 配额百分比 1-100（仅 win32-job 模式生效）。 */
  cpuRatePercent?: number;
}

/** 创建围栏：Windows 优先 Rust Job Object；其余情况使用对应平台的降级围栏。 */
export function createFence(opts: FenceOptions = {}): Fence {
  const native = loadNativeSupervisor();
  if (native) {
    try {
      return new JobFence(native, opts);
    } catch (err) {
      log('warn', `job-fence: Job 创建失败，降级 taskkill error=${String((err as Error).message ?? err)}`);
    }
  }
  return new FallbackFence();
}

/** 原生模块是否可用（恢复中心展示围栏档位用）。 */
export function fenceMode(): FenceMode {
  if (process.platform !== 'win32') return 'process-group';
  return loadNativeSupervisor() ? 'win32-job' : 'taskkill-fallback';
}
