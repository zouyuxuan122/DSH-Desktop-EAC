/**
 * 余额查询（host 半侧）：把「当前服务商」映射到对应的余额/用量接口并抓取。
 *
 * 设计：
 * - 数据源按「服务商 provider id」寻址（来源 = agentDefaultModel.currentSelection().provider）；
 * - 只登记有公开查询接口的服务商；未登记（如 opencode/Zen 暂无官方余额 API）→ 显式
 *   `unsupported`，由上层决定不显示，绝不静默伪造 0 余额；
 * - key 由调用方经 DSH 官方 credentialRef 解析后注入（不直接读 .credentials.yaml）；
 * - 网络超时 + 重试（实测该环境对境外端点间歇性超时）。
 */

/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 20_000;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;

/** 一个 service provider 的余额查询定义 */
export interface BalanceProvider {
  /** 可命中的 provider id（agentDefaultModel 报告的 id） */
  ids: string[];
  /** 凭证引用名（credentialRef），如 OPENCODE_GO_API_KEY */
  ref: string;
  /** 展示类型：余额 vs 用量 */
  kind: 'opencode' | 'deepseek';
}

/** 已知可查询余额的服务商（只登记有公开 API 的；opencode/Zen 暂无官方余额 API，不在此表） */
export const BALANCE_PROVIDERS: BalanceProvider[] = [
  { ids: ['opencode-go'], ref: 'OPENCODE_GO_API_KEY', kind: 'opencode' },
  { ids: ['deepseek-official'], ref: 'DEEPSEEK_API_KEY', kind: 'deepseek' },
];

/** provider id → 唯一匹配定义；未匹配返回 undefined（= 不支持查询） */
export function matchBalanceProvider(provider: string): BalanceProvider | undefined {
  return BALANCE_PROVIDERS.find((p) => p.ids.includes(provider));
}

/** 重构后的响应（client 端与 host 端同构使用） */
export type BalanceResult =
  | {
      ok: true;
      provider: string;
      kind: 'opencode';
      data: {
        rolling: number;
        weekly: number;
        monthly: number;
        rollingResetsAt: string;
        weeklyResetsAt: string;
        monthlyResetsAt: string;
      };
    }
  | {
      ok: true;
      provider: string;
      kind: 'deepseek';
      data: { currency: string; total: string; granted: string; toppedUp: string };
    }
  | { ok: false; provider: string; reason: 'unsupported' | 'credential-missing' | 'fetch-error'; message?: string };

/** fetch 一次，带超时；失败抛错（调用方决定是否重试） */
async function fetchOnce(url: string, key: string): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: 'Bearer ' + key, 'User-Agent': 'dsh-pet-balance' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/** fetch + 重试；全败抛最后错误 */
async function fetchWithRetry(url: string, key: string): Promise<Response> {
  let last: unknown;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      return await fetchOnce(url, key);
    } catch (e) {
      last = e;
      if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** 数字兜底校验：数值化失败或非有限数 → throw（数据异常显式报错，不静默当 0） */
function num(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('dsh-pet: 余额数据非法字段 ' + what);
  return n;
}

/** 字符串兜底校验：非空字符串，否则 throw */
function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('dsh-pet: 余额数据非法字段 ' + what);
  return value;
}

/** 抓取 OpenCode Go 用量（/zen/go/v1/usage） */
async function fetchOpencode(key: string, provider: string): Promise<BalanceResult> {
  const res = await fetchWithRetry('https://opencode.ai/zen/go/v1/usage', key);
  if (!res.ok) throw new Error('opencode usage HTTP ' + res.status);
  const body: unknown = await res.json();
  const usage = (body as { usage?: unknown })?.usage;
  if (!usage || typeof usage !== 'object') throw new Error('dsh-pet: opencode usage 响应缺少 usage');
  const u = usage as Record<string, { percent?: unknown; resetsAt?: unknown }>;
  const rolling = u.rolling,
    weekly = u.weekly,
    monthly = u.monthly;
  if (!rolling || !weekly || !monthly) throw new Error('dsh-pet: opencode usage 响应缺少窗口');
  return {
    ok: true,
    provider,
    kind: 'opencode',
    data: {
      rolling: num(rolling.percent, 'rolling.percent'),
      weekly: num(weekly.percent, 'weekly.percent'),
      monthly: num(monthly.percent, 'monthly.percent'),
      rollingResetsAt: str(rolling.resetsAt, 'rolling.resetsAt'),
      weeklyResetsAt: str(weekly.resetsAt, 'weekly.resetsAt'),
      monthlyResetsAt: str(monthly.resetsAt, 'monthly.resetsAt'),
    },
  };
}

/** 抓取 DeepSeek 余额（/user/balance） */
async function fetchDeepseek(key: string, provider: string): Promise<BalanceResult> {
  const res = await fetchWithRetry('https://api.deepseek.com/user/balance', key);
  if (!res.ok) throw new Error('deepseek balance HTTP ' + res.status);
  const body: unknown = await res.json();
  const infos = (body as { balance_infos?: unknown })?.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) throw new Error('dsh-pet: deepseek balance 响应缺少 balance_infos');
  const first = infos[0] as Record<string, unknown>;
  return {
    ok: true,
    provider,
    kind: 'deepseek',
    data: {
      currency: str(first.currency, 'currency'),
      total: str(first.total_balance, 'total_balance'),
      granted: str(first.granted_balance, 'granted_balance'),
      toppedUp: str(first.topped_up_balance, 'topped_up_balance'),
    },
  };
}

/**
 * 按当前服务商查询余额。
 * @param provider agentDefaultModel.currentSelection().provider
 * @param resolveKey 凭证解析：ref 名 → key（由调用方注入 ctx.credentials.resolve）
 * @returns 结构化结果：成功 / 不支持 / 缺凭证 / 抓取失败（失败带 message，绝不返回伪造数字）
 */
export async function queryBalance(
  provider: string,
  resolveKey: (ref: string) => Promise<string | undefined>,
): Promise<BalanceResult> {
  const match = matchBalanceProvider(provider);
  if (!match) return { ok: false, provider, reason: 'unsupported' };

  const rc = await resolveKey(match.ref);
  if (!rc) return { ok: false, provider, reason: 'credential-missing', message: '缺少凭证 ' + match.ref };

  try {
    return match.kind === 'opencode' ? await fetchOpencode(rc, provider) : await fetchDeepseek(rc, provider);
  } catch (e) {
    return { ok: false, provider, reason: 'fetch-error', message: e instanceof Error ? e.message : String(e) };
  }
}
