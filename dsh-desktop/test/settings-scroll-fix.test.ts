import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientSource = readFileSync(
  join(rootDir, 'assets', 'plugins', 'dsh-settings-scroll-fix', 'lib', 'client.js'),
  'utf8',
);

class FakeElement {
  constructor({ text = '', role = '', width = 640, height = 480, clientHeight = height, scrollHeight = height, attrs = {} } = {}) {
    this.nodeType = 1;
    this.textContent = text;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map(role ? [['role', role]] : []);
    for (const [name, value] of Object.entries(attrs)) this.attributes.set(name, value);
    this.dataset = {};
    this.clientHeight = clientHeight;
    this.scrollHeight = scrollHeight;
    this.scrollTop = 0;
    this.rect = { top: 0, left: 0, right: width, bottom: height, width, height };
    this.removed = false;
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
  }

  contains(candidate) {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  getBoundingClientRect() { return this.rect; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) {
    const hit = matchSimpleSelector(selector, this);
    if (hit !== null) return hit;
    if (selector === '[role="dialog"]') return this.getAttribute('role') === 'dialog';
    return false;
  }
  // 供 containsConversationTree / scoreCandidate 的契约选择器探测使用：
  // 支持 "[attr]"、'[attr="value"]' 与逗号分隔列表的最小子集。
  querySelector(selector) {
    for (const child of this.children) {
      if (matchSimpleSelector(selector, child) === true) return child;
      const deep = child.querySelector(selector);
      if (deep !== null) return deep;
    }
    return null;
  }
  closest(selector) {
    let cursor = this;
    while (cursor !== null) {
      if (matchSimpleSelector(selector, cursor) === true) return cursor;
      cursor = cursor.parentElement;
    }
    return null;
  }
  querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]); }
  remove() { this.removed = true; }
}

// 返回 true / false（选择器可判定）；null 表示本实现不认识该选择器语法。
function matchSimpleSelector(selector, element) {
  for (const raw of String(selector).split(',')) {
    const part = raw.trim();
    const m = /^\[([A-Za-z-]+)(?:(\^)?="([^"]*)")?\]$/.exec(part);
    if (m === null) continue;
    const actual = element.attributes.get(m[1]);
    if (m[3] === undefined) {
      if (actual !== undefined) return true;
    } else if (m[2] === '^' ? typeof actual === 'string' && actual.startsWith(m[3]) : actual === m[3]) {
      return true;
    }
  }
  return /[,[]/.test(selector) ? null : false;
}

function appendSettingsSlot(root) {
  root.append(new FakeElement({ attrs: { 'data-slot': 'settings.general' } }));
}

function setupHarness(seeds) {
  const styleElement = new FakeElement();
  const listeners = new Map();
  const document = {
    body: new FakeElement(),
    documentElement: new FakeElement(),
    head: { appendChild() {} },
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === '[data-dsh-settings-root]' ? seeds : [];
    },
    createElement(name) { assert.equal(name, 'style'); return styleElement; },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const window = {
    innerHeight: 900,
    __ModuleLoader__: { load(definition) { window.definition = definition; } },
    getComputedStyle() { return { display: 'flex', visibility: 'visible', overflowY: 'hidden' }; },
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    addEventListener(name, handler) { listeners.set(`window:${name}`, handler); },
    removeEventListener(name) { listeners.delete(`window:${name}`); },
  };
  class MutationObserver {
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  vm.runInNewContext(clientSource, {
    window,
    document,
    MutationObserver,
    console,
    Symbol,
    Set,
    Map,
    Math,
  });
  const plugin = window.definition.factory();
  return { plugin, document, listeners, styleElement };
}

test('settings scroll fix marks overflow targets and cleans up its lifecycle', () => {
  const settingsRoot = new FakeElement({
    text: '设置 通用 模型 插件',
    role: 'dialog',
    width: 900,
    height: 620,
  });
  appendSettingsSlot(settingsRoot);
  const scrollable = new FakeElement({
    width: 620,
    height: 320,
    clientHeight: 320,
    scrollHeight: 900,
  });
  settingsRoot.append(scrollable);

  const { plugin, listeners, styleElement } = setupHarness([settingsRoot]);
  const dispose = plugin.apply();
  assert.equal(scrollable.getAttribute('data-dssf-scrollable'), 'true');
  assert.equal(listeners.has('wheel'), true);

  dispose();
  assert.equal(scrollable.getAttribute('data-dssf-scrollable'), null);
  assert.equal(listeners.has('wheel'), false);
  assert.equal(styleElement.removed, true);
});

test('hero 态整页框架（含会话树）不再被误判为设置根，页面元素一律不打标', () => {
  // 新建对话（hero）页面：整页大框含侧栏设置词表命中，内部是会话骨架
  // （scrollBody 带 data-conversation-scroll），composer 溢出区天然
  // scrollHeight > clientHeight —— 2.0.0 会把整页当根、把溢出盒子全部
  // 打标成滚动容器（所有组件可滚的事故形态）。
  const pageRoot = new FakeElement({
    text: '设置 通用 模型 插件 外观',
    width: 1280,
    height: 800,
  });
  const conversationBody = new FakeElement({ width: 900, height: 700, attrs: { 'data-conversation-scroll': '' } });
  const composerStack = new FakeElement({
    width: 760,
    height: 320,
    clientHeight: 320,
    scrollHeight: 1400,
  });
  conversationBody.append(composerStack);
  pageRoot.append(conversationBody);

  const { plugin, document: doc } = setupHarness([pageRoot]);
  doc.body.append(pageRoot); // 挂到真实 body：promote 向上爬止步于 body
  const dispose = plugin.apply();
  assert.equal(composerStack.getAttribute('data-dssf-scrollable'), null);
  assert.equal(conversationBody.getAttribute('data-dssf-scrollable'), null);
  dispose();
});

test('含会话树的 role=dialog 大框同样被拒（dialog 分支守卫）', () => {
  const dialogRoot = new FakeElement({
    text: '设置 通用 模型',
    role: 'dialog',
    width: 900,
    height: 620,
  });
  appendSettingsSlot(dialogRoot);
  const conversationBody = new FakeElement({ attrs: { 'data-conversation-scroll': '' } });
  const overflowInside = new FakeElement({
    width: 620,
    height: 320,
    clientHeight: 320,
    scrollHeight: 900,
  });
  conversationBody.append(overflowInside);
  dialogRoot.append(conversationBody);

  const { plugin } = setupHarness([dialogRoot]);
  const dispose = plugin.apply();
  assert.equal(overflowInside.getAttribute('data-dssf-scrollable'), null);
  dispose();
});

test('设置弹层内的 data-phase 条目（plugin-inventory 形态）不再令弹层被误拒', () => {
  // 2.0.1 把 [data-phase] 当会话树契约，但设置弹层的插件清单分区同样
  // 挂 data-phase —— 一旦浮层缺失 role=dialog，整条修复链会把设置弹层
  // 自己误判成"含会话树"而拒绝。2.0.2 收窄为会话骨架独占属性。
  const panelRoot = new FakeElement({
    text: '设置 通用 模型 插件',
    width: 900,
    height: 620,
  });
  appendSettingsSlot(panelRoot);
  const navScrollable = new FakeElement({
    width: 188,
    height: 200,
    clientHeight: 200,
    scrollHeight: 640,
  });
  const inventoryItem = new FakeElement({
    width: 620,
    height: 120,
    clientHeight: 120,
    scrollHeight: 300,
    attrs: { 'data-phase': 'unobserved' },
  });
  panelRoot.append(navScrollable);
  panelRoot.append(inventoryItem);

  const { plugin } = setupHarness([panelRoot]);
  const dispose = plugin.apply();
  assert.equal(navScrollable.getAttribute('data-dssf-scrollable'), 'true');
  assert.equal(inventoryItem.getAttribute('data-dssf-scrollable'), 'true');
  dispose();
});

