'use strict';
// ---------------------------------------------------------------------------
// electron-builder afterPack 钩子（编译产物 scripts/after-pack.js 由
// electron-builder.yml 的 afterPack 字段加载；resolveFunction 会优先取
// 模块的 afterPack 命名导出）。
//
// electron-builder 的文件复制器会剥离 extraResources 里的嵌套 node_modules，
// 而内置 npm CLI 需要自带依赖（graceful-fs、semver 等）。打包完成后把
// vendor/npm 原样拷回 app 内，portable 与 NSIS 两个目标随后归档这份拷贝。
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBundleManifest } from '../bundle-integrity.js';

/** electron-builder 传入的打包上下文（结构子集，足以覆盖本钩子用到的字段）。 */
export interface AfterPackContext {
  appOutDir: string;
  electronPlatformName: string;
}

export async function afterPack(context: AfterPackContext): Promise<void> {
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

  // 同一个复制器也会剥离 app 文件（assets/**）里的嵌套 node_modules / vendor
  // 树。社区插件（尤其 tdai-memory）自带自包含运行时依赖（sqlite-vec、jieba、
  // ai sdk、BM25 语料数据），必须原样存活 —— 把插件树整体拷回。
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
}

// profile 回退闭包（profiles/node_modules junction）由 dsh-app-boot 维护，
// 其 BFS 从「内置 dsh 包的 package.json」出发。只存在于 app 层 package.json
// 的伴生插件依赖（如 better-sidebar → schemastery）对该 BFS 不可达，回退
// 闭包永远不会建立 schemastery junction，dsh web 以 ERR_MODULE_NOT_FOUND
// 死亡（退出码 1，「启动失败」循环 —— v3.0.0 现场报告）。机制级修复：把这些
// 依赖也声明进内置 dsh 包，BFS 就会经由 app 闭包（顶层 node_modules）解析，
// 并在每次启动时幂等地维护 junction。cosmokit 作为 schemastery 的自身依赖
// 一并带入。
function injectDshClosureExtras(appOutDir: string): void {
  const appNm = path.join(appOutDir, 'resources', 'app', 'node_modules');
  const dshPkgPath = path.join(appNm, '@deepseek-ai', 'dsh', 'package.json');
  if (!fs.existsSync(dshPkgPath)) return;
  let dshPkg: { dependencies?: Record<string, string> } & Record<string, unknown>;
  try {
    dshPkg = JSON.parse(fs.readFileSync(dshPkgPath, 'utf8'));
  } catch (err) {
    console.warn('afterPack: cannot parse bundled dsh package.json:', (err as Error).message);
    return;
  }
  dshPkg.dependencies = dshPkg.dependencies || {};

  const extras = ['schemastery'];
  let injected = 0;
  for (const name of extras) {
    if (dshPkg.dependencies[name]) continue;
    let version = '';
    try {
      version = (JSON.parse(fs.readFileSync(path.join(appNm, name, 'package.json'), 'utf8')) as { version?: string }).version || '';
    } catch {
      console.warn(`afterPack: ${name} not found in app closure — skipped`);
      continue;
    }
    dshPkg.dependencies[name] = '^' + version;
    injected++;
  }
  if (injected) {
    fs.writeFileSync(dshPkgPath, JSON.stringify(dshPkg, null, 2) + '\n');
    console.log(`afterPack: injected into dsh closure: ${extras.join(', ')} (fallback junctions will heal on next launch)`);
  }
}

// Issue #7：为最终载荷（裁剪/去重后）记录逐包文件数清单，安装后的应用可在
// boot 时检测被剥离的包（失败升级留下的空骨架），提示用户重装而不是在
// ERR_MODULE_NOT_FOUND 上循环。
function writeBundleManifest(appOutDir: string): void {
  const nmRoot = path.join(appOutDir, 'resources', 'app', 'node_modules');
  if (!fs.existsSync(nmRoot)) return;
  const manifest = buildBundleManifest(nmRoot);
  const out = path.join(appOutDir, 'resources', 'app', 'bundle-manifest.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
  console.log(`afterPack: bundle manifest written (${Object.keys(manifest.packages).length} packages)`);
}

// electron-builder 的依赖收集器会把某些依赖无谓地嵌套在其依赖方之下（例如
// dsh-session-telemetry-otel 下的 @opentelemetry/resources@2.10.0），即使顶层
// 已提升出完全相同的版本。这些嵌套副本是全树最深的路径，触发了 NSIS 的
// MAX_PATH 静默丢弃（issue #4）——与顶层逐字节相同时删掉嵌套副本，node 的
// 解析会向上回退到顶层副本。
function dedupeNestedModules(appOutDir: string): void {
  const nmRoot = path.join(appOutDir, 'resources', 'app', 'node_modules');
  if (!fs.existsSync(nmRoot)) return;
  const readVersion = (p: string): string | null => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')) as { version?: string }).version || '';
    } catch {
      return null;
    }
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
        let candidates: Array<[string, string]> = [];
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
      // 掏空后顺手移除 node_modules 目录本身
      const again = path.join(nmRoot, s.name, pkg.name, 'node_modules');
      try {
        if (fs.readdirSync(again).length === 0) fs.rmSync(again, { recursive: true, force: true });
      } catch { /* 已不存在 */ }
    }
  }
  if (!removed) console.log('afterPack: no redundant nested modules found');
}

// NSIS 安装器的 7z 解压器会静默丢弃完整路径超过 MAX_PATH（260）的文件 ——
// 无任何报错，运行期才发现模块缺失（issue #4）。删除「平台无关且恰好最深」
// 的载荷来压短目录树。
function trimLongPathFiles(appOutDir: string): void {
  const nmRoot = path.join(appOutDir, 'resources', 'app', 'node_modules');
  const kill: string[] = [];
  const collect = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // node-pty 的 arm64 载荷对 x64-only 构建无用
        if (e.name === 'win32-arm64' && dir.endsWith(path.join('node-pty', 'prebuilds'))) {
          kill.push(p);
        } else if (e.name === 'win10-arm64' && /node-pty[\\/]third_party[\\/]conpty[\\/][^\\/]+$/.test(dir)) {
          kill.push(p);
        } else if (e.name === 'esnext' && /@opentelemetry[\\/]+[^\\/]+[\\/]build$/.test(dir)) {
          // @opentelemetry 包的 ESM 构建：运行时 dsh 是 CJS、加载 build/src
          // （见 issue #4 的调用栈），而 esnext 是全树最深路径（安装后嵌套副本
          // 超 MAX_PATH）
          kill.push(p);
        } else if (e.name === 'browser' && /@opentelemetry[\\/]+[^\\/]+[\\/]build[\\/]+(esnext|src)[\\/]detectors[\\/]platform$/.test(dir)) {
          // browser 平台遥测探测器在纯 node 下永不加载
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
  // 嵌套 otel 副本在最深的运行时路径上仍持有 .js.map（CJS 构建本体必须留）
  // —— source map 是开发期产物，删掉。
  let maps = 0;
  const dropMaps = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) dropMaps(p);
      else if (e.name.endsWith('.js.map')) {
        fs.rmSync(p, { force: true });
        maps++;
      }
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

// 构建期就大声失败：任何打包文件若安装后会再次触发 MAX_PATH 静默丢弃。
// 路径重映射到真实安装前缀（20 字符用户名、默认 per-user Programs 目录、
// 无版本号产品目录）而非构建机路径 —— 数字反映 NSIS 解压器实际看到的长度。
function auditLongPaths(appOutDir: string): void {
  const INSTALL_PREFIX = 'C:\\Users\\12345678901234567890\\AppData\\Local\\Programs\\Deepseek Harness EAC\\';
  const LIMIT = 260;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
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
