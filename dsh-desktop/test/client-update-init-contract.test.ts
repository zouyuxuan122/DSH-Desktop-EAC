import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

function initObject(source: string, call: string): string {
  const start = source.indexOf(`${call}({`);
  assert.notEqual(start, -1, `${call} init call is missing`);
  const objectStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = objectStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(objectStart, i + 1);
    }
  }
  throw new Error(`${call} init object is not balanced`);
}

for (const relative of ['main.js', '../tauri-shell/sidecar/server.ts']) {
  test(`${relative} injects platform handoff into client update only`, () => {
    const source = readFileSync(join(root, relative), 'utf8');
    const clientUpdate = initObject(source, 'clientUpdateMod.init');
    const shortcuts = initObject(source, 'shortcutsMod.init');

    assert.match(clientUpdate, /\bgetPlatform\s*:/);
    assert.match(clientUpdate, /\bopenExternal\s*:/);
    assert.doesNotMatch(shortcuts, /\bgetPlatform\s*:/);
    assert.doesNotMatch(shortcuts, /\bopenExternal\s*:/);
  });
}
