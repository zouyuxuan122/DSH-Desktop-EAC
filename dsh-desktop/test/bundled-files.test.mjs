import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 防呆（v3.0.0 事故）：main.js 顶层 require 的本地模块（如 ./bundle-integrity）
// 若未列进 electron-builder.yml 的 files，打包产物启动即抛
// "Cannot find module" 并闪退。本测试静态比对两边清单。
//
// 约定：main.js 顶层的 require('./xxx') / require('./xxx.js') 都必须是
// files 清单里的一个条目（相对根目录的文件名）。运行时动态 require 的
// （dshBin 的 @deepseek-ai/dsh 走 node_modules，由默认规则打包）不受影响。

const mainSrc = fs.readFileSync(join(root, 'main.js'), 'utf8');

function localRequiresOf(src) {
  const out = new Set();
  const re = /require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let name = m[1];
    if (!name.endsWith('.js')) name = name + '.js';
    out.add(name);
  }
  return out;
}

function bundledFilesPatterns() {
  const yml = fs.readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  const lines = yml.split(/\r?\n/);
  const patterns = [];
  let inFiles = false;
  for (const line of lines) {
    if (/^files:/.test(line)) { inFiles = true; continue; }
    if (inFiles) {
      const m = line.match(/^\s{2}-\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/);
      if (m) patterns.push(m[1] || m[2] || m[3]);
      else if (line.trim() && !line.trim().startsWith('#')) inFiles = false;
    }
  }
  return patterns;
}

test('main.js 顶层 require 的每个本地模块都在 electron-builder files 清单中', () => {
  const requires = localRequiresOf(mainSrc);
  assert.ok(requires.size >= 10, '应至少识别出 10 个本地依赖，实际: ' + [...requires].join(', '));
  const patterns = bundledFilesPatterns();
  assert.ok(patterns.length > 0, 'files 清单解析失败');
  const missing = [...requires].filter((name) => !patterns.includes(name));
  assert.deepEqual(missing, [],
    '以下模块被 main.js require 但未打包，会导致启动即闪退: ' + missing.join(', '));
});

test('main.js 通过 __dirname 直接引用的运行时脚本也必须打包', () => {
  // spawn/读取型引用：path.join(__dirname, 'xxx.js') 形式
  const refs = new Set();
  const re = /__dirname\s*,\s*['"]([^'"]+\.js)['"]/g;
  let m;
  while ((m = re.exec(mainSrc)) !== null) refs.add(m[1]);
  const patterns = bundledFilesPatterns();
  const missing = [...refs].filter((name) => !patterns.includes(name));
  assert.deepEqual(missing, [],
    '以下脚本被运行时引用但未打包: ' + missing.join(', '));
});

test('preload.js 必须在打包清单中（窗口上下文桥）', () => {
  const patterns = bundledFilesPatterns();
  assert.ok(patterns.includes('preload.js'));
});
