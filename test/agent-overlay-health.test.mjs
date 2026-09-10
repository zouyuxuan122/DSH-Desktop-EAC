import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync as readText } from 'node:fs';

const require = createRequire(import.meta.url);
const { createDesktopCore } = require('../desktop-core.js');
const KERNEL_VERSION = '0.1.5-rc.2';

function packageAt(root, relative, version, source) {
  const dir = join(root, relative, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  writeFileSync(join(dir, 'lib', 'bin.js'), source);
  return join(dir, 'lib', 'bin.js');
}

function makeCore(t, overlaySource) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-overlay-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appRoot = join(root, 'app');
  const userDataDir = join(root, 'userdata');
  const home = join(root, 'home');
  const bundled = packageAt(appRoot, '', KERNEL_VERSION, "console.log('bundled');\n");
  const overlay = packageAt(userDataDir, 'agent', KERNEL_VERSION, overlaySource);
  const profilePackage = join(home, 'profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(profilePackage, { recursive: true });
  writeFileSync(join(profilePackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: KERNEL_VERSION }));
  writeFileSync(join(home, 'profiles', 'web-desktop', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web-desktop',
    dependencies: { '@deepseek-ai/dsh': KERNEL_VERSION },
  }));
  const core = createDesktopCore({
    appRoot,
    userDataDir,
    logsDir: join(root, 'logs'),
    dshHome: home,
    nodeExe: () => process.execPath,
    npmCli: () => '',
  });
  return { core, userDataDir, bundled, overlay };
}

test('a healthy agent overlay is verified before it can replace the bundled kernel', async (t) => {
  const { core, userDataDir, bundled, overlay } = makeCore(t, "console.log('healthy');\n");
  mkdirSync(join(userDataDir, 'agent-previous'), { recursive: true });
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ previousAgent: { version: '0.1.2', dir: 'agent-previous' } }));
  assert.equal(core.dshBin(), bundled, 'unverified overlay must not be selected');
  assert.deepEqual(await core.ensureHealthyOverlay(), { source: 'overlay' });
  assert.equal(core.dshBin(), overlay);
  const marker = JSON.parse(readFileSync(join(userDataDir, 'agent', '.aio-agent-health.json'), 'utf8'));
  assert.equal(marker.version, KERNEL_VERSION);
  assert.equal(core.confirmHealthyOverlay(), true, 'only a verified overlay may confirm the previous backup');
  assert.equal(readdirSync(userDataDir).includes('agent-previous'), false);
});

test('a broken agent overlay is quarantined and startup falls back to the bundled kernel', async (t) => {
  const { core, userDataDir, bundled } = makeCore(t, "require('@deepseek-ai/not-installed');\n");
  mkdirSync(join(userDataDir, 'agent-previous'), { recursive: true });
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ previousAgent: { version: '0.1.2', dir: 'agent-previous' } }));
  const result = await core.ensureHealthyOverlay();
  assert.equal(result.source, 'bundled');
  assert.equal(core.dshBin(), bundled);
  assert.equal(readdirSync(userDataDir).some((name) => name.startsWith('agent-broken-')), true);
  assert.equal(core.confirmHealthyOverlay(), false, 'bundled fallback must retain the previous overlay backup');
  assert.equal(readdirSync(userDataDir).includes('agent-previous'), true);
});

test('Rust clears the previous overlay only through the sidecar health gate after HTTP readiness', () => {
  const boot = readText(join(import.meta.dirname, '..', 'tauri-app', 'src', 'boot.rs'), 'utf8');
  assert.match(boot, /state\.sidecar\(\).*?updater\.confirmHealthy/s);
});
