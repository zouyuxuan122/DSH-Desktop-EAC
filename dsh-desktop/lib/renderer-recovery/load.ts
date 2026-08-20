/**
 * lib/renderer-recovery/load.ts — 带超时与在途标记的受控加载（Task 14 自
 * renderer-recovery.ts 拆出；语义与拆分前逐行一致）。
 *
 * 两个关注点：
 *   · 超时只放弃本次等待、绝不 kill webContents（慢加载是合法场景，后续
 *     故障事件或下一次调度会继续处理）；
 *   · 在途标记（loadFlight）让 did-fail-load 事件与加载 Promise 归并为
 *     同一动作，避免事件与拒绝路径重复计数。
 */

import type { LoadTarget, RecoveryWindow, WindowState } from './policy.js';

/** 带「在途标记」的加载：did-fail-load 事件与该加载属于同一动作，
 *  由本函数的 Promise 结果统一处理，避免事件与拒绝路径重复计数。 */
export async function loadTracked(
  win: RecoveryWindow,
  s: WindowState,
  target: NonNullable<LoadTarget>,
  gen: number,
  timeoutMs: number,
): Promise<void> {
  const flight = { active: true };
  s.loadFlight = flight;
  try {
    await loadWithTimeout(win, target, gen, timeoutMs);
  } finally {
    flight.active = false;
    if (s.loadFlight === flight) s.loadFlight = null;
  }
}

/** 加载目标页并限时等待完成（超时只放弃等待，不 kill webContents）。 */
export function loadWithTimeout(
  win: RecoveryWindow,
  target: NonNullable<LoadTarget>,
  _gen: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (win.isDestroyed()) {
      reject(new Error('window destroyed'));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    /** 一次性落定（成功/失败共用；先到者生效）。 */
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const ok = (): void => {
      if (settled) return;
      settle();
      resolve();
    };
    const fail = (err: unknown): void => {
      if (settled) return;
      settle();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const p = target.kind === 'url' ? win.webContents.loadURL(target.url) : win.webContents.loadFile(target.path);
    p.then(
      () => ok(),
      (err) => fail(err),
    );
    timer = setTimeout(() => {
      // 超时只放弃本次等待，绝不 kill webContents：慢加载（首次启动等）
      // 是合法场景；后续故障事件或下一次调度会继续处理。
      fail(new Error('load timeout'));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}
