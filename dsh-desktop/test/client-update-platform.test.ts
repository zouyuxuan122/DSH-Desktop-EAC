import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { checkLatest } from '../client-updater.js';

// V4 平台感知选版：上游双平台（Windows + Linux）发布后，/latest 被 Linux
// 产物占据时，Windows 客户端必须回退到最近一个含 Windows 资产的 release，
// 而不是提示一次必然失败的更新。

const ctx = () => ({ log: () => {}, userDataDir: '' });
const winAsset = (v) => ({
  name: 'Deepseek-Harness-EAC-Setup-x64.exe',
  browser_download_url: `http://x/dl-${v}.exe`,
  size: 100,
});
const linuxAssets = (v) => [
  { name: `DSH-Desktop-${v}.AppImage`, browser_download_url: `http://x/${v}.AppImage`, size: 90 },
  { name: `dsh-desktop_${v}_amd64.deb`, browser_download_url: `http://x/${v}.deb`, size: 80 },
];
const rel = (v, assets, extra = {}) => ({ tag_name: 'v' + v, assets, ...extra });

async function withApi(payload, fn) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.DSH_DESKTOP_RELEASE_API = `http://127.0.0.1:${server.address().port}/releases`;
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  try {
    return await fn();
  } finally {
    delete process.env.DSH_DESKTOP_RELEASE_API;
    await new Promise((r) => server.close(r));
  }
}

test('latest 被 Linux-only release 占据 → 回退到最近含 Windows 资产的版本', async () => {
  await withApi([
    rel('4.1.0', linuxAssets('4.1.0')),          // 最新：只有 Linux 资产
    rel('4.0.5', linuxAssets('4.0.5')),          // 次新：也只有 Linux
    rel('4.0.1', [winAsset('4.0.1')]),           // 第三个：Windows
    rel('3.9.0', [winAsset('3.9.0')]),
  ], async () => {
    const r = await checkLatest(ctx(), '4.0.0');
    assert.equal(r.version, '4.0.1', '应跳过 Linux-only 的 4.1.0/4.0.5，选中 4.0.1');
    assert.equal(r.isNewer, true);
  });
});

test('最新 release 有 Windows 资产 → 正常选最新', async () => {
  await withApi([
    rel('4.2.0', [winAsset('4.2.0'), ...linuxAssets('4.2.0')]), // 混合资产
    rel('4.1.0', [winAsset('4.1.0')]),
  ], async () => {
    const r = await checkLatest(ctx(), '4.0.0');
    assert.equal(r.version, '4.2.0');
    assert.equal(r.isNewer, true);
  });
});

test('本平台最新不比当前新 → isNewer=false（提示已是最新，而非报错）', async () => {
  await withApi([
    rel('4.1.0', linuxAssets('4.1.0')),
    rel('4.0.0', [winAsset('4.0.0')]),
  ], async () => {
    const r = await checkLatest(ctx(), '4.0.0');
    assert.equal(r.version, '4.0.0');
    assert.equal(r.isNewer, false);
  });
});

test('draft / prerelease 过滤（与 /latest 同语义）', async () => {
  await withApi([
    rel('5.0.0-rc1', [winAsset('5.0.0-rc1')], { prerelease: true }),
    rel('5.0.0', [winAsset('5.0.0')], { draft: true }),
    rel('4.2.0', [winAsset('4.2.0')]),
  ], async () => {
    const r = await checkLatest(ctx(), '4.0.0');
    assert.equal(r.version, '4.2.0');
  });
});

test('自定义镜像仍是单对象（latest 形态）也兼容', async () => {
  await withApi(rel('4.3.0', [winAsset('4.3.0')]), async () => {
    const r = await checkLatest(ctx(), '4.0.0');
    assert.equal(r.version, '4.3.0');
  });
});

test('全部 release 都没有 Windows 资产 → 明确报错（而不是选到坏资产）', async () => {
  await withApi([
    rel('4.1.0', linuxAssets('4.1.0')),
    rel('4.0.5', linuxAssets('4.0.5')),
  ], async () => {
    await assert.rejects(() => checkLatest(ctx(), '4.0.0'), /本平台/);
  });
});

test('乱入的 linux/arm64 命名 exe 不会被 selectAsset 误选', async () => {
  await withApi([
    rel('4.1.0', [
      { name: 'DSH-Desktop-Setup-4.1.0-linux-x64.exe', browser_download_url: 'http://x/l.exe', size: 100 },
      { name: 'Deepseek-Harness-EAC-Setup-x64.exe', browser_download_url: 'http://x/w.exe', size: 100 },
    ]),
  ], async () => {
    const r = await checkLatest(ctx(), '4.0.0');
    assert.equal(r.version, '4.1.0');
  });
});
