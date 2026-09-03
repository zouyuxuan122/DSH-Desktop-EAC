import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'sanitize-public-seed.mjs');

function makeSeed(base, settings) {
  const seed = path.join(base, 'profile-seed');
  const modules = path.join(seed, 'profiles', 'web-desktop', 'node_modules');
  fs.mkdirSync(path.join(modules, '.pnpm'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'settings.yaml'), settings, 'utf8');
  fs.writeFileSync(path.join(modules, '.modules.yaml'), 'storeDir: H:/CODEX/pnpm/store\n', 'utf8');
  fs.writeFileSync(path.join(modules, '.pnpm-workspace-state-v1.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(modules, '.pnpm', 'lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  return { seed, modules };
}

test('seed sanitizer targets DSH_PROFILE_SEED_DIR and preserves CRLF', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aio-seed-'));
  try {
    const settings = 'status-rotator:\r\n  enabled: true\r\nwebui-modules:\r\n  rewind: false\r\nprivate-key:\r\n  value: remove-me\r\n';
    const { seed, modules } = makeSeed(temp, settings);
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, DSH_PROFILE_SEED_DIR: seed },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sanitized = fs.readFileSync(path.join(seed, 'settings.yaml'), 'utf8');
    assert.ok(sanitized.includes('\r\n'));
    assert.doesNotMatch(sanitized, /private-key/);
    assert.ok(!fs.existsSync(path.join(modules, '.modules.yaml')));
    assert.ok(!fs.existsSync(path.join(modules, '.pnpm-workspace-state-v1.json')));
    assert.ok(!fs.existsSync(path.join(modules, '.pnpm', 'lock.yaml')));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('seed sanitizer rejects machine-local paths in the selected external seed', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aio-seed-'));
  try {
    const { seed } = makeSeed(temp, 'status-rotator:\n  enabled: true\nwebui-modules:\n  rewind: false\n');
    fs.writeFileSync(path.join(seed, 'leak.json'), '{"path":"C:/Users/32621/private"}\n', 'utf8');
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, DSH_PROFILE_SEED_DIR: seed },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /machine-local seed paths found/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
