'use strict';

// 构建前语法预检（prepack / predist 自动执行）。
// v0.3.8 事故（上游）：main.js 中 `async` 关键字与 function 声明被注释拆开，
// 打包出启动即抛 ReferenceError: async is not defined 的安装包。
// 该类问题 node --check 查不出来（孤立 async 是合法的表达式语句，
// 错误发生在运行时），因此本脚本额外做模式扫描。
// 检查范围与 electron-builder.yml 的 files 清单保持一致（入口 js）。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entryFiles = [
  'main.js',
  'preload.js',
  'updater.js',
  'client-updater.js',
  'balance.js',
  'session-watcher.js',
  'session-encoding-heal.js',
  'renderer-recovery.js',
  'watchdog.js',
  'shortcut-maintenance.js',
  'stable-port.js',
  'stream-write-guard.js',
  'koffi-preflight.js',
  'profile-module-heal.js',
  'patch-row-heal.js',
  'plugin-guard.js',
  'rescue-agent.js',
  'preset-sync.js',
];

// 匹配「async/await 关键字与紧随其后的 function 声明之间被空行/注释行拆开」：
//   async // 注释…
//   // 更多注释…
//   function probeOverlayAgent() {}
// 孤立 async/await 表达式在运行时会抛 ReferenceError，必须在打包前拦截。
const DETACHED_KEYWORD = /^[ \t]*(async|await)[ \t]*(?:\/\/[^\r\n]*)?[ \t]*\r?\n(?:[ \t]*(?:\/\/[^\r\n]*)?[ \t]*\r?\n)*[ \t]*function\b/gm;

function detachedHits(text) {
  const hits = [];
  let match;
  DETACHED_KEYWORD.lastIndex = 0;
  while ((match = DETACHED_KEYWORD.exec(text)) !== null) {
    const upTo = text.slice(0, match.index);
    hits.push({ keyword: match[1], line: upTo.split(/\r?\n/).length });
  }
  return hits;
}

const missing = entryFiles.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) {
  console.error('[check-syntax] 缺少入口文件: ' + missing.join(', '));
  process.exit(1);
}

let failed = 0;
for (const file of entryFiles) {
  const filePath = path.join(root, file);
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    failed++;
    console.error(`[check-syntax] FAIL ${file}（node --check）`);
    if (result.stderr) console.error(result.stderr.trim());
    continue;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const hits = detachedHits(text);
  if (hits.length > 0) {
    failed++;
    console.error(`[check-syntax] FAIL ${file}（疑似 async/await 关键字与声明被拆开）`);
    for (const hit of hits) {
      console.error(`  行 ${hit.line}: 孤立的 ${hit.keyword} 后跟 function 声明，运行时会抛 ReferenceError`);
    }
    continue;
  }
  console.log(`[check-syntax] ok   ${file}`);
}

if (failed > 0) {
  console.error(`[check-syntax] ${failed} 个文件未通过，终止打包。`);
  process.exit(1);
}
console.log('[check-syntax] 全部入口文件语法检查通过。');
