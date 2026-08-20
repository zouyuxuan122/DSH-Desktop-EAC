'use strict';

// Release freshness guard (v2.0.3 incident → issue #7).
//
// v2.0.3 shipped artifacts built BEFORE the last source edits. This script
// refuses to bless a dist/ directory when any tracked source file was
// modified after the packaged artifacts were built.
//
// Usage: node scripts/verify-dist-fresh.js [repoRoot]
// Exit 0 = fresh, exit 1 = stale or missing artifacts (with a report).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const IGNORED_PREFIXES = ['dist/', 'node_modules/', 'vendor/', '.git/'];

export interface DistFreshResult {
  ok: boolean;
  offenders: string[];
  error?: string;
  artifactTime?: number;
}

function listSources(repoRoot: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    // Not a git repo (tests): fall back to a directory walk.
    const files: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = path.relative(repoRoot, path.join(dir, e.name)).replace(/\\/g, '/');
        if (e.isDirectory()) {
          if (IGNORED_PREFIXES.some((p) => (p.endsWith('/') ? rel + '/' : rel).startsWith(p))) continue;
          walk(path.join(dir, e.name));
        } else {
          if (IGNORED_PREFIXES.some((p) => rel.startsWith(p))) continue;
          files.push(rel);
        }
      }
    };
    walk(repoRoot);
    return files;
  }
  return out.split(/\r?\n/).filter(Boolean).filter((f) => !IGNORED_PREFIXES.some((p) => f.startsWith(p)));
}

export function verifyDistFresh(repoRoot: string, distDir = path.join(repoRoot, 'dist')): DistFreshResult {
  const artifacts: string[] = [];
  try {
    for (const e of fs.readdirSync(distDir, { withFileTypes: true })) {
      if (e.isFile() && /\.exe$/i.test(e.name)) artifacts.push(path.join(distDir, e.name));
    }
  } catch { /* dist missing */ }
  if (!artifacts.length) {
    return { ok: false, offenders: [], error: 'no packaged artifacts (*.exe) found in dist/' };
  }
  const artifactTime = Math.min(...artifacts.map((p) => fs.statSync(p).mtimeMs));
  const offenders: string[] = [];
  for (const rel of listSources(repoRoot)) {
    const p = path.join(repoRoot, ...rel.split('/'));
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs > artifactTime) offenders.push(rel);
  }
  return { ok: offenders.length === 0, offenders, artifactTime };
}

if (require.main === module) {
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
  const r = verifyDistFresh(repoRoot);
  if (r.ok) {
    console.log('verify-dist-fresh: OK — artifacts newer than every tracked source file');
    process.exit(0);
  }
  console.error('verify-dist-fresh: STALE — ' + (r.error ?? `${r.offenders.length} source file(s) modified after the artifacts were built:`));
  for (const o of r.offenders.slice(0, 40)) console.error('  ' + o);
  if (r.offenders.length > 40) console.error(`  … and ${r.offenders.length - 40} more`);
  console.error('Rebuild (npm run dist) before publishing.');
  process.exit(1);
}
