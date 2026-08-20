/**
 * lib/supervisor/installer.ts — SDK 插件原子安装器（VNext Phase 1，Task 9）。
 *
 * 目录边界（架构文档 §7.1）：SDK 插件安装到 <DSH_HOME>/extensions/<id>/
 * {package,data,logs}；**绝不触碰 Core Profile**（profiles/web-desktop 的
 * package.json / node_modules / cordis.patch.yml / 模块解析路径零写入 —— 测试
 * 断言钉死）。
 *
 * 原子性（架构文档 §7.1「临时目录下载、校验、原子切换」）：
 *   1. 拷贝/下载到 extensions/.staging/<id>-<ts>/；
 *   2. 逐文件 SHA-256 → 汇总内容哈希（packageSha256，写进 registry）；
 *   3. 旧版（若有）先挪到 extensions/.rollback/<id>-<ts>/；
 *   4. staging → extensions/<id>/package rename 原子切换；
 *   5. 失败回滚：恢复 .rollback 里的旧版，staging 清理，registry 不留脏档。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { ExtensionRecord } from '../../shared/protocol.js';
import { state } from '../state.js';
import { log } from '../log.js';
import { readRegistry, writeRegistry } from './registry.js';
import type { RegistryEntry } from './registry.js';
import { parsePermissions, requiresUserConsent, setGranted } from './permissions.js';

/** SDK 扩展目录根（<dshHome>/extensions）。 */
export function extensionsRoot(): string {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'extensions');
}

/** 安装结果。 */
export interface InstallResult {
  ok: boolean;
  error?: string;
  /** 新安装包的内容哈希（SHA-256）。 */
  packageSha256?: string;
  /** 是否为覆盖升级（旧版已被移入回滚区）。 */
  upgraded?: boolean;
}

/** 递归拷贝目录（保留 mtime；用于 staging → 正式位的原子切换前准备）。 */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** 递归删除（带重试，容忍 Windows 文件锁瞬时占用）。 */
function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  } catch {
    /* 清理失败：留给下次 .staging 清扫 */
  }
}

/** 目录内容哈希：相对路径排序后逐文件 SHA-256，汇总为单一摘要。 */
export function hashTree(dir: string): string {
  const files: string[] = [];
  const walk = (d: string, rel = ''): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk(dir);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest());
  }
  return h.digest('hex');
}

/** 安装来源：本地目录（市场下载/解包后的产物）。 */
export interface InstallOptions {
  /** 待安装的插件包目录（含 package.json）。 */
  srcDir: string;
  /** 是否视为用户已确认高风险权限授权。 */
  userConsented?: boolean;
}

/**
 * 原子安装/升级一个 SDK 插件。
 * 全程不写 Core Profile；任何一步失败都恢复原状。
 */
export function installSdkPlugin(id: string, opts: InstallOptions): InstallResult {
  const root = extensionsRoot();
  const stamp = Date.now();
  const staging = path.join(root, '.staging', `${id}-${stamp}`);
  const finalDir = path.join(root, id);
  const pkgDir = path.join(finalDir, 'package');
  const rollbackDir = path.join(root, '.rollback', `${id}-${stamp}`);

  try {
    // 0) 来源校验：必须是含 package.json 的目录。
    const srcPkg = path.join(opts.srcDir, 'package.json');
    if (!fs.existsSync(srcPkg)) return { ok: false, error: '来源缺少 package.json' };
    const pkgJson = JSON.parse(fs.readFileSync(srcPkg, 'utf8')) as Record<string, unknown>;

    // 1) staging 拷贝 + 哈希校验（在临时位完成全部可能失败的工作）。
    fs.mkdirSync(staging, { recursive: true });
    copyDir(opts.srcDir, staging);
    const sha = hashTree(staging);
    // 空目录防呆（哈希恒定但无意义）。
    if (!fs.readdirSync(staging).length) throw new Error('来源目录为空');

    // 2) 权限解析（deny-by-default；高风险未授权则拒绝安装）。
    const { permissions, warnings } = parsePermissions(pkgJson);
    if (requiresUserConsent(permissions) && !opts.userConsented) {
      rmrf(staging);
      return {
        ok: false,
        error: '插件声明高风险权限（shell/env/任意网络），需用户确认后安装。' + (warnings.length ? '（' + warnings.join('；') + '）' : ''),
      };
    }

    // 3) 旧版移入回滚区（升级路径）。
    let upgraded = false;
    if (fs.existsSync(finalDir)) {
      copyDir(finalDir, rollbackDir);
      upgraded = true;
    }

    // 4) 原子切换：staging → extensions/<id>/package。
    try {
      fs.mkdirSync(finalDir, { recursive: true });
      fs.renameSync(staging, pkgDir);
    } catch {
      // Windows 上 rename 跨不过已存在的 pkgDir：先清正式位再切。
      if (fs.existsSync(pkgDir)) rmrf(pkgDir);
      fs.renameSync(staging, pkgDir);
    }
    // data/logs 目录就位（插件私有命名空间）。
    fs.mkdirSync(path.join(finalDir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(finalDir, 'logs'), { recursive: true });

    // 5) registry 建档（升级则保留 rollbackVersions 历史）。
    const reg = readRegistry();
    const prev = reg.plugins[id] as (ExtensionRecord & Record<string, unknown>) | undefined;
    const version = String(pkgJson.version ?? '');
    const rollbackVersions = prev
      ? [{ version: prev.version, packageSha256: prev.packageSha256 }, ...(prev.rollbackVersions ?? [])].slice(0, 5)
      : [];
    reg.plugins[id] = {
      ...(prev ?? {}),
      id,
      version,
      source: 'market',
      risk: 'isolated-sdk',
      kind: 'isolated',
      packageSha256: sha,
      installedAt: new Date().toISOString(),
      permissions,
      rollbackVersions,
      state: 'installed',
      enabled: true,
      crashStreak: 0,
    };
    if (!writeRegistry(reg)) throw new Error('注册表写入失败');
    if (requiresUserConsent(permissions)) setGranted(id, true);

    if (upgraded) log('installer', `SDK 插件 ${id}@${version} 已升级（回滚点 ${path.basename(rollbackDir)}）`);
    else log('installer', `SDK 插件 ${id}@${version} 已安装（sha256=${sha.slice(0, 12)}…）`);
    return { ok: true, packageSha256: sha, upgraded };
  } catch (err) {
    // 失败回滚：恢复旧版、清 staging、registry 不动（建档发生在切换成功后）。
    const msg = String((err as Error).message);
    log('installer', `安装失败(${id})，回滚: ${msg}`);
    try {
      if (fs.existsSync(rollbackDir)) {
        if (fs.existsSync(finalDir)) rmrf(finalDir);
        fs.mkdirSync(path.dirname(finalDir), { recursive: true });
        fs.renameSync(rollbackDir, finalDir);
        log('installer', `已恢复 ${id} 的旧版本`);
      }
    } catch (err2) {
      log('installer', `回滚失败(${id})，请从恢复中心重试: ${String((err2 as Error).message)}`);
    }
    rmrf(staging);
    return { ok: false, error: msg };
  }
}

/** 卸载：目录移入 .trash（可再生数据 data/logs 一并移除），registry 置 uninstalled。 */
export function uninstallSdkPlugin(id: string): { ok: boolean; error?: string } {
  try {
    const root = extensionsRoot();
    const finalDir = path.join(root, id);
    if (fs.existsSync(finalDir)) {
      const trash = path.join(root, '.trash', `${id}-${Date.now()}`);
      fs.mkdirSync(path.dirname(trash), { recursive: true });
      fs.renameSync(finalDir, trash);
    }
    const reg = readRegistry();
    const e = reg.plugins[id] as RegistryEntry | undefined;
    if (e) {
      e.state = 'uninstalled';
      e.enabled = false;
      reg.plugins[id] = e;
      writeRegistry(reg);
    }
    log('installer', `SDK 插件 ${id} 已卸载`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
}

/** 回滚到上一版本（.rollback 未清理时可原地换回；否则按 rollbackVersions 提示重装）。 */
export function rollbackSdkPlugin(id: string): { ok: boolean; error?: string } {
  try {
    const root = extensionsRoot();
    const finalDir = path.join(root, id);
    // 找最近一个该 id 的回滚点（安装失败自动恢复后通常已无存货）。
    const rbRoot = path.join(root, '.rollback');
    let latest: string | null = null;
    try {
      const candidates = fs
        .readdirSync(rbRoot)
        .filter((d) => d.startsWith(id + '-'))
        .sort();
      latest = candidates.length ? path.join(rbRoot, candidates[candidates.length - 1] as string) : null;
    } catch {
      latest = null;
    }
    if (!latest || !fs.existsSync(latest)) {
      return { ok: false, error: '无可用回滚点（安装失败时已自动恢复，或已过期清理）' };
    }
    if (fs.existsSync(finalDir)) rmrf(finalDir);
    fs.renameSync(latest, finalDir);
    const reg = readRegistry();
    const e = reg.plugins[id] as RegistryEntry | undefined;
    if (e) {
      const hist = [...e.rollbackVersions];
      const prevVer = hist[0];
      // 静态档案字段为 readonly —— 以整体替换表达「回到上一版建档」。
      reg.plugins[id] = {
        ...e,
        ...(prevVer
          ? { version: prevVer.version, packageSha256: prevVer.packageSha256, rollbackVersions: hist.slice(1) }
          : {}),
        state: 'disabled', // 回滚后先停用，待用户确认再启用
        enabled: false,
      };
      writeRegistry(reg);
    }
    log('installer', `SDK 插件 ${id} 已回滚到上一版本`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
}
