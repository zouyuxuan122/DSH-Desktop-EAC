'use strict';
// P2 GUI 冒烟（一次性）：真实启动 Tauri 壳 → CDP 断言桥与 chrome → 浮窗
// （硬门槛① per-webview data_directory）→ 菜单退出 → 零孤儿进程。
// WebView2 经 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 开 CDP 端口。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const tmpHome = path.join(repo, 'tmp-p2boot', 'gui-home');
fs.mkdirSync(tmpHome, { recursive: true });
const CDP_PORT = 9333;
const EXE = process.env.DSH_SMOKE_EXE || path.join(repo, 'tauri-shell', 'target', 'debug', 'dsh-eac-shell.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGetJson = (url) => new Promise((resolve, reject) => {
  http.get(url, { timeout: 4000 }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// --- 最小 CDP 客户端（Node ≥21 内置 WebSocket） ---------------------------
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(new Error('ws error')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
    }
  };
  return {
    ready,
    call(method, params) {
      return ready.then(() => new Promise((res, rej) => {
        const id = ++seq; pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      }));
    },
    async evalJs(expr) {
      const r = await this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page js: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function waitForTarget(matchFn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const hit = list.find(matchFn);
      if (hit) return hit;
    } catch { /* 端口未就绪 */ }
    await sleep(700);
  }
  throw new Error('target not found in time');
}

async function listOrphans() {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'tmp-p2boot' } | Select-Object -ExpandProperty ProcessId`],
      { windowsHide: true });
    let out = ''; p.stdout.on('data', (d) => (out += d));
    p.on('exit', () => resolve(out.trim()));
  });
}

(async () => {
  console.log('[gui-smoke] launching shell with DSH_HOME=' + tmpHome);
  const shell = spawn(EXE, [], {
    env: {
      ...process.env,
      DSH_HOME: tmpHome,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let shellOut = '';
  shell.stdout.on('data', (d) => { shellOut += d.toString(); process.stdout.write('[shell] ' + d); });
  shell.stderr.on('data', (d) => { shellOut += d.toString(); process.stderr.write('[shell-err] ' + d); });

  try {
    // 1) 主窗 target 出现且导航到真实 Web UI（非 /loading）
    const main = await waitForTarget((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(t.url) && !t.url.includes(`:${CDP_PORT}`), 180000);
    const c = cdp(main.webSocketDebuggerUrl);
    await c.ready;
    check('主窗导航到真实 Web UI', true, main.url);

    // 2) 桥 + 玻璃栏（页内轮询等 DOMContentLoaded —— 导航提交即可见 target）
    const hasBridge = await c.evalJs(`new Promise(function(res) {
      var t = setTimeout(function() { res(false); }, 15000);
      (function chk() {
        if (typeof window.dshDesktop === 'object' && typeof window.dshDesktop.rescue.getState === 'function') { clearTimeout(t); res(true); }
        else setTimeout(chk, 200);
      })();
    })`);
    check('window.dshDesktop 全量桥注入', hasBridge);
    const chromeReady = await c.evalJs(`new Promise(function(res) {
      var t = setTimeout(function() { res(null); }, 15000);
      (function chk() {
        var bar = document.getElementById('__dsh_desktop_chrome__');
        if (bar) { clearTimeout(t); res(document.documentElement.getAttribute('data-dsh-title-bar-height')); }
        else setTimeout(chk, 200);
      })();
    })`);
    check('36px 玻璃栏注入', chromeReady === '36', 'height=' + chromeReady);

    // 3) getInfo（sidecar chrome.init 真实数据；版本动态比对，勿硬编码）
    const info = await c.evalJs('window.dshDesktop.getInfo()');
    const wantVer = JSON.parse(fs.readFileSync(path.join(repo, 'dsh-desktop', 'package.json'), 'utf8')).version;
    check('getInfo 返回真实数据', !!(info && info.appVersion === wantVer && info.agentVersion), JSON.stringify({ v: info && info.appVersion, agent: info && info.agentVersion }));

    // 4) 窗口控制（Rust 拦截路径）
    const max1 = await c.evalJs('window.dshDesktop.windowControls.isMaximized()');
    await c.evalJs('window.dshDesktop.windowControls.toggleMaximize()');
    await sleep(900);
    const max2 = await c.evalJs('window.dshDesktop.windowControls.isMaximized()');
    check('窗口控制（最大化往返）', max1 === false && max2 === true, `${max1}→${max2}`);
    await c.evalJs('window.dshDesktop.windowControls.toggleMaximize()');
    await sleep(600);

    // 5) 心跳在飞（WS send 帧被壳层消费，无回复不算错——检查 WS 连接本身）
    const wsOpen = await c.evalJs('!!window.dshDesktop._call');
    check('桥 WS 通道可用', wsOpen);

    // 5b) P3：余额推送（refreshBalance → dsh.balance 通知 → window 事件）
    const balPush = await c.evalJs(`(async function() {
      var p = new Promise(function(resolve) {
        var t = setTimeout(function() { resolve(null); }, 20000);
        window.addEventListener('dsh-balance-changed', function(e) { clearTimeout(t); resolve(e.detail); });
      });
      await window.dshDesktop.refreshBalance();
      return await p;
    })()`);
    check('余额推送 dsh-balance-changed（15min 轮询已启动）', !!(balPush && balPush.prices), balPush ? 'period=' + (balPush.pricing && balPush.pricing.period) : 'null');

    // 5c) P3：菜单开关（真实 settings 写 + 状态回显）
    const toggled = await c.evalJs('window.dshDesktop.menu.action("toggle-notify")');
    const toggled2 = await c.evalJs('window.dshDesktop.menu.action("toggle-notify")');
    check('菜单开关往返（settings 持久化）', !!(toggled && typeof toggled.notifyOnTurnEnd === 'boolean' && toggled2), JSON.stringify(toggled));

    // 5d) P3：剪贴板（PowerShell Set-Clipboard）
    const clip = await c.evalJs('window.dshDesktop.copyText("dsh-eac-smoke-42")');
    check('copyText（PowerShell 剪贴板）', !!(clip && clip.ok), JSON.stringify(clip));

    // 5e) P3：插件管理列表（pluginManagerCollect）
    const plist = await c.evalJs('window.dshDesktop.pluginManager.list()');
    check('pluginManager.list（配套插件清单）', !!(plist && Array.isArray(plist.list) && plist.list.length >= 20), 'count=' + (plist && plist.list && plist.list.length));

    // 5f) P3：救援链（硬门槛②）—— rescue.getState / guard status
    const rs = await c.evalJs('window.dshDesktop.rescue.getState()');
    check('rescue.getState（救援链就绪）', !!(rs && rs.profile === 'web-desktop' && typeof rs.serverAlive === 'boolean' && rs.threshold >= 1), JSON.stringify({ profile: rs && rs.profile, alive: rs && rs.serverAlive, thr: rs && rs.threshold }));
    const gs = await c.evalJs('window.dshDesktop.guard.action("status")');
    check('guard.action status（保护中心）', !!(gs && gs.ok && Array.isArray(gs.snapshots)), 'snaps=' + (gs && gs.snapshots && gs.snapshots.length));

    // 6) 浮窗（硬门槛①：第二 WebviewWindow + per-webview data_directory）。
    //    独立 data_directory = 独立浏览器进程，不能共用 CDP 端口 —— 用生产信号
    //    路径验证：浮窗桥就绪后经 WS 广播 float.ready，主窗 _onNotify 可观测。
    const readyPromise = c.evalJs(`new Promise(function(resolve, reject) {
      var t = setTimeout(function() { reject(new Error('float.ready 15s 超时')); }, 15000);
      window.dshDesktop._onNotify(function(m, p) {
        if (m === 'float.ready') { clearTimeout(t); resolve(p); }
      });
      window.dshDesktop.floatWindow.open('smoke-session-1').catch(reject);
    })`);
    const floatReady = await readyPromise;
    check('浮窗独立创建并桥就绪（per-webview 隔离）', !!(floatReady && /smoke-session-1/.test(String(floatReady.win))), JSON.stringify(floatReady));
    // 浮窗标题栏模式：主窗不该变成浮窗条
    const mainBarStill = await c.evalJs('!!document.getElementById("__dsh_desktop_chrome__")');
    check('主窗仍为 36px 完整栏（浮窗模式未串扰）', mainBarStill);

    // 7) 退出策略（exitAction=ask 默认）：win.close → 退出确认 overlay 注入主窗。
    //    overlay 方案不新建窗口、不替换页面（旧 /exit 导航已移除）——
    //    无导航则 CDP 会话不销毁，同一 c 会话可观察与操作。
    const waitOverlay = (present) => c.evalJs(`new Promise(function(res) {
      var t = setTimeout(function() { res(false); }, 12000);
      (function chk() {
        if ((${present} ? !!document.getElementById('dsh-exit-overlay') : !document.getElementById('dsh-exit-overlay'))) { clearTimeout(t); res(true); }
        else setTimeout(chk, 250);
      })();
    })`).catch(() => false);
    await c.evalJs('window.dshDesktop.windowControls.close()');
    await sleep(1500);
    const overlayShown = await waitOverlay(true);
    check('win.close → 退出确认 overlay（ask 策略，不替换页面）', overlayShown === true);
    if (overlayShown) {
      // 取消 → overlay 消失，主窗与 Web UI 原样保留
      await c.evalJs(`document.querySelector('#dsh-exit-overlay [data-v=cancel]').click(); 0`).catch(() => {});
      const dismissed = await waitOverlay(false);
      check('取消 → overlay 消失且 Web UI 保留', dismissed === true);
      // 再触发一次，选「退出应用」→ win.close-force → 优雅退出链
      await c.evalJs('window.dshDesktop.windowControls.close()');
      await sleep(1500);
      const overlay2 = await waitOverlay(true);
      check('再次 win.close → overlay 重现', overlay2 === true);
      await c.evalJs(`document.querySelector('#dsh-exit-overlay [data-v=quit]').click(); 0`).catch(() => {});
    }

    // 7b) 退出应用（overlay quit 按钮 → win.close-force → app.exit → 优雅退出链）
    const exited = await new Promise((res) => {
      const t0 = Date.now();
      const tick = () => (shell.exitCode !== null ? res(true) : Date.now() - t0 > 20000 ? res(false) : setTimeout(tick, 500));
      tick();
    });
    check('退出应用（进程收口）', exited, 'exitCode=' + shell.exitCode);

    // 8) 零孤儿：DSH_HOME 指向 tmp 的 node/dsh 进程应已回收
    await sleep(3500);
    const orphans = await listOrphans();
    check('零孤儿进程（sidecar/dsh web 均回收）', orphans === '', orphans || '(none)');

    c.close();
  } catch (e) {
    check('GUI 冒烟执行流', false, e.message);
    try { shell.kill(); } catch {}
  }

  console.log(failures === 0 ? '[gui-smoke] ALL PASS' : `[gui-smoke] ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
