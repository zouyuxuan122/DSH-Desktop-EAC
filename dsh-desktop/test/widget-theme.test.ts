// V4 余额/高峰提醒样式（font-custom widget theming）回归测试。
//
// 机制：设置 → 外观 · 字体与颜色 新增「余额 / 高峰提醒样式」分组；配置经
// CSS 变量下发 —— --eac-widget-fg（文字颜色）/ --eac-widget-glow（流光
// 色）+ body[data-eac-widget-glow="1"]（动画门控）。消费方：
//   · dsh-balance 的 .dsh-balance-dock（变量缺省回退原主题色）
//   · dsh-offpeak 的 .dspg_title（font-custom 注入覆盖规则）
// 预览弹窗复用真实样式类，所见即所得。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fontCustom = readFileSync(join(root, 'assets', 'plugins', 'dsh-font-custom', 'lib', 'client.js'), 'utf8');
const balance = readFileSync(join(root, 'assets', 'plugins', 'dsh-balance', 'lib', 'client.js'), 'utf8');

test('dsh-balance 徽章文字颜色消费 --eac-widget-fg（缺省回退原主题色）', () => {
  const m = balance.match(/\.dsh-balance-dock\{[^}]*\}/);
  assert.ok(m, '余额徽章样式规则应存在');
  assert.match(m[0], /color:var\(--eac-widget-fg,var\(--dsw-alias-label-tertiary\)\)/,
    '徽章颜色必须是 var(--eac-widget-fg, 原主题色) —— 未自定义时零视觉变化');
});

test('font-custom 默认配置包含 widget 样式三项', () => {
  assert.match(fontCustom, /widgetColor:\s*""/);
  assert.match(fontCustom, /widgetGlow:\s*false/);
  assert.match(fontCustom, /widgetGlowColor:\s*""/);
});

test('buildCss 下发变量与流光动画（门控在 body 属性上）', () => {
  assert.match(fontCustom, /--eac-widget-fg:/, '应输出 --eac-widget-fg 变量');
  assert.match(fontCustom, /--eac-widget-glow:/, '应输出 --eac-widget-glow 变量');
  assert.match(fontCustom, /@keyframes eacWidgetSweep/, '流光动画 keyframes 应存在');
  // 门控选择器：余额徽章背景扫光 + OffPeak 标题文字流光。
  assert.match(fontCustom, /body\[data-eac-widget-glow=\\"1\\"\] \.dsh-balance-dock/);
  assert.match(fontCustom, /body\[data-eac-widget-glow=\\"1\\"\] \.dspg_title/);
});

test('applyConfig 用 body 属性门控流光（开启/关闭都生效）', () => {
  assert.match(fontCustom, /setAttribute\("data-eac-widget-glow", "1"\)/);
  assert.match(fontCustom, /removeAttribute\("data-eac-widget-glow"\)/);
});

test('文字颜色对 OffPeak 标题的覆盖带原色回退', () => {
  assert.match(fontCustom, /\.dspg_title,\.__fc_wmock_title\{color:var\(--eac-widget-fg,#e6a23c\)!important\}/);
});

test('预览弹窗复用真实样式类（.dsh-balance-dock / .dspg_modal），所见即所得', () => {
  assert.match(fontCustom, /function widgetPreviewModal/);
  assert.match(fontCustom, /className: "dsh-balance-dock"/);
  assert.match(fontCustom, /className: "dspg_modal"/);
  assert.match(fontCustom, /__fc_wmock_title dspg_title/);
  // 预览覆盖层必须足够高的 z-index 且可关闭。
  assert.match(fontCustom, /__fc_wmock_overlay\{position:fixed;inset:0;z-index:2147483100/);
});

test('配置安全：widget 颜色走 safeColor 白名单（防 CSS 注入）', () => {
  assert.match(fontCustom, /widgetColor: safeColor\(c\.widgetColor\)/);
  assert.match(fontCustom, /widgetGlowColor: safeColor\(c\.widgetGlowColor\)/);
  assert.match(fontCustom, /widgetGlow: c\.widgetGlow === true/);
});
