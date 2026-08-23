// preload.js ↔ tauri-shell/sidecar/bridge.ts 键集一致性契约。
//
// 背景（HANDOVER-2026-08-23 §5 P2-4）：Tauri 桥按 preload.js 逐字节重建
// window.dshDesktop。任何一侧新增/改名/删除方法而另一侧没跟上，都会让某个
// 配套插件在另一壳里静默拿不到 API（与 Bug #58「注册行丢失」同类的事故面）。
// 本测试把两侧的命名空间/方法树锁成同一个形状，CI 直接红。
//
// 允许的桥侧额外键：_call/_send/_onNotify/_onReady（桥内省，非 preload 面）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const preload = readFileSync(join(root, 'preload.js'), 'utf8');
const bridge = readFileSync(join(root, '..', 'tauri-shell', 'sidecar', 'bridge.ts'), 'utf8');

// 从「赋值起点」做花括号配对，收集相对深度 1（顶层键）与 2（命名空间内键）。
// 跳过字符串/模板串/注释，避免内容里的冒号干扰。
function extractKeyTree(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `marker not found: ${marker}`);
  const braceStart = src.indexOf('{', start);
  assert.ok(braceStart > start, 'object literal not found after marker');
  let depth = 0;
  let paren = 0; // 括号深度：参数表里的 TS 类型注解（changes: unknown）不是键
  let i = braceStart;
  let quote = null; // 当前所处的字符串引号（' " `）
  let lastTop = null;
  const tree = {};
  const identRe = /[A-Za-z_$][\w$]*/y;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') {
      depth -= 1;
      if (depth === 0) break; // 对象结束
      i += 1;
      continue;
    }
    if (c === '(') { paren += 1; i += 1; continue; }
    if (c === ')') { paren -= 1; i += 1; continue; }
    // 键位置：标识符 + 可选空白 + ':'（跳过 "?." 与 "::" 等非键形态）。
    if (/[A-Za-z_$]/.test(c)) {
      identRe.lastIndex = i;
      const m = identRe.exec(src);
      if (m) {
        let j = m[0].length + i;
        while (j < src.length && /\s/.test(src[j])) j += 1;
        if (src[j] === ':' && src[j + 1] !== ':' && paren === 0) {
          const name = m[0];
          if (depth === 1) {
            tree[name] = [];
            lastTop = name;
          } else if (depth === 2 && lastTop) {
            tree[lastTop].push(name);
          }
        }
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  assert.ok(depth === 0, `unbalanced braces after ${marker}`);
  return tree;
}

const preloadTree = extractKeyTree(preload, 'const dshDesktop =');
const bridgeTree = extractKeyTree(bridge, '(window as any).dshDesktop =');

test('preload dshDesktop exposes the expected namespaces', () => {
  // 基线锚点：防止解析器写歪导致两侧都解析出空树「假绿」。
  const tops = Object.keys(preloadTree).filter((k) => !k.startsWith('_'));
  for (const need of ['appVersion', 'windowControls', 'menu', 'getInfo', 'refreshBalance',
    'restartService', 'floatWindow', 'guard', 'pluginWizard', 'pluginManager', 'pluginUpdates',
    'imagePaste', 'balancePrices', 'balanceModels', 'revertFiles', 'openPath', 'openExternal',
    'copyText', 'getPathForFile', 'recovery', 'rescue']) {
    assert.ok(tops.includes(need), `preload missing ${need}`);
  }
  assert.ok(preloadTree.windowControls.length >= 5, 'windowControls subkeys parsed');
  assert.ok(preloadTree.rescue.length >= 7, 'rescue subkeys parsed');
});

test('bridge dshDesktop key tree matches preload exactly', () => {
  const preloadTops = Object.keys(preloadTree).sort();
  const bridgeTops = Object.keys(bridgeTree)
    .filter((k) => !k.startsWith('_')) // _call/_send/_onNotify/_onReady = 桥内省额外面
    .sort();
  assert.deepEqual(bridgeTops, preloadTops, '顶层键集不一致（一侧新增/改名/漏了方法）');
  for (const ns of preloadTops) {
    if (preloadTree[ns].length === 0 && bridgeTree[ns].length === 0) continue; // 叶子字段
    assert.deepEqual(
      [...bridgeTree[ns]].sort(),
      [...preloadTree[ns]].sort(),
      `命名空间 ${ns} 的方法集不一致`,
    );
  }
});

test('bridge keeps the introspection escape hatch for shell pages', () => {
  for (const k of ['_call', '_onReady']) {
    assert.ok(k in bridgeTree, `bridge introspection key missing: ${k}`);
  }
});
