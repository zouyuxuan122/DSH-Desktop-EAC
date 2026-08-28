// dsh-phone — host half：为设置页「连接手机」提供 qrcode 静态脚本路由。
// 手机桥本体在 Tauri 壳 sidecar（tauri-shell/sidecar/phone-bridge.js），
// 本插件只负责 Web UI 入口 + 二维码渲染所需脚本。
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const name = 'dsh-phone';
export const inject = ['webServer'];

const QRCODE_PATH = '/plugins/dsh-phone/qrcode.js';

export function apply(ctx, config) {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: QRCODE_PATH,
        handler: (req, res) => {
          try {
            // 插件从 profile node_modules/dsh-phone 加载：qrcode.js 与 index.js 同目录。
            const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qrcode.js');
            const content = fs.readFileSync(file, 'utf8');
            res.writeHead(200, {
              'content-type': 'application/javascript; charset=utf-8',
              'cache-control': 'public, max-age=86400',
              'content-length': Buffer.byteLength(content),
            });
            res.end(content);
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('qrcode.js 读取失败: ' + String((error && error.message) || error));
          }
        },
      }),
      'dsh-phone: qrcode route',
    );
  });
}

export default apply;