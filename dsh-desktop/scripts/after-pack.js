'use strict';

// electron-builder afterPack hook.
//
// electron-builder's file copier strips nested node_modules directories from
// extraResources, but the bundled npm CLI needs its own bundled deps
// (graceful-fs, semver, ...). Copy vendor/npm verbatim into the packed app
// after packaging; both the portable and NSIS targets then archive this copy.

const fs = require('node:fs');
const path = require('node:path');
const { buildBundleManifest } = require('../bundle-integrity.js');

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName !== 'win32') return;
  const src = path.resolve(__dirname, '..', 'vendor', 'npm');
  const dest = path.join(appOutDir, 'resources', 'npm');
  if (!fs.existsSync(src)) {
    console.warn('afterPack: vendor/npm missing — npm CLI will not be bundled');
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const deps = fs.readdirSync(path.join(dest, 'node_modules')).length;
  console.log(`afterPack: bundled npm copied (deps: ${deps})`);

  // Same copier also strips nested node_modules / vendor trees inside the
  // app files (assets/**). The community plugins ship self-contained runtime
  // deps (sqlite-vec, jieba, ai sdk, BM25 corpus data, dsh-dafeiyu helper)
  // that must survive verbatim — copy the plugins tree back in.
  const pluginsSrc = path.resolve(__dirname, '..', 'assets', 'plugins');
  const pluginsDest = path.join(appOutDir, 'resources', 'app', 'assets', 'plugins');
  if (fs.existsSync(pluginsSrc)) {
    fs.rmSync(pluginsDest, { recursive: true, force: true });
    fs.cpSync(pluginsSrc, pluginsDest, { recursive: true });
    console.log('afterPack: bundled plugins copied verbatim');
  }

  trimLongPathFiles(appOutDir);
  dedupeNestedModules(appOutDir);
  injectDshClosureExtras(appOutDir);
  writeBundleManifest(appOutDir);
  auditLongPaths(appOutDir);
};

// The profile fallback closure (profiles/node_modules junctions) is maintained
// by dsh-app-boot, whose BFS starts at the BUNDLED dsh package's package.json.
// Companion plugin deps that only exist in the app-layer package.json (e.g.
// better-sidebar → schemastery) are unreachable from that BFS, so the fallback
// never gains a schemastery junction and dsh web dies with ERR_MODULE_NOT_FOUND
// (exit code 1, "启动失败" loop — v3.0.0 field report). Fix at the mechanism
// level: declare those deps in the bundled dsh package too; the BFS then
// resolves them through the app closure (top-level node_modules) and maintains
// the junctions on every launch, idempotently. cosmokit comes along as
// schemastery's own dependency.
function injectDshClosureExtras(appOutDir) {
  const appNm = path.join(appOutDir, 'resources', 'app', 'node_modules');
  const dshPkgPath = path.join(appNm, '@deepseek-ai', 'dsh', 'package.json');
  if (!fs.existsSync(dshPkgPath)) return;
  let dshPkg;
  try { dshPkg = JSON.parse(fs.readFileSync(dshPkgPath, 'utf8')); }
  catch (err) { console.warn('afterPack: cannot parse bundled dsh package.json:', err.message); return; }
  dshPkg.dependencies = dshPkg.dependencies || {};

  const extras = ['schemastery'];
  let injected = 0;
  for (const name of extras) {
    if (dshPkg.dependencies[name]) continue;
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(appNm, name, 'package.json'), 'utf8')).version || ''; }
    catch { console.warn(`afterPack: ${name} not found in app closure — skipped`); continue; }
    dshPkg.dependencies[name] = '^' + version;
    injected++;
  }
  if (injected) {
    fs.writeFileSync(dshPkgPath, JSON.stringify(dshPkg, null, 2) + '\n');
    console.log(`afterPack: injected into dsh closure: ${extras.join(', ')} (fallback junctions will heal on next launch)`);
  }
}

// Issue #7: record a per-package file-count manifest of the FINAL payload
// (after trim/dedupe) so the installed app can detect stripped packages
// (empty skeletons after a botched upgrade) at boot and tell the user to
// reinstall instead of looping on ERR_MODULE_NOT_FOUND.
function writeBundleManifest(appOutDir) {
  const nmRoot = path.join(appOutDir, 'resources', 'app', 'node_modules');
  if (!fs.existsSync(nmRoot)) return;
  const manifest = buildBundleManifest(nmRoot);
  const out = path.join(appOutDir, 'resources', 'app', 'bundle-manifest.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
  console.log(`afterPack: bundle manifest written (${Object.keys(manifest.packages).length} packages)`);
}

// electron-builder's dependency collector needlessly nests some deps under
// their dependents (e.g. @opentelemetry/resources@2.10.0 under
// dsh-session-telemetry-otel) even when the exact same version is already
// hoisted at the top level. The nested copies are the deepest paths in the
// whole tree and triggered the NSIS MAX_PATH silent-drop (issue #4), so drop
// them when identical to the hoisted one — node resolution falls back up to
// the top-level copy, which is byte-identical.
function dedupeNestedModules(appOutDir) {
  const nmRoot = path.join(appOutDir, 'resources', 'app', 'node_modules');
  if (!fs.existsSync(nmRoot)) return;
  const readVersion = (p) => {
    try { return JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version || ''; }
    catch { return null; }
  };
  let removed = 0;
  const scopes = fs.existsSync(nmRoot) ? fs.readdirSync(nmRoot, { withFileTypes: true }) : [];
  for (const s of scopes) {
    if (!s.isDirectory() || !s.name.startsWith('@')) continue;
    for (const pkg of fs.readdirSync(path.join(nmRoot, s.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const nested = path.join(nmRoot, s.name, pkg.name, 'node_modules');
      if (!fs.existsSync(nested)) continue;
      for (const ns of fs.readdirSync(nested, { withFileTypes: true })) {
        if (!ns.isDirectory()) continue;
        const nsDir = path.join(nested, ns.name);
        let candidates = [];
        if (ns.name.startsWith('@')) {
          for (const p2 of fs.readdirSync(nsDir, { withFileTypes: true })) {
            if (p2.isDirectory()) candidates.push([path.join(nsDir, p2.name), `${ns.name}/${p2.name}`]);
          }
        } else {
          candidates.push([nsDir, ns.name]);
        }
        for (const [copyDir, name] of candidates) {
          const topDir = path.join(nmRoot, ...name.split('/'));
          if (!fs.existsSync(path.join(topDir, 'package.json'))) continue;
          if (readVersion(copyDir) === readVersion(topDir)) {
            fs.rmSync(copyDir, { recursive: true, force: true });
            removed++;
            console.log(`afterPack: deduped nested ${name} (== top-level ${readVersion(topDir)})`);
          }
        }
      }
      // drop the node_modules dir itself if we emptied it
      const again = path.join(nmRoot, s.name, pkg.name, 'node_modules');
      try { if (fs.readdirSync(again).length === 0) fs.rmSync(again, { recursive: true, force: true }); } catch {}
    }
  }
  if (!removed) console.log('afterPack: no redundant nested modules found');
}

// The NSIS installer's 7z extractor silently drops files whose full path
// exceeds MAX_PATH (260) — no error, just missing modules at runtime
// (issue #4). Keep the tree short by removing platform-irrelevant payloads
// that also happen to be the deepest ones.
function trimLongPathFiles(appOutDir) {
  const nmRoot = path.join(appOutDir, 'resources', 'app', 'node_modules');
  const kill = [];
  const collect = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // node-pty arm64 payloads are useless in an x64-only build
        if (e.name === 'win32-arm64' && dir.endsWith(path.join('node-pty', 'prebuilds'))) {
          kill.push(p);
        } else if (e.name === 'win10-arm64' && /node-pty[\\/]third_party[\\/]conpty[\\/][^\\/]+$/.test(dir)) {
          kill.push(p);
        } else if (e.name === 'esnext' && /@opentelemetry[\\/]+[^\\/]+[\\/]build$/.test(dir)) {
          // ESM build of @opentelemetry pkgs: runtime dsh is CJS and loads
          // build/src (see issue #4 stack traces) — and esnext holds the
          // deepest paths in the tree (nested copies > MAX_PATH after install)
          kill.push(p);
        } else if (e.name === 'browser' && /@opentelemetry[\\/]+[^\\/]+[\\/]build[\\/]+(esnext|src)[\\/]detectors[\\/]platform$/.test(dir)) {
          // browser-platform telemetry detectors never load under plain node
          kill.push(p);
        } else if (depth < 12) {
          collect(p, depth + 1);
        }
      }
    }
  };
  if (fs.existsSync(nmRoot)) collect(nmRoot, 0);
  for (const p of kill) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`afterPack: trimmed ${path.relative(appOutDir, p)}`);
  }
  // Nested otel copies still hold .js.map files at the deepest runtime paths
  // (the CJS build itself must stay) — source maps are dev-only, drop them.
  let maps = 0;
  const dropMaps = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) dropMaps(p);
      else if (e.name.endsWith('.js.map')) { fs.rmSync(p, { force: true }); maps++; }
    }
  };
  const otelNested = path.join(nmRoot, '@deepseek-ai');
  if (fs.existsSync(otelNested)) {
    for (const pkg of fs.readdirSync(otelNested, { withFileTypes: true })) {
      const nestedNm = path.join(otelNested, pkg.name, 'node_modules', '@opentelemetry');
      if (pkg.isDirectory() && fs.existsSync(nestedNm)) dropMaps(nestedNm);
    }
  }
  if (maps) console.log(`afterPack: dropped ${maps} nested .js.map files`);
}

// Fail loudly at build time if any packed file would risk the silent
// MAX_PATH drop again. Paths are re-based onto a realistic install prefix
// (20-char user name, default per-user Programs dir, version-less product
// folder) — NOT the build machine path — so the numbers reflect what the
// NSIS extractor will actually see.
function auditLongPaths(appOutDir) {
  const INSTALL_PREFIX = 'C:\\Users\\12345678901234567890\\AppData\\Local\\Programs\\Deepseek Harness EAC\\';
  const LIMIT = 260;
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (INSTALL_PREFIX.length + path.relative(appOutDir, p).length >= LIMIT) offenders.push(p);
    }
  };
  walk(appOutDir);
  if (offenders.length) {
    console.warn(`afterPack: WARNING ${offenders.length} file(s) would hit MAX_PATH(${LIMIT}) after install:`);
    for (const p of offenders.slice(0, 20)) console.warn('  ' + p);
    if (offenders.length > 20) console.warn(`  … and ${offenders.length - 20} more`);
  } else {
    console.log(`afterPack: long-path audit clean (install prefix ${INSTALL_PREFIX.length} + relpath < ${LIMIT})`);
  }
}
