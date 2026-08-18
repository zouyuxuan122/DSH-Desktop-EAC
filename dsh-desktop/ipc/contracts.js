'use strict';

// IPC 契约表（architecture-refactor-plan.md Phase 2.2 的第一步）。
//
// 全仓库 renderer→main IPC 通道的单一事实来源：channel 元数据（注册方式、
// 领域、sender 校验规则、请求载荷形状、未授权响应、幂等性）。
//
// 本模块先作为文档 + 校验工具存在（不改变运行时行为）：
//   · test/ipc-contracts.test.mjs 静态比对 main.js / preload.js 的通道字符串，
//     任何一边新增/改名/漏改都会被测试抓住（防漂移）；
//   · validatePayload 供后续 ipc/register-ipc.js 抽取时在注册层做结构校验
//     （log-only 接入），业务语义（路径围栏、URL allowlist、长度上限、模型
//     存在性）仍在各自 handler 内执行 —— 契约校验是第二道防线，不是替代品。
//
// sender 规则（与 main.js 现状一一对应）：
//   main-window   —— event.sender 必须是主窗 webContents
//   wizard-window —— 必须是插件选择向导窗 webContents
//   float-window  —— 必须是某个会话浮窗 webContents
//   any           —— 不做 sender 校验

/**
 * @typedef {'handle' | 'on'} IpcKind
 * @typedef {'main-window' | 'wizard-window' | 'float-window' | 'any'} IpcSenderRule
 * @typedef {'null' | 'array-empty' | 'unauthorized' | 'forbidden' | 'ok-false' | 'state' | 'ignore' | 'balance-cache'} IpcUnauthorized
 * @typedef {object} IpcRequestSpec
 * @property {string[]} keys
 * @property {Record<string, string>} [types]
 * @property {string[]} [required]
 * @typedef {object} IpcContract
 * @property {string} channel
 * @property {IpcKind} kind
 * @property {string} domain
 * @property {IpcSenderRule} sender
 * @property {IpcUnauthorized} unauthorized
 * @property {IpcRequestSpec | null} request
 * @property {string} response
 * @property {boolean} idempotent
 * @property {string} description
 */

/** @type {IpcContract[]} */
const IPC_CONTRACTS = [
  // ---- chrome（自绘标题栏 / 窗口 / 菜单 / 浮窗） ----
  {
    channel: 'chrome:init', kind: 'handle', domain: 'chrome', sender: 'main-window',
    unauthorized: 'null', request: null,
    response: 'object(appVersion/agentVersion/agentSource/…/staticPort)',
    idempotent: true,
    description: '主窗初始化信息（图标、版本、退出策略、快捷方式策略、仓库链接）。',
  },
  {
    channel: 'chrome:window', kind: 'handle', domain: 'chrome', sender: 'main-window',
    unauthorized: 'null', request: { keys: ['action'], types: { action: 'string' }, required: ['action'] },
    response: 'null | boolean(is-maximized)',
    idempotent: true,
    description: '自绘标题栏窗口控制：minimize / toggle-maximize / close / is-maximized。',
  },
  {
    channel: 'chrome:menu', kind: 'handle', domain: 'chrome', sender: 'main-window',
    unauthorized: 'state', request: { keys: ['action', 'value'], types: { action: 'string' } },
    response: 'menu state object(notifyOnTurnEnd/closeToTray/exitAction/shortcutPolicy)',
    idempotent: false,
    description: '菜单动作（reload/devtools/更新检查/通知与退出策略切换/关于/退出）；非主窗发送者降级返回当前状态。',
  },
  {
    channel: 'chrome:restart-service', kind: 'handle', domain: 'service', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['intent'], types: { intent: 'string' }, required: ['intent'] },
    response: '{ok, url?} | {ok:false, error}',
    idempotent: false,
    description: '插件市场/皮肤切换后原地重启 dsh web 服务；payload.intent 必须为 restart-service。',
  },
  {
    channel: 'chrome:float-window', kind: 'handle', domain: 'chrome', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['action', 'sessionId'], types: { action: 'string', sessionId: 'string' }, required: ['action', 'sessionId'] },
    response: '{ok, id?, reused?} | {ok:false, error}',
    idempotent: false,
    description: '会话浮窗：open（同会话复用，上限 FLOAT_MAX）。',
  },
  {
    channel: 'float:close', kind: 'on', domain: 'chrome', sender: 'float-window',
    unauthorized: 'ignore', request: null,
    response: 'void',
    idempotent: true,
    description: '浮窗关闭自身（发送者必须是某个浮窗）。',
  },
  {
    channel: 'dsh:copy-text', kind: 'handle', domain: 'chrome', sender: 'main-window',
    unauthorized: 'ok-false', request: { keys: ['text'], types: { text: 'string' } },
    response: '{ok}',
    idempotent: true,
    description: '复制文本到剪贴板（≤2048 字符）。',
  },

  // ---- recovery（渲染进程自恢复） ----
  {
    channel: 'dsh:renderer-heartbeat', kind: 'on', domain: 'recovery', sender: 'any',
    unauthorized: 'ignore', request: null,
    response: 'void',
    idempotent: true,
    description: 'preload 每 5s 心跳，恢复状态机兜底判定「挂起但未 unresponsive」。',
  },
  {
    channel: 'chrome:recovery-state', kind: 'handle', domain: 'recovery', sender: 'main-window',
    unauthorized: 'null', request: null,
    response: '{appVersion, logsDir, crashDumpsDir, state} | null',
    idempotent: true,
    description: '恢复页（assets/recovery.html）读取应用与恢复状态。',
  },
  {
    channel: 'chrome:recovery-reload', kind: 'handle', domain: 'recovery', sender: 'main-window',
    unauthorized: 'unauthorized', request: null,
    response: '{ok} | {ok:false, error}',
    idempotent: true,
    description: '恢复页重试：服务进程已退出时先重启服务（可能换端口）再重载。',
  },
  {
    channel: 'chrome:recovery-restart', kind: 'handle', domain: 'recovery', sender: 'main-window',
    unauthorized: 'unauthorized', request: null,
    response: '{ok}',
    idempotent: false,
    description: '恢复页选择重启客户端。',
  },
  {
    channel: 'chrome:recovery-open-logs', kind: 'handle', domain: 'recovery', sender: 'main-window',
    unauthorized: 'unauthorized', request: null,
    response: '{ok}',
    idempotent: true,
    description: '恢复页打开日志目录。',
  },
  {
    channel: 'dsh:page-error', kind: 'on', domain: 'recovery', sender: 'main-window',
    unauthorized: 'ignore', request: null,
    response: 'void',
    idempotent: true,
    description: 'preload 转发的 window.onerror / unhandledrejection（payload 为字符串）。',
  },

  // ---- guard（插件保护中心） ----
  {
    channel: 'guard:action', kind: 'handle', domain: 'guard', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['action', 'value'] },
    response: '{ok, …} | {ok:false, error}',
    idempotent: false,
    description: '插件保护中心：status / snapshot / restore / check / repair / incident / resolve-incident。',
  },

  // ---- plugin（插件管理 / 更新 / 粘贴） ----
  {
    channel: 'dsh:plugin-list', kind: 'handle', domain: 'plugin', sender: 'main-window',
    unauthorized: 'array-empty', request: null,
    response: 'PluginRow[]',
    idempotent: true,
    description: '插件管理列表（配套/用户/核心插件：id、包名、描述、启停状态）。',
  },
  {
    channel: 'dsh:plugin-set-enabled', kind: 'handle', domain: 'plugin', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['id', 'enabled'], types: { id: 'string', enabled: 'boolean' } },
    response: '{ok, restartRequired} | {ok:false, error}',
    idempotent: true,
    description: '启用/关闭插件（写 patch 层 disabled 条目，重启后生效）。',
  },
  {
    channel: 'dsh:plugin-set-removed', kind: 'handle', domain: 'plugin', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['id', 'removed'], types: { id: 'string', removed: 'boolean' } },
    response: '{ok, restartRequired} | {ok:false, error}',
    idempotent: true,
    description: '内置插件移除（卸载语义）/恢复。',
  },
  {
    channel: 'dsh:plugin-updates', kind: 'handle', domain: 'plugin', sender: 'main-window',
    unauthorized: 'null', request: { keys: ['force'], types: { force: 'boolean' } },
    response: '{list, autoUpdate, checkedAt} | {list: [], autoUpdate: false, error}',
    idempotent: true,
    description: '内置插件上游更新检测清单（24h 节流，force 忽略）。',
  },
  {
    channel: 'dsh:plugin-update', kind: 'handle', domain: 'plugin', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['id'], types: { id: 'string' } },
    response: '{ok, version?, restartRequired?, noop?} | {ok:false, error}',
    idempotent: false,
    description: '手动更新单个内置插件（覆盖层下载，--ignore-scripts）。',
  },
  {
    channel: 'dsh:plugin-auto-update', kind: 'handle', domain: 'plugin', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['enabled'], types: { enabled: 'boolean' } },
    response: '{ok} | {ok:false, error}',
    idempotent: true,
    description: '内置插件自动更新开关。',
  },
  {
    channel: 'dsh:plugin-uninstall', kind: 'handle', domain: 'plugin', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['id'], types: { id: 'string' } },
    response: '{ok} | {ok:false, error}',
    idempotent: false,
    description: '卸载市场插件（含回滚）。',
  },
  {
    channel: 'dsh:plugin-restore', kind: 'handle', domain: 'plugin', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['id'], types: { id: 'string' } },
    response: '{ok} | {ok:false, error}',
    idempotent: false,
    description: '恢复已移除的内置插件（覆盖层优先取源）。',
  },
  {
    channel: 'dsh:image-paste-save', kind: 'handle', domain: 'plugin', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['dataUrl', 'name'], types: { dataUrl: 'string', name: 'string' } },
    response: '{ok, path?, size?} | {ok:false, error}',
    idempotent: true,
    description: '剪贴板图片 data URL 存入 %TEMP%/dsh-paste/（限 image/*、15MB、文件名清洗）。',
  },

  // ---- onboarding（内置插件选择向导） ----
  {
    channel: 'onboard:list', kind: 'handle', domain: 'onboarding', sender: 'wizard-window',
    unauthorized: 'null', request: null,
    response: '{mode, catalog, current?} | null',
    idempotent: true,
    description: '向导目录与当前启停状态。',
  },
  {
    channel: 'onboard:submit', kind: 'handle', domain: 'onboarding', sender: 'wizard-window',
    unauthorized: 'unauthorized', request: { keys: ['ids'] },
    response: '{ok, applied, errors}',
    idempotent: false,
    description: '提交向导选择：写 patch 层 + 持久化 settings + 关窗（rerun 模式重启服务）。',
  },
  {
    channel: 'onboard:close', kind: 'on', domain: 'onboarding', sender: 'wizard-window',
    unauthorized: 'ignore', request: null,
    response: 'void',
    idempotent: true,
    description: '用户跳过/关闭向导（cancelled 分支，保持全部启用）。',
  },
  {
    channel: 'onboard:open', kind: 'handle', domain: 'onboarding', sender: 'main-window',
    unauthorized: 'unauthorized', request: null,
    response: '{ok, reused?}',
    idempotent: false,
    description: '设置页二次打开插件选择向导（rerun 模式）。',
  },

  // ---- balance（余额与价格） ----
  {
    channel: 'dsh:balance-refresh', kind: 'handle', domain: 'balance', sender: 'main-window',
    unauthorized: 'balance-cache', request: null,
    response: 'balance cache object',
    idempotent: true,
    description: '刷新并返回余额缓存（dsh-balance 插件）。',
  },
  {
    channel: 'dsh:balance-prices-get', kind: 'handle', domain: 'balance', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['model'], types: { model: 'string' } },
    response: '{ok, model, defaults, current}',
    idempotent: true,
    description: '读取模型 token 价格覆盖。',
  },
  {
    channel: 'dsh:balance-prices-set', kind: 'handle', domain: 'balance', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['model', 'prices'], types: { model: 'string' } },
    response: '{ok} | {ok:false, error}',
    idempotent: true,
    description: '保存模型价格覆盖（sanitizePrices 校验后写 settings 并重推余额）。',
  },
  {
    channel: 'dsh:balance-prices-reset', kind: 'handle', domain: 'balance', sender: 'main-window',
    unauthorized: 'unauthorized', request: { keys: ['model'], types: { model: 'string' } },
    response: '{ok} | {ok:false, error}',
    idempotent: true,
    description: '清除模型价格覆盖。',
  },

  // ---- file（会话文件还原 / 打开） ----
  {
    channel: 'dsh:file-revert', kind: 'handle', domain: 'file', sender: 'main-window',
    unauthorized: 'array-empty', request: { keys: ['changes'], required: ['changes'] },
    response: '{results: [{path, status, error?}]}',
    idempotent: true,
    description: '按会话日志写前/写后全文精确匹配回退（≤300 条，路径围栏内）。',
  },
  {
    channel: 'dsh:file-open', kind: 'handle', domain: 'file', sender: 'main-window',
    unauthorized: 'forbidden', request: { keys: ['path'], types: { path: 'string' }, required: ['path'] },
    response: '{ok} | {ok:false, error}',
    idempotent: true,
    description: '用系统默认程序打开项目文件（绝对路径 + 会话根围栏 + 危险扩展名拒绝）。',
  },
  {
    channel: 'dsh:open-external', kind: 'handle', domain: 'file', sender: 'main-window',
    unauthorized: 'forbidden', request: { keys: ['url'], types: { url: 'string' }, required: ['url'] },
    response: '{ok} | {ok:false, error}',
    idempotent: true,
    description: '预览面板用系统浏览器打开 http(s) URL。',
  },
];

// 主进程 → 渲染进程的推送通道（不经 ipcMain 注册，仅作文档登记，防误删）。
const PUSH_CHANNELS = ['chrome:maximized', 'dsh:balance'];

const BY_CHANNEL = new Map(IPC_CONTRACTS.map((c) => [c.channel, c]));

/**
 * @param {string} channel
 * @returns {IpcContract | null}
 */
function channelContract(channel) {
  return BY_CHANNEL.get(channel) || null;
}

// 载荷结构校验（非抛出）。只检查「形状/类型」，业务语义由 handler 负责。
// 返回 { ok, violations }；violations 为空即合法。
/**
 * @param {string} channel
 * @param {unknown} payload
 * @returns {{ ok: boolean, violations: string[] }}
 */
function validatePayload(channel, payload) {
  const contract = BY_CHANNEL.get(channel);
  if (!contract) return { ok: false, violations: ['unknown channel: ' + channel] };
  const violations = [];
  const spec = contract.request;

  if (payload === undefined || payload === null) {
    if (spec && spec.required && spec.required.length > 0) {
      violations.push('missing required payload keys: ' + spec.required.join(', '));
    }
    return { ok: violations.length === 0, violations };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, violations: ['payload must be a plain object'] };
  }
  /** @type {Record<string, unknown>} */
  const record = /** @type {Record<string, unknown>} */ (payload);
  if (spec && spec.required) {
    for (const key of spec.required) {
      if (record[key] === undefined) {
        violations.push('missing required payload key: ' + key);
      }
    }
  }
  const allowed = new Set(spec ? spec.keys : []);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) violations.push('unknown payload key: ' + key);
  }
  for (const [key, type] of Object.entries(spec ? spec.types || {} : {})) {
    const value = record[key];
    if (value !== undefined && value !== null && typeof value !== type) {
      violations.push('payload key ' + key + ' must be ' + type + ', got ' + typeof value);
    }
  }
  return { ok: violations.length === 0, violations };
}

module.exports = {
  IPC_CONTRACTS,
  PUSH_CHANNELS,
  channelContract,
  validatePayload,
};
