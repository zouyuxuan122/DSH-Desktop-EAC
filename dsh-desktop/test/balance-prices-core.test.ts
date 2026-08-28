import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const balance = await import(pathToFileURL(join(root, 'balance.js')).href);

test('sanitizePrices：合法双档价格原样通过', () => {
  const src = {
    peak: { cacheMiss: 9, cacheHit: 0.3, output: 27 },
    offpeak: { cacheMiss: 1.5, cacheHit: 0.05, output: 4.5 },
  };
  assert.deepEqual(Array.from(balance.sanitizePrices(src).peak), Array.from(src.peak));
  assert.deepEqual(Array.from(balance.sanitizePrices(src).offpeak), Array.from(src.offpeak));
});

test('sanitizePrices：数字字符串与 0 边界合法', () => {
  const out = balance.sanitizePrices({ peak: { cacheMiss: '0', cacheHit: 0, output: 1 }, offpeak: { cacheMiss: 0, cacheHit: '0.5', output: 0 } });
  assert.equal(out.peak.cacheMiss, 0);
  assert.equal(out.peak.output, 1);
  assert.equal(out.offpeak.cacheHit, 0.5);
});

test('sanitizePrices：负数 / NaN / 超上限 / 非数字 / 缺失档位全部拒绝', () => {
  const bad = (prices) => assert.throws(() => balance.sanitizePrices(prices));
  const good = { peak: { cacheMiss: 1, cacheHit: 1, output: 1 }, offpeak: { cacheMiss: 1, cacheHit: 1, output: 1 } };
  bad({ ...good, peak: { cacheMiss: -1, cacheHit: 1, output: 1 } });
  bad({ ...good, offpeak: { cacheMiss: 1, cacheHit: 'abc', output: 1 } });
  bad({ ...good, peak: { cacheMiss: 1, cacheHit: 1, output: 1001 } });
  bad({ ...good, peak: { cacheMiss: 1, cacheHit: Number.NaN, output: 1 } });
  bad({ ...good, peak: { cacheMiss: 1, cacheHit: 1, output: Number.POSITIVE_INFINITY } });
  bad({ peak: good.peak });
  bad({ peak: null });
  bad(null);
  bad({ peak: good.peak, offpeak: 'x' });
});

test('tierPrices：无覆盖时回退档 <- 模型默认档', () => {
  const base = { peak: { cacheMiss: 9, cacheHit: 0.3, output: 27 }, offpeak: { cacheMiss: 4.5, cacheHit: 0.15, output: 13.5 } };
  const t = balance.tierPrices(base, null, 'peak');
  assert.equal(t.cacheMiss, 9);
  assert.equal(t.cacheHit, 0.3);
  const o = balance.tierPrices(base, null, 'offpeak');
  assert.equal(o.output, 13.5);
});

test('tierPrices：双档覆盖只影响对应档位，另一档保持默认', () => {
  const base = balance.DEFAULT_PRICES['deepseek-v4-flash'];
  const ov = { peak: { cacheMiss: 5, cacheHit: 0.2, output: 15 }, offpeak: { cacheMiss: 2.5, cacheHit: 0.1, output: 7.5 } };
  const p = balance.tierPrices(base, ov, 'peak');
  assert.deepEqual(Array.from(p), Array.from({ cacheMiss: 5, cacheHit: 0.2, output: 15 }));
  const o = balance.tierPrices(base, ov, 'offpeak');
  assert.equal(o.cacheMiss, 2.5);
  assert.equal(o.output, 7.5);
});

test('tierPrices：旧扁平覆盖应用到两档（兼容）', () => {
  const base = balance.DEFAULT_PRICES['deepseek-chat'];
  const ov = { cacheMiss: 3, cacheHit: 0.7, output: 9 };
  const p = balance.tierPrices(base, ov, 'peak');
  const o = balance.tierPrices(base, ov, 'offpeak');
  assert.equal(p.cacheHit, 0.7);
  assert.equal(o.cacheHit, 0.7);
  assert.equal(p.cacheMiss, 3);
});

test('tierPrices：双档覆盖缺档时该档退回默认', () => {
  const base = balance.DEFAULT_PRICES['deepseek-v4-pro'];
  const ov = { peak: { cacheMiss: 1, cacheHit: 1, output: 1 } };
  const o = balance.tierPrices(base, ov, 'offpeak');
  assert.equal(o.cacheMiss, base.offpeak.cacheMiss);
  assert.equal(o.output, base.offpeak.output);
});

test('tierPrices：未知模型（无 base 档）回退 FALLBACK_PRICES', () => {
  const t = balance.tierPrices(balance.FALLBACK_PRICES, null, 'peak');
  assert.equal(t.cacheMiss, balance.FALLBACK_PRICES.peak.cacheMiss);
  const o = balance.tierPrices(balance.FALLBACK_PRICES, null, 'offpeak');
  assert.equal(o.output, balance.FALLBACK_PRICES.offpeak.output);
});
