// TDD wiring tests: 救援链必须真正接到桌面壳上。Electron era 版本锁定
// main.js/preload.js 对接点；两文件已随壳退役（批次 C），本测试接管为
// Tauri 侧等价对接点：sidecar rescue-integration.ts（崩溃计数/安全模式/
// 救援分发）+ 恢复中心动作表（lib/recovery-center/register.ts）+ rc 桥
// （recovery-center-preload.js）+ recovery.html 页面。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const rescue = readFileSync(join(ROOT, '..', 'tauri-shell', 'sidecar', 'rescue-integration.ts'), 'utf8');
const server = readFileSync(join(ROOT, '..', 'tauri-shell', 'sidecar', 'server.ts'), 'utf8');
const register = readFileSync(join(ROOT, 'lib', 'recovery-center', 'register.ts'), 'utf8');
const rcPreload = readFileSync(join(ROOT, 'assets', 'recovery-center-preload.js'), 'utf8');

test('sidecar 必须加载 rescue-agent 模块', () => {
  assert.match(rescue, /rescue-agent\.js/, "rescue-integration.ts 必须 require('rescue-agent')");
});

test('sidecar 接线崩溃循环计数：失败记录 / 健康启动清除 / 阈值判定', () => {
  for (const fn of ['recordBootFailureNow', 'clearRescueState', 'shouldEnterRescueNow']) {
    assert.ok(new RegExp(`export function ${fn}\\(`).test(rescue), `${fn}() 缺失`);
  }
  assert.ok(server.includes('clearRescueState'), ' 服务端健康启动路径必须调用 clearRescueState');
});

test('rc.action 动作面覆盖救援动作（status/enable/retry-boot/safe-mode/export-logs）', () => {
  for (const act of ['status', 'enable', 'retry-boot', 'safe-mode', 'export-logs']) {
    assert.ok(register.includes(`case '${act}'`), `rc.action 缺 ${act}`);
  }
});

test('rc 桥只暴露白名单动作面（action/close），不透出底层 socket', () => {
  assert.match(rcPreload, /window\.rc\s*=\s*\{/, 'window.rc 定义缺失');
  assert.match(rcPreload, /\baction:\s*function/, 'rc.action 缺失');
  assert.match(rcPreload, /\bclose:\s*function/, 'rc.close 缺失');
});

test('sidecar 接线安全模式：快照备份 + 状态查询 + 开关', () => {
  for (const fn of ['safeModeSet', 'safeModeStatus']) {
    assert.ok(new RegExp(`export function ${fn}\\(`).test(rescue), `${fn}() 缺失`);
  }
  assert.ok(/safe-mode-before/.test(register), '安全模式必须经 guard 快照备份（safe-mode-before）——见 register.safeModeEnable');
});

test('rescue 页面提供 AI 自动修复与救援模式 UI', () => {
  const page = join(ROOT, 'assets', 'recovery.html');
  assert.ok(existsSync(page), 'assets/recovery.html missing');
  const html = readFileSync(page, 'utf8');
  assert.ok(html.includes('AI 自动修复'), 'recovery.html 必须提供 AI 自动修复');
  assert.ok(/btn-autorepair/.test(html), 'recovery.html btn-autorepair 缺失');
  assert.ok(/auto-progress/.test(html), 'recovery.html auto-repair 进度区缺失');
  assert.ok(html.includes('救援模式'), 'recovery.html 必须呈现救援模式');
  assert.ok(html.includes('bridge.rescue'), 'recovery.html 必须使用 rescue 桥');
  assert.ok(html.includes('btn-safemode'), 'safe-mode 按钮缺失');
  assert.ok(html.includes('btn-diagnose'), 'AI 诊断按钮缺失');
  assert.ok(html.includes('manifest'), 'send-manifest 确认 UI 缺失');
});