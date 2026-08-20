/**
 * lib/plugin-guard/snapshot.ts — 快照 / 回滚域（Task 6.3 自 plugin-guard.js 提取）。
 *
 * 只备份声明性配置（GUARD_FILES 四个小文件），秒级完成；node_modules 实体
 * 不备份 —— 回滚配置后，残留的包目录只是「不再被引用」，不影响加载。
 * 回滚前自动留「pre-restore」快照（反悔有路）；快照数超过 MAX_SNAPSHOTS
 * 自动清理。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GUARD_FILES, MAX_SNAPSHOTS, patchRowIds, readJson, writeJson,
  type GuardCtx, type SnapshotMeta,
} from './ctx.js';

/** 快照域 API（由 index.ts 的 createGuard 装配后随 guard 实例暴露）。 */
export interface SnapshotDomain {
  snapshot(reason?: string): SnapshotMeta | null;
  listSnapshots(): SnapshotMeta[];
  restore(id: string): { ok: boolean; restored?: string[]; error?: string };
  markGood(id?: string | null): void;
  lastGoodSnapshot(): SnapshotMeta | null;
}

/** 构建快照域：snapshot/listSnapshots/restore/markGood/lastGoodSnapshot（语义见文件头）。 */
export function createSnapshotDomain(ctx: GuardCtx): SnapshotDomain {
  function snapshot(reason?: string): SnapshotMeta | null {
    try {
      const dir = ctx.profileDir();
      if (!fs.existsSync(dir)) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
      const dest = path.join(ctx.rollbacksDir(), stamp);
      fs.mkdirSync(dest, { recursive: true });
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
        id: stamp,
        reason: String(reason || 'manual'),
        at: new Date().toISOString(),
        files,
        pluginRows: rows,
      };
      writeJson(path.join(dest, 'meta.json'), meta);
      pruneSnapshots();
      ctx.log('guard', `已创建快照 ${stamp}（${reason}，${files.length} 个文件，${rows.length} 个插件行）`);
      return meta;
    } catch (err) {
      ctx.log('guard', '创建快照失败: ' + String((err as Error).message));
      return null;
    }
  }

  function listSnapshots(): SnapshotMeta[] {
    try {
      const root = ctx.rollbacksDir();
      if (!fs.existsSync(root)) return [];
      const out: SnapshotMeta[] = [];
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = readJson<SnapshotMeta | null>(path.join(root, entry.name, 'meta.json'), null);
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
        const item = list[i];
        if (item) fs.rmSync(path.join(ctx.rollbacksDir(), item.id), { recursive: true, force: true, maxRetries: 2 });
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  function restore(id: string): { ok: boolean; restored?: string[]; error?: string } {
    try {
      if (!/^[\w.-]+$/.test(String(id || ''))) return { ok: false, error: 'bad snapshot id' };
      const snapDir = path.join(ctx.rollbacksDir(), String(id));
      if (!fs.existsSync(snapDir)) return { ok: false, error: 'snapshot not found' };
      const dir = ctx.profileDir();
      fs.mkdirSync(dir, { recursive: true });
      // 回滚前给当前状态留一份「回滚前」快照，反悔有路。
      snapshot('pre-restore:' + id);
      const restored: string[] = [];
      for (const name of GUARD_FILES) {
        const src = path.join(snapDir, name);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(dir, name));
        restored.push(name);
      }
      ctx.log('guard', `已回滚 profile 到快照 ${id}（${restored.join(', ')}）`);
      return { ok: true, restored };
    } catch (err) {
      return { ok: false, error: String((err as Error).message || err) };
    }
  }

  function state(): Record<string, unknown> {
    return readJson<Record<string, unknown>>(ctx.stateFile(), {});
  }

  function markGood(id?: string | null): void {
    try {
      const s = state();
      s.lastGood = id || null;
      s.lastGoodAt = new Date().toISOString();
      writeJson(ctx.stateFile(), s);
    } catch {
      /* 标记失败无碍 */
    }
  }

  function lastGoodSnapshot(): SnapshotMeta | null {
    const s = state();
    const lastGood = s.lastGood;
    if (!lastGood) return null;
    return listSnapshots().find((m) => m.id === lastGood) || null;
  }

  return { snapshot, listSnapshots, restore, markGood, lastGoodSnapshot };
}
