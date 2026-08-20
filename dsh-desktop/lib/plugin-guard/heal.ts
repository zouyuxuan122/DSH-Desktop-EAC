/**
 * lib/plugin-guard/heal.ts — 修复执行器 / 事故报告 / 守护启动 / 启动失败归因
 * （Task 6.3 自 plugin-guard.js 提取）。
 *
 * 修复执行器只动插件/配置层：
 *   · SHADOW_* → 调 profile-module-heal 清理模块遮蔽；
 *   · PATCH_*  → 调 patch-row-heal 补 config.path / 去重 bundle 行；
 *   · JUNCTION_* → repairJunctions 把被外部 dsh 实例改指向的共享 junction
 *     指回本客户端安装闭包（「与原生 dsh 冲突」的根治面）。
 *
 * 守护启动失败链路：体检 → 可修复项修复 → 重试 → 仍有最后良好快照则回滚
 * → 重试 → 事故报告。每层只重试一次，绝不无限循环。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  fallbackPackages, normPath, readJson, removeLink, safeReadlink, safeRealpath,
  type Finding, type GuardCtx,
} from './ctx.js';
import type { ScanDomain } from './scan.js';
import type { SnapshotDomain } from './snapshot.js';

/** 修复域 API。 */
export interface HealDomain {
  repair(findings?: Finding[]): { applied: string[] };
  repairJunctions(): { repaired: string[]; unknown: string[] };
  reportIncident(title: string, detail: string): { ok: boolean; file?: string; error?: string };
  listIncidents(): Array<{ id: string; title: string }>;
  readIncident(id: string): { ok: boolean; content?: string; error?: string };
  resolveIncident(id: string): { ok: boolean; error?: string };
  guardedBoot(startOnce: () => Promise<string>, describeFailure?: () => string, opts?: { preRetry?: (errText: string) => Promise<{ applied?: string[] } | boolean> | { applied?: string[] } | boolean }): Promise<string>;
  setRollbackLift(fn: (() => Promise<string>) | null): void;
  attributeBootFailure(errText: string): { name: string; kind: string; rowId: string | null } | null;
}

/** 构建修复域：修复执行器/junction 修复/事故报告/guardedBoot 链/启动失败归因（语义见文件头）。 */
export function createHealDomain(ctx: GuardCtx, scan: ScanDomain, snap: SnapshotDomain): HealDomain {
  /** dshBin() → 安装闭包根（与 scan.ts 的同名私有函数一致）。 */
  function expectedClosureRoot(): string | null {
    try {
      return path.resolve(ctx.dshBin(), '../../../..');
    } catch {
      return null;
    }
  }

  // ── 修复执行器（只动插件/配置层）────────────────────────────────────
  function repair(findings?: Finding[]): { applied: string[] } {
    const applied: string[] = [];
    const list = Array.isArray(findings) ? findings : scan.healthCheck().findings;
    const dir = ctx.profileDir();

    if (list.some((f) => f.code === 'SHADOW_COPY' || f.code === 'SHADOW_LINK')) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { healProfileModuleShadowing } = require('../../profile-module-heal.js') as typeof import('../../profile-module-heal.js');
        const removed = healProfileModuleShadowing(ctx.home(), ctx.getProfile(), (m: string) => ctx.log('guard', m));
        if (removed.length) applied.push('清理模块遮蔽: ' + removed.join(', '));
      } catch (err) {
        ctx.log('guard', '清理模块遮蔽失败: ' + String((err as Error).message));
      }
    }

    if (list.some((f) => f.code === 'PATCH_DUP_ID' || f.code === 'PATCH_SOUL_CONFIG')) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { healSoulMdPatchRow, removeBundledRowDuplicates } = require('../../patch-row-heal.js') as typeof import('../../patch-row-heal.js');
        const file = path.join(dir, 'cordis.patch.yml');
        let patch = fs.readFileSync(file, 'utf8');
        const healed = healSoulMdPatchRow(patch);
        if (healed.healed.length) {
          patch = healed.patch;
          applied.push('补写 soul-md 行 config.path');
        }
        const ids: Record<string, string> = {};
        for (const id of readRowIds(patch)) ids[id] = id;
        let bundled: string[] = [];
        try {
          bundled = (readJson<{ dsh?: { profile?: { bundles?: string[] } } }>(path.join(dir, 'package.json'), {}).dsh?.profile?.bundles) || [];
        } catch {
          bundled = [];
        }
        const { patch: deduped, removed } = removeBundledRowDuplicates(patch, ids, bundled, new Set());
        if (removed.length) {
          patch = deduped;
          applied.push('移除与 bundle 重复的 patch 行: ' + removed.join(', '));
        }
        if (healed.healed.length || removed.length) fs.writeFileSync(file, patch);
      } catch (err) {
        ctx.log('guard', '修复 patch 行失败: ' + String((err as Error).message));
      }
    }

    if (list.some((f) => f.code === 'JUNCTION_FOREIGN' || f.code === 'JUNCTION_DANGLING')) {
      const result = repairJunctions();
      if (result.repaired.length) {
        applied.push('恢复共享模块指向: ' + result.repaired.slice(0, 5).join(', ') + (result.repaired.length > 5 ? ` 等 ${result.repaired.length} 个` : ''));
      }
    }

    return { applied };
  }

  /** 从 patch 文本提取行 id（heal 内部用；与 ctx.patchRowIds 等价）。 */
  function readRowIds(patch: string): string[] {
    const ids: string[] = [];
    const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(patch || ''))) !== null) {
      if (m[1] !== undefined) ids.push(m[1]);
    }
    return ids;
  }

  // 把被外部 dsh 实例改指向的共享 junction 重新指回本客户端的安装闭包。
  // dsh-app-boot 每次启动都会把 <home>/profiles/node_modules 的 junction 指向
  // 「自己」的闭包 —— 原生 CLI 一跑，桌面的模块解析就被换血（版本错位 /
  // npx 缓存被清后悬空）。这里以 dshBin() 推导闭包根，逐个纠正指向；
  // 闭包里不存在的名字（原生新版才有的包）保留原样并报告。
  function repairJunctions(): { repaired: string[]; unknown: string[] } {
    const repaired: string[] = [];
    const unknown: string[] = [];
    try {
      const fallbackDir = path.join(ctx.home(), 'profiles', 'node_modules');
      const expected = expectedClosureRoot();
      if (!expected || !fs.existsSync(fallbackDir)) return { repaired, unknown };
      fs.mkdirSync(fallbackDir, { recursive: true });
      const expRoot = safeRealpath(expected) || expected;
      for (const { full, rel } of fallbackPackages(fallbackDir)) {
        const link = path.join(fallbackDir, rel);
        let st: fs.Stats;
        try {
          st = fs.lstatSync(link);
        } catch {
          continue;
        }
        // 只处理链接；真实目录是历史损坏形态，交给人处理。
        if (!st.isSymbolicLink()) continue;
        const target = safeReadlink(link);
        if (!target) continue;
        const real = safeRealpath(link) || target;
        const good = normPath(real).startsWith(normPath(expRoot)) && fs.existsSync(real);
        if (good) continue;
        const want = path.join(expRoot, rel);
        if (!fs.existsSync(path.join(want, 'package.json'))) {
          unknown.push(full);
          continue;
        }
        try {
          removeLink(link);
          fs.symlinkSync(want, link, 'junction');
          repaired.push(full);
        } catch (err) {
          ctx.log('guard', `恢复 junction ${full} 失败: ` + String((err as Error).message));
        }
      }
      if (repaired.length) {
        ctx.log('guard', '已把 ' + repaired.length + ' 个共享模块指回客户端闭包');
      }
      if (unknown.length) {
        ctx.log('guard', '闭包中不存在的共享模块（保留原指向）: ' + unknown.slice(0, 10).join(', '));
      }
    } catch (err) {
      ctx.log('guard', 'junction 归属修复失败: ' + String((err as Error).message));
    }
    return { repaired, unknown };
  }

  // ── 事故报告（incident）─────────────────────────────────────────────
  function reportIncident(title: string, detail: string): { ok: boolean; file?: string; error?: string } {
    try {
      fs.mkdirSync(ctx.incidentsDir(), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = String(title || 'incident').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const file = path.join(ctx.incidentsDir(), stamp + '-' + slug + '.md');
      const body = [
        '# ' + (title || '事故报告'),
        '',
        '- 时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
        '- profile：' + ctx.getProfile(),
        '- 客户端快照保留：' + snap.listSnapshots().length + ' 份',
        '',
        '## 详情',
        '',
        '```',
        String(detail || '').slice(0, 20000),
        '```',
        '',
      ].join('\n');
      fs.writeFileSync(file, body);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: String((err as Error).message || err) };
    }
  }

  function listIncidents(): Array<{ id: string; title: string }> {
    try {
      const dir = ctx.incidentsDir();
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
      const file = path.join(ctx.incidentsDir(), id);
      if (!fs.existsSync(file)) return { ok: false, error: 'not found' };
      return { ok: true, content: fs.readFileSync(file, 'utf8').slice(0, 30000) };
    } catch (err) {
      return { ok: false, error: String((err as Error).message || err) };
    }
  }

  function resolveIncident(id: string): { ok: boolean; error?: string } {
    try {
      if (!/^[\w.-]+\.md$/.test(String(id || ''))) return { ok: false, error: 'bad id' };
      const file = path.join(ctx.incidentsDir(), id);
      if (!fs.existsSync(file)) return { ok: false, error: 'not found' };
      fs.renameSync(file, file + '.resolved.md');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message || err) };
    }
  }

  // ── 守护启动（guarded boot）──────────────────────────────────────────
  // startOnce: () => Promise<url>（真正的拉起动作）。
  // V4.2：opts.preRetry(errText) 是配置级修复钩子（pnpm allowBuilds 等），
  // 返回 { applied: [...] }（或真值）即视为「已修复」，与 repair() 结果合并
  // 后一起重试一次；返回 false 则走原链路。钩子只调用一次。
  async function guardedBoot(
    startOnce: () => Promise<string>,
    describeFailure?: () => string,
    opts: { preRetry?: (errText: string) => Promise<{ applied?: string[] } | boolean> | { applied?: string[] } | boolean } = {},
  ): Promise<string> {
    const bootSnap = snap.snapshot('boot');
    try {
      const url = await startOnce();
      if (bootSnap) snap.markGood(bootSnap.id);
      return url;
    } catch (firstErr) {
      ctx.log('guard', '守护启动：首次拉起失败，进入体检修复流程');
      const { findings } = scan.healthCheck();
      const fixable = findings.filter((f) => f.fixable);
      for (const f of findings) ctx.log('guard', `[体检] ${f.code}(${f.severity}): ${f.message}`);

      // V4.2：allowBuilds 等配置级修复钩子（只调用一次，返回 false 不打扰）。
      let preApplied: string[] = [];
      if (opts.preRetry) {
        try {
          const r = await opts.preRetry(String((firstErr as Error)?.message || firstErr));
          if (r && Array.isArray((r as { applied?: string[] }).applied) && ((r as { applied?: string[] }).applied as string[]).length) {
            preApplied = (r as { applied: string[] }).applied;
          } else if (r) preApplied = ['配置级修复钩子已应用'];
        } catch (err) {
          ctx.log('guard', 'preRetry 钩子失败: ' + String((err as Error).message || err));
        }
      }

      if (fixable.length || preApplied.length) {
        const { applied } = repair(findings);
        const all = [...applied, ...preApplied];
        if (all.length) {
          ctx.log('guard', '已应用修复: ' + all.join('；'));
          try {
            const url = await startOnce();
            if (bootSnap) snap.markGood(bootSnap.id);
            reportIncident(
              'boot-recovered',
              '首次启动失败，自动修复后恢复。\n修复项：\n- ' + all.join('\n- ') + '\n\n原始错误：\n' + String((firstErr as Error)?.message || firstErr),
            );
            return url;
          } catch (secondErr) {
            ctx.log('guard', '修复后重试仍失败，进入回滚流程');
            return rollbackPath(secondErr, bootSnap, describeFailure);
          }
        }
      }
      return rollbackPath(firstErr, bootSnap, describeFailure);
    }
  }

  async function rollbackPath(err: unknown, bootSnap: { id: string } | null, describeFailure?: () => string): Promise<string> {
    const good = snap.lastGoodSnapshot();
    if (good && (!bootSnap || good.id !== bootSnap.id)) {
      ctx.log('guard', `回滚到最后良好快照 ${good.id}（${good.reason}）`);
      const res = snap.restore(good.id);
      if (res.ok) {
        repair(scan.healthCheck().findings); // 回滚后再清一次遮蔽（pnpm 可能刚 hoist 过）
        try {
          const url = await guardedBootRetryOnce();
          return url;
        } catch (finalErr) {
          reportIncident('rollback-failed', '回滚到快照 ' + good.id + ' 后仍无法启动。\n\n最终错误：\n' + String((finalErr as Error)?.message || finalErr));
          throw finalErr;
        }
      }
    }
    reportIncident(
      'boot-failed',
      '启动失败且无可回滚快照。\n\n错误：\n' + String((err as Error)?.message || err) + (describeFailure ? '\n\n' + describeFailure() : ''),
    );
    throw err;
  }

  // 回滚后的拉起也要留「最后良好」标记 —— 交给调用方包一层。
  let rollbackLift: (() => Promise<string>) | null = null;
  function setRollbackLift(fn: (() => Promise<string>) | null): void {
    rollbackLift = fn;
  }
  async function guardedBootRetryOnce(): Promise<string> {
    if (rollbackLift) return rollbackLift();
    throw new Error('rollback lift not configured');
  }

  // ── 启动失败归因（V4.2）────────────────────────────────────────────
  // 把启动报错文案里的包名/行 id 对应到 profile 里「可停用的插件」：
  //   · 命中 patch 行 id/name → { name, kind: 'patchRow', rowId }
  //   · 命中 bundles / dependencies 键 → { name, kind, rowId: null }
  // 归因失败（报错不含可识别包名）返回 null —— 调用方退回通用按钮。
  // 只读 profile 配置面，绝不执行插件代码。
  function attributeBootFailure(errText: string): { name: string; kind: string; rowId: string | null } | null {
    try {
      const text = String(errText || '');
      if (!text) return null;
      const dir = ctx.profileDir();
      const candidates: string[] = [];
      const push = (raw: string): void => {
        const k = String(raw || '').replace(/['",.;:]+$/g, '');
        if (k && /^@?[A-Za-z0-9][A-Za-z0-9._@/+-]*$/.test(k) && !candidates.includes(k)) candidates.push(k);
      };
      const patterns = [
        /duplicate (?:loader )?entry[^\n]*?['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?/gi,
        /already registered[^\n]*?['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?/gi,
        /cannot find module\s+['"]([^'"]+)['"]/gi,
        /failed to (?:load|apply|initialize|resolve)\s+(?:plugin|entry|bundle)[^\n]*?['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?/gi,
        /(?:plugin|entry|bundle)\s+['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?\s+(?:failed|not found|unavailable|rejected)/gi,
      ];
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (m[1] !== undefined) push(m[1]);
        }
      }
      if (candidates.length === 0) return null;

      const manifest = readJson<{
        dsh?: { profile?: { bundles?: string[] } };
        dependencies?: Record<string, string>;
      }>(path.join(dir, 'package.json'), {});
      const bundles = manifest.dsh?.profile?.bundles ?? [];
      const depKeys = Object.keys(manifest.dependencies || {});
      // patch 行（顶层 + insert 内层）→ { id, name }
      let patchText = '';
      try {
        patchText = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
      } catch {
        /* 无 patch 文件按空处理 */
      }
      const rows: Array<{ id: string; name: string | null }> = [];
      if (patchText) {
        const lines = patchText.split(/\r?\n/);
        let pendingId: string | null = null;
        for (const line of lines) {
          const idm = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(line);
          if (idm !== null) {
            if (pendingId !== null) rows.push({ id: pendingId, name: null });
            pendingId = idm[1] ?? null;
            continue;
          }
          const nm = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
          if (nm !== null && pendingId !== null) {
            rows.push({ id: pendingId, name: nm[1] ?? null });
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

  return {
    repair,
    repairJunctions,
    reportIncident,
    listIncidents,
    readIncident,
    resolveIncident,
    guardedBoot,
    setRollbackLift,
    attributeBootFailure,
  };
}
