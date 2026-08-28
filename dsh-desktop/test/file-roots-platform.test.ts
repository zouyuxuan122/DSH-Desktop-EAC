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

test('file root authorization rejects a symlink that escapes the session root', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-file-root-'));
  try {
    const root = join(temp, 'workspace');
    const outside = join(temp, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    try {
      symlinkSync(outside, join(root, 'linked-outside'), 'dir');
    } catch (e) {
      // Windows 无管理员/开发者模式时创建符号链接被拒（EPERM），
      // 语义由 Linux 路径域测试覆盖，环境不允许则跳过，不算失败。
      const err = e as NodeJS.ErrnoException;
      if (process.platform === 'win32' && err.code === 'EPERM') {
        t.skip('symlink requires admin rights or developer mode on Windows');
        return;
      }
      throw e;
    }

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
