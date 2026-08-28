/**
 * Optional install helper for the PaddleOCR engine (image_ocr engine="paddle").
 * PaddleOCR is RECOMMENDED (far better at glowing/curved/game text) but
 * OPTIONAL — image_ocr degrades to the Windows engine when it is missing.
 *
 * What this does:
 *  1. Ensures a Python 3.12+ interpreter exists (downloads the official
 *     3.12.10 installer from the npmmirror mirror if missing).
 *  2. Creates/repairs the paddle_venv.
 *  3. Installs paddlepaddle + paddleocr from the Tsinghua PyPI mirror.
 *  4. Warms the model cache by running one recognition on a test image.
 *
 * Usage: node scripts/setup-ocr.mjs
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PY312 = 'C:\\Users\\Administrator\\Python312\\python.exe';
const VENV = 'C:\\Users\\Administrator\\paddle_venv\\Scripts\\python.exe';
const INSTALLER = 'C:\\Users\\Administrator\\Downloads\\python-3.12.10-amd64.exe';
const INSTALLER_URL = 'https://registry.npmmirror.com/-/binary/python/3.12.10/python-3.12.10-amd64.exe';
const PYPI = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const CACHE = join(dirname(fileURLToPath(import.meta.url)), '..', '.paddlex-cache');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    console.error(`!! command failed (exit ${result.status})`);
    process.exit(1);
  }
}

// 1. base Python 3.12
if (!existsSync(PY312)) {
  console.log('[1/4] Python 3.12 missing — downloading installer (npmmirror mirror)...');
  run('curl.exe', ['-L', '-o', INSTALLER, INSTALLER_URL]);
  console.log('[1/4] Installing Python 3.12 to C:\\Users\\Administrator\\Python312 (user-level, silent)...');
  spawnSync(INSTALLER, [
    '/quiet', 'InstallAllUsers=0', 'TargetDir=C:\\Users\\Administrator\\Python312',
    'Include_pip=1', 'PrependPath=0', 'Include_test=0', 'Include_launcher=0'
  ], { stdio: 'inherit' });
  if (!existsSync(PY312)) {
    console.error('!! Python install did not produce ' + PY312);
    process.exit(1);
  }
} else {
  console.log('[1/4] Python 3.12 found at ' + PY312);
}

// 2. venv
if (!existsSync(VENV)) {
  console.log('[2/4] Creating paddle_venv...');
  mkdirSync(dirname(VENV), { recursive: true });
  run(PY312, ['-m', 'venv', 'C:\\Users\\Administrator\\paddle_venv']);
} else {
  console.log('[2/4] paddle_venv found');
}

// 3. paddlepaddle + paddleocr
const probe = spawnSync(VENV, ['-c', 'import paddleocr; print(paddleocr.__version__)'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('[3/4] Installing paddlepaddle + paddleocr (Tsinghua mirror, ~1-3 min)...');
  run(VENV, ['-m', 'pip', 'install', '-i', PYPI, '--upgrade', 'pip']);
  run(VENV, ['-m', 'pip', 'install', '-i', PYPI, 'paddlepaddle==3.3.1', 'paddleocr']);
} else {
  console.log(`[3/4] paddleocr already installed (${probe.stdout.trim()})`);
}

// 4. warm the model cache with one recognition
console.log('[4/4] Warming the model cache (first run downloads detection/recognition models)...');
const testImage = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures-out', 'ocr-test.png');
mkdirSync(join(CACHE), { recursive: true });
if (existsSync(testImage)) {
  const warm = spawnSync(VENV, ['-c', [
    'from paddleocr import PaddleOCR',
    "ocr = PaddleOCR(lang='ch', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, enable_mkldnn=False)",
    `result = ocr.predict(r'${testImage.replaceAll("'", "''")}')`,
    'print("warm-up OCR ok, lines:", sum(len(r.get("rec_texts") or []) for r in result))'
  ].join('; ')], {
    env: { ...process.env, PADDLE_PDX_CACHE_HOME: CACHE, PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8'
  });
  if (warm.status !== 0) {
    console.error('!! warm-up failed — see output above; the engine may still work once models download');
    process.exit(1);
  }
  console.log(warm.stdout.trim());
} else {
  console.log('[4/4] test image missing — skip warm-up (first image_ocr paddle call will download models)');
}

console.log('\nDone. image_ocr engine="paddle" is now available.');
console.log('Verify: ask the model to read an image with image_ocr(engine="paddle").');
