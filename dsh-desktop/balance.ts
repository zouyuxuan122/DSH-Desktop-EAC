'use strict';

// DeepSeek 账户余额查询（主进程模块，供对话统计栏小部件 / chrome 菜单使用）。
//
// 密钥来源：环境变量 DEEPSEEK_API_KEY > DSH_HOME/.credentials.yaml。
// 端点：https://api.deepseek.com/user/balance；可用环境变量覆盖：
//   DEEPSEEK_BALANCE_URL —— 完整端点 URL（自定义代理/镜像）
//   DEEPSEEK_API_BASE    —— API 基址（自动拼接 /user/balance）

import https = require('node:https');
import fs = require('node:fs');
import path = require('node:path');

const DEFAULT_BASE = 'https://api.deepseek.com';

// 官方峰谷定价（2026-08-17 生效）：高峰 9:00-12:00、14:00-18:00（UTC+8），
// 其余为空闲时段，空闲价格为高峰的一半。各模型档位/时段价格（¥/百万 token，
// deepseek-v4-pro 正式定价；其余保留估算档，可在 settings.json 的
// balancePrices.<model>.{peak,offpeak} 中覆盖）。
const DEFAULT_PRICES = {
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
const FALLBACK_PRICES = { peak: { cacheMiss: 2, cacheHit: 0.5, output: 8 }, offpeak: { cacheMiss: 2, cacheHit: 0.5, output: 8 } };

// 默认高峰时段（UTC+8，官方公告 2026-08-17 生效）：9:00-12:00、14:00-18:00。
// 可在 settings.json 的 pricing.peakWindows 覆盖（数组的数组，支持跨午夜段，
// 如 [['23:00','08:00']]）。
const DEFAULT_PEAK_WINDOWS = [['09:00', '12:00'], ['14:00', '18:00']];

function parseHHMM(s: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mn = Number(m[2]);
  if (h > 23 || mn > 59) return null;
  return h * 60 + mn;
}

function fmtHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const mn = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0');
}

// 规范化高峰时段配置 → [[startMin, endMin], ...]（按开始时间升序）。
// 配置非法时回退官方默认；每段 [start, end)，start > end 表示跨午夜。
function normalizePeakWindows(raw: unknown): [number, number][] {
  const valid =
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every(
      (w) =>
        Array.isArray(w) &&
        w.length === 2 &&
        parseHHMM(w[0]) !== null &&
        parseHHMM(w[1]) !== null &&
        parseHHMM(w[0]) !== parseHHMM(w[1])
    );
  const src = (valid ? raw : DEFAULT_PEAK_WINDOWS) as [string, string][];
  return src
    .map(([a, b]) => [parseHHMM(a)!, parseHHMM(b)!] as [number, number])
    .sort((a, b) => a[0] - b[0]);
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

function inWindow(nowMin: number, [start, end]: [number, number]): boolean {
  return start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
}

// 当前峰谷状态：{ period: 'peak'|'offpeak', windows, nextAt }（nextAt 为毫秒时间戳）。
// 用于余额小部件的时段提示与计费档位切换。
function computePricingState(peakWindows: unknown, now = new Date()): { period: 'peak' | 'offpeak'; windows: string[][]; nextAt: number } {
  const windows = normalizePeakWindows(peakWindows);
  const nowMin = minutesOfDay(now);
  const peak = windows.some((w) => inWindow(nowMin, w));
  let next;
  if (peak) {
    const [start, end] = windows.find((w) => inWindow(nowMin, w))!;
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

function readApiKey(dshHome: string): string {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey.trim();
  try {
    const text = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)/);
      if (m) return m[1];
    }
  } catch {}
  return '';
}

// 当前默认模型（~/.dsh/settings.yaml 的 agent-default-model.model），
// 决定按哪一档价格估算本轮费用。
// 修复：先定位 agent-default-model 块，再在该块内匹配 model 行，
// 避免匹配到其他配置块（如 describe-image）的 model 字段。
function readActiveModel(dshHome: string): string {
  try {
    const text = fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8');
    // 找到 agent-default-model: 块的起始位置
    const blockMatch = text.match(/^agent-default-model\s*:/m);
    if (!blockMatch) return '';
    const blockStart = (blockMatch.index ?? 0) + blockMatch[0].length;
    // 找到下一个同级或更高级的 key（缩进 <= 0 的行），作为块的结束
    const rest = text.slice(blockStart);
    const lines = rest.split(/\r?\n/);
    let blockContent = '';
    for (const line of lines) {
      // 跳过空行
      if (!line.trim()) { blockContent += line + '\n'; continue; }
      // 如果缩进为 0（新的顶级 key），则块结束
      if (/^\S/.test(line)) break;
      blockContent += line + '\n';
    }
    // 在 agent-default-model 块内匹配 model 行
    const m = blockContent.match(/^\s*model\s*:\s*(\S+)/m);
    if (m) return m[1];
  } catch {}
  return '';
}

function balanceEndpoint() {
  if (process.env.DEEPSEEK_BALANCE_URL) return process.env.DEEPSEEK_BALANCE_URL;
  const base = (process.env.DEEPSEEK_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  return base + '/user/balance';
}

function fetchJson(url: string, apiKey: string, timeoutMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { Authorization: 'Bearer ' + apiKey, 'User-Agent': 'DSH-Desktop' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 1024 * 1024) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const hint = body.slice(0, 200).trim();
            return reject(new Error('HTTP ' + res.statusCode + (hint ? '：' + hint : '')));
          }
          try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON 解析失败')); }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// 单档价格合并：回退档 <- 模型默认档 <- 用户覆盖（双档 {peak,offpeak} 或旧
// 扁平覆盖），供 refreshBalance 与自定义价格 UI 共用。
function tierPrices(base: unknown, override: unknown, tier: string): Record<string, number> {
  const ov = (override || {}) as Record<string, unknown>;
  const ovDual = !!ov && typeof ov.peak === 'object' && ov.peak !== null &&
    typeof ov.offpeak === 'object' && ov.offpeak !== null;
  const src = (ovDual ? (ov[tier] || {}) : ov) as Record<string, number>;
  const b = (base || {}) as Record<string, unknown>;
  const fallback = FALLBACK_PRICES as Record<string, Record<string, number>>;
  return {
    ...(fallback[tier] || FALLBACK_PRICES),
    ...((b[tier] ? b[tier] : b) as Record<string, number>),
    ...(src || {}),
  };
}

// 自定义价格清洗（dsh:balance-prices-set）：prices 形如
// { peak: { cacheMiss, cacheHit, output }, offpeak: {...} }，三字段必须全部
// 是 0~1000 的有限数字，档位必须存在；否则抛错（防 NaN/负数/超大值/畸形
// 结构写进 settings.json）。
function sanitizePrices(prices: unknown): { peak: Record<string, number>; offpeak: Record<string, number> } {
  const tier = (src: unknown, label: string): Record<string, number> => {
    if (!src || typeof src !== 'object') throw new Error(label + ' 档位缺失');
    const out: Record<string, number> = {};
    for (const key of ['cacheMiss', 'cacheHit', 'output']) {
      const v = Number((src as Record<string, unknown>)[key]);
      if (!Number.isFinite(v) || v < 0 || v > 1000) {
        throw new Error(label + ' 的 ' + key + ' 必须是 0~1000 的数字');
      }
      out[key] = v;
    }
    return out;
  };
  const pr = (prices || {}) as Record<string, unknown>;
  return { peak: tier(pr && pr.peak, '高峰'), offpeak: tier(pr && pr.offpeak, '空闲') };
}

// 返回 { ok, isAvailable?, balances: [{currency,total,granted,toppedUp}], error?, prices }
async function queryBalance(dshHome: string): Promise<Record<string, unknown>> {
  const key = readApiKey(dshHome);
  if (!key) return { ok: false, error: 'no-key', balances: [], prices: DEFAULT_PRICES };
  try {
    const data = (await fetchJson(balanceEndpoint(), key)) as Record<string, unknown>;
    const infos = Array.isArray(data.balance_infos) ? (data.balance_infos as Array<Record<string, unknown>>) : [];
    const balances = infos.map((b) => ({
      currency: String(b.currency || ''),
      total: Number(b.total_balance) || 0,
      granted: Number(b.granted_balance) || 0,
      toppedUp: Number(b.topped_up_balance) || 0,
    }));
    return { ok: true, isAvailable: !!data.is_available, balances, prices: DEFAULT_PRICES };
  } catch (err) {
    return { ok: false, error: String((err && ((err as Error) && (err as Error).message) || err) || err), balances: [], prices: DEFAULT_PRICES };
  }
}

export = {
  queryBalance,
  readApiKey,
  readActiveModel,
  DEFAULT_PRICES,
  FALLBACK_PRICES,
  DEFAULT_PEAK_WINDOWS,
  normalizePeakWindows,
  computePricingState,
  tierPrices,
  sanitizePrices,
};
