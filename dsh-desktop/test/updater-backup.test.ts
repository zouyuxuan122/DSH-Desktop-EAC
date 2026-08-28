// Tests for the V4.1 update-safety additions in updater.js:
//   - applyUpdate keeps the previous overlay as agent-previous instead of
//     dropping it, so a broken new version can be rolled back;
//   - confirmPreviousAgentHealthy() cleans the backup once the new version
//     boots healthy;
//   - previousAgentInfo() / rollbackToPrevious() power the boot-failure
//     dialog's "fall back to previous version" button.
//
// These are pure-filesystem helpers, so the tests build a fake userData dir
// in the OS temp folder (no npm involved).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { confirmPreviousAgentHealthy, previousAgentInfo, rollbackToPrevious } =
  await import(new URL('../updater.js', import.meta.url));

function makeCtx() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-backup-'));
  const logs = [];
  const ctx = {
    userDataDir,
    log: (tag, msg) => logs.push(`[${tag}] ${msg}`),
    nodeExe: () => '',
    npmCli: () => '',
  };
  return { ctx, logs };
}

function writeSettings(ctx, extra) {
  fs.writeFileSync(path.join(ctx.userDataDir, 'settings.json'),
    JSON.stringify({ ...extra }, null, 2) + '\n');
}

function makeFakePackage(dir, version) {
  const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), '// fake bin\n');
}

test('previousAgentInfo returns null without settings or directory', () => {
  const { ctx } = makeCtx();
  assert.equal(previousAgentInfo(ctx), null);
  writeSettings(ctx, { previousAgent: { version: '1.0.0' } });
  assert.equal(previousAgentInfo(ctx), null, 'settings alone must not suffice');
  fs.mkdirSync(path.join(ctx.userDataDir, 'agent-previous'), { recursive: true });
  assert.ok(previousAgentInfo(ctx), 'settings + directory must be reported');
});

test('confirmPreviousAgentHealthy clears the backup and the setting', () => {
  const { ctx } = makeCtx();
  makeFakePackage(path.join(ctx.userDataDir, 'agent'), '1.2.0');
  fs.mkdirSync(path.join(ctx.userDataDir, 'agent-previous'), { recursive: true });
  writeSettings(ctx, { previousAgent: { version: '1.1.0', dir: 'agent-previous' } });
  assert.equal(confirmPreviousAgentHealthy(ctx), true);
  assert.equal(fs.existsSync(path.join(ctx.userDataDir, 'agent-previous')), false, 'backup dir must be gone');
  const settings = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'settings.json'), 'utf8'));
  assert.equal(settings.previousAgent, null);
});

test('confirmPreviousAgentHealthy is a no-op without a previousAgent marker', () => {
  const { ctx } = makeCtx();
  assert.equal(confirmPreviousAgentHealthy(ctx), false);
});

test('rollbackToPrevious swaps the broken overlay back to the previous version', () => {
  const { ctx } = makeCtx();
  makeFakePackage(path.join(ctx.userDataDir, 'agent'), '1.2.0');       // broken new
  makeFakePackage(path.join(ctx.userDataDir, 'agent-previous'), '1.1.0'); // good old
  writeSettings(ctx, { previousAgent: { version: '1.1.0', dir: 'agent-previous' } });
  const restored = rollbackToPrevious(ctx);
  assert.equal(restored, '1.1.0');
  const overlayPkg = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'agent', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  assert.equal(overlayPkg.version, '1.1.0', 'overlay must now carry the old version');
  assert.equal(fs.existsSync(path.join(ctx.userDataDir, 'agent-previous')), false);
  const broken = fs.readdirSync(ctx.userDataDir).find((n) => n.startsWith('agent-broken-'));
  assert.ok(broken, 'broken copy must be kept for diagnosis');
  const settings = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'settings.json'), 'utf8'));
  assert.equal(settings.previousAgent, null);
});

test('rollbackToPrevious returns null when there is nothing to roll back to', () => {
  const { ctx } = makeCtx();
  makeFakePackage(path.join(ctx.userDataDir, 'agent'), '1.2.0');
  assert.equal(rollbackToPrevious(ctx), null);
});