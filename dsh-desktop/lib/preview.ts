/**
 * lib/preview.ts — 本地预览静态文件服务（Task 2.4 自 main.js 提取）。
 *
 * 仅监听 127.0.0.1 随机端口的极简静态服务：供 Web UI 以 http URL 预览
 * 本地文件（file: 直开会被 CSP/跨源限制）。安全边界：只回环地址、只
 * GET/HEAD、路径必须绝对、无目录列举、no-store。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { state } from './state.js';
import { log } from './log.js';

/** 扩展名 → MIME 映射（预览所需的最小集合）。 */
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
};

/** 文本类 MIME 追加 charset=utf-8 的判定正则。 */
const TEXT_MIME = /^(text\/|application\/(json|javascript|xhtml\+xml|xml)|image\/svg)/;

/** 启动预览静态服务（127.0.0.1 随机端口，写入 state.previewStaticPort）。 */
export function startPreviewStaticServer(): void {
  const server = http.createServer((req, res) => {
    const ra = req.socket && req.socket.remoteAddress;
    if (ra !== '127.0.0.1' && ra !== '::1' && ra !== '::ffff:127.0.0.1') {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let p: string;
    try {
      p = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(1));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    if (!path.isAbsolute(p)) {
      res.writeHead(400);
      res.end();
      return;
    }
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const mime = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, {
        'content-type': TEXT_MIME.test(mime) ? mime + '; charset=utf-8' : mime,
        'content-length': String(st.size),
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(p).pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    state.previewStaticPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
    log('boot', '预览静态服务已启动: http://127.0.0.1:' + state.previewStaticPort);
  });
  server.on('error', (err) => log('boot', '预览静态服务失败: ' + String((err as Error).message)));
}
