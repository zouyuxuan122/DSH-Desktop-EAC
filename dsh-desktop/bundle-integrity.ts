'use strict';

// Bundled node_modules integrity verification (issue #7;
// Wave 3 自 bundle-integrity.js 类型化迁出，行为零变更).
//
// A botched upgrade (old NSIS uninstaller aborting midway: Delete phase done,
// RMDir phase not) leaves packages as empty directory skeletons. Node module
// resolution stops at the skeleton directory instead of continuing upward,
// so dsh web fails deterministically with ERR_MODULE_NOT_FOUND, and the
// profile fallback junction points into the same damaged tree — no recovery.
//
// Strategy: the build (scripts/after-pack.js) records a per-package file
// count manifest at resources/app/bundle-manifest.json. At boot the desktop
// recounts the installed tree and compares: any package whose directory is
// missing, whose package.json is gone, or whose file count DROPPED is
// reported as damaged, with an explicit user-facing message instead of a
// cryptic module error. Extra files appearing are tolerated (only losses
// break module resolution).

import fs = require('node:fs');
import path = require('node:path');

interface BundleManifest {
  version: number;
  packages: Record<string, { files: number }>;
}

export interface DamagedPackage {
  name: string;
  expected?: number;
  actual?: number;
  reason: string;
}

/** Count files (not dirs) recursively under dir. Symlinks count as files. */
function countFiles(dir: string): number {
  let n = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n += 1;
  }
  return n;
}

/**
 * Build the manifest for a node_modules tree: top-level packages and
 * @scope/* packages (depth 2), keyed by full package name.
 */
export function buildBundleManifest(nmRoot: string): BundleManifest {
  const packages: Record<string, { files: number }> = {};
  let entries;
  try { entries = fs.readdirSync(nmRoot, { withFileTypes: true }); } catch { return { version: 1, packages }; }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    if (e.name.startsWith('@')) {
      let scoped;
      try { scoped = fs.readdirSync(path.join(nmRoot, e.name), { withFileTypes: true }); } catch { continue; }
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
 * Verify an installed node_modules tree against a manifest.
 */
export function verifyBundle(
  nmRoot: string,
  manifest: BundleManifest | null | undefined,
): { ok: boolean; skipped?: boolean; damaged: DamagedPackage[] } {
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
