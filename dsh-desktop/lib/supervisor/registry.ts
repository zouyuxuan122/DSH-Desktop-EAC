/**
 * lib/supervisor/registry.ts — 扩展注册表（VNext Phase 0 雏形，Task 8）。
 *
 * <DSH_HOME>/extensions/registry.json：每个已装插件的档案（来源/风险等级/
 * 类型/最近启动失败），Phase 0 承担「插件档案」职责；Phase 1（Task 9）在其
 * 上叠加完整故障状态机（installed→…→quarantined）与原子安装字段。
 *
 * 写盘策略：tmp + rename 原子替换；读失败降级为空注册表（永不抛出，恢复
 * 中心在任何损坏状态下必须可用）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ExtensionRegistry, ExtensionRecord, ExtensionRuntimeState } from '../../shared/protocol.js';
import { state } from '../state.js';
import { log } from '../log.js';

/** 注册表 schema 版本（结构变更时 +1 并写迁移）。 */
const SCHEMA_VERSION = 1;

/** 注册表文件路径（<dshHome>/extensions/registry.json）。 */
export function registryPath(): string {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'extensions', 'registry.json');
}

/** 读注册表（损坏/缺失返回空表，绝不抛出）。 */
export function readRegistry(): ExtensionRegistry {
  const empty: ExtensionRegistry = { schemaVersion: SCHEMA_VERSION, plugins: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as ExtensionRegistry;
    if (!raw || typeof raw !== 'object' || !raw.plugins || typeof raw.plugins !== 'object')
      return empty;
    return { schemaVersion: SCHEMA_VERSION, plugins: raw.plugins };
  } catch {
    return empty;
  }
}

/** 原子写注册表（tmp + rename；失败记日志不抛出）。 */
export function writeRegistry(reg: ExtensionRegistry): boolean {
  try {
    const file = registryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log('registry', '注册表写入失败: ' + String((err as Error).message));
    return false;
  }
}

/** 单条档案（静态 + 动态字段的并集）。 */
export type RegistryEntry = ExtensionRecord & ExtensionRuntimeState;

/** 读取/补全单条档案（不存在时按传入静态字段建档）。 */
function entryOf(
  reg: ExtensionRegistry, id: string, init: Omit<ExtensionRecord, 'installedAt'>,
): RegistryEntry {
  const prev = reg.plugins[id] as RegistryEntry | undefined;
  if (prev) return prev;
  return {
    ...init,
    installedAt: new Date().toISOString(),
    state: 'installed',
    enabled: true,
    crashStreak: 0,
  };
}

/**
 * 登记/刷新一个 Legacy（Cordis 直注入）插件的档案。
 * Phase 0 启动链为全部内置配套插件与市场/手工插件建档（来源 + 风险等级）。
 */
export function upsertLegacyPlugin(p: {
  id: string;
  version?: string;
  source: 'builtin' | 'market' | 'manual';
  enabled?: boolean;
}): void {
  try {
    const reg = readRegistry();
    const e = entryOf(reg, p.id, {
      id: p.id,
      version: p.version ?? '',
      source: p.source,
      risk: 'legacy-cordis',
      kind: 'legacy',
      packageSha256: '',
      permissions: {},
      rollbackVersions: [],
    });
    if (p.enabled !== undefined) e.enabled = p.enabled;
    reg.plugins[p.id] = e;
    writeRegistry(reg);
  } catch (err) {
    log('registry', '档案登记失败(' + p.id + '): ' + String((err as Error).message));
  }
}

/** 记录一次启动失败归因（Phase 0.3：启动失败记录写入档案）。 */
export function recordStartFailure(id: string, error: string): void {
  try {
    const reg = readRegistry();
    const e = reg.plugins[id] as RegistryEntry | undefined;
    if (!e) return; // 未建档插件（如官方 bundle）不记录
    e.state = 'failed';
    e.lastError = String(error).slice(0, 500);
    e.lastErrorAt = new Date().toISOString();
    reg.plugins[id] = e;
    writeRegistry(reg);
  } catch (err) {
    log('registry', '启动失败归因落盘失败: ' + String((err as Error).message));
  }
}

/** 恢复中心动作成功后清除失败标记。 */
export function clearStartFailure(id: string): void {
  try {
    const reg = readRegistry();
    const e = reg.plugins[id] as RegistryEntry | undefined;
    if (!e) return;
    e.state = e.enabled ? 'installed' : 'disabled';
    delete e.lastError;
    delete e.lastErrorAt;
    reg.plugins[id] = e;
    writeRegistry(reg);
  } catch (err) {
    log('registry', '清除失败标记失败: ' + String((err as Error).message));
  }
}

/** 全量档案列表（恢复中心展示用；按 id 排序稳定输出）。 */
export function listRegistryEntries(): RegistryEntry[] {
  const reg = readRegistry();
  return Object.values(reg.plugins).sort((a, b) => a.id.localeCompare(b.id));
}

/** Phase 0「隔离标记」：手动隔离/解除（Phase 1 状态机接管后转为自动转移）。 */
export function setQuarantined(id: string, quarantined: boolean): boolean {
  const reg = readRegistry();
  const e = reg.plugins[id] as RegistryEntry | undefined;
  if (!e) return false;
  e.state = quarantined ? 'quarantined' : e.enabled ? 'installed' : 'disabled';
  reg.plugins[id] = e;
  return writeRegistry(reg);
}
