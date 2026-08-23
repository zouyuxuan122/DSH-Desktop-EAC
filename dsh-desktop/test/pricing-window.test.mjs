import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  DEFAULT_PEAK_WINDOWS,
  normalizePeakWindows,
  computePricingState,
  DEFAULT_PRICES,
  FALLBACK_PRICES,
} = require(join(root, 'balance.js'));

const at = (hh, mm = 0) => new Date(2026, 7, 16, hh, mm, 0, 0); // 本地时区任意日

test('默认高峰窗口：9:00-12:00、14:00-18:00（官方 2026-08-17 峰谷价）', () => {
  assert.deepEqual(DEFAULT_PEAK_WINDOWS, [['09:00', '12:00'], ['14:00', '18:00']]);
  assert.deepEqual(normalizePeakWindows(undefined), [[540, 720], [840, 1080]]);
});

test('normalizePeakWindows：非法配置回退官方默认', () => {
  assert.deepEqual(normalizePeakWindows('garbage'), [[540, 720], [840, 1080]]);
  assert.deepEqual(normalizePeakWindows([['25:00', '12:00']]), [[540, 720], [840, 1080]]);
  assert.deepEqual(normalizePeakWindows([['09:00', '09:00']]), [[540, 720], [840, 1080]]);
  assert.deepEqual(normalizePeakWindows([]), [[540, 720], [840, 1080]]);
  // 合法配置透传并排序
  assert.deepEqual(normalizePeakWindows([['14:00', '18:00'], ['09:00', '12:00']]), [[540, 720], [840, 1080]]);
});

test('computePricingState：官方默认窗口内判峰谷与 nextAt', () => {
  const s1 = computePricingState(undefined, at(10, 30));
  assert.equal(s1.period, 'peak');
  assert.equal(s1.windows[1][0], '14:00');
  assert.equal(new Date(s1.nextAt).getHours(), 12);
  assert.equal(new Date(s1.nextAt).getMinutes(), 0);

  const s2 = computePricingState(undefined, at(13, 0));
  assert.equal(s2.period, 'offpeak');
  assert.equal(new Date(s2.nextAt).getHours(), 14);

  const s3 = computePricingState(undefined, at(16, 0));
  assert.equal(s3.period, 'peak');
  assert.equal(new Date(s3.nextAt).getHours(), 18);

  const s4 = computePricingState(undefined, at(19, 0));
  assert.equal(s4.period, 'offpeak');
  assert.equal(new Date(s4.nextAt).getHours(), 9); // 次日 09:00
  assert.equal(new Date(s4.nextAt).getDate(), 17);
});

test('computePricingState：跨午夜窗口（23:00-08:00）', () => {
  const winds = [['23:00', '08:00']];
  const s1 = computePricingState(winds, at(23, 30));
  assert.equal(s1.period, 'peak');
  assert.equal(new Date(s1.nextAt).getHours(), 8); // 次日 08:00
  assert.equal(new Date(s1.nextAt).getDate(), 17);

  const s2 = computePricingState(winds, at(6, 0));
  assert.equal(s2.period, 'peak');
  assert.equal(new Date(s2.nextAt).getHours(), 8); // 当日 08:00

  const s3 = computePricingState(winds, at(12, 0));
  assert.equal(s3.period, 'offpeak');
  assert.equal(new Date(s3.nextAt).getHours(), 23); // 当日 23:00
});

test('官方新定价表：v4-flash/v4-pro 高峰=空闲×2，FALLBACK 双档结构', () => {
  assert.deepEqual(DEFAULT_PRICES['deepseek-v4-flash'], {
    peak: { cacheMiss: 3, cacheHit: 0.1, output: 9 },
    offpeak: { cacheMiss: 1.5, cacheHit: 0.05, output: 4.5 },
  });
  assert.deepEqual(DEFAULT_PRICES['deepseek-v4-pro'], {
    peak: { cacheMiss: 9, cacheHit: 0.3, output: 27 },
    offpeak: { cacheMiss: 4.5, cacheHit: 0.15, output: 13.5 },
  });
  for (const name of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']) {
    const t = DEFAULT_PRICES[name];
    const miss = t.peak.cacheMiss === t.offpeak.cacheMiss * 2 || t.peak.cacheMiss === t.offpeak.cacheMiss;
    assert.ok(miss, `${name} cacheMiss 应翻倍或同价`);
    const out = t.peak.output === t.offpeak.output * 2 || t.peak.output === t.offpeak.output;
    assert.ok(out, `${name} output 应翻倍或同价`);
  }
  for (const src of ['peak', 'offpeak']) {
    assert.ok(FALLBACK_PRICES[src] && FALLBACK_PRICES[src].cacheMiss > 0, `FALLBACK_PRICES.${src}`);
  }
});