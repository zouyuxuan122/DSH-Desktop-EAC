// 分析 desktop-core 及根模块的本地 require 闭包（复制根模块用）
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const seen = new Set();
const deps = new Map();

// 按 Node 解析规则把 require('./x') 解析成真实文件（x.js / x.json / x/index.js）
function resolveLocal(currentRel, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(currentRel), spec));
  for (const cand of [base, base + '.js', base + '.json', base + '/index.js', base + '/index.mjs']) {
    if (fs.existsSync(path.join(root, cand))) return cand;
  }
  return null;
}

function scan(rel) {
  if (seen.has(rel)) return;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
  seen.add(rel);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    return;
  }
  const local = new Set();
  const re = /require\((['"])(\.\.?\/[^'"]+)\1\)/g;
  let m;
  while ((m = re.exec(src))) local.add(m[2]);
  const re2 = /import\(['"](\.\.?\/[^'"]+)['"]\)/g;
  while ((m = re2.exec(src))) local.add(m[1]);
  const resolved = [];
  for (const d of local) {
    const r = resolveLocal(rel, d);
    if (r) resolved.push(r);
  }
  deps.set(rel, resolved);
  for (const r of resolved) scan(r);
}

scan('desktop-core.js');
console.log('--- 需要的根模块/脚本文件 ---');
const files = [...deps.keys()].sort();
for (const f of files) console.log(f);
console.log(`共 ${files.length} 个文件`);