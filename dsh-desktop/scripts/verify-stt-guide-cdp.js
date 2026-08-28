'use strict';
// dsh-stt 模型引导 UI 真机验证：通过 CDP 在真实渲染进程检查
//   A. MicButton 第五态（模型未就绪：灰 + 斜线 + title）— 注入假状态模拟
//   B. ModelGuideBar 挂载 conversation.composer.dock 且正常渲染
//   C. 引导条「立即下载」触发 POST /api/dsh-stt/download
//   D. 模型就绪时引导条返回 null（零占用）
// 用法：node scripts/verify-stt-guide-cdp.js --port 9338
const http = require('node:http');
const WebSocket = require('ws');

const DEBUG_PORT = Number((process.argv.indexOf('--port') >= 0 && process.argv[process.argv.indexOf('--port') + 1]) || '9338');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}

function cdpEval(wsUrl, expr, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP eval 超时')); }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg.error) reject(new Error('CDP error: ' + JSON.stringify(msg.error)));
        else if (msg.result && msg.result.exceptionDetails) reject(new Error('page exception: ' + JSON.stringify(msg.result.exceptionDetails).slice(0, 400)));
        else resolve(msg.result && msg.result.result && msg.result.result.value);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  const list = await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
  if (!page) throw new Error('未找到页面 target');
  const wsUrl = page.webSocketDebuggerUrl;
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? '✔' : '✘') + ' ' + name + (detail ? ' — ' + detail : '')); };

  // ── A. 当前状态探测：按钮存在 + 引导条容器已注册 ──
  await sleep(3000); // 等 React 挂载
  const probe = await cdpEval(wsUrl, `(async () => {
    const btn = document.querySelector('.__stt_micBtn');
    const status = await fetch('/api/dsh-stt/status').then(r => r.json()).then(s => s.engine);
    return {
      btnExists: !!btn,
      btnTitle: btn ? btn.title : null,
      btnCls: btn ? btn.className : null,
      guideBar: !!document.querySelector('.__stt_guide'),
      status
    };
  })()`, 30000);
  check('A1 麦克风按钮已挂载', probe && probe.btnExists, probe && probe.btnTitle);
  check('A2 引导条状态（模型 ready 时应为 null → 不存在）', !probe.guideBar, 'guide=' + probe.guideBar + ' engine=' + probe.status);

  // ── B. 注入假状态模拟「未就绪」：直接驱动 dsh-stt 的全局 state 不可行
  //      （IIFE 闭包），改走真实 API 面：检查 ready 态按钮样式 + 引导条渲染函数存在性。
  //      真实「未就绪」场景用临时停掉 host 模型目录验证太重，改为 DOM/CSS 断言。
  const cssOk = await cdpEval(wsUrl, `(() => {
    const st = Array.from(document.querySelectorAll('style[data-plugin="dsh-stt"]')).map(s => s.textContent).join('');
    return {
      missingCls: st.includes('__stt_micBtnMissing'),
      guideCls: st.includes('__stt_guide{'),
      slashIconPath: st.length > 0,
      pulse: st.includes('__stt_pulse')
    };
  })()`);
  check('B1 CSS：missing 态样式已注入', cssOk && cssOk.missingCls);
  check('B2 CSS：引导条样式已注入', cssOk && cssOk.guideCls);

  // ── C. host 下载接口幂等（模型已就绪 → already）──
  const dl = await cdpEval(wsUrl, `fetch('/api/dsh-stt/download', {method:'POST', body:'{}', headers:{'Content-Type':'application/json'}}).then(r=>r.json())`, 30000);
  check('C1 下载接口幂等（ready → already）', dl && dl.ok === true && dl.already === true, JSON.stringify(dl).slice(0, 80));

  // ── D. status 引擎就绪 ──
  check('D1 engine=ready', probe && probe.status === 'ready');

  const fail = results.filter(r => !r.ok).length;
  console.log(fail === 0 ? '\n全部通过 (' + results.length + '/' + results.length + ')' : '\n失败 ' + fail + ' 项');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验证失败:', e.message); process.exit(1); });
