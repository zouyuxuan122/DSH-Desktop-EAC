/**
 * bundle-integrity.ts — 捆绑 node_modules 完整性校验（issue #7）（Task 7.1
 * 自 bundle-integrity.js 迁 TS）。
 *
 * 升级被打断（旧 NSIS 卸载器中止在 Delete 完、RMDir 未做）会留下空目录
 * 骨架包。Node 模块解析停在骨架目录不再向上继续，dsh web 必然
 * ERR_MODULE_NOT_FOUND，且 profile fallback junction 指向同一受损树 ——
 * 无法自愈。
 *
 * 策略：构建期（scripts/after-pack.js）把每包文件数清单记录到
 * resources/app/bundle-manifest.json；启动时重数安装树比对：目录缺失 /
 * package.json 丢失 / 文件数下降的包判为受损，给出用户可读的提示而不是
 * 神秘的模块错误。多出的文件容忍（只有丢失才会破坏模块解析）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 清单里的单包条目。 */
export interface BundleManifestEntry {
  files: number;
}

/** bundle-manifest.json 的形状。 */
export interface BundleManifest {
  version: 1;
  packages: Record<string, BundleManifestEntry>;
}

/** 受损包描述。 */
export interface DamagedPackage {
  name: string;
  expected?: number;
  actual?: number;
  reason: string;
}

/** verifyBundle 的结果。 */
export interface VerifyResult {
  ok: boolean;
  skipped?: boolean;
  damaged: DamagedPackage[];
}

/** 递归统计 dir 下的文件数（不含目录；符号链接按文件计）。 */
function countFiles(dir: string): number {
  let n = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n += 1;
  }
  return n;
}

/**
 * 为 node_modules 树生成清单：顶层包与 @scope/* 包（深度 2），按完整包名
 * 为键。
 */
export function buildBundleManifest(nmRoot: string): BundleManifest {
  const packages: Record<string, BundleManifestEntry> = {};
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nmRoot, { withFileTypes: true });
  } catch {
    return { version: 1, packages };
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    if (e.name.startsWith('@')) {
      let scoped: fs.Dirent[];
      try {
        scoped = fs.readdirSync(path.join(nmRoot, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (!s.isDirectory() || s.isSymbolicLink()) continue;
        packages[`${e.name}/${s.name}`] = { files: countFiles(path.join(nmRoot, e.name, s.name)) };
      }
    } else {
      packages[e.name] = { files: countFiles(path.join(nmRoot, e.name)) };
    }
  }
  return { version: 1, packages };
}

/**
 * 对照清单校验已安装的 node_modules 树。
 * manifest 缺失/为空 → skipped（不打扰）。
 */
export function verifyBundle(nmRoot: string, manifest: BundleManifest | null): VerifyResult {
  if (!manifest || !manifest.packages) return { ok: true, skipped: true, damaged: [] };
  const damaged: DamagedPackage[] = [];
  for (const [name, meta] of Object.entries(manifest.packages)) {
    const pkgDir = path.join(nmRoot, ...name.split('/'));
    if (!fs.existsSync(pkgDir)) {
      damaged.push({ name, reason: 'missing', expected: meta.files, actual: 0 });
      continue;
    }
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
      damaged.push({ name, reason: 'no package.json (empty skeleton)', expected: meta.files, actual: countFiles(pkgDir) });
      continue;
    }
    const actual = countFiles(pkgDir);
    if (actual < meta.files) {
      damaged.push({ name, reason: 'files lost', expected: meta.files, actual });
    }
  }
  return { ok: damaged.length === 0, damaged };
}
