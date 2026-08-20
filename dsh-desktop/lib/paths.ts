/**
 * lib/paths.ts — 路径围栏与 profile 解析（Task 1.2 自 main.js 提取，逻辑等价）。
 *
 * 两类职责：
 *   1) H2/H3 路径围栏：fileRoots / isUnderFileRoots / DANGEROUS_EXT ——
 *      文件还原/打开只允许「会话 cwd」之下的项目文件，任意绝对路径
 *      （如写入 Startup\*.bat）一律拒绝；
 *   2) 桌面专属 profile：web-desktop（或 settings.shareWebProfile=true 时共享
 *      官方 web profile）的解析、初始化与派生目录。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import { scanZstdFrames } from '../session-watcher.js';
import * as updater from '../updater.js';
import { state } from './state.js';
import { log } from './log.js';
import { updCtx } from './proc.js';

/**
 * 危险扩展名围栏：文件视图/还原入口拒绝可执行类文件（H2/H3 安全边界，
 * 被 main.js 的 IPC 文件打开/还原 handler 使用）。
 */
export const DANGEROUS_EXT =
  /\.(bat|cmd|com|exe|ps1|vbs|lnk|js|jse|msi|scr|pif|reg)$/i;

/** 桌面专属 profile 名（与官方 web profile 彻底共存，见下方长注释）。 */
export const DESKTOP_PROFILE = 'web-desktop';

/** 与官方 web profile 出厂模板一致的 bundle 清单。 */
export const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

// ---------------------------------------------------------------------------
// H2/H3 路径围栏：会话 cwd 根集合，缓存 5 分钟。
// ---------------------------------------------------------------------------
const fileRootsCache: { at: number; roots: string[] } = { at: 0, roots: [] };

/**
 * 枚举「会话 cwd」根目录集合：扫描 DSH_HOME/sessions 下所有
 * session.jsonl.zstd，解出每个会话 header 的 cwd 字段。
 * 任意绝对路径（如写入 Startup\*.bat）不在根集合之下即被围栏拒绝。
 */
export function fileRoots(): string[] {
  if (Date.now() - fileRootsCache.at < 5 * 60 * 1000) return fileRootsCache.roots;
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const roots: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (e.name !== 'session.jsonl.zstd') continue;
      try {
        const buf = fs.readFileSync(p);
        const { frames } = scanZstdFrames(buf);
        if (frames.length === 0) continue;
        const first = frames[0];
        if (!first) continue;
        const text = zlib.zstdDecompressSync(buf.subarray(first.start, first.end)).toString('utf8');
        const header = JSON.parse(text.split('\n', 1)[0] ?? '') as { cwd?: unknown };
        if (header && typeof header.cwd === 'string' && header.cwd) roots.push(header.cwd);
      } catch {
        /* 跳过损坏日志 */
      }
    }
  };
  walk(path.join(dshHome, 'sessions'));
  fileRootsCache.roots = [...new Set(roots)];
  fileRootsCache.at = Date.now();
  return fileRootsCache.roots;
}

/** 路径是否落在任一会话 cwd 根之下（含根本身）。 */
export function isUnderFileRoots(p: string): boolean {
  const resolved = path.resolve(p);
  return fileRoots().some((r) => {
    const rp = path.resolve(r);
    return resolved === rp || resolved.startsWith(rp + path.sep);
  });
}

// ---------------------------------------------------------------------------
// 桌面专属 profile（与原生 CLI 彻底共存）：
//
// 历史冲突根因有二 ——
//   1. 桌面端把配套插件行/包直接写进原生 `web` profile，pnpm 安装、patch
//      行互踩，原生 CLI 跟着崩；
//   2. dsh-app-boot 会把 <home>/profiles/node_modules 的共享 junction 指向
//      「当前运行的 dsh 实例」自己的闭包 —— 原生 npx dsh 一跑，桌面端模块
//      解析被换血（版本错位 / npx 缓存清理后悬空）。
// 桌面端从此默认运行在独立 profile `web-desktop`（DSH_HOME 不变：会话、
// API Key、settings.yaml 依旧共享）；junction 归属由 plugin-guard 周期守卫。
// 旧共享模式仍可用（settings.shareWebProfile = true），仅供特殊需要。
// ---------------------------------------------------------------------------

/** 当前桌面端使用的 profile 名（shareWebProfile=true 时共享官方 web）。 */
export function desktopProfile(): string {
  try {
    const s = updater.loadSettings(updCtx());
    return s.shareWebProfile === true ? 'web' : DESKTOP_PROFILE;
  } catch {
    return DESKTOP_PROFILE;
  }
}

/** 当前 profile 的目录（<dshHome>/profiles/<profile>）。 */
export function desktopProfileDir(): string {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', desktopProfile());
}

/**
 * 未知 profile 不会自动初始化（dsh 直接报错退出），桌面端自己按官方模板
 * 创建：package.json（bundles）+ pnpm-workspace.yaml + 空 patch 层。
 */
export function ensureDesktopProfileInit(): void {
  try {
    const dir = desktopProfileDir();
    if (desktopProfile() === 'web') return; // 共享模式走官方模板
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(
        manifest,
        JSON.stringify(
          {
            name: 'dsh-profile-' + desktopProfile(),
            private: true,
            dependencies: {},
            dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
          },
          null,
          2,
        ) + '\n',
      );
      log('boot', '已初始化桌面专属 profile: ' + dir);
    }
    if (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      fs.writeFileSync(
        path.join(dir, 'pnpm-workspace.yaml'),
        'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
      );
    }
    if (!fs.existsSync(path.join(dir, 'cordis.patch.yml'))) {
      fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n');
    }
  } catch (err) {
    log('boot', '初始化桌面 profile 失败: ' + String((err as Error).message));
  }
}

/** 任意 profile 名 → 其目录（供插件市场/缓存等按 profile 派生路径）。 */
export function profileDirFor(profile: string): string {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', profile);
}

/** 任意 profile 名 → 其插件构建产物缓存目录。 */
export function artifactCacheDirFor(profile: string): string {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'plugin-artifact-cache', profile);
}
