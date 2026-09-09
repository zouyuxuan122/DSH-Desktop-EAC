import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const clientPath = path.join(
  workspace,
  'tauri-app', 'resources', 'profile-seed', 'profiles', 'web-desktop',
  'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'client.js',
);

test('staged WebUI embeds a working KaTeX runtime for inline, display, and chemical math', t => {
  if (!fs.existsSync(clientPath)) {
    t.skip('staged profile seed is not present; run the AIO staging step first');
    return;
  }
  const source = fs.readFileSync(clientPath, 'utf8');
  const katexMarker = '//#region src/client/markdown/katex-stub.ts';
  const mhchemMarker = '//#region \\0webui-katex-mhchem-stub';
  const katexStart = source.indexOf(katexMarker);
  const katexEnd = source.indexOf('//#endregion', katexStart) + '//#endregion'.length;
  const mhchemStart = source.indexOf(mhchemMarker);
  const mhchemEnd = source.indexOf('//#endregion', mhchemStart) + '//#endregion'.length;
  assert.ok(katexStart >= 0 && katexEnd > katexStart);
  assert.ok(mhchemStart >= 0 && mhchemEnd > mhchemStart);

  const code = [
    source.slice(katexStart, katexEnd),
    source.slice(mhchemStart, mhchemEnd),
    'init_katex_stub(); init__webui_katex_mhchem_stub(); return katex_stub_exports;',
  ].join('\n');
  const esmMin = (fn, result, error) => () => {
    if (error) throw error[0];
    try {
      return fn && (result = fn(fn = 0)), result;
    } catch (cause) {
      throw error = [cause], cause;
    }
  };
  const styles = [];
  const document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { append(node) { styles.push(node); } },
  };
  const runtime = new Function('__esmMin', 'document', code)(esmMin, document);
  assert.equal(typeof runtime.renderToString, 'function');

  const samples = [
    ['1+2+\\cdots+n=\\dfrac{n(n+1)}{2}', false],
    ['\\displaystyle\\int_{-\\infty}^{+\\infty}e^{-x^2}\\mathrm{d}x=\\sqrt{\\pi}', true],
    ['\\displaystyle\\oint_S \\mathbf E\\cdot\\mathrm d\\mathbf S=\\dfrac{Q_{\\text{内}}}{\\varepsilon_0}', true],
    ['K', false],
    ['\\ce{H2O}', false],
  ];
  for (const [formula, displayMode] of samples) {
    const html = runtime.renderToString(formula, { displayMode, throwOnError: true });
    assert.match(html, /class="katex"/);
  }
  assert.equal(styles.length, 1, 'KaTeX CSS should be injected once');
});
