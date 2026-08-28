import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'assets', 'plugins', 'dsh-eac-locale-compat', 'lib', 'client.js'), 'utf8');

function loadBundle() {
  const window: Record<string, unknown> = {
    __ModuleLoader__: {
      load(definition: { factory: () => unknown }) {
        window.plugin = definition.factory();
      },
    },
  };
  vm.runInNewContext(source, {
    window,
    console,
    Symbol,
    Object,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  });
  return (window.plugin as { __internals: Record<string, (...args: unknown[]) => unknown> }).__internals;
}

class FakeElement {
  nodeType = 1;
  childNodes: Array<FakeElement | FakeText> = [];
  parentElement: FakeElement | null = null;
  attributes = new Map<string, string>();
  excluded = false;

  append(child: FakeElement | FakeText) {
    child.parentElement = this;
    this.childNodes.push(child);
  }

  closest() { return this.excluded ? this : null; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}

class FakeText {
  nodeType = 3;
  parentElement: FakeElement | null = null;
  nodeValue: string;
  constructor(nodeValue: string) { this.nodeValue = nodeValue; }
}

test('compat translator covers fixed plugin copy and dynamic value fragments', () => {
  const { translateText, hasChinese } = loadBundle();
  assert.equal(translateText('编辑并回退'), 'Edit and rewind');
  assert.equal(translateText('正在下载 42%'), '正在下载 42%', 'shell-owned copy is not part of the plugin dictionary');
  assert.equal(translateText('将随消息重新附加 3 张图片'), 'Will reattach with the message: 3 image(s)');
  assert.equal(translateText('正在优化 · 已生成 42 字'), 'Optimizing · generated 42 characters');
  assert.equal(translateText('用 Ctrl+Shift+P 优化当前草稿'), 'Use Ctrl+Shift+P to optimize the current draft');
  assert.equal(translateText('3 轮'), '3 rounds');
  assert.equal(hasChinese('English only'), false);
  assert.equal(hasChinese('连接手机'), true);
});

test('compat translator restores original text and attributes when switching back to Chinese', () => {
  const { translateNode, restoreNode } = loadBundle();
  const rootNode = new FakeElement();
  rootNode.attributes.set('title', '弹出到独立窗口（分屏）');
  const label = new FakeText('编辑并回退');
  rootNode.append(label);

  translateNode(rootNode);
  assert.equal(rootNode.getAttribute('title'), 'Open in a separate window (split view)');
  assert.equal(label.nodeValue, 'Edit and rewind');

  restoreNode(rootNode);
  assert.equal(rootNode.getAttribute('title'), '弹出到独立窗口（分屏）');
  assert.equal(label.nodeValue, '编辑并回退');
});

test('compat translator follows dynamic plugin updates without restoring stale copy', () => {
  const { translateNode, restoreNode } = loadBundle();
  const rootNode = new FakeElement();
  rootNode.attributes.set('title', '编辑并回退');
  const label = new FakeText('正在优化 · 已生成 1 字');
  rootNode.append(label);

  translateNode(rootNode);
  label.nodeValue = '正在优化 · 已生成 2 字';
  rootNode.attributes.set('title', '弹出到独立窗口');
  translateNode(rootNode);
  assert.equal(label.nodeValue, 'Optimizing · generated 2 characters');
  assert.equal(rootNode.getAttribute('title'), 'Open in a separate window');

  label.nodeValue = 'Already provided in English';
  rootNode.attributes.set('title', 'Already English');
  translateNode(rootNode);
  restoreNode(rootNode);
  assert.equal(label.nodeValue, 'Already provided in English');
  assert.equal(rootNode.getAttribute('title'), 'Already English');
});

test('restoring Chinese clears translation state before later plugin updates', () => {
  const { translateNode, restoreNode } = loadBundle();
  const rootNode = new FakeElement();
  const label = new FakeText('编辑并回退');
  rootNode.append(label);

  translateNode(rootNode);
  restoreNode(rootNode);
  label.nodeValue = '正在加载模型列表…';
  restoreNode(rootNode);
  assert.equal(label.nodeValue, '正在加载模型列表…');
});

test('compat translator leaves conversation, code, terminal, editor, and user-input regions untouched', () => {
  const { translateNode } = loadBundle();
  const protectedNode = new FakeElement();
  protectedNode.excluded = true;
  const content = new FakeText('删除文件');
  protectedNode.append(content);

  translateNode(protectedNode);
  assert.equal(content.nodeValue, '删除文件');
});

test('compat plugin is registered as a required core plugin', () => {
  const sync = readFileSync(join(root, 'lib', 'desktop', 'companion-sync.ts'), 'utf8');
  const onboarding = readFileSync(join(root, 'scripts', 'onboarding.js'), 'utf8');
  assert.match(sync, /id: 'eac-locale-compat'.*name: 'dsh-eac-locale-compat'/);
  assert.match(onboarding, /CORE_PLUGIN_IDS[\s\S]*'eac-locale-compat'/);
});

test('shell-owned HTML includes an English branch for non-Chinese browser languages', () => {
  const onboarding = readFileSync(join(root, 'assets', 'onboarding.html'), 'utf8');
  const recovery = readFileSync(join(root, 'assets', 'recovery-center.html'), 'utf8');
  for (const html of [onboarding, recovery]) {
    assert.match(html, /navigator\.languages/);
    assert.match(html, /split\('-'\)\[0\] === 'zh'/);
    assert.match(html, /document\.documentElement\.lang = english \? 'en' : 'zh-CN'/);
  }
  assert.match(onboarding, /Built-in plugin wizard/);
  assert.match(recovery, /Recovery Center/);
});

test('non-DOM plugin instructions also follow the active English locale', () => {
  const sideSession = readFileSync(join(root, 'assets', 'plugins', 'dsh-side-session', 'lib', 'client.js'), 'utf8');
  const optimizer = readFileSync(join(root, 'assets', 'plugins', 'dsh-webui-prompt-optimizer', 'lib', 'client.js'), 'utf8');
  assert.match(sideSession, /Be concise and answer in English/);
  assert.match(sideSession, /document\.documentElement\.lang/);
  assert.match(optimizer, /Use the AI browser to verify/);
  assert.match(optimizer, /document\.documentElement\.lang/);
});
