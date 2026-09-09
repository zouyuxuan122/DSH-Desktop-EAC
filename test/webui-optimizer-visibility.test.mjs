import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { migrateWebuiPromptOptimize } from '../scripts/webui-prompt-optimize-compat.mjs';

const require = createRequire(import.meta.url);
const seed = process.env.DSH_PUBLIC_R5 ||
  'H:/CODEX/build-inputs/aio-1.2.0-public-seed-20260908-r5';
const webui = `${seed}/profiles/web-desktop/node_modules/@dsh-external/dsh-webui/lib/client.js`;
const available = fs.existsSync(webui);
const source = available ? migrateWebuiPromptOptimize(fs.readFileSync(webui, 'utf8')) : '';
function between(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return text.slice(from, to);
}

test('optimizer defaults on and stale local module cache is reconciled immediately',
  { skip: !available }, async () => {
    const settings = require('js-yaml').load(fs.readFileSync(`${seed}/settings.yaml`, 'utf8'));
    const flags = between(source, 'const WEBUI_MODULE_KEYS = ', '//#endregion');
    const cache = between(source, 'const MODULES_STORAGE_KEY = ', '//#endregion');
    const storage = new Map([['dsh-webui.modules', '{"promptOptimize":false}']]);
    let done;
    const synchronized = new Promise(resolve => { done = resolve; });
    const api = vm.runInNewContext(`${flags}\n${cache}
      ({isModuleEnabled,readStoredModules,syncServerModules});`, {
      localStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem(key, value) { storage.set(key, value); done(); },
      },
      fetch: async url => {
        assert.equal(url, '/api/webui-modules');
        return { ok: true, json: async () => ({ ok: true, modules: settings['webui-modules'] }) };
      },
    });
    assert.equal(api.isModuleEnabled(settings['webui-modules'], 'promptOptimize'), true);
    const startupDecision = api.isModuleEnabled(api.readStoredModules(), 'promptOptimize');
    assert.equal(startupDecision, false);
    let syncedModules;
    api.syncServerModules(modules => { syncedModules = modules; });
    await synchronized;
    assert.equal(api.isModuleEnabled(api.readStoredModules(), 'promptOptimize'), true);
    assert.equal(api.isModuleEnabled(syncedModules, 'promptOptimize'), true);
    assert.match(source, /PromptOptimizeButton\(\{ available, directory, useInput,/);
    assert.match(source, /const mountPromptOptimize = \(\) => \{/);
    assert.match(source, /syncServerModules\(\(modules\) => \{/);
    assert.match(source, /if \(on\("promptOptimize"\)\) mountPromptOptimize\(\);/);
  });

test('actual island selection keeps optimizer right-slot contribution visible by default',
  { skip: !available }, () => {
    // Companion is copied from app assets at bootstrap, not an npm seed dependency.
    const islandPath = new URL('../assets/plugins/dsh-composer-dynamic-island/lib/client.js', import.meta.url);
    const island = fs.readFileSync(islandPath, 'utf8');
    const functions = between(island, 'function describeCandidate(', 'function directElementChildren(');
    const zone = between(island, 'function inputSlotZone(', 'function findComposerParts(');
    // No browser or DOM automation: exercise actual identity/default selection
    // policy with the optimizer's semantic slot and label.
    const api = vm.runInNewContext(`${functions}
      ${zone}
      ({ describeCandidate, registerCurrentCandidates, candidateSelected,
         setCandidateSelected, resetCandidateSelection, inputSlotZone });`, {
      window: { localStorage: { getItem: () => null, setItem() {} } },
      STORE_KEY: 'isolated-test', ZONE_ORDER: ['right'], ZONE_LABELS: { right: 'right' },
      LEFT_SLOT: 'conversation.input.left', RIGHT_SLOT: 'conversation.input.right',
      MODEL_SLOT: 'conversation.input.model',
      labelOf: () => 'Optimize prompt', candidateBaseId: () => 'optimizer',
      hashText: value => value, requestRefresh() {},
    });
    const candidate = api.describeCandidate({}, api.inputSlotZone('conversation.input.right'), 0);
    api.registerCurrentCandidates([candidate]);
    assert.equal(candidate.defaultCollapsed, false);
    assert.equal(api.candidateSelected(candidate), false);
    api.setCandidateSelected(candidate.id, true);
    assert.equal(api.candidateSelected(candidate), true, 'explicit user choice may collapse the button');
    api.resetCandidateSelection();
    assert.equal(api.candidateSelected(candidate), false);
    assert.match(island, /const selectedItems = items\.filter\(\(item\) => candidateSelected\(item\.candidate\)\)/);
  });
