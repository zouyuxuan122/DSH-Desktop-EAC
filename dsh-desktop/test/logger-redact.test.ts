// Behavior: deepRedact() 三层 PII 命中 + 异常放行 + Map/Set util.inspect
// Expected: 键黑命中一律 '***'；前缀命中（sk-* / AKIA / ASIA / SEC* / encrypt_key 等）保留前 6 后 4 中间 ***；
//           值正则（JWT/PEM/手机号 1[3-9]/邮箱/家目录）命中；异常 getter 不丢日志且单条 warn；
//           Map/Set 整体经 util.inspect 过值正则（漏不进）
// Source: plan/logging-system.md step 2.3 + spec AC-2/AC-5/AC-6/AC-7

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const loggerPath = path.resolve(__dirname, '..', 'logger.js');
const require = createRequire(import.meta.url);

// 被测模块（先导出 deepRedact 内部函数 + PII 常量列表；RED 阶段肯定 importError 或 not exported）
let logger = null;
try { logger = require(loggerPath); } catch (err) { globalThis._requireErr = err; }

test('deepRedact 存在（RED 阶段必失败，用于确认测试框架跑起来）', () => {
  assert.ok(logger && typeof logger._testExports?.deepRedact === 'function',
    `logger._testExports.deepRedact should exist (have: ${Object.keys(logger || {})}, require err: ${globalThis._requireErr || 'no err'})`);
});

if (logger && logger._testExports?.deepRedact) {
  const { deepRedact, PII_PREFIXES_RULES, PII_KEYS_BLACKLIST } = logger._testExports;

  // -------- 键黑命中（AC-2）：各种大小写/分隔符变体
  const KEYS = [
    ['apiKey', 'sk-ant-123'], ['API_KEY', 'sk-ant-123'], ['api-key', 'sk-ant-123'],
    ['apikey', 'sk-ant-123'], ['apisecret', 'x'], ['secret', 'x'], ['accessKey', 'x'],
    ['access_token', 'x'], ['accessToken', 'x'], ['refreshToken', 'x'], ['authToken', 'x'],
    ['sessionToken', 'x'], ['bearerToken', 'x'], ['clientId', 'x'], ['clientSecret', 'x'],
    ['password', 'x'], ['passwd', 'x'], ['pwd', 'x'], ['passphrase', 'x'],
    ['authorization', 'x'], ['authorisation', 'x'], ['cookie', 'x'], ['sessionId', 'x'],
    ['session_id', 'x'], ['userId', 'x'], ['accountId', 'x'], ['phone', '13800000000'],
    ['mobile', '13800000000'], ['email', 'a@b.com'],
    ['AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE'], ['aws_secret_access_key', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['dingtalkSecret', 'SECxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
    ['feishuSecret', 'a1b2c3d4'], ['lark_secret', 'a1b2c3d4'],
    ['encrypt_key', 'xxxxx'], ['sign', 'SECabc12345'],
    ['proxyPassword', 'xx'], ['databaseUrl', 'postgres://u:p@h/db'],
    ['dbPassword', 'xx'], ['encryptionKey', 'xx'], ['licenseKey', 'xx'],
    ['jwt', 'xx'],
  ];
  for (const [k, v] of KEYS) {
    test(`键黑命中 ${k} -> '***'`, () => {
      const obj = {}; obj[k] = v;
      const out = deepRedact(obj);
      assert.equal(out[k], '***', `key ${k} should mask to *** got ${JSON.stringify(out[k])}`);
    });
  }

  // 键黑大小写不敏感 + 前缀/后缀 包容：X-API-KEY
  test('键黑命中 X-API-KEY (dash case + X- 前缀)', () => {
    assert.equal(deepRedact({ 'X-API-KEY': 'secret' })['X-API-KEY'], '***');
  });

  // 嵌套对象深遍历
  test('嵌套对象 deepRedact 内层字段命中', () => {
    const obj = { a: { b: { c: { secret: 'sk-' + 'x'.repeat(32) } } } };
    assert.equal(deepRedact(obj).a.b.c.secret, '***');
  });

  // 数组深遍历
  test('数组中的对象键黑', () => {
    const arr = [{ apiKey: 'sk-ant' }, 'plain'];
    assert.equal(deepRedact(arr)[0].apiKey, '***');
    assert.equal(deepRedact(arr)[1], 'plain');
  });

  // -------- 前缀命中（AC-6 / AC-7：sk-ant / AKIA / ASIA / 钉钉 SEC / sk-or / ds- / ghp_ 等）
  const PREFIX_CASES = [
    ['AKIAIOSFODNN7EXAMPLE',      'AKIA***MPLE',        'AWS AKIA 保留前 6 后 4'],
    ['ASIAIOSFODNN7EXAMPLE',      'ASIA***MPLE',        'AWS ASIA STS 前缀保留前 6 后 4'],
    ['sk-ant-1234567890abcdef',   'sk-an***cdef',       'sk-ant 前缀'],
    ['sk-or-abcdefghijklmnopqrs', 'sk-or***pqrs',       'sk-or OpenRouter'],
    ['ds-abcdefghijklmnopqrstuvw','ds-ab***tuvw',       'ds- Deepseek'],
    ['ghp_abcdefghijklmnopqrstuvwxyz1234567890', 'ghp_ab***7890', 'GitHub ghp_ 令牌'],
    ['SECxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'SECxxx***xxxx', '钉钉 webhook sign=SEC... 前缀'],
  ];
  for (const [val, want, desc] of PREFIX_CASES) {
    test(`前缀命中：${desc}`, () => {
      const out = deepRedact({ payload: val });
      // 前缀命中后，payload 字段因未在键黑（payload 白），会走值正则/前缀。
      // 我们把 payload 当作字符串值直接检查值 mask 规则也对。
      const s = typeof out === 'string' ? out : String(out.payload ?? '');
      assert.equal(s, want, `value mask 错：期望 "${want}"，实际 "${s}"`);
    });
  }

  // -------- 值正则命中
  // 手机号 1[3-9]\d{9}（AC-7，值正则）
  test('值正则：中国手机号 13800138000 -> 1***8000', () => {
    const s = deepRedact({ user: '我的手机号是 13800138000 请联系' }).user;
    assert.equal(s, '我的手机号是 138****8000 请联系', `实际：${s}`);
  });

  // 邮箱（值正则）
  test('值正则：邮箱 alice.longname@example.co.uk -> a****@example.co.uk', () => {
    const s = deepRedact({ payload: '邮件到 alice.longname@example.co.uk 抄送' }).payload;
    assert.match(s, /^邮件到 a\*{4}@example\.co\.uk 抄送$/, `实际：${s}`);
  });

  // JWT（值正则）
  test('值正则：JWT eyJ.eyJ.sig -> eyJ***', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const s = deepRedact({ payload: jwt }).payload;
    assert.equal(s, 'eyJ***');
  });

  // 家目录动态替换（Windows %USERPROFILE%，POSIX ~）
  test('值正则：家目录替换为平台占位符', () => {
    const home = os.homedir(); // e.g. C:\Users\lbn
    const s = deepRedact({ payload: `打开路径 ${home}\\AppData\\Roaming 即可` }).payload;
    const placeholder = process.platform === 'win32' ? '%USERPROFILE%' : '~';
    assert.equal(s, `打开路径 ${placeholder}\\AppData\\Roaming 即可`, `实际：${s}  |  home=${home}`);
  });

  // -------- 异常 getter 放行（plan Critic reservation）：不丢日志 + 单条 warn 记录
  test('deepRedact 异常 getter 放行，不抛且不丢原文', () => {
    const bad = { good: 'ok' };
    let gotWarn = null;
    Object.defineProperty(bad, 'boom', {
      get() { throw new Error('boom getter'); },
      enumerable: true, configurable: true,
    });
    const origErr = console.error;
    try {
      console.error = (x) => { gotWarn = x; }; // _warnHandler 我们会注入
      const out = logger._testExports._deepRedactInternal
        ? logger._testExports._deepRedactInternal(bad, new WeakMap(), { onError: (e) => { gotWarn = e; } })
        : deepRedact(bad);
      assert.equal(out.good, 'ok', 'good key 必须保留不丢');
      if (gotWarn) assert.ok(gotWarn.message.includes('boom'), `应当记录 boom 警告，实际：${gotWarn}`);
    } finally { console.error = origErr; }
  });

  // -------- 循环引用（WeakSet）不死循环 + 不抛
  test('deepRedact 循环引用不崩', () => {
    const a = {}; a.self = a; a.secret = 'sk-xxx';
    const out = deepRedact(a);
    assert.equal(out.secret, '***');
    assert.equal(out.self, out); // 循环引用保留（通过 WeakSet 不重入）
  });

  // -------- Map / Set 整体 util.inspect 过值正则（Critic reservation：不进 Map/Set 遍历）
  test('Map/Set 里的 PII 通过整体 inspect 过值正则不会漏', () => {
    const m = new Map([['apiKey', 'sk-ant-abcdefghijklmnopqrstuvw']]);
    const out = deepRedact({ payload: m });
    // Map 不会被深遍历，但其整体 toString/inspect 走值正则：sk-ant- 前缀 -> mask
    const rep = typeof out.payload === 'string' ? out.payload : String(out.payload) + (out.payload && out.payload[Symbol.for('nodejs.util.inspect.custom')] ? require('util').inspect(out.payload) : '');
    // 调用 _inspect 显式走值正则：
    const val = logger._testExports._valueMasked
      ? logger._testExports._valueMasked(require('util').inspect(m))
      : require('util').inspect(m);
    assert.ok(!val.includes('sk-ant-abcdefghijklmnopqrstuvw'),
      `Map 内的 sk-ant* 应被前缀 mask，实际：${val}`);
  });
}
