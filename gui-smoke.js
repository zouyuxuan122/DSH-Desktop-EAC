'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repo = __dirname;
const exe = process.env.DSH_SMOKE_EXE || path.join(repo, 'tauri-app', 'target', 'release', 'DSHEAC AIO.exe');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aio-gui-'));
const home = path.join(work, 'home');
const userData = path.join(work, 'user-data');
const screenshot = process.env.DSH_SMOKE_SCREENSHOT || path.join(repo, 'docs', 'aio-v1-smoke.png');
const cdpPort = Number(process.env.DSH_SMOKE_CDP_PORT || 9337);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

function cdp(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP connection failed')); });
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  };
  return {
    ready,
    call(method, params = {}) {
      return ready.then(() => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }));
    },
    async eval(expression) {
      const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'page evaluation failed');
      return result.result.value;
    },
    close() { try { ws.close(); } catch {} },
  };
}

(async () => {
  if (!fs.existsSync(exe)) throw new Error(`AIO smoke executable is missing: ${exe}`);
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_DESKTOP_USERDATA: userData,
      DSH_DESKTOP_SKIP_PLUGIN_UPDATE: '1',
      DSH_DESKTOP_TEST_NO_SHORTCUTS: '1',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
    stdio: 'ignore',
  });
  let client;
  try {
    let target;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`AIO exited early: ${child.exitCode}`);
      try {
        const list = await jsonGet(`http://127.0.0.1:${cdpPort}/json`);
        target = list.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url));
      } catch {}
      if (target) break;
      await sleep(500);
    }
    if (!target) throw new Error('AIO WebView target was not found');
    client = cdp(target.webSocketDebuggerUrl);
    await client.ready;
    const info = await client.eval('window.dshDesktop.getInfo()');
    if (!info || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(info.appVersion)) || info.desktopShell !== 'tauri') {
      throw new Error(`unexpected getInfo: ${JSON.stringify(info)}`);
    }
    if (!(await client.eval('!!document.getElementById("__dsh_desktop_chrome__")'))) throw new Error('AIO chrome bar is missing');
    const plugins = await client.eval('window.dshDesktop.pluginManager.list()');
    if (!Array.isArray(plugins) || plugins.length < 2) throw new Error('plugin manager bridge is not ready');
    const recovery = await client.eval('window.dshDesktop.recovery.getState()');
    if (!recovery || recovery.appVersion !== info.appVersion) throw new Error('recovery bridge is not ready');
    await client.call('Page.enable');
    const shot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
    console.log(`[gui-smoke] screenshot: ${screenshot}`);
  } finally {
    if (client) client.close();
    if (child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('[gui-smoke] PASS');
})().catch((error) => {
  console.error('[gui-smoke] FAIL:', error.stack || error.message);
  process.exit(1);
});
