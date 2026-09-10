import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { migrateWebuiContinue } from '../scripts/webui-continue-compat.mjs';

const seed = process.env.DSH_PUBLIC_R5 ||
  'H:/CODEX/build-inputs/aio-1.2.0-public-seed-20260908-r5';
const file = `${seed}/profiles/web-desktop/node_modules/@dsh-external/dsh-webui/lib/client.js`;
const available = fs.existsSync(file);
const source = available ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
test('reviewed CRLF archive and LF seed produce identical continuation fixes', { skip: !available }, () => {
  const crlf = source.replace(/\n/g, '\r\n');
  const migrated = migrateWebuiContinue(crlf);
  assert.equal(migrated.replace(/\r\n/g, '\n'), migrateWebuiContinue(source));
  assert.equal(migrateWebuiContinue(migrated), migrated);
});
function region(text, start) {
  const from = text.indexOf(start);
  const to = text.indexOf('//#endregion', from);
  assert.ok(from >= 0 && to > from);
  return text.slice(from, to);
}
const continueStart = 'const SEND_LABELS = ';
function snapshots({ running = false, empty = false, ended = true, closing = true,
  error = null, partial = null, draft = '', phase = 'plain' } = {}) {
  return {
    session: { running, lastAgentError: error },
    chat: {
      timeline: { turnOrder: empty ? [] : [1] },
      order: empty ? [] : ['tail'],
      nodes: new Map([['tail', { kind: 'turn-tail', data: { turn: 1, closing: closing ? {} : null } }]]),
      legacy: { nodes: [], turnTimings: new Map(ended ? [[1, { startTime: 10, endTime: 20 }]] : []), partial },
    },
    input: { draft, phase },
  };
}
function harness(text) {
  let state = snapshots();
  const actions = [];
  let effectCleanup;
  let mounted = false;
  const ref = {};
  const interval = {};
  const counters = { show: 0, dim: 0 };
  const props = {
    useSession: select => select(state.session),
    useChat: select => select(state.chat),
    useInput: select => select(state.input),
    inputActions: {
      setDraft: value => actions.push(['draft', value]),
      submit: () => actions.push(['submit']),
    },
  };
  const api = vm.runInNewContext(region(text, continueStart) + `
    ensureHideObserver = () => {};
    sweepMarked = () => {};
    findPrimaryButton = () => ({ closest: () => null });
    composerDraftEmpty = () => true;
    showOverlay = () => counters.show++;
    dimOverlay = () => counters.dim++;
    ({
      ComposerContinueEnhancer, factsOfFace, lastTurnUnfinished, interruptedFace,
      maybeFill, overlayLoop, onOverlayActivate,
      face: () => latestFace?.(), snap: () => latestSnap
    });`, {
    react: {
      useRef: () => ref,
      useEffect: fn => { if (!mounted) { mounted = true; effectCleanup = fn(); } },
    },
    ensureStyles() {}, css: { overlay: 'fixture-overlay' },
    document: { body: {}, addEventListener() {}, querySelectorAll: () => [] },
    window: {
      setInterval(fn, ms) { interval.fn = fn; interval.ms = ms; return 1; },
      clearInterval() {},
    },
    readText: () => 'Continue task', readHide: () => false,
    buildSendText: text => text, counters,
  });
  return { api, props, actions, interval, counters, render(next = state) {
    state = next;
    assert.equal(api.ComposerContinueEnhancer(props), null);
  }, cleanup: () => effectCleanup?.() };
}

test('actual r5 continue sentinel reproduces undefined.chat; local face migration is idempotent',
  { skip: !available }, () => {
    assert.throws(() => harness(source).render(), /chat/);
    const fixed = migrateWebuiContinue(source);
    assert.equal(migrateWebuiContinue(fixed), fixed);
    assert.throws(() => migrateWebuiContinue(source.replace('faceRef.current = props;', 'unknown();')),
      /Unrecognized/);
    const unrelated = '\nconst other = useSession(s => s.running);';
    assert.ok(migrateWebuiContinue(source + unrelated).endsWith(unrelated));
  });

test('actual 250ms loop reads current owners after rerender and retains continue actions',
  { skip: !available }, () => {
    const h = harness(migrateWebuiContinue(source));
    h.render(snapshots({ empty: true }));
    assert.equal(h.interval.ms, 250);
    assert.equal(h.api.snap().unfinished, false);
    for (const [options, unfinished] of [
      [{}, false], [{ ended: false }, true], [{ closing: false }, true],
      [{ error: 'failed' }, true], [{ partial: { text: 'partial' } }, true],
      [{ running: true, ended: false }, false],
    ]) {
      h.render(snapshots(options));
      assert.equal(h.api.interruptedFace(h.api.face()), unfinished);
      const shown = h.counters.show;
      h.interval.fn();
      assert.equal(h.counters.show - shown, unfinished ? 1 : 0);
    }
    h.render(snapshots({ ended: false }));
    h.interval.fn();
    assert.equal(h.api.maybeFill(h.api.face()), true);
    h.api.onOverlayActivate();
    assert.deepEqual(h.actions, [['draft', 'Continue task'], ['draft', 'Continue task'], ['submit']]);
    h.actions.length = 0;
    h.render(snapshots({ ended: false, draft: 'my own text' }));
    assert.equal(h.api.maybeFill(h.api.face()), false);
    h.api.onOverlayActivate();
    assert.deepEqual(h.actions, [['submit']]);
    for (const phase of ['adjudicating', 'submitting']) {
      h.actions.length = 0;
      h.render(snapshots({ ended: false, phase }));
      assert.equal(h.api.maybeFill(h.api.face()), false);
      h.api.onOverlayActivate();
      assert.deepEqual(h.actions, []);
    }
    h.cleanup();
    assert.doesNotThrow(() => h.interval.fn());
    assert.equal(h.api.face(), undefined);
  });

test('actual StatsLineShadow renders current legacy nodes and preserves projection/cache statistics',
  { skip: !available }, () => {
    const text = migrateWebuiContinue(source);
    const start = '//#region src/client/chat-stats/StatsLineShadow.tsx';
    const load = input => vm.runInNewContext(region(input, start) + '\nStatsLineShadow', {
      react: React, react_jsx_runtime: jsx,
      _deepseek_ai_dsh_client_ui_primitives: { Tooltip: ({ children }) => children },
    });
    const chat = snapshots().chat;
    chat.legacy.nodes = [
      { kind: 'assistant', turn: 1, timing: { stepStartTime: 10, firstTokenTime: 20, completedTime: 40 },
        usage: { outputTokens: 20 } },
      { kind: 'tool-result', callTime: 40, time: 50 },
    ];
    const props = {
      useSession: select => select(snapshots().session),
      useChat: select => select(chat),
      useProjection: key => key === 'tokenUsage'
        ? { uncachedInputTokens: 39, cacheReadTokens: 361, cacheWriteTokens: 0, outputTokens: 20 }
        : undefined,
      t: (key, values) => `${key}:${JSON.stringify(values)}`,
    };
    assert.throws(() => renderToStaticMarkup(React.createElement(load(source), props)), /legacy/);
    const html = renderToStaticMarkup(React.createElement(load(text), props));
    assert.match(html, /1 轮 · 1 步/);
    assert.match(html, /工具调用/);
    assert.match(html, /90.25/);
    assert.doesNotMatch(html, /stats\./);
    assert.doesNotMatch(html, /tok\/s/);
    props.useProjection = key => key === 'sessionStats'
      ? { turns: 7, steps: 8, llmMs: 0, toolMs: 0, ttftSteps: 0, decodeMs: 0 } : undefined;
    assert.match(renderToStaticMarkup(React.createElement(load(text), props)), /7 轮 · 8 步/);
  });

test('installed alpha.2 declarations pin lifecycle, chat legacy and input owners', () => {
  const read = file => fs.readFileSync(new URL(`../node_modules/@deepseek-ai/${file}`, import.meta.url), 'utf8');
  for (const name of ['dsh-api-session-controller', 'dsh-client-ui-chat', 'dsh-client-ui-conversation']) {
    assert.equal(JSON.parse(read(`${name}/package.json`)).version, '0.1.5-rc.2');
  }
  const session = read('dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts');
  assert.match(session, /readonly running: boolean/);
  assert.match(session, /readonly lastAgentError: string \| null/);
  const chat = read('dsh-client-ui-chat/lib/types/client/contract/snapshot.d.ts');
  assert.match(chat, /readonly legacy: LegacyConversationSlice/);
  assert.match(chat, /readonly turnTimings: ReadonlyMap/);
  assert.match(chat, /readonly partial: PartialAssistant \| null/);
  const input = read('dsh-client-ui-conversation/lib/types/client/contract/input.d.ts');
  assert.match(input, /submit\(mode\?: InputSubmitMode\): void/);
});
