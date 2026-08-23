// Behavioral tests for dsh-settings-nav-custom's DOM glue (Bug #58).
// The browser bundle is a classic script, so we evaluate the real file in a
// vm sandbox with a minimal DOM/localStorage/MutationObserver stub and drive
// the actual scan → footer → editor flow. String-grep tests cannot catch the
// stale-closure and fingerprint-suppression regressions this file locks down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BUNDLE = new URL('../assets/plugins/dsh-settings-nav-custom/lib/client.js', import.meta.url);

const SECTIONS = [
  { id: 'general', label: '通用设置' },
  { id: 'models', label: '模型' },
  { id: 'chat', label: '对话管理' },
  { id: 'appearance', label: '外观 · 字体与颜色' },
];

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentElement: null,
    style: {},
    listeners: {},
    textContent: '',
    className: '',
    draggable: false,
    type: '',
    checked: false,
    attrs: {},
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    insertBefore(newNode, refNode) {
      if (newNode.parentElement) newNode.parentElement.removeChild(newNode);
      if (!refNode) return this.appendChild(newNode);
      const idx = this.children.indexOf(refNode);
      if (idx === -1) return this.appendChild(newNode);
      newNode.parentElement = this;
      this.children.splice(idx, 0, newNode);
      return newNode;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentElement = null;
      return child;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    dispatch(type, ev) {
      for (const fn of this.listeners[type] ?? []) fn(ev ?? {});
    },
    matches(sel) {
      if (sel === 'button') return this.tagName === 'BUTTON';
      if (sel === 'input') return this.tagName === 'INPUT';
      if (sel.startsWith('.')) return String(this.className).split(/\s+/).includes(sel.slice(1));
      return this.tagName === sel.toUpperCase();
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null;
    },
  };
  Object.defineProperty(el, 'firstElementChild', {
    get() { return this.children[0] ?? null; },
  });
  Object.defineProperty(el, 'nextElementSibling', {
    get() {
      if (!this.parentElement) return null;
      const sibs = this.parentElement.children;
      const i = sibs.indexOf(this);
      return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
    },
  });
  return el;
}

function buildDom() {
  const cells = SECTIONS.map((s) => {
    const b = makeEl('button');
    b.textContent = s.label;
    b.sectionId = s.id;
    return b;
  });
  const listWrap = makeEl('div');
  for (const c of cells) listWrap.appendChild(c);
  const navTitle = makeEl('div');
  const nav = makeEl('div');
  nav.appendChild(navTitle);
  nav.appendChild(listWrap);
  const content = makeEl('div');
  const options = makeEl('div');
  const host = makeEl('div');
  options.appendChild(host);
  content.appendChild(options);
  const panel = makeEl('div');
  panel.appendChild(nav);
  content.parentElement = panel;
  options.parentElement = content;
  host.parentElement = options;

  const body = makeEl('body');
  const documentEl = {
    querySelector(sel) {
      if (sel === '[data-slot="settings.section"]') return host;
      return body.querySelector(sel);
    },
    createElement: makeEl,
    documentElement: makeEl('html'),
    body,
  };
  return { panel, nav, listWrap, cells, body, document: documentEl };
}

function bootSandbox({ storageSeed } = {}) {
  const dom = buildDom();
  const store = new Map(Object.entries(storageSeed ?? {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  let observerCallback = null;
  class MutationObserver {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  }
  const win = {
    __ModuleLoader__: { load: (h) => { win.__handoff = h; } },
  };
  const src = readFileSync(BUNDLE, 'utf8');
  vm.runInNewContext(src, {
    window: win,
    document: dom.document,
    localStorage,
    MutationObserver,
    console,
    setTimeout,
    clearTimeout,
    HTMLElement: class {},
    Set, Map, Array, JSON, Error,
  });
  assert.ok(win.__handoff, 'bundle must register via __ModuleLoader__.load');
  const exports = win.__handoff.factory(function () { return {}; });
  assert.equal(typeof exports.apply, 'function', 'factory must yield apply');
  const slots = { entries: () => SECTIONS.map((s) => ({ options: { id: s.id, label: s.label } })) };
  exports.apply({ get: (name) => (name === 'slots' ? slots : null) });
  const core = win.__dshSettingsNavCore;
  const fire = async () => {
    observerCallback([], {});
    await new Promise((r) => setTimeout(r, 140));
  };
  return { ...dom, core, store, localStorage, fire, slots };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('first scan applies default config and mounts the footer', async () => {
  const t = bootSandbox();
  await sleep(260); // initial schedule(200)
  const footer = t.nav.querySelector('.eac-nav-footer');
  assert.ok(footer, 'footer button must be mounted');
  // 默认配置：外观 · 字体与颜色 不在 DEFAULT_VISIBLE_LABELS，应隐藏
  const appearance = t.cells.find((c) => c.sectionId === 'appearance');
  assert.equal(appearance.style.display, 'none');
});

function findRowBox(overlay, sectionId) {
  const idx = SECTIONS.findIndex((s) => s.id === sectionId);
  const label = SECTIONS[idx].label;
  for (const row of overlay.querySelectorAll('div')) {
    const spans = row.querySelectorAll('span');
    if (spans.length === 1 && spans[0].textContent === label) {
      const box = row.querySelector('input');
      if (box) return box;
    }
  }
  return null;
}

test('reopening the editor reflects saved changes, not the stale first-open config', async () => {
  const t = bootSandbox();
  await sleep(260);
  const footer = t.nav.querySelector('.eac-nav-footer');

  // 第一次打开编辑器
  footer.dispatch('click');
  let overlay = t.document.querySelector('.eac-nav-editor');
  assert.ok(overlay, 'editor overlay must open');
  let boxes = overlay.querySelectorAll('input');
  assert.equal(boxes.length, SECTIONS.length);
  const modelsBox1 = findRowBox(overlay, 'models');
  assert.ok(modelsBox1, '模型 row must exist');
  assert.equal(modelsBox1.checked, true, '模型 starts visible');

  // 取消勾选「模型」→ applyAndSave 落盘
  modelsBox1.checked = false;
  modelsBox1.dispatch('change');
  const saved = JSON.parse(t.localStorage.getItem(t.core.STORAGE_KEY));
  assert.ok(saved.hidden.includes('models'), 'toggle must persist to localStorage');

  // 关闭编辑器（点击遮罩）
  overlay.dispatch('click', { target: overlay });
  assert.equal(t.document.querySelector('.eac-nav-editor'), null);

  // 第二次打开：必须读到最新保存状态（修复前是首轮闭包里的旧 cfg）
  footer.dispatch('click');
  overlay = t.document.querySelector('.eac-nav-editor');
  assert.ok(overlay, 'second open must work');
  boxes = overlay.querySelectorAll('input');
  const modelsBox2 = findRowBox(overlay, 'models');
  assert.equal(modelsBox2.checked, false,
    'reopened editor must reflect persisted hidden state (stale-closure fix)');
  overlay.dispatch('click', { target: overlay });
});

test('scan heals externally overwritten styles (groups/React fight)', async () => {
  const t = bootSandbox({
    storageSeed: { [t0Key()]: JSON.stringify({ hidden: ['appearance'], order: ['models', 'general', 'chat', 'appearance'] }) },
  });
  function t0Key() { return 'eac:settings-nav:v1'; }
  await sleep(260);

  const appearance = t.cells.find((c) => c.sectionId === 'appearance');
  const models = t.cells.find((c) => c.sectionId === 'models');
  const general = t.cells.find((c) => c.sectionId === 'general');
  assert.equal(appearance.style.display, 'none', 'stored hidden applied');
  assert.equal(models.style.order, '0', 'stored order applied');

  // 模拟 dsh-settings-groups 覆盖：复位全部行样式并插入组头（childList 变化）
  for (const c of t.cells) { c.style.display = ''; c.style.order = ''; }
  const head = makeEl('div');
  head.className = 'eac-settings-groups-navhead';
  t.listWrap.appendChild(head);
  await t.fire();

  assert.equal(appearance.style.display, 'none', 'hidden must be restored after overwrite');
  assert.equal(models.style.order, '0', 'custom order must be restored after overwrite');
  assert.equal(general.style.order, '1');

  // 收敛性：再次触发不再变化（无拉锯振荡）
  await t.fire();
  assert.equal(appearance.style.display, 'none');
  assert.equal(models.style.order, '0');
});

test('direct storage edits are picked up on the next scan', async () => {
  const t = bootSandbox();
  await sleep(260);
  const appearance = t.cells.find((c) => c.sectionId === 'appearance');
  // appearance 是隐藏集 + 高级组双重隐藏，默认应为 none
  assert.equal(appearance.style.display, 'none', 'default hides appearance (hidden set)');

  // 清空隐藏集但保持折叠收起：高级行仍因折叠隐藏
  t.localStorage.setItem(t.core.STORAGE_KEY, JSON.stringify({ hidden: [], order: [] }));
  await t.fire();
  assert.equal(appearance.style.display, 'none', 'advanced stays hidden while folded');

  // 展开高级组：高级行应恢复可见
  t.localStorage.setItem(t.core.FOLD_STORAGE_KEY, JSON.stringify({ folded: false }));
  await t.fire();
  assert.equal(appearance.style.display, '', 'storage change must trigger reapply and unfold');
});

// 单一写者折叠：高级行显隐完全由折叠状态决定，与自愈不冲突
test('fold state controls advanced rows via single writer', async () => {
  const t = bootSandbox();
  await sleep(260);
  const models = t.cells.find((c) => c.sectionId === 'models');
  const chat = t.cells.find((c) => c.sectionId === 'chat');
  // 默认折叠收起：高级（模型）隐藏，普通（对话管理）可见
  assert.equal(models.style.display, 'none', 'advanced hidden when folded');
  assert.equal(chat.style.display, '', 'basic visible when folded');

  // 展开：高级恢复
  t.localStorage.setItem(t.core.FOLD_STORAGE_KEY, JSON.stringify({ folded: false }));
  await t.fire();
  assert.equal(models.style.display, '', 'advanced visible when unfolded');

  // 再收起：高级再次隐藏
  t.localStorage.setItem(t.core.FOLD_STORAGE_KEY, JSON.stringify({ folded: true }));
  await t.fire();
  assert.equal(models.style.display, 'none', 'advanced hidden again after refold');

  // 无标记的样式篡改仍会被自愈
  models.style.display = '';
  await t.fire();
  assert.equal(models.style.display, 'none', 'folded state heals external overwrite');
  chat.style.order = '';
  await t.fire();
  assert.ok(chat.style.order !== '', 'order overwrite heals');
});

// 点击折叠后扫描状态必须同步（指纹 + 折叠存储），观察器调度的下一次扫描
// 直接命中跳过条件 —— 否则每次点击都多一轮冗余重放（Bug #58 抖动面）。
test('fold click syncs scan state so the next observer pass skips replay', async () => {
  const t = bootSandbox();
  await sleep(260);
  let slotReads = 0;
  const origEntries = t.slots.entries;
  t.slots.entries = function (...args) {
    slotReads++;
    return origEntries.apply(t.slots, args);
  };

  const advHead = t.listWrap.querySelector('.eac-sidebar-head-advanced');
  assert.ok(advHead, 'advanced head must exist after first scan');

  advHead.dispatch('click'); // 同步：写存储 → 应用布局 → 同步扫描状态
  await sleep(140); // 观察器因样式变更调度的那次扫描
  const readsAfterClick = slotReads;
  assert.ok(readsAfterClick >= 1, 'click must apply the layout directly');

  await t.fire(); // 再来一轮观察器调度
  assert.equal(slotReads, readsAfterClick,
    'post-click scans must skip: no redundant layout replay after fold click');

  // 功能不回归：点击确实切换了折叠态并落盘
  const stored = JSON.parse(t.localStorage.getItem(t.core.FOLD_STORAGE_KEY));
  assert.equal(stored.folded, false, 'click must persist unfolded state');
});
