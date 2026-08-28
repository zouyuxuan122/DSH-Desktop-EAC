// koffi 预检探针（koffi-preflight.ts + scripts/koffi-preflight.cjs，Electron ABI
// 专用）已随 Electron 冻结壳退役（批次 C）。koffi 仍是运行时依赖（内核
// @deepseek-ai/dsh 目录选择器等经 FFI 使用），本测试保留「原生绑定可加载」的
// 运行时 ABI 契约，并锁定装配清单不再携带预检脚本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('koffi 原生绑定可在当前 Node（v24 ABI）下加载', () => {
  const koffi = require('koffi');
  assert.equal(typeof koffi.load, 'function', 'koffi 应导出 load（FFI 库）');
});

test('stage-resources 不再装配 koffi 预检探针（已随壳退役）', () => {
  const stage = readFileSync(join(root, '..', 'tauri-shell', 'stage-resources.mjs'), 'utf8');
  for (const name of ['ROOT_FILES', 'SCRIPTS']) {
    const m = stage.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`));
    assert.ok(m, `${name} 清单缺失`);
    assert.ok(!/koffi-preflight/.test(m[1]), `${name} 不应再携带 koffi-preflight`);
  }
});