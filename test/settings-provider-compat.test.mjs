import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import Schema from '@deepseek-ai/schemastery';
import { createAioProviderSettingsApi, migrateProviderSettingsClient } from '../scripts/lib/migrate-provider-settings.mjs';
import { createMigrationStaging, transformPluginInterfaces } from '../scripts/migrate-plugin-interfaces.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const archive = path.resolve(root, '../build-inputs/aio-v1.1.0-local-packages/dsh-external-dsh-webui-0.5.1.tgz');
const original = execFileSync('tar', ['-xOf', archive, 'package/lib/client.js'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 }).replace(/\r\n/g, '\n');

function fixture() {
  const calls = [];
  const ok = value => Promise.resolve({ ok: true, value });
  const namespace = {
    ns: 'llm-pi-ai', revision: 7, schema: Schema.object({
      providers: Schema.dict(Schema.object({
        apiKeyEnv: Schema.string(),
        baseURL: Schema.string(),
        api: Schema.union(['openai-completions', 'anthropic-messages']),
        models: Schema.array(Schema.object({ id: Schema.string(), name: Schema.string() })),
      })),
    }).toJSON(),
    base: {}, user: { providers: { fixture: { apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'fixture-model' }] } } },
    value: { providers: { fixture: { apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'fixture-model' }] } } },
  };
  const invoke = (name, value) => (...args) => { calls.push([name, ...args]); return ok(value); };
  const remote = {
    llm: {
      listProviders: invoke('listProviders', [{ id: 'fixture', name: 'Fixture Provider' }]),
      listConfigurableProviders: invoke('listConfigurableProviders', [{
        provider: 'fixture', displayName: 'Fixture Provider', settingsNs: namespace.ns,
        settingsPath: ['providers', 'fixture'],
      }]),
      discoverModels: invoke('discoverModels', [{ id: 'discovered-model' }]),
    },
    settings: {
      describe: invoke('describeSettings', { writable: true, namespaces: [namespace] }),
      mutate: invoke('mutate', namespace),
    },
    credentials: {
      describe: invoke('describeCredentials', { FIXTURE_API_KEY: { configured: true, writable: true } }),
      set: invoke('setCredential', undefined),
      unset: invoke('unsetCredential', undefined),
    },
    $on: () => () => {},
  };
  return { remote, calls, namespace };
}

function providerComponents(source) {
  const start = source.indexOf('//#region ../../deepseek-harness/packages/client/schema-form/lib/index.js');
  const end = source.indexOf('//#region src/client/file-explorer/preview-bus.ts', start);
  assert.ok(start >= 0 && end > start);
  // Execute the actual provider code from the reviewed/migrated bundle, not a
  // replacement mock component. Only unrelated icons and DOM effects are inert.
  const region = source.slice(start, end);
  const sandbox = {
    react: { ...React,
      useSyncExternalStore: (subscribe, snapshot) => React.useSyncExternalStore(subscribe, snapshot, snapshot) },
    react_jsx_runtime: jsx,
    _deepseek_ai_dsh_client_runtime_client: { createSnapshotStore },
    _dsh_migration_store: { createSnapshotStore },
    _deepseek_ai_dsh_client_ui_primitives: new Proxy({}, { get: () => () => null }),
    console, URL, URLSearchParams, AbortController, structuredClone,
    fetch() { throw new Error('Network forbidden: synthetic settings only'); },
  };
  return vm.runInNewContext(region
    + '\n({applyProviderHub,ProviderHubSection,ModelsSettingsStore,ChatProviderDetail,targetOf})', sandbox);
}

function registerProvider(api, remote) {
  let registration;
  const requested = [];
  const ctx = {
    remote,
    get(name) { assert.equal(name, 'connection'); return { rpc: {} }; },
    effect(fn, label) {
      // Styling has its own ownership test; no simulated DOM is needed here.
      if (label.endsWith('provider section')) return fn();
    },
    inject(names, fn) { requested.push(...names); return fn(ctx); },
    slots: {
      inject(name, fn) { assert.equal(name, 'settings.section'); return fn(); },
      register(meta, component) { registration = { meta, component }; return () => {}; },
    },
  };
  api.applyProviderHub(ctx);
  assert.equal(registration.meta.id, 'provider-hub');
  return { ...registration, requested };
}

test('installed owner signatures used by the provider adapter are alpha.2 contracts', () => {
  for (const owner of ['dsh-client-connection', 'dsh-api-settings-controller', 'dsh-client-ui-settings-models']) {
    assert.equal(JSON.parse(read(`node_modules/@deepseek-ai/${owner}/package.json`)).version, '0.1.5-rc.2');
  }
  const canonical = read('node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js');
  for (const expression of [
    'ctx.remote.credentials.describe([ref])', 'ctx.remote.credentials.set(ref, value)',
    'ctx.remote.credentials.unset(ref)', 'ctx.remote.settings.mutate(ns, ops, expectedRevision)',
    'ctx.remote.llm.discoverModels(settingsNs, request)', 'this.ctx.remote.llm.listProviders()',
    'this.ctx.remote.llm.listConfigurableProviders()',
  ]) assert.ok(canonical.includes(expression), expression);
});

test('reproduces the original blank page with the actual ProviderHubSection', () => {
  const api = providerComponents(original);
  const registered = registerProvider(api, fixture().remote);
  const props = registered.meta.inject();
  assert.equal(props.api, undefined);
  assert.equal(renderToStaticMarkup(React.createElement(registered.component, props)), '');
});

test('migrated reviewed archive mounts and renders the real provider UI with current remotes', async t => {
  const stage = createMigrationStaging();
  t.after(() => fs.rmSync(stage.root, { recursive: true, force: true }));
  execFileSync('tar', ['-xf', archive, '-C', stage.root]);
  const result = transformPluginInterfaces(path.join(stage.root, 'package'), { stage, useUiCompat: true });
  assert.equal(result.unresolved.length, 0);
  assert.ok(result.changes.some(change => change.kind === 'provider-settings-api'));
  const migrated = result.proposedFiles['lib/client.js'];
  const api = providerComponents(migrated.replace(/\r\n/g, '\n'));
  const data = fixture();
  const registered = registerProvider(api, data.remote);
  assert.deepEqual(registered.requested, ['remote.llm', 'remote.settings', 'remote.credentials']);
  const props = registered.meta.inject();
  assert.ok(props.api);
  await props.controller.load();
  const snapshot = props.controller.store.getSnapshot();
  assert.equal(snapshot.status, 'ready', snapshot.error ?? '');
  assert.equal(snapshot.rows[0].credential.configured, true);
  const html = renderToStaticMarkup(React.createElement(registered.component, props));
  assert.match(html, /phub-host/);
  assert.match(html, /Fixture Provider/);
  assert.match(html, /API Key/);
  assert.ok(html.length > 500, 'rendered provider body, not just a CSS shell');
  const detail = renderToStaticMarkup(React.createElement(api.ChatProviderDetail, {
    state: snapshot, target: api.targetOf(snapshot.rows[0], 'edit'), api: props.api, onClose() {},
  }));
  assert.match(detail, /<input/);
  assert.match(detail, /fixture-model/);
  assert.deepEqual(data.calls.map(row => row[0]).sort(),
    ['describeCredentials', 'describeSettings', 'listConfigurableProviders', 'listProviders'].sort());
});

test('settings mutations, credentials, discovery and conflicts use current argument/result shapes', async () => {
  const { remote, calls, namespace } = fixture();
  const api = createAioProviderSettingsApi(remote);
  const ops = [{ op: 'set', path: ['providers', 'fixture', 'baseURL'], value: 'https://example.invalid' }];
  assert.equal((await api.settings.mutate({ ns: namespace.ns, ops, expectedRevision: 7 })).result.value.revision, 7);
  assert.equal((await api.credentials.set({ ref: 'FIXTURE_API_KEY', value: 'synthetic-only' })).result.ok, true);
  await api.credentials.unset({ ref: 'FIXTURE_API_KEY' });
  const models = await api.llm.discoverModels({ settingsNs: namespace.ns, provider: 'fixture' });
  assert.equal(models.result.value.models[0].id, 'discovered-model');
  assert.deepEqual(calls, [
    ['mutate', namespace.ns, ops, 7],
    ['setCredential', 'FIXTURE_API_KEY', 'synthetic-only'],
    ['unsetCredential', 'FIXTURE_API_KEY'],
    ['discoverModels', namespace.ns, { provider: 'fixture' }],
  ]);
  remote.settings.mutate = async () => ({
    ok: false, error: { code: 'settings/conflict', message: 'Revision changed', details: {} },
  });
  const failed = await api.settings.mutate({ ns: namespace.ns, ops, expectedRevision: 6 });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.error.code, 'settings-conflict');
  assert.equal(failed.result.error.message, 'Revision changed');
});

test('provider failures render an actionable error instead of a blank body', async () => {
  const api = providerComponents(migrateProviderSettingsClient(original));
  const { remote } = fixture();
  remote.llm.listConfigurableProviders = async () => ({
    ok: false, error: { code: 'gateway/unavailable', message: 'Fixture directory unavailable' },
  });
  const registered = registerProvider(api, remote);
  const props = registered.meta.inject();
  await props.controller.load();
  assert.equal(props.controller.store.getSnapshot().status, 'error');
  assert.match(renderToStaticMarkup(React.createElement(registered.component, props)),
    /Fixture directory unavailable/);
});

test('unknown provider-hub input fails closed without changing unrelated source', () => {
  assert.throws(() => migrateProviderSettingsClient(original.replace(
    'new ModelsSettingsStore(connection.api)', 'new ModelsSettingsStore(connection.unknown)')),
  /Unknown reviewed/);
  const output = migrateProviderSettingsClient(original);
  const start = original.indexOf('function applyProviderHub(ctx) {');
  const end = original.indexOf('//#endregion', start);
  assert.equal(output.slice(0, start), original.slice(0, start));
  assert.ok(output.endsWith(original.slice(end)), 'other components and all UI remain untouched');
});

test('desktop scrolling targets the real installed settings nav and preserves mobile navigation', () => {
  const css = read('assets/plugins/dsh-aio-ui-compat/src/SettingsScroll.css');
  const installed = read('node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js');
  for (const name of ['VOzbGW_panel', 'VOzbGW_nav', 'VOzbGW_navTitle', 'VOzbGW_navList']) {
    assert.ok(installed.includes(`"${name}"`), `pinned CSS owner ${name} must exist`);
  }
  assert.match(css, /@media \(min-width: 768px\)/);
  assert.match(css, /VOzbGW_navList\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /VOzbGW_navList > button\s*\{[^}]*flex-shrink: 0;/);
  assert.doesNotMatch(css, /!important|display:\s*none|position:\s*fixed|color:|background:/);
  const asset = read('assets/plugins/dsh-aio-ui-compat/lib/client.js');
  assert.ok(asset.includes('VOzbGW_navList'));
  assert.match(asset, /overflow-y:auto/);
});
