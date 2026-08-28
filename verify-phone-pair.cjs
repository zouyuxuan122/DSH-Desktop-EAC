'use strict';
// 手机配对全链路验证（5.1.2）· 真实 Tauri 壳 + CDP：
//  1) /plugins/dsh-phone/qrcode.js 静态路由 200（二维码库可达）
//  2) phoneBridge.start() → LAN /pair?token= 200（配对等待页，不再 403/白块）
//  3) desktop decide(true) → /api/pair-state approved + 下发 dsh_mobile cookie
//  4) / 与 /app 返回手机端续聊客户端（非「开发中」占位页）
//  5) /api/rpc 经真内核 client-request 信封往返成功（session.list）
//  6) 顺带抽查：设置侧边栏出现「余额」「多智能体协作团队」入口（尽力而为）
// 用法: node verify-phone-pair.cjs [exePath]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const tmpHome = path.join(repo, 'tmp-ui-verify-installed', 'ui-home');
const CDP_PORT = 9335;
const EXE = process.argv[2] || path.join(repo, 'tauri-shell', 'target', 'release', 'dsh-eac-shell.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGetJson = (url) => new Promise((resolve, reject) => {
  http.get(url, { timeout: 4000 }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});
function httpReq(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const req = http.request(
      {
        hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        method: options.method || 'GET', timeout: 8000,
        headers: {
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
        },
      },
      (res) => {
        const chunks = []; let raw = '';
        res.on('data', (c) => (chunks.push(c), (raw += c)));
        res.on('end', () => {
          let body = null;
          try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
          resolve({ status: res.statusCode || 0, headers: res.headers, body, raw });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id != null && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result); }
  };
  return {
    ready,
    call(method, params) { return ready.then(() => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); })); },
    async evalJs(expr) {
      const r = await this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page js: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    close() { try { ws.close(); } catch {} },
  };
}
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? '✔' : '✖'} ${name}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  if (!fs.existsSync(EXE)) { console.error('[pair] missing exe:', EXE); process.exit(2); }
  console.log('[pair] launching', EXE + ' (CDP ' + CDP_PORT + ', DSH_HOME=' + tmpHome + ')');
  const shell = spawn(EXE, [], {
    env: { ...process.env, DSH_HOME: tmpHome, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  shell.stderr.on('data', (d) => process.stdout.write('  [shell:err] ' + d));
  let exeExited = false;
  shell.on('exit', (code) => { exeExited = true; console.log('[pair] shell exited code=' + code); });
  const exit = (code) => { try { shell.kill(); } catch {} process.exit(code); };
  try {
    // 等主页面
    let target = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      try {
        const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
        target = list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1/.test(t.url));
        if (target) break;
      } catch {}
      await sleep(700);
    }
    if (!target) throw new Error('no main page target');
    const client = cdp(target.webSocketDebuggerUrl);
    await client.ready;
    await client.call('Page.enable', {});
    // 等 SPA 就绪
    const t1 = Date.now();
    while (Date.now() - t1 < 150000) {
      try {
        const s = await client.evalJs(`(() => ({ phase: document.querySelector('.wSkVaW_root')?.getAttribute('data-phase') ?? null, root: !!document.querySelector('#root') }))()`);
        if (s && s.root && s.phase !== null) break;
      } catch {}
      await sleep(1500);
    }
    await sleep(2000);
    console.log('[pair] SPA ready');

    // 1) qrcode 静态路由
    const qrStatus = await client.evalJs(`fetch('/plugins/dsh-phone/qrcode.js').then((r) => r.status).catch((e) => 'ERR:' + e)`);
    check('P1 qrcode.js 静态路由 200', qrStatus === 200, String(qrStatus));

    // 2) 起桥 → 配对 URL
    const start = await client.evalJs(`window.dshDesktop.phoneBridge.start().then((r) => r).catch((e) => ({ err: String(e && e.message || e) }))`);
    check('P2 phoneBridge.start() 返回配对 URL', !!(start && start.ok && start.url && start.port), JSON.stringify(start));
    const pairUrl = start.url;
    const token = new URL(pairUrl).searchParams.get('token');
    const port = start.port;

    // 3) /pair?token= 真实请求（回环可达）
    const pair = await httpReq(`http://127.0.0.1:${port}/pair?token=${encodeURIComponent(token)}`, {});
    check('P3 /pair 200 配对等待页（不再配对链接无效）', pair.status === 200 && /配对|正在建立/.test(pair.raw), 'status=' + pair.status);
    // 裸地址（无 token）仍按设计拒绝
    const bare = await httpReq(`http://127.0.0.1:${port}/pair`, {});
    check('P3b 无 token 裸地址 403（安全边界保留）', bare.status === 403, 'status=' + bare.status);

    // 4) 桌面批准 → approved + cookie
    const decided = await client.evalJs(`window.dshDesktop.phoneBridge.decide(true).then((r) => r).catch((e) => ({ err: String(e && e.message || e) }))`);
    check('P4 桌面批准 decide(true)', decided && decided.ok === true && decided.approved === true, JSON.stringify(decided));
    const poll = await httpReq(`http://127.0.0.1:${port}/api/pair-state?token=${encodeURIComponent(token)}`, {});
    const setCookie = poll.headers['set-cookie'] ? poll.headers['set-cookie'].join('; ') : '';
    check('P5 状态 approved + 下发 dsh_mobile cookie', poll.status === 200 && poll.body.state === 'approved' && /dsh_mobile=1/.test(setCookie), JSON.stringify({ state: poll.body && poll.body.state, cookie: /dsh_mobile=1/.test(setCookie) }));

    // 5) 手机端页面 = 真实续聊客户端
    const home = await httpReq(`http://127.0.0.1:${port}/`, {});
    const app = await httpReq(`http://127.0.0.1:${port}/app`, {});
    check('P6 手机端 / 返回续聊客户端（非占位）', home.status === 200 && /session\.list/.test(home.raw), 'len=' + home.raw.length);
    check('P6b /app 同客户端', app.status === 200 && /session\.list/.test(app.raw), 'len=' + app.raw.length);

    // 6) 白名单 RPC 经真内核信封往返
    const rpc = await httpReq(`http://127.0.0.1:${port}/api/rpc`, { method: 'POST', body: { method: 'session.list', params: {} }, cookie: 'dsh_mobile=1' });
    check('P7 /api/rpc 白名单信封往返成功', rpc.status === 200 && rpc.body && rpc.body.ok === true, 'status=' + rpc.status + ' body=' + JSON.stringify(rpc.body).slice(0, 120));

    // 7) 状态面
    const status = await client.evalJs(`window.dshDesktop.phoneBridge.status().then((r) => r).catch((e) => ({ err: String(e && e.message || e) }))`);
    check('P8 桥状态 running + mobileReady', status && status.running === true && status.mobileReady === true, JSON.stringify({ running: status && status.running, mobileReady: status && status.mobileReady }));

    // 8) 尽力而为：设置侧边栏「余额」「多智能体协作团队」入口
    const nav = await client.evalJs(`(async () => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const clickByText = (text) => {
        const els = Array.from(document.querySelectorAll('a,button,[role="button"],[role="tab"]'));
        const el = els.find((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && ((e.textContent || '').trim() === text || (e.getAttribute('aria-label') || '') === text);
        });
        if (el) { el.click(); return true; }
        return false;
      };
      const opened = clickByText('设置');
      if (!opened) return { opened: false };
      await wait(1200);
      const side = document.body.innerText;
      return { opened: true, hasBalance: side.includes('余额'), hasTeams: side.includes('多智能体协作团队') };
    })()`);
    check('P9 设置侧边栏含「余额」入口', nav && nav.opened === true && nav.hasBalance === true, JSON.stringify(nav));
    check('P10 设置侧边栏含「多智能体协作团队」入口', nav && nav.opened === true && nav.hasTeams === true, JSON.stringify(nav));

    console.log(failures === 0 ? '\n[pair] PASS' : `\n[pair] FAIL (${failures})`);
    client.close();
    exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error('[pair] ERROR:', e.message);
    exit(1);
  }
})();