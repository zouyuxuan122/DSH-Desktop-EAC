import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'assets', 'plugins', 'dsh-pet', 'lib', 'client.js'), 'utf8');

function loadInternals() {
  let bundleExports;
  const windowStub = {
    __ModuleLoader__: {
      load(spec) {
        bundleExports = spec.factory((id) => {
          if (id === 'react') {
            return { useEffect() {}, useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}] };
          }
          if (id === 'react/jsx-runtime') return { jsx: () => null };
          return {};
        });
      },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', source)(windowStub);
  return bundleExports.__internals;
}

test('dsh-pet stays viewport-fixed above sidebar surfaces without growing page overflow', () => {
  assert.match(source, /\.dsh-pet-root\{position:fixed/);
  assert.match(source, /\.dsh-pet-call\{position:fixed/);
  assert.match(source, /\[data-shell-overlay\]\{z-index:2147483647!important\}/);
  assert.match(source, /\.dsh-pet-stage\{[^}]*overflow:clip!important/);
  assert.doesNotMatch(source, /dsh-pet-stage\{[^}]*transform:/);
});

test('dsh-pet defines all corner anchors', () => {
  assert.match(source, /\.dsh-pet-root\[data-corner="top-right"\]\{right:24px;top:24px\}/);
  assert.match(source, /\.dsh-pet-root\[data-corner="top-left"\]\{left:24px;top:24px\}/);
});

test('dsh-pet keeps playback videos pointer-transparent and uses a bounded hit area', () => {
  assert.match(source, /\.dsh-pet-video\{[^}]*pointer-events:none/);
  assert.match(source, /--dsh-pet-hit-x:14%;--dsh-pet-hit-top:12%;--dsh-pet-hit-bottom:2%/);
  assert.match(source, /const hitAreaProps = \{/);
  assert.match(source, /h\('div', hitAreaProps\)/);
  assert.match(source, /\.dsh-pet-toolbar\{[^}]*opacity:\.72[^}]*pointer-events:auto/);
  assert.match(source, /\.dsh-pet-root:hover \.dsh-pet-toolbar,\.dsh-pet-toolbar:focus-within\{opacity:1\}/);
  const videoProps = source.match(/const commonVideoProps = \{([\s\S]*?)\n\t\t\t\};/)?.[1] || '';
  assert.doesNotMatch(videoProps, /onPointerDown:/);
});

test('dsh-pet clamps rendered size and free positions for small viewports', () => {
  const { fitPetSize, clampPetPosition } = loadInternals();
  assert.equal(fitPetSize(260, 220, 300), 172);
  assert.equal(fitPetSize(420, 800, 240), 216);
  assert.deepEqual(clampPetPosition(0, 0, 260, 220, 180), { left: 0, top: 0 });
  assert.deepEqual(clampPetPosition(1, 1, 120, 220, 180), { left: 100, top: 60 });
});

test('dsh-pet refreshes an existing style tag after plugin hot reload', () => {
  const existingTag = { dataset: {}, textContent: 'stale css' };
  let appended = 0;
  const documentStub = {
    querySelector: () => existingTag,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => { appended += 1; } },
  };
  const windowStub = {
    __ModuleLoader__: {
      load(spec) {
        spec.factory((id) => {
          if (id === 'react') {
            return { useEffect() {}, useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}] };
          }
          if (id === 'react/jsx-runtime') return { jsx: () => null };
          return {};
        });
      },
    },
  };

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(windowStub, documentStub);

  assert.equal(appended, 0);
  assert.match(existingTag.textContent, /\.dsh-pet-stage\{/);
  assert.doesNotMatch(existingTag.textContent, /stale css/);
});
