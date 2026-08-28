'use strict';
// dsh-viewport-lock（5.2 文档级滚动根治）验证 · 对任意在跑的 dsh web：
//   WEB_URL=http://127.0.0.1:<port> node verify-viewport-lock.cjs
// 断言：钳制样式注入并生效 / hero 稳定契约兜底生效 / 滚轮不产生文档滚动 /
// 内部滚动容器无回归 / 极小视口输入卡可达 / active 会话滚动正常。
// 需要全局 playwright（NODE_PATH 指向全局 node_modules）。
const { chromium } = require('playwright');


const URL = process.env.WEB_URL || 'http://127.0.0.1:3457/';
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1006, height: 447 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);

  // 新 origin 可能弹首启向导/声明弹层，先点掉（对已知按钮文本重试）
  for (let i = 0; i < 6; i++) {
    const phase = await page.evaluate(() => { const el = document.querySelector('[data-phase]'); return el ? el.getAttribute('data-phase') : null; });
    if (phase) break;
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button,[role="button"]')];
      const b = btns.find((x) => /^(我知道了|知道了|同意并继续|开始使用|确定|跳过|完成|下一步|Got it|OK|Skip|Done|Next|Accept|继续)$/.test((x.innerText || '').trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(1500);
  }

  // 1) 钳制样式已挂载且生效
  const lock = await page.evaluate(() => {
    const tag = document.getElementById('dsh-viewport-lock');
    const cs = getComputedStyle(document.documentElement);
    const cb = getComputedStyle(document.body);
    return { tag: !!tag, htmlOv: cs.overflow, htmlH: cs.height, bodyOv: cb.overflow, bodyH: cb.height };
  });
  check('1a 钳制样式标签已注入', lock.tag);
  check('1b html overflow hidden', lock.htmlOv === 'hidden', lock.htmlOv);
  check('1c body overflow hidden', lock.bodyOv === 'hidden', lock.bodyOv);
  check('1d html/body height 100%（computed 解析为视口高）', lock.htmlH === '447px' && lock.bodyH === '447px', lock.htmlH + '/' + lock.bodyH);

  // 2) hero 兜底（稳定契约选择器生效）
  const hero = await page.evaluate(() => {
    const sb = document.querySelector('[data-phase="hero"] [data-conversation-scroll]');
    if (!sb) return { found: false };
    const cs = getComputedStyle(sb);
    const seat = document.querySelector('.wSkVaW_composerSeat') || sb.querySelector('[class*="composerSeat"]');
    const r = seat ? seat.getBoundingClientRect() : null;
    return { found: true, justify: cs.justifyContent, seatTop: r ? Math.round(r.top) : null, seatBottom: r ? Math.round(r.bottom) : null, ih: innerHeight };
  });
  check('2a hero 滚动容器命中稳定契约', hero.found);
  check('2b hero justify flex-start', hero.justify === 'flex-start', hero.justify);
  check('2c composer 完整可见', hero.seatTop !== null && hero.seatTop >= 0 && hero.seatBottom <= hero.ih, JSON.stringify({ top: hero.seatTop, bottom: hero.seatBottom, ih: hero.ih }));

  // 3) 文档不可滚动：强推溢出后滚轮不产生文档滚动（overflow:hidden 本就不拦
  //    程序 scrollTo；症状是用户滚动路径 —— 滚轮/触摸/滚动条）。
  const clamp = await page.evaluate(async () => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:0;top:5000px;width:4000px;height:4000px;pointer-events:none;';
    document.body.appendChild(probe);
    await new Promise((r) => requestAnimationFrame(r));
    const before = { x: scrollX, y: scrollY };
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const after = { x: scrollX, y: scrollY };
    probe.remove();
    return { before, after };
  });
  check('3a 滚轮不产生文档滚动', clamp.after.x === 0 && clamp.after.y === 0, JSON.stringify(clamp));

  // 4) 内部滚动无回归：scrollBody 自身可滚（内容高于视口时）
  const inner = await page.evaluate(async () => {
    const sb = document.querySelector('[data-phase="hero"] [data-conversation-scroll]');
    if (!sb) return { found: false };
    // 临时注入高内容让 scrollBody 可滚
    const probe = document.createElement('div');
    probe.style.cssText = 'height:1200px;flex:none;';
    sb.appendChild(probe);
    await new Promise((r) => requestAnimationFrame(r));
    const before = sb.scrollTop;
    sb.scrollTop = 500;
    await new Promise((r) => requestAnimationFrame(r));
    const after = sb.scrollTop;
    const seat = sb.querySelector('[class*="composerSeat"]');
    const sr = seat ? seat.getBoundingClientRect() : null;
    probe.remove();
    sb.scrollTop = 0;
    return { found: true, before, after, seatTopAfterScroll: sr ? Math.round(sr.top) : null };
  });
  check('4a 内部滚动容器仍可滚', inner.found && inner.after > inner.before, JSON.stringify({ before: inner.before, after: inner.after }));
  check('4b 滚动后输入卡进入可视区', inner.seatTopAfterScroll !== null && inner.seatTopAfterScroll >= 0 && inner.seatTopAfterScroll < inner.ih || inner.seatTopAfterScroll === null, String(inner.seatTopAfterScroll));

  // 5) 极小视口（320x200）hero 输入卡仍可达
  await page.setViewportSize({ width: 320, height: 200 });
  await page.waitForTimeout(1200);
  const tiny = await page.evaluate(async () => {
    const sb = document.querySelector('[data-phase="hero"] [data-conversation-scroll]');
    const seat = document.querySelector('[class*="composerSeat"]');
    if (!sb || !seat) return { found: false };
    seat.scrollIntoView({ block: 'nearest' });
    await new Promise((r) => requestAnimationFrame(r));
    const r = seat.getBoundingClientRect();
    return { found: true, top: Math.round(r.top), bottom: Math.round(r.bottom), ih: innerHeight };
  });
  check('5a 极小视口输入卡可达（内部滚动达成）', tiny.found && tiny.top >= -2 && tiny.top < tiny.ih, JSON.stringify(tiny));

  // 6) active 会话阶段滚动正常（发消息后）
  await page.setViewportSize({ width: 1006, height: 447 });
  await page.waitForTimeout(600);
  const sent = await page.evaluate(async () => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no ta';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'viewport-lock 冒烟');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find((x) => /发送/.test(x.getAttribute('aria-label') || '') || /发送/.test(x.innerText || ''));
    if (btn) { btn.click(); return 'sent'; }
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return 'enter';
  });
  await page.waitForTimeout(4000);
  const active = await page.evaluate(async () => {
    const conv = document.querySelector('[data-phase]');
    const sb = document.querySelector('[data-conversation-scroll]');
    let scrollOk = null;
    if (sb) {
      const probe = document.createElement('div');
      probe.style.cssText = 'height:1500px;flex:none;';
      sb.appendChild(probe);
      await new Promise((r) => requestAnimationFrame(r));
      sb.scrollTop = 400;
      await new Promise((r) => requestAnimationFrame(r));
      scrollOk = sb.scrollTop > 0;
      probe.remove();
      sb.scrollTop = 0;
    }
    return { phase: conv ? conv.getAttribute('data-phase') : null, scrollOk, docSW: document.documentElement.scrollWidth, docSH: document.documentElement.scrollHeight };
  });
  check('6a 消息已发送进入会话', sent === 'sent' || sent === 'enter', sent);
  check('6b active 会话内部滚动正常', active.scrollOk === true, JSON.stringify({ phase: active.phase, scrollOk: active.scrollOk }));
  check('6c active 阶段文档仍被钳制', active.docSW <= 1006 + 2 && active.docSH <= 447 + 2, `${active.docSW}x${active.docSH}`);

  await page.screenshot({ path: 'tmp-dbg-repro/shots/viewport-lock-active.png' });
  await browser.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });