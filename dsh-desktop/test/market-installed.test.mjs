import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

// Import the ESM host module; cordis interface (name/inject/apply) is not
// exercised here — only the installed-state helpers.
const host = await import('../assets/plugins/dsh-unified-market/lib/host.js');
const { normalizeRepoUrl, readInstalledProvenance, matchInstalledPackage } = host;

const writePkg = (dir, rel, json) => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(json));
};

test('normalizeRepoUrl: 规整 github 链接为 owner/repo（小写、去 .git、容忍 /tree 路径）', () => {
  assert.equal(normalizeRepoUrl('https://github.com/Scorp1o117/dsh-tool-vision'), 'scorp1o117/dsh-tool-vision');
  assert.equal(normalizeRepoUrl('git+https://github.com/Scorp1o117/dsh-tool-vision.git'), 'scorp1o117/dsh-tool-vision');
  assert.equal(normalizeRepoUrl('https://github.com/whyihaveyou/dsh-suite/tree/main/packages/plugins/plugin-notify'), 'whyihaveyou/dsh-suite');
  assert.equal(normalizeRepoUrl(''), null);
  assert.equal(normalizeRepoUrl('https://example.com/foo/bar'), null);
});

test('readInstalledProvenance: 从已装包 package.json 的 repository/homepage 解析 owner/repo', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mkt-'));
  const base = join(home, 'profiles', 'web');
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    // scoped registry install -> key 与 repo basename 不一致（issue #17 场景）
    writePkg(base, 'package.json', {
      name: 'dsh-profile-web',
      dependencies: {
        'dsh-tool-vision': 'github:Scorp1o117/dsh-tool-vision',
        '@openma/deepseek-harness-acp': '^0.1.0',
      },
      dsh: { profile: { bundles: ['dsh-tool-vision'] } },
    });
    writePkg(base, 'node_modules/dsh-tool-vision/package.json', {
      name: 'dsh-tool-vision',
      repository: { type: 'git', url: 'git+https://github.com/Scorp1o117/dsh-tool-vision.git' },
    });
    writePkg(base, 'node_modules/@openma/deepseek-harness-acp/package.json', {
      name: '@openma/deepseek-harness-acp',
      homepage: 'https://github.com/openma-ai/deepseek-harness-acp#readme',
    });
    const prov = readInstalledProvenance('web');
    assert.equal(prov['dsh-tool-vision'], 'scorp1o117/dsh-tool-vision');
    assert.equal(prov['@openma/deepseek-harness-acp'], 'openma-ai/deepseek-harness-acp');
    assert.ok(existsSync(join(home, 'profiles', 'web', 'package.json')), '临时 profile 结构应可寻址');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('matchInstalledPackage: 依据 provenance 的 owner/repo 命中（scoped 包名 ≠ repo basename，issue #17）', () => {
  const plugin = { url: 'https://github.com/openma-ai/deepseek-harness-acp', profile: 'web' };
  const state = {
    dependencies: { '@openma/deepseek-harness-acp': '^0.1.0' },
    bundles: [],
    provenance: { '@openma/deepseek-harness-acp': 'openma-ai/deepseek-harness-acp' },
  };
  assert.equal(matchInstalledPackage(plugin, state), '@openma/deepseek-harness-acp');
});

test('matchInstalledPackage: 无 provenance 时回退 basename / github: 值匹配', () => {
  const plugin = { url: 'https://github.com/Scorp1o117/dsh-tool-vision', profile: 'web' };
  const state = { dependencies: { 'dsh-tool-vision': 'github:Scorp1o117/dsh-tool-vision' }, bundles: [] };
  assert.equal(matchInstalledPackage(plugin, state), 'dsh-tool-vision');
});

test('matchInstalledPackage: 未安装 / 空状态返回 null', () => {
  const plugin = { url: 'https://github.com/Scorp1o117/dsh-tool-vision', profile: 'web' };
  assert.equal(matchInstalledPackage(plugin, { dependencies: {}, bundles: [] }), null);
  assert.equal(matchInstalledPackage(plugin, null), null);
});