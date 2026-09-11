'use strict';

// 安装形态（v5.4 单发行版双形态）：同一个安装包，安装器选择「完整版 / 精简版」。
// 安装器（NSIS POSTINSTALL 钩子）把选择写入 <payload>/profile.txt（"full"/"lite"，
// 便携包默认缺省 = full），companion-sync 启动时读取并把它作为「新行默认值」
// —— 已有注册行不重写、用户选择优先（与 dsh-pet 默认禁用同一语义），因此
// 精简版用户随时可在「设置 → 插件 → 管理 / 增强功能」启用完整功能。

import fs = require('node:fs');
import path = require('node:path');

export type InstallProfile = 'full' | 'lite';

export const PROFILE_MARKER_FILE = 'profile.txt';

/**
 * 精简版默认停用的配套插件（companion id）。
 *
 * 精简原则：保留修复核心体验（滚动/视口/设置）、安全兜底（保护中心/急救/
 * 压缩）、省钱（余额/峰谷）与市场管理；停用高门槛或重外围能力，全部可在
 * 设置页一键启用。
 *
 * 约束（install-profile.test.ts 守护）：
 *  - 必须是 COMPANION_PLUGINS 的子集；
 *  - 不得命中 scripts/onboarding 的 CORE_PLUGIN_IDS（核心组锁定停用路径，
 *    核心插件即便在精简版也保持默认启用 —— 如 terminal、compact）。
 */
export const LITE_DEFAULT_DISABLED: readonly string[] = [
  'agent-teams',                 // 多智能体团队协作（高级玩法）
  'openclaw-bridge',             // 微信 ClawBot / OpenClaw 桥（集成类）
  'dsh-phone',                   // 手机桥（LAN 配对 + 反向代理）
  'computer-user',               // 读屏 + 鼠标键盘自动化（高级玩法）
  'dsh-dafeiyu',                 // 大肥鱼桌宠（含 49MB PyInstaller helper）
  'dsh-pet-settings',            // 桌宠设置分区（桌宠默认停用时无对象可管）
  'composer-dynamic-island',     // 输入灵动岛（改变输入区形态）
  'side-session',                // 侧边临时会话
  'float-window',                // 会话浮窗分屏
  'message-rewind',              // 消息回退编辑
  'prompt-custom',               // 自定义注入提示词
  'dsh-webui-prompt-optimizer',  // 提示词优化器
  'change-review',               // AI 变更审核
];

export function isLiteDisabled(id: string, profile: InstallProfile): boolean {
  return profile === 'lite' && LITE_DEFAULT_DISABLED.includes(id);
}

/** 读取安装形态标记：缺失 / 脏值 / 读失败一律回退 full（永不阻塞启动）。 */
export function readInstallProfile(appRoot: string): InstallProfile {
  try {
    const raw = fs.readFileSync(path.join(appRoot, PROFILE_MARKER_FILE), 'utf8');
    return raw.trim() === 'lite' ? 'lite' : 'full';
  } catch {
    return 'full';
  }
}
