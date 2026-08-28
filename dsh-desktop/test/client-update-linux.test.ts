import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:http';
import { init as initRuntimePaths } from '../lib/desktop/runtime-paths.js';
import { init as initProfile } from '../lib/desktop/profile.js';
import { init as initClientUpdate, offerPendingClientUpdate, runClientUpdateFlow } from '../lib/desktop/client-update.js';

test('Linux client update hands off to the release page without downloading or applying', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-linux-update-'));
  const requests: string[] = [];
  const releasePage = 'https://example.invalid/releases/v9.0.0';
  const server = createServer((req, res) => {
    requests.push(req.url || '');
    if (req.url === '/releases') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{
        tag_name: 'v9.0.0',
        html_url: releasePage,
        assets: [{
          name: 'Deepseek-Harness-EAC_9.0.0_amd64.AppImage',
          browser_download_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/asset.AppImage`,
          size: 80 * 1024 * 1024,
        }],
      }]));
      return;
    }
    res.writeHead(500);
    res.end('asset download must not be requested');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.DSH_DESKTOP_RELEASE_API = `http://127.0.0.1:${(server.address() as { port: number }).port}/releases`;

  const opened: string[] = [];
  let updateWindowCount = 0;
  let prepareQuitCount = 0;
  let exitCount = 0;
  const log = (): void => {};
  initRuntimePaths({ log, getUserDataDir: () => tmp, platform: 'linux' });
  initProfile({ log, getDshHome: () => path.join(tmp, '.dsh') });
  initClientUpdate({
    log,
    showBox: async () => ({ response: 0 }),
    isQuitting: () => false,
    getAppVersion: () => '1.0.0',
    getUserDataDir: () => tmp,
    getDshHome: () => path.join(tmp, '.dsh'),
    getPlatform: () => 'linux',
    openExternal: async (url) => { opened.push(url); return true; },
    showUpdateWindow: () => { updateWindowCount += 1; return null; },
    makeUpdateProgressPusher: () => ({ client: () => {}, agent: () => {}, force: () => {} }),
    prepareQuitForClientUpdate: async () => { prepareQuitCount += 1; },
    exitProcess: () => { exitCount += 1; },
    getExecDir: () => tmp,
  });

  try {
    await runClientUpdateFlow(true);
    assert.deepEqual(opened, [releasePage]);
    assert.deepEqual(requests, ['/releases']);
    assert.equal(updateWindowCount, 0);
    assert.equal(prepareQuitCount, 0);
    assert.equal(exitCount, 0);
  } finally {
    delete process.env.DSH_DESKTOP_RELEASE_API;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Linux ignores a pending Windows self-update instead of offering to apply it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-linux-pending-update-'));
  const pending = path.join(tmp, 'updates', 'setup.exe');
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, 'not executed');
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
    pendingClientUpdate: { version: '9.0.0', path: pending, source: 'Windows' },
  }));

  let promptCount = 0;
  let prepareQuitCount = 0;
  const log = (): void => {};
  initRuntimePaths({ log, getUserDataDir: () => tmp, platform: 'linux' });
  initProfile({ log, getDshHome: () => path.join(tmp, '.dsh') });
  initClientUpdate({
    log,
    showBox: async () => { promptCount += 1; return { response: 1 }; },
    isQuitting: () => false,
    getAppVersion: () => '1.0.0',
    getUserDataDir: () => tmp,
    getDshHome: () => path.join(tmp, '.dsh'),
    getPlatform: () => 'linux',
    openExternal: async () => true,
    showUpdateWindow: () => null,
    makeUpdateProgressPusher: () => ({ client: () => {}, agent: () => {}, force: () => {} }),
    prepareQuitForClientUpdate: async () => { prepareQuitCount += 1; },
    exitProcess: () => {},
    getExecDir: () => tmp,
  });

  try {
    offerPendingClientUpdate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(promptCount, 0);
    assert.equal(prepareQuitCount, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
