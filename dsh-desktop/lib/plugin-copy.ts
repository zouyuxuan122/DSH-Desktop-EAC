/**
 * lib/plugin-copy.ts — 插件包复制家族（Task 5.2 自 main.js 提取；Task 12.2
 * 性能重写：单遍走树 + 进程内戳记缓存）。
 *
 * 拷贝一个插件包目录到 profile node_modules（按包名 scope 落位，幂等）。
 * V4 关键优化：先比对「源 vs 目标」内容戳记，一致则跳过 —— 旧逻辑每次启动
 * 全量重拷（dsh-pet 15MB、dsh-dafeiyu ~58MB 资产，拖慢启动）。戳记文件放
 * 在包目录内（.eac-copy-stamp.json），pnpm 重写 node_modules 时随目录消失，
 * 天然触发重建。
 *
 * Task 12.2 两项改造（bench-boot 度量：冷启动关键路径 3.8s → 亚秒级）：
 *   1. 单遍走树 —— 旧实现每文件 existsSync+statSync×2（~5 次 IO/文件），
 *      现为每目录 1 次 readdirSync(withFileTypes) + 每文件 1 次 statSync，
 *      顶层候选成员关系由一次 readdir 判定；
 *   2. 进程内戳记缓存 —— syncCompanionPlugins 单次启动对同一源目录调用两
 *      次（boot 早期 + 服务启动前），第二次直接命中缓存，免全量走树。
 *
 * 戳记格式 {v,f,b,h}：h 为逐文件 (rel|size|mtimeMs) 的 FNV-1a 滚动哈希 ——
 * 比旧 {v,f,b} 多捕获「同字节数就地改写」（NSIS 原地覆盖更新文件后 mtime
 * 变而 size 可能不变，旧戳记会误判未变化而跳过重拷）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 随插件/皮肤包一起拷贝的许可与出处文件（存在才拷贝）。 */
export const EXTRA_PACKAGE_FILES = [
  'LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md',
  'README.md', 'README.zh.md', 'THIRD-PARTY-NOTICES.md',
];

const COPY_STAMP = '.eac-copy-stamp.json';

// 顶层候选文件与目录（拷贝清单；多算/漏算只影响戳记稳定性，不会拷错内容：
// 目录不存在时走树器直接跳过）。与旧实现清单逐项一致。
const TOP_FILES = [
  'package.json', 'skin.json', ...EXTRA_PACKAGE_FILES,
  'index.js', 'client.js', 'recall-inject.js', 'cordis.patch.yml',
];
const TOP_DIRS = ['lib', 'preview', 'vendor', 'node_modules', 'data', 'assets', 'runtime', 'src', 'client'];

/** 安全读 JSON（损坏/缺失返回 null）。 */
export function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 单遍走树器（Task 12.2）
// ---------------------------------------------------------------------------

/**
 * 枚举拷贝清单内全部文件，对每个文件回调 (rel, st)。
 *
 * 语义与旧 existsSync+statSync 双查完全一致：符号链接/junction 一律跟随
 * （statSync 语义）—— 链接→文件按内容计入；链接→目录在嵌套层不递归
 * （旧 Dirent.isDirectory() 对链接为 false，同样跳过）。任何单点 IO 失败
 * 静默跳过，绝不抛出。
 */
function walkCopySet(src: string, onFile: (rel: string, st: fs.Stats) => void): void {
  let top: fs.Dirent[];
  try {
    top = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  const topNames = new Set(top.map((e) => e.name));

  const emitFile = (rel: string): void => {
    try {
      const st = fs.statSync(path.join(src, rel));
      if (st.isFile()) onFile(rel, st);
    } catch {
      /* 单文件 stat 失败忽略 */
    }
  };

  const walkDir = (rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(src, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const sub = rel + '/' + e.name;
      if (e.isDirectory()) walkDir(sub);
      else emitFile(sub);
    }
  };

  // 顶层候选：readdir 成员判定替代逐个 existsSync（省 ~14 次 stat/包）。
  for (const f of TOP_FILES) {
    if (topNames.has(f)) emitFile(f);
  }
  for (const d of TOP_DIRS) {
    if (!topNames.has(d)) continue;
    let isDir = false;
    try {
      // statSync 跟随链接（旧语义：链接→目录同样递归拷内容）。
      isDir = fs.statSync(path.join(src, d)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walkDir(d);
  }
}

// ---------------------------------------------------------------------------
// 内容戳记（Task 12.2：{v,f,b} → {v,f,b,h}）
// ---------------------------------------------------------------------------

/** FNV-1a 32 位滚动哈希（变更检测用；碰撞后果只是多一次无害重拷）。 */
function stampHash(files: Array<{ rel: string; size: number; mtimeMs: number }>): string {
  let h = 0x811c9dc5;
  for (const f of files) {
    const s = `${f.rel}|${f.size}|${Math.round(f.mtimeMs)};`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16);
}

/** 直接走树计算戳记（无缓存；bench-boot 度量冷启动真实成本用）。 */
function computeStamp(src: string): string | null {
  try {
    const pkg = readJsonFile(path.join(src, 'package.json')) ?? {};
    let files = 0;
    let bytes = 0;
    const acc: Array<{ rel: string; size: number; mtimeMs: number }> = [];
    walkCopySet(src, (rel, st) => {
      files += 1;
      bytes += st.size;
      acc.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
    });
    return JSON.stringify({
      v: String(pkg.version ?? ''), f: files, b: bytes, h: stampHash(acc),
    });
  } catch {
    return null;
  }
}

// 进程内戳记缓存：源目录路径 → {顶层 mtimeMs, 戳记}。失效条件 = 源目录
// 顶层 mtime 变化（文件增删改名、覆盖层 rename 原子切换都会改变它）；进程
// 重启缓存天然清空。「就地改写文件内容但不增删条目」不改变目录 mtime ——
// 生产路径不存在该写入方（资产目录只读；覆盖层经 staging rename 整体切换），
// 且戳记 h 含文件级 mtime，任何真实改写都会在下次全量走树时被捕获。
const stampCache = new Map<string, { dirMtimeMs: number; stamp: string | null }>();

/**
 * 计算源目录内容戳记（带进程内缓存）。
 * syncCompanionPlugins 单次启动对同一源调用两次，第二次命中缓存免走树
 * （bench-boot：39 插件 ~1.1s → ~3 次 IO/插件）。
 */
export function pluginStampOf(src: string): string | null {
  let dirMtimeMs = 0;
  try {
    dirMtimeMs = fs.statSync(src).mtimeMs;
  } catch {
    return null; // 源目录不存在：不缓存（之后可能被创建，如覆盖层下载完成）
  }
  const hit = stampCache.get(src);
  if (hit && hit.dirMtimeMs === dirMtimeMs) return hit.stamp;
  const stamp = computeStamp(src);
  stampCache.set(src, { dirMtimeMs, stamp });
  return stamp;
}

/** 绕过缓存直接走树（bench-boot 度量冷路径用）。 */
export function pluginStampOfUncached(src: string): string | null {
  return computeStamp(src);
}

/** 清空进程内戳记缓存（测试/同进程内整体替换源目录树的场景）。 */
export function invalidatePluginStampCache(): void {
  stampCache.clear();
}

/** 拷贝插件包到 profile node_modules（内容戳记一致则跳过；幂等）。 */
export function copyPluginPackage(profileDirP: string, src: string, name: string): void {
  const destRoot = path.join(profileDirP, 'node_modules', ...name.split('/'));
  const stampFile = path.join(destRoot, COPY_STAMP);
  const want = pluginStampOf(src);
  try {
    if (want && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === want) {
      return; // 内容未变：跳过全量重拷
    }
  } catch {
    /* 比对失败按需重拷 */
  }
  fs.mkdirSync(path.dirname(destRoot), { recursive: true });
  // 拷贝清单与戳记走树器共享（同一套 TOP_FILES/TOP_DIRS），双 walk 保证
  // 戳记与实际拷贝内容严格一致。
  walkCopySet(src, (rel) => {
    const df = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(df), { recursive: true });
    fs.copyFileSync(path.join(src, rel), df);
  });
  if (want) {
    try {
      fs.mkdirSync(destRoot, { recursive: true });
      fs.writeFileSync(stampFile, want);
    } catch {
      /* 戳记写失败不影响功能 */
    }
  }
}
