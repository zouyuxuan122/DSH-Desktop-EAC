// VNext Phase 2 回归：RPC 帧协议/双向 RpcPeer、job-fence 围栏（Node spawn +
// Rust assignToJob 混合围栏，降级 taskkill）、Rust 原生模块导出面。钉住架构
// 文档 §5（隔离边界）与 spec F1.1/F2.3（Job Object 围栏 + 长度前缀帧 RPC）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(dirnameOf(import.meta.url), '..');

function dirnameOf(u) {
  return path.dirname(fileURLToPath(u));
}

const { encodeFrame, FrameDecoder, RpcPeer } = require(join(root, 'lib/extension-host/rpc.js'));
const jobFence = require(join(root, 'lib/extension-host/job-fence.js'));

function join(...p) {
  return path.join(...p);
}

// ---------------------------------------------------------------------------
// 帧协议
// ---------------------------------------------------------------------------

test('帧协议：编解码往返 + 半帧跨 chunk 重组', () => {
  const msg = { kind: 'notify', method: 'evt', params: { a: 1 } };
  const frame = encodeFrame(msg);
  const dec = new FrameDecoder();
  // 逐字节喂入：极端半帧场景
  const out = [];
  for (const b of frame) out.push(...dec.push(Buffer.from([b])));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], msg);
});

test('帧协议：一 chunk 多消息 + 残留', () => {
  const a = encodeFrame({ kind: 'notify', method: 'm1' });
  const b = encodeFrame({ kind: 'notify', method: 'm2' });
  const dec = new FrameDecoder();
  const msgs = dec.push(Buffer.concat([a, b.subarray(0, 3)]));
  assert.equal(msgs.length, 1);
  const rest = dec.push(b.subarray(3));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].method, 'm2');
});

test('帧协议：超限帧断流（防恶意 Host）', () => {
  const dec = new FrameDecoder();
  const head = Buffer.alloc(4);
  head.writeUInt32LE(5 * 1024 * 1024, 0);
  assert.throws(() => dec.push(head), /超限/);
});

// ---------------------------------------------------------------------------
// RpcPeer 双向：请求/应答/超时/通知/断开
// ---------------------------------------------------------------------------

function makePair() {
  // 内存双管道：a.write → b.feed，模拟 Supervisor ↔ Host stdio
  const a2b = new PassThrough();
  const b2a = new PassThrough();
  const peerA = new RpcPeer({ write: a2b });
  const peerB = new RpcPeer({ write: b2a });
  a2b.on('data', (c) => peerB.feed(c));
  b2a.on('data', (c) => peerA.feed(c));
  return { peerA, peerB };
}

test('RpcPeer：双向请求/应答 + 通知', async () => {
  const { peerA, peerB } = makePair();
  peerB.handle('add', (p) => p.x + p.y);
  peerA.notify('hello', { from: 'supervisor' });
  const res = await peerA.request('add', { x: 1, y: 2 });
  assert.equal(res, 3);
  peerB.handle('boom', () => {
    throw new Error('插件炸了');
  });
  await assert.rejects(peerA.request('boom'), /插件炸了/);
  peerA.close('test-done');
  peerB.close('test-done');
});

test('RpcPeer：请求超时拒绝 + close 拒绝在途请求', async () => {
  const { peerA, peerB } = makePair();
  // peerB 注册 echo 但永不应答（模拟 Host 卡死），peerA 超时
  peerB.handle('echo', () => new Promise(() => {}));
  await assert.rejects(peerA.request('echo', {}, 80), /超时/);
  // 在途请求被 close 拒绝
  const p = peerA.request('echo', {}, 5000);
  setTimeout(() => peerA.close('peer-quit'), 60);
  await assert.rejects(p, /对端断开/);
  peerB.close('done');
});

// ---------------------------------------------------------------------------
// job-fence：native 探测 / 降级 / 围栏 spawn
// ---------------------------------------------------------------------------

test('job-fence：native 模块可加载且导出面完整（本机为 Windows 构建路径）', () => {
  const native = jobFence.loadNativeSupervisor();
  if (process.platform === 'win32') {
    assert.ok(native, 'Windows 上 index.node 必须可用（build:native 产物）');
    for (const fn of ['createJob', 'assignToJob', 'terminateJob', 'jobAlive', 'closeJob', 'sha256Stream']) {
      assert.equal(typeof native[fn], 'function', `导出缺 ${fn}`);
    }
  } else {
    assert.equal(native, null, '非 Windows 应降级');
    assert.equal(jobFence.fenceMode(), 'taskkill-fallback');
  }
});

test('job-fence：fenceMode 与 createFence 模式一致；stdio 管道 + onExit 回调', async () => {
  const fence = jobFence.createFence();
  if (jobFence.fenceMode() === 'win32-job') {
    assert.equal(fence.mode, 'win32-job');
  }
  // spawn 一个真实 node 子进程（两种模式共用路径），验证 stdio 管道 + 退出感知
  const childScript = 'process.stdin.on("data",(c)=>{process.stdout.write("ack:"+c.toString().trim());process.exit(0)})';
  const h = fence.launch(process.execPath, ['-e', childScript]);
  assert.ok(h.pid > 0);
  assert.equal(h.mode, fence.mode);
  const exited = new Promise((r) => h.onExit(r));
  const got = new Promise((r) => {
    let buf = '';
    h.stdout.on('data', (c) => { buf += c.toString(); });
    h.stdout.on('end', () => r(buf));
    setTimeout(() => r(buf), 3000);
  });
  h.stdin.write('ping\n');
  const out = await got;
  assert.match(out, /ack:ping/);
  const code = await exited;
  assert.equal(code, 0, '子进程应自退出且退出码 0');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.alive(), false, '自退出后不得存活');
  h.dispose();
});

test('job-fence：kill() 强杀长驻进程（树回收）', async () => {
  const fence = jobFence.createFence();
  const h = fence.launch(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const exited = new Promise((r) => h.onExit(r));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.alive(), true, '长驻进程必须在围栏内存活');
  await h.kill();
  await exited;
  assert.equal(h.alive(), false, 'kill 后不得存活');
  // 幂等
  await h.kill();
});

test('job-fence：native sha256Stream 与 node crypto 一致', async () => {
  const native = jobFence.loadNativeSupervisor();
  if (!native) return; // 非 Windows 跳过
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sha-'));
  const file = path.join(dir, 'blob.bin');
  const blob = Buffer.alloc(300 * 1024); // 跨 64KB 块
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 7) & 0xff;
  fs.writeFileSync(file, blob);
  const crypto = await import('node:crypto');
  const expect = crypto.createHash('sha256').update(blob).digest('hex');
  assert.equal(native.sha256Stream(file), expect);
  fs.rmSync(dir, { recursive: true, force: true });
});
