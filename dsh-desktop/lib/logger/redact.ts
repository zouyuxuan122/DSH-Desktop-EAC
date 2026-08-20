/**
 * lib/logger/redact.ts — PII 脱敏引擎（Task 6.2 自 logger.js 提取）。
 *
 * 三层防线（依次作用）：
 *   1. 键名黑名单（normalizeKey 归一 camelCase/snake_case/kebab-case/X- 前缀
 *      后比对）—— 命中即值替换为 '***'；
 *   2. 前缀规则（AKIA/sk-/ghp_/xoxb-/SEC… 最长前缀优先，头尾保留掩码中间）；
 *   3. 值正则（JWT / PEM 私钥 / 公网 IPv4 / 身份证 / 银行卡 / 手机号 / 邮箱 /
 *      用户主目录）。
 *
 * 占位符协议：前缀掩码用 \x01/\x02 包裹的占位符暂存，防止短前缀规则
 * （如 sk-）对已掩码 token 二次匹配；占位符字符不会出现在真实 token 里，
 * 值正则也不会命中它们。
 */

import * as os from 'node:os';
import * as util from 'node:util';
import { Transform } from 'node:stream';

// --- PII 常量 ---------------------------------------------------------------

/** 前缀规则形状：匹配 prefix 开头的 token，保留头 head / 尾 tail 个字符。 */
export interface PrefixRule {
  prefix: string;
  head: number;
  tail: number;
}

/** 值正则规则形状。 */
export interface ValuePattern {
  re: RegExp;
  repl: (match: string, ...groups: string[]) => string;
}

// 键名黑名单：大小写不敏感，匹配 camelCase / snake_case / kebab-case / X- 前缀
//（归一：toLowerCase + 去 x- 前缀 + 去 -/_ 后比对）。
const PII_KEYS_BLACKLIST_RAW = [
  'apiKey', 'apikey', 'apiSecret', 'apisecret', 'accessKey', 'access_key',
  'secret', 'secretKey', 'secret_key', 'token', 'accessToken', 'access_token',
  'refreshToken', 'refresh_token', 'authToken', 'auth_token', 'sessionToken',
  'session_token', 'bearerToken', 'bearer_token', 'clientId', 'client_id',
  'clientSecret', 'client_secret', 'password', 'passwd', 'pwd', 'passphrase',
  'authorization', 'authorisation', 'cookie', 'sessionId', 'session_id', 'userId',
  'user_id', 'account', 'accountId', 'account_id', 'phone', 'mobile', 'tel',
  'telephone', 'email', 'emailAddr', 'email_address', 'ip', 'ipAddress',
  'ipv4', 'ipv6', 'address', 'homeAddress', 'home_address', 'idCard', 'id_card',
  'creditCard', 'credit_card', 'cvv', 'cvc', 'dsn', 's3Secret', 's3_secret',
  'awsSecret', 'aws_secret', 'awsAccessKeyId', 'aws_access_key_id',
  'awsSecretAccessKey', 'aws_secret_access_key',
  'privateKey', 'private_key', 'signingSecret', 'signing_secret',
  'webhookSecret', 'webhook_secret', 'dingtalkSecret', 'dingtalk_secret',
  'feishuSecret', 'feishu_secret', 'larkSecret', 'lark_secret',
  'encryptKey', 'encrypt_key', 'proxyPassword', 'proxy_password', 'proxyAuth',
  'databaseUrl', 'database_url', 'dbPassword', 'db_password', 'encryptionKey',
  'encryption_key', 'licenseKey', 'jwt', 'openaiKey', 'anthropicKey',
  'deepseekKey', 'dshToken', 'sign',
];

/** 归一键名：小写 + 去前导 x- + 去 -/_。 */
export function normalizeKey(k: unknown): string {
  let s = String(k).toLowerCase();
  // Strip leading "x-"
  if (s.startsWith('x-')) s = s.slice(2);
  return s.replace(/[-_]/g, '');
}

export const PII_KEYS_BLACKLIST: ReadonlySet<string> = new Set(PII_KEYS_BLACKLIST_RAW.map(normalizeKey));

/** 键名是否命中黑名单。 */
export function isBlackKey(k: unknown): boolean {
  if (typeof k !== 'string') return false;
  return PII_KEYS_BLACKLIST.has(normalizeKey(k));
}

// 前缀规则：head = 保留前 N 字符，tail = 保留后 N 字符。
// 规则按前缀长度降序应用。已被更长规则掩码的 token 被替换为占位符，
// 短规则永远不会二次命中（如 sk- 不会再匹配已被 sk-ant- 掩码的 token）。
const PII_PREFIXES_RULES_UNSORTED: PrefixRule[] = [
  { prefix: 'AKIA', head: 4, tail: 4 }, // AWS Access Key ID: "AKIA" 是固定 4 字符前缀
  { prefix: 'ASIA', head: 4, tail: 4 }, // AWS STS
  { prefix: 'sk-ant-', head: 5, tail: 4 }, // Anthropic（测试期望 head=5: "sk-an"）
  { prefix: 'sk-or-', head: 5, tail: 4 }, // OpenRouter（head=5 → "sk-or"）
  { prefix: 'ds-', head: 5, tail: 4 }, // Deepseek
  { prefix: 'sk-', head: 4, tail: 4 }, // OpenAI（兜底）
  { prefix: 'pk-', head: 4, tail: 4 }, // Stripe public
  { prefix: 'rk-', head: 4, tail: 4 }, // Stripe restricted
  { prefix: 'ghp_', head: 6, tail: 4 }, // GitHub Personal
  { prefix: 'gho_', head: 6, tail: 4 }, // GitHub OAuth
  { prefix: 'ghu_', head: 6, tail: 4 }, // GitHub user-to-server
  { prefix: 'ghs_', head: 6, tail: 4 }, // GitHub server-to-server
  { prefix: 'ghr_', head: 6, tail: 4 }, // GitHub refresh
  { prefix: 'glpat-', head: 6, tail: 4 }, // GitLab
  { prefix: 'xoxb-', head: 5, tail: 4 }, // Slack bot
  { prefix: 'xoxp-', head: 5, tail: 4 }, // Slack user
  { prefix: 'xoxa-', head: 5, tail: 4 }, // Slack workspace-app
  { prefix: 'xoxs-', head: 5, tail: 4 }, // Slack side
  { prefix: 'xoxr-', head: 5, tail: 4 }, // Slack refresh
  { prefix: 'xoxn-', head: 5, tail: 4 }, // Slack token
  { prefix: 'SEC', head: 6, tail: 4 }, // 钉钉 webhook 签名
  { prefix: 'MDAwMDAw', head: 6, tail: 4 }, // 通用 base64 头
  { prefix: 'Bearer ', head: 7, tail: 4 }, // HTTP Bearer
  { prefix: 'Basic ', head: 6, tail: 4 }, // HTTP Basic
];

export const PII_PREFIXES_RULES: readonly PrefixRule[] = [...PII_PREFIXES_RULES_UNSORTED].sort(
  (a, b) => b.prefix.length - a.prefix.length,
);

/** 值正则规则（带替换函数）。 */
export const PII_VALUE_PATTERNS: readonly ValuePattern[] = buildValuePatterns();

function buildValuePatterns(): ValuePattern[] {
  const pats: ValuePattern[] = [];
  // JWT: header.payload.sig（三段，各 ≥10 个 base64url 字符）
  pats.push({
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    repl: () => 'eyJ***',
  });
  // PEM 私钥块（RSA/EC/DSA/PKCS8/OPENSSH…）：贪婪但上限 6000 字符
  pats.push({
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,6000}?-----END [A-Z ]*PRIVATE KEY-----/g,
    repl: () => '-----BEGIN *** PRIVATE KEY-----',
  });
  // 公网 IPv4（排除 127.0.0.1/0.0.0.0/10.* / 172.16-31.* / 192.168.* / 169.254.*）
  // 每个八位组用非捕获组包裹，整体模式为 (OCT)(.OCT){3}。
  const IPV4_OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  const IPV4_RE_SOURCE = IPV4_OCT + '(?:\\.' + IPV4_OCT + '){3}';
  pats.push({
    re: new RegExp('\\b(' + IPV4_RE_SOURCE + ')\\b', 'g'),
    repl: (m: string) => {
      const parts = m.split('.').map(Number);
      const a = parts[0] ?? 0;
      const b = parts[1] ?? 0;
      if (a === 127 && m === '127.0.0.1') return m;
      if (m === '0.0.0.0') return m;
      if (a === 10) return m;
      if (a === 172 && b >= 16 && b <= 31) return m;
      if (a === 192 && b === 168) return m;
      if (a === 169 && b === 254) return m;
      return '***.***.***.***';
    },
  });
  // 18 位身份证号
  pats.push({
    re: /(?<!\d)([1-9]\d{5})(\d{8})(\d{3}[0-9Xx])(?!\d)/g,
    repl: (_m: string, a: string, _b: string, c: string) => a + '**********' + c, // 保留前 6 后 4，中间 8 位掩码
  });
  // 银行卡（13-19 位纯数字，按长度过滤）
  pats.push({
    re: /(?<!\d)(\d{6})(\d{1,9})(\d{4})(?!\d)/g,
    repl: (match: string, a: string, mid: string, c: string) => {
      const totalLen = match.length;
      if (totalLen < 13 || totalLen > 19) return match;
      return a + '*'.repeat(mid.length) + c;
    },
  });
  // 大陆手机号：1[3-9]\d{9}。保留前 3（运营商+地域位）+ 后 4。
  pats.push({
    re: /(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)/g,
    repl: (_m: string, a: string, _mid: string, c: string) => a + '****' + c,
  });
  // 邮箱：保留本地部分首字符 + 完整域名
  pats.push({
    re: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9_%+-])([A-Za-z0-9._%+-]*)(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    repl: (_m: string, first: string, rest: string, domain: string) => {
      if (first && rest === '') {
        // 单字符本地部分（罕见）→ 掩码为 * 但仍可读
        return first + '***' + domain;
      }
      return first + '****' + domain;
    },
  });
  // 用户主目录（动态：C:\Users\<name> / /Users/<name> / /home/<name>）
  const home = os.homedir();
  // Windows home: C:\Users\lbn → 替换字面量为 %USERPROFILE%
  if (home) {
    const homeEscaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pats.push({
      re: new RegExp(homeEscaped, 'g'),
      repl: () => (process.platform === 'win32' ? '%USERPROFILE%' : '~'),
    });
  }
  return pats;
}

// --- 前缀掩码 ---------------------------------------------------------------

/** 前缀规则 → 正则（转义前缀 + 捕获 ≤512 个 token 字符）。 */
function buildPrefixRegexes(): Array<{ re: RegExp; head: number; tail: number; prefix: string }> {
  const regexes: Array<{ re: RegExp; head: number; tail: number; prefix: string }> = [];
  for (const r of PII_PREFIXES_RULES) {
    const escaped = r.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped + '[A-Za-z0-9_.\\-]{0,512}', 'g');
    regexes.push({ re, head: r.head, tail: r.tail, prefix: r.prefix });
  }
  return regexes;
}

const prefixRegexes = buildPrefixRegexes();

// 占位符字符：刻意选 API token/标识符里不会出现的字符，使其他规则
//（JWT/邮箱/手机号）的正则永远不会匹配到占位符。
const PREFIX_MASK_SEP = '\x01';
const PREFIX_MASK_TOKEN = '\x02';

/** 前缀规则掩码（最长前缀优先 + 占位符防二次匹配）。 */
export function _maskPrefixesInString(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  if (s.length === 0) return s;

  // 阶段 1：按最长→最短规则消费 token。用占位符暂存，短规则不会二次掩码。
  const replacements: string[] = []; // 掩码串，按占位符 id 索引
  let placeholderId = 0;

  let cur = s;
  for (const r of prefixRegexes) {
    cur = cur.replace(r.re, (match: string) => {
      // 不消费已放置占位符内部的内容。
      if (match.includes(PREFIX_MASK_TOKEN)) return match;
      const head = match.slice(0, r.head);
      const tail = match.slice(-r.tail);
      const masked = head + '***' + tail;
      const id = placeholderId++;
      replacements.push(masked);
      return PREFIX_MASK_TOKEN + id + PREFIX_MASK_SEP;
    });
  }

  // 阶段 2：把占位符展开回掩码串（split-join 对任意内容安全）。
  if (replacements.length === 0) return cur;

  let out = cur;
  for (let i = 0; i < replacements.length; i++) {
    const masked = replacements[i] as string;
    const needle = PREFIX_MASK_TOKEN + i + PREFIX_MASK_SEP;
    if (out.includes(needle)) {
      out = out.split(needle).join(masked);
    }
  }
  return out;
}

/** 值级掩码：前缀规则 + 全部值正则（对字符串整体生效）。 */
export function _valueMasked(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  let out = _maskPrefixesInString(s) as string;
  for (const p of PII_VALUE_PATTERNS) {
    if (p.re.global || out.match(p.re)) {
      out = out.replace(p.re, p.repl as (substring: string, ...args: unknown[]) => string);
    }
  }
  return out;
}

// --- 深度脱敏 ---------------------------------------------------------------

/** deepRedact 的可选上下文。 */
export interface RedactOpts {
  onError?: (e: Error) => void;
}

/** 深度脱敏入口：克隆对象树并对全部字符串/键名做掩码（循环引用安全）。 */
export function deepRedact(o: unknown, opts?: RedactOpts): unknown {
  return _deepRedactInternal(o, new WeakMap<object, unknown>(), opts || {});
}

export function _deepRedactInternal(
  o: unknown,
  seen: WeakMap<object, unknown>,
  ctx: RedactOpts = {},
): unknown {
  const onError =
    ctx.onError ||
    function (e: Error): void {
      try {
        console.error('pii-redact warn:', e.message);
      } catch {
        /* console 不可用则静默 */
      }
    };
  try {
    if (o == null) return o;
    // 基元：string 走值掩码；number/boolean/bigint/symbol/function/undefined 原样
    const t = typeof o;
    if (t === 'string') return _valueMasked(o);
    if (t !== 'object') return o;
    const obj = o as object;
    // 防循环：WeakMap（原对象 → 克隆）使环指向新克隆而非原对象。
    const existing = seen.get(obj);
    if (existing !== undefined) return existing;

    // Buffer / Uint8Array：取前 2048 字节 → utf8 → 值掩码。
    // 不改动底层字节；返回字符串摘要。
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(o)) {
      const s = (o as Buffer).slice(0, 2048).toString('utf8');
      const masked = _valueMasked(s);
      seen.set(obj, masked);
      return masked;
    }
    if (ArrayBuffer.isView(o) || o instanceof Uint8Array) {
      const view = o as unknown as Uint8Array;
      const arr = new Uint8Array(view.buffer, view.byteOffset, Math.min(view.byteLength, 2048));
      let s = '';
      for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i] as number);
      const masked = _valueMasked(s);
      seen.set(obj, masked);
      return masked;
    }

    // Map / Set：不深遍历键值（风险高且昂贵）——util.inspect 序列化后值掩码。
    if (obj instanceof Map || obj instanceof Set) {
      const rep = util.inspect(obj, { depth: 4, maxStringLength: 4096 });
      const masked = _valueMasked(rep);
      seen.set(obj, masked);
      return masked;
    }

    // 数组
    if (Array.isArray(o)) {
      const out = new Array(o.length);
      seen.set(obj, out); // 提前登记：环 → out 而非原对象
      for (let i = 0; i < o.length; i++) {
        try {
          out[i] = _deepRedactInternal(o[i], seen, ctx);
        } catch (e) {
          onError(e as Error);
          out[i] = o[i];
        }
      }
      return out;
    }

    // RegExp / Date → 原样（脱敏器不触碰原型链）
    if (obj instanceof RegExp || obj instanceof Date) {
      seen.set(obj, obj);
      return o;
    }

    // 普通对象（或类实例）——遍历自有可枚举键。
    const keys = Object.keys(obj);
    const out: Record<string, unknown> = {};
    seen.set(obj, out); // 提前登记（遍历属性前），环指向新克隆
    for (const k of keys) {
      let v: unknown;
      try {
        v = (obj as Record<string, unknown>)[k]; // getter 可能抛错
      } catch (e) {
        onError(e as Error);
        out[k] = (obj as Record<string, unknown>)[k] !== undefined ? (obj as Record<string, unknown>)[k] : undefined; // 保留原形状
        continue;
      }
      if (isBlackKey(k)) {
        out[k] = '***';
        continue;
      }
      try {
        out[k] = _deepRedactInternal(v, seen, ctx);
      } catch (e) {
        onError(e as Error);
        out[k] = v;
      }
    }
    return out;
  } catch (e) {
    onError(e as Error);
    return o; // 绝不丢弃整个对象
  }
}

// --- RedactTransform（NDJSON 流水线）-----------------------------------------
// 输入：pino 产出的 NDJSON 行。输出：同行、值已掩码。
// 任何错误（解析/JSON 异常）→ 原样透传该行 + 记 warn。

/** RedactTransform 选项。 */
export interface RedactTransformOpts extends TransformOptions {
  warnHandler?: (msg: unknown) => void;
  redactLevel?: 'deep' | 'shallow';
}

// TransformOptions 由 node:stream 提供（Transform 构造参数的子集）。
interface TransformOptions {
  writableObjectMode?: boolean;
  readableObjectMode?: boolean;
  [k: string]: unknown;
}

export class RedactTransform extends Transform {
  private _buf = '';
  private readonly _warnHandler: (msg: unknown) => void;
  private _redactLevel: 'deep' | 'shallow';

  constructor(opts: RedactTransformOpts = {}) {
    const { warnHandler, redactLevel, ...rest } = opts;
    super({ writableObjectMode: false, readableObjectMode: false, ...(rest as object) });
    this._warnHandler =
      warnHandler ||
      function (msg: unknown): void {
        try {
          process.stderr.write('[pii-redact] ' + String((msg as { message?: string })?.message || msg) + '\n');
        } catch {
          /* stderr 不可用则静默 */
        }
      };
    this._redactLevel = redactLevel || 'deep';
  }

  setRedactLevel(l: 'deep' | 'shallow'): void {
    this._redactLevel = l;
  }

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (!chunk) {
      cb();
      return;
    }
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this._buf += s;
    let idx: number;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let outLine = line;
      try {
        if (this._redactLevel === 'shallow') {
          // 预热模式：不 JSON.parse/深遍历，只对原始行做值级掩码。
          outLine = _valueMasked(line) as string;
        } else {
          const obj = JSON.parse(line) as unknown;
          const redacted = deepRedact(obj, { onError: (e) => this._warnHandler(e) });
          outLine = JSON.stringify(redacted);
        }
      } catch (e) {
        this._warnHandler(e);
        // 兜底：原样透传
      }
      this.push(outLine + '\n');
    }
    cb();
  }

  override _flush(cb: (err?: Error | null) => void): void {
    if (this._buf) {
      try {
        this.push(this._redactLevel === 'shallow' ? (_valueMasked(this._buf) as string) : this._buf);
      } catch (e) {
        this._warnHandler(e);
        this.push(this._buf);
      }
      this._buf = '';
    }
    cb();
  }
}
