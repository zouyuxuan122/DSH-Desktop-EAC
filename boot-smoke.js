'use strict';
// P2 boot.start 冒烟驱动（一次性）：临时 DSH_HOME 下完整走
// 前置准备 → spawn dsh web → webUrl → HTTP 探活 → 优雅关停。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const tmpHome = path.join(repo, 'tmp-p2boot', 'dsh-home');
fs.mkdirSync(tmpHome, { recursive: true });

const node = process.execPath;
const sidecar = path.join(repo, 'tauri-shell', 'sidecar', 'server.js');
const child = spawn(node, [sidecar], {
  env: { ...process.env, DSH_HOME: tmpHome },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const t0 = Date.now();
const fail = (msg) => { console.error('[boot-smoke] FAIL:', msg); child.kill(); process.exit(1); };
const timer = setTimeout(() => fail('总超时 300s'), 300000);

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1 && msg.result && msg.result.webUrl) {
      const url = msg.result.webUrl;
      console.log('[boot-smoke] boot.start ok in', Math.round((Date.now() - t0) / 1000) + 's →', url);
      // 探活
      http.get(url + '/', { timeout: 5000 }, (r) => {
        r.resume();
        console.log('[boot-smoke] probe status =', r.statusCode);
        clearTimeout(timer);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} }) + '\n');
        setTimeout(() => { console.log('[boot-smoke] PASS'); child.kill(); process.exit(0); }, 9000);
      }).on('error', (e) => fail('probe error: ' + e.message));
    } else if (msg.id === 1 && msg.error) {
      fail('boot.start error: ' + JSON.stringify(msg.error));
    } else if (msg.method === 'boot.web-ready') {
      console.log('[boot-smoke] notify boot.web-ready:', JSON.stringify(msg.params));
    }
  }
});

setTimeout(() => {
  console.log('[boot-smoke] sending boot.start (DSH_HOME=' + tmpHome + ')');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'boot.start', params: {} }) + '\n');
}, 500);
child.on('exit', (code) => { console.log('[boot-smoke] sidecar exited code=' + code); });
