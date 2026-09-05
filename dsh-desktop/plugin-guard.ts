'use strict';

// plugin-guard.js — 桌面端内置的插件保护中心（融合社区三大保护插件并升华）：
//
//   lxzy-7/dsh-plugin-guard        → 安装前快照 / 一键与自动回滚 / 守护启动 /
//                                    事故报告（incident）
//   LX2000WASD/dsh-web-plugin-manager → 安装守卫（安装后验证 + 失败回滚）、
//                                    健康检查入口
//   chenw275-wq/dsh-plugin-healthcheck → 静态体检（模块遮蔽 / patch 行 / 高危
//                                    静态扫描），绝不执行插件代码
//
// 与三个独立插件不同，这里跑在 Electron 主进程里：
//   · 快照/回滚发生在「无服务进程持锁」的窗口期（重启间隙），不撞 Windows
//     文件锁；
//   · 守护启动直接包在 dsh web 的拉起链路上：起不来 → 体检 → 自动修复 →
//     重试 → 仍失败回滚到最后良好快照 → 再试 → 仍失败落事故报告并通知；
//   · junction 归属守卫（原生 dsh 共存，见 checkJunctionOwnership）。
//
// 原则（对齐 healthcheck 的 HARD RULE）：只动插件层与配置层
//（cordis.patch.yml / package.json / node_modules 里的遮蔽拷贝），
// 绝不修改 harness 内核或用户会话数据。

import fs = require('node:fs');
import path = require('node:path');
import os = require('node:os');

const { writeJsonAtomic, writeFileAtomic } = require('./lib/atomic-json') as {
  writeJsonAtomic(file: string, value: unknown): void;
  writeFileAtomic(file: string, content: string | Buffer): void;
};
const { healProfileModuleShadowing } = require('./profile-module-heal') as {
  healProfileModuleShadowing(home: string, profile?: string, log?: (m: string) => void): string[];
};
const { healSoulMdPatchRow, removeBundledRowDuplicates, collectBundleEntryIds } = require('./patch-row-heal') as {
  healSoulMdPatchRow(patch: string, config?: Record<string, unknown>): { patch: string; healed: string[] };
  removeBundledRowDuplicates(patch: string, rowIds: Record<string, unknown>, bundleNames: unknown[], bundleEntryIds: Set<string>): { patch: string; removed: string[] };
  collectBundleEntryIds(bundleNames: unknown[], profileNodeModules: string): Set<string>;
};
const { togglePluginInPatch } = require('./scripts/plugin-manager-patch') as {
  togglePluginInPatch(text: string, id: string, enabled: boolean, name?: string): string;
};
// semver 随 dsh 内核闭包/锁文件携带；个别精简环境缺失时降级：peer 版本比对
// 全部按「提示级」处理（绝不误判、绝不崩），模块缺失/入口/注入检查不受影响。
interface SemverLike {
  satisfies(v: string, r: string): boolean;
  validRange(r: string): string | null;
  minVersion(r: string): { major: number; minor: number; patch: number } | null;
  coerce(v: string): { major: number; minor: number; patch: number } | null;
}
let semverLib: SemverLike | null = null;
try { semverLib = require('semver') as SemverLike; } catch { /* semver 不可用 → 降级 */ }

// 快照覆盖的 profile 配置面：插件树的全部「声明性」状态。
const GUARD_FILES: string[] = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'];
const MAX_SNAPSHOTS = 10;

// ── 静态高危扫描（healthcheck 的 C8 思路）────────────────────────────────
// 只做 readFileSync + 正则，绝不 require/执行插件代码；命中即报告（高危级），
// 不自动删除。模式面向「装完即失控」的常见木马形态，刻意保守以压低误报。
interface TrojanPattern {
  code: string;
  re: RegExp;
}
const TROJAN_PATTERNS: TrojanPattern[] = [
  { code: 'TROJAN_REMOTE_EXEC', re: /(?:child_process|execSync|spawnSync|exec|spawn)\s*\(\s*['"`](?:curl|wget|powershell|cmd|bash|sh)\b[^'"`]*['"`][\s\S]{0,200}(?:\|\s*(?:sh|bash|iex|Invoke-Expression)|-enc\b)/i },
  { code: 'TROJAN_DOWNLOAD_EXEC', re: /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr)\b[\s\S]{0,160}?(?:\|\s*(?:sh|bash|iex|Invoke-Expression)\b|Out-File[\s\S]{0,80}\.(?:ps1|bat|cmd|vbs))/i },
  { code: 'TROJAN_BASE64_EVAL', re: /(?:eval|Function)\s*\(\s*(?:atob|Buffer\.from\([^)]*,\s*['"]base64['"]\)|window\.atob)\s*\(/i },
  { code: 'TROJAN_PERSISTENCE', re: /(?:reg(?:\.exe)?\s+add[\s\S]{0,120}(?:Run|RunOnce)|Startup[\\\\/][\w.-]+\.(?:bat|cmd|ps1|vbs|lnk)|schtasks\s+\/create|Register-ScheduledTask)/i },
  { code: 'TROJAN_EXFIL_ENV', re: /(?:process\.env|os\.env)[\s\S]{0,120}(?:https?:\/\/|fetch\s*\(|XMLHttpRequest|net\.connect|dgram)/i },
];
const SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;   // 单文件扫描上限 2MB
const SCAN_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 单包总扫描上限 32MB
const SCAN_EXTS = /\.(c?js|mjs|cjs|json|yml|yaml|sh|ps1|bat|cmd)$/i;

interface GuardOpts {
  getHome: () => string;    // () => string  有效的 DSH_HOME
  getProfile: () => string; // () => string  桌面端使用的 profile 名
  dshBin: () => string;     // () => string  当前生效的 dsh bin（内置或 overlay）
  log?: (section: string, message: string) => void;
}

interface SnapshotMeta {
  id: string;
  reason: string;
  at: string;
  files: string[];
  pluginRows: string[];
}

interface Finding {
  code: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
  fixable: boolean;
  /** 版本兼容防线的发现项归属（patch 行条目），供自动/手动隔离定位。 */
  entry?: { id: string | null; name: string; fromBundle?: boolean };
}

/** 版本兼容防线（v0.2）：内核版本 + 每条 patch 条目的安装/入口/peer/inject 状态。 */
interface CompatPeer {
  dep: string;
  required: string;
  actual: string | null;
  verdict: 'ok' | 'low' | 'high' | 'missing' | 'optional';
  ok: boolean;
  optional: boolean;
}
interface CompatInject {
  dep: string;
  ok: boolean;
  alias?: boolean;
}
interface CompatRow {
  id: string | null;
  name: string | null;
  enabled: boolean;
  fromBundle: boolean;
  installed: boolean;
  version: string | null;
  entryPoint: string | null;
  kernelWindow: string | null;
  peers: CompatPeer[];
  inject: CompatInject[];
  issues: string[];
}
interface CompatReport {
  at: string;
  profile: string;
  kernel: { name: string; version: string | null };
  entries: CompatRow[];
}

interface GuardState {
  lastGood?: string | null;
  lastGoodAt?: string;
}

interface BootAttribution {
  name: string;
  kind: 'patchRow' | 'bundle' | 'dependency';
  rowId: string | null;
}

interface GuardApi {
  snapshot(reason: string): SnapshotMeta | null;
  listSnapshots(): SnapshotMeta[];
  restore(id: string): { ok: boolean; restored?: string[]; error?: string };
  markGood(id: string): void;
  lastGoodSnapshot(): SnapshotMeta | null;
  healthCheck(): { at: string; profile: string; findings: Finding[] };
  repair(findings?: Finding[]): { applied: string[] };
  repairJunctions(): { repaired: string[]; unknown: string[]; pruned: string[] };
  junctionFindings(): Finding[];
  reportIncident(title: string, detail: string): { ok: boolean; file?: string; error?: string };
  listIncidents(): { id: string; title: string }[];
  readIncident(id: string): { ok: boolean; content?: string; error?: string };
  resolveIncident(id: string): { ok: boolean; error?: string };
  attributeBootFailure(errText: string): BootAttribution | null;
  // 版本兼容防线（v0.2）
  compatFindings(dir?: string): Finding[];
  versionReport(): CompatReport;
  quarantineFatal(opts?: { quarantinePeers?: boolean }): { checked: number; quarantined: string[] };
  quarantineById(id: string): { ok: boolean; error?: string; snapshot?: string | null; alreadyDisabled?: boolean; restartRequired?: boolean };
}

function createGuard(opts: GuardOpts): GuardApi {
  const {
    getHome,          // () => string  有效的 DSH_HOME
    getProfile,       // () => string  桌面端使用的 profile 名
    dshBin,           // () => string  当前生效的 dsh bin（内置或 overlay）
    log = () => {},
  } = opts;

  const home = () => getHome() || path.join(os.homedir(), '.dsh');
  const profileDir = () => path.join(home(), 'profiles', getProfile());
  const guardDir = () => path.join(home(), 'guard');
  const rollbacksDir = () => path.join(home(), 'rollbacks', getProfile());
  const stateFile = () => path.join(guardDir(), 'state.json');
  const incidentsDir = () => path.join(guardDir(), 'incidents');

  function readJson(file: string, fallback?: any): any {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  function writeJson(file: string, value: unknown): void {
    writeJsonAtomic(file, value);
  }

  // ── 快照 / 回滚（plugin-guard 的核心）────────────────────────────────
  // 只备份声明性配置（四个小文件），秒级完成；node_modules 实体不备份 ——
  // 回滚配置后，残留的包目录只是「不再被引用」，不影响加载。
  function snapshot(reason: string): SnapshotMeta | null {
    try {
      const dir = profileDir();
      if (!fs.existsSync(dir)) return null;
      const baseStamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
      fs.mkdirSync(rollbacksDir(), { recursive: true });
      let stamp = baseStamp;
      let dest = path.join(rollbacksDir(), stamp);
      for (let collision = 0; ; collision += 1) {
        try {
          fs.mkdirSync(dest);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          stamp = `${baseStamp}-${String(collision + 1).padStart(4, '0')}`;
          dest = path.join(rollbacksDir(), stamp);
        }
      }
      const files: string[] = [];
      const rows: string[] = [];
      for (const name of GUARD_FILES) {
        const src = path.join(dir, name);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(dest, name));
        files.push(name);
        if (name === 'cordis.patch.yml') {
          for (const id of patchRowIds(fs.readFileSync(src, 'utf8'))) rows.push(id);
        }
      }
      const meta: SnapshotMeta = {
        id: stamp, reason: String(reason || 'manual'), at: new Date().toISOString(),
        files, pluginRows: rows,
      };
      writeJson(path.join(dest, 'meta.json'), meta);
      pruneSnapshots();
      log('guard', `已创建快照 ${stamp}（${reason}，${files.length} 个文件，${rows.length} 个插件行）`);
      return meta;
    } catch (err) {
      log('guard', '创建快照失败: ' + (err as Error).message);
      return null;
    }
  }

  function listSnapshots(): SnapshotMeta[] {
    try {
      const root = rollbacksDir();
      if (!fs.existsSync(root)) return [];
      const out: SnapshotMeta[] = [];
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = readJson(path.join(root, entry.name, 'meta.json'), null);
        if (!meta || !Array.isArray(meta.files) || meta.files.length === 0) continue;
        out.push(meta);
      }
      out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
      return out;
    } catch {
      return [];
    }
  }

  function pruneSnapshots(): void {
    try {
      const list = listSnapshots();
      for (let i = MAX_SNAPSHOTS; i < list.length; i += 1) {
        fs.rmSync(path.join(rollbacksDir(), list[i]!.id), { recursive: true, force: true, maxRetries: 2 });
      }
    } catch { /* 清理失败不影响主流程 */ }
  }

  function restore(id: string): { ok: boolean; restored?: string[]; error?: string } {
    try {
      if (!/^[\w.-]+$/.test(String(id || ''))) return { ok: false, error: 'bad snapshot id' };
      const snapDir = path.join(rollbacksDir(), String(id));
      if (!fs.existsSync(snapDir)) return { ok: false, error: 'snapshot not found' };
      const dir = profileDir();
      fs.mkdirSync(dir, { recursive: true });
      // 回滚前给当前状态留一份「回滚前」快照，反悔有路。
      snapshot('pre-restore:' + id);
      const restored: string[] = [];
      for (const name of GUARD_FILES) {
        const src = path.join(snapDir, name);
        if (!fs.existsSync(src)) continue;
        // restore 目标是 cordis.patch.yml 等启动关键文件：copyFileSync 裸写
        // 中断即截断。读出字节后走原子写（保内容逐字节一致）。
        writeFileAtomic(path.join(dir, name), fs.readFileSync(src));
        restored.push(name);
      }
      log('guard', `已回滚 profile 到快照 ${id}（${restored.join(', ')}）`);
      return { ok: true, restored };
    } catch (err) {
      return { ok: false, error: String(((err as Error) && (err as Error).message) || err) };
    }
  }

  function state(): GuardState {
    return readJson(stateFile(), {});
  }

  function markGood(id: string): void {
    try {
      const s = state();
      s.lastGood = id || null;
      s.lastGoodAt = new Date().toISOString();
      writeJson(stateFile(), s);
    } catch { /* 标记失败无碍 */ }
  }

  function lastGoodSnapshot(): SnapshotMeta | null {
    const s = state();
    if (!s.lastGood) return null;
    return listSnapshots().find((m) => m.id === s.lastGood) || null;
  }

  // ── 静态体检（healthcheck 的 L0/L1 思路）─────────────────────────────
  // 发现项：{ code, severity: 'high'|'medium'|'low', message, fixable }
  function healthCheck(): { at: string; profile: string; findings: Finding[] } {
    const findings: Finding[] = [];
    const dir = profileDir();

    // C3：profile node_modules 里遮蔽安装闭包 junction 的拷贝（真实目录或
    // pnpm 链接）→ 模块双实例 → Symbol 身份不一致 → 「设置命名空间不可用」。
    findings.push(...shadowFindings(dir));

    // patch 行体检：重复 entry id（duplicate loader entry → 整树崩溃）、
    // soul-md 行缺 config.path（v2.0.0 存量坏行）。
    findings.push(...patchFindings(dir));

    // junction 归属（原生 dsh 共存冲突，见 checkJunctionOwnership 注释）。
    findings.push(...junctionFindings());

    // 高危静态扫描：只扫非内置的第三方包。
    findings.push(...trojanFindings(dir));

    // 版本兼容防线（v0.2）：插件包/入口缺失、peer 依赖不满足、client 注入
    // 缺失、内核版本窗口违例（只读 manifest，绝不执行插件代码）。
    findings.push(...compatFindings(dir));

    return { at: new Date().toISOString(), profile: getProfile(), findings };
  }

  // 供 main.js 周期性轻量检查（不打扰用户，只返回是否有异动）。
  function junctionFindings(): Finding[] {
    const out: Finding[] = [];
    try {
      const fallbackDir = path.join(home(), 'profiles', 'node_modules');
      const expected = expectedClosureRoot();
      if (!expected || !fs.existsSync(fallbackDir)) return out;
      for (const full of listFallbackNames(fallbackDir)) {
        const link = path.join(fallbackDir, full);
        let st;
        try { st = fs.lstatSync(link); } catch { continue; }
        if (!st.isSymbolicLink()) continue;
        const target = safeReadlink(link);
        if (!target) continue;
        const real = safeRealpath(link) || target;
        const expRoot = safeRealpath(expected) || expected;
        const norm = (p: string) => String(p).replace(/\//g, '\\').toLowerCase();
        if (!norm(real).startsWith(norm(expRoot))) {
          out.push({
            code: 'JUNCTION_FOREIGN',
            severity: 'high',
            message: `共享模块 ${full} 被外部 dsh 实例接管（指向 ${target}）`,
            fixable: true,
          });
        } else if (!fs.existsSync(real)) {
          out.push({
            code: 'JUNCTION_DANGLING',
            severity: 'high',
            message: `共享模块 ${full} 指向的目标已不存在（${target}）`,
            fixable: true,
          });
        }
      }
    } catch { /* 枚举失败按无发现处理 */ }
    return out;
  }

  function listFallbackNames(fallbackDir: string): string[] {
    const names: string[] = [];
    let entries;
    try { entries = fs.readdirSync(fallbackDir, { withFileTypes: true }); } catch { return names; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink() || entry.isDirectory()) names.push(entry.name);
      else if (entry.isDirectory() === false && entry.name.includes('-')) continue;
      if (entry.isDirectory()) {
        let children;
        try { children = fs.readdirSync(path.join(fallbackDir, entry.name), { withFileTypes: true }); } catch { continue; }
        for (const child of children) {
          if (child.isSymbolicLink() || child.isDirectory()) names.push(entry.name + '/' + child.name);
        }
      }
    }
    return names;
  }

  // dshBin() 形如 <closure>/@deepseek-ai/dsh/lib/bin.js → 安装闭包根。
  function expectedClosureRoot(): string | null {
    try {
      return path.resolve(dshBin(), '../../../..');
    } catch {
      return null;
    }
  }

  function shadowFindings(dir: string): Finding[] {
    const out: Finding[] = [];
    try {
      const fallbackDir = path.join(home(), 'profiles', 'node_modules');
      const modulesDir = path.join(dir, 'node_modules');
      if (!fs.existsSync(fallbackDir) || !fs.existsSync(modulesDir)) return out;
      for (const { full, rel } of fallbackPackages(fallbackDir)) {
        const shadow = path.join(modulesDir, rel);
        let st;
        try { st = fs.lstatSync(shadow); } catch { continue; }
        if (st.isDirectory() && !st.isSymbolicLink()) {
          out.push({ code: 'SHADOW_COPY', severity: 'high', message: `插件依赖把核心包 ${full} 装成了独立拷贝（模块双实例根源）`, fixable: true });
        } else if (st.isSymbolicLink()) {
          const target = safeReadlink(shadow) || '';
          const norm = (p: string) => String(p).replace(/\//g, '\\').toLowerCase();
          if (norm(target).includes(norm(path.join(modulesDir, '.pnpm')))) {
            out.push({ code: 'SHADOW_LINK', severity: 'high', message: `pnpm 把核心包 ${full} 链接进了 profile（模块双实例根源）`, fixable: true });
          }
        }
      }
    } catch { /* 枚举失败按无发现处理 */ }
    return out;
  }

  function fallbackPackages(fallbackDir: string): { full: string; rel: string }[] {
    const names: { full: string; rel: string }[] = [];
    let entries;
    try { entries = fs.readdirSync(fallbackDir, { withFileTypes: true }); } catch { return names; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) names.push({ full: entry.name, rel: entry.name });
      else if (entry.isDirectory()) {
        let children;
        try { children = fs.readdirSync(path.join(fallbackDir, entry.name), { withFileTypes: true }); } catch { continue; }
        for (const child of children) {
          if (child.isSymbolicLink() || child.isDirectory()) {
            names.push({ full: entry.name + '/' + child.name, rel: path.join(entry.name, child.name) });
          }
        }
      }
    }
    return names;
  }

  function patchRowIds(patch: string | null | undefined): string[] {
    const ids: string[] = [];
    const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(patch || ''))) !== null) ids.push(m[1]!);
    return ids;
  }

  function patchFindings(dir: string): Finding[] {
    const out: Finding[] = [];
    try {
      const file = path.join(dir, 'cordis.patch.yml');
      if (!fs.existsSync(file)) return out;
      const text = fs.readFileSync(file, 'utf8');
      const ids = patchRowIds(text);
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      for (const id of [...new Set(dup)]) {
        out.push({ code: 'PATCH_DUP_ID', severity: 'high', message: `patch 行 id 重复：${id}（会以 duplicate loader entry 拖垮整棵插件树）`, fixable: true });
      }
      if (/id:\s*soul-md\b/.test(text)) {
        const bad = /(^[\t ]*- id: soul-md\b[^\n]*\n[\t ]*name: ['"]?[^'"\n]+['"]?\n)(?![\t ]*config:)/m.test(text);
        if (bad) {
          out.push({ code: 'PATCH_SOUL_CONFIG', severity: 'medium', message: 'soul-md 行缺少 config.path（dsh web 退出码 1 的历史根因）', fixable: true });
        }
      }
    } catch { /* 读不了按无发现处理 */ }
    return out;
  }

  // 静态扫描结论缓存（vnext-absorb Phase 3）：键 = 文件绝对路径，命中条件 =
  // (mtimeMs, size) 与上次扫描一致 —— 重复 healthCheck() 免 readFileSync +
  // 正则（最多 32MB 插件文本）。容量上限防长期驻留内存膨胀。
  const SCAN_VERDICT_CACHE_MAX = 20000;
  const verdictCache = new Map<string, { mtimeMs: number; size: number; finding: Finding | null }>();

  function trojanFindings(dir: string): Finding[] {
    const out: Finding[] = [];
    try {
      const builtin = new Set(readJson(path.join(dir, '.dsh-builtin-plugins.json'), { names: [] }).names || []);
      const modulesDir = path.join(dir, 'node_modules');
      if (!fs.existsSync(modulesDir)) return out;
      let total = 0;
      const walk = (d: string, depth: number): void => {
        if (depth > 4 || total > SCAN_MAX_TOTAL_BYTES || out.length >= 20) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name === '.pnpm' || e.name.startsWith('.')) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            const pkg = readJson(path.join(p, 'package.json'), null);
            if (pkg && builtin.has(pkg.name)) continue; // 内置分发包不扫
            walk(p, depth + 1);
          } else if (e.isFile() && SCAN_EXTS.test(e.name)) {
            let st;
            try { st = fs.statSync(p); } catch { continue; }
            if (st.size > SCAN_MAX_FILE_BYTES || total + st.size > SCAN_MAX_TOTAL_BYTES) continue;
            total += st.size;
            // 结论缓存命中：内容身份 (mtimeMs, size) 未变 → 免读免正则。
            const cached = verdictCache.get(p);
            if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
              if (cached.finding) out.push(cached.finding);
              continue;
            }
            let finding: Finding | null = null;
            let text;
            try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
            for (const { code, re } of TROJAN_PATTERNS) {
              if (re.test(text)) {
                finding = {
                  code,
                  severity: 'high',
                  message: `静态扫描命中高危模式（${code}）：${path.relative(modulesDir, p)}`,
                  fixable: false,
                };
                break; // 每文件只报首个模式
              }
            }
            if (verdictCache.size >= SCAN_VERDICT_CACHE_MAX) verdictCache.clear();
            verdictCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, finding });
            if (finding) out.push(finding);
          }
        }
      };
      walk(modulesDir, 0);
    } catch { /* 扫描失败按无发现处理 */ }
    return out;
  }

  // ── 版本兼容防线（v0.2）────────────────────────────────────────────
  // 把「插件与内核/依赖对不上」在启动前静态揪出来，而不是等 loader import
  // 时整棵插件树崩掉（实战根因：cordis.patch.yml 引用 dsh-memory 但包缺失
  // → ERR_MODULE_NOT_FOUND → dsh web 退出码 1 连环事故）。只读 manifest 与
  // package.json（绝不执行插件代码）；可自动处置的发现项走「快照 → patch
  // disabled → incident」隔离，与其余 repair 同层：只动配置面与插件层。
  //
  // 检查面：
  //   ENTRY_MODULE_MISSING    patch 行/bundle 引用的插件包或入口文件缺失
  //                           （loader import 必崩）
  //   ENTRY_PEER_UNSATISFIED  peerDependencies 未安装或大版本线不满足
  //   PEER_RANGE_DRIFT        peer 版本仅 pre-release/patch 层面漂移（提示级）
  //   ENTRY_INJECT_MISSING    dsh.client.inject 引用的客户端包缺失（UI 挂点崩）
  //   KERNEL_RANGE_VIOLATION  dsh.kernel 声明的版本窗口与内核不匹配（新契约）
  // 隔离边界：@deepseek-ai/* 内核同源包不自动隔离（缺失=安装损坏，走回滚/重装）。
  const COMPAT_MAX_FINDINGS = 40;
  const COMPAT_CORE_PREFIXES = ['@deepseek-ai/'];

  interface PatchEntryRow {
    id: string | null;
    name: string | null;
    disabled: boolean;
    inInsert: boolean;
    fromBundle: boolean;
  }

  function patchEntryRows(dir: string): PatchEntryRow[] {
    const out: PatchEntryRow[] = [];
    const file = path.join(dir, 'cordis.patch.yml');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return out;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const m = /^([ \t]*)- id:\s*([A-Za-z0-9_.-]+)\s*$/.exec(line);
      if (!m) continue;
      const indent = m[1]!.length;
      const entry: PatchEntryRow = { id: m[2]!, name: null, disabled: false, inInsert: indent > 0, fromBundle: false };
      for (let j = i + 1; j < lines.length; j++) {
        const l2 = lines[j];
        if (!l2) break;
        const m2 = /^([ \t]*)(.*)$/.exec(l2);
        if (!m2) break;
        const ws = m2[1] ?? '';
        const rest = m2[2] ?? '';
        if (!rest || ws.length <= indent) break; // 兄弟条目 / 外层结构：块结束
        const nm = /^name:\s*['"]?([^'"\s]+)['"]?\s*(?:#.*)?$/.exec(rest);
        if (nm) entry.name = nm[1]!;
        const dm = /^disabled:\s*(true|false)\b/.exec(rest);
        if (dm) entry.disabled = dm[1] === 'true';
      }
      out.push(entry);
    }
    // bundle 聚合（profile package.json dsh.profile.bundles）：bundle 包自身
    // 缺失同样会拖垮启动 → 并入条目集做存在性检查。
    const manifest = readJson(path.join(dir, 'package.json'), {});
    const bundles: string[] = (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)) ? manifest.dsh.profile.bundles : [];
    for (const name of bundles) {
      if (out.some((e) => e.name === name || e.id === name)) continue;
      out.push({ id: null, name, disabled: false, inInsert: false, fromBundle: true });
    }
    return out;
  }

  // 包目录查找：profile node_modules → 共享 junction 层 → 安装闭包 node_modules。
  function resolvePkgDir(dir: string, name: string): string | null {
    const roots = [path.join(dir, 'node_modules'), path.join(home(), 'profiles', 'node_modules')];
    const closure = expectedClosureRoot();
    if (closure) roots.push(closure); // expectedClosureRoot 即 node_modules 根
    for (const root of roots) {
      const p = path.join(root, ...String(name).split('/'));
      try {
        if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'package.json'))) return p;
      } catch { /* 顺着找 */ }
    }
    return null;
  }

  // 入口解析：exports['.'] → main → index.js（对齐 ESM loader 行为）。
  function resolveEntryPoint(pkgDir: string, pkg: Record<string, unknown> | null): string | null {
    const candidates: string[] = [];
    const dot = pkg && pkg.exports && typeof pkg.exports === 'object' ? (pkg.exports as Record<string, unknown>)['.'] : null;
    if (typeof dot === 'string') candidates.push(dot);
    else if (dot && typeof dot === 'object') {
      const ex = dot as Record<string, unknown>;
      if (typeof ex.import === 'string') candidates.push(ex.import);
      if (typeof ex.default === 'string') candidates.push(ex.default);
      if (typeof ex.require === 'string') candidates.push(ex.require);
    }
    if (pkg && typeof pkg.main === 'string') candidates.push(pkg.main);
    candidates.push('index.js');
    for (const c of candidates) {
      const p = path.join(pkgDir, c);
      try {
        if (fs.statSync(p).isFile()) return p;
        if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'index.js'))) return path.join(p, 'index.js');
      } catch { /* 下一个候选 */ }
    }
    return null;
  }

  // 依赖实际版本查找（peers 对照）：profile → 共享层 → 闭包。
  function resolveDepVersion(dir: string, dep: string): string | null {
    const roots = [path.join(dir, 'node_modules'), path.join(home(), 'profiles', 'node_modules')];
    const closure = expectedClosureRoot();
    if (closure) roots.push(closure);
    for (const root of roots) {
      const pkg = readJson(path.join(root, ...String(dep).split('/'), 'package.json'), null);
      if (pkg && pkg.version) return pkg.version;
    }
    return null;
  }

  // 内核版本：从安装闭包 @deepseek-ai/dsh 读（expectedClosureRoot 即闭包
  // node_modules 根；dshBin 已区分内置/overlay）。
  function kernelVersion(): string | null {
    const closure = expectedClosureRoot();
    if (!closure) return null;
    const pkg = readJson(path.join(closure, '@deepseek-ai', 'dsh', 'package.json'), null);
    return (pkg && pkg.version) || null;
  }

  // peer 版本务实比对：dsh 生态在 rc/alpha 时代普遍用 `*`、^0.1.0-rc.x 声明
  // 兼容范围，而内核实际版本常带 -alpha/-rc tag —— 严格 semver（prerelease
  // 版本只匹配显式含同族 prerelease 的 range）会把全部兼容插件误报为不兼容。
  // 策略：先严格比对；失败则剥掉全部 prerelease tag 宽松比对；仍失败且
  // 主次版本线（major.minor）不一致 → 真不兼容（'high'，可隔离）；仅
  // prerelease/patch 层面差 → 'low'（提示级，不隔离）。semver 不可用时
  // 全部落 'low'，绝不误判。
  function peerCheck(got: string, want: string): 'ok' | 'low' | 'high' {
    if (semverLib) {
      try { if (semverLib.satisfies(got, want)) return 'ok'; } catch { /* 落宽松 */ }
    }
    const strip = (r: string) => String(r).replace(/-[0-9A-Za-z.-]+/g, '').trim();
    try {
      const w2 = strip(want);
      const g2 = strip(got);
      if (!w2 || w2 === '*' || w2 === 'x') return 'ok'; // 任意版本
      if (!semverLib) return 'low'; // semver 不可用 → 提示级
      if (!semverLib.validRange(w2)) return 'low'; // range 无法解析 → 提示级
      if (semverLib.satisfies(g2, w2)) return 'ok'; // 剥 tag 后满足 → 生态兼容
      // 宽松仍不满足 → 区分真不兼容（主次版本线不符）与补丁/预发布漂移
      const wMin = semverLib.minVersion(w2);
      const gv = semverLib.coerce(g2);
      if (wMin && gv && (wMin.major !== gv.major || wMin.minor !== gv.minor)) return 'high';
      return 'low';
    } catch {
      return 'low';
    }
  }

  // dsh.kernel 契约：semver range 字符串或 { min, max }；不满足返回说明，否则 null。
  function kernelWindowCheck(pkg: Record<string, unknown> | null, kernel: string | null): string | null {
    const w = pkg && pkg.dsh ? (pkg.dsh as Record<string, unknown>).kernel : null;
    if (!w || w === true) return null; // 未声明 / true = 只要求运行在 dsh 内核上
    if (!semverLib) return null;
    try {
      if (typeof w === 'string') {
        if (!kernel || !semverLib.validRange(w)) return null;
        return semverLib.satisfies(kernel, w) ? null : `要求 ${w}，当前 ${kernel || '未知'}`;
      }
      if (w && typeof w === 'object') {
        const k = kernel || '0.0.0';
        const wo = w as Record<string, unknown>;
        if (typeof wo.min === 'string' && !semverLib.satisfies(k, '>=' + wo.min)) return `要求 >=${wo.min}，当前 ${kernel || '未知'}`;
        if (typeof wo.max === 'string' && !semverLib.satisfies(k, '<=' + wo.max)) return `要求 <=${wo.max}，当前 ${kernel || '未知'}`;
      }
    } catch { /* 声明不可解析 → 不拦 */ }
    return null;
  }

  function compatFindings(dir: string): Finding[] {
    const out: Finding[] = [];
    const kernel = kernelVersion();
    for (const entry of patchEntryRows(dir)) {
      if (out.length >= COMPAT_MAX_FINDINGS) break;
      const name = entry.name || entry.id;
      if (!name) continue;
      const pkgDir = resolvePkgDir(dir, name);
      if (!pkgDir) {
        if (!entry.disabled) {
          out.push({
            code: 'ENTRY_MODULE_MISSING', severity: 'high', fixable: true,
            entry: { id: entry.id, name, fromBundle: entry.fromBundle },
            message: `${entry.fromBundle ? 'bundle' : 'patch 行'} ${entry.id || name}（${name}）引用的插件包不存在（loader import 必崩）`,
          });
        }
        continue;
      }
      const pkg = readJson(path.join(pkgDir, 'package.json'), null) as Record<string, unknown> | null;
      if (!entry.disabled && pkg && !resolveEntryPoint(pkgDir, pkg)) {
        out.push({
          code: 'ENTRY_MODULE_MISSING', severity: 'high', fixable: true,
          entry: { id: entry.id, name },
          message: `${entry.id || name}（${name}）的入口文件缺失（main/exports 均不可解析）: ${path.relative(dir, pkgDir)}`,
        });
      }
      if (!entry.disabled && pkg && pkg.peerDependencies) {
        const optional = pkg.peerDependenciesMeta && typeof pkg.peerDependenciesMeta === 'object' ? pkg.peerDependenciesMeta as Record<string, Record<string, unknown>> : {};
        const peers = pkg.peerDependencies as Record<string, unknown>;
        let n = 0;
        for (const dep of Object.keys(peers)) {
          if (n >= 4 || out.length >= COMPAT_MAX_FINDINGS) break;
          if (optional[dep] && optional[dep].optional === true) continue; // 可选 peer：不拦
          const want = String(peers[dep]);
          const got = resolveDepVersion(dir, dep);
          if (!got) {
            n += 1;
            out.push({
              code: 'ENTRY_PEER_UNSATISFIED', severity: 'high', fixable: true,
              entry: { id: entry.id, name },
              message: `${entry.id || name}（${name}）的运行时依赖 ${dep}（要求 ${want}）未安装`,
            });
            continue;
          }
          const verdict = peerCheck(got, want);
          if (verdict === 'high') {
            n += 1;
            out.push({
              code: 'ENTRY_PEER_UNSATISFIED', severity: 'high', fixable: true,
              entry: { id: entry.id, name },
              message: `${entry.id || name}（${name}）的运行时依赖不兼容：${dep} 要求 ${want}，实际 ${got}`,
            });
          } else if (verdict === 'low') {
            n += 1;
            out.push({
              code: 'PEER_RANGE_DRIFT', severity: 'low', fixable: false,
              entry: { id: entry.id, name },
              message: `${entry.id || name}（${name}）依赖 ${dep} 版本漂移：要求 ${want}，实际 ${got}（预发布/补丁级差异，仅提示）`,
            });
          }
        }
      }
      // dsh.client.inject 客户端包缺失 → web UI 挂点崩（只报告，自动隔离无意义）。
      // 裸名依赖是内核的别名机制（如 slots → @deepseek-ai/dsh-client-ui-slots），
      // 只有含 @scope/ 或裸包名的完整引用才做存在性检查。
      if (!entry.disabled && pkg && pkg.dsh) {
        const dshMeta = pkg.dsh as Record<string, unknown>;
        const inject = dshMeta.client && typeof dshMeta.client === 'object' ? (dshMeta.client as Record<string, unknown>).inject : null;
        if (Array.isArray(inject)) {
          let n = 0;
          for (const dep of inject as string[]) {
            if (n >= 3 || out.length >= COMPAT_MAX_FINDINGS) break;
            if (!String(dep).includes('/') && !String(dep).startsWith('@')) continue; // 别名引用：交给内核解析
            if (!resolvePkgDir(dir, dep)) {
              n += 1;
              out.push({
                code: 'ENTRY_INJECT_MISSING', severity: 'medium', fixable: false,
                entry: { id: entry.id, name },
                message: `${entry.id || name}（${name}）注入的客户端包 ${dep} 不存在（UI 挂点缺失）`,
              });
            }
          }
        }
      }
      // 内核版本窗口（dsh.kernel 新契约）。
      const badWindow = !entry.disabled && pkg ? kernelWindowCheck(pkg, kernel) : null;
      if (badWindow) {
        out.push({
          code: 'KERNEL_RANGE_VIOLATION', severity: 'medium', fixable: true,
          entry: { id: entry.id, name },
          message: `${entry.id || name}（${name}）声明与内核版本不兼容：${badWindow}`,
        });
      }
    }
    return out;
  }

  // 隔离执行器：快照先行 → patch disabled（togglePluginInPatch，防 loader
  // 双登记）→ 原子写 → incident 留痕。@deepseek-ai/* 同源内核包跳过。
  function quarantineEligible(findings: Finding[] | null | undefined, dirP?: string): string[] {
    const unique: Array<{ id: string | null; name: string | null; message: string }> = [];
    for (const f of findings || []) {
      if (!f || !f.entry) continue;
      const { id, name } = f.entry;
      const key = id || name;
      if (!key || unique.some((u) => (u.id || u.name) === key)) continue;
      if (name && COMPAT_CORE_PREFIXES.some((p) => String(name).startsWith(p))) continue;
      unique.push({ id, name, message: f.message });
    }
    if (!unique.length) return [];
    const dir = dirP || profileDir();
    const snap = snapshot('隔离不兼容插件: ' + unique.map((u) => u.id || u.name).join(','));
    const file = path.join(dir, 'cordis.patch.yml');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    if (!text.trim()) return [];
    const applied: string[] = [];
    for (const u of unique) {
      if (!u.id) continue; // bundle 行无 id 无法 toggle → 仅报告
      try {
        const patched = togglePluginInPatch(text, u.id, false, u.name || u.id);
        if (patched === text) continue; // 已是 disabled
        text = patched;
        applied.push(`隔离 ${u.id}（${u.name || u.id}：${u.message}）`);
      } catch (err) {
        log('guard', `隔离 ${u.id} 失败: ${(err as Error).message}`);
      }
    }
    if (applied.length) {
      try {
        writeFileAtomic(file, text);
        reportIncident('compat 自动隔离', `启动前版本兼容体检发现并隔离 ${applied.length} 个不兼容插件：\n\n${applied.join('\n')}${snap ? `\n\n已先创建快照 ${snap.id}（插件保护中心可随时回滚）` : ''}`);
        log('guard', '版本兼容体检自动隔离: ' + applied.join('；'));
      } catch (err) {
        log('guard', '写隔离配置失败: ' + (err as Error).message);
      }
    }
    return applied;
  }

  // 启动前预检：ENTRY_MODULE_MISSING 必然拖垮启动，无条件隔离；
  // ENTRY_PEER_UNSATISFIED 默认也隔离（quarantinePeers=false 关闭）。
  function quarantineFatal(opts?: { quarantinePeers?: boolean }): { checked: number; quarantined: string[] } {
    const findings = compatFindings(profileDir());
    const eligible = findings.filter((f) => f.code === 'ENTRY_MODULE_MISSING' || (opts && opts.quarantinePeers !== false && f.code === 'ENTRY_PEER_UNSATISFIED'));
    const applied = quarantineEligible(eligible, undefined);
    return { checked: findings.length, quarantined: applied };
  }

  // 手动隔离（UI/IPC）：按 patch 行 id 禁入指定插件。
  function quarantineById(id: string): { ok: boolean; error?: string; snapshot?: string | null; alreadyDisabled?: boolean; restartRequired?: boolean } {
    const dir = profileDir();
    const row = patchEntryRows(dir).find((e) => e.id === id);
    if (!row) return { ok: false, error: 'patch 行不存在: ' + String(id) };
    if (row.name && COMPAT_CORE_PREFIXES.some((p) => String(row.name).startsWith(p))) {
      return { ok: false, error: '内核同源插件不建议隔离（缺失时应走回滚/重装）: ' + id };
    }
    const snap = snapshot('手动隔离插件: ' + id);
    const file = path.join(dir, 'cordis.patch.yml');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch { /* 空 */ }
    if (!text) return { ok: false, error: 'patch 文件不可读' };
    let patched: string;
    try {
      patched = togglePluginInPatch(text, id, false, row.name || id);
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
    if (patched === text) return { ok: true, alreadyDisabled: true };
    try {
      writeFileAtomic(file, patched);
      reportIncident('compat 手动隔离', `手动隔离插件 ${id}（${row.name || id}）${snap ? `，快照 ${snap.id}` : ''}`);
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
    return { ok: true, snapshot: snap ? snap.id : null, restartRequired: true };
  }

  // 完整版本兼容报告（UI 展示）：内核版本 + 每条 patch 条目的安装/入口/peer/
  // inject/版本窗口状态。
  function versionReport(): CompatReport {
    const dir = profileDir();
    const kernel: CompatReport['kernel'] = { name: '@deepseek-ai/dsh', version: kernelVersion() };
    const entries: CompatRow[] = [];
    for (const entry of patchEntryRows(dir)) {
      const name = entry.name || entry.id;
      const row: CompatRow = {
        id: entry.id, name, enabled: !entry.disabled, fromBundle: entry.fromBundle,
        installed: false, version: null, entryPoint: null, kernelWindow: null,
        peers: [], inject: [], issues: [],
      };
      const pkgDir = name ? resolvePkgDir(dir, name) : null;
      const pkg = pkgDir ? readJson(path.join(pkgDir, 'package.json'), null) as Record<string, unknown> | null : null;
      if (pkgDir && pkg) {
        row.installed = true;
        row.version = typeof pkg.version === 'string' ? pkg.version : null;
        row.entryPoint = resolveEntryPoint(pkgDir, pkg);
        row.kernelWindow = pkg.dsh && typeof pkg.dsh === 'object' ? String((pkg.dsh as Record<string, unknown>).kernel || '') || null : null;
        if (pkg.peerDependencies) {
          const optional = pkg.peerDependenciesMeta && typeof pkg.peerDependenciesMeta === 'object' ? pkg.peerDependenciesMeta as Record<string, Record<string, unknown>> : {};
          const peers = pkg.peerDependencies as Record<string, unknown>;
          for (const dep of Object.keys(peers)) {
            const want = String(peers[dep]);
            const got = resolveDepVersion(dir, dep);
            const optionalFlag = !!(optional[dep] && optional[dep].optional === true);
            let verdict: CompatPeer['verdict'] = got ? peerCheck(got, want) : 'missing';
            if (optionalFlag) verdict = 'optional'; // 可选 peer：缺失/漂移都不算问题
            row.peers.push({ dep, required: want, actual: got, verdict, ok: verdict === 'ok' || verdict === 'optional', optional: optionalFlag });
          }
        }
        if (pkg.dsh) {
          const dshMeta = pkg.dsh as Record<string, unknown>;
          const inject = dshMeta.client && typeof dshMeta.client === 'object' ? (dshMeta.client as Record<string, unknown>).inject : null;
          if (Array.isArray(inject)) {
            for (const dep of inject as string[]) {
              if (!String(dep).includes('/') && !String(dep).startsWith('@')) {
                row.inject.push({ dep, ok: true, alias: true }); // 内核别名机制
                continue;
              }
              row.inject.push({ dep, ok: !!resolvePkgDir(dir, dep) });
            }
          }
        }
        const bw = kernelWindowCheck(pkg, kernel.version);
        if (bw) row.issues.push(bw);
      }
      entries.push(row);
    }
    return { at: new Date().toISOString(), profile: getProfile(), kernel, entries };
  }

  // ── 修复执行器（只动插件/配置层）────────────────────────────────────
  function repair(findings?: Finding[]): { applied: string[] } {
    const applied: string[] = [];
    const list = Array.isArray(findings) ? findings : (healthCheck().findings);
    const dir = profileDir();

    if (list.some((f) => f.code === 'SHADOW_COPY' || f.code === 'SHADOW_LINK')) {
      try {
        const removed = healProfileModuleShadowing(home(), getProfile(), (m) => log('guard', m));
        if (removed.length) applied.push('清理模块遮蔽: ' + removed.join(', '));
      } catch (err) {
        log('guard', '清理模块遮蔽失败: ' + (err as Error).message);
      }
    }

    if (list.some((f) => f.code === 'PATCH_DUP_ID' || f.code === 'PATCH_SOUL_CONFIG')) {
      try {
        const file = path.join(dir, 'cordis.patch.yml');
        let patch = fs.readFileSync(file, 'utf8');
        const healed = healSoulMdPatchRow(patch);
        if (healed.healed.length) { patch = healed.patch; applied.push('补写 soul-md 行 config.path'); }
        const ids: Record<string, unknown> = {};
        for (const id of patchRowIds(patch)) ids[id] = ids[id] || null;
        let bundled: unknown[] = [];
        try { bundled = readJson(path.join(dir, 'package.json'))?.dsh?.profile?.bundles || []; } catch { bundled = []; }
        const declaredBundleIds = collectBundleEntryIds(bundled, path.join(dir, 'node_modules'));
        const { patch: deduped, removed } = removeBundledRowDuplicates(patch, ids, bundled, declaredBundleIds);
        if (removed.length) {
          patch = deduped;
          applied.push('移除与 bundle 重复的 patch 行: ' + removed.join(', '));
        }
        // cordis.patch.yml 是启动关键文件：裸写中断即截断 → boot 死循环。
        if (healed.healed.length || removed.length) writeFileAtomic(file, patch);
      } catch (err) {
        log('guard', '修复 patch 行失败: ' + (err as Error).message);
      }
    }

    if (list.some((f) => f.code === 'JUNCTION_FOREIGN' || f.code === 'JUNCTION_DANGLING')) {
      const result = repairJunctions();
      if (result.repaired.length) applied.push('恢复共享模块指向: ' + result.repaired.slice(0, 5).join(', ') + (result.repaired.length > 5 ? ` 等 ${result.repaired.length} 个` : ''));
    }

    // 版本兼容防线：模块缺失 / peer 不满足 / 内核窗口违例 → 自动隔离
    //（快照 + patch disabled + incident）。
    if (list.some((f) => f.code === 'ENTRY_MODULE_MISSING' || f.code === 'ENTRY_PEER_UNSATISFIED' || f.code === 'KERNEL_RANGE_VIOLATION')) {
      const zapped = quarantineEligible(list, dir);
      applied.push(...zapped);
    }

    return { applied };
  }

  // 把被外部 dsh 实例改指向的共享 junction 重新指回本客户端的安装闭包。
  // 这是「与原生 dsh 冲突」的根治面：dsh-app-boot 每次启动都会把
  // <home>/profiles/node_modules 的 junction 指向「自己」的闭包 —— 原生 CLI
  // 一跑，桌面的模块解析就被换血（版本错位 / npx 缓存被清后悬空）。
  // 这里以 dshBin() 推导闭包根，逐个纠正指向；闭包里不存在的名字（原生
  // 新版才有的包）保留原样并报告。
  function repairJunctions(): { repaired: string[]; unknown: string[]; pruned: string[] } {
    const repaired: string[] = [];
    const unknown: string[] = [];
    const pruned: string[] = [];
    try {
      const fallbackDir = path.join(home(), 'profiles', 'node_modules');
      const expected = expectedClosureRoot();
      if (!expected || !fs.existsSync(fallbackDir)) return { repaired, unknown, pruned };
      fs.mkdirSync(fallbackDir, { recursive: true });
      const expRoot = safeRealpath(expected) || expected;
      const norm = (p: string) => String(p).replace(/\//g, '\\').toLowerCase();
      for (const { full, rel } of fallbackPackages(fallbackDir)) {
        const link = path.join(fallbackDir, rel);
        let st;
        try { st = fs.lstatSync(link); } catch { continue; }
        // 只处理链接；真实目录是历史损坏形态，交给人处理。
        if (!st.isSymbolicLink()) continue;
        const target = safeReadlink(link);
        if (!target) continue;
        const real = safeRealpath(link) || target;
        const good = norm(real).startsWith(norm(expRoot)) && fs.existsSync(real);
        if (good) continue;
        const want = path.join(expRoot, rel);
        if (!fs.existsSync(path.join(want, 'package.json'))) {
          // 闭包里没有这个名字:目标还活着（原生新版 CLI 才有的包）→ 保留原
          // 指向；目标已死（升级/卸载遗留的悬空链，如 0.1.2 升级后残留的
          // 104 条指向已卸载 Electron 目录的死链 —— 内核 heal 只增链不清理，
          // 永不可能自愈）→ 剪除。悬空链对任何一方都不可解析，只会让模块
          // 解析反复撞 ENOENT。
          if (!fs.existsSync(real)) {
            try {
              removeLink(link);
              pruned.push(full);
            } catch (err) {
              log('guard', `剪除悬空共享模块 ${full} 失败: ` + (err as Error).message);
            }
          } else {
            unknown.push(full);
          }
          continue;
        }
        try {
          removeLink(link);
          fs.symlinkSync(want, link, 'junction');
          repaired.push(full);
        } catch (err) {
          log('guard', `恢复 junction ${full} 失败: ` + (err as Error).message);
        }
      }
      if (repaired.length) {
        log('guard', '已把 ' + repaired.length + ' 个共享模块指回客户端闭包');
      }
      if (pruned.length) {
        log('guard', '已剪除 ' + pruned.length + ' 条悬空共享模块死链（目标已不存在）');
      }
      if (unknown.length) {
        log('guard', '闭包中不存在的共享模块（保留原指向）: ' + unknown.slice(0, 10).join(', '));
      }
    } catch (err) {
      log('guard', 'junction 归属修复失败: ' + (err as Error).message);
    }
    return { repaired, unknown, pruned };
  }

  // ── 事故报告（plugin-guard 的 incident）──────────────────────────────
  function reportIncident(title: string, detail: string): { ok: boolean; file?: string; error?: string } {
    try {
      fs.mkdirSync(incidentsDir(), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = String(title || 'incident').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const file = path.join(incidentsDir(), stamp + '-' + slug + '.md');
      const body = [
        '# ' + (title || '事故报告'),
        '',
        '- 时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
        '- profile：' + getProfile(),
        '- 客户端快照保留：' + listSnapshots().length + ' 份',
        '',
        '## 详情',
        '',
        '```',
        String(detail || '').slice(0, 20000),
        '```',
        '',
      ].join('\n');
      writeFileAtomic(file, body);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: String(((err as Error) && (err as Error).message) || err) };
    }
  }

  function listIncidents(): { id: string; title: string }[] {
    try {
      const dir = incidentsDir();
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md') && !f.endsWith('.resolved.md'))
        .sort()
        .reverse()
        .map((f) => ({ id: f, title: f.replace(/\.md$/, '') }));
    } catch {
      return [];
    }
  }

  function readIncident(id: string): { ok: boolean; content?: string; error?: string } {
    try {
      if (!/^[\w.-]+\.md$/.test(String(id || ''))) return { ok: false, error: 'bad id' };
      const file = path.join(incidentsDir(), id);
      if (!fs.existsSync(file)) return { ok: false, error: 'not found' };
      return { ok: true, content: fs.readFileSync(file, 'utf8').slice(0, 30000) };
    } catch (err) {
      return { ok: false, error: String(((err as Error) && (err as Error).message) || err) };
    }
  }

  function resolveIncident(id: string): { ok: boolean; error?: string } {
    try {
      if (!/^[\w.-]+\.md$/.test(String(id || ''))) return { ok: false, error: 'bad id' };
      const file = path.join(incidentsDir(), id);
      if (!fs.existsSync(file)) return { ok: false, error: 'not found' };
      fs.renameSync(file, file + '.resolved.md');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(((err as Error) && (err as Error).message) || err) };
    }
  }

  // ── 启动失败归因（V4.2）────────────────────────────────────────────
  // 把启动报错文案里的包名/行 id 对应到 profile 里「可停用的插件」：
  //   · 命中 patch 行 id/name → 返回 { name, kind: 'patchRow', rowId }
  //   · 命中 bundles / dependencies 键 → 返回 { name, kind, rowId: null }
  // 归因失败（报错不含可识别包名）返回 null —— 调用方退回通用按钮。
  // 只读 profile 配置面，绝不执行插件代码。
  function attributeBootFailure(errText: string): BootAttribution | null {
    try {
      const text = String(errText || '');
      if (!text) return null;
      const dir = profileDir();
      const candidates: string[] = [];
      const push = (raw: string | null | undefined) => {
        const k = String(raw || '').replace(/['",.;:]+$/g, '');
        if (k && /^@?[A-Za-z0-9][A-Za-z0-9._@/+-]*$/.test(k) && !candidates.includes(k)) candidates.push(k);
      };
      const patterns: RegExp[] = [
        /duplicate (?:loader )?entry[^\n]*?['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?/gi,
        /already registered[^\n]*?['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?/gi,
        /cannot find module\s+['"]([^'"]+)['"]/gi,
        /failed to (?:load|apply|initialize|resolve)\s+(?:plugin|entry|bundle)[^\n]*?['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?/gi,
        /(?:plugin|entry|bundle)\s+['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?\s+(?:failed|not found|unavailable|rejected)/gi,
      ];
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) push(m[1]);
      }
      if (candidates.length === 0) return null;

      const manifest = readJson(path.join(dir, 'package.json'), {});
      const bundles = (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)) ? manifest.dsh.profile.bundles : [];
      const depKeys = Object.keys(manifest.dependencies || {});
      // patch 行（顶层 + insert 内层）→ { id, name }
      let patchText = '';
      try { patchText = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'); } catch {}
      const rows: { id: string; name: string | null }[] = [];
      if (patchText) {
        const lines = patchText.split(/\r?\n/);
        let pendingId: string | null = null;
        for (const line of lines) {
          const idm = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(line);
          if (idm !== null) {
            if (pendingId !== null) rows.push({ id: pendingId, name: null });
            pendingId = idm[1]!;
            continue;
          }
          const nm = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
          if (nm !== null && pendingId !== null) {
            rows.push({ id: pendingId, name: nm[1]! });
            pendingId = null;
            continue;
          }
          if (pendingId !== null && /^\s*-\s*insert:/.test(line)) {
            rows.push({ id: pendingId, name: null });
            pendingId = null;
          }
        }
        if (pendingId !== null) rows.push({ id: pendingId, name: null });
      }

      for (const cand of candidates) {
        const row = rows.find((r) => r.id === cand || r.name === cand);
        if (row) return { name: row.name || row.id, kind: 'patchRow', rowId: row.id };
        if (bundles.includes(cand)) return { name: cand, kind: 'bundle', rowId: null };
        if (depKeys.includes(cand)) return { name: cand, kind: 'dependency', rowId: null };
      }
      return null;
    } catch {
      return null;
    }
  }

  function safeReadlink(p: string): string | null {
    try { return fs.readlinkSync(p); } catch { return null; }
  }

  // Windows 上 rmSync(force) 对 junction 会抛 ERR_FS_EISDIR —— 删链接必须
  // 走 unlink（只摘链接本身，绝不递归目标）。
  function removeLink(p: string): void {
    try { fs.unlinkSync(p); return; } catch { /* fall through */ }
    fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 });
  }

  function safeRealpath(p: string): string | null {
    try { return fs.realpathSync(p); } catch { return null; }
  }

  return {
    snapshot, listSnapshots, restore, markGood, lastGoodSnapshot,
    healthCheck, repair, repairJunctions, junctionFindings,
    reportIncident, listIncidents, readIncident, resolveIncident,
    attributeBootFailure,
    // 版本兼容防线（v0.2）
    compatFindings, versionReport, quarantineFatal, quarantineById,
  };
}

export = { createGuard };
