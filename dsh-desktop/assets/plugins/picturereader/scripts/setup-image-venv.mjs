/**
 * Optional install helper for the image_edit tool's Python environment.
 *
 * The image editing backend (Pillow + OpenCV, optional rembg/rawpy) runs in an
 * isolated venv at C:\Users\Administrator\image_venv, mirroring the pattern of
 * scripts/setup-doc-venv.mjs / setup-ocr.mjs.
 *
 * What this does:
 *  1. Locates the global Python 3.14 interpreter.
 *  2. Creates image_venv if missing.
 *  3. Installs core deps into the venv from the Tsinghua PyPI mirror:
 *       Pillow            (P0 基础变换 / 文字水印 / 格式互转)
 *       opencv-python-headless (P1 边缘/降噪/透视/形态学 + P2 色彩空间)
 *       piexif            (P2 EXIF 读写)
 *     Optional (pass --full):
 *       rembg             (P1 背景移除, U²-Net ~35MB, CPU 可跑, 首次下载模型)
 *       rawpy             (P2 RAW 处理, 基于 libraw)
 *
 * Idempotent: if the venv python exists and can import Pillow, it skips install.
 *
 * Usage: node scripts/setup-image-venv.mjs [--full]
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_PY = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python314\\python.exe';
const VENV_PY = 'C:\\Users\\Administrator\\image_venv\\Scripts\\python.exe';
const PYPI = 'https://pypi.tuna.tsinghua.edu.cn/simple';

const FULL = process.argv.includes('--full');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    console.error(`!! command failed (exit ${result.status})`);
    process.exit(1);
  }
}

// 1. base Python
if (existsSync(BASE_PY)) {
  console.log('[1/3] Global Python 3.14 found at ' + BASE_PY);
} else {
  console.error('!! Global Python 3.14 not found at ' + BASE_PY);
  console.error('    Install Python 3.14, or edit BASE_PY in scripts/setup-image-venv.mjs.');
  process.exit(1);
}

// 2. venv
if (!existsSync(VENV_PY)) {
  console.log('[2/3] Creating image_venv...');
  mkdirSync(dirname(VENV_PY), { recursive: true });
  run(BASE_PY, ['-m', 'venv', 'C:\\Users\\Administrator\\image_venv']);
} else {
  console.log('[2/3] image_venv found');
}

// 3. core deps
const probe = spawnSync(VENV_PY, ['-c', 'import PIL; print(PIL.__version__)'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('[3/3] Installing core image deps (Tsinghua mirror)...');
  run(VENV_PY, ['-m', 'pip', 'install', '-i', PYPI, '--upgrade', 'pip']);
  const core = ['Pillow', 'opencv-python-headless', 'piexif'];
  if (FULL) {
    core.push('rembg', 'rawpy');
  }
  run(VENV_PY, ['-m', 'pip', 'install', '-i', PYPI, ...core]);
  if (FULL) {
    // rembg 首次调用会下载 U²-Net 模型（~176MB onnx / u2netp ~4.7MB），这里不自动下载，
    // 由工具运行时按需触发。提示用户：
    console.log('\n[rembg] 背景移除模型首次运行时自动下载到 ~/.u2net，需联网一次。');
  }
} else {
  console.log(`[3/3] Pillow already installed (${probe.stdout.trim()})`);
}

console.log('\nDone. image_edit can now call the image_venv Python.');
console.log('Core: Pillow + OpenCV-headless + piexif.');
if (FULL) console.log('Optional installed: rembg (背景移除), rawpy (RAW).');
else console.log('For 背景移除/RAW, rerun with --full: node scripts/setup-image-venv.mjs --full');
console.log('Verify: run image_edit with action=resize on a small png.');
