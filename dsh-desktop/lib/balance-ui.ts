/**
 * lib/balance-ui.ts — DeepSeek 余额轮询与会话完成通知（Task 5b 自 main.js 提取）。
 *
 * refreshBalance：查询余额 + 按当前默认模型选价格档（settings.json 可覆盖
 * balancePrices.<model>，兼容旧扁平覆盖与 { peak, offpeak } 双档覆盖）+ 峰谷
 * 定价状态加工，推送给 Web UI 的 dsh-balance 插件（dsh:balance channel）。
 * onSessionTurnEnd：会话回合结束系统通知（30s 会话级限频）。
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { Notification } from 'electron';
import * as updater from '../updater.js';
import * as balance from '../balance.js';
import type { BalanceResult, PriceEntry, TierPrice } from '../balance.js';
import { state } from './state.js';
import type { AppState } from './state.js';
import { log } from './log.js';
import { updCtx } from './proc.js';

/** 查询并加工余额/定价，结果推主窗并缓存（state.balanceCache）。 */
export async function refreshBalance(): Promise<BalanceResult> {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  let result: BalanceResult;
  try {
    result = await balance.queryBalance(home);
  } catch (err) {
    result = { ok: false, error: String((err as Error).message), balances: [], prices: {} };
  }
  // 峰谷定价（2026-08-17 起）：按当前时段 pick 高峰/空闲档，两档随 pricing
  // 一起推给页面，时段切换后 client 可本地换档无需等下一次轮询。
  const model = balance.readActiveModel(home) || 'deepseek-v4-pro';
  const table: Record<string, PriceEntry> = result.prices ?? balance.DEFAULT_PRICES;
  const s = updater.loadSettings(updCtx());
  const pricing = balance.computePricingState(
    (s.pricing as { peakWindows?: unknown } | undefined)?.peakWindows,
  );
  const base: PriceEntry = table[model] ?? balance.FALLBACK_PRICES;
  const ov =
    ((s.balancePrices as Record<string, Record<string, unknown>> | undefined)?.[model]) ?? {};
  const tier = (src: 'peak' | 'offpeak'): TierPrice => balance.tierPrices(base, ov, src);
  result.prices = { [model]: tier(pricing.period) };
  result.pricing = { ...pricing, prices: { peak: tier('peak'), offpeak: tier('offpeak') } };
  // AppState 用最小 Like 形状描述缓存；此处按真实结构落缓存。
  state.balanceCache = result as unknown as NonNullable<AppState['balanceCache']>;
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('dsh:balance', result);
  }
  return result;
}

/** 启动余额轮询（立即一次 + 每 15 分钟）。 */
export function startBalanceLoop(): void {
  void refreshBalance().catch(() => {});
  state.balanceTimer = setInterval(() => void refreshBalance().catch(() => {}), 15 * 60 * 1000);
  if (state.balanceTimer.unref) state.balanceTimer.unref();
}

/** 回合结束信息（session-watcher 投影）。 */
export interface TurnEndInfo {
  sessionId: string | null;
  title?: string;
  body?: string;
}

// 会话完成通知：同一会话 30 秒内至多一条（长任务多回合不刷屏）。
const lastNotifyAt = new Map<string, number>(); // sessionId -> timestamp

/**
 * 会话回合结束通知（session-watcher 回调）：系统 toast + 点击聚焦主窗口。
 * 同一会话 30 秒节流（长任务多回合不刷屏）。
 */
export function onSessionTurnEnd(info: TurnEndInfo): void {
  if (!state.notifyOnTurnEnd || state.quitting) return;
  const now = Date.now();
  const key = info.sessionId ?? '';
  const last = lastNotifyAt.get(key) ?? 0;
  if (now - last < 30000) return; // same session: at most one toast per 30s
  lastNotifyAt.set(key, now);
  log('notify', '任务完成: ' + JSON.stringify(info));
  try {
    const n = new Notification({
      title: info.title || 'DSH 任务完成',
      body: info.body || '会话任务已完成',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    });
    n.on('click', () => {
      if (state.mainWindow) {
        if (state.mainWindow.isMinimized()) state.mainWindow.restore();
        state.mainWindow.show();
        state.mainWindow.focus();
      }
    });
    n.show();
  } catch (err) {
    log('notify', '通知发送失败: ' + String((err as Error).message));
  }
}
