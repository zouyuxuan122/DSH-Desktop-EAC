/**
 * Optional install helper for the document_to_image tool's Python environment.
 *
 * The document conversion chain (LibreOffice -> PyMuPDF/fitz) runs in an
 * isolated venv at C:\Users\Administrator\doc_venv so it does not depend on
 * the global Python. This script makes sure that venv exists with pymupdf
 * installed, mirroring the pattern of scripts/setup-ocr.mjs.
 *
 * What this does:
 *  1. Locates the global Python 3.14 interpreter.
 *  2. Creates doc_venv if missing (from that interpreter).
 *  3. Installs pymupdf (fitz) into the venv from the Tsinghua PyPI mirror if
 *     `import fitz` does not already work.
 *
 * Idempotent: if the venv python exists and can import fitz, it does nothing.
 *
 * Usage: node scripts/setup-doc-venv.mjs
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_PY = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python314\\python.exe';
const VENV_PY = 'C:\\Users\\Administrator\\doc_venv\\Scripts\\python.exe';
const PYPI = 'https://pypi.tuna.tsinghua.edu.cn/simple';

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    console.error(`!! command failed (exit ${result.status})`);
    process.exit(1);
  }
}

// 1. base Python 3.14
if (existsSync(BASE_PY)) {
  console.log('[1/3] Global Python 3.14 found at ' + BASE_PY);
} else {
  console.error('!! Global Python 3.14 not found at ' + BASE_PY);
  console.error('    Install Python 3.14, or edit BASE_PY in scripts/setup-doc-venv.mjs to your interpreter.');
  process.exit(1);
}

// 2. venv
if (!existsSync(VENV_PY)) {
  console.log('[2/3] Creating doc_venv...');
  mkdirSync(dirname(VENV_PY), { recursive: true });
  run(BASE_PY, ['-m', 'venv', 'C:\\Users\\Administrator\\doc_venv']);
} else {
  console.log('[2/3] doc_venv found');
}

// 3. pymupdf
const probe = spawnSync(VENV_PY, ['-c', 'import fitz; print(fitz.__doc__ or fitz.version)'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('[3/3] Installing pymupdf (Tsinghua mirror)...');
  run(VENV_PY, ['-m', 'pip', 'install', '-i', PYPI, '--upgrade', 'pip']);
  run(VENV_PY, ['-m', 'pip', 'install', '-i', PYPI, 'pymupdf']);
} else {
  console.log(`[3/3] pymupdf already installed (${probe.stdout.trim()})`);
}

console.log('\nDone. document_to_image can now call the doc_venv Python.');
console.log('Verify: run document_to_image on a small pdf/docx and inspect the returned PNG list.');
