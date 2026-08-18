// check-glibc.cjs 契约测试：全仓库唯一的 glibc 基线判定实现。
//
// 背景（2026-08 Debian 事故）：node-pty 在新 glibc 构建机上现场编译会绑定
// 新 glibc 符号，老系统加载即崩。阈值（GLIBC_2.34）与扫描逻辑必须只有一份，
// after-pack / CI / 归档审计全部引用本模块。用假 objdump 注入 stdout 验证
// 解析与阈值逻辑，无需真实 ELF 文件。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASELINE, maxGlibcRef, checkFile, compareVersion, main } from '../scripts/check-glibc.cjs';

const here = dirname(fileURLToPath(import.meta.url));

function fakeObjdumpInPath(symbolLines) {
  const binDir = mkdtempSync(join(tmpdir(), 'dsh-glibc-bin-'));
  const fake = join(binDir, 'objdump');
  if (symbolLines === null) {
    // 模拟 objdump 缺失：PATH 只指向空目录
    return { binDir, restorePath: process.env.PATH };
  }
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" ' + symbolLines.map((l) => '"' + l + '"').join(' ') + '\nexit 0\n');
  chmodSync(fake, 0o755);
  return { binDir, restorePath: process.env.PATH };
}

function withFakeObjdump(symbolLines, fn) {
  const { binDir, restorePath } = fakeObjdumpInPath(symbolLines);
  process.env.PATH = symbolLines === null ? binDir : binDir + ':' + restorePath;
  try {
    return fn();
  } finally {
    process.env.PATH = restorePath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

test('baseline constant is GLIBC_2.34 (Debian 12 empirical floor)', () => {
  assert.deepEqual(DEFAULT_BASELINE, [2, 34]);
});

test('compareVersion handles 2- and 3-component glibc versions', () => {
  assert.ok(compareVersion([2, 34], [2, 34]) === 0);
  assert.ok(compareVersion([2, 34], [2, 33]) > 0);
  assert.ok(compareVersion([2, 2, 5], [2, 34]) < 0);
  assert.ok(compareVersion([2, 34], [2, 2, 5]) > 0);
  assert.ok(compareVersion([3, 0], [2, 34]) > 0);
});

test('maxGlibcRef picks the highest referenced symbol version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-glibc-'));
  const f = join(dir, 'pty.node');
  writeFileSync(f, 'x');
  try {
    const max = withFakeObjdump(['GLIBC_2.17', 'GLIBC_2.2.5', 'GLIBC_2.34'], () => maxGlibcRef(f));
    assert.deepEqual(max, [2, 34]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkFile accepts a payload at the baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-glibc-'));
  const f = join(dir, 'pty.node');
  writeFileSync(f, 'x');
  try {
    const r = withFakeObjdump(['GLIBC_2.17', 'GLIBC_2.34'], () => checkFile(f));
    assert.equal(r.ok, true);
    assert.equal(r.skipped, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkFile rejects a payload above the baseline (the Debian incident)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-glibc-'));
  const f = join(dir, 'pty.node');
  writeFileSync(f, 'x');
  try {
    const r = withFakeObjdump(['GLIBC_2.34', 'GLIBC_2.45'], () => checkFile(f));
    assert.equal(r.ok, false);
    assert.match(r.message, /GLIBC_2\.45/);
    assert.match(r.message, /GLIBC_2\.34/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkFile honors a custom baseline (stricter than default)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-glibc-'));
  const f = join(dir, 'pty.node');
  writeFileSync(f, 'x');
  try {
    const r = withFakeObjdump(['GLIBC_2.28'], () => checkFile(f, [2, 17]));
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkFile treats no-GLIBC and objdump-unavailable as skip (fail-open, as afterPack did)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-glibc-'));
  const f = join(dir, 'pty.node');
  writeFileSync(f, 'x');
  try {
    assert.equal(withFakeObjdump([], () => checkFile(f)).skipped, true);
    assert.equal(withFakeObjdump(null, () => checkFile(f)).skipped, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: exits 0 on pass, 1 on violation, 2 on usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-glibc-cli-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const fake = join(dir, 'bin', 'objdump');
  writeFileSync(fake, '#!/bin/sh\nprintf "GLIBC_2.35\\n"\nexit 0\n');
  chmodSync(fake, 0o755);
  const ok = join(dir, 'ok.node');
  const bad = join(dir, 'bad.node');
  writeFileSync(ok, 'x');
  writeFileSync(bad, 'x');
  try {
    const env = { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH };
    const run = (args) => execFileSync(process.execPath, [join(here, '..', 'scripts', 'check-glibc.cjs'), ...args],
      { env, encoding: 'utf8' });

    // bad.node 超基线 → 退出码 1
    let code = 0;
    try { run([bad]); } catch (err) { code = err.status; }
    assert.equal(code, 1);

    // --baseline 放宽到 35 → 通过，退出码 0
    const out = run(['--baseline', '35', bad]);
    assert.match(out, /OK/);

    // 无参数 → 退出码 2
    code = 0;
    try { run([]); } catch (err) { code = err.status; }
    assert.equal(code, 2);

    assert.equal(main([]), 2); // main() 直接调用同样返回 2
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
