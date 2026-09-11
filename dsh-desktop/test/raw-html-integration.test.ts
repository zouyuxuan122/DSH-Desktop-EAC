import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(root, 'assets', 'plugins', 'dsh-raw-html');

interface RawHtmlClientExports {
  registerAssistantRenderer(ctx: unknown): void;
}

function loadRawHtmlClient(): RawHtmlClientExports {
  const source = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  let captured: { factory: (require: (id: string) => unknown) => unknown } | null = null;
  (window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
    load(def: { factory: (require: (id: string) => unknown) => unknown }) {
      captured = def;
    },
  };
  window.eval(source);
  assert.ok(captured, 'client.js must register itself through window.__ModuleLoader__.load');
  return captured.factory((id) => {
    if (id === 'react') return { createElement: () => null };
    throw new Error(`unexpected require inside client.js factory: ${id}`);
  }) as RawHtmlClientExports;
}

test('raw-html uses the EAC assistant slot instead of patching the web bundle', () => {
  const patchDeps = readFileSync(join(root, 'scripts', 'patch-deps.ts'), 'utf8');
  assert.doesNotMatch(patchDeps, /patchVcpRawHtml|install-v6|window\.__vcpStable/,
    'patch-deps must never inject raw-html into dsh-web-frontend');

  const client = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8');
  assert.match(client, /conversation\.chat\.node/);
  assert.match(client, /key:\s*'assistant-step'/);
  assert.match(client, /officialAssistantComponent/);
  assert.match(client, /attachShadow\(\{\s*mode:\s*'open'\s*\}\)/);
  assert.match(client, /data-vcp-input/);
  assert.doesNotMatch(client, /window\.__vcpStable/,
    'client integration must not depend on the legacy injected global');
});

test('raw-html is EAC-managed, opt-in, and cannot be overwritten by upstream auto-update', () => {
  const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
    version: string;
    files: string[];
    dsh: { client: { inject: string[] } };
  };
  assert.equal(pkg.version, '0.6.2');
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'));
  assert.equal(pkg.files.some((entry) => entry.startsWith('patch/')), false,
    'legacy bundle patch scripts must not be packaged');

  const client = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8');
  assert.match(client, /getItem\(RENDER_KEY\)\s*===\s*'1'/,
    'HTML rendering must require an explicit user opt-in');
  assert.match(client, /getItem\(AESTHETIC_KEY\)\s*===\s*'1'/,
    'aesthetic injection must require an explicit user opt-in');

  const host = readFileSync(join(pluginRoot, 'lib', 'index.js'), 'utf8');
  assert.match(host, /let render = false/);
  assert.match(host, /let aesthetic = false/);

  const companion = readFileSync(join(root, 'lib', 'desktop', 'companion-sync.ts'), 'utf8');
  const generatedRegistry = readFileSync(join(root, 'lib', 'desktop', 'plugin-sync-registry.ts'), 'utf8');
  assert.match(companion, /PLUGIN_UPDATE_SOURCES[^=]*=\s*GENERATED_PLUGIN_UPDATE_SOURCES/);
  assert.doesNotMatch(generatedRegistry, /plugin-sync:update-sources[^\n]*dsh-raw-html/,
    'EAC-managed raw-html must not be replaced by the upstream updater');
});

test('installed dsh-web-frontend bundle remains free of legacy raw-html injection markers', () => {
  const assets = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');
  const bundles = readdirSync(assets).filter((name) => /^index-[\w-]+\.js$/.test(name));
  assert.ok(bundles.length > 0, 'dsh-web-frontend index bundle must exist');
  for (const bundle of bundles) {
    const source = readFileSync(join(assets, bundle), 'utf8');
    assert.doesNotMatch(source, /window\.__vcpStable|window\.__vcpFast|__DSH_V6_INJECT_START__/,
      `${bundle} contains a legacy raw-html injection marker`);
  }
});

test('raw-html accepts the official React.memo assistant renderer and shadows its keyed slot', () => {
  const client = loadRawHtmlClient();
  const officialMemoComponent = { $$typeof: Symbol.for('react.memo'), type: () => null };
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
  const ctx = {
    slots: {
      entries(name: string) {
        assert.equal(name, 'conversation.chat.node');
        return [{
          options: { name, key: 'assistant-step', priority: 0 },
          locale: 'conversation',
          component: officialMemoComponent,
        }];
      },
      inject(name: string, callback: () => (() => void)) {
        assert.equal(name, 'conversation.chat.node');
        return callback();
      },
      register(options: Record<string, unknown>, component: unknown) {
        if (options.key === 'assistant-step' && (options.priority ?? 0) === 0) {
          throw new Error('duplicate assistant-step priority');
        }
        registrations.push({ options, component });
        return () => {};
      },
    },
  };

  client.registerAssistantRenderer(ctx);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.key, 'assistant-step');
  assert.equal(registrations[0].options.priority, -1);
  assert.equal(registrations[0].options.locale, 'conversation');
  assert.notEqual(registrations[0].component, officialMemoComponent);
});
