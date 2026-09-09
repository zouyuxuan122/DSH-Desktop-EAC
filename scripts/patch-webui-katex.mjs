import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateWebuiKatexFallback } from './migrate-plugin-interfaces.mjs';

const target = path.resolve(process.argv[2] || '');
if (!target || !fs.existsSync(target)) throw new Error(`WebUI client not found: ${target}`);

function readFirstExisting(candidates, label) {
  const file = candidates.find(candidate => fs.existsSync(candidate));
  if (!file) throw new Error(`WebUI KaTeX ${label} not found; checked: ${candidates.join(', ')}`);
  return { file, text: fs.readFileSync(file, 'utf8') };
}

function inlineKaTeXRuntime(text) {
  const marker = '//#region src/client/markdown/katex-stub.ts';
  const start = text.indexOf(marker);
  const end = text.indexOf('//#endregion', start);
  if (start < 0 || end < start || text.indexOf(marker, start + marker.length) >= 0) {
    throw new Error('Unknown staged WebUI KaTeX stub region');
  }
  const regionEnd = end + '//#endregion'.length;
  const original = text.slice(start, regionEnd);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const packageRoot = path.resolve(path.dirname(target), '..');
  const katexRoot = path.join(packageRoot, 'node_modules', 'katex');
  const fallbackRoot = path.resolve(packageRoot, '..', '..', 'katex');
  const roots = [katexRoot, fallbackRoot];
  const katex = readFirstExisting(roots.map(root => path.join(root, 'dist', 'katex.min.js')), 'runtime');
  const mhchem = readFirstExisting(roots.map(root => path.join(root, 'dist', 'contrib', 'mhchem.min.js')), 'mhchem runtime');
  const css = readFirstExisting(roots.map(root => path.join(root, 'dist', 'katex.min.css')), 'stylesheet');

  const cssText = JSON.stringify(css.text);
  const replacement = [
    marker,
    'var katex_stub_exports = {};',
    'var init_katex_stub = __esmMin((() => {',
    '  const localModule = { exports: {} };',
    '  const localExports = localModule.exports;',
    '  (function(module, exports, require) {',
    katex.text,
    '  })(localModule, localExports, () => { throw new Error("KaTeX has no runtime dependency"); });',
    '  const runtime = localModule.exports?.default ?? localModule.exports;',
    '  Object.assign(katex_stub_exports, runtime);',
    `  if (typeof document !== "undefined" && !document.querySelector("style[data-dsh-aio-katex]")) { const style = document.createElement("style"); style.setAttribute("data-dsh-aio-katex", "true"); style.textContent = ${cssText}; document.head.append(style); }`,
    '}));',
    '//#endregion',
  ].join('\n');

  const mhchemMarker = '//#region \\0webui-katex-mhchem-stub';
  const mhchemStart = text.indexOf(mhchemMarker);
  const mhchemEnd = text.indexOf('//#endregion', mhchemStart);
  if (mhchemStart < 0 || mhchemEnd < mhchemStart || text.indexOf(mhchemMarker, mhchemStart + mhchemMarker.length) >= 0) {
    throw new Error('Unknown staged WebUI mhchem stub region');
  }
  const mhchemRegionEnd = mhchemEnd + '//#endregion'.length;
  const mhchemReplacement = [
    mhchemMarker,
    'var _webui_katex_mhchem_stub_exports = {};',
    'var init__webui_katex_mhchem_stub = __esmMin((() => {',
    '  const localModule = { exports: {} };',
    '  const localExports = localModule.exports;',
    '  (function(module, exports, require) {',
    mhchem.text,
    '  })(localModule, localExports, (specifier) => { if (specifier === "katex") return katex_stub_exports; throw new Error(`Unknown KaTeX dependency: ${specifier}`); });',
    '  Object.assign(_webui_katex_mhchem_stub_exports, localModule.exports?.default ?? localModule.exports);',
    '}));',
    '//#endregion',
  ].join('\n');

  let output = text.slice(0, start) + replacement.replaceAll('\n', newline) + text.slice(regionEnd);
  const offset = output.length - text.length;
  const shiftedMhchemStart = mhchemStart >= regionEnd ? mhchemStart + offset : mhchemStart;
  const shiftedMhchemEnd = mhchemEnd >= regionEnd ? mhchemEnd + offset : mhchemEnd;
  const shiftedMhchemRegionEnd = shiftedMhchemEnd + '//#endregion'.length;
  output = output.slice(0, shiftedMhchemStart) + mhchemReplacement.replaceAll('\n', newline) + output.slice(shiftedMhchemRegionEnd);
  return output;
}

const original = fs.readFileSync(target, 'utf8');
let patched = migrateWebuiKatexFallback(original);
if (!patched.includes('data-dsh-aio-katex')) patched = inlineKaTeXRuntime(patched);
if (patched !== original) fs.writeFileSync(target, patched, 'utf8');
console.log(JSON.stringify({ target, changed: patched !== original, embedded: patched.includes('data-dsh-aio-katex') }));
