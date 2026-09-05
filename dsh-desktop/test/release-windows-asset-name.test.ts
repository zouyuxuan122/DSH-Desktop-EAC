import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(join(root, '.github', 'workflows', 'release-tauri.yml'), 'utf8');

test('Windows release publishes the legacy-updater-compatible Setup-x64 name', () => {
  assert.match(workflow, /Deepseek-Harness-EAC-\$version-Setup-x64\.exe/);
  assert.match(workflow, /bundle\/nsis\/Deepseek-Harness-EAC-\*-Setup-x64\.exe/);
  assert.match(workflow, /SHA256SUMS-windows-x64\.txt/);
  assert.doesNotMatch(workflow, /^\s+tauri-shell\/target\/release\/bundle\/nsis\/\*\.exe\s*$/m);
});
