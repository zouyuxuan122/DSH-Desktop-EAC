/**
 * balance.ts — DeepSeek 账户余额查询与峰谷定价（Task 7.1 自 balance.js
 * 迁 TS；主进程模块，供对话统计栏小部件 / chrome 菜单使用）。
 *
 * 密钥来源：环境变量 DEEPSEEK_API_KEY > DSH_HOME/.credentials.yaml。
 * 端点：https://api.deepseek.com/user/balance；可用环境变量覆盖：
 *   DEEPSEEK_BALANCE_URL —— 完整端点 URL（自定义代理/镜像）
 *   DEEPSEEK_API_BASE    —— API 基址（自动拼接 /user/balance）
 */

import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_BASE = 'https://api.deepseek.com';

/** 单档价格（¥/百万 token）。 */
export interface TierPrice {
  cacheMiss: number;
  cacheHit: number;
  output: number;
}

/** 双档价格（高峰/空闲）。 */
export interface DualPrice {
  peak: TierPrice;
  offpeak: TierPrice;
}

/** 价格表条目：双档（原始表）或单档（balance-ui 加工后回填当前时段价）。 */
export type PriceEntry = TierPrice | DualPrice;

/** 官方峰谷定价（2026-08-17 生效）：高峰 9:00-12:00、14:00-18:00（UTC+8），
 *  其余为空闲时段，空闲价格为高峰的一半。各模型档位/时段价格（¥/百万
 *  token，deepseek-v4-pro 正式定价；其余保留估算档，可在 settings.json
 *  的 balancePrices.<model>.{peak,offpeak} 中覆盖）。 */
export const DEFAULT_PRICES: Record<string, DualPrice> = {
  'deepseek-v4-flash': {
    peak: { cacheMiss: 3, cacheHit: 0.1, output: 9 },
    offpeak: { cacheMiss: 1.5, cacheHit: 0.05, output: 4.5 },
  },
  'deepseek-v4-pro': {
    peak: { cacheMiss: 9, cacheHit: 0.3, output: 27 },
    offpeak: { cacheMiss: 4.5, cacheHit: 0.15, output: 13.5 },
  },
  'deepseek-chat': { peak: { cacheMiss: 2, cacheHit: 0.5, output: 8 }, offpeak: { cacheMiss: 2, cacheHit: 0.5, output: 8 } },
  'deepseek-reasoner': { peak: { cacheMiss: 4, cacheHit: 1, output: 16 }, offpeak: { cacheMiss: 4, cacheHit: 1, output: 16 } },
};

export const FALLBACK_PRICES: DualPrice = {
  peak: { cacheMiss: 2, cacheHit: 0.5, output: 8 },
  offpeak: { cacheMiss: 2, cacheHit: 0.5, output: 8 },
};

/** 默认高峰时段（UTC+8，官方公告 2026-08-17 生效）：9:00-12:00、14:00-18:00。
 *  可在 settings.json 的 pricing.peakWindows 覆盖（数组的数组，支持跨午夜
 *  段，如 [['23:00','08:00']]）。 */
export const DEFAULT_PEAK_WINDOWS: string[][] = [
  ['09:00', '12:00'],
  ['14:00', '18:00'],
];

/** HH:MM → 当日分钟数（非法返回 null）。 */
function parseHHMM(s: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mn = Number(m[2]);
  if (h > 23 || mn > 59) return null;
  return h * 60 + mn;
}

/** 分钟数 → HH:MM。 */
function fmtHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const mn = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0');
}

/** 高峰时段（分钟数区间，[start, end)，start > end 表示跨午夜）。 */
export type PeakWindow = [number, number];

/** 规范化高峰时段配置 → [[startMin, endMin], ...]（按开始时间升序）。
 *  配置非法时回退官方默认。 */
export function normalizePeakWindows(raw: unknown): PeakWindow[] {
  const valid =
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every(
      (w) =>
        Array.isArray(w) &&
        w.length === 2 &&
        parseHHMM(w[0]) !== null &&
        parseHHMM(w[1]) !== null &&
        parseHHMM(w[0]) !== parseHHMM(w[1]),
    );
  const src = (valid ? (raw as string[][]) : DEFAULT_PEAK_WINDOWS)
    .map(([a, b]) => [parseHHMM(a) as number, parseHHMM(b) as number] as PeakWindow)
    .sort((a, b) => a[0] - b[0]);
  return src;
}

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function atMinutes(date: Date, minutes: number, dayOffset = 0): Date {
  const t = new Date(date);
  t.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (dayOffset) t.setDate(t.getDate() + dayOffset);
  return t;
}

function inWindow(nowMin: number, [start, end]: PeakWindow): boolean {
  return start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
}

/** 当前峰谷状态（余额小部件的时段提示与计费档位切换用）。 */
export interface PricingState {
  period: 'peak' | 'offpeak';
  windows: string[][];
  nextAt: number;
}

/** 当前峰谷状态：{ period, windows, nextAt }（nextAt 为毫秒时间戳）。 */
export function computePricingState(peakWindows: unknown, now: Date = new Date()): PricingState {
  const windows = normalizePeakWindows(peakWindows);
  const nowMin = minutesOfDay(now);
  const hit = windows.find((w) => inWindow(nowMin, w));
  const peak = !!hit;
  let next: Date;
  if (hit) {
    const [start, end] = hit;
    const dayOffset = start < end ? 0 : nowMin >= start ? 1 : 0;
    next = atMinutes(now, end, dayOffset);
  } else {
    // 离 nowMin 最近的下一段起点（跨天则折入 +1440 的单值比较）。
    let best: number | null = null;
    for (const [start] of windows) {
      const cand = start > nowMin ? start : start + 1440;
      if (best === null || cand < best) best = cand;
    }
    next = atMinutes(now, best ?? 0, 0);
  }
  return {
    period: peak ? 'peak' : 'offpeak',
    windows: windows.map(([s, e]) => [fmtHHMM(s), fmtHHMM(e)]),
    nextAt: next.getTime(),
  };
}

/** 读取 API Key（环境变量 > .credentials.yaml；缺失返回空串）。 */
function readApiKey(dshHome: string): string {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey.trim();
  try {
    const text = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)/);
      if (m && m[1] !== undefined) return m[1];
    }
  } catch {
    /* 无凭据文件 */
  }
  return '';
}

/** 当前默认模型（~/.dsh/settings.yaml 的 agent-default-model.model），
 *  决定按哪一档价格估算本轮费用。 */
export function readActiveModel(dshHome: string): string {
  try {
    const text = fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8');
    const m = text.match(/^\s*model\s*:\s*(\S+)/m);
    if (m && m[1] !== undefined) return m[1];
  } catch {
    /* 无 settings */
  }
  return '';
}

function balanceEndpoint(): string {
  if (process.env.DEEPSEEK_BALANCE_URL) return process.env.DEEPSEEK_BALANCE_URL;
  const base = (process.env.DEEPSEEK_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  return base + '/user/balance';
}

function fetchJson(url: string, apiKey: string, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { Authorization: 'Bearer ' + apiKey, 'User-Agent': 'DSH-Desktop' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          if (body.length > 1024 * 1024) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const hint = body.slice(0, 200).trim();
            reject(new Error('HTTP ' + res.statusCode + (hint ? '：' + hint : '')));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('JSON 解析失败'));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 单档价格合并：回退档 <- 模型默认档 <- 用户覆盖（双档 {peak,offpeak} 或旧
 *  扁平覆盖），供 refreshBalance 与自定义价格 UI 共用。base 可为双档条目
 *  （取其对应档）或旧扁平单档（原样使用）。 */
export function tierPrices(base: PriceEntry | null | undefined, override: unknown, tier: 'peak' | 'offpeak'): TierPrice {
  const ov = override as { peak?: unknown; offpeak?: unknown } | null | undefined;
  const ovDual = ov && typeof ov.peak === 'object' && ov.peak !== null && typeof ov.offpeak === 'object' && ov.offpeak !== null;
  const src = ovDual ? (((ov as Record<'peak' | 'offpeak', unknown>)[tier] as Record<string, number>) ?? {}) : ((ov as Record<string, number>) || {});
  const dual = base as Partial<DualPrice> | null | undefined;
  const baseTier: Record<string, number> = dual && dual[tier] ? (dual[tier] as unknown as Record<string, number>) : ((base as unknown as Record<string, number>) || {});
  return {
    ...(FALLBACK_PRICES[tier] as unknown as Record<string, number>),
    ...baseTier,
    ...src,
  } as unknown as TierPrice;
}

/** 自定义价格清洗（dsh:balance-prices-set）：prices 形如
 *  { peak: { cacheMiss, cacheHit, output }, offpeak: {...} }，三字段必须全部
 *  是 0~1000 的有限数字，档位必须存在；否则抛错（防 NaN/负数/超大值/畸形
 *  结构写进 settings.json）。 */
export function sanitizePrices(prices: { peak?: unknown; offpeak?: unknown } | null | undefined): DualPrice {
  const tier = (src: unknown, label: string): TierPrice => {
    if (!src || typeof src !== 'object') throw new Error(label + ' 档位缺失');
    const s = src as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const key of ['cacheMiss', 'cacheHit', 'output'] as const) {
      const v = Number(s[key]);
      if (!Number.isFinite(v) || v < 0 || v > 1000) {
        throw new Error(label + ' 的 ' + key + ' 必须是 0~1000 的数字');
      }
      out[key] = v;
    }
    return out as unknown as TierPrice;
  };
  return { peak: tier(prices && prices.peak, '高峰'), offpeak: tier(prices && prices.offpeak, '空闲') };
}

/** 单币种余额条目。 */
export interface BalanceEntry {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

/** balance-ui 加工后的峰谷定价（含双档展开价）。 */
export interface ProcessedPricing extends PricingState {
  prices: { peak: TierPrice; offpeak: TierPrice };
}

/** queryBalance 的结果。 */
export interface BalanceResult {
  ok: boolean;
  isAvailable?: boolean;
  balances: BalanceEntry[];
  error?: string;
  /** 原始为双档表（DEFAULT_PRICES）；balance-ui 加工后回填为「模型 → 当前时段价」。 */
  prices: Record<string, PriceEntry>;
  /** balance-ui 加工后回填的峰谷状态与双档展开价。 */
  pricing?: ProcessedPricing;
}

/** 查询账户余额（无 key 时 ok=false error='no-key'）。 */
export async function queryBalance(dshHome: string): Promise<BalanceResult> {
  const key = readApiKey(dshHome);
  if (!key) return { ok: false, error: 'no-key', balances: [], prices: DEFAULT_PRICES };
  try {
    const data = (await fetchJson(balanceEndpoint(), key)) as {
      is_available?: unknown;
      balance_infos?: unknown[];
    };
    const balances = Array.isArray(data.balance_infos)
      ? data.balance_infos.map((raw) => {
          const b = raw as Record<string, unknown>;
          return {
            currency: String(b.currency || ''),
            total: Number(b.total_balance) || 0,
            granted: Number(b.granted_balance) || 0,
            toppedUp: Number(b.topped_up_balance) || 0,
          };
        })
      : [];
    return { ok: true, isAvailable: !!data.is_available, balances, prices: DEFAULT_PRICES };
  } catch (err) {
    return { ok: false, error: String((err as Error).message || err), balances: [], prices: DEFAULT_PRICES };
  }
}
