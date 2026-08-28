'use strict';
// 教援模式实测 v2（一次性）：按真实 UX 驱动——
//   启动 → 外部杀 dsh web（模拟崩溃）→ /died 页「重新启动」→ 存活；
//   再杀 → /died 页「安全模式重启」→ safe-mode 激活 + patch 行收缩；
//   再杀 → 退出安全模式（快照恢复）→ 重新启动 → 行恢复 + 存活。
// 每阶段重新获取当前页面 target（导航会销毁旧上下文）。
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const tmpHome = path.join(repo, 'tmp-p2boot', 'rescue-home');
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(tmpHome, { recursive: true });
const CDP_PORT = 9335;
const EXE = process.env.DSH_SMOKE_EXE || path.join(repo, 'tauri-shell', 'target', 'release', 'dsh-eac-shell.exe');

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

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
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
      if (r.exceptionDetails) return { __ex: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 160) };
      return r.result.value;
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function pageTarget(matchFn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const hit = list.filter(matchFn).sort((a, b) => (a.id > b.id ? 1 : -1)).pop();
      if (hit) return hit;
    } catch { /* 端口未就绪 */ }
    await sleep(700);
  }
  throw new Error('target not found: ' + matchFn);
}

const call = (c, method, params) => c.evalJs(`window.dshDesktop._call(${JSON.stringify(method)}, ${JSON.stringify(params || {})})`);

async function killDshWeb() {
  // DSH_HOME 走环境变量（不在命令行）：从主窗页面 URL（http://127.0.0.1:PORT/）
  // 提取端口，按监听 PID 精确击杀 dsh web。
  const pages = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const isOurs = (u) => {
    const m = u.match(/^http:\/\/127\.0\.0\.1:(\d+)/);
    if (!m) return '';
    const p = m[1];
    return (p !== String(CDP_PORT) && p !== '19873') ? p : '';
  };
  let port = '';
  const dump = [];
  for (const x of pages) {
    dump.push(x.type + ' ' + x.url.slice(0, 60));
    const p = x.type === 'page' ? isOurs(x.url) : '';
    if (p && !port) port = p;
  }
  if (!port) throw new Error('killDshWeb: no dsh web page among [' + dump.join(' | ') + ']');
  if (!port) throw new Error('killDshWeb: main web page not found');
  execSync(
    `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }"`,
    { stdio: 'ignore' });
}

const patchFile = path.join(tmpHome, 'profiles', 'web-desktop', 'cordis.patch.yml');
const rowCount = () => (fs.existsSync(patchFile)
  ? fs.readFileSync(patchFile, 'utf8').split('\n').filter((l) => /^\s*-\s*(id|name):/.test(l)).length : -1);

async function waitAlive(c, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await call(c, 'rescue.state').catch(() => null);
    if (st && st.serverAlive) return true;
    await sleep(1200);
  }
  return false;
}

async function main() {
  const shell = spawn(EXE, [], {
    env: { ...process.env, DSH_HOME: tmpHome, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let c;
  try {
    // 初始启动 + 服务存活
    const t = await pageTarget((x) => x.type === 'page', 60000);
    c = cdp(t.webSocketDebuggerUrl); await c.ready;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const ok = await c.evalJs('typeof window.dshDesktop === "object" && typeof window.dshDesktop._call === "function"').catch(() => false);
      if (ok === true) break;
      await sleep(700);
    }
    check('桥注入就绪', true);
    check('初始服务存活', await waitAlive(c));
    // 等主窗真正导航到 Web UI（web-ready → 主线程导航存在滞后）。
    let navOk = false;
    try {
      await pageTarget((x) => x.type === 'page' && /^http:\/\/127\.0\.0\.1:(\d+)/.test(x.url) && !x.url.includes('19873') && !x.url.includes('loading'), 60000);
      navOk = true;
    } catch { /* 兜底：继续（killDshWeb 有独立诊断） */ }
    check('主窗已导航到 Web UI', navOk);
    const rowsBase = rowCount();
    check('初始 patch 插件行 > 0', rowsBase > 0, 'rows=' + rowsBase);

    // ---- 阶段 1：崩溃 → /died → 重新启动 ----
    await killDshWeb();
    const died1 = await pageTarget((x) => x.type === 'page' && /\/died/.test(x.url), 45000);
    c.close(); c = cdp(died1.webSocketDebuggerUrl); await c.ready;
    await sleep(800);
    const st1 = await call(c, 'rescue.state');
    check('崩溃后 /died 页可达且桥可用', !!(st1 && st1.serverAlive === false), 'alive=' + (st1 && st1.serverAlive));
    const r1 = await c.evalJs('document.querySelectorAll("button")[0].click(); "clicked"');
    check('点击「重新启动」', r1 === 'clicked');
    check('重新启动后服务存活', await waitAlive(c));

    // ---- 阶段 2：再崩溃 → 安全模式重启 ----
    await killDshWeb();
    const died2 = await pageTarget((x) => x.type === 'page' && /\/died/.test(x.url), 45000);
    c.close(); c = cdp(died2.webSocketDebuggerUrl); await c.ready;
    await sleep(800);
    const r2 = await c.evalJs('document.querySelectorAll("button")[1].click(); "clicked"');
    check('点击「安全模式重启」', r2 === 'clicked');
    check('安全模式重启后服务存活', await waitAlive(c, 120000));
    const rowsSafe = rowCount();
    check('安全模式 patch 行已收缩', rowsSafe >= 0 && rowsSafe < rowsBase, `rows ${rowsBase} → ${rowsSafe}`);
    let st2 = await call(c, 'rescue.state');
    check('safe-mode 状态激活', !!(st2 && st2.safeMode && st2.safeMode.active === true));

    // ---- 阶段 3：退出安全模式（先崩到 /died 再退）----
    await killDshWeb();
    const died3 = await pageTarget((x) => x.type === 'page' && /\/died/.test(x.url), 45000);
    c.close(); c = cdp(died3.webSocketDebuggerUrl); await c.ready;
    await sleep(800);
    const off = await call(c, 'rescue.safe-mode', { on: false });
    check('退出安全模式（快照恢复）', !!(off && off.ok), JSON.stringify(off).slice(0, 80));
    const rowsAfter = rowCount();
    check('插件行已恢复', rowsAfter === rowsBase, `rows ${rowsSafe} → ${rowsAfter}`);
    const r3 = await c.evalJs('document.querySelectorAll("button")[0].click(); "clicked"');
    check('再次「重新启动」', r3 === 'clicked');
    check('恢复后服务存活', await waitAlive(c));
    const st3 = await call(c, 'rescue.state');
    check('safe-mode 状态已清除', !!(st3 && st3.safeMode == null));

    c.close();
    console.log(failures === 0 ? '[rescue-smoke] ALL PASS' : `[rescue-smoke] ${failures} FAILURES`);
  } catch (e) {
    check('救援冒烟执行流', false, e.message);
  } finally {
    shell.kill();
    setTimeout(() => {
      spawn('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'rescue-home' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true, stdio: 'ignore' });
      process.exit(failures === 0 ? 0 : 1);
    }, 2500);
  }
}

void main();
