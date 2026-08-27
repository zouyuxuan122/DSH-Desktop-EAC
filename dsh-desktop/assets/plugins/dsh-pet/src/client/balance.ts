// 余额数据层（client 半侧）：拉取 /dsh-pet-7340/balance → 解析 → 档位计算。
// 纯逻辑模块（不依赖 React/DOM），可独立单测；与 host/balance.ts 的 BalanceResult 结构同构
// （HTTP 契约两端各自声明，避免 client 打包跨层 import host）。

/** /dsh-pet-7340/balance 响应（与 host/balance.ts 同构；client 按此结构校验） */
export interface RawBalanceResult {
  ok: boolean;
  provider?: string;
  kind?: 'opencode' | 'deepseek';
  reason?: string;
  message?: string;
  data?: {
    rolling?: unknown;
    weekly?: unknown;
    monthly?: unknown;
    rollingResetsAt?: unknown;
    weeklyResetsAt?: unknown;
    monthlyResetsAt?: unknown;
    currency?: unknown;
    total?: unknown;
    granted?: unknown;
    toppedUp?: unknown;
  };
}

/** 已解析的余额视图（client 展示 + 档位计算用） */
export interface BalanceView {
  provider: string;
  kind: 'opencode' | 'deepseek';
  ok: true;
  /** opencode：三窗口用量（0-100 数字）+ 各自的重置时间 */
  rolling?: number;
  weekly?: number;
  monthly?: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
  /** deepseek：余额金额（字符串，与接口一致） */
  currency?: string;
  total?: string;
  granted?: string;
  toppedUp?: string;
}

/** 无效（不支持/缺凭证/抓取失败）：显式标记，不静默 */
export interface BalanceUnavailable {
  provider: string;
  ok: false;
  reason: 'unsupported' | 'credential-missing' | 'fetch-error';
  message?: string;
}

export type BalanceState = BalanceView | BalanceUnavailable;

const TIMEOUT_MS = 20000;
const RETRIES = 2;

/** 带超时 + 重试的 GET（host 已内置重试，这里再兜底网络抖动） */
async function getWithRetry(url: string): Promise<Response> {
  let last: unknown;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res;
      last = new Error('HTTP ' + res.status);
    } catch (e) {
      last = e;
    }
    if (i < RETRIES) await new Promise((r) => setTimeout(r, 600));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** 拉取当前状态的余额；网络/解析失败显式抛错（上层决定报错方式，绝不静默 0） */
export async function fetchBalanceState(): Promise<BalanceState> {
  const res = await getWithRetry('/dsh-pet-7340/balance');
  const raw: RawBalanceResult = await res.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: /dsh-pet-7340/balance 响应非法');

  const provider = String(raw.provider ?? 'unknown');
  if (raw.ok !== true) {
    const reason =
      raw.reason === 'unsupported' || raw.reason === 'credential-missing' || raw.reason === 'fetch-error'
        ? raw.reason
        : 'fetch-error';
    return { provider, ok: false, reason, message: typeof raw.message === 'string' ? raw.message : undefined };
  }

  if (raw.kind === 'opencode') {
    const d = raw.data;
    if (!d || typeof d !== 'object') throw new Error('dsh-pet: /dsh-pet-7340/balance opencode 数据非法');
    const rolling = Number(d.rolling);
    const weekly = Number(d.weekly);
    const monthly = Number(d.monthly);
    if (![rolling, weekly, monthly].every(Number.isFinite))
      throw new Error('dsh-pet: /dsh-pet-7340/balance opencode 百分比非数字');
    return {
      provider,
      kind: 'opencode',
      ok: true,
      rolling,
      weekly,
      monthly,
      rollingResetsAt: typeof d.rollingResetsAt === 'string' ? d.rollingResetsAt : undefined,
      weeklyResetsAt: typeof d.weeklyResetsAt === 'string' ? d.weeklyResetsAt : undefined,
      monthlyResetsAt: typeof d.monthlyResetsAt === 'string' ? d.monthlyResetsAt : undefined,
    };
  }
  if (raw.kind === 'deepseek') {
    const d = raw.data;
    if (!d || typeof d !== 'object') throw new Error('dsh-pet: /dsh-pet-7340/balance deepseek 数据非法');
    return {
      provider,
      kind: 'deepseek',
      ok: true,
      currency: typeof d.currency === 'string' ? d.currency : undefined,
      total: typeof d.total === 'string' ? d.total : undefined,
      granted: typeof d.granted === 'string' ? d.granted : undefined,
      toppedUp: typeof d.toppedUp === 'string' ? d.toppedUp : undefined,
    };
  }
  throw new Error('dsh-pet: /dsh-pet-7340/balance kind 非法');
}

/** DeepSeek 满额基准（¥）：余额 ≥ 该值视为 100%（未消耗），余额按比例折算为已用百分比 */
const DEEPSEEK_FULL_BALANCE_CNY = 20;

/**
 * 事件档位百分比（已用百分比语义：0 = 未消耗，100 = 耗尽）：
 * - opencode：取三窗口最大（风险最高者为准）
 * - deepseek：余额按 DEEPSEEK_FULL_BALANCE_CNY（¥20 = 100%）折算为已用百分比
 *   （余额 20 元 → 0%，10 元 → 50%，0 元 → 100%）
 */
export function balancePercent(v: BalanceView): number | undefined {
  if (v.kind === 'opencode') return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
  if (v.kind === 'deepseek') {
    const total = Number(v.total);
    if (!Number.isFinite(total)) return undefined; // 金额非法（非数字）：不触发（上层校验已兜底，此处双保险）
    // 负数 = 透支，与 0 等价按「已用完」折算：-0.02 → 剩余 0 → 已用 100%（播「分文不剩」档）
    const remaining = (Math.max(0, total) / DEEPSEEK_FULL_BALANCE_CNY) * 100; // 剩余百分比 0~100+
    return Math.max(0, Math.min(100, 100 - remaining)); // 折算为已用百分比
  }
  return undefined;
}

/**
 * 余额事件档位索引（与 assets/config.jsonc 注释一致）：
 * index = p === 100 ? 5 : Math.floor(p / 20)
 */
export function balanceEventIndex(p: number): number {
  if (p === 100) return 5;
  const i = Math.floor(p / 20);
  return i < 5 ? i : 4;
}

/** OpenCode 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月 */
export const OPENCODE_QUOTA_USD = {
  rolling: 12,
  weekly: 30,
  monthly: 60,
} as const;

/** 窗口展示名（联想框文案用）：5h = 5 小时额度窗口、周、月 */
export const WINDOW_LABELS = {
  rolling: '5h',
  weekly: '周',
  monthly: '月',
} as const;

export type OpenCodeWindow = keyof typeof OPENCODE_QUOTA_USD;

/** 一个窗口的额度概况（用于联想框一句话判定） */
export interface WindowUsage {
  label: string;
  percent: number;
  quotaUsd: number;
  /** 剩余额度（USD）= 满额度 × (100 − percent) / 100 */
  remainingUsd: number;
  resetsAt?: string;
}

/** 取三窗口剩余额度最少的那个（最先到达满额度/最先用完） */
export function urgentWindow(v: BalanceView): WindowUsage | undefined {
  if (v.kind !== 'opencode') return undefined;
  const windows: OpenCodeWindow[] = ['rolling', 'weekly', 'monthly'];
  const resets: Record<OpenCodeWindow, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  let best: WindowUsage | undefined;
  for (const w of windows) {
    const percent = v[w] ?? 0;
    const quota = OPENCODE_QUOTA_USD[w];
    const remaining = (quota * (100 - percent)) / 100;
    const cand: WindowUsage = {
      label: WINDOW_LABELS[w],
      percent,
      quotaUsd: quota,
      remainingUsd: remaining,
      resetsAt: resets[w],
    };
    if (best === undefined || remaining < best.remainingUsd) best = cand;
  }
  return best;
}

/**
 * 重置时间 → 相对文案（保留 1 位小数）：
 * - 距重置 ≥ 4 天 → 「N.x 天」
 * - 距重置 < 4 天 → 「N.x 小时」
 * - 已过重置点 → 「已重置」；未知时间 → 空串
 */
export function resetInText(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = t - Date.now();
  if (delta <= 0) return '已重置';
  const hoursF = delta / 3_600_000;
  if (hoursF >= 96) return (Math.round((hoursF / 24) * 10) / 10).toFixed(1) + ' 天';
  return Math.max(0.1, Math.round(hoursF * 10) / 10).toFixed(1) + ' 小时';
}

/**
 * DeepSeek 峰谷计价档位（北京时间）：
 * - 高峰：工作日 9:00–12:00、14:00–18:00；其余为空闲（低谷）
 * - 周六/周日全天按低谷价计费（自 2026-08-23 起，周末不再区分峰谷）
 */
export type PricingTier = 'peak' | 'idle';

/** 当前时刻的 DeepSeek 计价档位（按北京时间 Asia/Shanghai，UTC+8 无夏令时） */
export function deepseekPricingTier(now: Date = new Date()): PricingTier {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23', // h23 避免午夜被格式化为 "24:00"
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return 'idle'; // 周末全天低谷
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'idle';
}
