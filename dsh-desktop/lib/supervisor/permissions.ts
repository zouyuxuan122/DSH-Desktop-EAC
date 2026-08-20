/**
 * lib/supervisor/permissions.ts — 权限模型解析（VNext Phase 1，Task 9）。
 *
 * deny-by-default（架构文档 §5 / spec F1.2）：SDK 插件在 package.json 的
 * `dsh.extension.permissions` 声明能力；未声明的能力在 host-bootstrap 的
 * SDK 边界不可见。本模块只做「声明 → 强类型结构」的解析与校验，强制执行
 * 在 host 侧（Task 10/11）。授权状态（用户是否知情同意高风险权限）写回
 * registry（grantedAt）。
 */

import type { ExtensionPermissions } from '../../shared/protocol.js';
import { readRegistry, writeRegistry } from './registry.js';
import type { RegistryEntry } from './registry.js';
import { log } from '../log.js';

/** 解析结果：permissions + 非法字段说明（不抛出，坏声明降级为空权限）。 */
export interface ParsedPermissions {
  permissions: ExtensionPermissions;
  warnings: string[];
}

/** 从插件 package.json 的 JSON 对象解析权限声明。 */
export function parsePermissions(pkgJson: Record<string, unknown>): ParsedPermissions {
  const warnings: string[] = [];
  const decl = (pkgJson.dsh as Record<string, unknown> | undefined)?.extension as
    | Record<string, unknown>
    | undefined;
  if (!decl || typeof decl !== 'object') return { permissions: {}, warnings };
  const rawPerms = decl.permissions as Record<string, unknown> | undefined;
  if (!rawPerms || typeof rawPerms !== 'object') return { permissions: {}, warnings };

  const perms: {
    net?: string[];
    fs?: string[];
    shell?: boolean;
    env?: boolean;
  } = {};
  if (rawPerms.net !== undefined) {
    if (Array.isArray(rawPerms.net) && rawPerms.net.every((h) => typeof h === 'string')) {
      perms.net = rawPerms.net.map(String);
    } else warnings.push('net 权限须为字符串数组（主机白名单），已忽略');
  }
  if (rawPerms.fs !== undefined) {
    if (Array.isArray(rawPerms.fs) && rawPerms.fs.every((d) => typeof d === 'string')) {
      perms.fs = rawPerms.fs.map(String);
    } else warnings.push('fs 权限须为字符串数组（目录白名单），已忽略');
  }
  if (rawPerms.shell !== undefined) {
    if (typeof rawPerms.shell === 'boolean') perms.shell = rawPerms.shell;
    else warnings.push('shell 权限须为布尔值，已忽略');
  }
  if (rawPerms.env !== undefined) {
    if (typeof rawPerms.env === 'boolean') perms.env = rawPerms.env;
    else warnings.push('env 权限须为布尔值，已忽略');
  }
  for (const w of warnings) log('permissions', '权限声明问题: ' + w);
  return { permissions: perms, warnings };
}

/** 需要用户显式授权的高风险能力判定（shell / env / 任意 net 通配）。 */
export function requiresUserConsent(p: ExtensionPermissions): boolean {
  return p.shell === true || p.env === true || (p.net ?? []).includes('*');
}

/** 记录用户授权动作（恢复中心/安装向导调用）。 */
export function setGranted(id: string, granted: boolean): boolean {
  const reg = readRegistry();
  const e = reg.plugins[id] as (RegistryEntry & { grantedAt?: string; granted?: boolean }) | undefined;
  if (!e) return false;
  if (granted) {
    e.granted = true;
    e.grantedAt = new Date().toISOString();
  } else {
    delete e.granted;
    delete e.grantedAt;
  }
  reg.plugins[id] = e;
  return writeRegistry(reg);
}
