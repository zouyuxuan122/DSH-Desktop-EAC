// RED: diagnostics zip 构建（AC-8: entries 清单 + PII 二次脱敏 + 不包含用户大备份 zip）
// Source: plan/logging-system.md step 2.5 + spec AC-8
//  Acceptance:
//   - AC-8 导出 zip 包含：diagnostics.json（版本/系统/启动时间/boot trace）、manifest.json（entries 列表 + size/mtime/hash）
//     logs/main.00 ... main.09（全部 rolled logs）
//     config/settings.json, config/dsh-settings.yaml, config/profile/cordis.patch.yml
//     updater/pending-client-update-*.json（增量更新元数据）
//     updater/backup/latest.manifest.json（只取最新备份 manifest，不带整个备份目录 zip）
//   - 打包前对配置文件再跑一次 deepRedact（保证 backup manifest 里的路径不泄漏 PII）
//   - zip 文件本身不包含 dshHome/**/*.zip（排除用户已有的备份 zip/tar.gz/7z 大文件，省下载带宽）
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const logger = require(path.resolve(__dirname, '..', 'logger.js'));
const unzipper = require('unzipper');

function mkdtmp(suffix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diag-' + suffix + '-'));
  process.on('beforeExit', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
  return d;
}

function setupFakeHome() {
  const fake = mkdtmp('env');
  const logsDir    = path.join(fake, 'logs');
  const userData   = path.join(fake, 'userData');
  const dshHome    = path.join(fake, 'dshHome');
  const profileDir = path.join(userData, 'profiles', 'web-desktop');
  const backupDir  = path.join(dshHome, 'updater', 'backup', '2025-07-01T00-00-00Z');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  // logs/main.00
  fs.writeFileSync(path.join(logsDir, 'main.00'),
    JSON.stringify({ level: 30, time: new Date().toISOString(), msg: 'hi line 1', sk: 'sk-ant-abcdefghijklmnopqrstuvw' }) + '\n' +
    JSON.stringify({ level: 30, time: new Date().toISOString(), msg: 'hi line 2' }) + '\n'
  );
  // logs/main.01
  fs.writeFileSync(path.join(logsDir, 'main.01'),
    JSON.stringify({ level: 40, time: new Date().toISOString(), msg: 'old warn 1' }) + '\n'
  );

  // userData/settings.json
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    userId: 'u_12345', password: 'should-be-masked', windowState: { w: 1024, h: 768 }
  }, null, 2));

  // userData/dsh-settings.yaml
  fs.writeFileSync(path.join(userData, 'dsh-settings.yaml'), [
    'apiKey: sk-ant-1234567890abcdef',
    'defaultHost: localhost',
    'user:',
    '  email: alice@example.com',
    '  token: tkn_abcdefghijk',
  ].join('\n'));

  // profile cordis.patch.yml
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    'overrides:',
    '  market.endpoint: https://example.com',
    '  market.apiKey: SECxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  ].join('\n'));

  // updater/pending-client-update-v4.3.0.json
  fs.writeFileSync(path.join(dshHome, 'updater', 'pending-client-update-v4.3.0.json'), JSON.stringify({
    version: '4.3.0',
    sha256: 'abc123',
    url: 'https://example.com/dsh-4.3.0.exe',
    addedPlugins: ['plugin-a', 'plugin-b'],
    removedPluginIds: ['plugin-c'],
  }, null, 2));

  // latest backup manifest.json
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    paths: {
      // paths may contain home directory (PII)
      installDir: os.homedir() + '\\AppData\\Local\\Programs\\dsh-desktop',
      userDataDir: path.join(userData),
      dshHome: dshHome,
    },
    // a huge binary backup zip (should NOT be included in diagnostics zip)
  }, null, 2));
  // put a big fake 10MB backup zip alongside manifest — must NOT appear in entries
  const bigZip = path.join(backupDir, 'backup.7z');
  fs.writeFileSync(bigZip, Buffer.alloc(10 * 1024 * 1024, 0)); // 10MB, should be skipped

  return { fake, logsDir, userData, dshHome, profileDir, backupDir };
}

// Extract zip via PowerShell + .NET ZipFile (Windows built-in, no extra module)
async function extractZip(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform !== 'win32') {
    await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: outDir })).promise();
    return;
  }
  const ps = [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
    `$zip = '${zipPath.replace(/'/g, "''")}'`,
    `$out = '${outDir.replace(/'/g, "''")}'`,
    `if (Test-Path $out) { Get-ChildItem $out -Recurse | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue }`,
    `New-Item -ItemType Directory -Force -Path $out | Out-Null`,
    `[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $out)`,
    `exit 0`,
  ].join('; ');
  try { execSync(`powershell.exe -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\"')}"`, { stdio: 'pipe', timeout: 60000 }); }
  catch (e) { throw new Error('Zip Extract failed: ' + (e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + e.message); }
}

test('AC-8.1 buildDiagnosticsZip 存在 & 返回 Promise<zipPath>', async () => {
  assert.equal(typeof logger.buildDiagnosticsZip, 'function',
    'logger.buildDiagnosticsZip should be function (RED fail expected here first impl run)');
});

test('AC-8.2 导出 zip entries 齐全且排除大备份归档', { timeout: 90000 }, async () => {
  const env = setupFakeHome();
  // 先 init logger，这样 buildDiagnosticsZip 有 bootTraceId
  logger.init({ logsDir: env.logsDir, level: 'info', appVersion: '4.3.0', env: 'test' });

  const opts = {
    logsDir: env.logsDir,
    userDataDir: env.userData,
    dshHome: env.dshHome,
    // outDir: 自动放到 <fake>/out
    outDir: path.join(env.fake, 'diag-out'),
  };
  fs.mkdirSync(opts.outDir, { recursive: true });
  const zipPath = await logger.buildDiagnosticsZip(opts);
  assert.ok(zipPath && typeof zipPath === 'string', `应返回 zip 路径，got: ${zipPath}`);
  assert.ok(fs.existsSync(zipPath), `zip 文件应存在：${zipPath}`);
  const zipSt = fs.statSync(zipPath);
  assert.ok(zipSt.size > 300, `zip 文件 size=${zipSt.size} 不应为空`);

  // Extract
  const extractDir = path.join(env.fake, 'extracted');
  await extractZip(zipPath, extractDir);

  const files = fs.readdirSync(extractDir, { recursive: true }).map(String);
  const has = (p) => files.includes(p) || files.some(f => f === p || f.replace(/\\/g, '/').endsWith(p.replace(/\\/g, '/')));
  const find = (suff) => files.find(f => f.replace(/\\/g, '/').endsWith(suff));

  // --- Top-level required entries ---
  assert.ok(has('diagnostics.json'), `缺失 diagnostics.json，现有 entries：\n${files.join('\n')}`);
  assert.ok(has('manifest.json'),      `缺失 manifest.json，现有 entries：\n${files.join('\n')}`);

  // --- logs ---
  assert.ok(find('logs/main.00'), `缺失 logs/main.00`);
  assert.ok(find('logs/main.01'), `缺失 logs/main.01`);

  // --- configs ---
  assert.ok(find('config/settings.json'), `缺失 config/settings.json`);
  assert.ok(find('config/dsh-settings.yaml'), `缺失 config/dsh-settings.yaml`);
  assert.ok(find('config/profile/cordis.patch.yml'), `缺失 config/profile/cordis.patch.yml`);

  // --- updater ---
  assert.ok(find('updater/pending-client-update-v4.3.0.json'), `缺失 updater pending update meta`);
  // Only latest backup manifest — not the 10MB backup.7z
  assert.ok(find('updater/backup/latest.manifest.json'), `缺失 updater/backup/latest.manifest.json`);
  for (const f of files) {
    assert.ok(!/backup\.(zip|7z|tar|gz|tgz|rar)$/i.test(f),
      `不应包含备份大归档文件，发现 entry: ${f}`);
  }

  // --- diagnostics.json metadata ---
  const diag = JSON.parse(fs.readFileSync(path.join(extractDir, 'diagnostics.json'), 'utf8'));
  assert.equal(typeof diag.bootTraceId, 'string', 'diagnostics.bootTraceId 应为 string');
  assert.ok(diag.bootTraceId.length > 5, `diagnostics.bootTraceId 过短: ${diag.bootTraceId}`);
  assert.equal(typeof diag.appVersion, 'string', 'diagnostics.appVersion 应为 string');
  assert.equal(typeof diag.exportedAt, 'string', 'diagnostics.exportedAt 应为 ISO string');
  assert.equal(typeof diag.totalSize, 'number', 'diagnostics.totalSize 应为 bytes number');
  assert.ok(diag.totalSize > 0, 'totalSize > 0');

  // --- manifest.json entries list ---
  const mani = JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(mani.entries), 'manifest.entries 应为 array');
  for (const e of mani.entries) {
    assert.equal(typeof e.name, 'string', 'entry.name 必须 string');
    assert.equal(typeof e.size, 'number', 'entry.size 必须 number');
    assert.ok(e.name && !e.name.startsWith('/') && !e.name.match(/^[A-Z]:/),
      `entry.name 应为相对路径，got: ${e.name}`);
    // each manifest entry exists on disk inside extract dir
    const disk = path.join(extractDir, ...e.name.split('/'));
    assert.ok(fs.existsSync(disk), `manifest 声明条目 ${e.name} 在 ${disk} 实际不存在`);
  }

  // --- PII re-redact on configs ---
  const settings = JSON.parse(fs.readFileSync(
    path.join(extractDir, ...(find('config/settings.json').split(/[\/\\]/))), 'utf8'));
  assert.equal(settings.password, '***',
    `打包 settings.json 前应再跑 PII 脱敏 password='***'，实际: ${JSON.stringify(settings)}`);

  // cleanup logger for other tests
  logger.close();
});
