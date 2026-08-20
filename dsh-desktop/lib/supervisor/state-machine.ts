/**
 * lib/supervisor/state-machine.ts — 扩展故障状态机（VNext Phase 1，Task 9）。
 *
 * 架构文档 §8：
 *   installed → disabled → starting → running ⇄ retrying → failed
 *                                ↓          ↘
 *                             failed → quarantined → disabled / uninstalled
 *
 * 策略：
 *   · 启动失败：记 incident，按指数退避排下次重试（nextRetryAt）；
 *   · 运行期崩溃：crashStreak+1，未达阈值 → retrying（Manager 重启 Host）；
 *   · 连续失败 ≥ 阈值：自动 quarantined（不再随客户端启动）；
 *   · 稳定运行（healthyForMs）后 crashStreak 清零；
 *   · 用户可在恢复中心解除隔离（quarantined → disabled）后手动重试；
 *   · 全部转移经 incidents.ts 留痕（版本/时间/原因/恢复动作）。
 *
 * 纯函数式核心（canTransition/nextState 可单测），落盘副作用集中在
 * applyTransition —— 与 registry.ts 的原子写盘配合。
 */

import type { ExtensionState, TransitionResult } from '../../shared/protocol.js';
import { readRegistry, writeRegistry } from './registry.js';
import type { RegistryEntry } from './registry.js';
import { recordIncident } from './incidents.js';
import { log } from '../log.js';

/** 连续失败自动隔离阈值。 */
export const QUARANTINE_THRESHOLD = 3;

/** 退避基数（ms）：第 n 次失败后等待 BACKOFF_BASE_MS * 2^(n-1)。 */
export const BACKOFF_BASE_MS = 30 * 1000;

/** 稳定运行时长（ms）：达到后 crashStreak 清零。 */
export const STABLE_MS = 60 * 1000;

/** 架构文档 §8 的合法转移表（key = 当前态，value = 可达态集合）。 */
const TRANSITIONS: Record<ExtensionState, ExtensionState[]> = {
  installed: ['disabled', 'starting', 'uninstalled'],
  disabled: ['installed', 'starting', 'uninstalled'],
  // quarantined：连续第 3 次启动失败（start-failed 达阈值）直接隔离 ——
  // 曾缺失该目标导致 applyTransition 拒绝转移、状态卡死在 starting。
  starting: ['running', 'failed', 'quarantined', 'disabled'],
  running: ['retrying', 'failed', 'disabled', 'uninstalled', 'quarantined'],
  retrying: ['running', 'failed', 'quarantined', 'disabled'],
  failed: ['starting', 'retrying', 'quarantined', 'disabled', 'uninstalled'],
  quarantined: ['disabled', 'uninstalled'],
  uninstalled: ['installed'],
};

/** 判定 from → to 是否为合法转移（纯函数）。 */
export function canTransition(from: ExtensionState, to: ExtensionState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** 驱动事件（Manager/Installer 对状态机的输入）。 */
export type SmEvent =
  | { type: 'enable' }                       // 用户启用（disabled/failed/quarantined → installed）
  | { type: 'disable' }                      // 用户停用
  | { type: 'starting' }                     // Host 开始拉起
  | { type: 'started'; stableForMs?: number } // Host 握手成功（stableForMs ≥ STABLE_MS 清计数）
  | { type: 'crash'; reason: string }        // 运行期退出/心跳超时
  | { type: 'start-failed'; reason: string } // 启动失败/握手失败
  | { type: 'quarantine' }                   // 强制隔离（恢复中心）
  | { type: 'unquarantine' }                 // 解除隔离（恢复中心）
  | { type: 'uninstall' };

/** 事件在架构语义下的目标态（非法输入返回 null，不产生转移）。 */
export function nextState(
  e: RegistryEntry, ev: SmEvent, now = Date.now(),
): { to: ExtensionState; crashStreak: number; nextRetryAt?: string; reason?: string } | null {
  switch (ev.type) {
    case 'enable':
      if (e.state === 'disabled' || e.state === 'failed' || e.state === 'quarantined')
        return { to: 'installed', crashStreak: 0 };
      return null;
    case 'disable':
      if (e.state !== 'uninstalled') return { to: 'disabled', crashStreak: e.crashStreak };
      return null;
    case 'starting':
      if (e.state === 'installed' || e.state === 'disabled' || e.state === 'failed') {
        // 退避窗口未到：拒绝本次拉起（调用方按 nextRetryAt 排期）。
        if (e.nextRetryAt && new Date(e.nextRetryAt).getTime() > now) return null;
        return { to: 'starting', crashStreak: e.crashStreak };
      }
      return null;
    case 'started': {
      if (e.state === 'starting' || e.state === 'retrying') {
        const streak = (ev.stableForMs ?? 0) >= STABLE_MS ? 0 : e.crashStreak;
        return { to: 'running', crashStreak: streak };
      }
      return null;
    }
    case 'crash': {
      if (e.state !== 'running') return null;
      const streak = e.crashStreak + 1;
      const to: ExtensionState = streak >= QUARANTINE_THRESHOLD ? 'quarantined' : 'retrying';
      const step: { to: ExtensionState; crashStreak: number; reason: string; nextRetryAt?: string } = {
        to,
        crashStreak: streak,
        reason: ev.reason,
      };
      if (to === 'retrying') {
        step.nextRetryAt = new Date(now + BACKOFF_BASE_MS * 2 ** (streak - 1)).toISOString();
      }
      return step;
    }
    case 'start-failed': {
      if (e.state !== 'starting' && e.state !== 'retrying') return null;
      const streak = e.crashStreak + 1;
      const to: ExtensionState = streak >= QUARANTINE_THRESHOLD ? 'quarantined' : 'failed';
      const step: { to: ExtensionState; crashStreak: number; reason: string; nextRetryAt?: string } = {
        to,
        crashStreak: streak,
        reason: ev.reason,
      };
      if (to === 'failed') {
        step.nextRetryAt = new Date(now + BACKOFF_BASE_MS * 2 ** (streak - 1)).toISOString();
      }
      return step;
    }
    case 'quarantine':
      if (e.state !== 'uninstalled') return { to: 'quarantined', crashStreak: e.crashStreak };
      return null;
    case 'unquarantine':
      if (e.state === 'quarantined') return { to: 'disabled', crashStreak: 0 };
      return null;
    case 'uninstall':
      if (e.state !== 'uninstalled') return { to: 'uninstalled', crashStreak: 0 };
      return null;
  }
}

/**
 * 应用一次转移：状态机推导 + registry 落盘 + incident 留痕。
 * 返回 TransitionResult；非法/未知插件返回 changed=false。
 */
export function applyTransition(id: string, ev: SmEvent): TransitionResult {
  const reg = readRegistry();
  const e = reg.plugins[id] as RegistryEntry | undefined;
  if (!e) return { from: 'installed', to: 'installed', changed: false, reason: 'unknown-plugin' };
  const step = nextState(e, ev);
  if (!step || !canTransition(e.state, step.to)) {
    return { from: e.state, to: e.state, changed: false, reason: step ? 'illegal-transition' : 'event-not-applicable' };
  }
  const from = e.state;
  e.state = step.to;
  e.crashStreak = step.crashStreak;
  if (step.nextRetryAt) e.nextRetryAt = step.nextRetryAt;
  else delete e.nextRetryAt;
  if (step.to === 'running') e.lastHealthyAt = new Date().toISOString();
  if (step.reason) {
    e.lastError = step.reason.slice(0, 500);
    e.lastErrorAt = new Date().toISOString();
  }
  if (step.to === 'installed' || step.to === 'disabled') {
    delete e.lastError;
    delete e.lastErrorAt;
  }
  reg.plugins[id] = e;
  const ok = writeRegistry(reg);
  if (!ok) return { from, to: from, changed: false, reason: 'registry-write-failed' };
  // 事故留痕：失败/隔离类转移必留；恢复/启停类转移留恢复动作。
  if (step.reason || step.to === 'quarantined' || step.to === 'failed' || from === 'quarantined') {
    recordIncident(id, {
      kind: step.to === 'quarantined' || step.to === 'failed' ? 'fault' : 'recovery',
      from,
      to: step.to,
      version: e.version,
      detail: step.reason ?? `${from} → ${step.to}`,
    });
  }
  log('state-machine', `${id}: ${from} → ${step.to}` + (step.reason ? `（${step.reason.slice(0, 120)}）` : ''));
  return { from, to: step.to, changed: true };
}

/**
 * 稳定运行清零（Manager 心跳成功路径调用）：
 * running 态下持续存活达到 STABLE_MS 后把 crashStreak 清零 —— 长期稳定
 * 的插件偶发一次崩溃不应再向隔离阈值累积（架构文档 §8「稳定清零」）。
 * 非 running 态 / 计数已为 0 时为无操作。
 */
export function noteStableRunning(id: string): void {
  try {
    const reg = readRegistry();
    const e = reg.plugins[id] as RegistryEntry | undefined;
    if (!e || e.state !== 'running' || e.crashStreak === 0) return;
    e.crashStreak = 0;
    delete e.nextRetryAt;
    reg.plugins[id] = e;
    if (writeRegistry(reg)) {
      log('state-machine', `${id}: 稳定运行 ${STABLE_MS / 1000}s，crashStreak 清零`);
    }
  } catch {
    /* 留痕/落盘失败不阻断心跳路径 */
  }
}
