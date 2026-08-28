'use strict';
// 自更新链路冒烟（P4/R6，可重复运行）：
//   Part A —— 资产选择/下载：本地 mock 发布源（DSH_DESKTOP_RELEASE_API 同源数据），
//             验证 Tauri 便携形态选中 *-portable.zip 并完成下载。
//   Part B —— 目录树交换：直接执行 buildTauriPortableApplyScript 生成的
//             apply-update.ps1（-AppPid 0 跳过等待），断言 staging → 顶层项
//             全量交换、.dsh-portable 保留、日志落盘。
//
// 用法：node update-smoke.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const cu = require(path.join(repo, 'dsh-desktop', 'client-updater.js'));

(async () => {
  // ---------- 准备：临时工作区 + 假发布包 ----------
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-smoke-'));
  const installDir = path.join(work, 'portable');
  const updatesDir = path.join(installDir, '.ud');
  const sidecarDir = path.join(installDir, 'sidecar');
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.mkdirSync(updatesDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'dsh-eac-shell.exe'), 'OLD-EXE-BYTES');
  fs.writeFileSync(path.join(installDir, '.dsh-portable'), '');
  fs.writeFileSync(path.join(sidecarDir, 'server.js'), '// old');

  // 新版本 zip：顶层 { dsh-eac-shell.exe, .dsh-portable, sidecar/server.js }
  const newTree = path.join(work, 'new-tree');
  for (const d of [path.join(newTree, 'sidecar')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(newTree, 'dsh-eac-shell.exe'), 'NEW-EXE-BYTES-v5.1.1');
  fs.writeFileSync(path.join(newTree, '.dsh-portable'), '');
  fs.writeFileSync(path.join(newTree, 'sidecar', 'server.js'), '// new v5.1.1');
  execFileSync('powershell', ['-NoProfile', '-Command',
    "$ProgressPreference='SilentlyContinue'; Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $env:P_SRC | ForEach-Object { $_.FullName }) -DestinationPath $env:P_DST -Force",
  ], { env: { ...process.env, P_SRC: newTree, P_DST: path.join(work, 'new.zip') }, stdio: 'ignore' });
  const zipBuf = fs.readFileSync(path.join(work, 'new.zip'));

  // ---------- mock 发布源 ----------
  const srv = http.createServer((req, res) => {
    if (req.url === '/releases') {
      const body = JSON.stringify([{
        tag_name: 'v5.1.1',
        name: 'v5.1.1',
        body: 'mock release',
        assets: [
          { name: 'Deepseek-Harness-EAC-5.1.1-portable.zip', browser_download_url: `${base}/new.zip`, size: zipBuf.length },
          { name: 'Deepseek-Harness-EAC_5.1.1_x64-setup.exe', browser_download_url: `${base}/setup.exe`, size: zipBuf.length },
        ],
      }]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else if (req.url === '/new.zip') {
      res.writeHead(200, { 'Content-Length': zipBuf.length });
      res.end(zipBuf);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  // 指向 mock 源（与真实镜像机制同一条 env 通道）
  process.env.DSH_DESKTOP_RELEASE_API = base + '/releases';

  try {
    // ---------- Part A：Tauri 便携形态的资产选择 + 下载 ----------
    process.env.DSH_SHELL_EXE = path.join(installDir, 'dsh-eac-shell.exe'); // exe 同级有 .dsh-portable ⇒ isTauriPortable
    check('isTauriPortable 判定（标记文件）', cu.isTauriPortable() === true);

    const ctx = { userDataDir: updatesDir, log: () => {} };
    const release = await cu.checkLatest(ctx, '5.1.0');
    check('checkLatest 经 mock 源发现 5.1.1', release.isNewer === true && release.version === '5.1.1', `v${release.version} newer=${release.isNewer}`);

    const sel = cu.selectAsset(release);
    check('selectAsset 选中 portable.zip', /\.zip$/i.test(sel.name), sel.name);

    // 用底层 downloadFile 直下（绕开 downloadRelease 的 64MB 完整包门槛——
    // 该门槛属既有冻结行为，由其单测覆盖；此处验证的是资产选择与交换链）。
    const dlPath = path.join(updatesDir, 'updates', sel.name);
    fs.mkdirSync(path.dirname(dlPath), { recursive: true });
    await cu.downloadFile(sel.parts[0].url, dlPath);
    check('downloadFile 完成且字节数一致', fs.existsSync(dlPath) && fs.statSync(dlPath).size === zipBuf.length, `${fs.statSync(dlPath).size}B`);
    const dl = { filePath: dlPath, size: zipBuf.length };

    // ---------- Part B：树交换脚本实跑 ----------
    const ps = path.join(updatesDir, 'apply-update.ps1');
    fs.writeFileSync(ps, cu.buildTauriPortableApplyScript().join('\r\n') + '\r\n');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps,
      '-ZipPath', dl.filePath, '-InstallDir', installDir, '-AppPid', '0'], { stdio: 'ignore' });

    check('新 exe 已就位', fs.readFileSync(path.join(installDir, 'dsh-eac-shell.exe'), 'utf8') === 'NEW-EXE-BYTES-v5.1.1');
    check('sidecar 已交换', fs.readFileSync(path.join(installDir, 'sidecar', 'server.js'), 'utf8') === '// new v5.1.1');
    check('.dsh-portable 标记保留', fs.existsSync(path.join(installDir, '.dsh-portable')));
    check('staging 已清理', !fs.existsSync(path.join(installDir, '.update-staging')));
    check('交换日志落盘', fs.existsSync(path.join(updatesDir, 'apply-update.log')));

    // ---------- 反向兼容：无标记时不得误判为 Tauri 便携 ----------
    fs.rmSync(path.join(installDir, '.dsh-portable'));
    delete process.env.DSH_SHELL_EXE;
    check('无 DSH_SHELL_EXE 时 isTauriPortable=false（Electron 兼容）', cu.isTauriPortable() === false);
  } finally {
    srv.close();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 临时目录尽力清理 */ }
  }

  console.log(failures === 0 ? '[update-smoke] 全部通过' : `[update-smoke] ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('[update-smoke] 异常:', e); process.exit(1); });
