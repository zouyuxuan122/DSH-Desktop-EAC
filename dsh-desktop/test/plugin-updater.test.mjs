'use strict';

// 内置插件上游更新引擎的纯函数测试（plugin-updater.js）：
// 不打真实 npm / GitHub —— 所有网络路径用 stub 隔离。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as updater from '../updater.js';
import * as pu from '../plugin-updater.js';

function tmpCtx(t) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-plugup-'));
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  return { userDataDir, log: () => {} };
}

function writePkg(dir, version, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version, ...extra }));
}

describe('版本判定', () => {
  it('hasUpdateOf: 上游更高才更新', () => {
    assert.equal(pu.hasUpdateOf('1.0.0', '1.0.1'), true);
    assert.equal(pu.hasUpdateOf('1.0.0', '1.0.0'), false);
    assert.equal(pu.hasUpdateOf('1.0.1', '1.0.0'), false);
    assert.equal(pu.hasUpdateOf('1.0.0', '1.0.0-rc.2'), false); // 预发布 < 正式版
    assert.equal(pu.hasUpdateOf(null, '1.0.0'), false);
    assert.equal(pu.hasUpdateOf('1.0.0', null), false);
  });

  it('versionOfDir 读取 package.json 版本', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vod-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(pu.versionOfDir(dir), null);
    writePkg(dir, '2.3.4');
    assert.equal(pu.versionOfDir(dir), '2.3.4');
  });

  it('currentVersionOf: profile 副本优先，资产副本回退', (t) => {
    const ctx = tmpCtx(t);
    const assets = mkdtempSync(join(tmpdir(), 'dsh-assets-'));
    const profile = mkdtempSync(join(tmpdir(), 'dsh-profile-'));
    t.after(() => { rmSync(assets, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true }); });
    writePkg(join(assets, 'pkg'), '1.0.0');
    writePkg(join(profile, 'node_modules', 'dsh-soul-md'), '1.2.0');
    const update = { npm: 'dsh-soul-md' };
    assert.equal(pu.currentVersionOf(ctx, join(assets, 'pkg'), update, profile), '1.2.0');
    assert.equal(pu.currentVersionOf(ctx, join(assets, 'pkg'), update, null), '1.0.0');
  });

  it('sourceKind / sourceName 解析', () => {
    assert.equal(pu.sourceKind({ npm: 'dsh-pet' }), 'npm');
    assert.equal(pu.sourceKind({ github: 'lire1131/dsh-undo-savepoint' }), 'github');
    assert.equal(pu.sourceKind({}), null);
    assert.equal(pu.sourceName({ npm: 'dsh-pet' }), 'dsh-pet');
    assert.equal(pu.sourceName({ github: 'lire1131/dsh-undo-savepoint' }), 'lire1131/dsh-undo-savepoint');
  });
});

describe('engines.dsh 门槛', () => {
  it('无声明放行', () => {
    assert.equal(pu.enginesGate({}, '4.2.0'), null);
    assert.equal(pu.enginesGate({ engines: {} }, '4.2.0'), null);
    assert.equal(pu.enginesGate(null, '4.2.0'), null);
  });
  it('要求 <= 当前内核放行', () => {
    assert.equal(pu.enginesGate({ engines: { dsh: '>=4.2.0' } }, '4.3.0'), null);
    assert.equal(pu.enginesGate({ engines: { dsh: '^4.2.0' } }, '4.2.1'), null);
    assert.equal(pu.enginesGate({ engines: { dsh: '4.2.0' } }, '4.2.0'), null);
  });
  it('要求高于当前内核拒绝', () => {
    const reason = pu.enginesGate({ engines: { dsh: '>=4.5.0' } }, '4.2.0');
    assert.ok(reason && reason.includes('4.5.0') && reason.includes('4.2.0'));
    assert.ok(pu.enginesGate({ engines: { dsh: '>=5.0.0' } }, '4.2.0'));
  });
  it('非法声明按放行处理', () => {
    assert.equal(pu.enginesGate({ engines: { dsh: 'hoge' } }, '4.2.0'), null);
  });
});

describe('节流 / 跳过版本 / 自动更新开关', () => {
  it('dueForCheck / markChecked 24h 节流', (t) => {
    const ctx = tmpCtx(t);
    assert.equal(pu.dueForCheck(ctx, Date.now()), true);
    pu.markChecked(ctx);
    const now = Date.now();
    assert.equal(pu.dueForCheck(ctx, now), false);
    assert.equal(pu.dueForCheck(ctx, now + 24 * 3600 * 1000 + 1), true);
  });
  it('isVersionSkipped / rememberSkip', (t) => {
    const ctx = tmpCtx(t);
    assert.equal(pu.isVersionSkipped(ctx, 'soul-md', '1.3.0'), false);
    pu.rememberSkip(ctx, 'soul-md', '1.3.0');
    assert.equal(pu.isVersionSkipped(ctx, 'soul-md', '1.3.0'), true);
    assert.equal(pu.isVersionSkipped(ctx, 'soul-md', '1.3.1'), false);
  });
  it('isAutoUpdateEnabled 默认关闭，设置后开启', (t) => {
    const ctx = tmpCtx(t);
    assert.equal(pu.isAutoUpdateEnabled(ctx), false);
    const s = updater.loadSettings(ctx);
    s.pluginAutoUpdate = true;
    updater.saveSettings(ctx, s);
    assert.equal(pu.isAutoUpdateEnabled(ctx), true);
  });
});

describe('npmLatest / githubLatest（stub 网络）', () => {
  it('npmLatest 走 registryChain，主源失败切镜像', async (t) => {
    const calls = [];
    const ctx = { ...tmpCtx(t), runNpm: async (_c, args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error('主源不可达');
      return '1.9.0\n';
    } };
    const v = await pu.npmLatest(ctx, 'dsh-pet');
    assert.equal(v, '1.9.0');
    assert.ok(calls.length >= 2, '主源失败后应切换镜像');
  });

  it('npmLatest 全源失败抛错', async (t) => {
    const ctx = { ...tmpCtx(t), runNpm: async () => { throw new Error('网络错误'); } };
    await assert.rejects(() => pu.npmLatest(ctx, 'dsh-pet'), /无法获取/);
  });

  it('githubLatest 解析 releases 标签并去掉 v 前缀', async (t) => {
    const ctx = tmpCtx(t);
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/releases/latest')) {
        return { ok: true, json: async () => ({ tag_name: 'v1.4.0' }) };
      }
      throw new Error('不应访问 tags');
    };
    t.after(() => { globalThis.fetch = original; });
    assert.equal(await pu.githubLatest(ctx, 'lire1131/dsh-undo-savepoint'), '1.4.0');
  });

  it('githubLatest releases 失败回退 tags', async (t) => {
    const ctx = tmpCtx(t);
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/releases/latest')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => [{ name: 'v0.9.1' }] };
    };
    t.after(() => { globalThis.fetch = original; });
    assert.equal(await pu.githubLatest(ctx, 'lire1131/dsh-undo-savepoint'), '0.9.1');
  });

  it('githubTarballCandidates 生成 v 前缀与非 v 前缀两个候选', () => {
    const c = pu.githubTarballCandidates('lire1131/dsh-undo-savepoint', '1.4.0');
    assert.equal(c.length, 2);
    assert.ok(c[0].includes('refs/tags/v1.4.0'));
    assert.ok(c[1].endsWith('refs/tags/1.4.0'));
  });

  it('findInstalledDir: npm 源按包名定位；GitHub 源扫描直子目录', (t) => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-fid-'));
    t.after(() => rmSync(staging, { recursive: true, force: true }));
    writePkg(join(staging, 'node_modules', 'dsh-pet'), '1.0.0');
    assert.equal(pu.findInstalledDir(staging, { npm: 'dsh-pet' }), join(staging, 'node_modules', 'dsh-pet'));
    assert.equal(pu.findInstalledDir(staging, { npm: 'dsh-other' }), null);
    // GitHub 形态：主包 + 依赖共存时选 name === basename 的那个
    writePkg(join(staging, 'node_modules', 'some-dep'), '0.1.0');
    writePkg(join(staging, 'node_modules', 'dsh-undo-savepoint'), '1.4.0', { name: 'dsh-undo-savepoint' });
    const dir = pu.findInstalledDir(staging, { github: 'lire1131/dsh-undo-savepoint' });
    assert.equal(dir, join(staging, 'node_modules', 'dsh-undo-savepoint'));
  });
});

describe('全量检测', () => {
  it('按源清单产出 { current, latest, hasUpdate, skipped }', async (t) => {
    const ctx = { ...tmpCtx(t), resolveLatest: async () => '1.5.0' };
    const assets = mkdtempSync(join(tmpdir(), 'dsh-src-'));
    t.after(() => rmSync(assets, { recursive: true, force: true }));
    writePkg(join(assets, 'dsh-pet'), '1.0.0');
    const sources = [{ id: 'dsh-pet', name: 'dsh-pet', assetsDir: join(assets, 'dsh-pet'), update: { npm: 'dsh-pet' } }];
    pu.invalidateCache();
    const list = await pu.checkPluginUpdates(ctx, sources, { force: true });
    assert.equal(list.length, 1);
    assert.equal(list[0].hasUpdate, true);
    assert.equal(list[0].current, '1.0.0');
    assert.equal(list[0].latest, '1.5.0');
    assert.equal(list[0].skipped, false);
  });

  it('单一插件解析失败不拖垮整个清单', async (t) => {
    const ctx = {
      ...tmpCtx(t),
      resolveLatest: async (_c, source) => {
        if (source.npm === 'a') throw new Error('404 未上架');
        return '2.1.0';
      },
    };
    const assets = mkdtempSync(join(tmpdir(), 'dsh-src2-'));
    t.after(() => rmSync(assets, { recursive: true, force: true }));
    writePkg(join(assets, 'a'), '1.0.0');
    writePkg(join(assets, 'b'), '2.0.0');
    const sources = [
      { id: 'a', name: 'a', assetsDir: join(assets, 'a'), update: { npm: 'a' } },
      { id: 'b', name: 'b', assetsDir: join(assets, 'b'), update: { npm: 'b' } },
    ];
    pu.invalidateCache();
    const list = await pu.checkPluginUpdates(ctx, sources, { force: true });
    const a = list.find((x) => x.id === 'a');
    const b = list.find((x) => x.id === 'b');
    assert.ok(a.error && a.error.includes('404'));
    assert.equal(a.hasUpdate, false);
    assert.equal(b.hasUpdate, true);
  });

  it('已跳过版本标记 skipped', async (t) => {
    const ctx = { ...tmpCtx(t), resolveLatest: async () => '1.5.0' };
    const assets = mkdtempSync(join(tmpdir(), 'dsh-src3-'));
    t.after(() => rmSync(assets, { recursive: true, force: true }));
    writePkg(join(assets, 'dsh-pet'), '1.0.0');
    const sources = [{ id: 'dsh-pet', name: 'dsh-pet', assetsDir: join(assets, 'dsh-pet'), update: { npm: 'dsh-pet' } }];
    pu.rememberSkip(ctx, 'dsh-pet', '1.5.0');
    pu.invalidateCache();
    const list = await pu.checkPluginUpdates(ctx, sources, { force: true });
    assert.equal(list[0].skipped, true);
    pu.rememberSkip(ctx, 'dsh-pet', '1.5.1');
    pu.invalidateCache();
    const list2 = await pu.checkPluginUpdates(ctx, sources, { force: true });
    assert.equal(list2[0].skipped, false);
  });

  it('checkCache TTL: 非 force 短时间复用结果，force 重新计算', async (t) => {
    let calls = 0;
    const ctx = { ...tmpCtx(t), resolveLatest: async () => { calls += 1; return '1.5.0'; } };
    const assets = mkdtempSync(join(tmpdir(), 'dsh-src4-'));
    t.after(() => rmSync(assets, { recursive: true, force: true }));
    writePkg(join(assets, 'dsh-pet'), '1.0.0');
    const sources = [{ id: 'dsh-pet', name: 'dsh-pet', assetsDir: join(assets, 'dsh-pet'), update: { npm: 'dsh-pet' } }];
    pu.invalidateCache();
    await pu.checkPluginUpdates(ctx, sources);      // 未命中缓存 → 1 次
    await pu.checkPluginUpdates(ctx, sources);      // 缓存命中 → 0 次
    assert.equal(calls, 1);
    await pu.checkPluginUpdates(ctx, sources, { force: true }); // force → 再 1 次
    assert.equal(calls, 2);
    pu.invalidateCache();
    await pu.checkPluginUpdates(ctx, sources);      // 失效后 → 再 1 次
    assert.equal(calls, 3);
  });
});

describe('应用更新（applyBuiltinPluginUpdate）', () => {
  it('已是最新 → noop，不动任何目录', async (t) => {
    const ctx = tmpCtx(t);
    const assets = mkdtempSync(join(tmpdir(), 'dsh-apply-'));
    t.after(() => rmSync(assets, { recursive: true, force: true }));
    writePkg(join(assets, 'dsh-pet'), '1.0.0');
    const source = { id: 'dsh-pet', name: 'dsh-pet', assetsDir: join(assets, 'dsh-pet'), update: { npm: 'dsh-pet' } };
    const r = await pu.applyBuiltinPluginUpdate(ctx, source, { latest: '1.0.0' });
    assert.equal(r.ok, true);
    assert.equal(r.noop, true);
    assert.equal(r.restartRequired, undefined);
  });

  it('完整流程: 下载 → 合并覆盖层 → 拷 profile', async (t) => {
    const ctx = tmpCtx(t);
    ctx.runNpm = async () => {
      // 模拟 npm install --prefix staging：在 staging/node_modules/dsh-pet 放新版本
      const staging = join(ctx.userDataDir, 'plugin-update-staging', 'pkg');
      writePkg(join(staging, 'node_modules', 'dsh-pet'), '1.5.0');
    };
    const assets = mkdtempSync(join(tmpdir(), 'dsh-apply2-'));
    t.after(() => rmSync(assets, { recursive: true, force: true }));
    writePkg(join(assets, 'dsh-pet'), '1.0.0');
    writeFileSync(join(assets, 'dsh-pet', 'extra.txt'), 'eac-only\n'); // EAC 附加文件
    const source = { id: 'dsh-pet', name: 'dsh-pet', assetsDir: join(assets, 'dsh-pet'), update: { npm: 'dsh-pet' } };
    let copied = null;
    const r = await pu.applyBuiltinPluginUpdate(ctx, source, {
      latest: '1.5.0',
      copyIntoProfile: (overlayDir, name) => { copied = overlayDir; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.latest, '1.5.0');
    assert.equal(r.restartRequired, false);
    const overlay = join(ctx.userDataDir, 'builtin-plugin-updates', 'dsh-pet');
    assert.equal(JSON.parse(readFileSync(join(overlay, 'package.json'), 'utf8')).version, '1.5.0');
    // EAC 附加文件保留（合并以资产副本为底）
    assert.equal(readFileSync(join(overlay, 'extra.txt'), 'utf8'), 'eac-only\n');
    assert.equal(copied, overlay);
  });

  it('guard 快照失败则中止', async (t) => {
    const ctx = tmpCtx(t);
    const assets = mkdtempSync(join(tmpdir(), 'dsh-apply3-'));
    t.after(() => rmSync(assets, { recursive: true, force: true }));
    writePkg(join(assets, 'dsh-pet'), '1.0.0');
    const source = { id: 'dsh-pet', name: 'dsh-pet', assetsDir: join(assets, 'dsh-pet'), update: { npm: 'dsh-pet' } };
    await assert.rejects(
      () => pu.applyBuiltinPluginUpdate(ctx, source, { latest: '1.5.0', guard: { snapshot: () => null } }),
      /保护快照失败/
    );
  });

  it('engines.dsh 门槛拦截更高内核要求', async (t) => {
    const ctx = tmpCtx(t);
    ctx.runNpm = async () => {
      const staging = join(ctx.userDataDir, 'plugin-update-staging', 'pkg');
      writePkg(join(staging, 'node_modules', 'dsh-pet'), '1.5.0', { engines: { dsh: '>=5.0.0' } });
    };
    const assets = mkdtempSync(join(tmpdir(), 'dsh-apply4-'));
    t.after(() => rmSync(assets, { recursive: true, force: true }));
    writePkg(join(assets, 'dsh-pet'), '1.0.0');
    const source = { id: 'dsh-pet', name: 'dsh-pet', assetsDir: join(assets, 'dsh-pet'), update: { npm: 'dsh-pet' } };
    await assert.rejects(
      () => pu.applyBuiltinPluginUpdate(ctx, source, { latest: '1.5.0', bundledDshVersion: '4.2.0' }),
      /要求 dsh 内核 >= 5.0.0/
    );
  });

  it('下载失败抛错并清理 staging', async (t) => {
    const ctx = { ...tmpCtx(t), runNpm: async () => { throw new Error('镜像全挂了'); } };
    const assets = mkdtempSync(join(tmpdir(), 'dsh-apply5-'));
    t.after(() => rmSync(assets, { recursive: true, force: true }));
    writePkg(join(assets, 'dsh-pet'), '1.0.0');
    const source = { id: 'dsh-pet', name: 'dsh-pet', assetsDir: join(assets, 'dsh-pet'), update: { npm: 'dsh-pet' } };
    await assert.rejects(() => pu.applyBuiltinPluginUpdate(ctx, source, { latest: '1.5.0' }), /下载失败/);
    assert.equal(existsSync(pu.stagingRoot(ctx)), false);
  });
});
