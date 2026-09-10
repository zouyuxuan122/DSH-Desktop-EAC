import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDesktopCore } = require('../desktop-core.js');

test('safe-mode marker prevents companion rows from being restored until it is cleared', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-safe-mode-sync-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const appRoot = join(temp, 'app');
  const home = join(temp, 'home');
  const profile = join(home, 'profiles', 'web-desktop');
  mkdirSync(join(appRoot, 'assets', 'plugins', 'dsh-balance'), { recursive: true });
  writeFileSync(join(appRoot, 'assets', 'plugins', 'dsh-balance', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-balance', version: '0.1.0' }));
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, '.dsh-safe-mode.json'), JSON.stringify({ active: true }) + '\n');

  const core = createDesktopCore({
    appRoot,
    userDataDir: join(temp, 'userdata'),
    logsDir: join(temp, 'logs'),
    dshHome: home,
    nodeExe: () => process.execPath,
    npmCli: () => '',
  });

  core.syncCompanionPlugins();
  const patch = join(profile, 'cordis.patch.yml');
  assert.doesNotMatch(readFileSync(patch, 'utf8'), /id: balance/, 'safe mode must not restore companion rows');

  rmSync(join(profile, '.dsh-safe-mode.json'));
  core.syncCompanionPlugins();
  assert.match(readFileSync(patch, 'utf8'), /id: balance/, 'clearing safe mode must allow normal companion sync');
});
