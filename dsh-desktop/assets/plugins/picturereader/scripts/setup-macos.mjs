/**
 * Optional install helper for the macOS OCR engine (image_ocr engine="macos").
 * Compiles scripts/macos-ocr.swift into ~/.dsh/cache/picturereader/macos-ocr
 * using swiftc (Xcode command line tools), then warms it up. Fully local —
 * no network, no Python, no third-party OCR dependency.
 *
 * Usage: node scripts/setup-macos.mjs
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir, platform, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SWIFT_SRC = join(HERE, 'macos-ocr.swift');
const BIN = process.env.DSH_MACOS_OCR_BIN ?? join(homedir(), '.dsh', 'cache', 'picturereader', 'macos-ocr');

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`!! command failed (exit ${result.status})`);
    process.exit(1);
  }
}

// 1. platform check
if (platform() !== 'darwin') {
  console.error('!! The macOS OCR engine only builds on macOS (Apple Vision framework).');
  process.exit(1);
}

// 2. Swift compiler (Xcode command line tools)
const swiftcProbe = spawnSync('xcrun', ['-f', 'swiftc'], { encoding: 'utf8' });
if (swiftcProbe.status !== 0 || !swiftcProbe.stdout.trim()) {
  console.error('!! swiftc not found. Install the Xcode command line tools first:');
  console.error('     xcode-select --install');
  process.exit(1);
}
console.log('[1/4] Xcode toolchain found (swiftc via xcrun).');

// 3. compile (module cache kept beside the binary so restricted setups never
//    touch the system clang cache). Invoke through xcrun so the macOS SDK
//    environment is resolved — calling the bare toolchain swiftc directly
//    fails with "unable to load standard library".
console.log('[2/4] Compiling macOS OCR tool...');
mkdirSync(dirname(BIN), { recursive: true });
run('xcrun', ['swiftc', '-O', '-swift-version', '5', '-module-cache-path', join(dirname(BIN), 'swift-module-cache'), SWIFT_SRC, '-o', BIN]);
console.log(`[3/4] Built: ${BIN}`);

// 4. warm-up: run once on a tiny built-in PNG and require valid JSON output.
//    (8x8 — Apple Vision rejects images smaller than 3 pixels per dimension.)
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR4nGP4jwMwDC0JALoev0Ewkwr8AAAAAElFTkSuQmCC';
const warmupPath = join(tmpdir(), `picturereader-macos-ocr-warmup-${process.pid}.png`);
writeFileSync(warmupPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
try {
  const probe = spawnSync(BIN, [warmupPath], { encoding: 'utf8', timeout: 30_000 });
  if (probe.status !== 0) {
    console.error(`!! warm-up failed (exit ${probe.status}): ${String(probe.stderr).trim().slice(-200)}`);
    process.exit(1);
  }
  const parsed = JSON.parse(probe.stdout);
  if (!Array.isArray(parsed.lines)) throw new Error('output is not {"lines":[...]}');
} catch (error) {
  console.error(`!! warm-up failed: ${error.message}`);
  process.exit(1);
} finally {
  try { existsSync(warmupPath) && import('node:fs').then((fs) => fs.rmSync(warmupPath, { force: true })); } catch {}
}
console.log('[4/4] Warm-up OK.');

console.log('');
console.log('✅ macOS OCR engine ready.');
console.log(`   binary : ${BIN}`);
console.log('   enable : DSH 设置 → 默认 OCR 引擎 → macos');
console.log('            (or pass engine="macos" to image_ocr / ocr_engine to vision_analyze)');
