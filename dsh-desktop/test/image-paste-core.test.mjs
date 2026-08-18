// Tests for the dsh-image-paste companion plugin's pure core.
// The plugin turns a clipboard image paste into a saved file + a path hint
// injected into the composer (agent reads it with inspect_image). Same
// evaluation strategy as settings-nav-core / file-drop-core: the browser
// bundle is a classic script, so the tests evaluate the real file with a
// stubbed window and assert against the exposed `window.__dshImagePasteCore`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BUNDLE = new URL('../assets/plugins/dsh-image-paste/lib/client.js', import.meta.url);

function loadCore() {
  const src = readFileSync(BUNDLE, 'utf8');
  const captured = {};
  const win = {
    __ModuleLoader__: { load: (handoff) => { captured.handoff = handoff; } },
  };
  vm.runInNewContext(src, {
    window: win,
    console,
    Promise,
    FileReader: class {},
    Event: class {},
    HTMLTextAreaElement: class {},
    Set, Map, Array, JSON, Error,
  });
  assert.ok(captured.handoff, 'bundle must register via __ModuleLoader__.load');
  assert.equal(captured.handoff.id, 'dsh-image-paste', 'handoff must carry the plugin id');
  assert.ok(win.__dshImagePasteCore, 'bundle must expose the pure core');
  return win.__dshImagePasteCore;
}

const core = loadCore();

test('isImageItem accepts image files and rejects text/HTML items', () => {
  assert.equal(core.isImageItem({ kind: 'file', type: 'image/png' }), true);
  assert.equal(core.isImageItem({ kind: 'file', type: 'image/jpeg' }), true);
  assert.equal(core.isImageItem({ kind: 'string', type: 'text/plain' }), false);
  assert.equal(core.isImageItem({ kind: 'file', type: 'text/html' }), false);
  assert.equal(core.isImageItem(null), false);
  assert.equal(core.isImageItem({}), false);
});

test('imageFilesFrom extracts only image files, preserving order', () => {
  const png = { kind: 'file', type: 'image/png', getAsFile: () => ({ name: 'a.png' }) };
  const text = { kind: 'string', type: 'text/plain', getAsFile: () => ({ name: 'x.txt' }) };
  const jpg = { kind: 'file', type: 'image/jpeg', getAsFile: () => ({ name: 'b.jpg' }) };
  const files = core.imageFilesFrom([text, png, jpg]);
  assert.deepEqual(Array.from(files).map((f) => f.name), ['a.png', 'b.jpg']);
});

test('imageFilesFrom tolerates getAsFile failures and empty input', () => {
  const bad = { kind: 'file', type: 'image/png', getAsFile: () => { throw new Error('boom'); } };
  assert.deepEqual(Array.from(core.imageFilesFrom([bad])), []);
  assert.deepEqual(Array.from(core.imageFilesFrom(null)), []);
  assert.deepEqual(Array.from(core.imageFilesFrom([])), []);
});

test('sanitizeName strips path separators and control chars, caps length', () => {
  assert.equal(core.sanitizeName('..\\..\\evil.png'), '.._.._evil.png');
  assert.equal(core.sanitizeName('a:b*c?"<>|'), 'a_b_c_____');
  assert.equal(core.sanitizeName(''), '粘贴图片');
  assert.equal(core.sanitizeName('   '), '粘贴图片');
  assert.ok(core.sanitizeName('x'.repeat(100)).length <= 40);
});

test('buildPasteHint renders path + size per image and inspect_image hint', () => {
  const out = core.buildPasteHint({
    images: [
      { name: '截图.png', path: 'C:\\tmp\\dsh-paste\\截图-1.png', size: 2048 },
      { name: '无路径', size: 5 * 1024 * 1024 },
    ],
  });
  assert.ok(out.includes('[粘贴图片]'));
  assert.ok(out.includes('截图.png'), 'name must appear');
  assert.ok(out.includes('C:\\tmp\\dsh-paste\\截图-1.png'), 'path must appear');
  assert.ok(out.includes('2.0 KB'), 'size must be formatted');
  assert.ok(out.includes('inspect_image'), 'agent hint must be present');
  assert.ok(out.indexOf('截图.png') < out.indexOf('无路径'), 'order preserved');
});

test('buildPasteHint omits the path line when absent', () => {
  const out = core.buildPasteHint({ images: [{ name: '无路径.png' }] });
  assert.ok(!out.includes('完整路径'), 'no path line without a path');
  assert.ok(out.includes('无路径.png'));
});