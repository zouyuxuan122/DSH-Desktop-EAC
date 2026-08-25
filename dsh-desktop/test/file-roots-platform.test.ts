import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPathWithinRoots } = require('../lib/desktop/file-roots.js') as {
  isPathWithinRoots(candidate: string, roots: string[], platform?: NodeJS.Platform): boolean;
};

test('file root authorization rejects a symlink that escapes the session root', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-file-root-'));
  try {
    const root = join(temp, 'workspace');
    const outside = join(temp, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'linked-outside'), 'dir');

    assert.equal(isPathWithinRoots(join(root, 'linked-outside', 'secret.txt'), [root], 'linux'), false);
    assert.equal(isPathWithinRoots(join(root, 'normal.txt'), [root], 'linux'), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('file root authorization allows a not-yet-created child below a real root', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-file-root-'));
  try {
    const root = join(temp, 'workspace');
    mkdirSync(root);
    assert.equal(isPathWithinRoots(join(root, 'new', 'file.txt'), [root], 'linux'), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
