/**
 * lib/plugin-guard/scan.ts — 静态体检查域（Task 6.3 自 plugin-guard.js 提取）。
 *
 * 只做 readFileSync + 正则，**绝不 require/执行插件代码**。四类检查：
 *   · shadowFindings   profile node_modules 里遮蔽安装闭包 junction 的拷贝
 *                      （模块双实例 → Symbol 身份不一致 →「设置命名空间不可用」）；
 *   · patchFindings    patch 行重复 entry id（duplicate loader entry 拖垮整树）、
 *                      soul-md 行缺 config.path（v2.0.0 存量坏行）；
 *   · junctionFindings 共享 junction 被外部 dsh 实例接管 / 悬空（原生共存冲突）；
 *   · trojanFindings   高危静态扫描（木马形态，命中即报告高危级，不自动删除）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  fallbackPackages, normPath, patchRowIds, readJson, safeReadlink, safeRealpath,
  type Finding, type GuardCtx, type HealthReport,
} from './ctx.js';

// ── 静态高危扫描（healthcheck 的 C8 思路）────────────────────────────────
// 模式面向「装完即失控」的常见木马形态，刻意保守以压低误报。
const TROJAN_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'TROJAN_REMOTE_EXEC', re: /(?:child_process|execSync|spawnSync|exec|spawn)\s*\(\s*['"`](?:curl|wget|powershell|cmd|bash|sh)\b[^'"`]*['"`][\s\S]{0,200}(?:\|\s*(?:sh|bash|iex|Invoke-Expression)|-enc\b)/i },
  { code: 'TROJAN_DOWNLOAD_EXEC', re: /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr)\b[\s\S]{0,160}?(?:\|\s*(?:sh|bash|iex|Invoke-Expression)\b|Out-File[\s\S]{0,80}\.(?:ps1|bat|cmd|vbs))/i },
  { code: 'TROJAN_BASE64_EVAL', re: /(?:eval|Function)\s*\(\s*(?:atob|Buffer\.from\([^)]*,\s*['"]base64['"]\)|window\.atob)\s*\(/i },
  { code: 'TROJAN_PERSISTENCE', re: /(?:reg(?:\.exe)?\s+add[\s\S]{0,120}(?:Run|RunOnce)|Startup[\\\\/][\w.-]+\.(?:bat|cmd|ps1|vbs|lnk)|schtasks\s+\/create|Register-ScheduledTask)/i },
  { code: 'TROJAN_EXFIL_ENV', re: /(?:process\.env|os\.env)[\s\S]{0,120}(?:https?:\/\/|fetch\s*\(|XMLHttpRequest|net\.connect|dgram)/i },
];

const SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件扫描上限 2MB
const SCAN_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 单包总扫描上限 32MB
const SCAN_EXTS = /\.(c?js|mjs|cjs|json|yml|yaml|sh|ps1|bat|cmd)$/i;

/** 扫描域 API。 */
export interface ScanDomain {
  healthCheck(): HealthReport;
  junctionFindings(): Finding[];
}

/** 构建扫描域：healthCheck（配置巡检 + 木马静态扫描，含逐文件结论缓存）与 junctionFindings。 */
export function createScanDomain(ctx: GuardCtx): ScanDomain {
  // Task 12.2（spec F2.1）：高危扫描的逐文件结论缓存（随 guard 单例存活）。
  // 键 = 文件绝对路径，命中条件 = (mtimeMs, size) 与上次扫描一致 —— 任何
  // 真实写操作都会推进 mtime，故命中即可安全跳过 readFileSync + 正则（单次
  // healthCheck 文本量上限 32MB，恢复中心/修复流程反复触发放大该成本）。
  // readdir/stat 走树本身不可省：发现新增/删除文件正是巡检目标。容量上限
  // 防御性清空（正常 profile 远达不到）。
  const SCAN_VERDICT_CACHE_MAX = 20_000;
  const verdictCache = new Map<string, { mtimeMs: number; size: number; finding: Finding | null }>();

  /** dshBin() 形如 <closure>/@deepseek-ai/dsh/lib/bin.js → 安装闭包根。 */
  function expectedClosureRoot(): string | null {
    try {
      return path.resolve(ctx.dshBin(), '../../../..');
    } catch {
      return null;
    }
  }

  function shadowFindings(dir: string): Finding[] {
    const out: Finding[] = [];
    try {
      const fallbackDir = path.join(ctx.home(), 'profiles', 'node_modules');
      const modulesDir = path.join(dir, 'node_modules');
      if (!fs.existsSync(fallbackDir) || !fs.existsSync(modulesDir)) return out;
      for (const { full, rel } of fallbackPackages(fallbackDir)) {
        const shadow = path.join(modulesDir, rel);
        let st: fs.Stats;
        try {
          st = fs.lstatSync(shadow);
        } catch {
          continue;
        }
        if (st.isDirectory() && !st.isSymbolicLink()) {
          out.push({ code: 'SHADOW_COPY', severity: 'high', message: `插件依赖把核心包 ${full} 装成了独立拷贝（模块双实例根源）`, fixable: true });
        } else if (st.isSymbolicLink()) {
          const target = safeReadlink(shadow) || '';
          if (normPath(target).includes(normPath(path.join(modulesDir, '.pnpm')))) {
            out.push({ code: 'SHADOW_LINK', severity: 'high', message: `pnpm 把核心包 ${full} 链接进了 profile（模块双实例根源）`, fixable: true });
          }
        }
      }
    } catch {
      /* 枚举失败按无发现处理 */
    }
    return out;
  }

  function junctionFindings(): Finding[] {
    const out: Finding[] = [];
    try {
      const fallbackDir = path.join(ctx.home(), 'profiles', 'node_modules');
      const expected = expectedClosureRoot();
      if (!expected || !fs.existsSync(fallbackDir)) return out;
      for (const full of listFallbackNames(fallbackDir)) {
        const link = path.join(fallbackDir, full);
        let st: fs.Stats;
        try {
          st = fs.lstatSync(link);
        } catch {
          continue;
        }
        if (!st.isSymbolicLink()) continue;
        const target = safeReadlink(link);
        if (!target) continue;
        const real = safeRealpath(link) || target;
        const expRoot = safeRealpath(expected) || expected;
        if (!normPath(real).startsWith(normPath(expRoot))) {
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
    } catch {
      /* 枚举失败按无发现处理 */
    }
    return out;
  }

  /** 枚举 fallback 目录名（含 scope/子级两段形式，供 junction 巡检）。 */
  function listFallbackNames(fallbackDir: string): string[] {
    const names: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(fallbackDir, { withFileTypes: true });
    } catch {
      return names;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink() || entry.isDirectory()) names.push(entry.name);
      else if (entry.isDirectory() === false && entry.name.includes('-')) continue;
      if (entry.isDirectory()) {
        let children: fs.Dirent[];
        try {
          children = fs.readdirSync(path.join(fallbackDir, entry.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          if (child.isSymbolicLink() || child.isDirectory()) names.push(entry.name + '/' + child.name);
        }
      }
    }
    return names;
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
    } catch {
      /* 读不了按无发现处理 */
    }
    return out;
  }

  function trojanFindings(dir: string): Finding[] {
    const out: Finding[] = [];
    try {
      const builtin = new Set<string>(
        (readJson<{ names?: string[] }>(path.join(dir, '.dsh-builtin-plugins.json'), { names: [] }).names || []),
      );
      const modulesDir = path.join(dir, 'node_modules');
      if (!fs.existsSync(modulesDir)) return out;
      let total = 0;
      const walk = (d: string, depth: number): void => {
        if (depth > 4 || total > SCAN_MAX_TOTAL_BYTES || out.length >= 20) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name === '.pnpm' || e.name.startsWith('.')) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            const pkg = readJson<{ name?: string } | null>(path.join(p, 'package.json'), null);
            if (pkg && pkg.name && builtin.has(pkg.name)) continue; // 内置分发包不扫
            walk(p, depth + 1);
          } else if (e.isFile() && SCAN_EXTS.test(e.name)) {
            let st: fs.Stats;
            try {
              st = fs.statSync(p);
            } catch {
              continue;
            }
            if (st.size > SCAN_MAX_FILE_BYTES || total + st.size > SCAN_MAX_TOTAL_BYTES) continue;
            total += st.size;
            // 结论缓存命中：内容身份 (mtimeMs, size) 未变 → 免读免正则。
            const cached = verdictCache.get(p);
            let finding: Finding | null = null;
            if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
              finding = cached.finding;
            } else {
              let text: string;
              try {
                text = fs.readFileSync(p, 'utf8');
              } catch {
                continue;
              }
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
            }
            if (finding) out.push(finding);
          }
        }
      };
      walk(modulesDir, 0);
    } catch {
      /* 扫描失败按无发现处理 */
    }
    return out;
  }

  function healthCheck(): HealthReport {
    const findings: Finding[] = [];
    const dir = ctx.profileDir();
    // C3：模块遮蔽（真实目录或 pnpm 链接）→ 模块双实例 → Symbol 身份不一致。
    findings.push(...shadowFindings(dir));
    // patch 行体检：重复 entry id、soul-md 行缺 config.path。
    findings.push(...patchFindings(dir));
    // junction 归属（原生 dsh 共存冲突）。
    findings.push(...junctionFindings());
    // 高危静态扫描：只扫非内置的第三方包。
    findings.push(...trojanFindings(dir));
    return { at: new Date().toISOString(), profile: ctx.getProfile(), findings };
  }

  return { healthCheck, junctionFindings };
}
