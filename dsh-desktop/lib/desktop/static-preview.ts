'use strict';

// 预览静态文件服务（ADR 0002 L2 业务服务层；Wave 2 自 static-preview.js
// 类型化迁出，行为零变更）：独立端口的只读文件服务，供「站内 HTML 预览」
// 的 iframe 使用。为什么要独立端口：浏览器对同一主机 HTTP/1.1 并发连接上限
// 6，web UI 自身长连接已占满；预览 iframe 及其相对资源若走 dsh 宿主会被
// 排队。仅接受回环。

import path = require('node:path');
import fs = require('node:fs');
import http = require('node:http');
import type { IncomingMessage, ServerResponse } from 'node:http';
const bundleIntegrity = require('../../bundle-integrity') as {
  verifyBundle(dir: string, manifest: unknown): { skipped: boolean; ok: boolean; damaged: { name: string; reason: string }[] };
};

/** 注入接口：由宿主（Electron main / Tauri sidecar）在启动时提供。 */
export interface StaticPreviewCtx {
  log(tag: string, msg: string): void;
  showBox(opts: Record<string, unknown>): Promise<{ response: number }>;
  exitDamaged(): void;
  isPackaged?(): boolean;
  resourcesPath?(): string;
}

let ctx!: StaticPreviewCtx;
export function init(d: StaticPreviewCtx): void { ctx = d; }
function isPackaged(): boolean {
  return typeof ctx.isPackaged === 'function' ? !!ctx.isPackaged() : false;
}
function resourcesDir(): string {
  return typeof ctx.resourcesPath === 'function' ? ctx.resourcesPath() : '';
}

let previewStaticPort = 0;
export function getPreviewStaticPort(): number { return previewStaticPort; }

export function startPreviewStaticServer(): void {
  const MIME: Record<string, string> = {
    ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
    ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
    ".json": "application/json", ".map": "application/json", ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf", ".xml": "application/xml"
  };
  const TEXT_MIME = /^(text\/|application\/(json|javascript|xhtml\+xml|xml)|image\/svg)/;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const ra = req.socket && req.socket.remoteAddress;
    if (ra !== "127.0.0.1" && ra !== "::1" && ra !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    let p: string;
    try {
      p = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname.slice(1));
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
      const mime = MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "content-type": TEXT_MIME.test(mime) ? mime + "; charset=utf-8" : mime,
        "content-length": String(st.size),
        "cache-control": "no-store"
      });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(p).pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1", () => {
    previewStaticPort = server.address() && typeof server.address() === 'object'
      ? (server.address() as { port: number }).port : 0;
    ctx.log("boot", "预览静态服务已启动: http://127.0.0.1:" + previewStaticPort);
  });
  server.on("error", (err) => ctx.log("boot", "预览静态服务失败: " + err.message));
}

// Issue #7: verify the bundled node_modules against the build-time manifest
// before starting dsh web. A botched upgrade leaves empty package skeletons;
// Node then dies with ERR_MODULE_NOT_FOUND in a loop. Tell the user to
// reinstall instead (with an escape hatch to continue anyway).
export function verifyBundledModules(): Promise<void> {
  if (!isPackaged()) return Promise.resolve();
  const appDir = path.join(resourcesDir(), 'app');
  const manifestPath = path.join(appDir, 'bundle-manifest.json');
  let manifest: unknown = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return Promise.resolve(); }
  const r = bundleIntegrity.verifyBundle(path.join(appDir, 'node_modules'), manifest);
  if (r.skipped || r.ok) return Promise.resolve();
  const sample = r.damaged.slice(0, 5).map((d) => `${d.name}（${d.reason}）`).join('、');
  ctx.log('boot', `捆绑依赖完整性校验失败（${r.damaged.length} 个包受损）: ${sample}${r.damaged.length > 5 ? ' 等' : ''}`);
  return ctx.showBox({
    type: 'error',
    title: '程序文件受损',
    message: `检测到 ${r.damaged.length} 个捆绑依赖包文件缺失，可能是升级中断或安全软件清理所致。`,
    detail: `受损包: ${sample}${r.damaged.length > 5 ? `（共 ${r.damaged.length} 个）` : ''}\n\n建议重新下载安装包覆盖安装（GitHub Releases 最新版）。\n选择「仍然启动」大概率无法正常运行。`,
    buttons: ['仍然启动', '退出'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response !== 0) {
      ctx.exitDamaged(); // 用户选择退出：不让看门狗拉起一个已知损坏的安装
    }
  });
}
