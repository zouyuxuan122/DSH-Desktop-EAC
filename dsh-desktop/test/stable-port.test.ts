import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  CHROMIUM_RESTRICTED_PORTS,
  restrictedPortOf,
  chooseStableWebPort,
} = require(join(root, 'stable-port.js'));

// --- CHROMIUM_RESTRICTED_PORTS ----------------------------------------------

test('CHROMIUM_RESTRICTED_PORTS 包含已知 Chromium 受限端口（6000/7/22/25）', () => {
  for (const p of [1, 7, 22, 25, 6000, 6667, 10080]) {
    assert.ok(CHROMIUM_RESTRICTED_PORTS.has(p), `应包含 ${p}`);
  }
  for (const p of [0, 8080, 3000, 5173]) {
    assert.ok(!CHROMIUM_RESTRICTED_PORTS.has(p), `不应包含 ${p}`);
  }
});

// --- restrictedPortOf -------------------------------------------------------

test('restrictedPortOf: 命中受限端口返回端口号，否则返回 0', () => {
  assert.equal(restrictedPortOf('http://127.0.0.1:6000/'), 6000);
  assert.equal(restrictedPortOf('http://127.0.0.1:7/'), 7);
  assert.equal(restrictedPortOf('http://127.0.0.1:8080/'), 0);
  assert.equal(restrictedPortOf('http://127.0.0.1:80/'), 0); // 80 不在受限列表
  assert.equal(restrictedPortOf('https://127.0.0.1:443/'), 0); // 443 不在受限列表
});

test('restrictedPortOf: https 默认端口 443 不被误判为受限', () => {
  assert.equal(restrictedPortOf('https://example.com/'), 0);
});

test('restrictedPortOf: 无效 URL 返回 0', () => {
  assert.equal(restrictedPortOf('not-a-url'), 0);
  assert.equal(restrictedPortOf(''), 0);
});

// --- chooseStableWebPort ----------------------------------------------------

// 用伪造的 settings 读写器，避免依赖真实 Electron updater
function fakeCtx(dir) {
  return {
    userDataDir: dir,
    log: () => {},
    loadSettings: () => {
      try {
        const f = join(dir, 'settings.json');
        const j = JSON.parse(require('fs').readFileSync(f, 'utf8'));
        return j;
      } catch {
        return {};
      }
    },
    saveSettings: (_ctx, s) => {
      require('fs').writeFileSync(join(dir, 'settings.json'), JSON.stringify(s));
    },
  };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

test('chooseStableWebPort: 无偏好端口时选一个非受限的可用端口并保存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-port-'));
  try {
    const ctx = fakeCtx(dir);
    const port = await chooseStableWebPort(ctx);
    assert.ok(port > 0, '应返回有效端口');
    assert.ok(!CHROMIUM_RESTRICTED_PORTS.has(port), `返回的端口 ${port} 不应在受限列表中`);
    assert.ok(await isPortFree(port), `返回的端口 ${port} 应可用`);
    // 持久化到 settings
    const saved = ctx.loadSettings(ctx);
    assert.equal(saved.webPort, port, '应把端口写入 settings.webPort');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chooseStableWebPort: 偏好端口可用时复用并保存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-port-'));
  try {
    // 预置偏好端口
    const ctx = fakeCtx(dir);
    ctx.saveSettings(ctx, { webPort: 0 }); // 先初始化
    // 选一个空闲端口作为偏好
    const probe = net.createServer();
    const preferred = await new Promise((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });
    ctx.saveSettings(ctx, { webPort: preferred });
    const port = await chooseStableWebPort(ctx);
    assert.equal(port, preferred, '应复用偏好端口');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chooseStableWebPort: 偏好端口被占用时回落到空闲端口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-port-'));
  try {
    const ctx = fakeCtx(dir);
    // 占用一个端口作为偏好
    const holder = net.createServer();
    const occupied = await new Promise((resolve) => {
      holder.listen(0, '127.0.0.1', () => resolve(holder.address().port));
    });
    ctx.saveSettings(ctx, { webPort: occupied });
    const port = await chooseStableWebPort(ctx);
    assert.notEqual(port, occupied, '不应返回被占用端口');
    assert.ok(port > 0);
    assert.ok(await isPortFree(port));
    holder.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chooseStableWebPort: 偏好端口在受限列表时回落到空闲端口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-port-'));
  try {
    const ctx = fakeCtx(dir);
    ctx.saveSettings(ctx, { webPort: 6000 }); // 受限端口
    const port = await chooseStableWebPort(ctx);
    assert.notEqual(port, 6000, '不应返回受限端口');
    assert.ok(port === 0 || !CHROMIUM_RESTRICTED_PORTS.has(port));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chooseStableWebPort: 空闲端口恰好命中受限端口时重试选非受限', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-port-'));
  try {
    const ctx = fakeCtx(dir);
    const port = await chooseStableWebPort(ctx, { maxFreeRetries: 20 });
    assert.ok(port === 0 || !CHROMIUM_RESTRICTED_PORTS.has(port),
      '即使经过多次重试，最终也不应落在受限列表中');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
