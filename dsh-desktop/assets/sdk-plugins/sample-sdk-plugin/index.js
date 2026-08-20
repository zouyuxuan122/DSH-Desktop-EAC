/**
 * sample-sdk-plugin — VNext Phase 2 Extension SDK V1 最小示例（Task 11.3）。
 *
 * 演示 SDK 全部核心能力面（ctx 由 host-bootstrap 的 lib/extension-host/sdk
 * 构建，插件只拿到这个受控对象）：
 *   - registerTool(name, {description, parameters}, handler)：Agent 工具，
 *     元数据经 Core Bridge 以 `eac_sample-sdk-plugin_echo` 注册进 dsh；
 *   - provideContext(fn)：每回合上下文贡献（超时即被丢弃）；
 *   - settings.get/set：插件私有设置（data/settings.json，原子落盘）；
 *   - on('turn-end', cb)：只读事件订阅（Supervisor 广播）；
 *   - log(level, msg)：结构化日志（回 Supervisor 统一落盘）。
 *
 * 本插件随仓库分发（assets/sdk-plugins/），首启由 boot 自动安装到
 * <DSH_HOME>/extensions/sample-sdk-plugin 并拉起 —— 即「零侵入扩展」的
 * 活样板：不写 Core Profile 任何文件即可让 Agent 获得新工具。
 */

'use strict';

module.exports.activate = function activate(ctx) {
  let startedAt = new Date().toISOString();
  ctx.settings.set('startedAt', startedAt);
  ctx.log('info', `sample-sdk-plugin 已激活（dataDir=${ctx.dataDir}）`);

  // ── 工具 1：echo —— 参数校验（msg 必填）+ 设置读写的最小闭环 ──────────
  ctx.registerTool(
    'echo',
    {
      description: '回显输入文本（sample-sdk-plugin 演示工具：验证隔离链路端到端可用）。',
      parameters: {
        msg: { type: 'string', required: true, description: '要回显的文本。' },
      },
    },
    (args) => {
      const count = (ctx.settings.get('echoCount', 0) || 0) + 1;
      ctx.settings.set('echoCount', count);
      ctx.log('debug', `echo #${count}: ${String(args.msg).slice(0, 80)}`);
      return { echo: args.msg, calls: count };
    },
  );

  // ── 工具 2：status —— 展示宿主/设置状态（无参数工具）───────────────────
  ctx.registerTool(
    'status',
    {
      description: '返回 sample-sdk-plugin 的运行状态（激活时间/调用计数/宿主 pid）。',
    },
    () => ({
      startedAt,
      echoCalls: ctx.settings.get('echoCount', 0) || 0,
      hostPid: process.pid,
    }),
  );

  // ── 上下文贡献：每回合注入一行标记（演示 provideContext）────────────────
  ctx.provideContext(() => {
    const n = (ctx.settings.get('contextTurns', 0) || 0) + 1;
    ctx.settings.set('contextTurns', n);
    return `[sample-sdk-plugin] 隔离插件运行中（第 ${n} 次上下文贡献）`;
  });

  // ── 事件订阅：回合结束（演示 on；Supervisor 广播）──────────────────────
  ctx.on('turn-end', (info) => {
    ctx.log('info', `回合结束事件: ${JSON.stringify(info ?? {}).slice(0, 120)}`);
  });
};
