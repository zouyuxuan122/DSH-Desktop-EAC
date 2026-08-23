import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(join('assets', 'plugins', 'dsh-unified-market', 'lib', 'artifact-keep.mjs')).href);
const { snapshotArtifacts, restoreArtifacts, listThirdPartyPackages } = mod;

function makeProfile(root) {
  // 模拟 profile node_modules：
  //   meow-memory —— GitHub 装的第三方插件，含人工补齐的 lib/（tarball 里没有）
  //   @deepseek-ai/dsh-base —— 官方闭包（managed 前缀，不进快照）
  //   dsh-better-sidebar —— 壳层配套（managedNames，不进快照）
  const nm = join(root, 'profiles', 'web-desktop', 'node_modules');
  mkdirSync(join(nm, 'meow-memory', 'lib'), { recursive: true });
  writeFileSync(join(nm, 'meow-memory', 'package.json'), JSON.stringify({ name: 'meow-memory', version: '1.0.0', main: 'lib/index.js' }));
  writeFileSync(join(nm, 'meow-memory', 'lib', 'index.js'), 'module.exports = 1;');
  mkdirSync(join(nm, '@deepseek-ai', 'dsh-base'), { recursive: true });
  writeFileSync(join(nm, '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '2.0.0' }));
  mkdirSync(join(nm, 'dsh-better-sidebar'), { recursive: true });
  writeFileSync(join(nm, 'dsh-better-sidebar', 'package.json'), JSON.stringify({ name: 'dsh-better-sidebar', version: '0.1.0' }));
  return join(root, 'profiles', 'web-desktop');
}

test('listThirdPartyPackages skips managed prefixes and managedNames', () => {
  const t = mkdtempSync(join(tmpdir(), 'ak-list-'));
  try {
    const profile = makeProfile(t);
    const names = listThirdPartyPackages(profile, ['dsh-better-sidebar']);
    assert.deepEqual(names, ['meow-memory']);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('snapshot → pnpm 清掉 lib/ → restore 补回（meow-memory 修复场景）', () => {
  const t = mkdtempSync(join(tmpdir(), 'ak-roundtrip-'));
  try {
    const profile = makeProfile(t);
    const cache = join(t, 'plugin-artifact-cache', 'web-desktop');
    const snap = snapshotArtifacts(profile, cache, { managedNames: ['dsh-better-sidebar'], log: () => {} });
    assert.deepEqual(snap.kept, ['meow-memory']);

    // 模拟 pnpm 重新解包：lib/ 消失（tarball 里本来就没有）。
    rmSync(join(profile, 'node_modules', 'meow-memory', 'lib'), { recursive: true, force: true });

    const res = restoreArtifacts(profile, cache, { log: () => {} });
    assert.equal(res.files, 1);
    const restored = join(profile, 'node_modules', 'meow-memory', 'lib', 'index.js');
    assert.ok(existsSync(restored), 'lib/index.js 应回填');
    assert.equal(readFileSync(restored, 'utf8'), 'module.exports = 1;');
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('restore 不覆盖现存文件（只补缺）', () => {
  const t = mkdtempSync(join(tmpdir(), 'ak-nooverwrite-'));
  try {
    const profile = makeProfile(t);
    const cache = join(t, 'plugin-artifact-cache', 'web-desktop');
    snapshotArtifacts(profile, cache, { managedNames: [], log: () => {} });
    // pnpm 重装后 lib 存在但内容是新版本。
    writeFileSync(join(profile, 'node_modules', 'meow-memory', 'lib', 'index.js'), 'module.exports = 2;');
    const res = restoreArtifacts(profile, cache, { log: () => {} });
    assert.equal(res.files, 0, '现存文件不得被覆盖');
    assert.equal(readFileSync(join(profile, 'node_modules', 'meow-memory', 'lib', 'index.js'), 'utf8'), 'module.exports = 2;');
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('卸载的包清掉快照；版本变化放弃旧快照', () => {
  const t = mkdtempSync(join(tmpdir(), 'ak-version-'));
  try {
    const profile = makeProfile(t);
    const cache = join(t, 'plugin-artifact-cache', 'web-desktop');
    snapshotArtifacts(profile, cache, { managedNames: [], log: () => {} });

    // 场景 1：包被卸载（目录没了）→ 快照删除。
    rmSync(join(profile, 'node_modules', 'meow-memory'), { recursive: true, force: true });
    let res = restoreArtifacts(profile, cache, { log: () => {} });
    assert.deepEqual(res.dropped, ['meow-memory']);
    assert.equal(res.files, 0, '已卸载的包不回填');
    assert.ok(!existsSync(join(cache, 'meow-memory')), '快照应被清理');

    // 场景 2：pnpm 重装了新版本（快照时还是 1.0.0，磁盘已是 1.1.0）→ 放弃旧快照。
    mkdirSync(join(profile, 'node_modules', 'meow-memory'), { recursive: true });
    writeFileSync(join(profile, 'node_modules', 'meow-memory', 'package.json'), JSON.stringify({ name: 'meow-memory', version: '1.0.0' }));
    snapshotArtifacts(profile, cache, { managedNames: [], log: () => {} });
    writeFileSync(join(profile, 'node_modules', 'meow-memory', 'package.json'), JSON.stringify({ name: 'meow-memory', version: '1.1.0' }));
    res = restoreArtifacts(profile, cache, { log: () => {} });
    assert.ok(res.dropped.some((d) => d.includes('meow-memory')), '版本变化应放弃快照: ' + JSON.stringify(res.dropped));
    assert.equal(res.files, 0);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});
