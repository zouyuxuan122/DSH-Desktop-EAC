'use strict';

// 老用户更新链路模拟验证（无外网依赖）：
//   node scripts/sim-client-update.js
//
// 用本地 HTTP 服务模拟 GitHub Releases API + 资产下载源，覆盖：
//   1. checkLatest 解析 mock release（版本比较 isNewer）；
//   2. downloadRelease 全流程：>64MB 资产下载 + SHA-256 校验通过
//      （digest 字段路径 + SHA256SUMS.txt 路径）→ sha256Verified=true；
//   3. 哈希不一致 → 抛错、安装包被删除（绝不运行被篡改的文件）；
//   4. 上游无哈希 → 告警放行（老 Release 兼容）。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const updater = require('../client-updater.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  ✔ ' : '  ✖ ') + name + (ok ? '' : ' — ' + detail));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-sim-'));
  const assetPath = path.join(root, 'setup.exe');
  // 65MB 假安装包（> MIN_VALID_BYTES=64MB）
  const chunk = Buffer.alloc(1024 * 1024, 7);
  const out = fs.createWriteStream(assetPath);
  for (let i = 0; i < 65; i++) out.write(chunk);
  await new Promise((r) => out.end(r));
  const goodHash = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
  const badHash = 'f'.repeat(64);

  const server = http.createServer((req, res) => {
    if (req.url === '/api/release') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: 'v4.0.1',
        assets: [
          { name: 'Deepseek-Harness-EAC-Setup-x64.exe', browser_download_url: `http://127.0.0.1:${server.address().port}/dl/setup.exe`, size: fs.statSync(assetPath).size },
          { name: 'SHA256SUMS.txt', browser_download_url: `http://127.0.0.1:${server.address().port}/dl/sums`, size: 10 },
        ],
      }));
      return;
    }
    if (req.url === '/dl/setup.exe') {
      res.writeHead(200, { 'content-length': String(fs.statSync(assetPath).size) });
      fs.createReadStream(assetPath).pipe(res);
      return;
    }
    if (req.url === '/dl/sums') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${goodHash}  Deepseek-Harness-EAC-Setup-x64.exe\n`);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.DSH_DESKTOP_RELEASE_API = base + '/api/release';
  delete process.env.PORTABLE_EXECUTABLE_DIR;

  const ctx = { log: () => {}, userDataDir: path.join(root, 'userdata') };

  // 1) checkLatest
  const rel = await updater.checkLatest(ctx, '4.0.0');
  check('checkLatest 解析 mock release（v4.0.1 > 4.0.0）', rel.version === '4.0.1' && rel.isNewer === true);

  // 2) SHA256SUMS 路径：校验通过
  const r1 = await updater.downloadRelease(ctx, rel);
  check('下载 + SHA256SUMS 校验通过（sha256Verified=true）', r1.sha256Verified === true);
  check('安装包落盘', fs.existsSync(r1.filePath));

  // 3) digest 字段路径 + 哈希不一致 → 中止并删除
  {
    const relBad = JSON.parse(JSON.stringify(rel));
    relBad.assets[0].digest = `sha256:${badHash}`;
    const relBadN = updater.normalizeRelease('mock', {
      tag_name: 'v4.0.2',
      assets: relBad.assets.map((a) => ({ ...a, digest: a.digest })),
    });
    relBadN.isNewer = true;
    let threw = '';
    try { await updater.downloadRelease(ctx, relBadN); } catch (e) { threw = e.message; }
    check('哈希不一致 → 抛错中止', /SHA-256 校验失败/.test(threw), threw);
    // downloadRelease 目标文件应已删除（updates 目录里没有 setup.exe）
    const leftover = fs.readdirSync(path.join(ctx.userDataDir, 'updates')).filter((f) => f.endsWith('.exe'));
    check('被篡改的安装包已删除', leftover.length === 0, 'leftover: ' + leftover.join(','));
  }

  // 4) 无哈希 → 兼容放行
  {
    const relNoHash = updater.normalizeRelease('mock', {
      tag_name: 'v4.0.3',
      assets: [{ name: 'Deepseek-Harness-EAC-Setup-x64.exe', browser_download_url: base + '/dl/setup.exe', size: fs.statSync(assetPath).size }],
    });
    const r3 = await updater.downloadRelease(ctx, relNoHash);
    check('上游无哈希 → 放行（sha256Verified=false，大小校验兜底）', r3.sha256Verified === false);
  }

  server.close();
  setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }, 200);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n[sim-update] 结果：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('[sim-update] 异常: ' + err.message); process.exit(1); });
