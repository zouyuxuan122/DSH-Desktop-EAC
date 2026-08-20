/**
 * lib/extension-host/bridge-server.ts — Core Bridge 的 Supervisor 侧端点（Task 11.2）。
 *
 * 形态：仅监听 127.0.0.1 的极简 JSON HTTP 服务，供运行在 Core Harness
 * （dsh web 进程）里的受信 cordis 组件 dsh-eac-core-bridge 回调：
 *   POST /tools    {token}          → 全部运行中插件的工具元数据
 *   POST /invoke   {token, pluginId, tool, args} → 转发 manager.invoke（结果 JSON 化）
 *   POST /context  {token, sessionId}            → 收集回合上下文（超时丢弃）
 *
 * 鉴权：每次启动生成一次性 token（crypto.randomBytes），经 childEnv 注入
 * dsh web 子进程（DSH_EAC_BRIDGE_URL / DSH_EAC_BRIDGE_TOKEN），桥接组件凭
 * x-eac-token 头回传。仅回环监听 + 随机端口 + 每会话 token，邻进程无法
 * 碰到（本机其它进程可见端口，但无 token 即 401）。
 *
 * 失败语义（架构文档 §5「Core Bridge」）：工具调用异常/超时 → 返回错误文本
 * 由 Agent 看到（不炸核心回合）；上下文收集超时 → 丢弃该插件贡献。
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { ExtensionHostManager } from './manager.js';
import { log } from '../log.js';

/** 桥接服务句柄（供 childEnv 注入与关闭）。 */
export interface BridgeServer {
  url: string;
  token: string;
  close(): void;
}

/** 工具调用的整体超时（Agent 侧工具本就允许长任务）。 */
const INVOKE_TIMEOUT_MS = 120_000;

/** 单次请求体大小上限（防失控桥接组件撑爆主进程）。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 启动桥接端点（必须 await：端口在 listening 事件后才可用）。 */
export async function startExtensionBridgeServer(manager: ExtensionHostManager): Promise<BridgeServer> {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    void handle(req, res, manager, token);
  });
  // listen 是异步的：不等 listening 事件就读 address() 会拿到 null（端口 0，
  // 调用方连接即 EADDRNOTAVAIL —— 曾踩坑）。
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const info = server.address() as { port: number } | null;
  const port = info?.port ?? 0;
  log('ext-host', `Core Bridge 端点已启动：127.0.0.1:${port}`);
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close(): void {
      server.close();
    },
  };
}

/** 读取 JSON 请求体（带上限，超限 413）。 */
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: ExtensionHostManager,
  token: string,
): Promise<void> {
  try {
    if (req.method !== 'POST' || !req.url) {
      json(res, 404, { ok: false, error: 'not found' });
      return;
    }
    // 鉴权：token 放头或体（桥接组件统一走 x-eac-token 头）。
    if (req.headers['x-eac-token'] !== token) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const body = await readBody(req);
    switch (req.url) {
      case '/tools': {
        json(res, 200, { ok: true, tools: manager.allToolMetas() });
        return;
      }
      case '/invoke': {
        const pluginId = String(body.pluginId ?? '');
        const tool = String(body.tool ?? '');
        if (!pluginId || !tool) {
          json(res, 400, { ok: false, error: 'pluginId/tool 必填' });
          return;
        }
        try {
          const result = await manager.invoke(pluginId, tool, body.args, INVOKE_TIMEOUT_MS);
          json(res, 200, { ok: true, result: result ?? null });
        } catch (err) {
          // 工具失败返回错误文本：Agent 可见，核心回合继续。
          json(res, 200, { ok: false, error: String((err as Error).message).slice(0, 500) });
        }
        return;
      }
      case '/context': {
        const sessionId = String(body.sessionId ?? '');
        const contributions = await manager.collectContexts(sessionId);
        json(res, 200, { ok: true, contributions });
        return;
      }
      default:
        json(res, 404, { ok: false, error: 'not found' });
    }
  } catch (err) {
    json(res, 400, { ok: false, error: String((err as Error).message).slice(0, 300) });
  }
}
