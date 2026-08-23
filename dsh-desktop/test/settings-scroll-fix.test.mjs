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
  constructor({ text = '', role = '', width = 640, height = 480, clientHeight = height, scrollHeight = height } = {}) {
    this.nodeType = 1;
    this.textContent = text;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map(role ? [['role', role]] : []);
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
    if (selector === '[role="dialog"]') return this.getAttribute('role') === 'dialog';
    return false;
  }
  querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]); }
  remove() { this.removed = true; }
}

test('settings scroll fix marks overflow targets and cleans up its lifecycle', () => {
  const settingsRoot = new FakeElement({
    text: '设置 通用 模型 插件',
    role: 'dialog',
    width: 900,
    height: 620,
  });
  const scrollable = new FakeElement({
    width: 620,
    height: 320,
    clientHeight: 320,
    scrollHeight: 900,
  });
  settingsRoot.append(scrollable);

  const styleElement = new FakeElement();
  const listeners = new Map();
  const document = {
    body: new FakeElement(),
    documentElement: new FakeElement(),
    head: { appendChild(element) { assert.equal(element, styleElement); } },
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === '[data-dsh-settings-root]' ? [settingsRoot] : [];
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
    constructor(callback) { this.callback = callback; }
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

  assert.equal(window.definition.id, 'dsh-settings-scroll-fix');
  const plugin = window.definition.factory();
  const dispose = plugin.apply();
  assert.equal(scrollable.getAttribute('data-dssf-scrollable'), 'true');
  assert.equal(listeners.has('wheel'), true);

  dispose();
  assert.equal(scrollable.getAttribute('data-dssf-scrollable'), null);
  assert.equal(listeners.has('wheel'), false);
  assert.equal(styleElement.removed, true);
});
