import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { Session } from '@deepseek-ai/dsh-session';

// Audit reproductions, NOT passing compatibility acceptance tests: these assert
// the currently observed failures. No host apply, UI, sockets or profiles.
const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8').replace(/\r\n/g, '\n');
const sidebar = read('assets/plugins/dsh-better-sidebar/lib/client.js');
const editor = read('assets/plugins/dsh-better-sidebar/lib/client-editor.js');
const host = read('assets/plugins/dsh-better-sidebar/lib/index.js');
const primitives = read('node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing reviewed boundary: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing reviewed boundary: ${end}`);
  return source.slice(from, to);
}

function browserBundle(relative) {
  let registration;
  const sandbox = vm.createContext({
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    console, URL, URLSearchParams, AbortController,
    fetch() { throw new Error('Network forbidden in audit'); },
  });
  vm.runInContext(read(relative), sandbox, { filename: fileURLToPath(new URL(relative, root)) });
  assert.equal(typeof registration?.factory, 'function');
  const exports = registration.factory(id => { throw new Error(`Unexpected dependency: ${id}`); });
  return { sandbox, exports, id: registration.id };
}

test('audit is pinned to the installed 0.1.5-rc.2 owners', () => {
  for (const name of ['dsh-session', 'dsh-client-modules', 'dsh-client-connection',
    'dsh-client-ui-primitives', 'dsh-api-session-controller']) {
    assert.equal(JSON.parse(read(`node_modules/@deepseek-ai/${name}/package.json`)).version,
      '0.1.5-rc.2', name);
  }
});

test('reproduces editor and terminal load failure despite a working ctx.modules owner', async () => {
  const { sandbox, exports, id } = browserBundle('node_modules/@deepseek-ai/dsh-client-modules/lib/client.js');
  const system = exports.createClientModuleSystem({ mode: 'queue', pendingQueue: [] },
    { id, exports }, {
      boot: { rev: 'audit', entries: [], batches: [] },
      staticModules: { react: { auditSeed: true } },
      loadBundle() { throw new Error('Bundle transport forbidden in audit'); },
    });
  const ctx = {};
  exports.apply({ reflect: { provide(name, value) { ctx[name] = value; } } });
  assert.equal(ctx.modules, system);
  assert.equal((await ctx.modules.import('react')).auditSeed, true);
  assert.equal(sandbox.__DSH_MODULES__, undefined);

  // Execute the actual lazy path, including its global read. The script loader
  // must not be reached: failure precedes both chunk fetching and require.
  const loader = between(sidebar, 'const CHUNK_EXTERNALS = [', '\n\t\t//#endregion');
  vm.runInContext(`${loader}\nglobalThis.auditLoadChunk = loadChunk;`, sandbox);
  for (const chunk of ['editor', 'terminal']) {
    await assert.rejects(sandbox.auditLoadChunk(chunk), /client module system unavailable/);
  }
});

test('reproduces fenced-Markdown preview failure with the lazy editor actual props', () => {
  const expression = between(editor,
    '(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {',
    '\n\t\t\t\t})') + '\n})';
  const element = vm.runInNewContext(expression, {
    react_jsx_runtime: { jsx: (type, props) => ({ type, props }) },
    _deepseek_ai_dsh_client_ui_primitives: { MarkdownText: 'MarkdownText' },
    draft: null, content: '```js\n1\n```', t: key => key,
  });
  assert.ok(element.props.codeLabels);
  assert.equal(element.props.labels, undefined);
  // Use the installed fence renderer unchanged; CSS/DOM/highlighting are not
  // involved in this missing-label failure.
  const renderCodeSource = between(primitives, 'function renderCode(', '\n/** A list is loose');
  const renderCode = vm.runInNewContext(`${renderCodeSource}\nrenderCode`, {
    jsx: (type, props) => ({ type, props }), CodeBlock: 'CodeBlock',
  });
  const node = { type: 'code', lang: 'js', value: '1' };
  assert.throws(() => renderCode(node, 'fence', { streaming: false, labels: element.props.labels }),
    /Cannot read properties of undefined.*code/);
  const fixedOwnerProps = { code: element.props.codeLabels, footnotes: 'Footnotes' };
  assert.equal(renderCode(node, 'fence', { streaming: false, labels: fixedOwnerProps }).props.copyLabel, 'copy');
});

test('reproduces silent subagent activity failure against the installed connection handle', async () => {
  const { exports } = browserBundle('node_modules/@deepseek-ai/dsh-client-connection/lib/client.js');
  const ctx = {};
  // Connection apply constructs a dormant handle; never start its connect loop.
  exports.apply({ provide(name, value) { ctx[name] = value; } });
  assert.equal(typeof ctx.connection.rpc.call, 'function');
  assert.equal(ctx.connection.api, undefined);
  const view = between(sidebar, 'function SubagentLiveLines(props)', '\n\t\t\t}, [ctx, address]);');
  const callback = view.slice(view.indexOf('const load =')) + '\n}, [ctx, address]);\nload';
  let updates = 0;
  const load = vm.runInNewContext(callback, {
    ctx, address: { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' },
    controllerRef: { current: undefined }, AbortController,
    react: { useCallback: fn => fn },
    setLive() { updates++; },
    lastActivity() { throw new Error('Should fail before receiving history'); },
  });
  await load();
  assert.equal(updates, 0, 'empty catch swallows missing connection.api without showing a diagnostic');
  const contract = read('node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts');
  assert.match(contract, /readonly kind: 'subagent'/);
  assert.match(contract, /interface SessionFollowRequest/);
  assert.match(contract, /readonly records: readonly SessionHistoryRecord\[\]/);
});

test('reproduces restored job output loss with a real in-memory installed Session', () => {
  const session = Session.create('companion-audit');
  session.append('tool/call', {
    name: 'job_output', callId: 'call-audit', arguments: '{"job_id":"job-audit"}',
  });
  session.append('tool/result', {
    message: {
      role: 'tool', source: { callId: 'call-audit' },
      content: [{ type: 'tool-result', content: [{ type: 'text', text: 'restored output' }] }],
    },
  }, { surfaceOp: 'append' });
  assert.equal(session.events, undefined);
  assert.equal(session.snapshotEvents().length, 2);
  const jobs = between(host, 'function resultText(message)', '\n//#endregion\n//#region src/index.ts');
  const build = vm.runInNewContext(`${jobs}\nbuildJobsApi`, {
    requireString(payload, key) {
      assert.equal(typeof payload[key], 'string');
      return payload[key];
    },
  });
  const context = object => ({
    get() { return undefined; }, sessions: { get() { return object; } },
    on() { return () => {}; }, effect() {},
  });
  const result = build(context(session), 1024).output({ sessionId: session.id, id: 'job-audit' });
  assert.equal(result.text, '');
  assert.equal(result.read, false);
  // Positive control: identical stored events become visible through the new
  // owner API. No plugin file is changed to supply this comparison adapter.
  const projected = { events: session.snapshotEvents() };
  const control = build(context(projected), 1024).output({ sessionId: session.id, id: 'job-audit' });
  assert.equal(control.text, 'restored output');
  assert.equal(control.read, true);
});
