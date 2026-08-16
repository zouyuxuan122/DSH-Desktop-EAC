// TDD tests for the after-pack node-pty native module audit (3.0.1 Arch incident).
//
// Bug: the 3.0.1 Linux (Arch) package shipped without node-pty's linux-x64
// native module (build/Release/pty.node or prebuilds/linux-x64/pty.node).
// dsh-subprocess-local and better-sidebar then failed to load node-pty and
// dsh web exited with code 1 in a "启动失败" loop. The bundle manifest was
// written from the already-broken tree, so the boot integrity check treated
// the missing file as its own baseline and never flagged it.
//
// Fix: after-pack audits node-pty BEFORE writing the manifest and fails the
// build if the native module is absent; on Linux it also imports the module
// with the bundled Node to catch ABI mismatches.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditNodePty } from '../scripts/after-pack.js';

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-nodepty-'));
  const ptyDir = join(root, 'resources', 'app', 'node_modules', 'node-pty');
  mkdirSync(join(ptyDir, 'build', 'Release'), { recursive: true });
  mkdirSync(join(root, 'resources', 'node'), { recursive: true });
  writeFileSync(join(ptyDir, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'lib/index.js' }));
  return root;
}

test('auditNodePty throws when node-pty itself is missing from the payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-nodepty-'));
  try {
    assert.throws(() => auditNodePty(root, 'linux'), /node-pty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditNodePty throws when no linux-x64 pty.node is present (the 3.0.1 bug)', () => {
  const root = makeTree();
  try {
    assert.throws(() => auditNodePty(root, 'linux'), /pty\.node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditNodePty accepts build/Release/pty.node and imports it with the bundled node',
  { skip: process.platform === 'win32' }, () => {
    const root = makeTree();
    try {
      writeFileSync(join(root, 'resources', 'app', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'x');
      const fakeNode = join(root, 'resources', 'node', 'node');
      writeFileSync(fakeNode, '#!/bin/sh\necho "node-pty loadable @ v22.0.0"\nexit 0\n');
      chmodSync(fakeNode, 0o755);
      auditNodePty(root, 'linux');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('auditNodePty throws when the bundled node cannot import pty.node',
  { skip: process.platform === 'win32' }, () => {
    const root = makeTree();
    try {
      writeFileSync(join(root, 'resources', 'app', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'x');
      const fakeNode = join(root, 'resources', 'node', 'node');
      writeFileSync(fakeNode, '#!/bin/sh\necho "NODE_MODULE_VERSION mismatch" >&2\nexit 1\n');
      chmodSync(fakeNode, 0o755);
      assert.throws(() => auditNodePty(root, 'linux'), /无法加载 node-pty/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('auditNodePty on linux throws when the bundled node binary is absent', () => {
  const root = makeTree();
  try {
    const prebuild = join(root, 'resources', 'app', 'node_modules', 'node-pty', 'prebuilds', 'linux-x64');
    mkdirSync(prebuild, { recursive: true });
    writeFileSync(join(prebuild, 'pty.node'), 'x');
    // resources/node/node intentionally not created
    assert.throws(() => auditNodePty(root, 'linux'), /捆绑 Node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditNodePty on win32 only requires presence (no bundled-node import)', () => {
  const root = makeTree();
  try {
    writeFileSync(join(root, 'resources', 'app', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'x');
    auditNodePty(root, 'win32');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditNodePty on win32 throws when win32 pty.node is missing', () => {
  const root = makeTree();
  try {
    assert.throws(() => auditNodePty(root, 'win32'), /pty\.node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// glibc 基线审计（2026-08 Debian 事故）：在 Arch / 最新 Ubuntu 上现场编译的
// pty.node 绑定新 glibc（GLIBC_2.42），Debian 13（2.41）及更老系统加载即崩。
// after-pack 必须拦截超过支持矩阵基线（GLIBC_2.34）的 pty.node。
// 用假 objdump 注入 stdout，验证阈值逻辑，无需真实 ELF 文件。
function fakeObjdumpInPath(binDir, glibcLines) {
  const fakeObjdump = join(binDir, 'objdump');
  writeFileSync(fakeObjdump, '#!/bin/sh\nprintf "%s\\n" ' + glibcLines.map((l) => '"' + l + '"').join(' ') + '\n');
  chmodSync(fakeObjdump, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = binDir + ':' + origPath;
  return origPath;
}

function makeLoadableTree() {
  const root = makeTree();
  writeFileSync(join(root, 'resources', 'app', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'x');
  const fakeNode = join(root, 'resources', 'node', 'node');
  writeFileSync(fakeNode, '#!/bin/sh\necho "node-pty loadable @ v22.0.0"\nexit 0\n');
  chmodSync(fakeNode, 0o755);
  return root;
}

test('auditNodePty rejects pty.node whose glibc requirement exceeds the 2.34 baseline',
  { skip: process.platform === 'win32' }, () => {
    const root = makeLoadableTree();
    const binDir = mkdtempSync(join(tmpdir(), 'dsh-nodepty-bin-'));
    const origPath = fakeObjdumpInPath(binDir, ['GLIBC_2.34', 'GLIBC_2.45']);
    try {
      assert.throws(() => auditNodePty(root, 'linux'), /GLIBC_2\.45/);
    } finally {
      process.env.PATH = origPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

test('auditNodePty accepts pty.node within the 2.34 glibc baseline',
  { skip: process.platform === 'win32' }, () => {
    const root = makeLoadableTree();
    const binDir = mkdtempSync(join(tmpdir(), 'dsh-nodepty-bin-'));
    const origPath = fakeObjdumpInPath(binDir, ['GLIBC_2.17', 'GLIBC_2.31']);
    try {
      auditNodePty(root, 'linux');
    } finally {
      process.env.PATH = origPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

test('auditNodePty skips the glibc check when objdump is unavailable',
  { skip: process.platform === 'win32' }, () => {
    const root = makeLoadableTree();
    const binDir = mkdtempSync(join(tmpdir(), 'dsh-nodepty-bin-'));
    const origPath = process.env.PATH;
    try {
      // 把 PATH 指向空目录，objdump 找不到 → 跳过 glibc 检查，仅存在性 + ABI 检查
      process.env.PATH = binDir;
      auditNodePty(root, 'linux');
    } finally {
      process.env.PATH = origPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
