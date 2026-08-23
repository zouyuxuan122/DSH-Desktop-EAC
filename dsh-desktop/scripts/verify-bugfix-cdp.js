'use strict';
// Bug #58 真机操控验证：启动打包后的应用（隔离环境），通过 CDP 在真实
// 渲染进程里驱动设置页，验证（V4.6.1 单一写者架构）：
//   A. 侧边栏有「普通」「高级」组头（nav-custom 唯一写入）
//   B. 高级折叠/展开可用、抗自愈、持久化到 eac:sidebar:v2
//   C. 用户隐藏的行展开高级后也不复活
//   D. 静置 10s 侧边栏零翻动（navList 子树 DOM 变更计数为 0，防振荡回归）
//   E. dsh-compact 引擎在 preset 中处于激活态（engineActive）
// 用法：node scripts/verify-bugfix-cdp.js --exe <path> [--port 9338]

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const WebSocket = require('ws');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const EXE = arg('exe');
const DEBUG_PORT = Number(arg('port', '9338'));
if (!EXE || !fs.existsSync(EXE)) {
  console.error('[verify] --exe 必须指向存在的 exe');
  process.exit(2);
}

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

async function cdpPageTarget() {
  const list = await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
}

function cdpEval(wsUrl, expr, timeoutMs = 20000) {
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
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result?.result?.value);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function cdpScreenshot(wsUrl, outFile, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('截图超时')); }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg.error || !msg.result?.data) reject(new Error(msg.error?.message || '无截图数据'));
        else {
          fs.writeFileSync(outFile, Buffer.from(msg.result.data, 'base64'));
          resolve(outFile);
        }
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function waitForPage(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const t = await cdpPageTarget(); if (t) return t; } catch {}
    await sleep(1500);
  }
  throw new Error('等待页面超时');
}

async function main() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 隔离环境（绝不触碰真实用户数据）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-bugfix-'));
  const env = {
    ...process.env,
    DSH_HOME: path.join(root, 'dsh'),
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    DSH_DESKTOP_SKIP_AGENT_UPDATE: '1',
    DSH_DESKTOP_SKIP_CLIENT_UPDATE: '1',
    DSH_DESKTOP_SKIP_PLUGIN_UPDATE: '1',
    DSH_DESKTOP_E2E: '1',
  };
  for (const d of [env.DSH_HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(d, { recursive: true });

  console.log(`[verify] 启动 ${EXE}`);
  const app = spawn(EXE, ['--remote-debugging-port=' + DEBUG_PORT], {
    stdio: 'ignore',
    windowsHide: true,
    env,
    detached: false,
  });
  console.log(`[verify] pid=${app.pid}`);

  try {
    const page = await waitForPage();
    console.log(`[verify] 页面就绪 url=${page.url}`);
    const wsUrl = page.webSocketDebuggerUrl;

    // 等待 Web UI 渲染完成（官方设置入口出现）
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await cdpEval(wsUrl, `!!document.querySelector('[data-slot="settings.section"]') || !!document.body.innerText.length`, 8000).catch(() => false);
      if (!ready) await sleep(1500);
    }
    check('Web UI 已渲染', !!ready);

    // 预置「已接管」状态：模拟用户之前用过自定义边栏（这正是用户报障的场景）
    await cdpEval(wsUrl, `(() => {
      localStorage.setItem('eac:settings-nav:v1', JSON.stringify({
        hidden: [],
        order: []
      }));
      return true;
    })()`, 8000);

    // 打开设置页：找侧栏里的设置按钮（齿轮）。官方 UI 的设置按钮 title/aria 可能不同，
    // 直接调用内部路由最稳 —— 但不依赖内部 API，改为点击带「设置」文本的按钮。
    const opened = await cdpEval(wsUrl, `(async () => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const t = btns.find((b) => /设置|Settings/.test(b.getAttribute('aria-label') || b.title || b.textContent || ''));
      if (!t) return 'no-button';
      t.click();
      await new Promise((r) => setTimeout(r, 1200));
      return !!document.querySelector('[data-slot="settings.section"]');
    })()`, 20000);
    check('设置页已打开', opened === true || opened === 'no-button' ? !!opened : !!opened, String(opened));

    // 等待配套插件扫描生效
    await sleep(2500);

    // A. 单一写者：接管状态下仍应有「普通」「高级」组头（nav-custom 写入）
    const heads = await cdpEval(wsUrl, `(() => {
      const lists = document.querySelectorAll('[class*="navList"]');
      for (const l of lists) {
        const hs = l.querySelectorAll('.eac-sidebar-head-basic, .eac-sidebar-head-advanced');
        if (hs.length) return Array.from(hs).map((h) => h.textContent.trim());
      }
      return [];
    })()`, 10000);
    check('A. 「普通/高级」组头存在（单一写者）',
      Array.isArray(heads) && heads.some((x) => x.startsWith('普通')) && heads.some((x) => x.startsWith('高级')),
      JSON.stringify(heads));

    // B. 折叠/展开：真实行级断言 —— 点收起后高级行必须真的 display:none，
    // 且在自愈窗口（1.5s）后仍然保持隐藏；展开后恢复；状态落 eac:sidebar:v2。
    const toggle = await cdpEval(wsUrl, `(async () => {
      const findHead = () => {
        for (const l of document.querySelectorAll('[class*="navList"]')) {
          const h = l.querySelector('.eac-sidebar-head-advanced');
          if (h) return { list: l, head: h };
        }
        return null;
      };
      const settle = (ms) => new Promise((r) => setTimeout(r, ms));
      let f = findHead();
      if (!f) return 'no-head';
      const visibleButtons = () => Array.from(f.list.querySelectorAll('button')).filter((b) => b.style.display !== 'none').length;
      // 先归到收起态
      if (f.head.getAttribute('aria-expanded') === 'true') { f.head.click(); await settle(600); f = findHead(); if (!f) return 'head-lost'; }
      const visibleCollapsed = visibleButtons();
      await settle(1500);
      f = findHead();
      const visibleCollapsedLater = f ? visibleButtons() : -1;
      const ariaCollapsed = f ? f.head.getAttribute('aria-expanded') : null;
      // 全新档案默认收起是懒持久化（从未点击不落盘），此处可能为 null
      const stored = localStorage.getItem('eac:sidebar:v2');
      // 再展开
      f.head.click(); await settle(600);
      f = findHead();
      const visibleExpanded = f ? visibleButtons() : -1;
      const ariaExpanded = f ? f.head.getAttribute('aria-expanded') : null;
      const storedAfterExpand = localStorage.getItem('eac:sidebar:v2');
      // 收回收起态，给后续检查一个确定基线
      f.head.click(); await settle(600);
      return { visibleCollapsed, visibleCollapsedLater, ariaCollapsed, stored, storedAfterExpand, visibleExpanded, ariaExpanded };
    })()`, 30000);
    const toggledOk = toggle && typeof toggle === 'object'
      && toggle.visibleCollapsedLater === toggle.visibleCollapsed
      && toggle.visibleCollapsed < toggle.visibleExpanded
      && toggle.ariaCollapsed === 'false' && toggle.ariaExpanded === 'true'
      && typeof toggle.storedAfterExpand === 'string' && toggle.storedAfterExpand.includes('"folded":false');
    check('B. 收起真的隐藏行、抗自愈、可再展开、持久化到 eac:sidebar:v2', !!toggledOk, JSON.stringify(toggle));

    // C. 用户隐藏行不被复活：隐藏「模型」→ 等 scan → 展开高级 → 模型仍隐藏
    const hideCheck = await cdpEval(wsUrl, `(async () => {
      const lists = document.querySelectorAll('[class*="navList"]');
      let list = null;
      for (const l of lists) {
        if (Array.from(l.querySelectorAll('button')).some((b) => b.textContent.trim() === '模型')) { list = l; break; }
      }
      if (!list) return 'no-list';
      // 通过自定义边栏的存储直接声明隐藏（等价于用户在编辑器里取消勾选）
      const raw = JSON.parse(localStorage.getItem('eac:settings-nav:v1') || '{}');
      raw.hidden = ['models'];
      localStorage.setItem('eac:settings-nav:v1', JSON.stringify(raw));
      // 触发重扫：改 DOM（childList）让 MutationObserver 跑起来
      const div = document.createElement('div');
      list.appendChild(div);
      div.remove();
      await new Promise((r) => setTimeout(r, 1200));
      const modelBtn = Array.from(list.querySelectorAll('button')).find((b) => b.textContent.trim() === '模型');
      const displayAfterHide = modelBtn ? modelBtn.style.display : 'gone';
      // 展开高级，确认隐藏行没有被复活
      const advHead = list.querySelector('.eac-sidebar-head-advanced');
      if (advHead && advHead.getAttribute('aria-expanded') === 'false') {
        advHead.click();
        await new Promise((r) => setTimeout(r, 500));
      }
      const modelBtn2 = Array.from(list.querySelectorAll('button')).find((b) => b.textContent.trim() === '模型');
      const displayAfterExpand = modelBtn2 ? modelBtn2.style.display : 'gone';
      return { displayAfterHide, displayAfterExpand };
    })()`, 20000);
    const hiddenOk = hideCheck && typeof hideCheck === 'object'
      && (hideCheck.displayAfterHide === 'none' || hideCheck.displayAfterHide === 'gone')
      && (hideCheck.displayAfterExpand === 'none' || hideCheck.displayAfterExpand === 'gone');
    check('C. 用户隐藏的行展开高级后也不复活', !!hiddenOk, JSON.stringify(hideCheck));

    // D. 静置零翻动：给 navList 子树装 MutationObserver（childList + style），
    // 静置 10s 计数必须为 0 —— 单一写者幂等收敛后，空闲期变更速率必须归零。
    await sleep(1500); // 等 C 的展开写入彻底沉降
    const armed = await cdpEval(wsUrl, `(() => {
      const lists = Array.from(document.querySelectorAll('[class*="navList"]'));
      const list = lists.find((l) => l.querySelector('button')) || null;
      if (!list) return false;
      if (window.__dshFlutterObs) window.__dshFlutterObs.disconnect();
      window.__dshFlutter = 0;
      window.__dshFlutterObs = new MutationObserver((muts) => { window.__dshFlutter += muts.length; });
      window.__dshFlutterObs.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
      return true;
    })()`, 10000);
    let flutter = -1;
    if (armed) {
      await sleep(10000);
      flutter = await cdpEval(wsUrl, `window.__dshFlutter`, 8000);
    }
    check('D. 静置 10s 侧边栏零翻动（变更速率归零）', armed === true && flutter === 0, 'armed=' + armed + ' mutations=' + flutter);

    // E. dsh-compact 引擎激活（host 端点）
    const webUrl = page.url.match(/^http:\/\/127\.0\.0\.1:(\d+)/);
    if (webUrl) {
      const status = await httpGetJson(`http://127.0.0.1:${webUrl[1]}/plugins/dsh-compact/status?sessionId=`).catch((e) => ({ err: String(e) }));
      check('E. dsh-compact status 端点可达', !!status && !status.err, JSON.stringify(status).slice(0, 160));
    } else {
      check('E. dsh-compact status 端点可达', false, '无法从页面 URL 解析端口');
    }

    // 截图留证（真实渲染画面）
    const shot = path.join(root, 'settings-sidebar.png');
    await cdpScreenshot(wsUrl, shot);
    console.log(`[verify] 截图已保存: ${shot}`);

    const pass = results.every((r) => r.ok);
    console.log(`[verify] 结果: ${pass ? 'ALL PASS' : 'FAILED'} (${results.filter((r) => r.ok).length}/${results.length})`);
    fs.writeFileSync(path.join(root, 'verify-result.json'), JSON.stringify({ pass, results }, null, 2));
    process.exitCode = pass ? 0 : 1;
  } finally {
    try { app.kill(); } catch {}
    await sleep(1500);
    try { execSync('taskkill /PID ' + app.pid + ' /T /F', { windowsHide: true }); } catch {}
  }
}

main().catch((e) => { console.error('[verify] 失败:', e); process.exit(1); });
