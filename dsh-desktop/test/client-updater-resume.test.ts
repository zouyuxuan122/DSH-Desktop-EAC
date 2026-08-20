import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadFile } from '../client-updater.js';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

function tmpDest(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resume-'));
  return path.join(dir, name);
}

test('downloadFile resumes from .part after connection reset (206 Range)', async () => {
  const payload = Buffer.alloc(300 * 1024, 7); // 300KB
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    const range = req.headers.range;
    if (hits === 1) {
      assert.equal(range, undefined);
      // 声明 300KB 却只发 150KB 就结束 —— 模拟 net::ERR_CONNECTION_RESET
      // 之后服务端连接中断：body 被截断，客户端收到 premature close
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload.subarray(0, 150 * 1024));
      return;
    }
    const m = /^bytes=(\d+)-/.exec(range || '');
    assert.ok(m, 'second attempt must carry Range header');
    const start = Number(m[1]);
    assert.equal(start, 150 * 1024, 'resume offset must match bytes already on disk');
    const body = payload.subarray(start);
    res.writeHead(206, {
      'content-length': body.length,
      'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
    });
    res.end(body);
  });
  const port = await listen(srv);
  const dest = tmpDest('pkg.exe');
  const ctx = { log: () => {} };
  const out = await downloadFile(`http://127.0.0.1:${port}/pkg.exe`, dest, { ctx, maxAttempts: 2 });
  assert.equal(out.size, payload.length);
  assert.deepEqual(fs.readFileSync(dest), payload);
  assert.equal(hits, 2);
  srv.close();
});

test('downloadFile survives servers that ignore Range (200 full body)', async () => {
  const payload = Buffer.alloc(200 * 1024, 3);
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    // 无论是否有 Range 都回 200 全量（部分镜像的行为）
    res.writeHead(200, { 'content-length': payload.length, 'content-range': `bytes 0-${payload.length - 1}/${payload.length}` });
    res.end(payload);
  });
  const port = await listen(srv);
  const dest = tmpDest('pkg2.exe');
  // 预置一个"半截" .part，服务器却只肯给全量 —— 必须覆盖写而不是追加
  fs.writeFileSync(dest + '.part', Buffer.alloc(50 * 1024, 9));
  const out = await downloadFile(`http://127.0.0.1:${port}/pkg.exe`, dest, { ctx: { log: () => {} } });
  assert.equal(out.size, payload.length);
  assert.deepEqual(fs.readFileSync(dest), payload);
  assert.ok(hits >= 1);
  srv.close();
});

test('downloadFile discards oversized .part on 416 and restarts clean', async () => {
  const payload = Buffer.alloc(100 * 1024, 5);
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (req.headers.range) {
      const start = Number(/^bytes=(\d+)-/.exec(req.headers.range)[1]);
      if (start >= payload.length) {
        res.writeHead(416, { 'content-range': `bytes */${payload.length}` });
        res.end();
        return;
      }
    }
    res.writeHead(200, { 'content-length': payload.length });
    res.end(payload);
  });
  const port = await listen(srv);
  const dest = tmpDest('pkg3.exe');
  // .part 比真实文件长（损坏场景）→ 416 → 作废重来
  fs.writeFileSync(dest + '.part', Buffer.alloc(120 * 1024, 1));
  const out = await downloadFile(`http://127.0.0.1:${port}/pkg.exe`, dest, { ctx: { log: () => {} } });
  assert.equal(out.size, payload.length);
  assert.deepEqual(fs.readFileSync(dest), payload);
  srv.close();
});
