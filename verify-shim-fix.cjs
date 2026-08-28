'use strict';
// 一次性验证（better-sidebar 修复）：真实 release 壳 + 隔离 home，
// 经 CDP 断言 ① __DSH_MODULES__ 已由 bridge 垫片补发；② editor chunk 的
// 外部依赖经 modules.import 全部可解析；③ 插件 chunk 路由可达。
// 结构照抄 gui-smoke.js（启动环境 / CDP 客户端 / 优雅退出 / 零孤儿检查）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const tmpHome = path.join(repo, 'tmp-p2boot', 'shim-home');
fs.mkdirSync(tmpHome, { recursive: true });
const CDP_PORT = 9334;
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
  console.log('[verify-shim] launching release shell with DSH_HOME=' + tmpHome);
  const shell = spawn(EXE, [], {
    env: {
      ...process.env,
      DSH_HOME: tmpHome,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let shellOut = '';
  shell.stdout.on('data', (d) => { shellOut += d.toString(); });
  shell.stderr.on('data', (d) => { shellOut += d.toString(); });

  try {
    const main = await waitForTarget((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(t.url), 180000);
    const c = cdp(main.webSocketDebuggerUrl);
    await c.ready;

    // ① 垫片补发的模块系统（引导完成后出现；等满 60s 再判失败）
    const hasModules = await c.evalJs(`new Promise(function(res) {
      var t = setTimeout(function() { res(false); }, 60000);
      (function chk() {
        if (window.__DSH_MODULES__ && typeof window.__DSH_MODULES__.import === 'function') { clearTimeout(t); res(true); }
        else setTimeout(chk, 300);
      })();
    })`);
    check('globalThis.__DSH_MODULES__ 已由垫片补发', hasModules);

    if (hasModules) {
      // ② editor chunk require 的外部依赖 + CHUNK_EXTERNALS 里的 graph 行
      const ext = await c.evalJs(`(async function() {
        var specs = ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-runtime/client'];
        var out = {};
        for (var i = 0; i < specs.length; i++) {
          try { var m = await window.__DSH_MODULES__.import(specs[i]); out[specs[i]] = !!m; }
          catch (e) { out[specs[i]] = 'ERR:' + String(e.message).slice(0, 80); }
        }
        return out;
      })()`);
      const allOk = Object.keys(ext).every((k) => ext[k] === true);
      check('editor/terminal chunk 外部依赖全部可解析', allOk, JSON.stringify(ext));

      // ③ 插件懒 chunk 路由（better-sidebar host 半；200 = 插件已激活）
      const chunk = await c.evalJs(`fetch('/sidebar/bundle/editor.js').then(function(r) {
        return r.status + ' len=' + r.headers.get('content-length');
      }).catch(function(e) { return 'FETCH_ERR ' + e; })`);
      check('插件 editor chunk 路由可达', /^200 /.test(chunk), chunk);

      // ④ 复刻插件 loadChunk("editor") 全链路：脚本加载 → __dshChunks__ 工厂注册
      //    → buildExternalsRequire（失败吞成 undefined）→ 工厂执行出 TextEditor
      const chunkOk = await c.evalJs(`(async function() {
        try {
          await new Promise(function(res, rej) {
            var s = document.createElement('script');
            s.src = '/sidebar/bundle/editor.js';
            s.onload = res;
            s.onerror = function() { rej(new Error('script load failed')); };
            document.head.appendChild(s);
          });
          var factory = (window.__dshChunks__ || {})['editor'];
          if (typeof factory !== 'function') return 'NO_FACTORY';
          var specs = ['react','react/jsx-runtime','react-dom','react-dom/client','cordis','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-web-react','@deepseek-ai/dsh-client-ui-primitives','@deepseek-ai/dsh-client-schema-form','@deepseek-ai/dsh-client-runtime/client'];
          var table = {};
          for (var i = 0; i < specs.length; i++) {
            try { table[specs[i]] = await window.__DSH_MODULES__.import(specs[i]); } catch (e) { table[specs[i]] = undefined; }
          }
          var exports = factory(function(spec) {
            if (!(spec in table)) throw new Error('missed module table: ' + spec);
            return table[spec];
          });
          return 'OK TextEditor=' + typeof exports.TextEditor;
        } catch (e) { return 'ERR ' + String(e.message).slice(0, 120); }
      })()`);
      check('复刻 loadChunk("editor") 全链路（脚本→工厂→TextEditor）', /^OK TextEditor=function/.test(chunkOk), chunkOk);
    }

    // 优雅退出：win.close → overlay → quit（与 gui-smoke 同路径）
    await c.evalJs('window.dshDesktop.windowControls.close()').catch(() => {});
    await sleep(1500);
    await c.evalJs(`document.querySelector('#dsh-exit-overlay [data-v=quit]').click(); 0`).catch(() => {});
    const exited = await new Promise((res) => {
      const t0 = Date.now();
      const tick = () => (shell.exitCode !== null ? res(true) : Date.now() - t0 > 20000 ? res(false) : setTimeout(tick, 500));
      tick();
    });
    if (!exited) { try { spawn('taskkill', ['/T', '/F', '/PID', String(shell.pid)]); } catch {} }
    check('退出应用（进程收口）', exited, 'exitCode=' + shell.exitCode);

    await sleep(3500);
    const orphans = await listOrphans();
    check('零孤儿进程', orphans === '', orphans || '(none)');

    c.close();
  } catch (e) {
    check('验证执行流', false, e.message + (shellOut ? ' | shell: ' + shellOut.slice(-400) : ''));
    try { spawn('taskkill', ['/T', '/F', '/PID', String(shell.pid)]); } catch {}
  }

  console.log(failures === 0 ? '[verify-shim] ALL PASS' : `[verify-shim] ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
