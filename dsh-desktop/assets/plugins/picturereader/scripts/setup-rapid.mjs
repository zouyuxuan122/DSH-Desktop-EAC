/**
 * Optional install helper for the RapidOCR engine (image_ocr engine="rapid").
 * RapidOCR is an OPTIONAL engine — image_ocr degrades to the Windows engine
 * when it is missing.
 *
 * RapidOCR uses the `rapidocr_onnxruntime` package with 3 bundled ONNX models
 * (det/rec/cls), so no network model download happens on first run.
 *
 * What this does:
 *  1. Ensures a base Python interpreter exists (default: the user Python314).
 *  2. Creates/repairs the rapid_venv.
 *  3. Installs rapidocr_onnxruntime from the Tsinghua PyPI mirror.
 *  4. Warms up by running one recognition on the OCR test image.
 *
 * Usage: node scripts/setup-rapid.mjs
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_PYTHON = process.env.DSH_RAPID_BASE_PYTHON ?? 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python314\\python.exe';
const VENV = 'C:\\Users\\Administrator\\rapid_venv\\Scripts\\python.exe';
const PYPI = 'https://pypi.tuna.tsinghua.edu.cn/simple';

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  // pwsh can mis-report pip's Chinese output as exit 1; trust the actual status.
  if (result.status !== 0) {
    console.error(`!! command failed (exit ${result.status})`);
    process.exit(1);
  }
}

// 1. base Python
if (!existsSync(BASE_PYTHON)) {
  console.error('!! base Python not found at ' + BASE_PYTHON);
  console.error('   Set DSH_RAPID_BASE_PYTHON to a valid python.exe (3.9+) and rerun.');
  process.exit(1);
}

// 2. venv
if (!existsSync(VENV)) {
  console.log('[1/3] Creating rapid_venv...');
  mkdirSync(dirname(VENV), { recursive: true });
  run(BASE_PYTHON, ['-m', 'venv', 'C:\\Users\\Administrator\\rapid_venv']);
} else {
  console.log('[1/3] rapid_venv found');
}

// 3. rapidocr_onnxruntime
const probe = spawnSync(VENV, ['-c', 'import rapidocr_onnxruntime; print(rapidocr_onnxruntime.__version__)'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('[2/3] Installing rapidocr_onnxruntime (Tsinghua mirror, ~1 min)...');
  run(VENV, ['-m', 'pip', 'install', '-i', PYPI, '--upgrade', 'pip']);
  run(VENV, ['-m', 'pip', 'install', '-i', PYPI, 'rapidocr_onnxruntime']);
} else {
  console.log(`[2/3] rapidocr_onnxruntime already installed (${probe.stdout.trim()})`);
}

// 4. warm-up with one recognition
console.log('[3/3] Warming up RapidOCR (bundled ONNX models — no download)...');
const testImage = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures-out', 'ocr-test.png');
if (existsSync(testImage)) {
  const warm = spawnSync(VENV, ['-c', [
    'import json, sys',
    'from rapidocr_onnxruntime import RapidOCR',
    "_r, _ = RapidOCR()(sys.argv[1])",
    'print("warm-up OCR ok, lines:", len(_r or []))'
  ].join('; '), testImage.replaceAll('\\', '/')], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8'
  });
  if (warm.status !== 0) {
    console.error('!! warm-up failed — see output above; the engine may still work once models are present');
    process.exit(1);
  }
  console.log(warm.stdout.trim());
} else {
  console.log('[3/3] test image missing — skip warm-up (first image_ocr rapid call loads models)');
}

console.log('\nDone. image_ocr engine="rapid" is now available.');
console.log('Verify: ask the model to read an image with image_ocr(engine="rapid").');
