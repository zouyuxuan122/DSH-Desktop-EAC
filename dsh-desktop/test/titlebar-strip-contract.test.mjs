// 回归：EAC 自绘标题栏（36px 玻璃条）必须向页面声明自身高度
// （<html data-dsh-title-bar-height>），否则 better-sidebar 的
// 自动避让不激活：面板 fixed top:0、折叠按钮 top:3px 全部被玻璃栏
// （z-index 2147483000）盖住 → 用户“看不到标签栏、无法折叠”（v3.0.0 反馈）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const preload = readFileSync(join(root, 'preload.js'), 'utf8');

test('preload declares its titlebar height on <html> for client plugins', () => {
  // BAR_HEIGHT 与声明的属性值必须同源（同一常量插值），不能硬编码两份
  const barHeight = Number(preload.match(/const BAR_HEIGHT = (\d+)/)?.[1]);
  assert.ok(barHeight > 0, 'BAR_HEIGHT must be defined');
  assert.match(
    preload,
    new RegExp(`setAttribute\\('data-dsh-title-bar-height', String\\(BAR_HEIGHT\\)\\)`),
    'injectChrome must set data-dsh-title-bar-height from BAR_HEIGHT (better-sidebar reads it once at mount to auto-shift its fixed panel/toggle cluster)',
  );
});

test('vendored better-sidebar honors the attribute (compat contract)', () => {
  const client = readFileSync(join(root, 'assets', 'plugins', 'dsh-better-sidebar', 'lib', 'client.js'), 'utf8');
  assert.match(client, /data-dsh-title-bar-height/, 'plugin must read the attribute');
  assert.match(client, /body\[data-dsh-title-bar-compat\] \.dxPSYW_panel\{padding-top:var\(--dsh-title-bar-strip/, 'plugin must pad its fixed panel when compat is on');
});
