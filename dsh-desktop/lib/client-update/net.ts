/**
 * lib/client-update/net.ts — 统一 HTTP 传输层（Task 6.1 自 client-updater.js 提取）。
 *
 * Electron 主进程下优先用 net 模块（Chromium 网络栈）发请求：走系统代理
 * 与系统 CA 信任库。用户网络里 Node https 常见的两类硬伤它都能正确处理：
 *   ① 企业/网关 MITM 证书不在 Node 内置 Mozilla CA 列表 —— 报
 *      "unable to verify the first certificate"，检查更新直接失败；
 *   ② 系统代理（如 127.0.0.1:7890）Node https 根本不读，直连 GitHub
 *      超时。纯 Node 环境（单测）下 electron 不可用，自动回落 node https。
 */

import * as https from 'node:https';
import * as http from 'node:http';
import type { HttpResponse } from './types.js';

/** electron.net 的最小结构类型（与 Electron 主进程的 net API 面对齐）。 */
interface ElectronNet {
  request(opts: { url: string; redirect: 'follow' }): {
    setHeader(k: string, v: string): void;
    on(ev: 'response', cb: (res: { statusCode?: number; headers: NodeJS.Dict<string | string[]> } & NodeJS.ReadableStream) => void): void;
    on(ev: 'error', cb: (err: Error) => void): void;
    end(): void;
    destroy(err?: Error): void;
  };
}

// 惰性探测 electron.net：纯 Node（单测）下 require('electron') 抛错即回落。
let electronNet: ElectronNet | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as { net?: unknown };
  if (electron && typeof electron.net === 'object' && typeof (electron.net as ElectronNet).request === 'function') {
    electronNet = electron.net as ElectronNet;
  }
} catch {
  /* plain node (tests): fall back to node https */
}

/** 统一取响应头字段（net 与 http 的 header 值类型不一致，可能是数组）。 */
export function headerValue(headers: NodeJS.Dict<string | string[]>, name: string): string | string[] | undefined {
  const v = headers && headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 统一的“取响应”原语：resolve { status, headers, stream }。
 * electron.net 路径自动跟随重定向（含跨域）、自动走系统代理与系统 CA；
 * node https 回退路径手动跟随重定向（≤5 次）。timeoutMs 只约束到响应头
 * 到达（TTFB），响应体由调用方各自控制。
 */
export function getResponse(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; redirects?: number } = {},
): Promise<HttpResponse> {
  const { headers = {}, timeoutMs = 20_000, redirects = 0 } = opts;
  if (redirects > 5) return Promise.reject(new Error('重定向次数过多'));
  if (electronNet) {
    return new Promise<HttpResponse>((resolve, reject) => {
      let req: ReturnType<ElectronNet['request']>;
      try {
        req = electronNet.request({ url, redirect: 'follow' });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      for (const [k, v] of Object.entries({ 'User-Agent': 'DSH-Desktop', ...headers })) {
        try {
          req.setHeader(k, v);
        } catch {
          /* 无效头名等，忽略 */
        }
      }
      const timer = setTimeout(() => {
        try {
          req.destroy(new Error('请求超时'));
        } catch {
          /* already destroyed */
        }
      }, timeoutMs);
      req.on('response', (res) => {
        clearTimeout(timer);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          stream: res as unknown as HttpResponse['stream'],
        });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      req.end();
    });
  }
  return new Promise<HttpResponse>((resolve, reject) => {
    // 自定义镜像（DSH_DESKTOP_RELEASE_API）与单测允许 http:// 端点
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'DSH-Desktop', ...headers } }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        getResponse(new URL(loc, url).toString(), { headers, timeoutMs, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** GET 并解析 JSON（响应体上限 4MB，防镜像端点吐异常大响应）。 */
export async function httpGetJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<unknown> {
  const { status, stream } = await getResponse(url, { headers, timeoutMs });
  if (status !== 200) {
    stream.resume();
    throw new Error('HTTP ' + status);
  }
  let body = '';
  await new Promise<void>((resolve, reject) => {
    stream.setEncoding?.('utf8');
    stream.on('data', (c: string) => {
      body += c;
      if (body.length > 4 * 1024 * 1024) stream.destroy?.(new Error('响应过大'));
    });
    stream.on('end', () => resolve());
    stream.on('aborted', () => reject(new Error('连接中断')));
    stream.on('error', reject);
  });
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('JSON 解析失败');
  }
}

/** 判断是否“磁盘空间不足”类错误：重试不会好转，必须立即停下并提示用户。 */
export function isNoSpaceError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string };
  if (e.code === 'ENOSPC') return true;
  return /no space left on device/i.test(String(e.message || ''));
}

/** 构造带 ENOSPC code 的错误（供调用方统一识别磁盘满）。 */
export function noSpaceError(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'ENOSPC';
  return e;
}
