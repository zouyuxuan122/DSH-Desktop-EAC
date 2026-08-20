/**
 * types-ws.d.ts — ws（electron-builder 的传递依赖，无独立 @types 入库）的
 * 最小 ambient 垫片，仅覆盖 e2e 脚本（scripts/e2e-*.ts）用到的 API。
 */
declare module 'ws' {
  import { EventEmitter } from 'node:events';

  export interface WebSocketOptions {
    perMessageDeflate?: boolean;
  }

  export class WebSocket extends EventEmitter {
    constructor(url: string, opts?: WebSocketOptions);
    send(data: string): void;
    close(): void;
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: Buffer) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }
}
