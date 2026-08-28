'use strict';
// DSH 手机连接桥（sidecar 层，Tauri 壳运行期）。
//
// 参照上游 dsh-desktop 的「手机访问 = 扫码配对 + 白名单 RPC 续聊桥」架构
// （非 scrcpy 类屏幕远控）：本模块在 sidecar 上开一个 0.0.0.0 的 LAN HTTP
// 端口，只暴露配对/状态/白名单 RPC 三条面，Harness 本体仍只在 127.0.0.1
// 回环监听，绝不把内核 Web 服务绑到公网接口。
//
// 本版本（5.1.1）落地完整配对链路与接口契约，但手机端 UI 为占位页
// 「手机端正在开发中」——客户端接入点（/、/api/rpc、cookie）全部保留，
// 供后续移动端接入时直接使用：
//   /pair?token=…        配对：一次性 token（5 分钟 TTL，timingSafeEqual 比对）
//   /api/pair-state?token=… 手机端轮询配对状态；approved 时下发 dsh_mobile cookie
//   /desktop/decide       桌面端批准（仅回环可达）
//   /desktop/disconnect   桌面端断开（仅回环可达；轮换 token，手机端立即失效）
//   /api/rpc              白名单 RPC 转发到内核（需 dsh_mobile cookie）
//   /                     手机端占位页（PWA meta；「手机端正在开发中」）
//
// 安全边界：配对 token 一次性 + 5min TTL + 常量时间比对；approve/decide/
// disconnect 仅接受回环来源；dsh_mobile cookie HttpOnly + SameSite=Strict，
// 一年有效期；RPC 白名单仅放行会话/模型/工作区只读或明确的用户动作。

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const PAIRING_TTL_MS = 5 * 60 * 1000;
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 一年
const RPC_ALLOWLIST = new Set([
  'workspace.list',
  'agentPreset.list',
  'agentPreset.select',
  'session.list',
  'session.history',
  'session.models',
  'session.selectModel',
  'session.create',
  'session.prompt',
  'session.cancel',
]);

export interface PhoneBridgeOptions {
  getWebUrl: () => string | null;
  log: (message: string) => void;
}

export interface PhoneStatus {
  running: boolean;
  port: number;
  lanUrl: string;
  mobileReady: boolean;
  pairing: {
    state: 'idle' | 'waiting' | 'approved' | 'expired';
    expiresAt: number | null;
  };
}

interface PairingState {
  token: string;
  expiresAt: number;
  decided: boolean | null; // null=未决, true=批准, false=拒绝
}

// 挑一个手机可达的 LAN IPv4：优先 RFC1918 私网地址（192.168/10./172.16-31，
// 普通家用/办公 Wi-Fi 网段），其次任意非回环地址（含 169.254 链路本地——DHCP
// 失败时的兜底，本机可达、同网段手机通常也可达），最后回环。旧实现直接取第一
// 个非回环地址，经常选中虚拟网卡/APIPA 的 169.254.x，手机扫出来的地址连不上。
// interfaces 参数仅为测试注入 fake 网卡表（生产调用不传，走 os.networkInterfaces）。
export function lanAddress(interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string {
  const ifaces = interfaces ?? os.networkInterfaces();
  let fallback: string | null = null;
  for (const name of Object.keys(ifaces)) {
    for (const entry of ifaces[name] ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address;
      if (fallback === null) fallback = ip;
      const p = ip.split('.').map((s) => Number(s));
      if (p.length !== 4 || p.some((n) => Number.isNaN(n))) continue;
      const a = p[0] ?? -1;
      const b = p[1] ?? -1;
      const rfc1918 =
        a === 10 ||
        (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31);
      if (rfc1918) return ip;
    }
  }
  return fallback ?? '127.0.0.1';
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function tokenEquals(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// 手机端续聊客户端（单文件静态页，随 sidecar 分发；与 phone-bridge.js 同级，
// stage-resources 的 sidecar 清单已含 mobile-app.html）。读盘失败时回退占位页。
let mobileClientHtml: string | null = null;
function mobileClientPage(): string {
  if (mobileClientHtml !== null) return mobileClientHtml;
  try {
    mobileClientHtml = fs.readFileSync(path.join(__dirname, 'mobile-app.html'), 'utf8');
  } catch {
    mobileClientHtml = mobilePlaceholderPage();
  }
  return mobileClientHtml;
}

function mobilePlaceholderPage(): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="theme-color" content="#111418">',
    '<title>DSH Mobile</title>',
    '<style>',
    'body{margin:0;background:#111418;color:#e8eaed;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px;box-sizing:border-box}',
    '.card{max-width:420px;background:#1c2128;border:1px solid #2b333d;border-radius:16px;padding:32px 24px}',
    'h1{font-size:20px;margin:0 0 12px}',
    'p{font-size:14px;line-height:1.7;color:#aab2bd;margin:0}',
    '.badge{display:inline-block;margin-top:16px;background:#2a3340;color:#9ecbff;border-radius:999px;padding:4px 12px;font-size:12px}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="card">',
    '<h1>DSH Mobile</h1>',
    '<p>手机端客户端正在开发中，敬请期待。<br>配对与接口已就绪，移动端接入后将自动可用。</p>',
    '<span class="badge">开发中</span>',
    '</div>',
    '</body>',
    '</html>',
  ].join('');
}

function pairingWaitPage(): string {
  const script = [
    'var poll=function(){',
    "fetch('/api/pair-state?token='+encodeURIComponent(location.search.match(/[?&]token=([^&]+)/)[1]))",
    ".then(function(r){return r.json()})",
    ".then(function(s){if(s.state==='approved'){location.href='/'}else if(s.state==='expired'){",
    "document.getElementById('st').textContent='配对已过期，请在电脑端重新发起配对。'}})",
    ".catch(function(){})",
    '};',
    'setInterval(poll,1200);poll();',
  ].join('');
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>配对验证</title>',
    '<style>body{margin:0;background:#111418;color:#e8eaed;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{max-width:360px;background:#1c2128;border:1px solid #2b333d;border-radius:16px;padding:28px 22px;text-align:center}h1{font-size:18px;margin:0 0 10px}p{font-size:14px;color:#aab2bd;line-height:1.7;margin:0}</style>',
    `</head><body><div class="card"><h1>正在建立配对</h1><p id="st">请在电脑端确认配对后，本页将自动跳转。</p></div><script>${script}</script></body></html>`,
  ].join('');
}

export function createPhoneBridge(options: PhoneBridgeOptions) {
  const { getWebUrl, log } = options;
  let server: http.Server | null = null;
  let port = 0;
  let lanUrl = '';
  let pairing: PairingState | null = null;
  let mobileReady = true; // 手机端续聊客户端已随 sidecar 内置分发

  function rotatePairing(): void {
    pairing = {
      token: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      decided: null,
    };
  }

  function currentPairingState(): 'idle' | 'waiting' | 'approved' | 'expired' {
    if (!server || pairing === null) return 'idle';
    if (pairing.decided === true) return 'approved';
    if (Date.now() > pairing.expiresAt) return 'expired';
    return 'waiting';
  }

  function forwardRpc(method: string, params: unknown): Promise<{ status: number; body: unknown }> {
    const base = getWebUrl();
    if (!base) return Promise.resolve({ status: 503, body: { error: 'harness web service is not running' } });
    return new Promise((resolve) => {
      let url: URL;
      try {
        url = new URL(`/api/${method}`, base);
      } catch {
        resolve({ status: 400, body: { error: 'bad kernel web url' } });
        return;
      }
      // 内核只认 dsh-host-apiproxy 的 client-request 信封（docs/MOBILE-CLIENT-DEV-SPEC.md §4.1）；
      // 旧实现把手机端 body 原样转发，内核信封校验失败恒 400 bad-request。
      const envelope = JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload: params === undefined ? {} : params,
      });
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: 'POST',
          agent: false, // 短连接：桥是低频转发方，不留 keep-alive 池
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(envelope),
            connection: 'close',
          },
        },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status !== 200) {
              resolve({ status, body: { ok: false, error: { code: `http-${status}`, message: raw.slice(0, 200) || `kernel http ${status}` } } });
              return;
            }
            let parsed: unknown = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
            // server-response 解包：result.ok===true 取 value；ok===false 透传业务错误；
            // 非 server-response 形状（个别窄路径直接回业务对象）按原值放行。
            const outer = parsed as { type?: string; result?: { ok?: boolean; value?: unknown; error?: unknown } } | null;
            if (outer && outer.type === 'server-response' && outer.result && typeof outer.result === 'object') {
              if (outer.result.ok === true) resolve({ status: 200, body: { ok: true, value: outer.result.value } });
              else resolve({ status: 200, body: { ok: false, error: outer.result.error ?? { code: 'unknown', message: 'unknown kernel error' } } });
              return;
            }
            resolve({ status: 200, body: { ok: true, value: parsed } });
          });
          res.on('error', () => resolve({ status: 502, body: { error: 'forward stream failed' } }));
        },
      );
      req.setTimeout(30_000, () => req.destroy(new Error('forward timeout')));
      req.on('error', (error: Error) => resolve({ status: 502, body: { error: `forward failed: ${error.message}` } }));
      req.end(envelope);
    });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const readJson = async (): Promise<unknown> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    };

    if (req.method === 'GET' && (path === '/' || path === '/app')) {
      // 手机端续聊客户端（单文件静态页，随 sidecar 分发；docs/MOBILE-CLIENT-DEV-SPEC.md §5）。
      const page = mobileClientPage();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self' 'unsafe-inline'",
        'content-length': Buffer.byteLength(page),
      });
      res.end(page);
      return;
    }

    if (req.method === 'GET' && path === '/pair') {
      if (pairing === null || !tokenEquals(url.searchParams.get('token') ?? '', pairing.token)) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h3>配对链接无效</h3><p>请在电脑端重新发起「连接手机」配对。</p>');
        return;
      }
      if (Date.now() > pairing.expiresAt) {
        res.writeHead(410, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h3>配对已过期</h3><p>请在电脑端重新发起配对。</p>');
        return;
      }
      const page = pairingWaitPage();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-length': Buffer.byteLength(page),
      });
      res.end(page);
      return;
    }

    if (req.method === 'GET' && path === '/api/pair-state') {
      if (pairing === null || !tokenEquals(url.searchParams.get('token') ?? '', pairing.token)) {
        json(res, 403, { error: 'invalid token' });
        return;
      }
      const state = currentPairingState();
      const headers: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
      };
      if (state === 'approved') {
        // 配对成功即签发一年期 dsh_mobile 会话 cookie（移动端随后继访问携带）。
        headers['set-cookie'] =
          `dsh_mobile=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
      }
      const payload = JSON.stringify({ state, expiresAt: pairing.expiresAt });
      res.writeHead(200, headers);
      res.end(payload);
      return;
    }

    if (req.method === 'POST' && path === '/api/rpc') {
      const cookies = (req.headers.cookie ?? '').split(';').map((c) => c.trim());
      if (!cookies.some((c) => c === 'dsh_mobile=1')) {
        json(res, 401, { error: 'not paired' });
        return;
      }
      let body: { method?: unknown; params?: unknown; payload?: unknown };
      try {
        body = (await readJson()) as { method?: unknown; params?: unknown; payload?: unknown };
      } catch {
        json(res, 400, { error: 'invalid json body' });
        return;
      }
      if (typeof body.method !== 'string' || !RPC_ALLOWLIST.has(body.method)) {
        json(res, 400, { error: 'method not allowed' });
        return;
      }
      const forwarded = await forwardRpc(body.method, body.params !== undefined ? body.params : body.payload);
      json(res, forwarded.status, forwarded.body);
      return;
    }

    if (path === '/desktop/decide' || path === '/desktop/disconnect') {
      if (!isLoopback(req.socket?.remoteAddress)) {
        json(res, 403, { error: 'loopback only' });
        return;
      }
      if (path === '/desktop/decide') {
        if (pairing === null || pairing.decided !== null) {
          json(res, 409, { error: 'no pending pairing' });
          return;
        }
        let body: { approved?: unknown };
        try {
          body = (await readJson()) as { approved?: unknown };
        } catch {
          json(res, 400, { error: 'invalid json body' });
          return;
        }
        pairing.decided = body.approved === true;
        log(`phone bridge: pairing ${pairing.decided ? 'approved' : 'rejected'} by desktop`);
        json(res, 200, { ok: true, approved: pairing.decided });
        return;
      }
      rotatePairing();
      log('phone bridge: disconnected; pairing token rotated');
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: 'not found' });
  }

  return {
    /** 启动 LAN 桥并轮换配对 token。幂等：已运行则返回当前状态。 */
    start(): Promise<{ url: string; port: number }> {
      if (server !== null) {
        const pending = pairing;
        if (!pending) rotatePairing();
        return Promise.resolve({ url: lanUrl + '/pair?token=' + (pairing?.token ?? ''), port });
      }
      rotatePairing();
      return new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          handle(req, res).catch((error: unknown) => {
            try {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) });
            } catch {
              res.destroy();
            }
          });
        });
        s.on('error', (error) => reject(error));
        s.listen(0, '0.0.0.0', () => {
          const address = s.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('phone bridge: failed to bind'));
            return;
          }
          server = s;
          port = address.port;
          lanUrl = `http://${lanAddress()}:${port}`;
          log(`phone bridge: listening on ${lanUrl} (pairing token TTL 5min)`);
          resolve({ url: `${lanUrl}/pair?token=${pairing?.token ?? ''}`, port });
        });
      });
    },
    /** 停止 LAN 桥并清空配对状态。 */
    stop(): Promise<void> {
      return new Promise((resolve) => {
        const s = server;
        server = null;
        port = 0;
        lanUrl = '';
        pairing = null;
        if (!s) {
          resolve();
          return;
        }
        // 断开全部 keep-alive 连接，否则 server.close() 会一直等待空闲连接。
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
        s.close(() => resolve());
      });
    },
    status(): PhoneStatus {
      return {
        running: server !== null,
        port,
        lanUrl,
        mobileReady,
        pairing: {
          state: currentPairingState(),
          expiresAt: pairing ? pairing.expiresAt : null,
        },
      };
    },
    /** 桌面端批准/拒绝一次待决配对（RPC 面，WS 桥本身回环）。 */
    decide(approved: boolean): { ok: boolean; error?: string; approved?: boolean } {
      if (pairing === null || pairing.decided !== null) {
        return { ok: false, error: 'no pending pairing' };
      }
      pairing.decided = approved === true;
      log(`phone bridge: pairing ${pairing.decided ? 'approved' : 'rejected'} via desktop RPC`);
      return { ok: true, approved: pairing.decided };
    },
    /** 桌面端断开：轮换配对 token 并清空决定，手机端既有 cookie 立即失效。 */
    disconnect(): { ok: boolean } {
      rotatePairing();
      log('phone bridge: disconnected via desktop RPC; pairing token rotated');
      return { ok: true };
    },
  };
}

export default createPhoneBridge;