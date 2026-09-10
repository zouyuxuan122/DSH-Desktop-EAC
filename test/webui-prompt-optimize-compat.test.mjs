import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import HttpServer from '@deepseek-ai/dsh-host-webserver';
import { migrateWebuiPromptOptimize } from '../scripts/webui-prompt-optimize-compat.mjs';
import { migrateWebuiNativeModelSelection } from '../scripts/webui-native-model-selection-compat.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const jsx = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { chooseStableWebPort } = require('../stable-port');
const seed = process.env.DSH_PUBLIC_R4 || 'H:/CODEX/build-inputs/aio-1.2.0-public-seed-20260908-r4';
const file = path.join(seed, 'profiles/web-desktop/node_modules/@dsh-external/dsh-webui/lib/client.js');
const available = fs.existsSync(file);
const source = available ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
test('reviewed package and installed input owner contracts are pinned', { skip: !available }, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '../package.json')));
  assert.equal(pkg.name, '@dsh-external/dsh-webui');
  assert.equal(pkg.version, '0.5.1');
  const owner = new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/', import.meta.url);
  assert.equal(JSON.parse(fs.readFileSync(new URL('package.json', owner))).version, '0.1.5-rc.2');
  const contract = fs.readFileSync(new URL('lib/types/client/contract/slots.d.ts', owner), 'utf8');
  assert.match(contract, /useInput: SnapshotSelectorHook<InputState>/);
  assert.match(contract, /inputActions: InputActions/);
});
function section(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return text.slice(a, b);
}
function component(text) {
  return vm.runInNewContext(section(text, 'function PromptOptimizeButton(', '\n\t\t//#endregion') +
    '\nPromptOptimizeButton', {
    react: React, react_jsx_runtime: jsx,
    ensureStyles$1() {}, readStyle: () => 'balanced', readTarget: () => false,
    panelStyle: () => ({}), css$1: {}, clsx$2: () => '',
    _deepseek_ai_dsh_client_ui_primitives: { IconSparkle16: () => null },
  });
}

test('optimizer migration is bounded and idempotent', { skip: !available }, () => {
  const fixed = migrateWebuiPromptOptimize(source);
  assert.equal(migrateWebuiPromptOptimize(fixed), fixed);
  assert.throws(() => migrateWebuiPromptOptimize('unexpected'), /Unrecognized/);
  assert.match(fixed, /function syncServerModules\(onModulesSynced\)/);
  assert.match(fixed, /const mountPromptOptimize = \(\) => \{/);
  assert.match(fixed, /syncServerModules\(\(modules\) => \{/);
  assert.doesNotMatch(fixed, /if \(on\("promptOptimize"\)\) applyPromptOptimize\(ctx\);/);
  assert.match(fixed, /if \(on\("promptOptimize"\)\) mountPromptOptimize\(\);/);
  assert.match(fixed, /NS\$1 = "webui\.skill";/);
  assert.match(fixed, /"remote\.session",\n\t\t\t\t"sessions"/);
});

test('native provider/model selection disables the WebUI replacement', { skip: !available }, () => {
  const fixed = migrateWebuiNativeModelSelection(source);
  assert.equal(migrateWebuiNativeModelSelection(fixed), fixed);
  assert.match(fixed, /AIO keeps provider\/model selection in the host native control/);
  assert.doesNotMatch(fixed, /if \(on\("modelSeats"\)\) applyModelSeats\(ctx\);/);
});

test('actual optimizer slot registers and renders with current useInput props', { skip: !available }, () => {
  const props = {
    available: true, sessionId: 'isolated-test',
    directory: { getSnapshot: () => ({ current: { provider: 'local', model: 'fake' }, groups: [] }) },
    useInput: select => select({ draft: 'draft\n<plain text>' }),
    inputActions: { setDraft() {} },
  };
  assert.throws(() => renderToStaticMarkup(React.createElement(component(source), props)), /draft/);
  const fixed = migrateWebuiPromptOptimize(source);
  const Button = component(fixed);
  const apply = vm.runInNewContext(section(fixed, 'function applyPromptOptimize(ctx)', '\n\t\t//#endregion') +
    '\napplyPromptOptimize', { PromptOptimizeButton: Button });
  let registration;
  const scope = {
    modelDirectories: { directoryFor: () => ({ store: props.directory }) },
    sessions: { subagentAddress: () => undefined },
    slots: {
      inject(name, callback) { assert.equal(name, 'conversation.input.right'); callback(); },
      register(spec, view) { registration = { spec, view }; },
    },
  };
  apply({ inject(owners, callback) {
    assert.deepEqual(Array.from(owners), ['slots', 'modelDirectories', 'remote.session', 'sessions']);
    callback(scope);
  } });
  assert.equal(registration.spec.id, 'webui-prompt-optimize');
  const face = registration.spec.inject(props.sessionId);
  const html = renderToStaticMarkup(React.createElement(registration.view, { ...props, ...face }));
  assert.match(html, /<button/);
  assert.match(html, /aria-expanded="false"/);
  scope.sessions.subagentAddress = () => ({ parentSessionId: 'parent' });
  assert.equal(renderToStaticMarkup(React.createElement(registration.view,
    { ...props, ...registration.spec.inject(props.sessionId) })), '');
});

test('reviewed host activates real current webserver routes and streams keyless output',
  { skip: !available, timeout: 15000 }, async () => {
    const { applyPromptOptimize } = await import(pathToFileURL(
      path.join(path.dirname(file), 'prompt-optimize.js')));
    const ctx = new Context();
    let cleanup;
    let calls = 0;
    try {
      let selectedPort = 0;
      const port = await chooseStableWebPort({
        loadSettings: () => ({}),
        saveSettings: (_ctx, settings) => { selectedPort = settings.webPort; },
      });
      assert.equal(port, selectedPort);
      await ctx.plugin(HttpServer, { host: '127.0.0.1', port });
      const base = `http://127.0.0.1:${ctx.webServer.port}`;
      const route = `${base}/api/webui-prompt-optimize`;
      assert.equal((await fetch(route)).status, 404);
      applyPromptOptimize({
        webServer: ctx.webServer,
        effect(callback) { cleanup = callback(); },
        get(name) {
          assert.equal(name, 'llm');
          return { async *stream(request) {
            calls++;
            assert.equal(request.provider, 'local');
            assert.equal(request.model, 'keyless');
            assert.match(JSON.stringify(request.messages), /original draft/);
            await new Promise(resolve => setTimeout(resolve, 20));
            request.signal.throwIfAborted();
            yield { type: 'text-delta', text: 'Improved prompt.' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          } };
        },
      });
      const response = await fetch(route, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'local', model: 'keyless',
          text: 'original draft', sessionId: 'isolated' }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      const frames = await response.text();
      assert.match(frames, /"type":"done","text":"Improved prompt."/);
      assert.equal(calls, 1);
      cleanup();
      cleanup = undefined;
      assert.equal((await fetch(route)).status, 404);
    } finally {
      cleanup?.();
      await ctx.fiber.dispose();
    }
  });
