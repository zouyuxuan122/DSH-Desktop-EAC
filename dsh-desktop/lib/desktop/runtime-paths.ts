'use strict';

// 运行时定位：内置 Node / npm CLI / dsh CLI 二进制（ADR 0002 L2 业务服务层；
// Wave 1 自 runtime-paths.js 类型化迁出，行为零变更）。
// 优先级：用户已批准的官方更新 overlay > 随包内置副本。

import path = require('node:path');
import fs = require('node:fs');

// 应用根目录（本模块位于 <root>/lib/desktop/ 下）。
export const APP_ROOT = path.resolve(__dirname, '..', '..');

/** 注入接口：由宿主（Electron main / Tauri sidecar）在启动时提供。 */
export interface RuntimePathsCtx {
  log(tag: string, msg: string): void;
  getUserDataDir(): string;
  isPackaged?(): boolean;
  resourcesPath?(): string;
}

interface UpdCtx {
  userDataDir: string;
  nodeExe: () => string;
  npmCli: () => string;
  log(tag: string, msg: string): void;
}

// updater.js 尚未类型化（Wave 3 收编），先以窄签名消费。
const updater = require('../../updater') as {
  overlayBinPath(c: UpdCtx): string | null;
  activeVersion(c: UpdCtx): string | null;
  overlayVersion(c: UpdCtx): string | null;
  bundledVersion(): string | null;
  compareVersions(a: string, b: string): number;
};

let ctx!: RuntimePathsCtx;
export function init(d: RuntimePathsCtx): void { ctx = d; }
// 壳环境注入缺省时按开发态处理（保持原防御语义）。
function isPackaged(): boolean {
  return typeof ctx.isPackaged === 'function' ? !!ctx.isPackaged() : false;
}
function resourcesDir(): string {
  return typeof ctx.resourcesPath === 'function' ? ctx.resourcesPath() : '';
}

export function nodeExe(): string {
  if (isPackaged()) return path.join(resourcesDir(), 'node', 'node.exe');
  return path.resolve(APP_ROOT, 'vendor', 'node', 'node.exe');
}

export function npmCli(): string {
  if (isPackaged()) return path.join(resourcesDir(), 'npm', 'bin', 'npm-cli.js');
  return path.resolve(APP_ROOT, 'vendor', 'npm', 'bin', 'npm-cli.js');
}

// Context shared with the updater module.
export function updCtx(): UpdCtx {
  return {
    userDataDir: ctx.getUserDataDir(),
    nodeExe,
    npmCli,
    log: ctx.log,
  };
}

// Updated overlay takes precedence over the bundled copy — 除非 overlay 比
// 随包内置内核旧（应用升级后，过时的官方更新 overlay 不得遮蔽更新的内置内核；
// 平局仍取 overlay，保持既有语义）。
function effectiveOverlay(): string | null {
  const c = updCtx();
  const ov = updater.overlayBinPath(c);
  if (!ov || !fs.existsSync(ov)) return null;
  const ovVer = updater.overlayVersion(c);
  const bundled = updater.bundledVersion();
  if (ovVer && bundled && updater.compareVersions(ovVer, bundled) < 0) return null;
  return ov;
}

export function dshBin(): string {
  const ov = effectiveOverlay();
  if (ov) return ov;
  return require.resolve('@deepseek-ai/dsh/lib/bin.js');
}

export function dshVersion(): string {
  const c = updCtx();
  if (effectiveOverlay()) return updater.overlayVersion(c) || updater.activeVersion(c) || '未知';
  return updater.bundledVersion() || '未知';
}

export function dshVersionSource(): string {
  return effectiveOverlay() ? '用户目录（已更新）' : '内置';
}
