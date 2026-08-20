/**
 * lib/renderer-recovery/policy.ts — 恢复策略类型/参数/纯函数（Task 14 自
 * renderer-recovery.ts 拆出；背景与设计约束见根门面文件头）。
 *
 * 本文件不含任何副作用：类型 + 默认参数 + 可单测的纯决策函数。
 */

/** 恢复策略参数（测试可注入覆盖）。 */
export interface RecoveryOpts {
  /** 一个「故障窗口」内允许的自动恢复动作总数（含重建主窗）。 */
  MAX_ATTEMPTS: number;
  /** 故障窗口时长：超过此时长无新故障（或已稳定）才清零计数。 */
  ATTEMPT_WINDOW_MS: number;
  /** 加载成功后需要稳定存活这么久才清零故障计数。 */
  STABILITY_MS: number;
  FIRST_DELAY_MS: number;
  BACKOFF_BASE_MS: number;
  BACKOFF_MAX_MS: number;
  LOAD_TIMEOUT_MS: number;
  UNRESPONSIVE_GRACE_MS: number;
  HEARTBEAT_MISS_MS: number;
  SERVER_WAIT_MAX_MS: number;
  ERROR_PAGE_RELOAD_MIN_INTERVAL_MS: number;
  HANG_PENDING_TOLERANCE_MS: number;
}

export const DEFAULT_OPTS: RecoveryOpts = {
  MAX_ATTEMPTS: 4,
  ATTEMPT_WINDOW_MS: 90 * 1000,
  STABILITY_MS: 30 * 1000,
  FIRST_DELAY_MS: 800,
  BACKOFF_BASE_MS: 2000,
  BACKOFF_MAX_MS: 15000,
  LOAD_TIMEOUT_MS: 30 * 1000,
  UNRESPONSIVE_GRACE_MS: 20 * 1000,
  HEARTBEAT_MISS_MS: 45 * 1000,
  SERVER_WAIT_MAX_MS: 60 * 1000,
  ERROR_PAGE_RELOAD_MIN_INTERVAL_MS: 10 * 1000,
  HANG_PENDING_TOLERANCE_MS: 10 * 1000,
};

/** 窗口类型：主窗 / 会话浮窗。 */
export type WindowKind = 'main' | 'float';

/** 恢复动作档位。 */
export type RecoveryAction = 'reload' | 'rebuild' | 'give-up';

/** 加载目标页。 */
export type LoadTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string } | null;

/** 单次故障记录（错误页 / 状态查询展示）。 */
export interface FailureRecord {
  reason: string;
  exitCode: number | null;
  at: string;
}

/** 窗口的最小结构类型（不依赖 electron）。 */
export interface RecoveryWindow {
  readonly id: number;
  isDestroyed(): boolean;
  destroy(): void;
  on(ev: 'show', cb: () => void): unknown;
  on(ev: 'hide', cb: () => void): unknown;
  readonly webContents: {
    readonly id: number;
    on(ev: string, cb: (...args: unknown[]) => void): unknown;
    getURL(): string;
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    forcefullyCrashRenderer?(): void;
  };
}

/** RendererRecovery 的注入依赖（全部由 lib/window.ts 提供）。 */
export interface RendererRecoveryDeps extends Partial<RecoveryOpts> {
  log(msg: string): void;
  isQuitting(): boolean;
  isServerAlive(): boolean;
  getTarget(win: RecoveryWindow): LoadTarget;
  loadingPage: string;
  recoveryPage: string;
  rebuildMainWindow(opts: { startHidden: boolean }): RecoveryWindow | null;
  waitServerUp(maxMs: number): Promise<unknown>;
  onGaveUp?(lastFailure: FailureRecord | null): void;
  onRecovered?(): void;
  onStable?(): void;
  notify?(title: string, body: string): void;
}

/** 单窗口恢复状态。 */
export interface WindowState {
  kind: WindowKind;
  failures: number;
  windowStart: number;
  gaveUp: boolean;
  expectingWeb: boolean;
  userHidden: boolean; // 窗口创建时是隐藏的；show 事件后置 false
  attemptTimer: NodeJS.Timeout | null;
  stabilityTimer: NodeJS.Timeout | null;
  hangGrace: NodeJS.Timeout | null;
  hangDetectedAt: number;
  gen: number;
  rebuiltInBurst: boolean;
  failuresAtLoad: number;
  loadFlight: { active: boolean } | null; // 在途加载：active 时 did-fail-load 由加载调用方处理
  lastFailure: FailureRecord | null;
  lastErrorPageAt: number;
  pendingHangCrash: number;
}

/** 纯函数：按故障次数计算退避延迟（指数退避 + 抖动，避免雷击效应）。 */
export function computeBackoff(failureCount: number, opts?: Partial<RecoveryOpts>): number {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  if (failureCount <= 1) return o.FIRST_DELAY_MS;
  const cap = Math.min(o.BACKOFF_MAX_MS, o.BACKOFF_BASE_MS * 2 ** (failureCount - 1));
  const jitter = Math.round(cap * (0.15 + 0.2 * Math.random())); // +15%~+35%
  return Math.round(cap + jitter);
}

/** 纯函数：由当前故障计数决定下一步动作。
 *  failures 1~2 → reload；3（主窗且本窗口未重建过）→ rebuild；>MAX → give-up。 */
export function nextAction(failures: number, kind: WindowKind, rebuiltInBurst: boolean): RecoveryAction {
  if (failures > DEFAULT_OPTS.MAX_ATTEMPTS) return 'give-up';
  if (kind === 'main' && failures === 3 && !rebuiltInBurst) return 'rebuild';
  return 'reload';
}

/** origin 精确比较（解析失败视为不同源）。 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
