/**
 * lib/supervisor/incidents.ts — 扩展事故记录（VNext Phase 1，Task 9）。
 *
 * <DSH_HOME>/extensions/incidents/<id>/<ts>.json：每次故障/恢复转移一条，
 * 含版本、时间、原因与恢复动作 —— 架构文档 §7.2/§10.5「每个插件故障都能
 * 关联版本、日志、发生时间和恢复动作」。列表按时间倒序（新在前）。
 */

import fs = require('node:fs');
import path = require('node:path');
import os = require('node:os');
import { state } from '../state.js';
import { log } from '../log.js';

/** 单条事故记录。 */
export interface Incident {
  id: string;
  at: string;
  kind: 'fault' | 'recovery';
  from: string;
  to: string;
  version: string;
  detail: string;
}

/** 事故目录根（<dshHome>/extensions/incidents）。 */
function incidentsRoot(): string {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'extensions', 'incidents');
}

/** 追加一条事故（写失败只记日志 —— 留痕不得阻塞状态机转移）。 */
export function recordIncident(pluginId: string, inc: Omit<Incident, 'id' | 'at'>): Incident {
  const entry: Incident = { id: pluginId, at: new Date().toISOString(), ...inc };
  try {
    const dir = path.join(incidentsRoot(), sanitize(pluginId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, entry.at.replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n');
    prune(pluginId, dir);
  } catch (err) {
    log('incidents', '事故记录写入失败(' + pluginId + '): ' + String((err as Error).message));
  }
  return entry;
}

/** 每插件最多保留条数（防止长期抖动刷盘）。 */
const MAX_PER_PLUGIN = 50;

function prune(_pluginId: string, dir: string): void {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_PER_PLUGIN))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    /* 清理失败无碍 */
  }
}

/** 列某插件事故（新在前；limit 上限）。 */
export function listIncidents(pluginId: string, limit = 20): Incident[] {
  try {
    const dir = path.join(incidentsRoot(), sanitize(pluginId));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
    const out: Incident[] = [];
    for (const f of files.slice(0, limit)) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Incident);
      } catch {
        /* 单条损坏跳过 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 插件 id 白名单化（目录名只允许 [A-Za-z0-9._-]，杜绝路径逃逸）。 */
function sanitize(id: string): string {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}
