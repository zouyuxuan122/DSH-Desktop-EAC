/**
 * test/plugin-copy-stamp.test.ts — 插件包戳记与拷贝语义（Task 12.2 回归）。
 *
 * 覆盖三个契约：
 *   1. 戳记命中 no-op：源未变时 copyPluginPackage 绝不重写目标（用户/修复
 *      流程对 dest 的改动不被覆盖）；
 *   2. h 哈希（rel|size|mtimeMs）：同字节数就地改写源文件也必须触发重拷
 *      （旧 {v,f,b} 戳记在此形态下误判未变化 —— NSIS 原地覆盖更新的缺口）；
 *   3. 进程内戳记缓存：invalidatePluginStampCache 后按新内容重算。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPluginPackage, pluginStampOfUncached, invalidatePluginStampCache } from '../lib/plugin-copy.js';

function makeSource(root: string, aContent: string): string {
  const src = join(root, 'src-pkg');
  mkdirSync(join(src, 'lib'), { recursive: true });
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'eac-test-pkg', version: '1.0.0' }));
  writeFileSync(join(src, 'lib', 'a.js'), aContent);
  return src;
}

test('copyPluginPackage no-op: unchanged source never rewrites dest', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pcopy-'));
  try {
    const src = makeSource(root, 'AAA');
    const profile = join(root, 'profile');
    mkdirSync(profile, { recursive: true });
    copyPluginPackage(profile, src, 'eac-test-pkg');
    const destFile = join(profile, 'node_modules', 'eac-test-pkg', 'lib', 'a.js');
    assert.ok(existsSync(destFile), 'first copy must materialize dest');
    // dest 侧做标记（模拟修复流程/用户改动）；no-op 路径不得覆盖它。
    writeFileSync(destFile, 'MUTATED-KEEP');
    copyPluginPackage(profile, src, 'eac-test-pkg');
    assert.equal(readFileSync(destFile, 'utf8'), 'MUTATED-KEEP', 'stamp hit must skip copy');
    // 缓存失效后重算戳记：内容一致 → 仍是 no-op。
    invalidatePluginStampCache();
    copyPluginPackage(profile, src, 'eac-test-pkg');
    assert.equal(readFileSync(destFile, 'utf8'), 'MUTATED-KEEP', 'recomputed stamp must still match');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('same-size in-place source edit changes stamp (h hash) and forces re-copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pcopy-'));
  try {
    const src = makeSource(root, 'AAA');
    const profile = join(root, 'profile');
    mkdirSync(profile, { recursive: true });
    copyPluginPackage(profile, src, 'eac-test-pkg');
    const srcFile = join(src, 'lib', 'a.js');
    // 就地改写为同字节数内容：size/文件数/版本全不变，只有 mtime 变。
    // Windows 文件系统连续两次写可能落在同一 mtime 刻度内（时间戳更新粒度
    // ~10ms），utimes 显式钉住两个相距悬殊的 mtime，避免刻度竞态（CI 上
    // 曾因此 flaky）。
    writeFileSync(srcFile, 'BBB');
    const tOld = 1_000_000_000;
    utimesSync(srcFile, tOld, tOld);
    const stampOld = pluginStampOfUncached(src);
    writeFileSync(srcFile, 'CCC');
    const tNew = tOld + 50_000;
    utimesSync(srcFile, tNew, tNew);
    const stampNew = pluginStampOfUncached(src);
    assert.notEqual(stampOld, stampNew, 'same-size edit must change stamp (h hash)');
    // 缓存清理后重拷：dest 得到新内容（覆盖旧 {v,f,b} 戳记漏判的缺口）。
    invalidatePluginStampCache();
    copyPluginPackage(profile, src, 'eac-test-pkg');
    const destFile = join(profile, 'node_modules', 'eac-test-pkg', 'lib', 'a.js');
    assert.equal(readFileSync(destFile, 'utf8'), 'CCC', 'changed source must re-copy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stamp cache: same source returns identical stamp across calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pcopy-'));
  try {
    const src = makeSource(root, 'AAA');
    const a = pluginStampOfUncached(src) as string;
    const b = pluginStampOfUncached(src) as string;
    assert.equal(a, b, 'deterministic walk must yield stable stamps');
    const parsed = JSON.parse(a) as { v: string; f: number; b: number; h: string };
    assert.equal(parsed.v, '1.0.0');
    assert.equal(parsed.f, 2, 'package.json + lib/a.js');
    assert.ok(/^[0-9a-f]+$/.test(parsed.h), 'h must be hex digest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
