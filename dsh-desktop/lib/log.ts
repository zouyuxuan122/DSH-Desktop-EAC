/**
 * lib/log.ts — 隔离体系统一日志通道（vnext-absorb 自重构版 log.ts 裁剪）。
 *
 * 重构版经 state.desktopLog 写 desktop.log + 结构化 logger 双通道；本地 Tauri
 * sidecar 的日志出口是侧边服务注入的 ctx.log（写 desktop.log 并脱敏），因此
 * 这里做成可注入 sink：sidecar boot 链 setLogSink(ctx.log) 后，supervisor /
 * extension-host / recovery-center 模块的 `log(tag, msg)` 走同一出口；sink
 * 未设置时静默丢弃（模块在纯单测环境可独立加载）。
 */

type LogSink = (tag: string, msg: string) => void;

let sink: LogSink | null = null;

/** 注入日志出口（sidecar boot 链调用；幂等）。 */
export function setLogSink(fn: LogSink | null): void {
  sink = fn;
}

/**
 * 统一日志入口。
 * @param tag 子系统标签（如 'ext-host' / 'registry' / 'recovery-center'）。
 * @param msg 消息文本。
 */
export function log(tag: string, msg: string): void {
  try {
    if (sink) sink(tag, msg);
  } catch {
    /* 日志失败不影响业务 */
  }
}
