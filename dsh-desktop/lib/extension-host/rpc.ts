/**
 * lib/extension-host/rpc.ts — 长度前缀帧 JSON-RPC（VNext Phase 2，Task 10.1）。
 *
 * 线协议（spec F2.3「RPC 快路径」）：
 *   [4 字节小端长度][UTF-8 JSON] 一帧一消息；超 4MB 断流（防恶意 Host）。
 *   消息三态：req（需应答，nanoid 关联）/ res / notify（单向：事件+心跳合流，
 *   避免高频小包拆 JSON 行的解析/GC 压力）。
 *
 * RpcPeer 双向对称：Supervisor 与 host-bootstrap 各持一端，spawn 的 stdio
 * 管道即传输层 —— 不依赖任何 socket，天然本地隔离。
 */

import type { Writable } from 'node:stream';
import { nanoid } from 'nanoid';
import type { RpcMessage, RpcRequest, RpcResponse } from '../../shared/protocol.js';
import { RPC_MAX_FRAME_BYTES } from '../../shared/protocol.js';

/** 单帧编码：长度前缀（小端 u32）+ JSON。 */
export function encodeFrame(msg: RpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * 流式帧解码器：push(chunk) 吐出完整消息；半帧缓存到下一块。
 * 超限/非法长度抛错（调用方据此断开 Host）。
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RpcMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: RpcMessage[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32LE(0);
      if (len > RPC_MAX_FRAME_BYTES) {
        throw new Error(`RPC 帧超限（${len} > ${RPC_MAX_FRAME_BYTES}），断开`);
      }
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      const msg = JSON.parse(body) as RpcMessage;
      if (msg.kind !== 'req' && msg.kind !== 'res' && msg.kind !== 'notify') {
        throw new Error('RPC 消息缺少 kind 字段，断开');
      }
      out.push(msg);
    }
    return out;
  }
}

/** handler 签名：参数 → 结果（抛错转为 error 响应）。 */
export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

/** RpcPeer 配置。 */
export interface RpcPeerOpts {
  /** 对端可写流（Supervisor 侧 = child.stdin；Host 侧 = process.stdout）。 */
  write: Writable;
  /** 请求超时（ms，默认 10s；同步扩展调用按架构文档须严格超时）。 */
  defaultTimeoutMs?: number;
  /** 对端断开/协议错误的回调。 */
  onClosed?: (reason: string) => void;
  /** 通知回调（method 分发前先给这里）。 */
  onNotify?: (method: string, params: unknown) => void;
}

/** 双向 RPC 端点。 */
export class RpcPeer {
  private readonly write: Writable;
  /** 常驻解码器：跨 chunk 的半帧缓存在这里（feed 复用，不可每帧新建）。 */
  private readonly decoder = new FrameDecoder();
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly onClosed: ((reason: string) => void) | undefined;
  private readonly onNotify: ((method: string, params: unknown) => void) | undefined;
  private closed = false;

  constructor(opts: RpcPeerOpts) {
    this.write = opts.write;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
    this.onClosed = opts.onClosed;
    this.onNotify = opts.onNotify;
  }

  /** 注册方法处理器（对端 req 到达时分发）。 */
  handle(method: string, fn: RpcHandler): void {
    this.handlers.set(method, fn);
  }

  /** 发送通知（无需应答）。 */
  notify(method: string, params?: unknown): void {
    this.send({ kind: 'notify', method, params });
  }

  /** 发起请求：超时拒绝（默认 10s），closed 后立即拒绝。 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('RPC peer closed'));
        return;
      }
      const id = nanoid();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 超时: ${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.send({ kind: 'req', id, method, params });
    });
  }

  /** 喂入对端数据（把 child.stdout/stderr 或 stdin 数据接进来）。 */
  feed(chunk: Buffer): void {
    let msgs: RpcMessage[];
    try {
      msgs = this.decoder.push(chunk);
    } catch (err) {
      this.close('protocol-error: ' + String((err as Error).message));
      return;
    }
    for (const m of msgs) void this.dispatch(m);
  }

  /** 标记断开：拒绝全部在途请求。 */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('RPC 对端断开: ' + reason));
    }
    this.pending.clear();
    this.onClosed?.(reason);
  }

  isClosed(): boolean {
    return this.closed;
  }

  private send(msg: RpcMessage): void {
    if (this.closed) return;
    try {
      this.write.write(encodeFrame(msg));
    } catch (err) {
      this.close('write-failed: ' + String((err as Error).message));
    }
  }

  private async dispatch(m: RpcMessage): Promise<void> {
    if (m.kind === 'notify') {
      this.onNotify?.(m.method, m.params);
      return;
    }
    if (m.kind === 'res') {
      const p = this.pending.get(m.id);
      if (!p) return; // 已超时：丢弃迟到响应
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error ?? 'RPC 远端错误'));
      return;
    }
    // req：分发 handler
    const h = this.handlers.get((m as RpcRequest).method);
    if (!h) {
      this.send({ kind: 'res', id: (m as RpcRequest).id, ok: false, error: 'unknown method: ' + (m as RpcRequest).method });
      return;
    }
    try {
      const result = await h((m as RpcRequest).params);
      const res: RpcResponse = { kind: 'res', id: (m as RpcRequest).id, ok: true };
      if (result !== undefined) res.result = result;
      this.send(res);
    } catch (err) {
      this.send({
        kind: 'res', id: (m as RpcRequest).id, ok: false,
        error: String((err as Error).message ?? err),
      });
    }
  }
}
