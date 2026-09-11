// 回归：无边框主窗的窗口控制依赖 WS 桥。
//
// 桥端口在 19873 被占用时会回退到其他端口；如果真实 Web UI 导航后
// 仍注入裸 BRIDGE_JS，页面侧客户端会退回固定 19873，导致拖动、最小化、
// 最大化和关闭按钮全部失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = readFileSync(join(root, 'tauri-shell', 'src', 'main.rs'), 'utf8');

test('壳层初始化脚本绑定实际桥端口', () => {
  assert.match(main, /fn bridge_init_script\(\) -> String/, '应有统一初始化脚本生成器');
  assert.match(
    main,
    /fn bridge_init_script\(\)[\s\S]*?ws_port\(\)[\s\S]*?BRIDGE_JS/,
    '初始化脚本必须把实际 ws_port 注入到单源 bridge 前',
  );
  assert.doesNotMatch(
    main,
    /\.initialization_script\(BRIDGE_JS\)/,
    'WebView 不得直接注入不带实际端口的裸 BRIDGE_JS',
  );
  assert.match(
    main,
    /\.initialization_script\(&bridge_init_script\(\)\)/,
    '主窗必须使用带实际端口的初始化脚本',
  );
});

test('浮窗初始化脚本也绑定实际桥端口', () => {
  assert.match(
    main,
    /window\.__DSH_FLOAT__[\s\S]*?bridge_init_script\(\)/,
    '浮窗不得绕过实际桥端口注入',
  );
});
