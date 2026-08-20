import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { computeSha256, fetchSumsMap, expectedSha256, normalizeRelease } from '../client-updater.js';

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const ctx = { log: () => {}, userDataDir: '' };

test('computeSha256 输出与 node crypto 一致（小写 hex）', async () => {
  const t = mkdtempSync(join(tmpdir(), 'sha-'));
  try {
    const file = join(t, 'blob.bin');
    writeFileSync(file, Buffer.from('hello dsh'));
    const expected = crypto.createHash('sha256').update('hello dsh').digest('hex');
    assert.equal(await computeSha256(file), expected);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('normalizeRelease 摘取 GitHub digest 字段（V4 内容校验数据源）', async () => {
  const good = crypto.createHash('sha256').update('x').digest('hex');
  const rel = normalizeRelease('GitHub', {
    tag_name: 'v4.0.0',
    assets: [
      { name: 'Deepseek-Harness-EAC-Setup-x64.exe', browser_download_url: 'http://x/', size: 100, digest: `sha256:${good}` },
      // 非法 digest 形态（非 sha256 前缀）应被忽略，不留脏数据。
      { name: 'other.exe', browser_download_url: 'http://y/', size: 1, digest: 'md5:zz' },
    ],
  });
  assert.equal(rel.assets[0].sha256, good);
  assert.equal(rel.assets[1].sha256, undefined);
  const got = await expectedSha256(ctx, rel, { parts: [rel.assets[0]], name: rel.assets[0].name });
  assert.equal(got, good);
});

test('expectedSha256：digest 缺失时回落 SHA256SUMS.txt 条目', async () => {
  const hex1 = 'a'.repeat(64);
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${hex1}  Deepseek-Harness-EAC-Setup-x64.exe\n${'b'.repeat(64)}  other.exe\n`);
  }, async (base) => {
    const rel = {
      version: '4.0.0',
      assets: [
        { name: 'Deepseek-Harness-EAC-Setup-x64.exe', url: base + '/setup.exe', size: 100 },
        { name: 'SHA256SUMS.txt', url: base + '/SHA256SUMS.txt', size: 10 },
      ],
    };
    const got = await expectedSha256(ctx, rel, { parts: [rel.assets[0]], name: rel.assets[0].name });
    assert.equal(got, hex1);
  });
});

test('fetchSumsMap 解析标准 sha256sum 格式（* 二进制标记、大小写文件名）', async () => {
  const hex1 = 'c'.repeat(64);
  const hex2 = 'd'.repeat(64);
  await withServer((req, res) => {
    res.writeHead(200);
    res.end(`${hex1}  file-a.exe\n${hex2} *File-B.exe\nnot-a-hash-line\n`);
  }, async (base) => {
    const rel = { assets: [{ name: 'SHA256SUMS.txt', url: base + '/sums' }] };
    const map = await fetchSumsMap(ctx, rel);
    assert.equal(map.get('file-a.exe'), hex1);
    assert.equal(map.get('file-b.exe'), hex2);
    assert.equal(map.size, 2);
  });
});

test('expectedSha256：两者皆无 → null（老 release 兼容，跳过校验）', async () => {
  const rel = {
    version: '3.1.0',
    assets: [{ name: 'Deepseek-Harness-EAC-Setup-x64.exe', url: 'http://x/', size: 100 }],
  };
  assert.equal(await expectedSha256(ctx, rel, { parts: rel.assets, name: rel.assets[0].name }), null);
});
