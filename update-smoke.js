'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repo = __dirname;
const packageJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(repo, 'tauri-app', 'tauri.conf.json'), 'utf8'));
const ipc = fs.readFileSync(path.join(repo, 'tauri-app', 'src', 'ipc.rs'), 'utf8');
const shell = fs.readFileSync(path.join(repo, 'tauri-app', 'frontend', 'chrome.ts'), 'utf8');

assert.equal(packageJson.version, '1.1.0');
assert.equal(tauriConfig.version, '1.1.0');
assert.ok(!JSON.stringify(packageJson.scripts).includes('client-update'), 'AIO must not expose client auto-update scripts');
assert.ok(!ipc.includes('client_update'), 'AIO native IPC must not expose a client updater');
assert.ok(!shell.includes('clientUpdater'), 'AIO web bridge must not expose a client updater');

(async () => {
  const updater = await import(pathToFileURL(path.join(repo, 'sidecar', 'dist', 'lib', 'plugin-updater.js')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aio-update-'));
  try {
    const ctx = {
      userDataDir: dir,
      nodeExe: () => process.execPath,
      npmCli: () => '',
      log: () => {},
    };
    assert.equal(updater.isAutoUpdateEnabled(ctx), false, 'plugin auto-update must default to disabled');
    console.log('[update-smoke] client updater absent; plugin auto-update defaults to disabled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('[update-smoke] PASS');
})().catch((error) => {
  console.error('[update-smoke] FAIL:', error.stack || error.message);
  process.exit(1);
});
