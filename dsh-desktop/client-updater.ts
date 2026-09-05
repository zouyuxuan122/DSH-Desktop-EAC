'use strict';

// Deepseek Harness EAC 客户端自更新引擎（更新“封装客户端本身”，与 updater.js 的
// dsh agent 更新互相独立）。
//
// 流程：
//   1. checkLatest(): 依次查询上游发布源（GitHub Releases → Gitee Releases，
//      可用环境变量 DSH_DESKTOP_RELEASE_API 指向自定义镜像 API），取 latest
//      release 的 tag 作为版本号，与当前 APP_VERSION 比较。
//   2. selectAsset(): 按当前部署形态选择安装包 —— 便携版选
//      *-portable-x64.exe；安装版选 Setup-*-x64.exe。Gitee 因单文件 100MB
//      限制把安装包拆成 .part1/.part2 分片，此时自动按序下载并拼接。
//   3. downloadRelease(): 流式下载（带进度回调）到 <userData>/updates/。
//   4. applyUpdate(): 便携版写纯 ASCII cmd 做原地替换；安装版写纯 ASCII
//      PowerShell 辅助脚本，按当前主进程 PID 等待/兜底结束后启动 Setup。
//      便携版启动方式是整行引用 + /d /s /c：spawn('cmd.exe',
//      ['/c', script, a1, a2]) 让 Node 给每个含空格参数加引号，cmd /c 的
//      剥引号规则会把首尾引号剥掉，路径在空格处断开 → "'C:\...\Deepseek'
//      is not recognized" 且被 stdio:'ignore' 吞掉 → 脚本静默不执行，
//      用户点“立即重启”后毫无反应（v2.0.x 反馈）。/s + 外层再包一对引号
//      剥掉后原样还原为带引号参数行；参数经 Unicode 命令行传递，中文
//      用户名不受 cmd 文件 ANSI 编码影响：
//      · 便携版：等旧 exe 解锁 → 备份 → 用新 exe 原地替换 → 重新启动；
//        若旧 exe 所在目录只读，则退化为直接启动新 exe（保留旧文件）。
//      · 安装版：隐藏 PowerShell 按当前主进程 PID 有界等待；超时只结束该
//        PID（不按镜像名、不杀进程树）→ 以向导方式启动新 Setup 安装包。

import https = require('node:https');
import http = require('node:http');
import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import cp = require('node:child_process');
import updater = require('./updater');
const { compareVersions } = updater;

// （历史备注：Electron 主进程时代曾优先用 electron.net —— Chromium 网络栈
// 走系统代理与系统 CA，规避企业 MITM 证书与系统代理两类 Node https 硬伤；
// Tauri 化后 electron 模块永不可得，该路径已整体退役。）

/** 统一取响应头字段（http 与 https 的 header 值类型不一致，可能是数组）。 */
function headerValue(headers: Record<string, unknown> | null | undefined, name: string): unknown {
  const v = headers && headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const DEFAULT_REPOS = { github: 'zouyuxuan122/DSH-Desktop-EAC', gitee: 'zouyuxuan122/DSH-Desktop-EAC' };
const REPO_SLUG = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;
const MIN_VALID_BYTES = 64 * 1024 * 1024; // 完整安装包远大于 64MB，防止把错误页当 exe
const GITHUB_DOWNLOAD_PROXY_DEFAULT = 'https://gh.geekertao.top/';
// 5.3.3：代理前缀可经 DSH_DESKTOP_GH_PROXY 覆盖（第三方加速域名易主/失效
// 会拖垮全部 GitHub 下载）；置 0/off/false 关闭。
function ghProxyBase(): string | null {
  const env = String(process.env.DSH_DESKTOP_GH_PROXY || '').trim();
  if (/^(0|off|false)$/i.test(env)) return null;
  if (env) return env.replace(/\/+$/, '') + '/';
  return GITHUB_DOWNLOAD_PROXY_DEFAULT;
}

interface UpdateCtx {
  userDataDir: string;
  log(section: string, message: string): void;
}

interface PlatformAssetOptions {
  platform?: NodeJS.Platform;
}

interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  sha256?: string;
}

interface ReleaseInfo {
  source: string;
  version: string;
  name: string | null;
  body: string;
  htmlUrl: string | null;
  assets: ReleaseAsset[];
  isNewer?: boolean;
}

interface SelectedAsset {
  parts: ReleaseAsset[];
  name: string;
  totalSize: number;
}

interface DownloadResult {
  path: string;
  size: number;
}

interface EndpointSpec {
  name: string;
  url: string;
  headers?: Record<string, unknown>;
}

function isPortable(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

/**
 * Tauri 便携部署检测（P4/R6）：Rust 壳 spawn sidecar 时必带 DSH_SHELL_EXE
 * （Electron 链路从不设置），且 make-portable 在 exe 同级放 .dsh-portable 标记
 * —— 双条件同时成立才走「zip → 目录树交换」自更新；否则维持既有
 * 单 exe（Electron 便携）/ Setup /S（安装版）语义，冻结链路零影响。
 */
function isTauriPortable(): boolean {
  const shellExe = process.env.DSH_SHELL_EXE;
  if (!shellExe) return false;
  try {
    return fs.existsSync(path.join(path.dirname(shellExe), '.dsh-portable'));
  } catch {
    return false;
  }
}

/**
 * 生成 Tauri 便携版 apply-update.ps1：等待壳进程（DSH_SHELL_PID）退出 →
 * 解压新 zip 到安装目录内 staging → 逐顶层项 rename(.old)+move 交换 →
 * 重启壳。失败路径尽力拉起现有程序；历史 .old 树在下次更新前清理。
 * 脚本保持纯 ASCII，路径经参数传递（与安装版助手同一套纪律）。
 */
function buildTauriPortableApplyScript(): string[] {
  return [
    'param(',
    '  [string]$ZipPath = "",',
    '  [string]$InstallDir = "",',
    '  [int]$AppPid = 0',
    ')',
    '$ErrorActionPreference = "Stop"',
    '$Log = Join-Path $PSScriptRoot "apply-update.log"',
    'function Write-Log([string]$m) { Add-Content -LiteralPath $Log -Value ("[{0}] {1}" -f (Get-Date -Format s), $m) }',
    'try {',
    '  Write-Log "tauri portable update start"',
    '  if ($AppPid -gt 0) {',
    '    for ($i = 0; $i -lt 150; $i++) {',
    '      Start-Sleep -Milliseconds 2000',
    '      if (-not (Get-Process -Id $AppPid -ErrorAction SilentlyContinue)) { break }',
    '    }',
    '    Start-Sleep -Seconds 2',
    '  }',
    '  $exe = Join-Path $InstallDir "dsh-eac-shell.exe"',
    '  $staging = Join-Path $InstallDir ".update-staging"',
    '  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }',
    '  Write-Log ("extracting " + $ZipPath)',
    '  Expand-Archive -LiteralPath $ZipPath -DestinationPath $staging -Force',
    '  Get-ChildItem -LiteralPath $InstallDir -Directory -Filter "*.old" -ErrorAction SilentlyContinue | ForEach-Object {',
    '    try { Remove-Item -LiteralPath $_.FullName -Recurse -Force } catch {}',
    '  }',
    '  Get-ChildItem -LiteralPath $staging | ForEach-Object {',
    '    $dest = Join-Path $InstallDir $_.Name',
    '    if (Test-Path -LiteralPath $dest) { Rename-Item -LiteralPath $dest -NewName ($_.Name + ".old") -Force }',
    '    Move-Item -LiteralPath $_.FullName -Destination $dest -Force',
    '    Write-Log ("swapped " + $_.Name)',
    '  }',
    '  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue',
    '  Write-Log "swap complete"',
    // 重启是尽力而为：文件交换已完成，拉起失败不应把更新标记为失败
    //（用户可手动启动；真实场景 exe 必然有效）。
    '  try { Start-Process -FilePath $exe -WorkingDirectory $InstallDir } catch {',
    '    Write-Log ("relaunch failed: " + $_.Exception.Message)',
    '  }',
    '  exit 0',
    '} catch {',
    '  Write-Log ("update failed: " + $_.Exception.Message)',
    '  try { Start-Process -FilePath (Join-Path $InstallDir "dsh-eac-shell.exe") -WorkingDirectory $InstallDir } catch {}',
    '  exit 1',
    '}',
  ];
}

/** 解析仓库地址（格式非法或缺省时回退到内置默认仓库）。 */
function resolveRepos(repos?: unknown): { github: string; gitee: string } {
  const r = repos && typeof repos === 'object' ? repos as Record<string, unknown> : {};
  const github = REPO_SLUG.test(String(r.github || '')) ? r.github : DEFAULT_REPOS.github;
  const gitee = REPO_SLUG.test(String(r.gitee || '')) ? r.gitee : DEFAULT_REPOS.gitee;
  return { github: String(github), gitee: String(gitee) };
}

/**
 * 只为 GitHub Release 资产生成代理地址；其他来源保持原地址。
 * opts.version / opts.sha256 作为查询参数附加：gh.geekertao.top 这类加速代理
 * 会缓存旧的安装包文件（同名同大小、内容却是旧版），客户端拿到旧文件导致
 * SHA-256 校验失败、更新中止。附加版本号与公布哈希后，代理缓存键随内容变化，
 * 自动绕开旧缓存（版本号必带，哈希可加强到内容级）。
 */
function githubProxyUrl(url: string | null | undefined, { version = '', sha256 = '' }: { version?: string; sha256?: string } = {}): string | null {
  const value = String(url || '').trim();
  if (!/^https:\/\/github\.com\//i.test(value)) return null;
  const params: string[] = [];
  if (version) params.push(`v=${encodeURIComponent(String(version))}`);
  if (sha256) params.push(`sha256=${encodeURIComponent(String(sha256))}`);
  const suffix = params.length ? (value.includes('?') ? '&' : '?') + params.join('&') : '';
  const base = ghProxyBase();
  return base ? base + value + suffix : null;
}

/** 组装下载候选：代理优先，随后原始地址，再接其他 Release 源。opts 透传给代理地址生成（缓存破坏参数）。 */
function downloadUrls(primaryUrl: string | null | undefined, fallbackUrls: unknown[] = [], opts: { version?: string; sha256?: string } = {}): string[] {
  const primary = String(primaryUrl || '').trim();
  const candidates: string[] = [];
  // 直连优先（官方源），代理只作直连失败后的加速候选。
  if (primary) candidates.push(primary);
  const proxied = githubProxyUrl(primary, opts);
  if (proxied) candidates.push(proxied);
  for (const url of Array.isArray(fallbackUrls) ? fallbackUrls : []) {
    const value = String(url || '').trim();
    if (value) candidates.push(value);
  }
  return [...new Set(candidates)];
}

function apiEndpoints(): EndpointSpec[] {
  if (process.env.DSH_DESKTOP_RELEASE_API) {
    // 自定义镜像：兼容 latest 单对象与 releases 列表两种形态。
    return [{ name: '自定义镜像', url: process.env.DSH_DESKTOP_RELEASE_API }];
  }
  const { github, gitee } = resolveRepos();
  return [
    {
      name: 'GitHub',
      // V4：改用 releases 列表（而非 /latest 单对象）—— 本仓库同时发布
      // Windows 与 Linux 产物；当最新 release 只有 Linux 资产时，/latest
      // 会把 Windows 客户端引向一次必然失败的更新（selectAsset 找不到
      // .exe）。列表自新向旧扫，取「第一个含本平台资产的 release」。
      url: `https://api.github.com/repos/${github}/releases?per_page=20`,
      headers: { Accept: 'application/vnd.github+json' },
    },
    { name: 'Gitee', url: `https://gitee.com/api/v5/repos/${gitee}/releases?page=1&per_page=20` },
  ];
}

// --- HTTP ----------------------------------------------------------------

interface ResponseBundle {
  status: number | undefined;
  headers: Record<string, unknown>;
  stream: any;
}

// Electron 时代的 electron.net 路径已随壳退役删除（原走 Chromium 网络栈：
// 系统代理 + 系统 CA，Tauri 产品里 electron 模块永远不存在），统一 node
// https：手动跟随重定向（≤5 次）。timeoutMs 只约束到响应头到达（TTFB），
// 响应体由调用方各自控制。
function getResponse(url: string, { headers = {}, timeoutMs = 20000, redirects = 0 }: { headers?: Record<string, unknown>; timeoutMs?: number; redirects?: number } = {}): Promise<ResponseBundle> {
  if (redirects > 5) return Promise.reject(new Error('重定向次数过多'));
  return new Promise((resolve, reject) => {
    // 自定义镜像（DSH_DESKTOP_RELEASE_API）与单测允许 http:// 端点
    const lib = (url.startsWith('http:') ? http : https) as unknown as typeof http;
    const req = lib.get(url, { headers: { 'User-Agent': 'DSH-Desktop', ...headers } }, (res) => {
      const sc = res.statusCode;
      if (sc !== undefined && sc >= 300 && sc < 400 && res.headers.location) {
        res.resume();
        getResponse(new URL(res.headers.location, url).toString(), { headers, timeoutMs, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      resolve({ status: sc, headers: res.headers, stream: res });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

async function httpGetJson(url: string, headers: Record<string, unknown> = {}, timeoutMs = 20000): Promise<any> {
  const { status, stream } = await getResponse(url, { headers, timeoutMs });
  if (status !== 200) {
    stream.resume();
    throw new Error('HTTP ' + status);
  }
  let body = '';
  await new Promise<void>((resolve, reject) => {
    stream.setEncoding('utf8');
    stream.on('data', (c: Buffer) => {
      body += c;
      if (body.length > 4 * 1024 * 1024) stream.destroy(new Error('响应过大'));
    });
    stream.on('end', resolve);
    stream.on('aborted', () => reject(new Error('连接中断')));
    stream.on('error', reject);
  });
  try { return JSON.parse(body); } catch { throw new Error('JSON 解析失败'); }
}

// --- release 规范化 -------------------------------------------------------

function normalizeRelease(source: string, data: any): ReleaseInfo {
  const tag = String(data.tag_name || data.tag || data.name || '').trim();
  const version = tag.replace(/^v/i, '');
  const assets: ReleaseAsset[] = Array.isArray(data.assets)
    ? data.assets
        .map((a: any): ReleaseAsset => {
          const item: ReleaseAsset = {
            name: String(a.name || ''),
            url: String(a.browser_download_url || a.url || ''),
            size: Number(a.size || 0),
          };
          // V4：GitHub Releases API 的 digest 字段（"sha256:<hex>"）——发布
          // 侧带 digest 时下载后做内容校验（此前只比文件大小，与不校验
          // 没有差别；用户反馈：下载完应算 SHA-256 与公布值比对，不一致
          // 就中止替换）。
          const digest = String(a.digest || '');
          if (/^sha256:[0-9a-f]{64}$/i.test(digest)) item.sha256 = digest.slice(7).toLowerCase();
          return item;
        })
        .filter((a: ReleaseAsset) => a.name && a.url)
    : [];
  return {
    source,
    version,
    name: data.name || null,
    body: String(data.body || ''),
    htmlUrl: data.html_url || null,
    assets,
  };
}

async function checkLatest(
  ctx: UpdateCtx,
  currentVersion: string,
  { platform = 'win32' }: PlatformAssetOptions = {},
): Promise<ReleaseInfo> {
  const errors: string[] = [];
  for (const ep of apiEndpoints()) {
    try {
      const data = await httpGetJson(ep.url, ep.headers || {});
      // 兼容两种形态：/releases/latest 的单对象 与 /releases 列表数组。
      const rawList = Array.isArray(data) ? data : [data];
      // 与 /latest 同语义：过滤 draft / prerelease；再按版本号降序稳定排序
      // （API 默认按创建时间，releases 被编辑/补传资产时版本序更可靠）。
      const releases = rawList
        .filter((r: any) => r && !r.draft && !r.prerelease)
        .map((r: any) => normalizeRelease(ep.name, r))
        .filter((r: ReleaseInfo) => r.version)
        .sort((a: ReleaseInfo, b: ReleaseInfo) => compareVersions(b.version, a.version));
      if (!releases.length) throw new Error('上游没有可见的 release');
      // 自新向旧找「第一个含目标平台资产的 release」。默认目标仍为
      // Windows；Linux 壳显式传入 linux，只用于发现版本并外部 handoff。
      const skippedNoAsset: string[] = [];
      let picked: ReleaseInfo | null = null;
      for (const rel of releases) {
        try {
          selectAsset(rel, { platform });
          picked = rel;
          break;
        } catch {
          skippedNoAsset.push(rel.version);
        }
      }
      if (!picked) {
        throw new Error(`最近 20 个 release 都没有本平台（${platform}）的安装包资产`);
      }
      picked.isNewer = compareVersions(picked.version, currentVersion) > 0;
      ctx.log('client-update', `[${ep.name}] 本平台最新=${picked.version} 当前=${currentVersion} 资产数=${picked.assets.length}` +
        (skippedNoAsset.length ? `；跳过无 ${platform} 资产的版本: ${skippedNoAsset.join(', ')}` : ''));
      return picked;
    } catch (err) {
      errors.push(`${ep.name}: ${(err as Error).message}`);
      ctx.log('client-update', `[${ep.name}] 查询失败: ${(err as Error).message}`);
    }
  }
  throw new Error('无法连接上游发布源（' + errors.join('；') + '）');
}

// --- 资产选择 / 下载 -------------------------------------------------------

function selectAsset(release: ReleaseInfo, { platform = 'win32' }: PlatformAssetOptions = {}): SelectedAsset {
  if (platform === 'linux') {
    const linuxAsset = release.assets.find((asset) =>
      !/arm64|aarch64/i.test(asset.name) && /(?:x86_64|amd64).*(?:\.AppImage|\.deb)$|(?:\.AppImage|_amd64\.deb)$/i.test(asset.name));
    if (!linuxAsset) {
      throw new Error('未找到匹配的 Linux x86_64 安装包资产（' + release.assets.map((a) => a.name).join(', ') + '）');
    }
    return { parts: [linuxAsset], name: linuxAsset.name, totalSize: linuxAsset.size };
  }
  if (platform !== 'win32') {
    throw new Error(`不支持 ${platform} 平台的客户端资产`);
  }
  // 资产命名：Deepseek-Harness-EAC-<version>-Setup-x64.exe / …-Portable-x64.exe。
  // 旧正则 /-setup-.*-x64\.exe$/ 要求 -setup- 之后还有第二个 "-x64"，
  // 对 "…-v2.0.1-Setup-x64.exe"（-Setup- 直接连 x64.exe）永远匹配失败，
  // 更新流程卡死在"未找到匹配的安装包资产"。锚定 \.exe$ 保证 .blockmap
  // 等附属资产不会被误选。
  // V4 平台围栏：文件名带 linux/arm64 等标记的一律不选（双平台发布时
  // 防止误拿；x64 正则本身已排除 arm64，这里再显式拒绝）。
  // Tauri 便携：选 -portable.zip（树交换更新）；Electron 便携/安装版正则不变。
  const wanted = isTauriPortable()
    ? /portable\.zip$/i
    : isPortable()
      ? /portable.*x64\.exe$/i
      : /(?:setup.*x64|x64.*setup)\.exe$/i;
  const platformOk = (name: string) => !/linux|arm64|aarch64|appimage|\.deb$|\.rpm$|\.snap$/i.test(name);
  // 一个 release 可以同步承载正式版、AIO、Launcher 等不同产品。旧逻辑只
  // 看 Setup/Portable 后缀，API 或镜像一旦调整 assets 顺序，正式版客户端就
  // 可能下载到 AIO 安装器。正式版自更新必须同时验证产品身份，不依赖顺序。
  const officialProduct = (name: string) =>
    /^deepseek(?:[. _-]+)harness(?:[. _-]+)eac(?:[. _-]|$)/i.test(name)
    && !/(?:^|[. _-])aio(?:[. _-]|$)|launcher/i.test(name);
  const direct = release.assets.find((a) => wanted.test(a.name) && platformOk(a.name) && officialProduct(a.name));
  if (direct) return { parts: [direct], name: direct.name, totalSize: direct.size };

  // Gitee 单文件 100MB 限制：安装包拆分为 <file>.part1 / <file>.part2 …
  // 候选覆盖各历史命名：固定名（v2.0.3 起）、版本在 Setup 前的两种旧形态、
  // 以及当前命名（Setup-v<version>-x64.exe，版本在 Setup 后）。
  const kind = isPortable() ? 'Portable' : 'Setup';
  const bases = [
    `Deepseek-Harness-EAC-${kind}-x64.exe`,
    `Deepseek-Harness-EAC-v${release.version}-${kind}-x64.exe`,
    `Deepseek-Harness-EAC-${release.version}-${kind}-x64.exe`,
    `Deepseek-Harness-EAC-${kind}-v${release.version}-x64.exe`,
  ];
  let base = '';
  let parts: ReleaseAsset[] = [];
  for (const b of bases) {
    parts = release.assets
      .filter((a) => a.name.startsWith(b + '.part'))
      .sort((a, b2) => {
        const n = (s: string) => parseInt(s.split('part').pop()!, 10) || 0;
        return n(a.name) - n(b2.name);
      });
    if (parts.length) { base = b; break; }
  }
  if (!parts.length) {
    throw new Error('未找到匹配的安装包资产（' + release.assets.map((a) => a.name).join(', ') + '）');
  }
  return { parts, name: base, totalSize: parts.reduce((s, p) => s + p.size, 0) };
}

/** 单次下载尝试。resumeFrom > 0 时发 Range 续传请求并以追加模式写入；
 *  失败时保留 .part 供下一次断点续传（不删）。 */
function downloadFileOnce(url: string, dest: string, { onProgress, resumeFrom = 0 }: { onProgress?: ((received: number, total: number) => void) | undefined; resumeFrom?: number } = {}): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    let received = resumeFrom;
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const finish = (fn: (v: any) => void, value: any) => { if (!settled) { settled = true; if (idleTimer) clearTimeout(idleTimer); fn(value); } };
    // 空闲超时：60 秒没有任何数据到达才判死（167MB 的安装包在慢链路上
    // 要传十几分钟，不能设整体超时）。每个数据块重置计时。
    const bumpIdle = (stream: any) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { stream.destroy(new Error('下载超时')); } catch { /* already destroyed */ }
      }, 60000);
    };
    const reqHeaders: Record<string, unknown> = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
    getResponse(url, { timeoutMs: 60000, headers: reqHeaders }).then(({ status, headers, stream }) => {
      if (settled) { stream.resume(); return; }
      if (status === 416) {
        // .part 比远端文件还长（上轮损坏/上游换了文件）：作废重来
        stream.resume();
        try { fs.rmSync(tmp, { force: true }); } catch {}
        return finish(reject, new Error('RESUME_INVALID'));
      }
      const partial = status === 206;
      if (status !== 200 && !partial) {
        stream.resume();
        return finish(reject, new Error('下载失败 HTTP ' + status));
      }
      if (partial) {
        const cr = String(headerValue(headers, 'content-range') || '');
        const m = /^bytes (\d+)-/i.exec(cr);
        if (m && Number(m[1]!) !== resumeFrom) {
          stream.resume();
          // 必须删掉 .part：不删则下一轮 attempt 携同一半截重试，恒撞
          // RESUME_INVALID 空转烧完 maxAttempts（416 分支已有同款清理）。
          try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
          return finish(reject, new Error('RESUME_INVALID'));
        }
      }
      // 服务器忽略 Range 回 200 全量时必须覆盖写（追加会把旧半截拼在前面）
      const append = partial && resumeFrom > 0;
      if (!append) received = 0;
      const file = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' });
      const fail = (err: Error) => {
        file.close(() => {});
        // 保留 .part：下一次重试从已落盘字节续传
        finish(reject, err);
      };
      const declared = Number(headerValue(headers, 'content-length') || 0);
      const total = append ? (declared ? resumeFrom + declared : 0) : declared;
      bumpIdle(stream);
      stream.on('data', (c: Buffer) => {
        received += c.length;
        bumpIdle(stream);
        if (onProgress) { try { onProgress(received, total); } catch {} }
      });
      stream.on('aborted', () => fail(new Error('连接中断')));
      stream.on('error', fail);
      file.on('finish', () => {
        if (settled) return;
        try { fs.renameSync(tmp, dest); } catch (err) { return finish(reject, err); }
        finish(resolve, { path: dest, size: received });
      });
      file.on('error', fail);
      stream.pipe(file);
    }, finish.bind(null, reject));
  });
}

/** 判断是否“磁盘空间不足”类错误：重试不会好转，必须立即停下并提示用户。 */
function isNoSpaceError(err: any): boolean {
  if (!err) return false;
  if (err.code === 'ENOSPC') return true;
  return /no space left on device/i.test(String(err.message || ''));
}

function noSpaceError(msg: string): Error {
  const e = new Error(msg);
  (e as Error & { code: string }).code = 'ENOSPC';
  return e;
}

/** 带断点续传 + 指数退避重试的下载。慢链路上 167MB 直连常被 RST
 *  （net::ERR_CONNECTION_RESET），一锤子流下载必然偶发失败；每次重试
 *  从已落盘的 .part 断点继续，而不是整包重来。 */
async function downloadFile(url: string, dest: string, { onProgress, ctx = null, maxAttempts = 10 }: { onProgress?: ((received: number, total: number) => void) | undefined; ctx?: UpdateCtx | null; maxAttempts?: number } = {}): Promise<DownloadResult> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resumeFrom = 0;
    try { resumeFrom = fs.statSync(dest + '.part').size; } catch { /* 无残留，全新下载 */ }
    if (attempt > 1 || resumeFrom > 0) {
      ctx?.log?.('client-update', `下载尝试 ${attempt}/${maxAttempts}（从 ${Math.round(resumeFrom / 1048576)} MB 处续传）`);
    }
    try {
      return await downloadFileOnce(url, dest, { onProgress, resumeFrom });
    } catch (err) {
      lastErr = err;
      if (isNoSpaceError(err)) break; // 磁盘满：重试只会继续写失败，直接终止并提示
      if ((err as Error).message === 'RESUME_INVALID') continue; // .part 已作废，立即全新重试
      if (attempt < maxAttempts) {
        const delay = Math.min(3000 * 2 ** (attempt - 1), 30000);
        ctx?.log?.('client-update', `下载中断（${(err as Error).message}），${Math.round(delay / 1000)}s 后从断点重试`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  if (isNoSpaceError(lastErr)) {
    throw noSpaceError('磁盘空间不足，无法下载更新包。请清理磁盘空间（如临时文件、旧安装包）后重试。');
  }
  throw lastErr || new Error('下载失败');
}

// 同源多次失败后自动切换镜像源（GitHub ↔ Gitee 等）：切换时丢弃旧 .part
//（不同来源的文件可能不一致，断点续传不安全），整包重新下载。
async function downloadWithSourceSwitch(urls: string[], dest: string, { onProgress, ctx = null, onSourceChange = null }: { onProgress?: (received: number, total: number) => void; ctx?: UpdateCtx | null; onSourceChange?: ((i: number) => void) | null } = {}): Promise<DownloadResult> {
  let lastErr: any;
  for (let i = 0; i < urls.length; i++) {
    if (i > 0) {
      try { fs.rmSync(dest + '.part', { force: true }); } catch {}
      try { fs.rmSync(dest, { force: true }); } catch {}
      ctx?.log?.('client-update', `当前下载源失败（${lastErr && lastErr.message}），切换备用源 ${i + 1}/${urls.length}`);
      if (onSourceChange) { try { onSourceChange(i); } catch {} }
    }
    try {
      return await downloadFile(urls[i]!, dest, { onProgress, ctx, maxAttempts: i === 0 ? 4 : 6 });
    } catch (err) {
      lastErr = err;
      if (isNoSpaceError(err)) throw err; // 磁盘满：换源也不会好转
    }
  }
  if (isNoSpaceError(lastErr)) throw lastErr;
  throw lastErr || new Error('下载失败');
}

async function concatFiles(sources: string[], dest: string): Promise<void> {
  const out = fs.createWriteStream(dest);
  // 写侧 error 监听必须在拷贝循环之前挂上：pipe 不转发写错误，ENOSPC/EIO
  // 若在此处无监听会以 uncaught exception 直接杀掉进程（磁盘压力场景恰是
  // 本函数存在的理由）。每段拷贝的 promise 同时监听读写两侧错误，保证必
  // 定settle；失败时销毁写流并清掉半成品 dest。
  let writeErr: Error | null = null;
  out.on('error', (err) => { if (!writeErr) writeErr = err; });
  try {
    for (const s of sources) {
      await new Promise<void>((res, rej) => {
        const rs = fs.createReadStream(s);
        const onWriteErr = (err: Error) => { try { rs.destroy(); } catch { /* noop */ } rej(err); };
        out.once('error', onWriteErr);
        rs.on('error', rej);
        rs.on('end', () => { out.off('error', onWriteErr); res(); });
        rs.pipe(out, { end: false });
      });
      if (writeErr) throw writeErr;
      fs.rmSync(s, { force: true });
    }
    await new Promise<void>((res, rej) => {
      out.on('error', rej);
      out.end(res);
    });
  } catch (err) {
    try { out.destroy(); } catch { /* already destroyed */ }
    try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// --- SHA-256 内容校验（V4）--------------------------------------------------
//
// 此前下载完成只比对文件大小（±2MB 还只告警不拦截），与不做内容校验没有
// 差别：传输损坏 / 投毒的镜像 / 被劫持的下载源都会把替换流程照走到底。
// 现在按以下优先级取“公布哈希”，取到即强校验，不一致 → 删除文件并中止：
//   1. release 资产自带的 digest 字段（GitHub API 提供，"sha256:<hex>"）；
//   2. release 里的 SHA256SUMS.txt 资产（发布脚本随包生成，Gitee 也可用；
//      覆盖 Gitee 分片合并后的最终文件名）；
//   3. 都没有（老 release / 自定义镜像）：记录告警后放行，保持向后兼容。

/** 流式计算文件 SHA-256（hex 小写）。 */
function computeSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/** 找到 release 里的 SHA256SUMS.txt 资产并解析成 Map（文件名小写 → hex）。 */
async function fetchSumsMap(ctx: UpdateCtx, release: ReleaseInfo): Promise<Map<string, string> | null> {
  const sumsAsset = release.assets.find((a) => /^sha-?256-?sums?\.txt$/i.test(a.name));
  if (!sumsAsset) return null;
  try {
    const { status, stream } = await getResponse(sumsAsset.url, { timeoutMs: 20000 });
    if (status !== 200) { stream.resume(); return null; }
    let text = '';
    await new Promise<void>((resolve, reject) => {
      stream.setEncoding('utf8');
      stream.on('data', (c: Buffer) => {
        text += c;
        if (text.length > 65536) stream.destroy(new Error('sums 过大'));
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const map = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
      if (m) map.set(m[2]!.toLowerCase(), m[1]!.toLowerCase());
    }
    return map;
  } catch (err) {
    ctx.log('client-update', `SHA256SUMS 获取失败（跳过该来源）: ${(err as Error).message}`);
    return null;
  }
}

/** 组装“期望哈希”：digest 字段优先，其次 SHA256SUMS 条目。 */
async function expectedSha256(ctx: UpdateCtx, release: ReleaseInfo, sel: SelectedAsset): Promise<string | null> {
  // 单资产（无分片）：digest 直接可用。
  if (sel.parts.length === 1 && sel.parts[0]!.sha256) return sel.parts[0]!.sha256;
  // 分片合并 / 无 digest：查 SHA256SUMS（按最终文件名）。
  const sums = await fetchSumsMap(ctx, release);
  if (sums) {
    const hit = sums.get(sel.name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// 尽力补齐同一版本在其余发布源（GitHub ↔ Gitee）的 release 对象，供下载
// 中途切换源使用。任一源失败/无该版本都静默跳过（仅记日志）。
async function releaseFallbacks(ctx: UpdateCtx, release: ReleaseInfo, { apiEndpointsList = null }: { apiEndpointsList?: EndpointSpec[] | null } = {}): Promise<ReleaseInfo[]> {
  const eps = apiEndpointsList || apiEndpoints();
  const fallbacks: ReleaseInfo[] = [];
  for (const ep of eps) {
    if (ep.name === release.source) continue;
    try {
      const data = await httpGetJson(ep.url, ep.headers || {});
      const rawList = Array.isArray(data) ? data : [data];
      const same = rawList
        .filter((r: any) => r && !r.draft && !r.prerelease)
        .map((r: any) => normalizeRelease(ep.name, r))
        .find((r: ReleaseInfo) => r.version === release.version);
      if (!same) { ctx.log('client-update', `[${ep.name}] 无 ${release.version} 的 release（跳过备用源）`); continue; }
      try { selectAsset(same); } catch { continue; } // 该源没有可用资产，跳过
      fallbacks.push(same);
      ctx.log('client-update', `[${ep.name}] 已就绪为 ${release.version} 的备用下载源`);
    } catch (err) {
      ctx.log('client-update', `[${ep.name}] 备用源探测失败: ${(err as Error).message}`);
    }
  }
  return fallbacks;
}

interface DownloadReleaseOpts {
  onProgress?: (received: number, total: number) => void;
  onSourceChange?: (source: string, idx: number, urls: string[]) => void;
  fallbacks?: ReleaseInfo[];
}

async function downloadRelease(ctx: UpdateCtx, release: ReleaseInfo, { onProgress, onSourceChange, fallbacks = [] }: DownloadReleaseOpts = {}): Promise<{ filePath: string; size: number; sha256Verified: boolean }> {
  const dir = path.join(ctx.userDataDir, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const sel = selectAsset(release);
  const split = sel.parts.length > 1;
  const finalPath = path.join(dir, sel.name);
  const partPaths: string[] = [];
  let merged = 0;
  // 备用源按相同的分片名对齐（命名规则一致时索引即对应；对不上就跳过）。
  const fbSelections: SelectedAsset[] = [];
  for (const fb of fallbacks) {
    try {
      const fbSel = selectAsset(fb);
      if (fbSel.parts.length === sel.parts.length && fbSel.parts.every((p, i) => p.name === sel.parts[i]!.name)) fbSelections.push(fbSel);
    } catch {}
  }
  // 下载前先求一次期望哈希：既作为代理 URL 的缓存破坏参数（sha256=…，
  // 配合 version 让代理缓存键随内容变化、绕开旧缓存），又在下载完成后复用
  // 做内容校验（单一来源，不在每个分片/校验时重复请求 SHA256SUMS）。
  const expected = await expectedSha256(ctx, release, sel);
  // 分片按版本掺名后旧版本残留不再命中，下载前顺手清理（含 5.3.2 旧式
  // 无版本分片名）。
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(sel.name) && f.includes('.part') && !f.includes(release.version + '.part')) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  } catch { /* 尽力而为 */ }
  for (let i = 0; i < sel.parts.length; i++) {
    const p = sel.parts[i]!;
    ctx.log('client-update', `下载 ${p.name}（${Math.round(p.size / 1048576)} MB）`);
    // 分片名掺入版本号：固定名候选（无版本）跨版本同名，旧 .part 会被
    // 当断点续传拼进新版本安装包（无 digest 时仅 ±2MB 告警兜底）。
    const dest = split ? `${finalPath}.${release.version}.part${i + 1}` : finalPath;
    const urls = downloadUrls(
      p.url,
      fbSelections.map((f) => (f.parts[i] && f.parts[i]!.url) || ''),
      { version: release.version, sha256: expected || '' },
    );
    const res = await downloadWithSourceSwitch(urls, dest, {
      ctx,
      onSourceChange: (idx) => {
        if (onSourceChange) onSourceChange(release.source, idx, urls);
      },
      onProgress: (r) => {
        if (onProgress) onProgress(split ? merged + r : r, sel.totalSize);
      },
    });
    if (split) { merged += res.size; partPaths.push(dest); }
  }
  if (split) {
    ctx.log('client-update', `合并 ${partPaths.length} 个分片 → ${sel.name}`);
    try {
      await concatFiles(partPaths, finalPath);
    } catch (err) {
      if (isNoSpaceError(err)) throw noSpaceError('磁盘空间不足，无法合并更新分片。请清理磁盘空间后重试。');
      throw err;
    }
  }
  const stat = fs.statSync(finalPath);
  if (stat.size < MIN_VALID_BYTES) {
    fs.rmSync(finalPath, { force: true });
    throw new Error('下载文件异常（仅 ' + Math.round(stat.size / 1048576) + ' MB），已丢弃');
  }
  // V4：SHA-256 内容校验 —— 有公布哈希即强校验；不一致删除文件并中止
  // 更新（绝不运行被篡改/损坏的安装包）。复用下载前求得的 expected。
  if (expected) {
    ctx.log('client-update', `校验 SHA-256（期望 ${expected.slice(0, 16)}…）`);
    const actual = await computeSha256(finalPath);
    if (actual !== expected) {
      fs.rmSync(finalPath, { force: true });
      throw new Error(
        `SHA-256 校验失败，已中止更新并删除下载文件（期望 ${expected}，实际 ${actual}）。` +
        '文件可能在传输中损坏或下载源被篡改，请稍后重试或手动从官方 Release 下载。'
      );
    }
    ctx.log('client-update', 'SHA-256 校验通过');
  } else {
    ctx.log('client-update', '上游未提供哈希（无 digest / SHA256SUMS.txt），跳过内容校验（大小校验兜底）');
    if (sel.totalSize > 0 && Math.abs(stat.size - sel.totalSize) > 2 * 1024 * 1024) {
      ctx.log('client-update', `大小与上游声明不一致：期望 ${sel.totalSize} 实际 ${stat.size}（继续，安装器会自校验）`);
    }
  }
  ctx.log('client-update', `下载完成: ${finalPath}（${Math.round(stat.size / 1048576)} MB）`);
  return { filePath: finalPath, size: stat.size, sha256Verified: !!expected };
}

// --- 应用更新（detached 辅助进程 + 主进程退出） -----------------------------

/**
 * 安装版使用隐藏 PowerShell 辅助进程等待当前主进程退出，再调用负责
 * 备份/回滚/安装的 CMD。CMD 不再执行 ping/taskkill，也不再负责进程等待。
 *
 * 旧实现由 EAC 生成 apply-update.cmd，再执行 taskkill /F /T /IM。正式安装
 * 环境中更新 CMD 是 EAC 派生的进程，/T 可能把更新助手一并结束；外部
 * ping/find 也可能暴露控制台窗口。新实现只等待/结束调用方传入的主进程
 * PID，进程退出后才进入备份与 Setup 流程。
 */
function buildInstalledApplyScript(): string[] {
  return [
    'param(',
    '  [Parameter(Mandatory = $true)][string]$ActionScriptPath,',
    '  [Parameter(Mandatory = $true)][string]$SetupPath,',
    '  [Parameter(Mandatory = $true)][string]$OldExePath,',
    '  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$UserDataDir,',
    '  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$DshHome,',
    '  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$InstallDir,',
    '  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ProfileDir,',
    '  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$CurrentVersion,',
    '  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$NewVersion,',
    '  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$NodeExePath,',
    '  [Parameter(Mandatory = $true)][int]$AppPid,',
    '  [Parameter(Mandatory = $true)][string]$LogPath,',
    '  [int]$WaitTimeoutSeconds = 20',
    ')',
    "$ErrorActionPreference = 'Stop'",
    '$ScriptPath = $MyInvocation.MyCommand.Path',
    'function Write-ApplyLog([string]$Message) {',
    "  $Stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'",
    '  Add-Content -LiteralPath $LogPath -Value ("[" + $Stamp + "] " + $Message) -Encoding UTF8',
    '}',
    'function Get-AppProcess {',
    '  Get-Process -Id $AppPid -ErrorAction SilentlyContinue',
    '}',
    'try {',
    '  if ($AppPid -le 0) { throw "Invalid app PID" }',
    '  if ($WaitTimeoutSeconds -lt 1 -or $WaitTimeoutSeconds -gt 120) { throw "Invalid wait timeout" }',
    '  $LogDir = Split-Path -Parent $LogPath',
    '  if ($LogDir) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }',
    '  Set-Content -LiteralPath $LogPath -Value "" -Encoding UTF8',
    '  Write-ApplyLog ("installed apply-update start; appPid=" + $AppPid)',
    '  if (-not (Test-Path -LiteralPath $SetupPath -PathType Leaf)) { throw "Setup not found" }',
    '  if (-not (Test-Path -LiteralPath $ActionScriptPath -PathType Leaf)) { throw "Action script not found" }',
    '  Write-ApplyLog "waiting for app exit"',
    '  $Deadline = [DateTime]::UtcNow.AddSeconds($WaitTimeoutSeconds)',
    '  while ((Get-AppProcess) -and [DateTime]::UtcNow -lt $Deadline) {',
    '    Start-Sleep -Milliseconds 200',
    '  }',
    '  if (Get-AppProcess) {',
    '    Write-ApplyLog "app exit wait timed out; stopping exact PID"',
    '    try {',
    '      Stop-Process -Id $AppPid -Force -ErrorAction Stop',
    '    } catch {',
    '      if (Get-AppProcess) { throw }',
    '    }',
    '    for ($i = 0; $i -lt 25 -and (Get-AppProcess); $i++) { Start-Sleep -Milliseconds 200 }',
    '  }',
    '  if (Get-AppProcess) { throw "App process did not exit" }',
    '  Write-ApplyLog "running hidden update action"',
    '  & $ActionScriptPath $SetupPath $OldExePath $UserDataDir $DshHome $InstallDir $ProfileDir $CurrentVersion $NewVersion $NodeExePath',
    '  $ActionExitCode = [int]$LASTEXITCODE',
    '  Write-ApplyLog ("update action exit code " + $ActionExitCode)',
    '  if ($ActionExitCode -ne 0) { exit $ActionExitCode }',
    '  Remove-Item -LiteralPath $ScriptPath -Force -ErrorAction SilentlyContinue',
    '  exit 0',
    '} catch {',
    '  try { Write-ApplyLog ("update failed: " + $_.Exception.Message) } catch {}',
    '  if (Test-Path -LiteralPath $OldExePath -PathType Leaf) {',
    '    try { Start-Process -FilePath $OldExePath | Out-Null } catch {}',
    '  }',
    '  exit 1',
    '}',
  ];
}

interface ApplyScriptOpts {
  newExe: string;
  oldExe: string;
  portable: boolean;
  userDataDir?: string;
  dshHome?: string;
  installDir?: string;
  profileDir?: string;
  currentVersion?: string;
  newVersion?: string;
  nodeExe?: string;
}

/**
 * 生成 apply-update.cmd：便携版负责原地替换，安装版负责备份/回滚/Setup。
 *
 * 安装版 CMD 由 PowerShell 在旧主进程退出后调用，不再自行等待或结束进程；
 * 便携版保留原地替换与回滚语义。脚本保持纯 ASCII，路径通过参数传递。
 */
function buildApplyScript({ portable }: ApplyScriptOpts): string[] {
  const lines = ['@echo off'];
  if (portable) {
    lines.push(
      'set "NEW=%~1"',
      'set "OLD=%~2"',
      'set "LOG=%~dp0apply-update.log"',
      'echo [%date% %time%] portable apply-update start > "%LOG%"',
      'set /a tries=0',
      ':wait',
      'set /a tries+=1',
      'if %tries% gtr 300 goto failed',
      'ping -n 2 127.0.0.1 >nul',
      'if not exist "%OLD%" goto replace',
      'copy /y "%OLD%" "%OLD%.bak" >nul 2>&1',
      'if errorlevel 1 goto wait',
      'del /f /q "%OLD%" >nul 2>&1',
      'if exist "%OLD%" goto wait',
      ':replace',
      'echo [%date% %time%] replacing portable exe >> "%LOG%"',
      'copy /y "%NEW%" "%OLD%" >nul 2>&1',
      'if errorlevel 1 goto failed',
      'del "%NEW%" >nul 2>&1',
      // V4.1 更新保障③：成功路径也保留 %OLD%.bak（上一版 exe）并落 marker。
      // 新版若崩溃（run-state 非干净退出 + marker 存在），下次启动自动回退。
      // 新版健康启动后由主进程清理（cleanupClientBackupIfHealthy）。
      // V4.1 保障③的 .crash 快照必须取自 %OLD%.bak（上一版 exe）：此处
      // %OLD% 已被上方 copy 覆盖为新版，从 %OLD% 复制得到的是新 exe，
      // 崩溃回退保险丝名存实亡。
      'if exist "%OLD%.bak" copy /y "%OLD%.bak" "%OLD%.crash" >nul 2>&1',
      'start "" "%OLD%"',
      'echo updated %date% %time% > "%OLD%.bak.marker"',
      'del "%~f0" >nul 2>&1',
      'exit /b 0',
      ':failed',
      'echo [%date% %time%] portable update failed, restoring >> "%LOG%"',
      // M3 修复：超时后先尽力复制回原位再启动，避免便携版从 updates 目录
      // 直接启动导致新建 data 目录、丢失设置。
      'if exist "%OLD%.bak" copy /y "%OLD%.bak" "%OLD%" >nul 2>&1',
      'if not exist "%OLD%" copy /y "%NEW%" "%OLD%" >nul 2>&1',
      'if exist "%OLD%" (start "" "%OLD%") else (start "" "%NEW%")',
      'if exist "%OLD%.bak" del "%OLD%.bak" >nul 2>&1',
      'del "%~f0" >nul 2>&1',
      'exit /b 0'
    );
  } else {
    // 安装版 CMD 只负责备份、Setup 与回滚。主进程等待由隐藏 PowerShell
    // 助手完成，因此这里不得再加入 ping/tasklist/find/taskkill。
    //
    // V4.3 增量更新 PR（独有价值保留）：
    //   1) 备份 4 目录（userData / dshHome / profile / installDir）到
    //      <userData>/backups/<unix-ts>/ ，同时从注册表查询 InstallLocation
    //      并与实际 installDir 对比，两者都写入 manifest.json（安装目录被
    //      用户手动移动过时，备份/回滚以实际路径为准，注册表值仅记录）。
    //   2) Setup 调用添加 /S：oneClick: false 下 NSIS 静默走完所有步骤到原
    //      路径（读注册表 InstallLocation）。
    //   3) 成功路径写 <userData>/updates/.backup-ts marker（内容就是时间戳），
    //      新版健康启动后主进程 cleanupClientBackupIfHealthy →
    //      offerBackupCleanupConfirm 询问是否清理备份（保留 24h，超过不自动弹）。
    //   4) 失败路径：从备份目录反向 robocopy /MIR 回 4 目录，再拉起旧版。
    //   5) manifest.json 的内联 JS 用「应用自带 node」执行（经隐藏 PowerShell
    //      作为第 9 个参数传入，打包在 resources\node\node.exe）：目标用户机器普遍没有系统 Node，
    //      裸调 PATH 上的 node 会 errorlevel 9009 → BAD=2 → 更新永远中止
    //      回滚（更新死循环，v3.0.1 自举陷阱同类）。nodeExe 缺失/不存在时
    //      降级 SKIP_BACKUP（回到 v4.3 无备份语义），绝不依赖 PATH。
    lines.push(
      'set "SETUP=%~1"',
      'set "OLD=%~2"',
      'set "UD=%~3"',
      'set "DSH=%~4"',
      'set "INST=%~5"',
      'set "PROF=%~6"',
      'set "OLDVER=%~7"',
      'set "NEWVER=%~8"',
      // 第 9 个参数仍可用 %~9 直接引用。nodeExe 先由 PowerShell 的 Unicode
      // 参数链传递，可避免把含非 ASCII 字符的绝对路径写进 OEM 代码页批处理。
      // 第 10 个参数不能写成 %~10（会被解析成 %~1 后跟字面量 0）。
      'set "NODEEXE=%~9"',
      'set "LOG=%~dp0apply-update.log"',
      'echo [%date% %time%] installed update action start >> "%LOG%"',
      'echo [%date% %time%] oldVer=%OLDVER% newVer=%NEWVER% >> "%LOG%"',
      'echo [%date% %time%] userData=%UD% >> "%LOG%"',
      'echo [%date% %time%] dsh=%DSH% >> "%LOG%"',
      'echo [%date% %time%] install=%INST% >> "%LOG%"',
      'echo [%date% %time%] profile=%PROF% >> "%LOG%"',
      // --- 关键路径是否齐全：只要有一个为空就跳过备份（单测/开发回退到原语义）---
      'set "SKIP_BACKUP=0"',
      'if "%UD%"=="" set SKIP_BACKUP=1',
      'if "%DSH%"=="" set SKIP_BACKUP=1',
      'if "%INST%"=="" set SKIP_BACKUP=1',
      'if "%PROF%"=="" set SKIP_BACKUP=1',
      'if "%NODEEXE%"=="" set SKIP_BACKUP=1',
      'if not exist "%NODEEXE%" set SKIP_BACKUP=1',
      'if "%SKIP_BACKUP%"=="1" echo [%date% %time%] WARN: one of UD/DSH/INST/PROF/NODEEXE empty or missing, skipping backup (fallback semantics) >> "%LOG%"',
      // --- 阶段 0：查注册表 InstallLocation（供 manifest 对比，不影响实际动作）---
      'if "%SKIP_BACKUP%"=="0" set "REG_INST="',
      'if "%SKIP_BACKUP%"=="0" for /f "tokens=2*" %%a in (\'reg query "HKCU\\Software\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKLM\\Software\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKCU\\Software\\WOW6432Node\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKLM\\Software\\WOW6432Node\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      // 注册表值可能被安装器写脏（实测出现过 ["D:\\..."] 这种内嵌引号/括号的
      // InstallLocation）：引号会在下方 if 展开时截断比较串，cmd 直接报
      // 「此时不应有 Harness」并以 255 退出，备份链静默中断。剥掉全部双
      // 引号后再参与对比（仅用于 WARN 日志与 manifest 记录，路径以实际为准）。
      'if "%SKIP_BACKUP%"=="0" if defined REG_INST set "REG_INST=%REG_INST:"=%"',
      'if "%SKIP_BACKUP%"=="0" echo [%date% %time%] InstallLocation(registry)=%REG_INST% >> "%LOG%"',
      'if "%SKIP_BACKUP%"=="0" if /i not "%REG_INST%" == "" if /i not "%REG_INST%" == "%INST%" echo [%date% %time%] WARN: InstallLocation registry vs actual mismatch (backup/rollback use actual path) >> "%LOG%"',
      // --- 阶段 1：生成时间戳 + 建备份根目录 ---
      'if "%SKIP_BACKUP%"=="0" set "TS="',
      'if "%SKIP_BACKUP%"=="0" for /f %%t in (\'powershell -NoProfile -Command "[DateTimeOffset]::Now.ToUnixTimeSeconds()" 2^>nul\') do set "TS=%%t"',
      'if "%SKIP_BACKUP%"=="0" if not defined TS set "TS=%date:~-10,4%%date:~-5,2%%date:~-2,2%%time:~0,2%%time:~3,2%%time:~6,2%"',
      'if "%SKIP_BACKUP%"=="0" set "TS=%TS: =0%"',
      'if "%SKIP_BACKUP%"=="0" set "BACKUP=%UD%\\backups\\%TS%"',
      'if "%SKIP_BACKUP%"=="0" echo [%date% %time%] backup root=%BACKUP% >> "%LOG%"',
      'if "%SKIP_BACKUP%"=="0" if not exist "%BACKUP%\\." mkdir "%BACKUP%" 2>nul',
      // robocopy 成功码 0..7（0=无复制/1=成功/2=额外文件/3=成功+额外/...7=成功+额外+不匹配），
      // errorlevel>=8 才是失败。/MIR=/E+/PURGE，/R:1 /W:1，不写日志头。
      'if "%SKIP_BACKUP%"=="0" set "BAD=0"',
      // --- 阶段 2a：备份 userData（除 updates/ 自身和 backups/ 自身外都复制）---
      'if "%SKIP_BACKUP%"=="0" if exist "%UD%\\." (',
      '  echo [%date% %time%] backing up userData =%UD% >> "%LOG%"',
      '  robocopy "%UD%" "%BACKUP%\\userdata" /MIR /XD "%UD%\\updates" "%UD%\\backups" "%UD%\\logs" /XF "*.log" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '  if errorlevel 8 set BAD=1',
      ')',
      // --- 阶段 2b：备份 .dsh 目录（不含 sessions/ 大文件与 node_modules/.cache）---
      'if "%SKIP_BACKUP%"=="0" if exist "%DSH%\\." (',
      '  echo [%date% %time%] backing up dsh =%DSH% >> "%LOG%"',
      '  robocopy "%DSH%" "%BACKUP%\\dsh" /MIR /XD "%DSH%\\sessions" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '  if errorlevel 8 set BAD=1',
      ')',
      // --- 阶段 2c：备份 web-desktop profile ---
      'if "%SKIP_BACKUP%"=="0" if exist "%PROF%\\." (',
      '  echo [%date% %time%] backing up profile =%PROF% >> "%LOG%"',
      '  robocopy "%PROF%" "%BACKUP%\\profile" /MIR /XD "%PROF%\\node_modules\\.cache" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '  if errorlevel 8 set BAD=1',
      ')',
      // --- 阶段 2d：备份安装目录（含 exe + resources 等；排除 node_modules/.cache 加速）---
      'if "%SKIP_BACKUP%"=="0" if exist "%INST%\\." (',
      '  echo [%date% %time%] backing up install =%INST% >> "%LOG%"',
      '  robocopy "%INST%" "%BACKUP%\\install" /MIR /XD "%INST%\\resources\\app\\node_modules\\.cache" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '  if errorlevel 8 set BAD=1',
      ')',
      // --- 阶段 3：写 manifest.json（Node 内联，携带版本号 + 路径 + registry 对比 + 回滚指引）---
      'if "%SKIP_BACKUP%"=="0" if "%BAD%" == "0" (',
      '  echo [%date% %time%] writing manifest.json >> "%LOG%"',
      // 注意：node 内联脚本读 process.env.ENV_MAN —— 变量名必须是
      // ENV_MAN（v4.4 实测 PR79 原稿写成 MAN，manifest 阶段 ENOENT: open ''
      // → BAD=2 → 更新中止回滚；此前被 %~10 触发的 SKIP_BACKUP 掩盖）。
      '  set "ENV_MAN=%BACKUP%\\manifest.json"',
      '  set "ENV_TS=%TS%"',
      '  set "ENV_UD=%UD%"',
      '  set "ENV_DSH=%DSH%"',
      '  set "ENV_PROF=%PROF%"',
      '  set "ENV_INST=%INST%"',
      '  set "ENV_REG=%REG_INST%"',
      '  set "ENV_OLD=%OLDVER%"',
      '  set "ENV_NEW=%NEWVER%"',
      '  set "ENV_BACK=%BACKUP%"',
      '  "%NODEEXE%" -e "try{const t=process.env;const fs=require(\'fs\');const p={userData:{src:t.ENV_UD||\'\',backup:pathJoin(t.ENV_BACK,\'userdata\')},dsh:{src:t.ENV_DSH||\'\',backup:pathJoin(t.ENV_BACK,\'dsh\')},profile:{src:t.ENV_PROF||\'\',backup:pathJoin(t.ENV_BACK,\'profile\')},install:{src:t.ENV_INST||\'\',backup:pathJoin(t.ENV_BACK,\'install\')}};function pathJoin(a,b){return require(\'path\').join(String(a||\'\'),String(b||\'\'));}const m={timestamp:Number(t.ENV_TS)||Date.now(),backupTs:String(t.ENV_TS||\'\'),oldVersion:t.ENV_OLD||\'\',newVersion:t.ENV_NEW||\'\',installLocation:{registry:t.ENV_REG||\'\',actual:t.ENV_INST||\'\',match:!!(t.ENV_REG&&t.ENV_INST&&String(t.ENV_REG).toLowerCase().replace(/[\\\\\\/]+$/g,\'\')===String(t.ENV_INST).toLowerCase().replace(/[\\\\\\/]+$/g,\'\'))},paths:p,rollbackGuide:\'4 directories each mirror-copied to the parallel ./userdata ./dsh ./profile ./install subdirs. Robocopy /MIR them back to paths.{userData,dsh,profile,install}.src, then launch OLD executable.\'};fs.writeFileSync(t.ENV_MAN||\'\',JSON.stringify(m,null,2));}catch(e){console.error(e.message);process.exit(1);}" >> "%LOG%" 2>&1',
      '  if errorlevel 1 set BAD=2',
      ')',
      'if "%SKIP_BACKUP%"=="0" if not "%BAD%" == "0" (',
      '  echo [%date% %time%] backup failed with code %BAD%, aborting update >> "%LOG%"',
      '  goto failed',
      ')',
      // --- 阶段 4：启动 NSIS 静默安装（oneClick: false，/S 下走到原路径）---
      'echo [%date% %time%] running setup /S >> "%LOG%"',
      // call 而非 start /wait：隐藏控制台下 start /wait 偶发不返回（实测
      // 子进程已退出、父脚本仍停滞，黑窗卡死的共因）；批处理直接调用另一
      // 个批处理则是 tail-call 语义不返回。call 对 .cmd/.exe 都同步等待、
      // 返回控制权并保留退出码。
      'call "%SETUP%" /S',
      'echo [%date% %time%] setup exit code %errorlevel% >> "%LOG%"',
      'if errorlevel 1 goto failed',
      'goto success',
      ':success',
      // --- 成功：落 .backup-ts marker（新版主进程读取后弹清理确认）；
      // SKIP_BACKUP 时跳过写 marker（没有备份目录要确认）
      'echo [%date% %time%] update applied >> "%LOG%"',
      'if "%SKIP_BACKUP%"=="0" (',
      '  echo [%date% %time%] writing backup-ts marker=%TS% >> "%LOG%"',
      '  if not exist "%UD%\\updates\\." mkdir "%UD%\\updates" 2>nul',
      '  echo %TS% > "%UD%\\updates\\.backup-ts"',
      ')',
      'del "%SETUP%" >nul 2>&1',
      // 静默安装成功后主动拉起新版本：electron-builder assistedInstaller 的
      // MUI_FINISHPAGE_RUN 挂在 finish 页渲染上，/S 静默模式不渲染该页 →
      // 自更新后无任何重启动作（v4.4 用户实测「程序关闭后不自动重开，版本
      // 仍 4.4.0」）。与失败路径拉起旧版（start "%OLD%"）对称，这里拉起
      // 安装目录里的新主程序（Tauri / Electron 两个 exe 名都探测）。
      'if not "%INST%" == "" (',
      '  if exist "%INST%\\dsh-eac-shell.exe" start "" "%INST%\\dsh-eac-shell.exe"',
      '  if exist "%INST%\\Deepseek Harness EAC.exe" start "" "%INST%\\Deepseek Harness EAC.exe"',
      ')',
      // (goto) 2>nul 先终止批处理上下文，其后的 del/exit 在批处理之外
      // 执行：直接 del 自身再写 exit /b 0 的话，cmd 自删后读不到下一行，
      // 批处理异常终止（退出码 1）。
      '(goto) 2>nul & del "%~f0" >nul 2>&1 & exit /b 0',
      ':failed',
      'echo [%date% %time%] update failed, installer kept for diagnosis >> "%LOG%"',
      // --- 失败：从备份目录反向 robocopy /MIR 回原路径（如果备份已生成）---
      'if "%SKIP_BACKUP%"=="0" if defined TS if exist "%BACKUP%\\manifest.json" (',
      '  echo [%date% %time%] rolling back 4 directories from %BACKUP% >> "%LOG%"',
      '  set "RBAD=0"',
      '  if exist "%BACKUP%\\install\\." (',
      '    robocopy "%BACKUP%\\install" "%INST%" /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '    if errorlevel 8 set RBAD=1',
      '  )',
      '  if exist "%BACKUP%\\dsh\\." (',
      '    robocopy "%BACKUP%\\dsh" "%DSH%" /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '    if errorlevel 8 set RBAD=1',
      '  )',
      '  if exist "%BACKUP%\\profile\\." (',
      '    robocopy "%BACKUP%\\profile" "%PROF%" /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '    if errorlevel 8 set RBAD=1',
      '  )',
      '  if exist "%BACKUP%\\userdata\\." (',
      '    robocopy "%BACKUP%\\userdata" "%UD%" /MIR /XD "%UD%\\updates" "%UD%\\backups" "%UD%\\logs" /XF "*.log" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '    if errorlevel 8 set RBAD=1',
      '  )',
      ')',
      // RBAD 判定必须是括号块外的独立语句：块内 %RBAD% 在整块解析期展开
      // （此时 set 尚未执行），恒为空串 → 永远走 else，日志字面就是
      // "rollback partially failed (code "（v4.4 实测）。移出后本行在块
      // 执行完才被解析，%RBAD% 已是 robocopy 的最终值；入口条件与块相同，
      // 块没跑时本行整体跳过。不用 ENABLEDELAYEDEXPANSION —— 它会把
      // 用户路径里的字面 ! 吃掉。与上方 BAD 的判定模式保持一致。
      'if "%SKIP_BACKUP%"=="0" if defined TS if exist "%BACKUP%\\manifest.json" if "%RBAD%"=="0" (echo [%date% %time%] rollback OK >> "%LOG%") else (echo [%date% %time%] rollback partially failed (code %RBAD%) >> "%LOG%")',
      'if not "%OLD%" == "" if exist "%OLD%" start "" "%OLD%"',
      'exit /b 1'
    );
  }
  return lines;
}

/**
 * 构造 spawn cmd.exe 用的整行命令（配合 /d /s /c 与 windowsVerbatimArguments）。
 *
 * 形如：""C:\app dir\apply-update.cmd" "C:\...\Setup.exe" "app.exe""
 * /s 语义下 cmd 剥掉最外层引号对，还原为带引号的标准参数行；脚本本体
 * 里的 %~1/%~2 因此拿到完整路径。中文路径经 Unicode 命令行传递不受影响
 * （实测 if exist 判定通过）。
 */
function buildSpawnCommandLine(script: string, args: string[]): string {
  return '"' + [script, ...args].map((a) => `"${a}"`).join(' ') + '"';
}

interface InstalledPowerShellArgsOpts {
  actionScript: string;
  newExe: string;
  oldExe: string;
  userDataDir?: string;
  dshHome?: string;
  installDir?: string;
  profileDir?: string;
  currentVersion?: string;
  newVersion?: string;
  nodeExe?: string;
  appPid: number;
  logPath: string;
  waitTimeoutSeconds?: number;
}

function buildInstalledPowerShellArgs(script: string, {
  actionScript,
  newExe,
  oldExe,
  userDataDir,
  dshHome,
  installDir,
  profileDir,
  currentVersion,
  newVersion,
  nodeExe,
  appPid,
  logPath,
  waitTimeoutSeconds = 20,
}: InstalledPowerShellArgsOpts): string[] {
  if (!Number.isInteger(appPid) || appPid <= 0) throw new Error('安装版更新 PID 无效');
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', script,
    '-ActionScriptPath', actionScript,
    '-SetupPath', newExe,
    '-OldExePath', oldExe,
    '-UserDataDir', userDataDir || '',
    '-DshHome', dshHome || '',
    '-InstallDir', installDir || '',
    '-ProfileDir', profileDir || '',
    '-CurrentVersion', currentVersion || '',
    '-NewVersion', newVersion || '',
    '-NodeExePath', nodeExe || '',
    '-AppPid', String(appPid),
    '-LogPath', logPath,
    '-WaitTimeoutSeconds', String(waitTimeoutSeconds),
  ];
}

interface ApplyUpdateOpts {
  userDataDir?: string;
  dshHome?: string;
  installDir?: string;
  profileDir?: string;
  currentVersion?: string;
  newVersion?: string;
  nodeExe?: string;
}

interface PendingUpdate {
  path: string;
  version?: string;
}

function applyUpdate(ctx: UpdateCtx, pending: PendingUpdate, opts?: ApplyUpdateOpts): string {
  const newExe = pending.path;
  const portable = isPortable();
  const oldExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const updateDir = path.join(ctx.userDataDir, 'updates');
  const logPath = path.join(updateDir, 'apply-update.log');
  const userDataDir = (opts && opts.userDataDir) || ctx.userDataDir || '';
  const dshHome = (opts && opts.dshHome) || process.env.DSH_HOME || '';
  const installDir = (opts && opts.installDir) || path.dirname(oldExe);
  const profileDir = (opts && opts.profileDir) || '';
  const currentVersion = (opts && opts.currentVersion) || '';
  const newVersion = (opts && opts.newVersion) || (pending && pending.version) || '';
  const nodeExe = (opts && opts.nodeExe) || '';
  let script: string;
  let child: cp.ChildProcess;
  if (isTauriPortable()) {
    // Tauri 便携：exe + sidecar + dsh-desktop 目录树整体交换（P4/R6）。
    // 等待对象是壳进程 PID（Rust spawn sidecar 时经 DSH_SHELL_PID 注入）。
    script = path.join(updateDir, 'apply-update.ps1');
    fs.writeFileSync(script, buildTauriPortableApplyScript().join('\r\n') + '\r\n');
    const powershell2 = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    if (!fs.existsSync(powershell2)) throw new Error('找不到 Windows PowerShell: ' + powershell2);
    const tauriInstallDir = process.env.DSH_SHELL_EXE ? path.dirname(process.env.DSH_SHELL_EXE) : installDir;
    const shellPid = parseInt(process.env.DSH_SHELL_PID || '', 10) || 0;
    child = cp.spawn(powershell2, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-ZipPath', newExe, '-InstallDir', tauriInstallDir, '-AppPid', String(shellPid),
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } else if (portable) {
    script = path.join(updateDir, 'apply-update.cmd');
    fs.writeFileSync(script, buildApplyScript({ newExe, oldExe, portable: true }).join('\r\n') + '\r\n');
    const args = [newExe, oldExe];
    child = cp.spawn('cmd.exe', ['/d', '/s', '/c', buildSpawnCommandLine(script, args)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } else {
    const actionScript = path.join(updateDir, 'apply-update.cmd');
    script = path.join(updateDir, 'apply-update.ps1');
    const actionLines = buildApplyScript({
      newExe, oldExe, portable: false,
      userDataDir, dshHome, installDir, profileDir, currentVersion, newVersion, nodeExe,
    });
    fs.writeFileSync(actionScript, actionLines.join('\r\n') + '\r\n');
    fs.writeFileSync(script, buildInstalledApplyScript().join('\r\n') + '\r\n', 'ascii');
    const powershell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    if (!fs.existsSync(powershell)) throw new Error('找不到 Windows PowerShell: ' + powershell);
    const args = buildInstalledPowerShellArgs(script, {
      actionScript,
      newExe,
      oldExe,
      userDataDir,
      dshHome,
      installDir,
      profileDir,
      currentVersion,
      newVersion,
      nodeExe,
      appPid: process.pid,
      logPath,
    });
    child = cp.spawn(powershell, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  ctx.log('client-update', `启动更新助手: ${script}（新: ${newExe}，旧: ${oldExe}，备份根: ${userDataDir}\\backups\\<ts>，node: ${nodeExe || '(无，跳过备份)'}）`);
  child.once('error', (err) => ctx.log('client-update', '更新助手启动失败: ' + err.message));
  child.unref();
  return script;
}


// --- 更新备份清理（V4.3/V4.1 保障③承诺的 cleanupClientBackupIfHealthy）------
// 安装版自更新每次在 <userData>/backups/<ts>/ 留 4 目录全量镜像并写
// <userData>/updates/.backup-ts marker；便携版留 <shellExe>.bak(+.bak.marker)。
// 「新版健康启动后清理」的承诺在 Tauri 化后一直没有实现 —— 更新频繁的用户
// 磁盘被逐次吃满。headless sidecar 弹窗会被 fail-closed 兜底自动应答（等同
// 无人选择），因此不做询问交互：备份保留 24h —— 未满 24h 留待下次启动再查，
// 超过即静默删除。便携 .bak 是崩溃自回退保险丝：健康启动（本函数被调到）
// 即不再需要，删 marker + .bak + .crash。
// ⚠️ 必须异步（fs.promises.rm）且由调用方在 boot 应答后延迟调用：真实机器
// 的 backups/ 可累积数 GB 镜像，同步 rm 会冻结 sidecar 事件循环数分钟
//（所有 RPC 卡死 + boot.start 180s 超时弹 died 页，5.3.5 首发实测事故）。
// backups/<ts> 目录名有三种真实格式（apply 脚本时代产生）：
//   10 位 = Unix 秒（PowerShell ToUnixTimeSeconds，主路径）
//   13 位 = Unix 毫秒（测试/早期写入）
//   14 位 = YYYYMMDDHHmmss（PowerShell 缺席时的 batch 兜底，本地时区）
// 直接 parseInt 会把秒级/兜底格式与 Date.now()（毫秒）混比：秒级永远
// 「超过 24h」被立即删（24h 回滚保护窗形同虚设），14 位兜底格式比
// now-ms 还大、永远不删。先按位数归一化到毫秒再比较；配不上回退 mtime，
// mtime 也拿不到就宁留勿删。
function backupDirTimestampMs(name: string, dir: string): number {
  const s = String(name).trim();
  if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000;
  if (/^\d{13}$/.test(s)) return parseInt(s, 10);
  if (/^\d{14}$/.test(s)) {
    const t = new Date(
      +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
      +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14),
    ).getTime();
    if (Number.isFinite(t)) return t;
  }
  try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
}

async function cleanupClientBackupIfHealthy(ctx: UpdateCtx, opts: { shellExe?: string } = {}): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  const KEEP_MS = 24 * 60 * 60 * 1000;
  const backupsDir = path.join(ctx.userDataDir, 'backups');
  let sawBackup = false;
  let entries;
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  } catch { entries = null; /* backups 目录不存在：无安装版备份可清 */ }
  if (entries) {
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      sawBackup = true;
      const dir = path.join(backupsDir, e.name);
      if (fs.existsSync(path.join(dir, '.keep'))) { kept.push(e.name); continue; }
      const at = backupDirTimestampMs(e.name, dir);
      if (!at) continue; // 时间不可判定：宁留勿删
      if (Date.now() - at < KEEP_MS) { kept.push(e.name); continue; }
      try {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
        removed.push(e.name);
      } catch { kept.push(e.name); }
    }
    if (sawBackup && removed.length) {
      ctx.log('update', `已清理更新备份 ${removed.length} 份（保留未满 24h 的 ${kept.length} 份）`);
      if (!kept.length) {
        try { await fs.promises.rm(path.join(ctx.userDataDir, 'updates', '.backup-ts'), { force: true }); } catch { /* 尽力而为 */ }
      }
    }
  }
  const shellExe = opts.shellExe || process.env.DSH_SHELL_EXE || '';
  if (shellExe) {
    try {
      if (fs.existsSync(shellExe + '.bak.marker')) {
        // .bak/.crash 是单文件 exe（百 MB 级），同样走异步删。
        // 删除顺序：marker 必须最后删 —— 它是下次启动再进本分支的门，
        // 先删 marker 后 .bak 失败（杀软/索引器正占着刚换下的百 MB exe）
        // 会永久残留 .bak/.crash（合计 2× exe 体积）且再无重试机会。
        // 各文件独立 try：一个失败不拖累其余的清理。
        for (const suffix of ['.bak', '.crash']) {
          try {
            await fs.promises.rm(shellExe + suffix, { force: true, maxRetries: 3 });
          } catch (err) {
            ctx.log('update', `清理便携 ${suffix} 失败（下次启动重试）: ` + ((err as Error) && (err as Error).message || err));
          }
        }
        await fs.promises.rm(shellExe + '.bak.marker', { force: true });
        ctx.log('update', '新版启动确认健康，已清理便携 .bak 保险丝');
      }
    } catch (err) {
      ctx.log('update', '清理便携 .bak 保险丝失败: ' + ((err as Error) && (err as Error).message || err));
    }
  }
  return { removed, kept };
}

export = { cleanupClientBackupIfHealthy, checkLatest, selectAsset, downloadFile, downloadWithSourceSwitch, downloadRelease, releaseFallbacks, applyUpdate, buildApplyScript, buildInstalledApplyScript, buildInstalledPowerShellArgs, buildSpawnCommandLine, buildTauriPortableApplyScript, isTauriPortable, resolveRepos, normalizeRelease, computeSha256, fetchSumsMap, expectedSha256, isNoSpaceError, githubProxyUrl, downloadUrls };
