import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const fetchKernel = readFileSync(join(root, 'scripts', 'fetch-kernel.ts'), 'utf8');
const buildNative = readFileSync(join(root, 'scripts', 'build-native.ts'), 'utf8');

test('Windows tar fallback requires the complete kernel build inputs', () => {
  assert.match(fetchKernel, /process\.platform === 'win32' && srcDir !== undefined && hasKernelBuildInputs\(srcDir\)/);
  for (const required of [
    'package.json',
    'scripts/pnpm-invocation.ts',
    'scripts/release/pack.ts',
    'scripts/release/tarball.ts',
  ]) {
    assert.match(fetchKernel, new RegExp(`'${escapeRegex(required)}'`));
  }
  assert.match(fetchKernel, /throw new Error\(`解包失败/);
});

test('Windows native builds use the MSVC target and target-specific artifact directory', () => {
  assert.match(buildNative, /const WINDOWS_MSVC_TARGET = 'x86_64-pc-windows-msvc'/);
  assert.match(buildNative, /args\.push\('--target', target\)/);
  assert.match(buildNative, /path\.join\(targetDir, target, 'release'\)/);
  assert.match(buildNative, /CARGO_BUILD_TARGET=\$\{configured\}/);
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
