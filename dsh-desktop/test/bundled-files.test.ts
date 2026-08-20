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

// Task 14：上述两个测试只覆盖 main.js 的「直接」require。Task 6 门面化把
// logger/client-updater/plugin-guard 拆进了 lib/ 子目录，门面在清单里面、
// 实现文件却不在 —— 启动照样闪退。本测试从 main.js / host-bootstrap.js /
// preload.js 三个入口出发做 require 闭包遍历（读编译产物 .js），每一个
// 可静态解析的本地相对 require 都必须命中 files 清单。
test('入口 require 闭包内的每个本地模块都在 files 清单中', () => {
  const patterns = bundledFilesPatterns();
  const patternSet = new Set(patterns);

  /** 编译产物里的本地相对 require（CJS 双引号/单引号均可）。 */
  function localRequiresOfCompiled(src: string): string[] {
    const out: string[] = [];
    const re = /require\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[2]);
    return out;
  }

  const entries = ['main.js', 'host-bootstrap.js', 'preload.js'];
  const seen = new Set<string>();
  const queue = [...entries];
  let walked = 0;
  while (queue.length) {
    const rel = queue.shift() as string;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(root, rel);
    if (!fs.existsSync(abs)) continue; // 入口或依赖不存在（如未编译的 .cjs）跳过
    walked++;
    const dir = path.posix.dirname(rel);
    for (const spec of localRequiresOfCompiled(fs.readFileSync(abs, 'utf8'))) {
      const joined = dir === '.' ? spec : path.posix.join(dir, spec);
      const norm = path.posix.normalize(joined);
      if (!fs.existsSync(join(root, norm))) continue; // 动态/可选 require 解析失败不阻断
      queue.push(norm);
    }
  }
  assert.ok(walked >= 5, `闭包至少应覆盖 5 个文件，实际 ${walked}`);
  const missing = [...seen].filter((f) => f !== 'main.js' && f !== 'host-bootstrap.js' && f !== 'preload.js' && !patternSet.has(f));
  assert.deepEqual(missing, [],
    '以下模块在入口 require 闭包内但未打包（启动即闪退风险）: ' + missing.join(', '));
});
