'use strict';

// Stable web-port selection (integrated from upstream dsh_desktop;
// Wave 3 自 stable-port.js 类型化迁出，行为零变更).
//
// dsh web 的部分 Web UI 偏好（如左侧会话分组方式）存在 localStorage，而
// localStorage 按 origin 隔离；每次 `--port 0` 随机分配都会换 origin，导致
// 用户偏好丢失。启动时优先复用 settings 里持久化的端口，不可用再挑一个
// 固定的空闲端口；同时避开 Chromium 受限端口（ERR_UNSAFE_PORT），否则窗口
// 加载 http://127.0.0.1:<restricted>/ 会直接白屏。

import net = require('node:net');

// Chromium bad-port list（截取常见的系统/保留端口，完整列表见
// https://chromium.googlesource.com/chromium/src/+/main/net/base/port_util.cc）
export const CHROMIUM_RESTRICTED_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

interface StablePortCtx {
  loadSettings(c: unknown): { webPort?: number } & Record<string, unknown>;
  saveSettings(c: unknown, s: unknown): void;
}

// url 命中受限端口时返回该端口号，否则返回 0。
export function restrictedPortOf(url: string): number {
  try {
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === 'https:' ? '443' : '80'));
    return CHROMIUM_RESTRICTED_PORTS.has(port) ? port : 0;
  } catch {
    return 0;
  }
}

// 选一个尽量稳定的 127.0.0.1 端口并通过 ctx.saveSettings 持久化。
//
// ctx 形如主进程的 updCtx()：
//   ctx.loadSettings(ctx) / ctx.saveSettings(ctx, settings) —— 端口持久化
// opts.maxFreeRetries —— 空闲随机端口命中受限列表时的重试次数（默认 5），
//   重试耗尽仍受限则保存 0（回落到 dsh web 的随机分配，由启动方的
//   watchServerProc 受限端口重试兜底）。
export function chooseStableWebPort(
  ctx: StablePortCtx,
  opts: { maxFreeRetries?: number } = {},
): Promise<number> {
  const maxFreeRetries = opts.maxFreeRetries != null ? opts.maxFreeRetries : 5;
  return new Promise((resolve) => {
    const settings = ctx.loadSettings(ctx);
    const preferred = Number(settings.webPort) || 0;
    const save = (port: number): void => {
      settings.webPort = port;
      ctx.saveSettings(ctx, settings);
      resolve(port);
    };
    const tryPort = (port: number, done: (ok: boolean) => void): void => {
      const probe = net.createServer();
      const finish = (ok: boolean): void => {
        probe.removeAllListeners();
        probe.close(() => done(ok));
      };
      probe.once('error', () => finish(false));
      probe.listen(port, '127.0.0.1', () => finish(true));
    };
    const pickFree = (retriesLeft: number = maxFreeRetries): void => {
      const probe = net.createServer();
      probe.once('error', () => {
        if (retriesLeft > 0) pickFree(retriesLeft - 1);
        else save(0);
      });
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        const port = addr && typeof addr === 'object' ? addr.port : 0;
        probe.close(() => {
          if (CHROMIUM_RESTRICTED_PORTS.has(port) && retriesLeft > 0) pickFree(retriesLeft - 1);
          else save(port);
        });
      });
    };
    if (preferred && !CHROMIUM_RESTRICTED_PORTS.has(preferred)) {
      tryPort(preferred, (ok) => (ok ? save(preferred) : pickFree()));
    } else {
      pickFree();
    }
  });
}
