import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// r7 seed 曾在仓库 seed 修正之前生成，cordis.patch.yml 里残留已删除插件的
// insert 注册（dsh-skin-switch / @sanqi-normal/dsh-webui-market-plugin），
// 安装包首启时 dsh web 以 ERR_MODULE_NOT_FOUND 崩溃。buildSeed 现在必须在
// 生成期拒绝 patch 注册与 manifest 依赖不一致的 seed。
test('public seed build rejects patch registrations absent from the manifest', () => {
  const source = fs.readFileSync(new URL('../scripts/prepare-public-seed.mjs', import.meta.url), 'utf8');
  assert.match(source, /patch registers unknown dependency/);
  assert.match(source, /yaml\.load\(configs\.get\('profiles\/web-desktop\/cordis\.patch\.yml'\)\)/);
  assert.match(source, /Object\.hasOwn\(manifest\.dependencies, item\.name\)/);
});

// 仓库占位 seed 自身必须保持干净：patch 注册的每个插件要么是 npm 依赖，要么是
// assets/plugins 内置 companion 插件（首启拷入 profile），防止把脏清单带给下一次 seed 生成。
test('repository placeholder seed keeps patch registrations aligned with real plugin sources', async () => {
  const yaml = (await import('js-yaml')).default;
  const patch = yaml.load(fs.readFileSync(new URL(
    '../distribution/profile-seed/profiles/web-desktop/cordis.patch.yml', import.meta.url), 'utf8'));
  const profile = JSON.parse(fs.readFileSync(new URL(
    '../distribution/profile-seed/profiles/web-desktop/package.json', import.meta.url), 'utf8'));
  const builtin = fs.readdirSync(new URL('../assets/plugins', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const names = patch.flatMap(entry => (entry.insert || []).map(item => item.name)).filter(Boolean);
  assert.ok(names.length >= 6, `expected companion plugin registrations, got ${names.length}`);
  for (const name of names) {
    const shortName = name.startsWith('@') ? name.split('/')[1] : name;
    const known = Object.hasOwn(profile.dependencies || {}, name) || builtin.includes(shortName);
    assert.ok(known, `cordis.patch.yml registers ${name} but it is neither a profile dependency nor a builtin plugin`);
  }
  // 已删除的插件不得回流。
  for (const retired of ['dsh-webui-market-plugin', 'dsh-market', 'dsh-offpeak']) {
    assert.ok(!names.some(name => name.includes(retired)), `retired plugin ${retired} must not be registered`);
  }
});
