/**
 * lib/client-update/release.ts — 发布源查询 / release 规范化 / 资产选择（Task 6.1
 * 自 client-updater.js 提取）。
 *
 * 发布源优先级：GitHub Releases → Gitee Releases；可用环境变量
 * DSH_DESKTOP_RELEASE_API 指向自定义镜像 API。Gitee 因单文件 100MB 限制
 * 把安装包拆成 .part1/.part2 分片，selectAsset 自动识别分片序列。
 */

import { compareVersions } from '../../updater.js';
import { httpGetJson, getResponse } from './net.js';
import type { ApiEndpoint, AssetSelection, ClientUpdCtx, NormalizedRelease } from './types.js';

/** 默认发布仓库（owner/repo slug）。 */
export const DEFAULT_REPOS = { github: 'zouyuxuan122/Deepseek-Harness-EAC', gitee: 'zouyuxuan122/Deepseek-Harness-EAC' };

/** 合法 slug 形状（防配置注入路径穿越等怪值）。 */
const REPO_SLUG = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;

/** 完整安装包远大于 64MB —— 防止把错误页/占位文件当 exe。 */
export const MIN_VALID_BYTES = 64 * 1024 * 1024;

/** 是否便携版（PORTABLE_EXECUTABLE_DIR 由 portable 启动器注入）。 */
export function isPortable(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

/** 解析仓库地址（格式非法或缺省时回退到内置默认仓库）。 */
export function resolveRepos(repos?: unknown): { github: string; gitee: string } {
  const r = repos && typeof repos === 'object' ? (repos as Record<string, unknown>) : {};
  const github = REPO_SLUG.test(String(r.github || '')) ? String(r.github) : DEFAULT_REPOS.github;
  const gitee = REPO_SLUG.test(String(r.gitee || '')) ? String(r.gitee) : DEFAULT_REPOS.gitee;
  return { github, gitee };
}

/** 组装发布源端点列表（自定义镜像优先）。 */
export function apiEndpoints(): ApiEndpoint[] {
  const custom = process.env.DSH_DESKTOP_RELEASE_API;
  if (custom) {
    // 自定义镜像：兼容 latest 单对象与 releases 列表两种形态。
    return [{ name: '自定义镜像', url: custom }];
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

/** 把 GitHub/Gitee/镜像的 release JSON 规范化为 NormalizedRelease。 */
export function normalizeRelease(source: string, data: Record<string, unknown>): NormalizedRelease {
  const tag = String(data.tag_name || data.tag || data.name || '').trim();
  const version = tag.replace(/^v/i, '');
  const rawAssets = Array.isArray(data.assets) ? (data.assets as Record<string, unknown>[]) : [];
  const assets = rawAssets
    .map((a): { name: string; url: string; size: number; sha256?: string } => {
      const item: { name: string; url: string; size: number; sha256?: string } = {
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
    .filter((a) => a.name && a.url);
  return {
    source,
    version,
    name: (data.name as string) || null,
    body: String(data.body || ''),
    htmlUrl: (data.html_url as string) || null,
    assets,
  };
}

/**
 * 依次查询发布源，取「第一个含本平台资产的最新 release」。
 * 返回的 release 带 isNewer（与 currentVersion 比较）。
 */
export async function checkLatest(ctx: ClientUpdCtx, currentVersion: string): Promise<NormalizedRelease> {
  const errors: string[] = [];
  for (const ep of apiEndpoints()) {
    try {
      const data = await httpGetJson(ep.url, ep.headers || {});
      // 兼容两种形态：/releases/latest 的单对象 与 /releases 列表数组。
      const rawList = Array.isArray(data) ? data : [data];
      // 与 /latest 同语义：过滤 draft / prerelease；再按版本号降序稳定排序
      // （API 默认按创建时间，releases 被编辑/补传资产时版本序更可靠）。
      const releases = rawList
        .filter((r) => {
          const o = r as Record<string, unknown>;
          return r && !o.draft && !o.prerelease;
        })
        .map((r) => normalizeRelease(ep.name, r as Record<string, unknown>))
        .filter((r) => r.version)
        .sort((a, b) => compareVersions(b.version, a.version));
      if (!releases.length) throw new Error('上游没有可见的 release');
      // 自新向旧找「第一个含本平台（Windows）资产的 release」。只有
      // Linux 资产（.AppImage/.deb/.zip 等）的版本对 selectAsset 不可选，
      // 记录后跳过 —— Windows 用户接不到 Linux-only 更新，也不会漏掉
      // 更早的 Windows 版本（回退语义）。
      const skippedNoAsset: string[] = [];
      let picked: NormalizedRelease | null = null;
      for (const rel of releases) {
        try {
          selectAsset(rel);
          picked = rel;
          break;
        } catch {
          skippedNoAsset.push(rel.version);
        }
      }
      if (!picked) {
        throw new Error('最近 20 个 release 都没有本平台（Windows）的安装包资产');
      }
      picked.isNewer = compareVersions(picked.version, currentVersion) > 0;
      ctx.log(
        'client-update',
        `[${ep.name}] 本平台最新=${picked.version} 当前=${currentVersion} 资产数=${picked.assets.length}` +
          (skippedNoAsset.length ? `；跳过无 Windows 资产的版本: ${skippedNoAsset.join(', ')}` : ''),
      );
      return picked;
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${ep.name}: ${msg}`);
      ctx.log('client-update', `[${ep.name}] 查询失败: ${msg}`);
    }
  }
  throw new Error('无法连接上游发布源（' + errors.join('；') + '）');
}

/**
 * 按当前部署形态选择安装包资产：
 *   - 便携版：*-portable-x64.exe；安装版：Setup-*-x64.exe；
 *   - Gitee 分片（<file>.part1/.part2 …）自动按序收集。
 * 无匹配资产抛错（checkLatest 据此跳过无 Windows 资产的版本）。
 */
export function selectAsset(release: NormalizedRelease): AssetSelection {
  // 资产命名：Deepseek-Harness-EAC-<version>-Setup-x64.exe / …-Portable-x64.exe。
  // 旧正则 /-setup-.*-x64\.exe$/ 要求 -setup- 之后还有第二个 "-x64"，
  // 对 "…-v2.0.1-Setup-x64.exe"（-Setup- 直接连 x64.exe）永远匹配失败，
  // 更新流程卡死在“未找到匹配的安装包资产”。锚定 \.exe$ 保证 .blockmap
  // 等附属资产不会被误选。
  // V4 平台围栏：文件名带 linux/arm64 等标记的一律不选（双平台发布时
  // 防止误拿；x64 正则本身已排除 arm64，这里再显式拒绝）。
  const wanted = isPortable() ? /portable.*x64\.exe$/i : /setup.*x64\.exe$/i;
  const platformOk = (name: string): boolean => !/linux|arm64|aarch64|appimage|\.deb$|\.rpm$|\.snap$/i.test(name);
  const direct = release.assets.find((a) => wanted.test(a.name) && platformOk(a.name));
  if (direct) return { parts: [direct], name: direct.name, totalSize: direct.size };

  // Gitee 单文件 100MB 限制：安装包拆分为 <file>.part1 / <file>.part2 …
  // v2.0.3 起 artifact 名不再带版本号，两个候选都试（覆盖旧 Release）。
  const kind = isPortable() ? 'Portable' : 'Setup';
  const bases = [
    `Deepseek-Harness-EAC-${kind}-x64.exe`,
    `Deepseek-Harness-EAC-v${release.version}-${kind}-x64.exe`,
    `Deepseek-Harness-EAC-${release.version}-${kind}-x64.exe`,
  ];
  let base = '';
  let parts: NormalizedRelease['assets'] = [];
  for (const b of bases) {
    parts = release.assets
      .filter((a) => a.name.startsWith(b + '.part'))
      .sort((a, b2) => {
        const n = (s: string): number => parseInt(s.split('part').pop() ?? '0', 10) || 0;
        return n(a.name) - n(b2.name);
      });
    if (parts.length) {
      base = b;
      break;
    }
  }
  if (!parts.length) {
    throw new Error('未找到匹配的安装包资产（' + release.assets.map((a) => a.name).join(', ') + '）');
  }
  return { parts, name: base, totalSize: parts.reduce((s, p) => s + p.size, 0) };
}

/** 找到 release 里的 SHA256SUMS.txt 资产并解析成 Map（文件名小写 → hex）。 */
export async function fetchSumsMap(ctx: ClientUpdCtx, release: NormalizedRelease): Promise<Map<string, string> | null> {
  const sumsAsset = release.assets.find((a) => /^sha-?256-?sums?\.txt$/i.test(a.name));
  if (!sumsAsset) return null;
  try {
    const { status, stream } = await getResponse(sumsAsset.url, { timeoutMs: 20_000 });
    if (status !== 200) {
      stream.resume();
      return null;
    }
    let text = '';
    await new Promise<void>((resolve, reject) => {
      stream.setEncoding?.('utf8');
      stream.on('data', (c: string) => {
        text += c;
        if (text.length > 65536) stream.destroy?.(new Error('sums 过大'));
      });
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    const map = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
      if (m) {
        const name = m[2] as string;
        const hex = m[1] as string;
        map.set(name.toLowerCase(), hex.toLowerCase());
      }
    }
    return map;
  } catch (err) {
    ctx.log('client-update', `SHA256SUMS 获取失败（跳过该来源）: ${(err as Error).message}`);
    return null;
  }
}

/** 组装“期望哈希”：digest 字段优先，其次 SHA256SUMS 条目。 */
export async function expectedSha256(
  ctx: ClientUpdCtx,
  release: NormalizedRelease,
  sel: AssetSelection,
): Promise<string | null> {
  // 单资产（无分片）：digest 直接可用。
  const first = sel.parts[0];
  if (sel.parts.length === 1 && first?.sha256) return first.sha256;
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
export async function releaseFallbacks(
  ctx: ClientUpdCtx,
  release: NormalizedRelease,
  opts: { apiEndpointsList?: ApiEndpoint[] | null } = {},
): Promise<NormalizedRelease[]> {
  const eps = opts.apiEndpointsList || apiEndpoints();
  const fallbacks: NormalizedRelease[] = [];
  for (const ep of eps) {
    if (ep.name === release.source) continue;
    try {
      const data = await httpGetJson(ep.url, ep.headers || {});
      const rawList = Array.isArray(data) ? data : [data];
      const same = rawList
        .filter((r) => {
          const o = r as Record<string, unknown>;
          return r && !o.draft && !o.prerelease;
        })
        .map((r) => normalizeRelease(ep.name, r as Record<string, unknown>))
        .find((r) => r.version === release.version);
      if (!same) {
        ctx.log('client-update', `[${ep.name}] 无 ${release.version} 的 release（跳过备用源）`);
        continue;
      }
      try {
        selectAsset(same);
      } catch {
        continue; // 该源没有可用资产，跳过
      }
      fallbacks.push(same);
      ctx.log('client-update', `[${ep.name}] 已就绪为 ${release.version} 的备用下载源`);
    } catch (err) {
      ctx.log('client-update', `[${ep.name}] 备用源探测失败: ${(err as Error).message}`);
    }
  }
  return fallbacks;
}
