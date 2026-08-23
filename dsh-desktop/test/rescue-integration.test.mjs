// TDD wiring tests: the rescue agent must actually be wired into the desktop
// shell. main.js is an Electron entry (untestable under node:test directly),
// so we pin the wiring points at the source level — each assertion corresponds
// to a required integration point of the crash-rescue system.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8');
const preloadSrc = readFileSync(join(ROOT, 'preload.js'), 'utf8');

test('main.js requires the rescue-agent module', () => {
  assert.ok(/require\('\.\/rescue-agent'\)/.test(mainSrc), "main.js must require('./rescue-agent')");
});

test('main.js wires the crash-loop counter: record on failure, clear on healthy boot', () => {
  assert.ok(/function recordBootFailureNow\(/.test(mainSrc), 'recordBootFailureNow() missing');
  assert.ok(/function clearRescueState\(/.test(mainSrc), 'clearRescueState() missing');
  assert.ok(/clearRescueState\(\)/.test(mainSrc), 'clearRescueState() must run on healthy boot');
  assert.ok(/recordBootFailureNow\(/.test(mainSrc), 'recordBootFailureNow() must run in handleBootFailure');
  assert.ok(/shouldEnterRescueNow\(/.test(mainSrc), 'crash-loop threshold must route to the rescue page');
});

test('main.js registers every rescue IPC endpoint', () => {
  for (const ch of ['rescue:state', 'rescue:confirm', 'rescue:diagnose', 'rescue:apply', 'rescue:retry', 'safe-mode:set']) {
    assert.ok(mainSrc.includes(`'${ch}'`), `IPC handler ${ch} missing`);
  }
});

test('main.js wires the one-click AI auto-repair IPC', () => {
  assert.ok(mainSrc.includes("'rescue:auto-repair'"), "IPC handler rescue:auto-repair missing");
  assert.ok(/rescueAgent\.runAutoRepair\(/.test(mainSrc), 'main.js must call rescueAgent.runAutoRepair()');
});

test('main.js executes edit-file and resync in the whitelist dispatcher', () => {
  assert.ok(/case 'edit-file'/.test(mainSrc), "rescueExecuteSuggestion edit-file case missing");
  assert.ok(/case 'resync'/.test(mainSrc), "rescueExecuteSuggestion resync case missing");
  assert.ok(/applyProfileEdit\(/.test(mainSrc), 'edit-file must go through applyProfileEdit()');
  assert.ok(/snapshot\('ai-edit-before'\)/.test(mainSrc), 'edit-file must snapshot before writing');
});

test('main.js offers 进入救援模式 from the boot-failure dialog', () => {
  assert.ok(mainSrc.includes("'进入救援模式'"), 'rescue-mode button missing from handleBootFailure');
  assert.ok(/function showRescuePage\(/.test(mainSrc), 'showRescuePage() missing');
});

test('main.js wires the shell-level safe mode (snapshot backup + core-only patch)', () => {
  assert.ok(/function safeModeSet\(/.test(mainSrc), 'safeModeSet() missing');
  assert.ok(/safeModePatch\(/.test(mainSrc), 'safeModePatch() must be applied by safeModeSet');
  assert.ok(/snapshot\('safe-mode-before'\)/.test(mainSrc), 'safe mode must back up via guard snapshot');
});

test('main.js executes rescue suggestions through the whitelist dispatcher', () => {
  assert.ok(/function rescueExecuteSuggestion\(/.test(mainSrc), 'rescueExecuteSuggestion() missing');
  assert.ok(/applySuggestion\(/.test(mainSrc), 'applySuggestion() must gate every rescue action');
});

test('preload exposes the rescue bridge', () => {
  assert.ok(preloadSrc.includes('rescue:'), 'preload rescue bridge missing');
  for (const ch of ['rescue:state', 'rescue:confirm', 'rescue:diagnose', 'rescue:apply', 'rescue:retry', 'safe-mode:set']) {
    assert.ok(preloadSrc.includes(`'${ch}'`), `preload bridge for ${ch} missing`);
  }
});

test('preload exposes the auto-repair bridge', () => {
  assert.ok(preloadSrc.includes("'rescue:auto-repair'"), 'preload auto-repair bridge missing');
  assert.ok(/autoRepair:/.test(preloadSrc), 'preload rescue.autoRepair() missing');
});

test('rescue page offers the one-click AI auto repair', () => {
  const page = join(ROOT, 'assets', 'recovery.html');
  const html = readFileSync(page, 'utf8');
  assert.ok(html.includes('AI 自动修复'), 'recovery.html must offer the AI auto-repair button');
  assert.ok(/btn-autorepair/.test(html), 'recovery.html btn-autorepair missing');
  assert.ok(/auto-progress/.test(html), 'recovery.html auto-repair progress area missing');
});

test('rescue page exists and references the rescue bridge', () => {
  const page = join(ROOT, 'assets', 'recovery.html');
  assert.ok(existsSync(page), 'assets/recovery.html missing');
  const html = readFileSync(page, 'utf8');
  assert.ok(html.includes('救援模式'), 'recovery.html must present the rescue mode');
  assert.ok(html.includes('bridge.rescue'), 'recovery.html must use the rescue bridge');
  assert.ok(html.includes('btn-safemode'), 'safe-mode button missing');
  assert.ok(html.includes('btn-diagnose'), 'AI diagnose button missing');
  assert.ok(html.includes('manifest'), 'send-manifest confirmation UI missing');
});