'use strict';

// 功能包（.dshpack）核心（ADR 0002 L2 业务服务层；契约 = docs/feature-pack-spec.md
// + docs/schemas/feature-pack-pack.json）。
//
// 职责：清单解析与校验、内核 semver 范围匹配（matchSemverRange）、注册表 CRUD、
// 内核兼容检查与启动扫描、安装/卸载/更新/导出/回滚编排、op 状态文件与排队
// resume。纯 Node 实现，不依赖 Electron/Tauri；由 sidecar（启动扫描、排队消费）
// 与 scripts/feature-pack-cli.ts 共同使用。
//
// 边界（红线）：
//   · 不修改 @deepseek-ai/* 包本体；插件装配一律经 `dsh plugin` CLI；
//   · 不手写 cordis.patch.yml（builtin 引用只核验存在并登记）；
//   · preset/skills 沿用 skip-if-exists；用户自建同名永不覆盖；
//   · DSH_HOME 仅新增 feature-packs/ 目录；
//   · 安装/更新事务化：失败按保护中心快照回滚并清理半成品。

import path = require('node:path');
import fs = require('node:fs');
import os = require('node:os');
import cp = require('node:child_process');
import { pathToFileURL } from 'node:url';

// 应用根目录（本模块位于 <root>/lib/desktop/ 下；与 runtime-paths 的 APP_ROOT 同值，
// 此处独立声明避免循环依赖）。
const APP_ROOT = path.resolve(__dirname, '..', '..');

// unzipper（zip 读取）为 devDependency，随 dsh-desktop 整树打包分发；开发态 npm ci
// 后亦存在。缺失时解析/安装降级为明确报错（不静默）。
const unzipper = require('unzipper') as {
  Open: { file(p: string): Promise<{ files: ZipEntry[] }> };
};
const archiver = require('archiver') as (format: string, o?: Record<string, unknown>) => ArchiverLike;

interface ZipEntry { path: string; buffer(): Promise<Buffer> }
interface ArchiverLike {
  append(content: string | Buffer, o: { name: string }): ArchiverLike;
  directory(dir: string, dest: string): ArchiverLike;
  pipe(w: NodeJS.WritableStream): ArchiverLike;
  finalize(): Promise<void>;
  on(event: 'error', cb: (err: Error) => void): ArchiverLike;
}

// ---------------------------------------------------------------------------
// 注入接口与上下文
// ---------------------------------------------------------------------------

export interface FeaturePackCtx {
  log(tag: string, msg: string): void;
  getDshHome(): string | null;
  getDesktopProfile(): string;
  getUserDataDir(): string;
  getDshBin(): string;
  getNodeExe(): string;
  /** 子进程环境（sidecar 传入 childEnv()；CLI 传 process.env）。 */
  getChildEnv(): NodeJS.ProcessEnv;
  /** 内置插件源目录解析（companion-sync 的 builtinPluginSourceDir 语义）。 */
  builtinSourceDir(dirName: string): string;
  /** 保护中心快照能力（guard-box ensureGuard 语义）；缺省 null = 无快照。 */
  snapshot?: (label: string) => { id?: string } | null;
  restoreSnapshot?: (id: string) => { ok: boolean; error?: string };
  /** 已启用插件名列表（冲突预检用；缺省读 cordis.patch.yml insert name）。 */
  enabledPluginNames?: () => string[];
}

let ctx!: FeaturePackCtx;
export function init(d: FeaturePackCtx): void { ctx = d; }

// 命令行退出码（spec §7）。
export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
export const EXIT_LOCK = 3;
export const EXIT_COMPAT = 4;
export const EXIT_CONFLICT = 5;

function fail(msg: string): Error { return new Error(msg); }

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function featurePacksRoot(home: string): string { return path.join(home, 'feature-packs'); }
export function registryFile(home: string): string { return path.join(featurePacksRoot(home), 'registry.json'); }
export function opsDir(home: string): string { return path.join(featurePacksRoot(home), '.ops'); }
export function pendingFile(home: string): string { return path.join(opsDir(home), 'pending.json'); }
export function packDataDir(home: string, id: string): string { return path.join(featurePacksRoot(home), id); }
export function packPayloadDir(home: string, id: string): string { return path.join(packDataDir(home, id), 'payload'); }
export function packOverridesDir(home: string, id: string): string { return path.join(packDataDir(home, id), 'overrides'); }

function homeOf(): string {
  return ctx.getDshHome() || path.join(os.homedir(), '.dsh');
}
function profileDirOf(): string {
  return path.join(homeOf(), 'profiles', ctx.getDesktopProfile());
}

// ---------------------------------------------------------------------------
// 第三方构建产物保留（复用 dsh-unified-market 的 artifact-keep）：pnpm add/remove
// 会按锁文件重写整棵 node_modules，人工补齐的 lib/ 会被清掉 —— 功能包装配前后
// 快照/回填（与 market.ts / market host 同一份模块）。
// ---------------------------------------------------------------------------

type EsmModule = Record<string, unknown>;
// tsc(commonjs) 会把 import() 降级为 require()，而 require() 加载 .mjs 会抛错；
// 用 new Function 保住原生动态 import（market.ts 同款做法）。
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>;
const ARTIFACT_KEEP_MODULE = path.join(APP_ROOT, 'assets', 'plugins', 'dsh-unified-market', 'lib', 'artifact-keep.mjs');
let artifactKeepMod: EsmModule | null = null;

async function artifactKeep(): Promise<EsmModule> {
  if (artifactKeepMod) return artifactKeepMod;
  try {
    artifactKeepMod = await dynamicImport(pathToFileURL(ARTIFACT_KEEP_MODULE).href) as unknown as EsmModule;
  } catch (err) {
    ctx.log('feature-pack', 'artifact-keep 模块加载失败: ' + String((err as Error).message));
    artifactKeepMod = {};
  }
  return artifactKeepMod;
}

async function snapshotArtifactsFor(profile: string): Promise<void> {
  try {
    const ak = await artifactKeep();
    if (typeof ak.snapshotArtifacts !== 'function') return;
    const profileDirP = path.join(homeOf(), 'profiles', profile);
    const cache = path.join(homeOf(), 'plugin-artifact-cache', profile);
    const builtinFile = path.join(profileDirP, '.dsh-builtin-plugins.json');
    let managedNames: string[] = [];
    try {
      const b = JSON.parse(fs.readFileSync(builtinFile, 'utf8')) as unknown;
      if (Array.isArray(b)) managedNames = b as string[];
      else if (b && typeof b === 'object' && Array.isArray((b as Record<string, unknown>).names)) managedNames = (b as Record<string, unknown>).names as string[];
    } catch { /* 缺省空 */ }
    await (ak.snapshotArtifacts as (a: string, b: string, o: { managedNames: string[]; log(m: string): void }) => void)(
      profileDirP, cache, { managedNames, log: (m: string) => ctx.log('feature-pack', '[keep] ' + m) });
  } catch (err) {
    ctx.log('feature-pack', 'artifact 快照失败（继续）: ' + String((err as Error).message));
  }
}

async function restoreArtifactsFor(profile: string): Promise<void> {
  try {
    const ak = await artifactKeep();
    if (typeof ak.restoreArtifacts !== 'function') return;
    const profileDirP = path.join(homeOf(), 'profiles', profile);
    const cache = path.join(homeOf(), 'plugin-artifact-cache', profile);
    await (ak.restoreArtifacts as (a: string, b: string, o: { log(m: string): void }) => void)(
      profileDirP, cache, { log: (m: string) => ctx.log('feature-pack', '[keep] ' + m) });
  } catch (err) {
    ctx.log('feature-pack', 'artifact 回填失败（继续）: ' + String((err as Error).message));
  }
}

// ---------------------------------------------------------------------------
// 清单模型与校验（与 docs/schemas/feature-pack-pack.json 保持一致的实现）
// ---------------------------------------------------------------------------

export interface PackPluginRef {
  ref: string;
  source: 'builtin' | 'github' | 'market';
  pkg: string | null;      // 装配用的包名/源（npm 名或 github:o/r；builtin 为 null）
  version?: string | null; // 期望范围（github/market）
  managed: boolean;        // 是否由本包安装（builtin 恒 false）
  installed: boolean;
}
export interface PackPresetRef { id: string; installed: boolean; skipped: boolean }
export interface PackSkillRef { id: string; installed: boolean; skipped: boolean }

export interface PackManifest {
  formatVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  icon?: string;
  requires?: { dsh?: string };
  plugins?: { ref: string; version?: string; enabled?: boolean }[];
  presets?: { id: string }[];
  skills?: { id: string }[];
  conflicts?: string[];
  overrides?: string[];
  changelog?: string;
}

export interface PackRecord {
  id: string;
  version: string;
  installedAt: string;
  profile: string;
  state: 'active' | 'incompatible' | 'rolled-back';
  source: string;
  manifest: PackManifest;
  plugins: PackPluginRef[];
  presets: PackPresetRef[];
  skills: PackSkillRef[];
  snapshotRef: string | null;
  opRef: string | null;
}

export interface PackRegistry { version: number; packs: PackRecord[] }

const ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function validateManifest(m: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!m || typeof m !== 'object') { return { ok: false, errors: ['pack.json 不是对象'] }; }
  const o = m as Record<string, unknown>;
  if (o.formatVersion !== 1) errors.push('formatVersion 必须为 1');
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) {
    errors.push('id 必须匹配 ^[a-z0-9][a-z0-9._-]{2,63}$');
  }
  if (typeof o.name !== 'string' || o.name.length < 1 || o.name.length > 64) {
    errors.push('name 必须为 1–64 字符字符串');
  }
  if (typeof o.version !== 'string' || !SEMVER_RE.test(o.version)) {
    errors.push('version 必须为 semver（如 1.2.0 / 0.1.1-rc.2）');
  }
  if (o.description !== undefined && (typeof o.description !== 'string' || o.description.length > 500)) {
    errors.push('description 必须为 ≤500 字符字符串');
  }
  if (o.author !== undefined && (typeof o.author !== 'string' || o.author.length > 128)) {
    errors.push('author 必须为 ≤128 字符字符串');
  }
  if (o.license !== undefined && (typeof o.license !== 'string' || o.license.length > 64)) {
    errors.push('license 必须为 ≤64 字符字符串');
  }
  if (o.icon !== undefined && (typeof o.icon !== 'string' || !/^[A-Za-z0-9._/-]+\.png$/.test(o.icon))) {
    errors.push('icon 必须为包内 .png 相对路径');
  }
  if (o.requires !== undefined) {
    const r = o.requires as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push('requires 必须为对象');
    } else if (r.dsh !== undefined && (typeof r.dsh !== 'string' || r.dsh.length < 1 || r.dsh.length > 256)) {
      errors.push('requires.dsh 必须为 1–256 字符范围字符串');
    }
  }
  if (o.plugins !== undefined) {
    if (!Array.isArray(o.plugins) || o.plugins.length > 64) errors.push('plugins 必须为 ≤64 数组');
    else for (const [i, p] of o.plugins.entries()) {
      const pp = p as Record<string, unknown>;
      if (!pp || typeof pp !== 'object' || typeof pp.ref !== 'string' || !pp.ref) {
        errors.push(`plugins[${i}].ref 必须为非空字符串`);
      } else if (pp.version !== undefined && (typeof pp.version !== 'string' || pp.version.length > 256)) {
        errors.push(`plugins[${i}].version 必须为 ≤256 字符范围字符串`);
      } else if (pp.enabled !== undefined && typeof pp.enabled !== 'boolean') {
        errors.push(`plugins[${i}].enabled 必须为布尔`);
      }
    }
  }
  if (o.presets !== undefined) {
    if (!Array.isArray(o.presets) || o.presets.length > 32) errors.push('presets 必须为 ≤32 数组');
    else for (const [i, p] of o.presets.entries()) {
      const pp = p as Record<string, unknown>;
      if (!pp || typeof pp !== 'object' || typeof pp.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(pp.id)) {
        errors.push(`presets[${i}].id 非法`);
      }
    }
  }
  if (o.skills !== undefined) {
    if (!Array.isArray(o.skills) || o.skills.length > 32) errors.push('skills 必须为 ≤32 数组');
    else for (const [i, s] of o.skills.entries()) {
      const ss = s as Record<string, unknown>;
      if (!ss || typeof ss !== 'object' || typeof ss.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(ss.id)) {
        errors.push(`skills[${i}].id 非法`);
      }
    }
  }
  if (o.conflicts !== undefined) {
    if (!Array.isArray(o.conflicts) || o.conflicts.length > 64) errors.push('conflicts 必须为 ≤64 数组');
    else for (const c of o.conflicts) if (typeof c !== 'string' || !c) errors.push('conflicts 项必须为非空字符串');
  }
  if (o.overrides !== undefined) {
    // v1 预留：必须为空数组（避免目录穿越路径进入安装器）。
    if (!Array.isArray(o.overrides) || o.overrides.length !== 0) {
      errors.push('overrides 为 v1 预留字段，必须为空数组');
    }
  }
  if (o.changelog !== undefined && (typeof o.changelog !== 'string' || o.changelog.length > 2000)) {
    errors.push('changelog 必须为 ≤2000 字符字符串');
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// semver 范围匹配（spec §5.1；宽容预发布策略）
// ---------------------------------------------------------------------------

interface Version { major: number; minor: number; patch: number; pre: string[] }

export function parseVersion(v: string): Version | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  const major = Number(m[1]); const minor = Number(m[2]); const patch = Number(m[3]);
  const pre = m[4] ? m[4].split('.') : [];
  return { major, minor, patch, pre };
}

// 比较两个版本（标准 semver tuple 序；稳定版本恒大于同段的预发布版本）。
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a); const vb = parseVersion(b);
  if (!va) return a < b ? -1 : a > b ? 1 : 0;
  if (!vb) return b < a ? 1 : b > a ? -1 : 0;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;   // stable > pre
  if (vb.pre.length === 0) return -1;
  const n = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < n; i++) {
    const pa = va.pre[i]; const pb = vb.pre[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (pa === pb) continue;
    const na = /^\d+$/.test(pa); const nb = /^\d+$/.test(pb);
    if (na && nb) { const d = Number(pa) - Number(pb); if (d) return d < 0 ? -1 : 1; }
    else if (na) return -1;          // 数字标识符 < 字母标识符
    else if (nb) return 1;
    else { const d = pa < pb ? -1 : pa > pb ? 1 : 0; if (d) return d; }
  }
  return 0;
}

interface RangePart {
  // op: '>=','>','<=','<','='；target 解析后的版本；hasPre：范围已声明预发布。
  op: '>=' | '>' | '<=' | '<' | '=';
  target: Version | null;   // null 表示 *（任意）
  hasPre: boolean;
}

// 半开区间展开：^ 上界 = 下个 major；~ / 部分版本的上界按段递增。
function boundMajor(major: number, minor: number, patch: number): RangePart[] {
  return [
    { op: '>=', target: { major, minor, patch, pre: [] }, hasPre: false },
    { op: '<', target: { major: major + 1, minor: 0, patch: 0, pre: [] }, hasPre: false },
  ];
}
function boundMinor(major: number, minor: number, patch: number): RangePart[] {
  return [
    { op: '>=', target: { major, minor, patch, pre: [] }, hasPre: false },
    { op: '<', target: { major, minor: minor + 1, patch: 0, pre: [] }, hasPre: false },
  ];
}

function parseRangePart(raw: string): RangePart[] | null {
  const s = raw.trim();
  if (!s || s === '*' || s === 'x' || s === 'X') return [{ op: '>=', target: null, hasPre: false }];
  const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(s)!;
  const op = m[1] || '=';
  let rest = (m[2] || '').trim();
  // 部分版本（1.2 / 1 / 1.2.x / 1.x）：裸字面量 / ^ / ~ 展开为半开区间；
  // 比较符（>=<=><）只按补齐零的完整版本单项比较（>=1.2 ≙ >=1.2.0）。
  // 仅当段数不足三段或含 x 通配时才走部分展开；完整三段走下方 semver 分支。
  const partialRe = /^(\d+)(?:\.([0-9xX*]+))?(?:\.([0-9xX*]+))?$/;
  const partial = partialRe.exec(rest);
  const segCount = rest.split('.').length;
  if (partial && (/[xX*]/.test(rest) || segCount < 3)) {
    const major = Number(partial[1]);
    const minorTxt = partial[2];
    const patchTxt = partial[3];
    const minor = minorTxt !== undefined && !/[xX*]/.test(minorTxt) ? Number(minorTxt) : undefined;
    const patch = patchTxt !== undefined && !/[xX*]/.test(patchTxt) ? Number(patchTxt) : undefined;
    const rangeLike = op === '=' || op === '^' || op === '~';
    const single = (): RangePart[] => [{ op: (op as '>=' | '>' | '<=' | '<' | '='), target: { major, minor: minor ?? 0, patch: patch ?? 0, pre: [] }, hasPre: false }];
    if (minor === undefined) return rangeLike ? boundMajor(major, 0, 0) : single();   // 1 / 1.x → >=1.0.0 <2.0.0
    if (patch === undefined) return rangeLike ? boundMinor(major, minor, 0) : single(); // 1.2 / 1.2.x → >=1.2.0 <1.3.0
    return rangeLike ? boundMinor(major, minor, patch) : single();                     // 1.2.3 (≡=) → 精确以上端
  }
  // 完整 semver（可带预发布）。
  const vm = SEMVER_RE.exec(rest);
  if (!vm) return null;
  const major = Number(vm[1]); const minor = Number(vm[2]); const patch = Number(vm[3]);
  const pre = vm[4] ? vm[4].split('.') : [];
  const hasPre = pre.length > 0;
  const target: Version = { major, minor, patch, pre };
  if (op === '^') {
    if (major > 0) return [{ op: '>=', target, hasPre }, { op: '<', target: { major: major + 1, minor: 0, patch: 0, pre: [] }, hasPre: false }];
    if (minor > 0) return [{ op: '>=', target, hasPre }, { op: '<', target: { major: 0, minor: minor + 1, patch: 0, pre: [] }, hasPre: false }];
    return [{ op: '>=', target, hasPre }, { op: '<', target: { major: 0, minor: 0, patch: patch + 1, pre: [] }, hasPre: false }];
  }
  if (op === '~') {
    return [{ op: '>=', target, hasPre }, { op: '<', target: { major, minor: minor + 1, patch: 0, pre: [] }, hasPre: false }];
  }
  return [{ op: (op as '>=' | '>' | '<=' | '<' | '='), target, hasPre }];
}

function partMatch(p: RangePart, v: Version): boolean {
  if (!p.target) return true;                    // *
  if (p.hasPre || v.pre.length === 0) {
    // 标准 tuple 比较。
    const c = compareVersions(verStr(v), verStr(p.target));
    switch (p.op) {
      case '>=': return c >= 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      case '<': return c < 0;
      case '=': return c === 0;
    }
  }
  // 宽容策略：范围未声明预发布、候选是预发布 → 按稳定段比较
  // （0.1.1-rc.2 满足 =0.1.1 / >=0.1.1，不满足 >=0.1.2）。
  const s = { major: v.major, minor: v.minor, patch: v.patch, pre: [] as string[] };
  return partMatch({ ...p, target: p.target ? { ...p.target, pre: [] } : null }, s);
}

function verStr(v: Version): string {
  return v.major + '.' + v.minor + '.' + v.patch + (v.pre.length ? '-' + v.pre.join('.') : '');
}

/** 解析若干"空格 AND"比较子 → 部分列表。 */
function parseRangeParts(clause: string): RangePart[] | null {
  const out: RangePart[] = [];
  for (const raw of clause.trim().split(/\s+/)) {
    if (!raw) continue;
    const parts = parseRangePart(raw);
    if (!parts) return null;
    out.push(...parts);
  }
  return out.length ? out : null;
}

/**
 * 匹配 semver 范围（spec §5.1）。支持 *｜空｜x.y.z｜比较符｜^｜~｜|| 或组｜
 * 空格 AND｜部分版本（1.2 ≙ >=1.2.0 <1.3.0）。无法解析 → 保守返回 false。
 */
export function matchSemverRange(range: string | undefined, version: string): boolean {
  if (!range || !range.trim() || range.trim() === '*') return true;
  const v = parseVersion(version);
  if (!v) return false;
  for (const clause of range.split('||')) {
    if (!clause.trim()) continue;
    const parts = parseRangeParts(clause);
    if (!parts) continue;                                    // 子句语法错误 → 跳过（保守不匹配）
    if (parts.every((p) => partMatch(p, v))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// zip 读取 / payload 解压
// ---------------------------------------------------------------------------

async function openZip(zipPath: string): Promise<{ files: ZipEntry[] }> {
  try {
    return await unzipper.Open.file(zipPath);
  } catch (err) {
    throw fail('打开 .dshpack 失败: ' + String((err as Error).message || err));
  }
}

/** 解析 zip → 校验清单 → 返回 { manifest, zipFiles }。 */
export async function parsePackZip(zipPath: string): Promise<{ manifest: PackManifest; zip: { files: ZipEntry[] } }> {
  const zip = await openZip(zipPath);
  const entry = zip.files.find((f) => f.path === 'pack.json');
  if (!entry) throw fail('归档缺少 pack.json');
  let raw: string;
  try {
    raw = (await entry.buffer()).toString('utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    throw fail('读取 pack.json 失败: ' + String((err as Error).message || err));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw fail('pack.json 不是合法 JSON'); }
  const v = validateManifest(parsed);
  if (!v.ok) throw fail('pack.json 校验失败: ' + v.errors.join('；'));
  const manifest = parsed as PackManifest;
  if (manifest.id + '-' + manifest.version !== path.basename(zipPath).replace(/\.dshpack$/i, '')) {
    // 文件名约定校验（<id>-<version>.dshpack）；不强制（允许重命名），仅提示。
    /* 空 */
  }
  return { manifest, zip };
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export function loadRegistry(home: string): PackRegistry {
  const file = registryFile(home);
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as PackRegistry;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.packs)) return parsed;
  } catch { /* 缺省空注册表 */ }
  return { version: 1, packs: [] };
}

export function saveRegistry(home: string, reg: PackRegistry): void {
  fs.mkdirSync(featurePacksRoot(home), { recursive: true });
  const file = registryFile(home);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
  fs.renameSync(tmp, file);   // 原子替换
}

export function findPack(home: string, id: string): PackRecord | null {
  return loadRegistry(home).packs.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------------------
// 内核版本与兼容
// ---------------------------------------------------------------------------

export function resolveKernelVersion(): string {
  try {
    const profile = profileDirOf();
    const pkgFile = path.join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
    }
  } catch { /* 回退内置 */ }
  try {
    const pkgFile = path.join(path.dirname(ctx.getDshBin()), '..', 'package.json');
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
    }
  } catch { /* 未知 */ }
  return 'unknown';
}

export function checkPackCompat(manifest: Pick<PackManifest, 'requires'>, kernelVersion: string): { ok: boolean; range?: string } {
  const range = manifest.requires && manifest.requires.dsh;
  if (!range) return { ok: true };
  return { ok: matchSemverRange(range, kernelVersion), range };
}

/** 启动/手动兼容扫描：active 包失配 → incompatible（幂等）；返回本次更新列表。 */
export function scanFeaturePackCompatibility(): { checked: number; incompatible: string[] } {
  const home = homeOf();
  const reg = loadRegistry(home);
  const kernel = resolveKernelVersion();
  const incompatible: string[] = [];
  let changed = false;
  for (const pack of reg.packs) {
    if (pack.state === 'rolled-back') continue;
    const ok = checkPackCompat(pack.manifest, kernel).ok;
    const next = ok ? 'active' : 'incompatible';
    if (pack.state !== next) { pack.state = next; changed = true; }
    if (!ok) incompatible.push(pack.id);
  }
  if (changed) { try { saveRegistry(home, reg); } catch (err) { ctx.log('feature-pack', '兼容扫描写回失败: ' + String((err as Error).message)); } }
  return { checked: reg.packs.length, incompatible };
}

// ---------------------------------------------------------------------------
// 子进程（dsh plugin）
// ---------------------------------------------------------------------------

export interface SpawnResult { code: number; output: string }

export function runDshPlugin(args: string[], profile: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const nodeBin = ctx.getNodeExe();
    const bin = ctx.getDshBin();
    if (!fs.existsSync(nodeBin) || !fs.existsSync(bin)) {
      resolve({ code: EXIT_FAIL, output: '找不到 node/dsh CLI' });
      return;
    }
    const child = cp.spawn(nodeBin, [bin, 'plugin', '--profile', profile, ...args], {
      cwd: ctx.getUserDataDir(),
      env: { ...ctx.getChildEnv(), CI: 'true' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (c: Buffer): void => { output = (output + c.toString()).slice(-16000); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => resolve({ code: EXIT_FAIL, output: String((err as Error).message) }));
    child.on('close', (code) => resolve({ code: code === null ? EXIT_FAIL : code, output }));
  });
}

/** 判断输出是否命中 Windows 文件锁（EPERM/EBUSY）。 */
export function isFileLockFailure(output: string): boolean {
  return /EPERM|EBUSY|resource busy|being used by another process/i.test(output);
}

// ---------------------------------------------------------------------------
// 内置插件 / 已启用插件
// ---------------------------------------------------------------------------

export function builtinPluginExists(dirName: string): boolean {
  try {
    return fs.existsSync(path.join(ctx.builtinSourceDir(dirName), 'package.json'));
  } catch { return false; }
}

function patchEnabledNames(): string[] {
  try {
    if (ctx.enabledPluginNames) return ctx.enabledPluginNames();
    const file = path.join(profileDirOf(), 'cordis.patch.yml');
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const names: string[] = [];
    for (const m of text.matchAll(/-\s+name:\s*['"]?([^'"\s]+)/g)) {
      const n = m[1];
      if (n) names.push(n);
    }
    return names;
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// payload：preset / skills 同步（沿用 skip-if-exists 纪律）
// ---------------------------------------------------------------------------

async function writeZipEntries(files: ZipEntry[], prefix: string, destDir: string): Promise<string[]> {
  const written: string[] = [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rel = f.path.slice(prefix.length).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) continue;
    if (rel.split(/[/\\]/).includes('..')) continue;   // 防目录穿越
    const out = path.join(destDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await f.buffer());
    written.push(out);
  }
  return written;
}

/** 安装 payload 中的 preset 目录（skip-if-exists 默认；目标带 .eac-package.json 时覆盖更新）。 */
async function syncPayloadPreset(files: ZipEntry[], id: string, presetsRoot: string): Promise<{ installed: boolean; skipped: boolean }> {
  const prefix = 'payload/presets/' + id + '/';
  const has = files.some((f) => f.path.startsWith(prefix) && f.path.endsWith('preset.yml'));
  if (!has) {
    // 引用式：要求目标已存在。
    if (fs.existsSync(path.join(presetsRoot, id, 'preset.yml'))) return { installed: false, skipped: false };
    throw fail('preset 未内嵌且目标不存在: ' + id);
  }
  const dest = path.join(presetsRoot, id);
  const managedMarker = path.join(dest, '.eac-package.json');
  if (fs.existsSync(path.join(dest, 'preset.yml')) && !fs.existsSync(managedMarker)) {
    return { installed: false, skipped: true };   // 用户自建同名：永不覆盖
  }
  await writeZipEntries(files, prefix, dest);
  try {
    fs.writeFileSync(managedMarker, JSON.stringify({ packId: null as string | null, managed: true, version: 1 }, null, 2) + '\n');
  } catch { /* 标记写失败不阻断 */ }
  return { installed: true, skipped: false };
}

/** 安装 payload 中的 skill 目录（现有 .eac-skill.json 托管语义 + packId 标记）。 */
async function syncPayloadSkill(files: ZipEntry[], id: string, skillsRoot: string): Promise<{ installed: boolean; skipped: boolean }> {
  const prefix = 'payload/skills/' + id + '/';
  const has = files.some((f) => f.path.startsWith(prefix) && f.path.endsWith('SKILL.md'));
  if (!has) {
    if (fs.existsSync(path.join(skillsRoot, id, 'SKILL.md'))) return { installed: false, skipped: false };
    throw fail('skill 未内嵌且目标不存在: ' + id);
  }
  const dest = path.join(skillsRoot, id);
  const marker = path.join(dest, '.eac-skill.json');
  const existing = ((): { version?: number; managed?: boolean } | null => {
    try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return null; }
  })();
  if (existing && fs.existsSync(path.join(dest, 'SKILL.md')) && existing.managed !== false) {
    // 托管（含用户旧托管或本包）→ 覆盖更新。
    await writeZipEntries(files, prefix, dest);
    try {
      fs.writeFileSync(marker, JSON.stringify({ ...(existing || {}), managed: true, version: (existing?.version || 1) + 1 }, null, 2) + '\n');
    } catch { /* 尽力 */ }
    return { installed: true, skipped: false };
  }
  if (fs.existsSync(path.join(dest, 'SKILL.md'))) {
    return { installed: false, skipped: true };    // 用户自建：永不覆盖
  }
  await writeZipEntries(files, prefix, dest);
  try { fs.writeFileSync(marker, JSON.stringify({ packId: null as string | null, managed: true, version: 1 }, null, 2) + '\n'); } catch { /* 尽力 */ }
  return { installed: true, skipped: false };
}

// ---------------------------------------------------------------------------
// 安装 / 卸载 / 更新 / 导出 / 回滚
// ---------------------------------------------------------------------------

export interface InstallResult { ok: boolean; stage?: string; error?: string; code?: number; recordId?: string; kernel?: string | null; range?: string | null }

function refSourceOf(ref: string): { source: 'builtin' | 'github' | 'market'; pkg: string | null } {
  if (ref.startsWith('builtin:')) {
    const dir = ref.slice('builtin:'.length);
    if (!dir || !/^[A-Za-z0-9._-]+$/.test(dir)) throw fail('builtin 引用非法: ' + ref);
    return { source: 'builtin', pkg: null };
  }
  if (/^github:[^/]+\/[^/]+$/.test(ref)) return { source: 'github', pkg: ref };
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/.test(ref)) throw fail('插件引用非法: ' + ref);
  return { source: 'market', pkg: ref };
}

/** 其他已装包对某插件的引用计数。 */
function refCount(reg: PackRegistry, excludeId: string, pkg: string): number {
  let n = 0;
  for (const p of reg.packs) {
    if (p.id === excludeId) continue;
    if (p.plugins.some((pl) => pl.pkg === pkg || pl.ref === pkg)) n += 1;
  }
  return n;
}

async function assemblePlugin(plugin: { ref: string; version?: string }, profile: string): Promise<{ installed: boolean }> {
  const { source, pkg } = refSourceOf(plugin.ref);
  if (source === 'builtin') {
    const dir = plugin.ref.slice('builtin:'.length);
    if (!builtinPluginExists(dir)) throw fail('内置插件不存在: ' + dir);
    return { installed: true };   // 只核验并登记，不复制不写行
  }
  if (!pkg) throw fail('插件装配目标缺失: ' + plugin.ref);
  const r = await runDshPlugin(['add', pkg], profile);
  if (r.code !== 0) {
    if (isFileLockFailure(r.output)) throw Object.assign(fail('插件安装被文件锁阻塞: ' + pkg), { lock: true });
    throw fail('插件安装失败 ' + pkg + ':\n' + r.output.slice(0, 800));
  }
  return { installed: true };
}

async function removePlugin(plugin: PackPluginRef, profile: string): Promise<void> {
  if (plugin.source === 'builtin' || !plugin.pkg) return;
  const r = await runDshPlugin(['remove', plugin.pkg], profile);
  if (r.code !== 0) {
    if (isFileLockFailure(r.output)) throw Object.assign(fail('插件移除被文件锁阻塞: ' + plugin.pkg), { lock: true });
    if (!/not installed|没有安装|unknown/i.test(r.output)) {
      ctx.log('feature-pack', '插件移除失败（继续） ' + plugin.pkg + ': ' + r.output.slice(0, 300));
    }
  }
}

async function extractZipTo(zip: { files: ZipEntry[] }, prefix: string, destDir: string): Promise<void> {
  await writeZipEntries(zip.files, prefix, destDir);
}

export async function installPack(args: {
  zipPath?: string;
  manifest?: PackManifest;
  zip?: { files: ZipEntry[] };
  profile?: string;
  force?: boolean;
  opRef?: string | null;
  source?: string;
}): Promise<InstallResult> {
  const home = homeOf();
  const profile = args.profile || ctx.getDesktopProfile();
  const source = args.source || (args.zipPath ? 'local-file' : 'manual');
  const opRef = args.opRef || null;
  const stage = (s: string): void => { ctx.log('feature-pack', '[install] ' + s); if (opRef) writeOpState(opRef, { stage: s, pct: null, message: s, done: false }); };
  let manifestId: string | null = null;
  try {
    let manifest = args.manifest;
    let zip = args.zip;
    if (!manifest) {
      if (!args.zipPath) throw fail('缺少 zipPath 或 manifest');
      stage('解析清单');
      const parsed = await parsePackZip(args.zipPath);
      manifest = parsed.manifest; zip = parsed.zip;
    }
    if (!zip) zip = { files: [] };
    const id = manifest.id;
    manifestId = id;

    stage('内核兼容检查');
    const kernel = resolveKernelVersion();
    const compat = checkPackCompat(manifest, kernel);
    if (!compat.ok && !args.force) {
      return { ok: false, code: EXIT_COMPAT, error: '内核 ' + kernel + ' 不在功能包兼容范围 ' + compat.range + '（可 --force 强制安装并标记不兼容）', kernel, range: compat.range || null };
    }

    stage('冲突预检');
    const reg = loadRegistry(home);
    const existing = findPack(home, id);
    if (existing) {
      return { ok: false, error: '功能包已安装（v' + existing.version + '），请使用 update', recordId: id };
    }
    const enabledNames = patchEnabledNames();
    const conflictHits = (manifest.conflicts || []).filter((c) =>
      reg.packs.some((p) => p.plugins.some((pl) => pl.ref === c || (pl.pkg && pl.pkg === c))) ||
      enabledNames.some((n) => n === c || n === c.replace(/^builtin:/, '')));
    if (conflictHits.length > 0) {
      return { ok: false, code: EXIT_CONFLICT, error: '与已启用插件冲突: ' + conflictHits.join(', ') };
    }

    stage('保护中心快照');
    let snapshotRef: string | null = null;
    if (ctx.snapshot) {
      try { snapshotRef = ctx.snapshot('pack:' + id + ':' + manifest.version)?.id || null; } catch (err) { ctx.log('feature-pack', '快照失败（继续）: ' + String((err as Error).message)); }
    }

    // 包数据目录（payload/icon 保留，供导出与覆盖更新）。
    const dataDir = packDataDir(home, id);
    fs.mkdirSync(dataDir, { recursive: true });

    // 装配 plugins。
    const plugins: PackPluginRef[] = [];
    stage('装配插件（' + (manifest.plugins || []).length + ' 个）');
    await snapshotArtifactsFor(profile);
    for (const p of manifest.plugins || []) {
      const { source: src, pkg } = refSourceOf(p.ref);
      const installed = await assemblePlugin(p, profile);
      plugins.push({ ref: p.ref, source: src, pkg, version: p.version || null, managed: src !== 'builtin', installed: installed.installed });
    }

    // payload：presets / skills。
    const presets: PackPresetRef[] = [];
    stage('同步预设（' + (manifest.presets || []).length + ' 个）');
    for (const pr of manifest.presets || []) {
      const r = await syncPayloadPreset(zip.files, pr.id, path.join(home, '.agent-presets'));
      presets.push({ id: pr.id, installed: r.installed, skipped: r.skipped });
    }
    const skills: PackSkillRef[] = [];
    stage('同步技能（' + (manifest.skills || []).length + ' 个）');
    for (const sk of manifest.skills || []) {
      const r = await syncPayloadSkill(zip.files, sk.id, path.join(home, 'skills'));
      skills.push({ id: sk.id, installed: r.installed, skipped: r.skipped });
    }

    // payload 原始目录保留到包数据目录（导出用）；icon 同样。
    if (zip.files.some((f) => f.path.startsWith('payload/'))) {
      await extractZipTo(zip, 'payload/', packPayloadDir(home, id));
    }
    if (manifest.icon && zip.files.some((f) => f.path === manifest.icon)) {
      await extractZipTo(zip, manifest.icon.slice(0, manifest.icon.lastIndexOf('/') + 1), dataDir);
    }
    await restoreArtifactsFor(profile);

    // 注册表。
    const record: PackRecord = {
      id, version: manifest.version,
      installedAt: new Date().toISOString(),
      profile, state: compat.ok ? 'active' : 'incompatible',
      source, manifest, plugins, presets, skills,
      snapshotRef, opRef,
    };
    reg.packs.push(record);
    saveRegistry(home, reg);
    stage('安装完成');
    if (opRef) writeOpState(opRef, { stage: 'done', pct: 100, message: '安装完成', done: true, ok: true });
    return { ok: true, recordId: id };
  } catch (err) {
    const e = err as Error & { lock?: boolean };
    ctx.log('feature-pack', '安装失败: ' + e.message);
    if (opRef) writeOpState(opRef, { stage: 'failed', pct: null, message: e.message, done: true, ok: false, error: e.message });
    // 清理半成品包数据目录（未入册，无需回滚注册表）。
    if (manifestId) {
      try { fs.rmSync(packDataDir(home, manifestId), { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    }
    return { ok: false, stage: 'error', error: e.message, code: e.lock ? EXIT_LOCK : EXIT_FAIL };
  }
}

export async function uninstallPack(id: string, opts: { opRef?: string | null } = {}): Promise<{ ok: boolean; error?: string; code?: number }> {
  const home = homeOf();
  const opRef = opts.opRef || null;
  try {
    const reg = loadRegistry(home);
    const rec = reg.packs.find((p) => p.id === id);
    if (!rec) return { ok: false, error: '未安装该功能包: ' + id, code: EXIT_FAIL };
    const profile = rec.profile || ctx.getDesktopProfile();

    // 插件：managed 且无其他包引用 → 移除（builtin 不动作）。
    await snapshotArtifactsFor(profile);
    for (const pl of rec.plugins) {
      if (pl.source === 'builtin' || !pl.managed) continue;
      if (refCount(reg, id, pl.pkg || pl.ref) > 0) continue;
      ctx.log('feature-pack', '移除包所属插件: ' + (pl.pkg || pl.ref));
      await removePlugin(pl, profile);
    }
    await restoreArtifactsFor(profile);

    // preset：由本包装且未被跳过 → 带托管标记的目录删除。
    for (const pr of rec.presets) {
      if (!pr.installed || pr.skipped) continue;
      const dest = path.join(home, '.agent-presets', pr.id);
      try {
        if (fs.existsSync(path.join(dest, '.eac-package.json'))) fs.rmSync(dest, { recursive: true, force: true });
      } catch (err) { ctx.log('feature-pack', 'preset 清理失败（继续）: ' + String((err as Error).message)); }
    }

    // skills：托管标记删除。
    for (const sk of rec.skills) {
      if (!sk.installed || sk.skipped) continue;
      const dest = path.join(home, 'skills', sk.id);
      try {
        const marker = path.join(dest, '.eac-skill.json');
        if (fs.existsSync(marker)) {
          const m = JSON.parse(fs.readFileSync(marker, 'utf8')) as { managed?: boolean };
          if (m.managed !== false) fs.rmSync(dest, { recursive: true, force: true });
        }
      } catch (err) { ctx.log('feature-pack', 'skill 清理失败（继续）: ' + String((err as Error).message)); }
    }

    // 包数据目录 + 注册表记录。
    fs.rmSync(packDataDir(home, id), { recursive: true, force: true });
    reg.packs = reg.packs.filter((p) => p.id !== id);
    saveRegistry(home, reg);
    if (opRef) writeOpState(opRef, { stage: 'done', pct: 100, message: '卸载完成', done: true, ok: true });
    return { ok: true };
  } catch (err) {
    const e = err as Error;
    if (opRef) writeOpState(opRef, { stage: 'failed', pct: null, message: e.message, done: true, ok: false, error: e.message });
    return { ok: false, error: e.message, code: EXIT_FAIL };
  }
}

export async function updatePack(id: string, args: { zipPath?: string; manifest?: PackManifest; zip?: { files: ZipEntry[] }; force?: boolean; opRef?: string | null }): Promise<InstallResult> {
  const home = homeOf();
  const opRef = args.opRef || null;
  const stage = (s: string): void => { ctx.log('feature-pack', '[update] ' + s); if (opRef) writeOpState(opRef, { stage: s, pct: null, message: s, done: false }); };
  try {
    const reg = loadRegistry(home);
    const rec = reg.packs.find((p) => p.id === id);
    if (!rec) return { ok: false, error: '未安装该功能包: ' + id, code: EXIT_FAIL };
    let manifest = args.manifest;
    let zip = args.zip;
    if (!manifest) {
      if (!args.zipPath) throw fail('缺少 zipPath 或 manifest');
      const parsed = await parsePackZip(args.zipPath);
      manifest = parsed.manifest; zip = parsed.zip;
    }
    if (manifest.id !== id) throw fail('更新包 id 不一致: ' + manifest.id);
    if (!zip) zip = { files: [] };

    stage('内核兼容检查');
    const kernel = resolveKernelVersion();
    const compat = checkPackCompat(manifest, kernel);
    if (!compat.ok && !args.force) {
      return { ok: false, code: EXIT_COMPAT, error: '内核 ' + kernel + ' 不在新版本兼容范围 ' + compat.range, kernel, range: compat.range || null };
    }

    stage('冲突预检');
    const enabledNames = patchEnabledNames();
    const conflictHits = (manifest.conflicts || []).filter((c) =>
      reg.packs.some((p) => p.id !== id && p.plugins.some((pl) => pl.ref === c || (pl.pkg && pl.pkg === c))) ||
      enabledNames.some((n) => n === c || n === c.replace(/^builtin:/, '')));
    if (conflictHits.length > 0) return { ok: false, code: EXIT_CONFLICT, error: '与已启用插件冲突: ' + conflictHits.join(', ') };

    stage('保护中心快照');
    let snapshotRef: string | null = null;
    if (ctx.snapshot) {
      try { snapshotRef = ctx.snapshot('pack-update:' + id + ':' + manifest.version)?.id || null; } catch { /* 继续 */ }
    }

    // 插件差异：移除不再引用的 owned；新增引用装配。
    const profile = rec.profile || ctx.getDesktopProfile();
    await snapshotArtifactsFor(profile);
    const oldPlugins = rec.plugins;
    const newRefs = (manifest.plugins || []).map((p) => p.ref);
    const plugins: PackPluginRef[] = [];
    for (const old of oldPlugins) {
      if (old.managed && !newRefs.includes(old.ref)) {
        if (refCount(reg, id, old.pkg || old.ref) === 0) {
          ctx.log('feature-pack', '更新移除不再引用插件: ' + (old.pkg || old.ref));
          removePlugin(old, profile);
        }
      }
    }
    for (const p of manifest.plugins || []) {
      const prev = oldPlugins.find((o) => o.ref === p.ref);
      const { source: src, pkg } = refSourceOf(p.ref);
      const versionChanged = !!prev && !!p.version && prev.version !== p.version;
      if (versionChanged && src !== 'builtin' && pkg) {
        // 期望版本变化 → 升级式重装（remove + add）。
        await removePlugin(prev, profile);
      }
      if (!prev || versionChanged) {
        const installed = await assemblePlugin(p, profile);
        plugins.push({ ref: p.ref, source: src, pkg, version: p.version || null, managed: src !== 'builtin', installed: installed.installed });
      } else {
        plugins.push({ ...prev, version: p.version || prev.version || null });
      }
    }
    await restoreArtifactsFor(profile);

    // payload 差异。
    const presets: PackPresetRef[] = [];
    for (const pr of manifest.presets || []) {
      const r = await syncPayloadPreset(zip.files, pr.id, path.join(home, '.agent-presets'));
      presets.push({ id: pr.id, installed: r.installed, skipped: r.skipped });
    }
    const skills: PackSkillRef[] = [];
    for (const sk of manifest.skills || []) {
      const r = await syncPayloadSkill(zip.files, sk.id, path.join(home, 'skills'));
      skills.push({ id: sk.id, installed: r.installed, skipped: r.skipped });
    }
    // 不再引用的 managed payload 删除。
    for (const pr of rec.presets) {
      if (pr.installed && !pr.skipped && !presets.some((n) => n.id === pr.id)) {
        const dest = path.join(home, '.agent-presets', pr.id);
        try { if (fs.existsSync(path.join(dest, '.eac-package.json'))) fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 继续 */ }
      }
    }
    for (const sk of rec.skills) {
      if (sk.installed && !sk.skipped && !skills.some((n) => n.id === sk.id)) {
        const dest = path.join(home, 'skills', sk.id);
        try {
          const marker = path.join(dest, '.eac-skill.json');
          if (fs.existsSync(marker)) {
            const m = JSON.parse(fs.readFileSync(marker, 'utf8')) as { managed?: boolean };
            if (m.managed !== false) fs.rmSync(dest, { recursive: true, force: true });
          }
        } catch { /* 继续 */ }
      }
    }

    // payload/icon 更新到包数据目录。
    if (zip.files.some((f) => f.path.startsWith('payload/'))) {
      fs.rmSync(packPayloadDir(home, id), { recursive: true, force: true });
      await extractZipTo(zip, 'payload/', packPayloadDir(home, id));
    }
    if (manifest.icon && zip.files.some((f) => f.path === manifest.icon)) {
      await extractZipTo(zip, manifest.icon.slice(0, manifest.icon.lastIndexOf('/') + 1), packDataDir(home, id));
    }

    rec.version = manifest.version;
    rec.manifest = manifest;
    rec.state = compat.ok ? 'active' : 'incompatible';
    rec.plugins = plugins;
    rec.presets = presets;
    rec.skills = skills;
    rec.snapshotRef = snapshotRef;
    rec.opRef = opRef;
    saveRegistry(home, reg);
    stage('更新完成');
    if (opRef) writeOpState(opRef, { stage: 'done', pct: 100, message: '更新完成', done: true, ok: true });
    return { ok: true, recordId: id };
  } catch (err) {
    const e = err as Error & { lock?: boolean };
    ctx.log('feature-pack', '更新失败: ' + e.message);
    if (opRef) writeOpState(opRef, { stage: 'failed', pct: null, message: e.message, done: true, ok: false, error: e.message });
    return { ok: false, stage: 'error', error: e.message, code: e.lock ? EXIT_LOCK : EXIT_FAIL };
  }
}

export async function exportPack(id: string, outZip: string): Promise<{ ok: boolean; error?: string; path?: string }> {
  try {
    const home = homeOf();
    const rec = findPack(home, id);
    if (!rec) return { ok: false, error: '未安装该功能包: ' + id };
    const dataDir = packDataDir(home, id);
    const payloadDir = packPayloadDir(home, id);
    fs.mkdirSync(path.dirname(outZip), { recursive: true });
    return new Promise<{ ok: boolean; error?: string; path?: string }>((resolve) => {
      const z = archiver('zip', { zlib: { level: 9 } });
      const out = fs.createWriteStream(outZip);
      const done = (r: { ok: boolean; error?: string; path?: string }): void => { try { out.close(); } catch { /* 已关闭 */ } resolve(r); };
      z.on('error', (err) => done({ ok: false, error: String((err as Error).message) }));
      out.on('error', (err) => done({ ok: false, error: String((err as Error).message) }));
      z.pipe(out);
      z.append(JSON.stringify({ ...rec.manifest, formatVersion: 1 }, null, 2) + '\n', { name: 'pack.json' });
      // 保留的 payload。
      try {
        if (fs.existsSync(payloadDir)) {
          for (const dir of ['presets', 'skills']) {
            const base = path.join(payloadDir, dir);
            if (!fs.existsSync(base)) continue;
            for (const name of fs.readdirSync(base)) {
              z.directory(path.join(base, name), 'payload/' + dir + '/' + name);
            }
          }
        }
      } catch { /* payload 缺失不影响导出 */
      }
      // icon。
      try {
        if (rec.manifest.icon) {
          const iconPath = path.join(dataDir, path.basename(rec.manifest.icon));
          if (fs.existsSync(iconPath)) {
            z.append(fs.readFileSync(iconPath), { name: rec.manifest.icon });
          }
        }
      } catch { /* 忽略 */ }
      z.finalize().then(() => done({ ok: true, path: outZip })).catch((err: Error) => done({ ok: false, error: err.message }));
    });
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
}

export function rollbackPack(id: string): { ok: boolean; error?: string } {
  const home = homeOf();
  const rec = findPack(home, id);
  if (!rec) return { ok: false, error: '未安装该功能包: ' + id };
  if (!rec.snapshotRef) return { ok: false, error: '该功能包没有保护中心快照（无法回滚）' };
  if (!ctx.restoreSnapshot) return { ok: false, error: '保护中心回滚能力不可用' };
  const r = ctx.restoreSnapshot(rec.snapshotRef);
  if (!r.ok) return { ok: false, error: r.error || '回滚失败' };
  rec.state = 'rolled-back';
  const reg = loadRegistry(home);
  const rec2 = reg.packs.find((p) => p.id === id);
  if (rec2) { rec2.state = 'rolled-back'; saveRegistry(home, reg); }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// op 状态文件与排队 resume
// ---------------------------------------------------------------------------

export interface OpState {
  opRef: string;
  action: string;
  stage: string;
  pct: number | null;
  message: string;
  done: boolean;
  ok: boolean | undefined;
  error: string | undefined;
}

export function writeOpState(opRef: string, partial: Omit<OpState, 'opRef' | 'action' | 'ok' | 'error'> & { action?: string; ok?: boolean; error?: string }): void {
  try {
    const home = homeOf();
    fs.mkdirSync(opsDir(home), { recursive: true });
    const prev = readOpState(opRef);
    const next: OpState = { opRef, action: partial.action || prev?.action || 'op', stage: partial.stage, pct: partial.pct ?? prev?.pct ?? null, message: partial.message, done: partial.done, ok: partial.ok, error: partial.error };
    const file = path.join(opsDir(home), opRef + '.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 状态文件尽力而为 */ }
}

export function readOpState(opRef: string): OpState | null {
  try {
    const file = path.join(opsDir(homeOf()), opRef + '.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as OpState;
  } catch { return null; }
}

export interface PendingTask { action: 'install' | 'uninstall' | 'update'; id?: string; zipPath?: string; force?: boolean; opRef?: string; attempts?: number; ts?: number }
export interface PendingFile { version: number; tasks: PendingTask[] }

export function loadPending(): PendingFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingFile(homeOf()), 'utf8')) as PendingFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.tasks)) return parsed;
  } catch { /* 缺省空 */ }
  return { version: 1, tasks: [] };
}

export function savePending(p: PendingFile): void {
  const home = homeOf();
  fs.mkdirSync(opsDir(home), { recursive: true });
  const file = pendingFile(home);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function enqueuePending(task: PendingTask): void {
  const p = loadPending();
  p.tasks.push({ ...task, attempts: task.attempts || 0, ts: Date.now() });
  savePending(p);
}

/** 无锁窗口消费排队任务（sidecar 在旧进程退出后调用）；失败任务 attempts+1，超限丢弃。 */
export async function resumePending(): Promise<{ ok: boolean; results: { action: string; id: string | undefined; ok: boolean; error: string | undefined }[]; skipped: string[] }> {
  const p = loadPending();
  if (p.tasks.length === 0) return { ok: true, results: [], skipped: [] };
  const results: { action: string; id: string | undefined; ok: boolean; error: string | undefined }[] = [];
  const skipped: string[] = [];
  const PENDING_MAX = 3;
  for (const t of p.tasks) {
    const attempts = t.attempts || 0;
    try {
      let r: InstallResult | { ok: boolean; error?: string; code?: number };
      if (t.action === 'install') {
        r = await installPack({ ...(t.zipPath ? { zipPath: t.zipPath } : {}), ...(t.force ? { force: true } : {}), opRef: t.opRef ?? null, source: 'pending' });
      } else if (t.action === 'update') {
        if (!t.id) { skipped.push('update 缺少 id'); continue; }
        r = await updatePack(t.id, { ...(t.zipPath ? { zipPath: t.zipPath } : {}), ...(t.force ? { force: true } : {}), opRef: t.opRef ?? null });
      } else {
        if (!t.id) { skipped.push('uninstall 缺少 id'); continue; }
        r = await uninstallPack(t.id, { opRef: t.opRef ?? null });
      }
      if (!r.ok) {
        const error = r.error || '';
        if (attempts + 1 >= PENDING_MAX) {
          skipped.push((t.id || t.zipPath || '?') + '（连续 ' + (attempts + 1) + ' 次失败，放弃: ' + error.slice(0, 200) + '）');
        } else {
          t.attempts = attempts + 1;
          results.push({ action: t.action, id: t.id, ok: false, error: '待重试: ' + error.slice(0, 200) });
          continue;   // 保留任务
        }
      } else {
        results.push({ action: t.action, id: t.id, ok: true, error: undefined });
      }
    } catch (err) {
      const error = String((err as Error).message);
      if (attempts + 1 >= PENDING_MAX) skipped.push((t.id || t.zipPath || '?') + '（异常放弃: ' + error.slice(0, 200) + '）');
      else { t.attempts = attempts + 1; results.push({ action: t.action, id: t.id, ok: false, error: '待重试: ' + error.slice(0, 200) }); continue; }
    }
    p.tasks = p.tasks.filter((x) => x !== t);
  }
  if (p.tasks.length === 0) {
    try { fs.rmSync(pendingFile(homeOf()), { force: true }); } catch { /* 尽力 */ }
  } else {
    savePending(p);
  }
  return { ok: true, results, skipped };
}