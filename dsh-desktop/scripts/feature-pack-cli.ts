'use strict';

// 功能包 CLI（执行体唯一入口，契约 docs/feature-pack-spec.md §7）。
//
// 由 L3 市场插件经 DSH_DESKTOP_RESOURCE_ROOT 定位 spawn（node feature-pack-cli.js
// <cmd> ...），或由 sidecar 在无锁窗口直接调用（resume）。
//
// 子命令：
//   inspect  <zip|url>            # 只解析校验，stdout 输出 manifest JSON
//   list                          # 注册表 + 实时兼容标注
//   install  <zip|url> [--force] [--op <opRef>]
//   update   <id> <zip|url> [--force] [--op <opRef>]
//   uninstall <id> [--op <opRef>]
//   export   <id> [-o <out.zip>]
//   scan                          # 启动兼容扫描（写回 state）
//   resume                        # 消费 .ops/pending.json 排队任务（无锁窗口）
//
// 退出码：0 成功｜1 一般失败｜2 用法错误｜3 文件锁待排队｜4 兼容失配｜5 冲突阻断。
// 进度：install/update/uninstall 若有 --op，把进度写 <DSH_HOME>/feature-packs/.ops/<opRef>.json。

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {
  init as initFeaturePack,
  EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_LOCK,
  parsePackZip, resolveKernelVersion, checkPackCompat,
  loadRegistry, scanFeaturePackCompatibility, installPack, updatePack,
  uninstallPack, exportPack, rollbackPack, resumePending, enqueuePending,
  type FeaturePackCtx, type PackManifest,
} from '../lib/desktop/feature-pack';

const CLI_ROOT = path.resolve(path.dirname(process.argv[1] || __filename), '..');

function homeOf(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function log(tag: string, msg: string): void {
  console.error('[' + tag + '] ' + msg);
}

// 与 sidecar 相同的能力复用：profile 初始化 + 保护中心快照/回滚。
function initShared(): void {
  const profile = require('../lib/desktop/profile') as {
    init(d: { log(tag: string, msg: string): void; getDshHome(): string | null }): void;
    ensureDesktopProfileInit(): void;
    desktopProfile(): string;
  };
  profile.init({ log, getDshHome: () => process.env.DSH_HOME || null });
  try { profile.ensureDesktopProfileInit(); } catch { /* 尽力 */ }
  const guardBox = require('../lib/desktop/guard-box') as {
    init(d: { log(tag: string, msg: string): void; getDshHome(): string | null; getDesktopProfile(): string; getDshBin(): string }): void;
    ensureGuard(): { snapshot(label: string): { id?: string } | null; restore(id: string): { ok: boolean; error?: string } };
  };
  guardBox.init({
    log,
    getDshHome: () => process.env.DSH_HOME || null,
    getDesktopProfile: () => process.env.DSH_DESKTOP_PROFILE || 'web-desktop',
    getDshBin: () => {
      try { return require.resolve('@deepseek-ai/dsh/lib/bin.js'); } catch { return ''; }
    },
  });
  try {
    (globalThis as Record<string, unknown>).__fpGuard = guardBox.ensureGuard();
  } catch (err) {
    log('feature-pack', '保护中心初始化失败（功能包继续，快照/回滚不可用）: ' + String((err as Error).message));
    (globalThis as Record<string, unknown>).__fpGuard = { snapshot: () => null, restore: () => ({ ok: false, error: '保护中心不可用' }) };
  }
}

function guardBox(): { snapshot(label: string): { id?: string } | null; restore(id: string): { ok: boolean; error?: string } } {
  return (globalThis as Record<string, unknown>).__fpGuard as { snapshot(label: string): { id?: string } | null; restore(id: string): { ok: boolean; error?: string } };
}

function makeCtx(): FeaturePackCtx {
  if (!(globalThis as Record<string, unknown>).__fpGuard) initShared();
  const guard = guardBox();
  return {
    log,
    getDshHome: () => process.env.DSH_HOME || null,
    getDesktopProfile: () => process.env.DSH_DESKTOP_PROFILE || 'web-desktop',
    getUserDataDir: () => process.env.DSH_DESKTOP_USER_DATA || path.join(os.homedir(), '.dsh-desktop'),
    getDshBin: () => {
      try { return require.resolve('@deepseek-ai/dsh/lib/bin.js'); } catch { return ''; }
    },
    getNodeExe: () => process.execPath,
    getChildEnv: () => process.env,
    builtinSourceDir: (dirName: string) => path.join(CLI_ROOT, 'assets', 'plugins', dirName),
    snapshot: (label) => guard.snapshot(label),
    restoreSnapshot: (id) => guard.restore(id),
  };
}

// URL → 临时 .dshpack 文件（宿主通常已下载，这里兜底支持 URL；可传 --sha256 校验）。
async function fetchPackToTemp(target: string, sha256?: string): Promise<string> {
  if (/^https?:\/\//i.test(target)) {
    const res = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status + ': ' + target);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256) {
      const crypto = require('node:crypto') as { createHash(a: string): { update(b: Buffer): { digest(e: string): string } } };
      const h = crypto.createHash('sha256').update(buf).digest('hex');
      if (h.toLowerCase() !== String(sha256).toLowerCase()) {
        throw new Error('SHA-256 校验失败（期望 ' + String(sha256).slice(0, 12) + '…，实际 ' + h.slice(0, 12) + '…）');
      }
    }
    const name = path.basename(new URL(target).pathname) || 'pack.dshpack';
    const tmp = path.join(os.tmpdir(), 'dshpack-' + process.pid + '-' + name.replace(/[^A-Za-z0-9._-]/g, '_'));
    fs.writeFileSync(tmp, buf);
    return tmp;
  }
  if (!fs.existsSync(target)) throw new Error('文件不存在: ' + target);
  return target;
}

function printJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}

/** 注册表 + 实时兼容标注（list）。 */
function listPacks(): Array<{
  id: string; name: string; version: string; state: string;
  installedAt: string; source: string; requires: PackManifest['requires'];
  compatOk: boolean; compatRange: string | null;
  plugins: unknown[]; presets: unknown[]; skills: unknown[];
}> {
  const home = homeOf();
  const reg = loadRegistry(home);
  const kernel = resolveKernelVersion();
  return reg.packs.map((p) => {
    const compat = checkPackCompat(p.manifest, kernel);
    return {
      id: p.id, name: p.manifest.name, version: p.version, state: p.state,
      installedAt: p.installedAt, source: p.source,
      requires: p.manifest.requires,
      compatOk: compat.ok, compatRange: compat.range || null,
      snapshotRef: p.snapshotRef,
      plugins: p.plugins, presets: p.presets, skills: p.skills,
    };
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) { printJson({ ok: false, error: '用法：feature-pack-cli inspect|list|install|update|uninstall|export|scan|resume …' }); return EXIT_USAGE; }

  const flag = (name: string): string | undefined => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const hasFlag = (name: string): boolean => args.includes('--' + name);

  initFeaturePack(makeCtx());

  try {
    switch (cmd) {
      case 'inspect': {
        const target = args[1];
        if (!target) { printJson({ ok: false, error: '用法：feature-pack-cli inspect <zip|url>' }); return EXIT_USAGE; }
        const tmp = await fetchPackToTemp(target);
        const { manifest, zip } = await parsePackZip(tmp);
        printJson({ ok: true, manifest, payloadPresets: zip.files.filter((f) => f.path.startsWith('payload/presets/')).length > 0, payloadSkills: zip.files.filter((f) => f.path.startsWith('payload/skills/')).length > 0 });
        return EXIT_OK;
      }
      case 'list': {
        printJson({ ok: true, kernel: resolveKernelVersion(), packs: listPacks() });
        return EXIT_OK;
      }
      case 'install': {
        const target = args[1];
        if (!target) { printJson({ ok: false, error: '用法：feature-pack-cli install <zip|url> [--force] [--op <opRef>] [--sha256 <hex>]' }); return EXIT_USAGE; }
        console.error('[feature-pack] 下载/定位包: ' + target);
        const tmp = await fetchPackToTemp(target, flag('sha256'));
        const r = await installPack({ zipPath: tmp, force: hasFlag('force'), opRef: flag('op') ?? null, source: /^https?:\/\//i.test(target) ? 'url' : 'local-file' });
        if (!r.ok && r.code === EXIT_LOCK) {
          const opRef = flag('op');
          enqueuePending({ action: 'install', zipPath: tmp, force: hasFlag('force'), ...(opRef ? { opRef } : {}) });
          console.error('[feature-pack] 文件被占用（Windows 文件锁）：任务已排队，等待服务重启后的无锁窗口自动完成');
        }
        printJson(r);
        return r.ok ? EXIT_OK : (r.code ?? EXIT_FAIL);
      }
      case 'update': {
        const id = args[1];
        const target = args[2];
        if (!id || !target) { printJson({ ok: false, error: '用法：feature-pack-cli update <id> <zip|url> [--force] [--op <opRef>] [--sha256 <hex>]' }); return EXIT_USAGE; }
        const tmp = await fetchPackToTemp(target, flag('sha256'));
        const r = await updatePack(id, { zipPath: tmp, force: hasFlag('force'), opRef: flag('op') ?? null });
        if (!r.ok && r.code === EXIT_LOCK) {
          const opRef = flag('op');
          enqueuePending({ action: 'update', id, zipPath: tmp, force: hasFlag('force'), ...(opRef ? { opRef } : {}) });
          console.error('[feature-pack] 文件被占用（Windows 文件锁）：任务已排队，等待服务重启后的无锁窗口自动完成');
        }
        printJson(r);
        return r.ok ? EXIT_OK : (r.code ?? EXIT_FAIL);
      }
      case 'uninstall': {
        const id = args[1];
        if (!id) { printJson({ ok: false, error: '用法：feature-pack-cli uninstall <id> [--op <opRef>]' }); return EXIT_USAGE; }
        const r = await uninstallPack(id, { opRef: flag('op') ?? null });
        if (!r.ok && r.code === EXIT_LOCK) {
          const opRef = flag('op');
          enqueuePending({ action: 'uninstall', id, ...(opRef ? { opRef } : {}) });
          console.error('[feature-pack] 文件被占用（Windows 文件锁）：任务已排队，等待服务重启后的无锁窗口自动完成');
        }
        printJson(r);
        return r.ok ? EXIT_OK : (r.code ?? EXIT_FAIL);
      }
      case 'export': {
        const id = args[1];
        const out = flag('o') || (args[2] && !args[2].startsWith('-') ? args[2] : undefined);
        if (!id || !out) { printJson({ ok: false, error: '用法：feature-pack-cli export <id> [-o <out.zip>]' }); return EXIT_USAGE; }
        const r = await exportPack(id, out);
        printJson(r);
        return r.ok ? EXIT_OK : EXIT_FAIL;
      }
      case 'rollback': {
        const id = args[1];
        if (!id) { printJson({ ok: false, error: '用法：feature-pack-cli rollback <id>' }); return EXIT_USAGE; }
        const r = rollbackPack(id);
        printJson(r);
        return r.ok ? EXIT_OK : EXIT_FAIL;
      }
      case 'scan': {
        const r = scanFeaturePackCompatibility();
        printJson({ ok: true, ...r });
        return EXIT_OK;
      }
      case 'resume': {
        const r = await resumePending();
        printJson({ ok: r.ok, results: r.results, skipped: r.skipped });
        return EXIT_OK;
      }
      default:
        printJson({ ok: false, error: '未知子命令: ' + cmd });
        return EXIT_USAGE;
    }
  } catch (err) {
    const e = err as Error;
    printJson({ ok: false, error: e.message });
    return EXIT_FAIL;
  }
}

// tsconfig.module=commonjs：top-level await 不可用，用 .then 收口。
main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('[feature-pack] 致命错误: ' + String((err && (err as Error).message) || err));
  process.exitCode = EXIT_FAIL;
});