import assert from "node:assert/strict";
import plugin, { apply, calculateCost, extractOfficialPrices, normalizeUsage, totalsOf } from "../lib/index.js";

assert.equal(plugin.apply, apply);
assert.equal(typeof plugin.apply, "function");
assert.deepEqual(normalizeUsage({ inputTokens: 3, outputTokens: 4 }), { uncachedInputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
assert.deepEqual(totalsOf({ a: { usage: { inputTokens: 3 } }, b: { usage: { outputTokens: 4 } } }), { uncachedInputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
assert.equal(calculateCost({ uncachedInputTokens: 1_000_000 }, { cacheMiss: 1, usdToCurrency: 7 }), 7);
assert.deepEqual(extractOfficialPrices("deepseek-v4-flash $0.01 $0.2 $0.6 $0.02 $0.4 $1.2"), { cacheHit: 0.02, cacheMiss: 0.4, output: 1.2 });
const matrix = `<table><tr><td>MODEL</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr><tr><td rowspan="6">PRICING</td><td>CACHE HIT</td><td>OFF-PEAK</td><td>$0.007</td><td>$0.022</td></tr><tr><td>PEAK</td><td>$0.014</td><td>$0.044</td></tr><tr><td>CACHE MISS</td><td>OFF-PEAK</td><td>$0.22</td><td>$0.66</td></tr><tr><td>PEAK</td><td>$0.44</td><td>$1.32</td></tr><tr><td>OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.66</td><td>$1.98</td></tr><tr><td>PEAK</td><td>$1.32</td><td>$3.96</td></tr><tr><td>Concurrency Limit</td></tr></table>`;
assert.deepEqual(extractOfficialPrices(matrix, "deepseek-v4-flash"), { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 });
assert.deepEqual(extractOfficialPrices(matrix, "deepseek-v4-pro"), { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 });

let effectCleanup;
const registered = [];
apply({
  get(key) { return key === "webServer" ? { register(spec) { registered.push(spec); return () => registered.push("disposed"); } } : null; },
  effect(callback) { effectCleanup = callback(); }
});
assert.equal(registered[0].path, "/plugins/dsh-whale-meter/state.json");
effectCleanup();
assert.equal(registered[1], "disposed");
console.log("dsh-whale-meter smoke tests passed");
