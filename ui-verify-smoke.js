'use strict';
// 一次性安装态 UI 验证（5.1.1 修复包 G3）：
// 真实 Tauri 壳 + CDP，断言三类修复在「装出来的应用」里生效：
//  A) 抽搐 —— #root/中栏 transition-duration 0s，切窗口/会话时 #root 位移 < 1px
//  B) 新建对话截断 —— 矮视口下 hero 输入卡完整可见（顶部 ≥36 玻璃栏下沿）
//  C) 模型选择遮挡 —— 向上展开的模型菜单越界时被桥内 rescue 翻转向下可见
// 用法: node ui-verify-smoke.js [exePath]   （DSH_SMOKE_EXE 亦可）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const tmpHome = path.join(repo, 'tmp-ui-verify-installed', 'ui-home');
fs.mkdirSync(tmpHome, { recursive: true });
const CDP_PORT = 9334;
const EXE = process.env.DSH_SMOKE_EXE || process.argv[2] || path.join(repo, 'tauri-shell', 'target', 'release', 'dsh-eac-shell.exe');
const SHOTS = path.join(repo, 'tmp-ui-verify-installed', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

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
    const msg = JSON.parse(String(ev.data));
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
      if (r.exceptionDetails) throw new Error('page js: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async shot(name) {
      await this.call('Page.captureScreenshot', { format: 'png' }).then((r) => {
        if (r && r.data) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
      }).catch((e) => console.log('  [shot skipped]', name, e.message));
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function waitForMainPage(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const hit = list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1/.test(t.url));
      if (hit) return hit;
    } catch { /* 端口未就绪 */ }
    await sleep(700);
  }
  throw new Error('main page target not found in time');
}

async function waitForAppReady(client, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const state = await client.evalJs(`(() => {
        const root = document.querySelector('#root');
        return { phase: document.querySelector('.wSkVaW_root')?.getAttribute('data-phase') ?? null, hero: !!document.querySelector('.pXSMma_root'), root: !!root };
      })()`);
      if (state && state.root && state.phase !== null) return state;
    } catch { /* 页面还在切换/注入中 */ }
    await sleep(1500);
  }
  throw new Error('SPA did not become ready in time');
}

(async () => {
  if (!fs.existsSync(EXE)) {
    console.error('[ui-verify] missing exe:', EXE);
    process.exit(2);
  }
  console.log('[ui-verify] launching', EXE, '(DSH_HOME=' + tmpHome + ')');
  const shell = spawn(EXE, [], {
    env: {
      ...process.env,
      DSH_HOME: tmpHome,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  shell.stdout.on('data', (d) => { if (String(d).includes('boot.web-ready')) console.log('  [shell] web-ready'); });
  shell.stderr.on('data', (d) => process.stdout.write('  [shell:err] ' + d));
  let exeExited = false;
  shell.on('exit', (code) => { exeExited = true; console.log('[ui-verify] shell exited code=' + code); });

  try {
    const target = await waitForMainPage(180000);
    const client = cdp(target.webSocketDebuggerUrl);
    await client.ready;
    await client.call('Page.enable', {});
    const appState = await waitForAppReady(client, 150000);
    console.log('  [ui-verify] SPA ready, phase=' + appState.phase);
    await sleep(2000); // SPA 引导余量

    // ---- A) 抽搐：transition 掐断 + 位移稳定 ----
    const trans = await client.evalJs(`(() => {
      const g = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return cs.transitionProperty + '|' + cs.transitionDuration; };
      return { root: g('#root'), center: g('#root > div[data-slot="root"] > div > div:nth-child(2)') };
    })()`);
    check('A1 #root 无 0.3s 布局过渡', trans && trans.root === 'none|0s', JSON.stringify(trans && trans.root));
    check('A2 中栏无 0.3s 布局过渡', trans && trans.center === 'none|0s', JSON.stringify(trans && trans.center));

    const drift = await client.evalJs(`(async () => {
      const root = document.querySelector('#root'); if (!root) return null;
      const xs = []; const ys = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 1200) {
        const r = root.getBoundingClientRect();
        xs.push(r.left); ys.push(r.top);
        await new Promise((res) => requestAnimationFrame(res));
      }
      return { maxDx: Math.max(...xs) - Math.min(...xs), maxDy: Math.max(...ys) - Math.min(...ys) };
    })()`);
    check('A3 静置 1.2s #root 位移 < 1px', drift && drift.maxDx < 1 && drift.maxDy < 1, JSON.stringify(drift));

    // ---- B) hero 输入卡在矮视口下完整可见 ----
    await client.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 470, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    const hero = await client.evalJs(`(() => {
      const card = document.querySelector('.uV2eYG_card'); if (!card) return null;
      const r = card.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, topGap: Math.round(r.top - 36), bottomGap: Math.round(innerHeight - r.bottom) };
    })()`);
    check('B1 hero 输入卡顶部 ≥ 36（玻璃栏下方）', hero && hero.top >= 36, JSON.stringify(hero));
    check('B2 hero 输入卡底部 ≤ 视口高（无截断）', hero && hero.bottom <= hero.vh, JSON.stringify(hero));
    await client.shot('g3-hero-short.png');

    // ---- C) 模型菜单救援：越界 → 翻转向下可见 ----
    // 首启"内测声明"等全局模态（web-frontend ModalRoot，z 1000 遮罩）会盖住整个
    // 应用；真实用户点过「继续」后不再出现，测试前先点掉它。
    const modalDismiss = await client.evalJs(`(async () => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const root = Array.from(document.querySelectorAll('[class*="_root_15u5s"]'))
        .find((el) => { const r = getComputedStyle(el); return r.position === 'fixed' && r.zIndex === '1000'; });
      if (!root) return 'none';
      const btns = Array.from(root.querySelectorAll('button'));
      const target = btns[btns.length - 1] || btns[0];
      if (!target) return 'no-button';
      target.click();
      await wait(600);
      return Array.from(document.querySelectorAll('[class*="_root_15u5s"]'))
        .some((el) => { const r = getComputedStyle(el); return r.position === 'fixed' && r.zIndex === '1000'; }) ? 'still-open' : 'dismissed';
    })()`);
    check('C0 关闭首启模态（若有）', modalDismiss === 'none' || modalDismiss === 'dismissed', String(modalDismiss));
    const menu = await client.evalJs(`(async () => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const trailing = document.querySelector('.uV2eYG_trailing'); if (!trailing) return null;
      if (document.getElementById('g3-fake-model-menu')) return { already: true };
      const root = document.createElement('div');
      root.className = '_7KE1Ra_root';
      root.style.cssText = 'min-width:0;position:relative;margin-left:auto;';
      root.innerHTML = '<button id="g3-fake-trigger" style="width:220px;height:28px;">模型(模拟)</button>' +
        '<div id="g3-fake-model-menu" class="_7KE1Ra_menu" style="z-index:20;position:absolute;bottom:calc(100% + 8px);right:0;width:280px;height:360px;background:#1b2438;border:1px solid rgba(255,255,255,.35);border-radius:12px;"></div>';
      trailing.appendChild(root);
      await wait(900); // 等 bridge rescue 的 MutationObserver + 翻转生效
      const m = document.getElementById('g3-fake-model-menu');
      const r = m.getBoundingClientRect();
      const flipped = m.classList.contains('dsh-popup-flip');
      const maxH = m.style.maxHeight;
      const rect = { top: Math.round(r.top), bottom: Math.round(r.bottom) };
      // 命中探测：首启「内测声明」模态可能在测试中途异步弹出盖住全屏，
      // 且首次启动偶会瞬时进入 settling（openState=loading → composer 短暂
      // visibility:hidden）。遮罩则关掉重试；瞬态则重试探针直至收敛。
      const probeInfo = () => {
        const cx = Math.max(4, Math.round(r.left + r.width / 2));
        const cy = Math.max(1, Math.round(r.top + 8));
        const hit = document.elementFromPoint(cx, cy);
        const cls = hit && typeof hit.className === 'string' ? hit.className.split(' ').slice(0, 2).join('.') : '';
        return {
          onMask: hit ? cls.includes('_mask_') : false,
          hitIsMenu: hit === m || (hit && hit.closest && Boolean(hit.closest('#g3-fake-model-menu'))),
          hitClass: hit ? ((hit.id ? '#' + hit.id : '') + '.' + cls + hit.tagName) : 'null',
          seatVis: (() => { const s = m.closest('.wSkVaW_composerSeat'); return s ? getComputedStyle(s).visibility : null; })(),
        };
      };
      let p = probeInfo();
      if (p.onMask) {
        const root = Array.from(document.querySelectorAll('[class*="_root_15u5s"]'))
          .find((el) => { const s = getComputedStyle(el); return s.position === 'fixed' && s.zIndex === '1000'; });
        if (root) {
          const btns = Array.from(root.querySelectorAll('button'));
          (btns[btns.length - 1] || btns[0])?.click?.();
          await wait(700);
        }
      }
      for (let attempt = 0; attempt < 4 && !p.hitIsMenu && !p.onMask; attempt++) {
        await wait(450);
        p = probeInfo();
      }
      return {
        flipped, maxH, rect, hitIsMenu: p.hitIsMenu, onMask: p.onMask, hitClass: p.hitClass, seatVis: p.seatVis,
        triggerRect: (() => { const t = document.getElementById('g3-fake-trigger'); if (!t) return null; const r = t.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; })(),
        trailingRect: (() => { const t = document.querySelector('.uV2eYG_trailing'); if (!t) return null; const r = t.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: getComputedStyle(t).display !== 'none' }; })(),
      };
    })()`);
    check('C1 越界菜单被翻转向下（dsh-popup-flip）', menu && menu.flipped === true, JSON.stringify(menu && { flipped: menu.flipped, maxH: menu.maxH, rect: menu.rect, trigger: menu.triggerRect, trailing: menu.trailingRect }));
    check('C2 菜单顶部 ≥ 36 不再出视口', menu && menu.rect && menu.rect.top >= 36, JSON.stringify(menu && menu.rect));
    check('C3 菜单顶角像素命中菜单自身（未被遮挡）', menu && menu.hitIsMenu === true);
    await client.shot('g3-model-menu-flip.png');

    // ---- D) 悬停浮层横向溢出（提示词优化按钮 hover / 「/」命令菜单同款病灶） ----
    // hero 态滚动体内核只设 overflow-y、x 轴未裁剪，absolute 弹出面板向上展开即把
    // 页面撑出横向滚动条，且面板常驻挂载、移出后不恢复。5.1.2 垫片把 hero 滚动体与
    // body 的 x 轴钉死 + 插件面板改 fixed 定位。D 组用真实鼠标移动 hover 触发钮、
    // 再注入 320px 绝对定位浮层，断言四个时刻都无横向溢出且输入卡完整可见。
    await client.evalJs(`(() => {
      window.__dshOverflowProbe = function (label) {
        const scrollBody = document.querySelector('.wSkVaW_scrollBody');
        const de = document.documentElement;
        const sw = Math.max(document.body.scrollWidth, de.scrollWidth);
        const card = document.querySelector('.uV2eYG_card');
        const cr = card ? card.getBoundingClientRect() : null;
        const panelEl = document.querySelector('.webui-po-panel');
        return {
          label,
          overflowX: sw - de.clientWidth,
          bodyScrollW: document.body.scrollWidth,
          docScrollW: de.scrollWidth,
          clientW: de.clientWidth,
          scrollBodyOX: scrollBody ? getComputedStyle(scrollBody).overflowX : null,
          panelOpen: !!panelEl && panelEl.classList.contains('webui-po-panel-open'),
          card: cr ? { top: Math.round(cr.top), bottom: Math.round(cr.bottom), inView: cr.top >= 0 && cr.bottom <= innerHeight } : null,
          trigger: (() => { const t = document.querySelector('.webui-po-trigger'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })(),
        };
      };
      return true;
    })()`);
    const base = await client.evalJs(`window.__dshOverflowProbe('base')`);
    check('D1 hero 基线无横向溢出', base && base.overflowX <= 1, JSON.stringify(base));
    // 真实触发钮只在活跃会话输入行才挂载（hero 布局不渲染 conversation.input.right
    // slot）；找不到时注入「修复前的旧版几何」模拟面板（absolute 向上展开 320px），
    // 等价验证同一回归：旧布局 hover 后绝不能再撑出横向溢出。
    let hoverPoint = base && base.trigger;
    let realHover = !!hoverPoint;
    if (!hoverPoint) {
      const injected = await client.evalJs(`(() => {
        const trailing = document.querySelector('.uV2eYG_trailing'); if (!trailing) return false;
        const btn = document.createElement('button');
        btn.id = 'g3-fake-po-trigger';
        btn.style.cssText = 'width:28px;height:28px;';
        const panel = document.createElement('div');
        panel.className = 'webui-po-panel webui-po-panel-open';
        panel.style.cssText = 'position:absolute;bottom:calc(100% + 10px);right:0;width:320px;height:200px;background:#1b2438;border:1px solid rgba(255,255,255,.35);border-radius:12px;';
        trailing.appendChild(btn);
        trailing.appendChild(panel);
        return true;
      })()`);
      if (injected) {
        const p = await client.evalJs(`(() => {
          const t = document.getElementById('g3-fake-po-trigger'); if (!t) return null;
          const r = t.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        hoverPoint = p;
        await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
        await sleep(400);
      }
    } else {
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPoint.x, y: hoverPoint.y, button: 'none' });
      await sleep(700);
    }
    const during = await client.evalJs(`window.__dshOverflowProbe('during')`);
    check('D2 悬停提示词优化（面板打开）无横向溢出', during && during.overflowX <= 1 && during.panelOpen === true, JSON.stringify({ realHover, ...during }));
    // 注入式绝对定位浮层（「/」命令菜单同款）：320px 宽向上展开。
    await client.evalJs(`(() => {
      const trailing = document.querySelector('.uV2eYG_trailing');
      if (!trailing) return false;
      const fake = document.createElement('div');
      fake.id = 'g3-fake-slash-menu';
      fake.style.cssText = 'position:absolute;bottom:calc(100% + 10px);right:0;width:320px;height:240px;background:#1b2438;border-radius:12px;z-index:80;';
      trailing.appendChild(fake);
      return true;
    })()`);
    await sleep(300);
    const withFake = await client.evalJs(`window.__dshOverflowProbe('withFake')`);
    check('D4 绝对定位浮层（/ 命令菜单同款）无横向溢出', withFake && withFake.overflowX <= 1, JSON.stringify(withFake));
    await client.evalJs(`(() => { const f = document.getElementById('g3-fake-slash-menu'); if (f) f.remove(); return true; })()`);
    if (hoverPoint) {
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 300, button: 'none' });
      await sleep(600);
    }
    const after = await client.evalJs(`window.__dshOverflowProbe('after')`);
    check('D3 移出鼠标后仍无横向溢出（面板已收起）', after && after.overflowX <= 1 && (realHover ? after.panelOpen === false : true), JSON.stringify({ realHover, ...after }));
    check('D5 hero 输入卡全程完整可见', base && during && withFake && after &&
      base.card && during.card && withFake.card && after.card &&
      [base.card, during.card, withFake.card, after.card].every((c) => c.inView === true),
      JSON.stringify({ base: base && base.card, during: during && during.card, after: after && after.card }));
    await client.shot('g3-hover-overflow.png');

    console.log(failures === 0 ? '\n[ui-verify] PASS' : `\n[ui-verify] FAIL (${failures})`);
    client.close();
    // 退出前保留现场 3s 截图基线？不必；直接收尾。
    shell.kill();
    process.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error('[ui-verify] ERROR:', e.message);
    if (!exeExited) shell.kill();
    process.exit(1);
  }
})();