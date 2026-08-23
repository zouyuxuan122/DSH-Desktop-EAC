'use strict';

// 桌面专属 profile（与原生 CLI 彻底共存）（ADR 0002 L2 业务服务层；
// Wave 1 自 profile.js 类型化迁出，行为零变更）。
//
// 历史冲突根因有二 ——
//   1. 桌面端把配套插件行/包直接写进原生 `web` profile，pnpm 安装、patch
//      行互踩，原生 CLI 跟着崩；
//   2. dsh-app-boot 会把 <home>/profiles/node_modules 的共享 junction 指向
//      「当前运行的 dsh 实例」自己的闭包 —— 原生 npx dsh 一跑，桌面端模块
//      解析被换血（版本错位 / npx 缓存清理后悬空）。
// 桌面端从此默认运行在独立 profile `web-desktop`（DSH_HOME 不变：会话、
// API Key、settings.yaml 依旧共享）；junction 归属由 plugin-guard 周期守卫。
// 旧共享模式仍可用（settings.shareWebProfile = true），仅供特殊需要。

import path = require('node:path');
import fs = require('node:fs');
import os = require('node:os');
import { updCtx, APP_ROOT } from './runtime-paths';
// updater.js 尚未类型化（Wave 3 收编），先以窄签名消费。
const updater = require('../../updater') as {
  loadSettings(c: ReturnType<typeof updCtx>): { shareWebProfile?: boolean };
};

export const DESKTOP_PROFILE = 'web-desktop';
// 与官方 web profile 出厂模板一致（@deepseek-ai/dsh-base + dsh-web-app）。
export const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** 注入接口：由宿主（Electron main / Tauri sidecar）在启动时提供。 */
export interface ProfileCtx {
  log(tag: string, msg: string): void;
  getDshHome(): string | null;
}

let ctx!: ProfileCtx;
export function init(d: ProfileCtx): void { ctx = d; }

export function desktopProfile(): string {
  try {
    const s = updater.loadSettings(updCtx());
    return s.shareWebProfile === true ? 'web' : DESKTOP_PROFILE;
  } catch {
    return DESKTOP_PROFILE;
  }
}

export function desktopProfileDir(): string {
  const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', desktopProfile());
}

// 未知 profile 不会自动初始化（dsh 直接报错退出），桌面端自己按官方模板
// 创建：package.json（bundles）+ pnpm-workspace.yaml + 空 patch 层。
export function ensureDesktopProfileInit() {
  try {
    const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
    const dir = desktopProfileDir();
    if (desktopProfile() === 'web') return; // 共享模式走官方模板
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(manifest, JSON.stringify({
        name: 'dsh-profile-' + desktopProfile(),
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
      }, null, 2) + '\n');
      ctx.log('boot', '已初始化桌面专属 profile: ' + dir);
    }
    if (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
    }
    if (!fs.existsSync(path.join(dir, 'cordis.patch.yml'))) {
      fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n');
    }
    // 从源码运行时，插件会从 DSH_HOME/profile 的共享 node_modules 解析
    // 宿主依赖；全新隔离 DSH_HOME 没有安装闭包，先补齐桌面依赖中的
    // schemastery junction，避免 better-sidebar / side-session 触发整树失败。
    const shared = path.join(home, 'profiles', 'node_modules');
    const source = path.join(APP_ROOT, 'node_modules', 'schemastery');
    const link = path.join(shared, 'schemastery');
    if (fs.existsSync(source) && !fs.existsSync(link)) {
      fs.mkdirSync(shared, { recursive: true });
      try { fs.symlinkSync(source, link, 'junction'); } catch (err) {
        ctx.log('boot', '创建 schemastery 共享链接失败: ' + (err as Error).message);
      }
    }
  } catch (err) {
    ctx.log('boot', '初始化桌面 profile 失败: ' + (err as Error).message);
  }
}
