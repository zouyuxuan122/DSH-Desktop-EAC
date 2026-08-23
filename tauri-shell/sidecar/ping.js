'use strict';

// L2 Node sidecar PoC —— stdio JSON-RPC（行分隔帧）。
// 未来承载 lib/desktop/* 全部业务模块；本文件演示协议与 L3 内核定位。

const path = require('node:path');

function respond(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try {
    req = JSON.parse(text);
  } catch {
    return respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const { id, method, params } = req;
  try {
    if (method === 'ping') {
      return respond({ jsonrpc: '2.0', id, result: { pong: true, ts: Date.now(), gotParams: params || null } });
    }
    if (method === 'shell.info') {
      return respond({
        jsonrpc: '2.0',
        id,
        result: {
          sidecar: 'ping.js',
          node: process.version,
          platform: process.platform,
          pid: process.pid,
        },
      });
    }
    if (method === 'dsh.probe') {
      // L2 → L3：定位随 dsh-desktop 分发的内核 CLI（零改动验证）。
      try {
        // sidecar 位于 tauri-shell/sidecar/，dsh-desktop 是其祖父目录的兄弟。
      const bin = require.resolve('@deepseek-ai/dsh/lib/bin.js', {
        paths: [path.join(__dirname, '..', '..', 'dsh-desktop')],
      });
        return respond({ jsonrpc: '2.0', id, result: { found: true, bin } });
      } catch (e) {
        return respond({ jsonrpc: '2.0', id, result: { found: false, error: e.message } });
      }
    }
    respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  } catch (e) {
    respond({ jsonrpc: '2.0', id, error: { code: -32000, message: String((e && e.message) || e) } });
  }
});
rl.on('close', () => process.exit(0));
