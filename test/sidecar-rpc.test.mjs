'use strict';

// sidecar-rpc.test.mjs — shell-host.js stdio JSON-RPC 契约测试。
// 以真实子进程拉起 sidecar，用临时 userData/DSH_HOME 验证：
//   · 协议帧（请求/响应/事件）与错误传播
//   · profile 初始化 + 配套插件同步落盘（package.json/patch/内置清单）
//   · 保护中心快照/回滚/体检/事故报告闭环
//   · 插件管理 list/setEnabled/setRemoved
//   · 余额价格读写校验
//   · 排队任务标记解析与清理

import test from 'node:test';
import assert from 'node:assert/strict';

// 断言失败时把 sidecar 日志事件带出来（并发全量跑时的偶发问题诊断）。
function withLogs(s, fn) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      const bootLogs = s.events.filter((e) => e.event === 'log').slice(-25)
        .map((e) => `[${e.tag}] ${e.msg}`).join('\n');
      throw new Error(`${err.message}\n--- sidecar 日志尾部 ---\n${bootLogs}`);
    }
  };
}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// V-T：sidecar 已 TS 化，契约测试直接锁定编译产物（与生产运行物一致）。
const HOST = path.join(ROOT, '..', 'sidecar', 'dist', 'shell-host.js');

function tmpRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sidecar-' + name + '-'));
  return dir;
}

// 拉起 sidecar 并返回 { rpc, events, kill }。
async function startSidecar(home, userData, logs) {
  const child = spawn(process.execPath, [
    HOST,
    '--app-root', ROOT + '/..',
    '--user-data', userData,
    '--logs-dir', logs,
    '--dsh-home', home,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  const pending = new Map();
  let buf = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (Number.isFinite(msg.id) && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        resolve(msg);
      } else if (msg.event) {
        events.push(msg);
      }
    }
  });
  child.stderr.on('data', (c) => events.push({ event: 'log', tag: 'stderr', msg: String(c) }));
  const rpc = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('rpc 超时: ' + method));
      }
    }, timeoutMs);
    pending.set(id, { resolve: (m) => resolve(m), timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const kill = () => {
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  };
  // 等 ready 日志事件（sidecar 装配完成）。
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.tag === 'sidecar' && String(e.msg).includes('ready'))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { rpc, events, kill, child };
}

test('sidecar: ready 事件 + 未知方法错误', async () => {
  const home = tmpRoot('home');
  const userData = tmpRoot('userdata');
  const logs = path.join(userData, 'logs');
  const s = await startSidecar(home, userData, logs);
  try {
    assert.ok(s.events.some((e) => e.tag === 'sidecar' && String(e.msg).includes('ready')), '应有 ready 日志事件');
    const r = await s.rpc('no.such.method', {});
    assert.equal(r.ok, false);
    assert.match(r.error, /未知方法/);
  } finally {
    s.kill();
  }
});

test('sidecar: profile 初始化 + 配套插件同步落盘', async () => {
  const home = tmpRoot('home');
  const userData = tmpRoot('userdata');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const s = await startSidecar(home, userData, logs);
  try {
    const r = await s.rpc('profile.migrateAndSync', {}, 120000);
    assert.equal(r.ok, true);
    const profileDir = path.join(home, 'profiles', 'web-desktop');
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    assert.ok(fs.existsSync(path.join(profileDir, 'pnpm-workspace.yaml')));
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /id: balance/);
    assert.match(patch, /id: plugin-manager/);
    assert.match(patch, /id: composer-dynamic-island[\s\S]*?name: 'dsh-composer-dynamic-island'/);
    // 皮肤行默认禁用。
    assert.match(patch, /id: ui-skin-[\w-]+[\s\S]*?disabled: true/);
    // 内置清单标记已写。
    const marker = JSON.parse(fs.readFileSync(path.join(profileDir, '.dsh-builtin-plugins.json'), 'utf8'));
    assert.ok(marker.names.includes('@deepseek-ai/dsh-balance'));
    assert.ok(marker.names.includes('dsh-composer-dynamic-island'));
    // 配套插件包已拷贝（余额插件）。
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-balance', 'package.json')));
    const islandRoot = path.join(profileDir, 'node_modules', 'dsh-composer-dynamic-island');
    for (const rel of ['package.json', 'lib/client.js', 'dsh-plugin.json', 'docs/COMPATIBILITY.md', 'EAC-VENDOR.json']) {
      assert.ok(fs.existsSync(path.join(islandRoot, rel)), `动态岛包缺少 ${rel}`);
    }
  } finally {
    s.kill();
  }
});

test('sidecar: 保护中心快照/回滚/体检/事故闭环', async () => {
  const home = tmpRoot('home');
  const userData = tmpRoot('userdata');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const s = await startSidecar(home, userData, logs);
  try {
    await withLogs(s, async () => {
      await s.rpc('profile.migrateAndSync', {}, 120000);
      // 快照
      const snap = await s.rpc('guard.snapshot', { reason: 'test' });
      assert.equal(snap.ok, true);
      assert.ok(snap.result.id);
      // 篡改 patch 制造体检发现（重复 id 行）。
      const patchFile = path.join(home, 'profiles', 'web-desktop', 'cordis.patch.yml');
      fs.appendFileSync(patchFile, '- insert:\n    - id: balance\n      name: \'@deepseek-ai/dsh-balance\'\n');
      const hc = await s.rpc('guard.healthCheck', {});
      assert.equal(hc.ok, true);
      assert.ok(hc.result.findings.some((f) => f.code === 'PATCH_DUP_ID'), '应发现重复 patch id');
      // 回滚到快照后重复行消失。
      const rs = await s.rpc('guard.restore', { id: snap.result.id });
      assert.equal(rs.ok, true);
      const hc2 = await s.rpc('guard.healthCheck', {});
      assert.ok(!hc2.result.findings.some((f) => f.code === 'PATCH_DUP_ID'), '回滚后应无重复 patch id');
      // 事故报告。
      const inc = await s.rpc('guard.reportIncident', { title: 'test-incident', detail: 'x' });
      assert.equal(inc.ok, true);
      const status = await s.rpc('guard.action', { action: 'status' });
      assert.ok(status.result.incidents.some((i) => i.id.includes('test-incident')));
      // lastGood 标记。
      await s.rpc('guard.markGood', { id: snap.result.id });
      const good = await s.rpc('guard.lastGood', {});
      assert.equal(good.result.id, snap.result.id);
    })();
  } finally {
    s.kill();
  }
});

test('sidecar: 插件管理 list/禁用/移除', async () => {
  const home = tmpRoot('home');
  const userData = tmpRoot('userdata');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const s = await startSidecar(home, userData, logs);
  try {
    await s.rpc('profile.migrateAndSync', {}, 120000);
    const list = await s.rpc('plugin.list', {});
    assert.equal(list.ok, true);
    const rows = list.result;
    assert.ok(rows.some((r) => r.id === 'balance'));
    const core = rows.find((r) => r.id === 'plugin-manager');
    assert.equal(core.core, true);
    // 核心插件拒绝移除。
    const rm = await s.rpc('plugin.setRemoved', { id: 'plugin-manager', removed: true });
    assert.equal(rm.result.ok, false);
    // 移除普通插件 → removedPlugins 记录 + patch 行清理。
    const rm2 = await s.rpc('plugin.setRemoved', { id: 'balance', removed: true });
    assert.equal(rm2.result.ok, true);
    assert.equal(rm2.result.restartRequired, true);
    const settings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    assert.ok(settings.removedPlugins.includes('balance'));
    const list2 = await s.rpc('plugin.list', {});
    const bal = list2.result.find((r) => r.id === 'balance');
    assert.equal(bal.removed, true);
  } finally {
    s.kill();
  }
});

test('sidecar: 余额价格读写校验', async () => {
  const home = tmpRoot('home');
  const userData = tmpRoot('userdata');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const s = await startSidecar(home, userData, logs);
  try {
    const bad = await s.rpc('balance.pricesSet', { model: 'no-such-model', prices: {} });
    assert.equal(bad.result.ok, false);
    const set = await s.rpc('balance.pricesSet', {
      model: 'deepseek-v4-pro',
      prices: {
        peak: { cacheMiss: 9, cacheHit: 0.3, output: 27 },
        offpeak: { cacheMiss: 4.5, cacheHit: 0.15, output: 13.5 },
      },
    });
    assert.equal(set.result.ok, true);
    const get = await s.rpc('balance.pricesGet', { model: 'deepseek-v4-pro' });
    assert.equal(get.result.ok, true);
    assert.deepEqual(get.result.current, {
      peak: { cacheMiss: 9, cacheHit: 0.3, output: 27 },
      offpeak: { cacheMiss: 4.5, cacheHit: 0.15, output: 13.5 },
    });
    const reset = await s.rpc('balance.pricesReset', { model: 'deepseek-v4-pro' });
    assert.equal(reset.result.ok, true);
    const get2 = await s.rpc('balance.pricesGet', { model: 'deepseek-v4-pro' });
    assert.equal(get2.result.current, null);
  } finally {
    s.kill();
  }
});

test('sidecar: 排队任务标记解析与 profile 归一化', async () => {
  const home = tmpRoot('home');
  const userData = tmpRoot('userdata');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const s = await startSidecar(home, userData, logs);
  try {
    // 损坏标记：扫描时应被删除而不是崩溃。
    const profiles = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profiles, { recursive: true });
    fs.writeFileSync(path.join(profiles, '.dsh-market-pending.json'), '{broken');
    const r = await s.rpc('market.processPending', {}, 60000);
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(path.join(profiles, '.dsh-market-pending.json')), '损坏标记应被清理');
  } finally {
    s.kill();
  }
});

test('sidecar: stdin EOF 自然退出', async () => {
  const home = tmpRoot('home');
  const userData = tmpRoot('userdata');
  const logs = path.join(userData, 'logs');
  const s = await startSidecar(home, userData, logs);
  const exited = new Promise((resolve) => s.child.on('exit', resolve));
  s.kill();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  assert.notEqual(code, 'timeout', 'stdin 关闭后 sidecar 应自然退出');
});
