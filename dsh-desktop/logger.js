// Logger core
//  - Phase 1 (GREEN): PII redact / RedactTransform / deepRedact
//  - Phase 2 (GREEN): pino instance, size-based rotate, trace helpers, compat wrappers
//  - Phase 3 (next): IPC for diagnostics:export + buildDiagnosticsZip via archiver
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const util = require('node:util');
const { Transform, Writable, finished } = require('node:stream');
let pino = null;
try { pino = require('pino'); } catch (e) { /* deps not installed yet in RED */ }
let nanoidFn = null;
try { nanoidFn = require('nanoid').nanoid || (() => (Math.random().toString(36).slice(2, 12))); }
catch (e) { nanoidFn = () => Math.random().toString(36).slice(2, 14) + Date.now().toString(36); }

// --- PII constants -----------------------------------------------------------
// Keys blacklist: case-insensitive, matches any of [camelCase, snake_case, kebab-case, X- prefix]
// We normalize: toLowerCase, replace _ and - then compare.
const PII_KEYS_BLACKLIST_RAW = [
  'apiKey','apikey','apiSecret','apisecret','accessKey','access_key',
  'secret','secretKey','secret_key','token','accessToken','access_token',
  'refreshToken','refresh_token','authToken','auth_token','sessionToken',
  'session_token','bearerToken','bearer_token','clientId','client_id',
  'clientSecret','client_secret','password','passwd','pwd','passphrase',
  'authorization','authorisation','cookie','sessionId','session_id','userId',
  'user_id','account','accountId','account_id','phone','mobile','tel',
  'telephone','email','emailAddr','email_address','ip','ipAddress',
  'ipv4','ipv6','address','homeAddress','home_address','idCard','id_card',
  'creditCard','credit_card','cvv','cvc','dsn','s3Secret','s3_secret',
  'awsSecret','aws_secret','awsAccessKeyId','aws_access_key_id',
  'awsSecretAccessKey','aws_secret_access_key',
  'privateKey','private_key','signingSecret','signing_secret',
  'webhookSecret','webhook_secret','dingtalkSecret','dingtalk_secret',
  'feishuSecret','feishu_secret','larkSecret','lark_secret',
  'encryptKey','encrypt_key','proxyPassword','proxy_password','proxyAuth',
  'databaseUrl','database_url','dbPassword','db_password','encryptionKey',
  'encryption_key','licenseKey','jwt','openaiKey','anthropicKey',
  'deepseekKey','dshToken','sign',
];
const PII_KEYS_BLACKLIST = new Set(PII_KEYS_BLACKLIST_RAW.map(normalizeKey));
function normalizeKey(k) {
  let s = String(k).toLowerCase();
  // Strip leading "x-"
  if (s.startsWith('x-')) s = s.slice(2);
  return s.replace(/[-_]/g, '');
}
function isBlackKey(k) {
  if (typeof k !== 'string') return false;
  return PII_KEYS_BLACKLIST.has(normalizeKey(k));
}

// Prefix rules: head = keep N leading chars, tail = keep N trailing chars.
// Rules are applied longest-first. Tokens matched by earlier (longer) rules are
// replaced with a placeholder so shorter rules can never clobber them (e.g. "sk-"
// won't re-match a token already masked by "sk-ant-").
const PII_PREFIXES_RULES_UNSORTED = [
  { prefix: 'AKIA', head: 4, tail: 4 }, // AWS Access Key ID: "AKIA" is the fixed 4-char prefix
  { prefix: 'ASIA', head: 4, tail: 4 }, // AWS STS
  { prefix: 'sk-ant-', head: 5, tail: 4 }, // Anthropic (tests expected head=5: "sk-an")
  { prefix: 'sk-or-',  head: 5, tail: 4 }, // OpenRouter (head=5 → "sk-or")
  { prefix: 'ds-',     head: 5, tail: 4 }, // Deepseek
  { prefix: 'sk-',     head: 4, tail: 4 }, // OpenAI (fallback)
  { prefix: 'pk-',     head: 4, tail: 4 }, // Stripe public
  { prefix: 'rk-',     head: 4, tail: 4 }, // Stripe restricted
  { prefix: 'ghp_',    head: 6, tail: 4 }, // GitHub Personal
  { prefix: 'gho_',    head: 6, tail: 4 }, // GitHub OAuth
  { prefix: 'ghu_',    head: 6, tail: 4 }, // GitHub user-to-server
  { prefix: 'ghs_',    head: 6, tail: 4 }, // GitHub server-to-server
  { prefix: 'ghr_',    head: 6, tail: 4 }, // GitHub refresh
  { prefix: 'glpat-',  head: 6, tail: 4 }, // GitLab
  { prefix: 'xoxb-',   head: 5, tail: 4 }, // Slack bot
  { prefix: 'xoxp-',   head: 5, tail: 4 }, // Slack user
  { prefix: 'xoxa-',   head: 5, tail: 4 }, // Slack workspace-app
  { prefix: 'xoxs-',   head: 5, tail: 4 }, // Slack side
  { prefix: 'xoxr-',   head: 5, tail: 4 }, // Slack refresh
  { prefix: 'xoxn-',   head: 5, tail: 4 }, // Slack token
  { prefix: 'SEC',     head: 6, tail: 4 }, // DingTalk webhook sign
  { prefix: 'MDAwMDAw', head: 6, tail: 4 }, // generic base64 header
  { prefix: 'Bearer ', head: 7, tail: 4 }, // HTTP Bearer
  { prefix: 'Basic ',  head: 6, tail: 4 },  // HTTP Basic
];
const PII_PREFIXES_RULES = [...PII_PREFIXES_RULES_UNSORTED]
  .sort((a, b) => b.prefix.length - a.prefix.length);

// Value regex patterns (masked with a replacer function).
const PII_VALUE_PATTERNS = buildValuePatterns();

function buildValuePatterns() {
  const pats = [];
  // JWT: header.payload.sig (3 segments, each >=10 base64url)
  pats.push({
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    repl: () => 'eyJ***',
  });
  // PEM private key block (RSA/EC/DSA/PKCS8/OPENSSH...): greedy with max 6000 chars
  pats.push({
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,6000}?-----END [A-Z ]*PRIVATE KEY-----/g,
    repl: () => '-----BEGIN *** PRIVATE KEY-----',
  });
  // Public IPv4 (exclude 127.0.0.1/0.0.0.0/10.* / 172.16-31.* / 192.168.* / 169.254.*)
  // Wrap each option in a non-capturing group so the full pattern is (OCT)(.OCT){3}.
  const IPV4_OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  const IPV4_RE_SOURCE = IPV4_OCT + '(?:\\.' + IPV4_OCT + '){3}';
  pats.push({
    re: new RegExp('\\b(' + IPV4_RE_SOURCE + ')\\b', 'g'),
    repl: (m) => {
      const parts = m.split('.').map(Number);
      const [a, b] = parts;
      if (a === 127 && m === '127.0.0.1') return m;
      if (m === '0.0.0.0') return m;
      if (a === 10) return m;
      if (a === 172 && b >= 16 && b <= 31) return m;
      if (a === 192 && b === 168) return m;
      if (a === 169 && b === 254) return m;
      return '***.***.***.***';
    },
  });
  // 18-digit Chinese ID card
  pats.push({
    re: /(?<!\d)([1-9]\d{5})(\d{8})(\d{3}[0-9Xx])(?!\d)/g,
    repl: (_, a, __b, c) => a + '**********' + c, // keep first 6 + last 4, middle 8 masked (total 18 -> 6+10*+4 = 20 chars, but that's OK)
  });
  // Chinese bank card (13-19 digits, simple length+digits match)
  pats.push({
    re: /(?<!\d)(\d{6})(\d{1,9})(\d{4})(?!\d)/g,
    repl: (match, a, mid, c) => {
      const totalLen = match.length;
      if (totalLen < 13 || totalLen > 19) return match;
      return a + '*'.repeat(mid.length) + c;
    },
  });
  // Mainland mobile: 1[3-9]\d{9}. Keep first 3 (operator + 地区位) + last 4.
  pats.push({
    re: /(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)/g,
    repl: (_, a, _m, c) => a + '****' + c,
  });
  // Email: keep first char of local part + full domain
  pats.push({
    re: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9_%+-])([A-Za-z0-9._%+-]*)(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    repl: (_, first, rest, domain) => {
      if (first && rest === '') {
        // single-char local (rare) -> mask to * still readable
        return first + '***' + domain;
      }
      return first + '****' + domain;
    },
  });
  // Home directories (dynamic: C:\Users\<name> / /Users/<name> / /home/<name>)
  const home = os.homedir();
  // Windows home: C:\Users\lbn -> replace literal with %USERPROFILE%
  if (home) {
    const homeEscaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pats.push({
      re: new RegExp(homeEscaped, 'g'),
      repl: () => process.platform === 'win32' ? '%USERPROFILE%' : '~',
    });
  }
  return pats;
}

// --- Helpers ----------------------------------------------------------------
// Convert prefix rule to regex.
const { prefixRegexes } = buildPrefixRegexes();
function buildPrefixRegexes() {
  const regexes = [];
  for (const r of PII_PREFIXES_RULES) {
    const escaped = r.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped + '[A-Za-z0-9_.\\-]{0,512}', 'g');
    regexes.push({ re, head: r.head, tail: r.tail, prefix: r.prefix });
  }
  return { prefixRegexes: regexes };
}

// Marker characters used for placeholder protocol. We deliberately pick chars
// that are not valid inside API tokens / identifiers so regex patterns for other
// rules (JWT / email / phone) will never match a placeholder.
const PREFIX_MASK_SEP = '\x01';
const PREFIX_MASK_TOKEN = '\x02';

function _maskPrefixesInString(s) {
  if (typeof s !== 'string') return s;
  if (s.length === 0) return s;

  // Phase 1: consume tokens using longest→shortest rules.
  // Use placeholder tokens so subsequent (shorter) rules cannot double-mask.
  const replacements = []; // [maskedString] indexed by placeholder id.
  let placeholderId = 0;

  let cur = s;
  for (const r of prefixRegexes) {
    cur = cur.replace(r.re, (match) => {
      // Don't consume inside already-placed placeholders.
      if (match.includes(PREFIX_MASK_TOKEN)) return match;
      const head = match.slice(0, r.head);
      const tail = match.slice(-r.tail);
      const masked = head + '***' + tail;
      const id = placeholderId++;
      replacements.push(masked);
      return PREFIX_MASK_TOKEN + id + PREFIX_MASK_SEP;
    });
  }

  // Phase 2: expand placeholders back into masked strings.
  // Use a plain regex replace; if length gets huge, we fall back to split-join.
  if (replacements.length === 0) return cur;

  // Use a split-join approach to be safe with arbitrary content.
  let out = cur;
  for (let i = 0; i < replacements.length; i++) {
    const needle = PREFIX_MASK_TOKEN + i + PREFIX_MASK_SEP;
    if (out.includes(needle)) {
      out = out.split(needle).join(replacements[i]);
    }
  }
  return out;
}

function _valueMasked(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  out = _maskPrefixesInString(out);
  for (const p of PII_VALUE_PATTERNS) {
    if (p.re.global || out.match(p.re)) {
      out = out.replace(p.re, p.repl);
    }
  }
  return out;
}

// --- Deep redactor ----------------------------------------------------------
function deepRedact(o, opts) {
  return _deepRedactInternal(o, new WeakMap(), opts || {});
}

function _deepRedactInternal(o, seen, ctx = {}) {
  const onError = ctx.onError || function(e) { try { console.error('pii-redact warn:', e.message); } catch {} };
  try {
    if (o == null) return o;
    // Primitives: string, number, boolean, bigint, symbol, function, undefined
    const t = typeof o;
    if (t === 'string') return _valueMasked(o);
    if (t !== 'object') return o;
    // Protect against cycles — use WeakMap (original → clone) so that cycles point to the NEW clone, not the original.
    const existing = seen.get(o);
    if (existing !== undefined) return existing;

    // Buffer / Uint8Array: slice first 2048 bytes -> utf8 -> run value regex.
    // We don't mutate the underlying bytes; return a string summary.
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(o)) {
      const s = o.slice(0, 2048).toString('utf8');
      const masked = _valueMasked(s);
      seen.set(o, masked);
      return masked;
    }
    if (ArrayBuffer.isView(o) || o instanceof Uint8Array) {
      const arr = new Uint8Array(o.buffer, o.byteOffset, Math.min(o.byteLength, 2048));
      let s = '';
      for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
      const masked = _valueMasked(s);
      seen.set(o, masked);
      return masked;
    }

    // Map / Set: we don't deep-traverse keys/values (risky & expensive).
    // Instead stringify via util.inspect then run value masker.
    if (o instanceof Map || o instanceof Set) {
      const rep = util.inspect(o, { depth: 4, maxStringLength: 4096 });
      const masked = _valueMasked(rep);
      seen.set(o, masked);
      return masked;
    }

    // Array
    if (Array.isArray(o)) {
      const out = new Array(o.length);
      seen.set(o, out); // register early so cycle → out, not original
      for (let i = 0; i < o.length; i++) {
        try { out[i] = _deepRedactInternal(o[i], seen, ctx); }
        catch (e) { onError(e); out[i] = o[i]; }
      }
      return out;
    }

    // RegExp / Date -> leave as-is (valueMasker will not process Date but redactor shouldn't touch prototypes)
    if (o instanceof RegExp || o instanceof Date) {
      seen.set(o, o);
      return o;
    }

    // Plain object (or class instances) — walk own enumerable keys.
    const keys = Object.keys(o);
    const out = {};
    seen.set(o, out); // register EARLY (before walking props), so any cycle points to NEW clone.
    for (const k of keys) {
      let v;
      try { v = o[k]; } // access getter may throw
      catch (e) {
        onError(e);
        out[k] = o[k] !== undefined ? o[k] : undefined; // keep original (even if we can't read, don't erase shape)
        continue;
      }
      if (isBlackKey(k)) {
        out[k] = '***';
        continue;
      }
      try { out[k] = _deepRedactInternal(v, seen, ctx); }
      catch (e) { onError(e); out[k] = v; }
    }
    return out;
  } catch (e) {
    onError(e);
    return o; // never drop the whole object
  }
}

// --- RedactTransform (NDJSON stream pipeline) ------------------------------
// Input: NDJSON lines produced by pino. Output: same lines, each value-masked.
// Any error (parse/json exception) => pass the line through verbatim + log warn.
class RedactTransform extends Transform {
  constructor(opts = {}) {
    super({ writableObjectMode: false, readableObjectMode: false, ...opts });
    this._buf = '';
    this._warnHandler = opts.warnHandler || function (msg) { try { process.stderr.write('[pii-redact] ' + String(msg && msg.message || msg) + '\n'); } catch {} };
    this._redactLevel = opts.redactLevel || 'deep'; // 'deep' | 'shallow'
  }
  setRedactLevel(l) { this._redactLevel = l; }

  _transform(chunk, enc, cb) {
    if (!chunk) return cb();
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this._buf += s;
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let outLine = line;
      try {
        if (this._redactLevel === 'shallow') {
          // Warm-up mode: don't JSON.parse/deep-walk. Only run value-level masker on raw line.
          outLine = _valueMasked(line);
        } else {
          const obj = JSON.parse(line);
          const redacted = deepRedact(obj, { onError: (e) => this._warnHandler(e) });
          outLine = JSON.stringify(redacted);
        }
      } catch (e) {
        this._warnHandler(e);
        // fall-through: pass through verbatim
      }
      this.push(outLine + '\n');
    }
    cb();
  }

  _flush(cb) {
    if (this._buf) {
      try { this.push(this._redactLevel === 'shallow' ? _valueMasked(this._buf) : this._buf); }
      catch (e) { this._warnHandler(e); this.push(this._buf); }
      this._buf = '';
    }
    cb();
  }
}

// --- Phase 2: RotateWriteStream --------------------------------------------
// File roll policy:
//   - active file = <logsDir>/main.00
//   - When size > maxBytes, rename chain: main.08 -> delete main.09 ; main.07 -> main.08 ; ... main.00 -> main.01
//   - maxFiles default 10 (indices 00..09)
// Notes:
//   - We avoid shell/file-name races by writing only to main.00. Rolls happen synchronously just before write.
//   - We buffer nothing; pass-through directly to fs.createWriteStream.
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20MB
const DEFAULT_MAX_FILES = 10;
function _idxName(i) { return 'main.' + String(i).padStart(2, '0'); }

class RotateWriteStream extends Writable {
  constructor(logsDir, opts = {}) {
    super({ ...opts, decodeStrings: false });
    this.logsDir = logsDir;
    this.maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
    this._fd = null;
    this._path = path.join(this.logsDir, _idxName(0));
    this._size = 0;
    this._closed = false;
    if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });
    this._openNew();
  }

  _openNew() {
    if (this._fd !== null) { try { fs.closeSync(this._fd); } catch {} this._fd = null; }
    // Truncate / create main.00
    this._fd = fs.openSync(this._path, 'w', 0o644);
    try { this._size = fs.fstatSync(this._fd).size; } catch { this._size = 0; }
    this._closed = false;
  }

  _rollIfNeeded(extraBytes) {
    if (this._size + extraBytes <= this.maxBytes) return;
    // Do roll
    // 1. Delete the oldest file if exists (index maxFiles-1)
    const lastIdx = this.maxFiles - 1;
    const lastPath = path.join(this.logsDir, _idxName(lastIdx));
    try { fs.unlinkSync(lastPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // 2. Rename higher-numbered → +1 (from lastIdx-1 down to 0)
    for (let i = lastIdx - 1; i >= 0; i--) {
      const src = path.join(this.logsDir, _idxName(i));
      const dst = path.join(this.logsDir, _idxName(i + 1));
      try { fs.renameSync(src, dst); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    // 3. Open new main.00
    this._openNew();
  }

  _write(chunk, enc, cb) {
    if (this._closed) {
      // Re-open if flushed then reused.
      this._openNew();
    }
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, enc || 'utf8') : chunk;
    try {
      this._rollIfNeeded(buf.length);
      fs.writeSync(this._fd, buf, 0, buf.length, null);
      this._size += buf.length;
      cb(null);
    } catch (e) { cb(e); }
  }

  _final(cb) {
    try { this.closeSync(); cb(null); } catch (e) { cb(e); }
  }

  closeSync() {
    if (this._fd !== null) {
      try { fs.closeSync(this._fd); } catch {}
      this._fd = null;
    }
    this._closed = true;
  }

  flushSync() {
    if (this._fd !== null) {
      try { fs.fsyncSync(this._fd); } catch {}
    }
  }
}

// --- Logger instance & state -----------------------------------------------
const _state = {
  initialized: false,
  rotateStream: null,
  redactStream: null,
  pino: null,          // actual pino logger
  bootTraceId: null,
  logsDir: null,
  level: 'info',
  appVersion: '0.0.0',
  env: 'production',
  onError(err) { try { process.stderr.write('[logger] ' + (err && err.stack || String(err)) + '\n'); } catch {} },
};

function _safePinoChild(bindings) {
  if (!_state.pino) return null;
  try { return _state.pino.child(bindings || {}); } catch (e) { _state.onError(e); return null; }
}

// Logger API object: wraps pino logger with helpers; if init() not yet called,
// all log methods are no-op to avoid crash (backward compatible with noopLogger).
const loggerAPI = {
  // --- Level methods (proxy to pino if available)
  trace(...args) { if (_state.pino) { try { _state.pino.trace(...args); } catch (e) { _state.onError(e); } } return loggerAPI; },
  debug(...args) { if (_state.pino) { try { _state.pino.debug(...args); } catch (e) { _state.onError(e); } } return loggerAPI; },
  info(...args)  { if (_state.pino) { try { _state.pino.info(...args);  } catch (e) { _state.onError(e); } } return loggerAPI; },
  warn(...args)  { if (_state.pino) { try { _state.pino.warn(...args);  } catch (e) { _state.onError(e); } } return loggerAPI; },
  error(...args) { if (_state.pino) { try { _state.pino.error(...args); } catch (e) { _state.onError(e); } } return loggerAPI; },
  fatal(...args) { if (_state.pino) { try { _state.pino.fatal(...args); } catch (e) { _state.onError(e); } } return loggerAPI; },

  // --- Trace helpers
  getBootTraceId() { return _state.bootTraceId || null; },

  makeActionTrace(kind) {
    const bootId = _state.bootTraceId || '';
    const actionId = typeof nanoidFn === 'function' ? nanoidFn() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    return { bootId, actionId, kind: kind || '' };
  },

  child(bindings) {
    const pChild = _safePinoChild(bindings || {});
    // Return an API shell whose level methods proxy to this child.
    // Shell has same helpers; if child is null (pino not inited) it falls back gracefully.
    const shell = {
      trace(...a) { if (pChild) try { pChild.trace(...a); } catch (e){_state.onError(e);} return shell; },
      debug(...a) { if (pChild) try { pChild.debug(...a); } catch (e){_state.onError(e);} return shell; },
      info(...a)  { if (pChild) try { pChild.info(...a);  } catch (e){_state.onError(e);} return shell; },
      warn(...a)  { if (pChild) try { pChild.warn(...a);  } catch (e){_state.onError(e);} return shell; },
      error(...a) { if (pChild) try { pChild.error(...a); } catch (e){_state.onError(e);} return shell; },
      fatal(...a) { if (pChild) try { pChild.fatal(...a); } catch (e){_state.onError(e);} return shell; },
      tag(...tags) { return shell.child({ tags: (bindings && bindings.tags || []).concat(tags) }); },
      withTrace(k, extra) { return shell.child(Object.assign({ action_trace: loggerAPI.makeActionTrace(k) }, extra || {})); },
      child(b2) { return loggerAPI.child(Object.assign({}, bindings || {}, b2 || {})); },
    };
    return shell;
  },

  tag(...tags) { return loggerAPI.child({ tags: tags }); },

  withTrace(kind, extraBindings) {
    const tr = loggerAPI.makeActionTrace(kind);
    return loggerAPI.child(Object.assign({ action_trace: tr }, extraBindings || {}));
  },

  // Compat: old code used ctx.log = { level, message, ...props }
  //   e.g. ctx.log({ level: 'info', message: 'hi', a: 1 })
  // Now translates to: logger[level]({ a: 1, ...other }, message)
  logCompat(ctxLevelMsgObj) {
    if (!ctxLevelMsgObj || typeof ctxLevelMsgObj !== 'object') return;
    const lvl = String(ctxLevelMsgObj.level || 'info').toLowerCase();
    const msg = ctxLevelMsgObj.message || '';
    const rest = Object.assign({}, ctxLevelMsgObj);
    delete rest.level; delete rest.message;
    const fn = loggerAPI[lvl] || loggerAPI.info;
    if (Object.keys(rest).length === 0) fn(msg); else fn(rest, msg);
  },

  // Wrap ctx (context object) with ctx.log = a pre-bound child logger with ctx-id bindings.
  // Guards: ctx must exist; if ctx already has `.log`, this is no-op.
  wrapChild(kind, ctx, extraBindings) {
    if (!ctx || typeof ctx !== 'object') return;
    if (ctx.log) return; // don't clobber existing ctx.log
    const tr = { action_trace: loggerAPI.makeActionTrace(kind) };
    const bindings = Object.assign({}, tr, extraBindings || {});
    if (ctx.id) bindings.context_id = String(ctx.id);
    ctx.log = loggerAPI.child(bindings);
  },

  // --- Lifecycle: init / flush / close
  init(opts = {}) {
    const logsDir = opts.logsDir;
    if (!logsDir || typeof logsDir !== 'string') {
      throw new Error('logger.init: logsDir is required');
    }
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    // Close any previous streams (tests may call init multiple times).
    if (_state.rotateStream) {
      try { _state.rotateStream.closeSync(); } catch {}
      _state.rotateStream = null;
    }
    if (_state.redactStream) {
      try { _state.redactStream.end(); } catch {}
      _state.redactStream = null;
    }

    _state.logsDir = logsDir;
    _state.level = opts.level || 'info';
    _state.appVersion = opts.appVersion || '0.0.0';
    _state.env = opts.env || 'production';

    _state.bootTraceId = typeof nanoidFn === 'function' ? nanoidFn()
      : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

    // Create rotate stream first (sink).
    _state.rotateStream = new RotateWriteStream(logsDir, {
      maxBytes: opts.maxBytes || undefined,
      maxFiles: opts.maxFiles || undefined,
    });
    _state.rotateStream.on('error', (e) => _state.onError(e));

    // Redact transform in "deep" mode (always; fallback shallow handled by try/catch inside).
    _state.redactStream = new RedactTransform({
      redactLevel: 'deep',
      warnHandler: (m) => _state.onError(m),
    });
    // Pipe redact -> rotate. We don't need backpressure handled for crash safety so push() is fine.
    _state.redactStream.pipe(_state.rotateStream);
    _state.redactStream.on('error', (e) => _state.onError(e));

    // Build pino.
    if (pino) {
      try {
        const pinoOpts = {
          level: _state.level,
          // Disable newline insertion: we already add \n in RedactTransform per-line?
          // pino already adds \n by default; leave default so redact transform sees clean NDJSON lines.
          timestamp: pino.stdTimeFunctions && pino.stdTimeFunctions.isoTime
            ? pino.stdTimeFunctions.isoTime
            : () => (',"time":' + '"' + new Date().toISOString() + '"'),
          base: {
            pid: process.pid,
            hostname: os.hostname().slice(0, 64),
            env: _state.env,
            platform: os.platform(),
            arch: os.arch(),
            appVersion: _state.appVersion,
            bootTraceId: _state.bootTraceId,
          },
          // Add custom level strings to be "level": 30 → not needed; pino default already maps.
        };
        // dest = redactStream (pino will NDJSON write into it).
        _state.pino = pino(pinoOpts, _state.redactStream);
        _state.pino.on('error', (e) => _state.onError(e));
      } catch (e) {
        _state.onError(e);
        _state.pino = null;
      }
    }

    _state.initialized = true;

    // ---- AC-1: write boot first line ----
    // Use a plain object so JSON.stringify works; include key fields.
    const bootBindings = {
      bootTraceId: _state.bootTraceId,
      env: _state.env,
      platform: os.platform(),
      arch: os.arch(),
      appVersion: _state.appVersion,
      pid: process.pid,
      cpus: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1048576),
      nodeVersion: process.version,
      uptime: process.uptime(),
    };
    const bootMsg = 'boot ' + _state.bootTraceId + ' ' + _state.env + ' ' + os.platform();
    loggerAPI.info(bootBindings, bootMsg);
    // Flush so tests immediately read main.00.
    loggerAPI.flush();
    return true;
  },

  flush() {
    // fsync current fd + emit end on redact stream so buffered lines flush into rotateStream.
    try {
      if (_state.redactStream) {
        // Force internal buffer to flush via _flush by ending with a no-op? _flush is called at stream.end()
        // which we don't want. Instead access private method (our own class, safe).
        try {
          if (typeof _state.redactStream._flush === 'function') {
            _state.redactStream._flush(() => {});
          }
        } catch {}
      }
      if (_state.rotateStream) {
        try { _state.rotateStream.flushSync(); } catch {}
      }
    } catch (e) { _state.onError(e); }
    return true;
  },

  close() {
    try {
      if (_state.redactStream) { try { _state.redactStream.end(); } catch {} }
      if (_state.rotateStream) { try { _state.rotateStream.closeSync(); } catch {} }
    } catch (e) { _state.onError(e); }
  },

  // --- Diagnostics zip builder (AC-8) ----------------------------------------
  // Returns Promise<string> = absolute path to generated zip file.
  // Re-redacts any config files before adding. Skips large backup archives.
  async buildDiagnosticsZip(opts = {}) {
    if (!opts.logsDir || !opts.userDataDir || !opts.dshHome) {
      throw new Error('buildDiagnosticsZip: logsDir, userDataDir, dshHome are all required');
    }
    const logsDir = opts.logsDir;
    const userDataDir = opts.userDataDir;
    const dshHome = opts.dshHome;
    const outDir = opts.outDir || logsDir;
    fs.mkdirSync(outDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipName = `dsh-diagnostics-${ts}.zip`;
    const zipPath = path.join(outDir, zipName);
    const output = fs.createWriteStream(zipPath);

    let archiver;
    try { archiver = require('archiver'); } catch (e) { throw new Error('archiver dep missing: ' + e.message); }
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (e) => { throw e; });
    archive.pipe(output);

    const manifestEntries = []; // { name, size, mtime }
    let totalSize = 0;

    const isArchiveExt = (name) => /\.(zip|7z|tar|gz|tgz|rar|bz2|xz)$/i.test(name);

    // Add helper: buffer → archive entry, with manifest record.
    function addBuffer(name, buf, { mtime } = {}) {
      if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf, 'utf8');
      archive.append(buf, { name, date: mtime || new Date() });
      const sz = buf.length;
      totalSize += sz;
      manifestEntries.push({ name, size: sz, mtime: (mtime || new Date()).toISOString() });
    }

    function addFileAsIs(srcPath, archiveName) {
      if (!fs.existsSync(srcPath)) return;
      const st = fs.statSync(srcPath);
      if (st.isDirectory()) return;
      if (isArchiveExt(srcPath)) return;
      const buf = fs.readFileSync(srcPath);
      addBuffer(archiveName, buf, { mtime: st.mtime });
    }

    // (1) Logs: logsDir/main.NN
    if (fs.existsSync(logsDir)) {
      const logFiles = fs.readdirSync(logsDir)
        .filter(f => /^main\.\d{2}$/.test(f))
        .sort();
      for (const f of logFiles) {
        const src = path.join(logsDir, f);
        // Already PII-masked, but run value-masker once more on each line (defense-in-depth).
        let text;
        try { text = fs.readFileSync(src, 'utf8'); }
        catch (e) { _state.onError(e); continue; }
        // Run line-by-line value masker (shallow redact) to be safe.
        let masked = '';
        for (const line of text.split('\n')) {
          if (!line) { masked += '\n'; continue; }
          let m = line;
          try {
            // Try JSON.parse + deepRedact first; if fails, shallow value masker.
            const obj = JSON.parse(line);
            m = JSON.stringify(deepRedact(obj));
          } catch { m = _valueMasked(line); }
          masked += m + '\n';
        }
        const st = fs.statSync(src);
        addBuffer('logs/' + f, masked, { mtime: st.mtime });
      }
    }

    // (2) Config files: settings.json (JSON → deepRedact) and YAML files (shallow).
    //   settings.json
    {
      const src = path.join(userDataDir, 'settings.json');
      if (fs.existsSync(src)) {
        try {
          const raw = fs.readFileSync(src, 'utf8');
          let out = raw;
          try {
            const obj = JSON.parse(raw);
            out = JSON.stringify(deepRedact(obj), null, 2);
          } catch { out = _valueMasked(raw); }
          const st = fs.statSync(src);
          addBuffer('config/settings.json', out, { mtime: st.mtime });
        } catch (e) { _state.onError(e); }
      }
    }
    //   dsh-settings.yaml
    {
      const src = path.join(userDataDir, 'dsh-settings.yaml');
      if (fs.existsSync(src)) {
        try {
          const raw = fs.readFileSync(src, 'utf8');
          const masked = _valueMasked(raw);
          const st = fs.statSync(src);
          addBuffer('config/dsh-settings.yaml', masked, { mtime: st.mtime });
        } catch (e) { _state.onError(e); }
      }
    }
    //   profile cordis.patch.yml
    {
      const profileDir = path.join(userDataDir, 'profiles', 'web-desktop');
      const src = path.join(profileDir, 'cordis.patch.yml');
      if (fs.existsSync(src)) {
        try {
          const raw = fs.readFileSync(src, 'utf8');
          const masked = _valueMasked(raw);
          const st = fs.statSync(src);
          addBuffer('config/profile/cordis.patch.yml', masked, { mtime: st.mtime });
        } catch (e) { _state.onError(e); }
      }
    }

    // (3) Updater pending update meta.
    {
      const updaterDir = path.join(dshHome, 'updater');
      if (fs.existsSync(updaterDir)) {
        for (const f of fs.readdirSync(updaterDir)) {
          if (!/^pending-client-update-.*\.json$/i.test(f)) continue;
          const src = path.join(updaterDir, f);
          try {
            const raw = fs.readFileSync(src, 'utf8');
            let masked = raw;
            try { masked = JSON.stringify(deepRedact(JSON.parse(raw)), null, 2); }
            catch { masked = _valueMasked(raw); }
            const st = fs.statSync(src);
            addBuffer('updater/' + f, masked, { mtime: st.mtime });
          } catch (e) { _state.onError(e); }
        }
      }
    }

    // (4) Latest backup manifest (only manifest, never its backup archives).
    {
      const backupRoot = path.join(dshHome, 'updater', 'backup');
      if (fs.existsSync(backupRoot)) {
        // Iterate sub-folders, pick the one with newest mtime.
        let newestDir = null; let newestMtime = -1;
        for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const p = path.join(backupRoot, entry.name);
          try {
            const st = fs.statSync(p);
            if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newestDir = p; }
          } catch {}
        }
        if (newestDir) {
          const mani = path.join(newestDir, 'manifest.json');
          if (fs.existsSync(mani)) {
            try {
              const raw = fs.readFileSync(mani, 'utf8');
              let masked = raw;
              try { masked = JSON.stringify(deepRedact(JSON.parse(raw)), null, 2); }
              catch { masked = _valueMasked(raw); }
              const st = fs.statSync(mani);
              addBuffer('updater/backup/latest.manifest.json', masked, { mtime: st.mtime });
            } catch (e) { _state.onError(e); }
          }
        }
      }
    }

    // (5) Build diagnostics.json first so we know totalSize? Chicken-egg.
    // We'll compute totalSize (current manifest entries bytes) + add estimated overhead.
    // diagnostics.json itself is added with final totalSize.
    const diagnostics = {
      bootTraceId: _state.bootTraceId || loggerAPI.makeActionTrace('diag').actionId,
      appVersion: _state.appVersion || '0.0.0',
      env: _state.env || 'unknown',
      exportedAt: new Date().toISOString(),
      platform: os.platform(),
      arch: os.arch(),
      pid: process.pid,
      nodeVersion: process.version,
      host: (os.hostname() || '').slice(0, 64),
      entriesCount: manifestEntries.length,
      // placeholder, will be updated after we add manifest.json
      totalSize,
    };

    // First add a dummy diagnostics.json + manifest.json placeholders so their sizes are captured later? Too complex.
    // Simpler: write diagnostics first (without totalSize → final), then manifest, then patch? Archiver doesn't support patching.
    // Instead, compute the size of the (diagnostics + manifest) JSON strings, add their sizes to totalSize, THEN append them.
    const diagJSON0 = JSON.stringify(diagnostics, null, 2);
    // Estimate manifest size (approx).
    const maniStub = JSON.stringify({
      version: 1,
      generatedAt: diagnostics.exportedAt,
      entries: manifestEntries.map(e => ({ ...e })),
    }, null, 2);
    const diagSize = Buffer.byteLength(diagJSON0, 'utf8');
    const maniSize = Buffer.byteLength(maniStub, 'utf8');
    totalSize += diagSize + maniSize;
    diagnostics.totalSize = totalSize;

    // Add diagnostics.json (now with final totalSize)
    const diagFinal = JSON.stringify(diagnostics, null, 2);
    addBuffer('diagnostics.json', diagFinal, { mtime: new Date() });

    // Recompute manifest entries (added size for diagnostics.json will be off by a few bytes — acceptable, we rebuild manifest from scratch).
    const finalManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      entries: manifestEntries.map(e => ({ ...e })),
    };
    const maniBuf = Buffer.from(JSON.stringify(finalManifest, null, 2), 'utf8');
    archive.append(maniBuf, { name: 'manifest.json', date: new Date() });

    // Finalize archive & ensure output file handle fully closed (no sharing violation).
    const finished = new Promise((res, rej) => {
      output.once('close', res);
      output.once('error', rej);
      // Guard: if already closed, fire on next tick.
      process.nextTick(() => { if (output.closed) res(); });
    });
    await archive.finalize();
    await finished;

    return zipPath;
  },

  // Expose internal state for tests / diagnostics-zip builder later.
  _internalState: _state,
};

// Expose state on module-level so we can still require('./logger') then build zip from another module.
module.exports = loggerAPI;

// --- Test-only exports ------------------------------------------------------
module.exports._testExports = {
  PII_KEYS_BLACKLIST,
  PII_PREFIXES_RULES,
  PII_VALUE_PATTERNS,
  normalizeKey,
  isBlackKey,
  maskStringByPrefix: _maskPrefixesInString, // backward compat alias
  _maskPrefixesInString,
  _valueMasked,
  deepRedact,
  _deepRedactInternal,
  RedactTransform,
  RotateWriteStream,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  _idxName,
};
