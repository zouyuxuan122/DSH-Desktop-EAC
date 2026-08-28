'use strict';

import path = require('node:path');

const STANDARD_SHORTCUT_NAME = 'Deepseek Harness EAC.lnk';
const RUNTIME_SHORTCUT_DESCRIPTION = 'DeepSeek Harness 桌面客户端';
const INSTALLER_SHORTCUT_DESCRIPTIONS = new Set([
  'DeepSeek Harness (dsh) 开箱即用的 Windows 桌面客户端：内置 dsh CLI 与 Node 运行时，一键启动 Web UI',
]);

function normalizeWindowsPath(value: unknown, stripIconIndex = false): string {
  let text = String(value || '').trim();
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  if (stripIconIndex) text = text.replace(/,\s*-?\d+\s*$/, '');
  if (!text) return '';
  return path.win32.normalize(text).replace(/[\\/]+$/, '').toLowerCase();
}

function sameWindowsPath(a: unknown, b: unknown, stripIconIndex = false): boolean {
  const left = normalizeWindowsPath(a, stripIconIndex);
  const right = normalizeWindowsPath(b, stripIconIndex);
  return Boolean(left && right && left === right);
}

function shortcutTargetKind(link: LnkLike | null | undefined, target: string, previousTarget?: string | null): string | null {
  if (!link || !link.target) return null;
  if (sameWindowsPath(link.target, target)) return 'current';
  if (previousTarget && sameWindowsPath(link.target, previousTarget)) return 'previous';
  return null;
}

function shortcutTargetsApp(link: LnkLike | null | undefined, target: string, previousTarget?: string | null): boolean {
  return shortcutTargetKind(link, target, previousTarget) !== null;
}

function desktopShortcutDirs(userDesktop: string, publicRoot: string): Array<{ scope: string; dir: string }> {
  const rows: Array<{ scope: string; dir: string }> = [];
  const seen = new Set<string>();
  const add = (scope: string, dir: string) => {
    const normalized = normalizeWindowsPath(dir);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rows.push({ scope, dir });
  };
  add('user', userDesktop);
  if (publicRoot) add('public', path.win32.join(publicRoot, 'Desktop'));
  return rows;
}

interface LnkLike { target?: string; icon?: string; args?: string; arguments?: string; description?: string }
interface ClassifyOpts { target?: string; previousTarget?: string | null | undefined; managedIcon?: string | undefined }

function classifyManagedShortcut(entry: { filePath?: string; link?: LnkLike | null } | null, {
  target,
  previousTarget,
  managedIcon,
}: ClassifyOpts = {}): string | null {
  if (!entry || path.win32.basename(String(entry.filePath || '')).toLowerCase()
    !== STANDARD_SHORTCUT_NAME.toLowerCase()) return null;
  const link = entry && entry.link;
  if (!shortcutTargetsApp(link || null, target || '', previousTarget)) return null;
  if (String((link && (link.args ?? link.arguments)) || '').trim() !== '') return null;

  const description = String((link && link.description) || '');
  const icon = String((link && link.icon) || '');
  if (description === RUNTIME_SHORTCUT_DESCRIPTION
    && (!icon || sameWindowsPath(icon, managedIcon, true))) {
    return 'runtime';
  }
  if (INSTALLER_SHORTCUT_DESCRIPTIONS.has(description)
    && (!icon
      || sameWindowsPath(icon, (link && link.target) || '', true)
      || sameWindowsPath(icon, target, true)
      || (previousTarget && sameWindowsPath(icon, previousTarget, true)))) {
    return 'installer';
  }
  return null;
}

function preferredManagedEntry(entries: Array<{ filePath?: string; link?: LnkLike | null; managedKind?: string | null; scope?: string; targetKind?: string | null }>, portable: boolean, target: string) {
  const score = (row: { filePath?: string; link?: LnkLike | null; managedKind?: string | null; scope?: string; targetKind?: string | null }): number => {
    // 当前可用目标的优先级最高；不能为了偏爱某个创建者而保留一份仍指向
    // 旧 exe 的快捷方式，并删除已经指向当前 exe 的那份。
    let value = shortcutTargetKind(row.link, target, null) === 'current' ? 1000 : 0;
    if (portable) {
      if (row.managedKind === 'runtime') value += 100;
      if (row.scope === 'user') value += 10;
    } else {
      if (row.managedKind === 'installer') value += 100;
      if (row.scope === 'public') value += 10;
    }
    return value;
  };
  return [...entries].sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    return String(a.filePath).localeCompare(String(b.filePath));
  })[0] || null;
}

interface PlanOpts {
  entries?: Array<{ filePath?: string; link?: LnkLike | null }>;
  target?: string;
  previousTarget?: string | null;
  managedIcon?: string;
  portable?: boolean;
  policy?: string;
}

function planDesktopShortcutMaintenance({
  entries = [],
  target = '',
  previousTarget,
  managedIcon,
  portable = false,
  policy = 'auto',
}: PlanOpts = {}) {
  if (policy === 'never') return { create: false, removals: [], preferred: null };

  const classified = entries.map((entry) => ({
    ...entry,
    targetKind: shortcutTargetKind(entry.link, target, previousTarget),
    managedKind: classifyManagedShortcut(entry, { target, previousTarget, managedIcon }),
  }));
  const appEntries = classified.filter((entry) => entry.targetKind);
  const managedEntries = classified.filter((entry) => entry.managedKind);
  const preferred = preferredManagedEntry(managedEntries as Array<{ filePath?: string; link?: LnkLike | null; managedKind?: string | null; scope?: string; targetKind?: string | null }>, Boolean(portable), target);
  // 自动重复只会由两个创建者交叉产生：NSIS + 运行时。相同创建者的两份
  // 元数据完全一致，无法可靠区分“软件重复”与“用户手动复制”，因此不删。
  const managedKinds = new Set(managedEntries.map((entry) => entry.managedKind));
  const removals = preferred && managedKinds.has('installer') && managedKinds.has('runtime')
    ? managedEntries.filter((entry) => entry.filePath !== preferred.filePath)
      .map((entry) => entry.filePath)
    : [];

  return {
    create: Boolean(portable) && appEntries.length === 0,
    removals,
    preferred: preferred ? preferred.filePath : null,
  };
}

module.exports = {
  STANDARD_SHORTCUT_NAME,
  RUNTIME_SHORTCUT_DESCRIPTION,
  normalizeWindowsPath,
  sameWindowsPath,
  shortcutTargetKind,
  shortcutTargetsApp,
  desktopShortcutDirs,
  classifyManagedShortcut,
  planDesktopShortcutMaintenance,
};
