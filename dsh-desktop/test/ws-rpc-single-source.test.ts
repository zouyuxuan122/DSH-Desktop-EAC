// WS JSON-RPC 回环客户端单源契约（批次 D：bridge.ts / recovery-center-preload.js
// 各自内联的 WS 客户端收编为一个文件 assets/ws-jsonrpc-client.js）。
// 防回归：
//   1. 单源文件必须存在且定义 window.__DSH_WS_RPC__ 工厂；
//   2. 两个桥胶水必须消费工厂，且不得再内联自己的 connect/queue 实现；
//   3. 壳层注入链（main.rs + stage 装配）必须让客户端先于桥胶水就位。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assetsDir = join(root, 'dsh-desktop', 'assets');

test('单源客户端存在且定义 __DSH_WS_RPC__ 工厂（connect/queue 只此一处）', () => {
  const src = readFileSync(join(assetsDir, 'ws-jsonrpc-client.js'), 'utf8');
  assert.match(src, /window\.__DSH_WS_RPC__\s*=/, '应定义 __DSH_WS_RPC__ 工厂');
  assert.match(src, /function createWsJsonRpc\(/, '应有工厂创建函数');
  assert.match(src, /function connect\(\)/, 'connect 应只存在于单源');
});

test('bridge.ts 消费单源工厂，不再内联 WS 客户端', () => {
  const bridge = readFileSync(join(root, 'tauri-shell', 'sidecar', 'bridge.ts'), 'utf8');
  assert.match(bridge, /__DSH_WS_RPC__/, 'bridge 应消费 __DSH_WS_RPC__');
  assert.doesNotMatch(bridge, /function connect\(\)/, 'bridge 不得再内联 connect');
  assert.doesNotMatch(bridge, /new WebSocket\(/, 'bridge 不得再直连 WebSocket');
});

test('recovery-center-preload.js 消费单源工厂，只做动作接线', () => {
  const preload = readFileSync(join(assetsDir, 'recovery-center-preload.js'), 'utf8');
  assert.match(preload, /__DSH_WS_RPC__/, 'rc preload 应消费 __DSH_WS_RPC__');
  assert.doesNotMatch(preload, /function connect\(\)/, 'rc preload 不得再内联 connect');
  assert.match(preload, /window\.rc\s*=/, 'window.rc 白名单动作面应保留');
});

test('壳层注入链保证客户端先于桥胶水（build.rs 拼装 + recovery 页拼接）', () => {
  const b = readFileSync(join(root, 'tauri-shell', 'build.rs'), 'utf8');
  assert.match(b, /ws-jsonrpc-client\.js/, 'build.rs 应读取单源客户端');
  assert.match(b, /bridge-bundle\.js/, 'build.rs 应产出 bridge-bundle.js');
  const main = readFileSync(join(root, 'tauri-shell', 'src', 'main.rs'), 'utf8');
  assert.match(main, /BRIDGE_JS: &str = include_str!\(concat!\(env!\("OUT_DIR"\), "\/bridge-bundle\.js"\)\)/,
    'main.rs 应以 include_str! 内嵌拼装产物');
  assert.ok(!/WS_RPC_JS|BRIDGE_INIT_JS/.test(main), 'main.rs 不应残留被替换的常量名');
  assert.match(main, /format!\("\{\}\\n\{\}", ws_rpc, preload\)/, '恢复中心窗应把单源拼进 preload 前');
});