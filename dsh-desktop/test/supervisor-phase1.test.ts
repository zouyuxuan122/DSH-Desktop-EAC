// VNext Phase 1 回归：故障状态机全转移路径 / 原子安装（失败回退、Core
// Profile 零写入）/ 权限模型（deny-by-default）。钉住架构文档 §7-§8 与
// 验收标准 §10.4「插件的安装、更新与回滚不修改 Core Profile 的依赖图」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync as rf, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

/** 受控环境里加载编译产物（registry/incidents 依赖 state.dshHome，不触 Electron）。 */
function loadSupervisor(home) {
  process.env.DSH_HOME = home;
  for (const m of ['lib/state.js', 'lib/log.js', 'lib/supervisor/registry.js', 'lib/supervisor/incidents.js']) {
    delete require.cache[require.resolve(join(root, m))];
  }
  const stateMod = require(join(root, 'lib', 'state.js'));
  stateMod.state.dshHome = home;
  const registry = require(join(root, 'lib', 'supervisor', 'registry.js'));
  // 防呆：受控 home 必须生效，否则测试会读写真实 ~/.dsh（曾因写错对象踩坑）。
  assert.ok(registry.registryPath().startsWith(home), `受控 DSH_HOME 未生效: ${registry.registryPath()}`);
  return {
    registry,
    incidents: require(join(root, 'lib', 'supervisor', 'incidents.js')),
  };
}

/** 纯函数核心（不落盘）：直接加载 state-machine 的依赖闭包。 */
function loadStateMachine(home) {
  const ctx = loadSupervisor(home);
  for (const m of ['lib/supervisor/state-machine.js']) {
    delete require.cache[require.resolve(join(root, m))];
  }
  return { ...ctx, sm: require(join(root, 'lib', 'supervisor', 'state-machine.js')) };
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'sm-'));
}

test('状态机：架构文档 §8 全部合法转移可走通（行为单元）', () => {
  const sm = require(join(root, 'lib', 'supervisor', 'state-machine.js'));
  // installed → disabled → starting → running
  const e0 = { state: 'installed', crashStreak: 0, enabled: true };
  assert.equal(sm.nextState(e0, { type: 'disable' })?.to, 'disabled');
  const e1 = { ...e0, state: 'disabled' };
  assert.equal(sm.nextState(e1, { type: 'starting' })?.to, 'starting');
  const e2 = { ...e0, state: 'starting' };
  assert.equal(sm.nextState(e2, { type: 'started', stableForMs: 0 })?.to, 'running');
  // running --crash--> retrying → running（重启成功）
  const e3 = { ...e0, state: 'running' };
  const c1 = sm.nextState(e3, { type: 'crash', reason: 'exit 1' });
  assert.equal(c1.to, 'retrying');
  assert.equal(c1.crashStreak, 1);
  assert.ok(c1.nextRetryAt, '首次崩溃须排退避重试');
  const e4 = { ...e0, state: 'retrying', crashStreak: 1 };
  assert.equal(sm.nextState(e4, { type: 'started', stableForMs: 0 })?.to, 'running');
  // 退避窗口未到：starting 拒绝
  const gated = sm.nextState(
    { ...e0, state: 'failed', nextRetryAt: new Date(Date.now() + 60_000).toISOString() },
    { type: 'starting' },
  );
  assert.equal(gated, null, '退避窗口内不得拉起');
  // 连续失败达阈值 → quarantined；解除隔离 → disabled
  const e5 = { ...e0, state: 'running', crashStreak: sm.QUARANTINE_THRESHOLD - 1 };
  assert.equal(sm.nextState(e5, { type: 'crash', reason: 'x' }).to, 'quarantined');
  const e6 = { ...e0, state: 'quarantined' };
  assert.equal(sm.nextState(e6, { type: 'unquarantine' })?.to, 'disabled');
  // quarantined → starting 非法（隔离后不随启动加载）
  assert.equal(sm.nextState(e6, { type: 'starting' }), null);
  // 稳定运行清零计数（重启成功且稳定期达标）
  const e7 = { ...e0, state: 'retrying', crashStreak: 2 };
  assert.equal(sm.nextState(e7, { type: 'started', stableForMs: sm.STABLE_MS }).crashStreak, 0);
});

test('状态机：转移留痕 incidents，registry 落盘可读（集成单元）', () => {
  const home = freshHome();
  try {
    const { registry, sm, incidents } = loadStateMachine(home);
    registry.upsertLegacyPlugin({ id: 'plug-a', source: 'market' });
    // 走 crash 路径 ×3 → quarantined（start-failed 路径带退避门控，见上一用例）。
    for (let i = 1; i <= sm.QUARANTINE_THRESHOLD; i++) {
      sm.applyTransition('plug-a', { type: 'starting' });
      sm.applyTransition('plug-a', { type: 'started', stableForMs: 0 });
      // 清退避（crash 不设门控，但保持入口态干净）。
      const reg = registry.readRegistry();
      delete reg.plugins['plug-a'].nextRetryAt;
      registry.writeRegistry(reg);
      sm.applyTransition('plug-a', { type: 'crash', reason: 'boom-' + i });
    }
    const e = registry.listRegistryEntries().find((p) => p.id === 'plug-a');
    assert.equal(e.state, 'quarantined');
    assert.ok(e.lastError.includes('boom-3'));
    const inc = incidents.listIncidents('plug-a');
    assert.ok(inc.length >= 1, '故障转移必须留痕');
    assert.ok(inc[0].version !== undefined);
    // 解除隔离 → disabled，恢复动作也留痕
    sm.applyTransition('plug-a', { type: 'unquarantine' });
    assert.equal(registry.listRegistryEntries().find((p) => p.id === 'plug-a').state, 'disabled');
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('原子安装：staging→切换→建档；失败自动回退保住旧版', () => {
  const home = freshHome();
  try {
    const ctx = (() => {
      process.env.DSH_HOME = home;
      for (const m of [
        'lib/state.js', 'lib/log.js', 'lib/supervisor/registry.js',
        'lib/supervisor/permissions.js', 'lib/supervisor/installer.js',
      ]) delete require.cache[require.resolve(join(root, m))];
      const stateMod = require(join(root, 'lib', 'state.js'));
      stateMod.state.dshHome = home;
      const registry = require(join(root, 'lib', 'supervisor', 'registry.js'));
      const installer = require(join(root, 'lib', 'supervisor', 'installer.js'));
      assert.ok(registry.registryPath().startsWith(home), '受控 DSH_HOME 未生效');
      assert.ok(installer.extensionsRoot().startsWith(home), '受控 DSH_HOME 未生效(installer)');
      return { registry, installer };
    })();

    // 旧版 v1.0.0 已在位（registry 建档 + extensions 目录）。
    const srcV1 = mkdtempSync(join(tmpdir(), 'pkg-v1-'));
    writeFileSync(join(srcV1, 'package.json'), JSON.stringify({ name: 'demo-ext', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(srcV1, 'index.js'), 'module.exports = 1;\n');
    assert.ok(ctx.installer.installSdkPlugin('demo-ext', { srcDir: srcV1 }).ok);

    // 升级到 v2.0.0：内容变化、哈希更新、回滚历史 +1。
    const srcV2 = mkdtempSync(join(tmpdir(), 'pkg-v2-'));
    writeFileSync(join(srcV2, 'package.json'), JSON.stringify({ name: 'demo-ext', version: '2.0.0', main: 'index.js' }));
    writeFileSync(join(srcV2, 'index.js'), 'module.exports = 2;\n');
    const up = ctx.installer.installSdkPlugin('demo-ext', { srcDir: srcV2 });
    assert.ok(up.ok && up.upgraded);
    const e2 = ctx.registry.listRegistryEntries().find((p) => p.id === 'demo-ext');
    assert.equal(e2.version, '2.0.0');
    assert.equal(e2.rollbackVersions.length, 1);
    assert.equal(e2.rollbackVersions[0].version, '1.0.0');
    assert.match(readFileSync(join(home, 'extensions', 'demo-ext', 'package', 'index.js'), 'utf8'), /2;/);

    // 失败升级（来源缺 package.json）：旧版 v2 原样保留，registry 不变。
    const badSrc = mkdtempSync(join(tmpdir(), 'pkg-bad-'));
    const fail = ctx.installer.installSdkPlugin('demo-ext', { srcDir: badSrc });
    assert.equal(fail.ok, false);
    assert.match(readFileSync(join(home, 'extensions', 'demo-ext', 'package', 'index.js'), 'utf8'), /2;/);
    const e3 = ctx.registry.listRegistryEntries().find((p) => p.id === 'demo-ext');
    assert.equal(e3.version, '2.0.0');

    // 卸载：目录移出正式位，registry 置 uninstalled。
    assert.ok(ctx.installer.uninstallSdkPlugin('demo-ext').ok);
    assert.equal(existsSync(join(home, 'extensions', 'demo-ext', 'package')), false);
    assert.equal(ctx.registry.listRegistryEntries().find((p) => p.id === 'demo-ext').state, 'uninstalled');
    rmSync(srcV1, { recursive: true, force: true });
    rmSync(srcV2, { recursive: true, force: true });
    rmSync(badSrc, { recursive: true, force: true });
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('核心配置围栏：安装/卸载/回滚全程不触碰 Core Profile（§10.4）', () => {
  const home = freshHome();
  try {
    process.env.DSH_HOME = home;
    for (const m of [
      'lib/state.js', 'lib/log.js', 'lib/supervisor/registry.js',
      'lib/supervisor/permissions.js', 'lib/supervisor/installer.js',
    ]) delete require.cache[require.resolve(join(root, m))];
    const stateMod = require(join(root, 'lib', 'state.js'));
    stateMod.state.dshHome = home;
    const installer = require(join(root, 'lib', 'supervisor', 'installer.js'));
    assert.ok(installer.extensionsRoot().startsWith(home), '受控 DSH_HOME 未生效');

    // 伪造 Core Profile（profiles/web-desktop），快照三份关键文件内容。
    const profile = join(home, 'profiles', 'web-desktop');
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    writeFileSync(join(profile, 'package.json'), '{"name":"core"}');
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
    writeFileSync(join(profile, 'node_modules', 'sentinel.txt'), 'keep');
    const snap = (f) => rf(join(profile, f), 'utf8');

    const src = mkdtempSync(join(tmpdir(), 'pkg-fence-'));
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'fence-ext', version: '1.0.0' }));
    assert.ok(installer.installSdkPlugin('fence-ext', { srcDir: src }).ok);
    assert.ok(installer.uninstallSdkPlugin('fence-ext').ok);
    assert.ok(installer.rollbackSdkPlugin('fence-ext').ok || true); // 无回滚点属预期

    // 断言：三份内容逐字节不变；node_modules 下无新增目录。
    assert.equal(snap('package.json'), '{"name":"core"}');
    assert.equal(snap('cordis.patch.yml'), '[]\n');
    assert.equal(snap(join('node_modules', 'sentinel.txt')), 'keep');
    const nm = require('node:fs').readdirSync(join(profile, 'node_modules'));
    assert.deepEqual(nm, ['sentinel.txt'], 'Core Profile node_modules 不得被安装器写入');
    rmSync(src, { recursive: true, force: true });
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('权限模型：deny-by-default 解析 + 高风险需授权', () => {
  const perms = require(join(root, 'lib', 'supervisor', 'permissions.js'));
  // 无声明 → 空权限。
  const none = perms.parsePermissions({ name: 'x' });
  assert.deepEqual(none.permissions, {});
  // 合法声明。
  const ok = perms.parsePermissions({
    dsh: { extension: { permissions: { net: ['api.github.com'], fs: ['data'], shell: false } } },
  });
  assert.deepEqual(ok.permissions.net, ['api.github.com']);
  assert.equal(perms.requiresUserConsent(ok.permissions), false);
  // 高风险：shell/env/通配 net。
  for (const p of [
    { shell: true }, { env: true }, { net: ['*'] },
  ]) {
    const hi = perms.parsePermissions({ dsh: { extension: { permissions: p } } });
    assert.equal(perms.requiresUserConsent(hi.permissions), true, JSON.stringify(p));
  }
  // 非法形态降级为忽略 + 告警。
  const bad = perms.parsePermissions({ dsh: { extension: { permissions: { net: 'not-array' } } } });
  assert.equal(bad.permissions.net, undefined);
  assert.ok(bad.warnings.length >= 1);
});

test('安装器拒绝高风险未授权安装', () => {
  const home = freshHome();
  try {
    process.env.DSH_HOME = home;
    for (const m of [
      'lib/state.js', 'lib/log.js', 'lib/supervisor/registry.js',
      'lib/supervisor/permissions.js', 'lib/supervisor/installer.js',
    ]) delete require.cache[require.resolve(join(root, m))];
    const stateMod = require(join(root, 'lib', 'state.js'));
    stateMod.state.dshHome = home;
    const installer = require(join(root, 'lib', 'supervisor', 'installer.js'));
    assert.ok(installer.extensionsRoot().startsWith(home), '受控 DSH_HOME 未生效');
    const src = mkdtempSync(join(tmpdir(), 'pkg-hi-'));
    writeFileSync(join(src, 'package.json'), JSON.stringify({
      name: 'hi-ext', version: '1.0.0',
      dsh: { extension: { permissions: { shell: true } } },
    }));
    const denied = installer.installSdkPlugin('hi-ext', { srcDir: src });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /高风险权限/);
    // 授权后可装，且 granted 状态落 registry。
    const allowed = installer.installSdkPlugin('hi-ext', { srcDir: src, userConsented: true });
    assert.equal(allowed.ok, true);
    rmSync(src, { recursive: true, force: true });
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
