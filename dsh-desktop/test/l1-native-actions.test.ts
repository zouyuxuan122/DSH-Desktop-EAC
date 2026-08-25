import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const sidecar = readFileSync(join(root, 'tauri-shell', 'sidecar', 'server.ts'), 'utf8');
const shell = readFileSync(join(root, 'tauri-shell', 'src', 'main.rs'), 'utf8');

test('Tauri sidecar authorizes files but delegates native actions to L1', () => {
  assert.doesNotMatch(sidecar, /desktopPlatform\.(?:openPath|writeClipboardText)/);
  assert.match(sidecar, /'files\.authorize-open'/);
  assert.doesNotMatch(sidecar, /'clipboard\.write-text'\s*:/);
  assert.match(sidecar, /notify\('shell\.open-external'/);
  assert.match(sidecar, /notify\('shell\.system-notification'/);
});

test('Rust L1 owns file-open, external URL and clipboard methods', () => {
  assert.match(shell, /"files\.open"\s*=>/);
  assert.match(shell, /"clipboard\.write-text"\s*=>/);
  assert.match(shell, /fn open_native_target\(/);
  assert.match(shell, /async fn write_clipboard_text\(/);
  assert.match(shell, /"shell\.system-notification"\s*=>/);
  assert.match(shell, /fn show_system_notification\(/);
});
