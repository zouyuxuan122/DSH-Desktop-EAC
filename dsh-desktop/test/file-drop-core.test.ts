// Tests for the dsh-file-drop companion plugin's pure core.
// The plugin lets users drag files into the conversation input:
//   · text files → content injected into the composer (size-clamped)
//   · images / binaries / oversized files → path hint text for the agent
// The pure logic lives inside lib/client.js as `window.__dshFileDropCore`
// (classic-script bundle, no ESM imports allowed by the dsh module loader),
// so this test evaluates the real bundle with a stubbed window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BUNDLE = new URL('../assets/plugins/dsh-file-drop/lib/client.js', import.meta.url);

/** Evaluate the real client bundle with a stub loader; returns the exposed core. */
function loadCore() {
  const src = readFileSync(BUNDLE, 'utf8');
  const captured = {};
  const win = {
    __ModuleLoader__: { load: (handoff) => { captured.handoff = handoff; } },
  };
  vm.runInNewContext(src, { window: win, console, setTimeout, clearTimeout, FileReader: class {}, DataTransfer: class {}, InputEvent: class {}, Event: class {} });
  assert.ok(captured.handoff, 'bundle must register via __ModuleLoader__.load');
  assert.equal(captured.handoff.id, 'dsh-file-drop', 'handoff must carry the plugin id');
  assert.ok(win.__dshFileDropCore, 'bundle must expose the pure core');
  return win.__dshFileDropCore;
}

const core = loadCore();

test('bundle registers as dsh-file-drop with a web client', () => {
  // the handoff factory shape is exercised when the loader materializes it;
  // here we only verify registration metadata reached the stub.
});

test('classifyFile: known text extensions and extensionless files are text', () => {
  for (const name of ['a.txt', 'main.js', 'b.md', 'c.json', 'd.yaml', 'e.log', 'f.csv', 'Makefile', 'LICENSE', 'package.json']) {
    assert.equal(core.classifyFile(name, 100).kind, 'text', name);
  }
});

test('classifyFile: images are image', () => {
  for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'e.gif', 'f.bmp', 'g.svg']) {
    assert.equal(core.classifyFile(name, 100).kind, 'image', name);
  }
});

test('classifyFile: binaries and unknown extensions fall back to path hint', () => {
  for (const name of ['a.exe', 'b.dll', 'c.bin', 'd.pdb', 'e.zip', 'f.unknownxyz']) {
    assert.equal(core.classifyFile(name, 100).kind, 'binary', name);
  }
});

test('buildTextInsertion wraps content with a filename header', () => {
  const out = core.buildTextInsertion({ name: 'notes.md', content: 'hello\nworld' });
  assert.equal(out.kind, 'text');
  assert.ok(out.text.includes('notes.md'), 'header names the file');
  assert.ok(out.text.includes('hello\nworld'), 'content survives verbatim');
});

test('buildTextInsertion clamps oversized content to a path hint', () => {
  const big = 'x'.repeat(core.TEXT_MAX_BYTES + 1);
  const out = core.buildTextInsertion({ name: 'huge.txt', content: big, path: 'C:\\huge.txt', size: big.length });
  assert.equal(out.kind, 'path-hint');
  assert.ok(out.text.includes('C:\\huge.txt'), 'path hint carries the full path');
  assert.ok(!out.text.includes('xxxx'), 'no content dumped into the hint');
});

test('buildPathHint carries name, path and size; missing path yields a readable fallback', () => {
  const withPath = core.buildPathHint({ name: 'img.png', path: 'D:\\p\\img.png', size: 2048 });
  assert.ok(withPath.includes('img.png') && withPath.includes('D:\\p\\img.png'));
  assert.ok(withPath.includes('2.0 KB'), 'size is human-helpful (formatted, not raw bytes)');
  const noPath = core.buildPathHint({ name: 'img.png', size: 2048 });
  assert.ok(noPath.includes('img.png'));
  assert.ok(!noPath.includes('undefined'), 'missing path never leaks undefined');
});

test('looksBinary detects NUL bytes in the head of the content', () => {
  assert.equal(core.looksBinary('plain text'), false);
  assert.equal(core.looksBinary('a\u0000b'), true);
});

test('TEXT_MAX_BYTES is a sane clamp', () => {
  assert.equal(typeof core.TEXT_MAX_BYTES, 'number');
  assert.ok(core.TEXT_MAX_BYTES >= 65536 && core.TEXT_MAX_BYTES <= 1024 * 1024, 'clamp between 64KB and 1MB');
});