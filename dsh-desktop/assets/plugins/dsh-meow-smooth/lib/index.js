// src/notify-host.ts
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var EVENTS_TTL_MS = 10 * 6e4;
var EVENTS_CAP = 20;
var SUBSCRIPTIONS_CAP = 64;
var TITLE_MAX = 20;
function dataDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, ".meow-smooth");
}
function sessionTitleFromEvents(events) {
  if (!Array.isArray(events)) return "";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "session/title" && typeof event.data?.title === "string" && event.data.title !== "") {
      return event.data.title;
    }
  }
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    const data = event.data;
    const text = data?.content?.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join(" ").replace(/\s+/g, " ").trim();
    if (text !== void 0 && text !== "") {
      return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}\u2026` : text;
    }
  }
  return "";
}
function pngIcon() {
  const size = 180;
  const top = [79, 70, 229];
  const bottom = [49, 46, 129];
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1);
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const off = row + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
function iconPng(size) {
  try {
    return readFileSync(new URL(`../assets/icon-${size}.png`, import.meta.url));
  } catch {
    return pngIcon();
  }
}
function swSource() {
  return [
    "/* meow-smooth service worker: push notification bridge */",
    "self.addEventListener('install', () => { self.skipWaiting() })",
    "self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })",
    "self.addEventListener('push', (event) => {",
    "  let data = {}",
    "  try { data = event.data ? event.data.json() : {} } catch { /* non-JSON payload ignored */ }",
    "  const title = data.title || 'dsh'",
    "  event.waitUntil((async () => {",
    "    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })",
    "    const origin = new URL(self.registration.scope).origin",
    "    const focused = clients.some(c => c.focused === true && new URL(c.url).origin === origin)",
    "    if (focused) return",
    "    await self.registration.showNotification(title, {",
    "      body: data.body || '',",
    "      tag: data.tag || 'meow-' + Date.now(),",
    "      icon: '/plugins/meow-smooth/icon-180.png',",
    "      data: { sessionId: data.sessionId || null },",
    "      requireInteraction: data.kind === 'approval' || data.kind === 'question',",
    "    })",
    "  })())",
    "})",
    "self.addEventListener('notificationclick', (event) => {",
    "  event.notification.close()",
    "  const origin = new URL(self.registration.scope).origin",
    "  const sessionId = event.notification.data && event.notification.data.sessionId",
    "  event.waitUntil((async () => {",
    "    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })",
    "    for (const client of windows) {",
    "      if (new URL(client.url).origin !== origin) continue",
    "      await client.focus()",
    "      if (sessionId) client.postMessage({ type: 'meow-smooth:jump', sessionId })",
    "      return",
    "    }",
    "    const win = await self.clients.openWindow(new URL('/', self.registration.scope).href)",
    "    if (sessionId && win) win.postMessage({ type: 'meow-smooth:jump', sessionId })",
    "  })())",
    "})"
  ].join("\n");
}
function manifestSource() {
  return JSON.stringify({
    name: "dsh meow",
    short_name: "dsh",
    display: "standalone",
    start_url: "/",
    scope: "/",
    icons: [
      { src: "/plugins/meow-smooth/icon-180.png", sizes: "180x180", type: "image/png" },
      { src: "/plugins/meow-smooth/icon-512.png", sizes: "512x512", type: "image/png" }
    ]
  });
}
function installNotifyHost(ctx, config) {
  const threshold = typeof config?.longTaskToolCalls === "number" && config.longTaskToolCalls > 0 ? config.longTaskToolCalls : 7;
  const completions = [];
  const turnCalls = /* @__PURE__ */ new Map();
  const completionEvents = () => {
    const cutoff = Date.now() - EVENTS_TTL_MS;
    while (completions.length > 0 && completions[0].at < cutoff) completions.shift();
    return completions;
  };
  let pushMod;
  let vapidPublicKey = config?.vapidPublicKey;
  let vapidPrivateKey = config?.vapidPrivateKey;
  let pushReady;
  const ensurePush = () => {
    pushReady ??= (async () => {
      try {
        const imported = await import("web-push");
        const mod = imported.default ?? imported;
        if (vapidPublicKey === void 0 || vapidPrivateKey === void 0) {
          const dir = dataDir();
          const file = join(dir, "vapid.json");
          if (existsSync(file)) {
            const saved = JSON.parse(readFileSync(file, "utf8"));
            vapidPublicKey = saved.publicKey;
            vapidPrivateKey = saved.privateKey;
          }
        }
        if (vapidPublicKey === void 0 || vapidPrivateKey === void 0) {
          const keys = mod.generateVAPIDKeys();
          vapidPublicKey = keys.publicKey;
          vapidPrivateKey = keys.privateKey;
          mkdirSync(dataDir(), { recursive: true });
          writeFileSync(join(dataDir(), "vapid.json"), JSON.stringify(keys, null, 2), "utf8");
        }
        mod.setVapidDetails("https://github.com/Phant0Meow/dsh-meow-smooth", vapidPublicKey, vapidPrivateKey);
        pushMod = mod;
        return true;
      } catch (error) {
        console.warn(`[meow-smooth] web push unavailable: ${String(error).slice(0, 160)}`);
        return false;
      }
    })();
    return pushReady;
  };
  const pushEnabled = () => pushMod !== void 0;
  const subscriptionsFile = join(dataDir(), "subscriptions.json");
  let subscriptions = [];
  const diagLog = [];
  try {
    if (existsSync(subscriptionsFile)) {
      const parsed = JSON.parse(readFileSync(subscriptionsFile, "utf8"));
      if (Array.isArray(parsed)) subscriptions = parsed.slice(0, SUBSCRIPTIONS_CAP);
    }
  } catch {
    subscriptions = [];
  }
  const saveSubscriptions = () => {
    try {
      mkdirSync(dataDir(), { recursive: true });
      writeFileSync(subscriptionsFile, JSON.stringify(subscriptions.slice(0, SUBSCRIPTIONS_CAP), null, 2), "utf8");
    } catch {
    }
  };
  const FOCUS_WINDOW_MS = 3e3;
  const focusedByHost = /* @__PURE__ */ new Map();
  const noteFocus = (host, focused) => {
    if (typeof host !== "string" || host === "") return;
    if (focused) focusedByHost.set(host, Date.now());
    else focusedByHost.delete(host);
  };
  const anyFocusedRecently = () => {
    const cutoff = Date.now() - FOCUS_WINDOW_MS;
    for (const [host, at] of focusedByHost) {
      if (at >= cutoff) return true;
      focusedByHost.delete(host);
    }
    return false;
  };
  const sendPush = async (payload) => {
    if (!await ensurePush() || subscriptions.length === 0) return false;
    let delivered = false;
    const body = JSON.stringify(payload);
    for (const sub of subscriptions) {
      try {
        await pushMod.sendNotification(sub, body, { TTL: 3600 });
        delivered = true;
      } catch (error) {
        const status = error?.statusCode;
        if (status === 404 || status === 410) {
          subscriptions = subscriptions.filter((item) => item.endpoint !== sub.endpoint);
          saveSubscriptions();
        } else {
          console.warn(`[meow-smooth] push failed (${status ?? "unknown"}): ${String(error).slice(0, 160)}`);
        }
      }
    }
    return delivered;
  };
  const deliver = async (payload) => {
    if (anyFocusedRecently()) return;
    const delivered = await sendPush(payload);
    if (!delivered) sendWebhook(payload);
  };
  const webhookUrl = config?.webhookUrl;
  const webhookIconUrl = config?.webhookIconUrl;
  const webhookAppUrl = config?.webhookAppUrl;
  const sendWebhook = (payload) => {
    if (typeof webhookUrl !== "string" || webhookUrl === "") return;
    try {
      const body = { ...payload, group: "dsh" };
      if (typeof webhookIconUrl === "string" && webhookIconUrl !== "") body.icon = webhookIconUrl;
      if (typeof webhookAppUrl === "string" && webhookAppUrl !== "") body.url = webhookAppUrl;
      void fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }).catch(() => {
      });
    } catch {
    }
  };
  const titleCache = /* @__PURE__ */ new Map();
  const sessionTitle = (sessionId) => {
    const cached = titleCache.get(sessionId);
    if (cached !== void 0) return cached;
    let title = "";
    try {
      const session = ctx?.sessions?.get?.(sessionId);
      title = sessionTitleFromEvents(session?.events);
    } catch {
      title = "";
    }
    titleCache.set(sessionId, title);
    return title;
  };
  const PUSH_DEDUP_KEY = "__meow_smooth_push_dedup__";
  const recentPushes = globalThis[PUSH_DEDUP_KEY] ?? /* @__PURE__ */ new Map();
  globalThis[PUSH_DEDUP_KEY] = recentPushes;
  const pushOnce = (key, fn) => {
    const now = Date.now();
    const last = recentPushes.get(key);
    if (last !== void 0 && now - last < 3e3) return;
    recentPushes.set(key, now);
    if (recentPushes.size > 200) {
      const cutoff = now - 6e4;
      for (const [k, at] of recentPushes) {
        if (at < cutoff) recentPushes.delete(k);
      }
    }
    fn();
  };
  if (typeof ctx.on === "function") {
    ctx.on("session/event", (session, event) => {
      try {
        const sessionId = session?.id ?? "";
        if (sessionId === "") return;
        const data = event?.data;
        if (event?.type === "turn/start") {
          turnCalls.set(sessionId, { turn: data?.turn ?? 0, calls: 0 });
          return;
        }
        if (event?.type === "tool/call") {
          const current = turnCalls.get(sessionId);
          if (current !== void 0 && (data?.turn === void 0 || data.turn === current.turn)) {
            current.calls += 1;
          }
          if (data?.name === "ask_user_question") {
            const callId = data.callId ?? "";
            const title = sessionTitle(sessionId);
            const payload = {
              kind: "question",
              title: title === "" ? "\u672A\u547D\u540D\u4F1A\u8BDD" : title,
              body: "\u6709\u63D0\u95EE\u5F85\u56DE\u7B54\uFF0C\u70B9\u51FB\u67E5\u770B\u2026",
              // tag 与 client 页面内通知统一（q:<sessionId>:question）：
              // 2026-08-20 修双弹——此前 q:<sessionId>:<callId> 与页面内
              // 通知 tag 不同，同一提问 SW 与页面内各弹一条不合并。
              tag: `q:${sessionId}:question`,
              sessionId
            };
            pushOnce(`q:${sessionId}:${callId}`, () => {
              void deliver(payload);
            });
          }
          return;
        }
        if (event?.type === "turn/end") {
          const reason = data?.reason;
          if (reason?.kind === "error") {
            const turn = typeof data?.turn === "number" ? data.turn : 0;
            const rawMessage = typeof reason.error?.message === "string" ? reason.error.message : "";
            const code = typeof reason.error?.code === "string" ? reason.error.code : "";
            const title2 = sessionTitle(sessionId);
            const item2 = {
              id: `${sessionId}:${turn}:error`,
              sessionId,
              toolCalls: 0,
              at: Date.now(),
              kind: "failed",
              ...rawMessage !== "" ? { message: rawMessage.length > 120 ? `${rawMessage.slice(0, 120)}\u2026` : rawMessage } : {},
              ...code !== "" ? { code } : {},
              ...title2 !== "" ? { title: title2 } : {}
            };
            completions.push(item2);
            if (completions.length > EVENTS_CAP) completions.shift();
            const payload2 = {
              kind: "failed",
              title: title2 === "" ? "\u672A\u547D\u540D\u4F1A\u8BDD" : title2,
              body: item2.message !== void 0 ? `\u8FD0\u884C\u5931\u8D25\uFF1A${item2.message}` : "AI \u56DE\u5408\u56E0\u9519\u8BEF\u4E2D\u65AD\uFF0C\u70B9\u51FB\u67E5\u770B\u2026",
              tag: `f:${item2.id}`,
              sessionId
            };
            pushOnce(`f:${item2.id}`, () => {
              void deliver(payload2);
            });
            return;
          }
          const current = turnCalls.get(sessionId);
          if (current === void 0) return;
          turnCalls.delete(sessionId);
          if (current.calls < threshold) return;
          const item = {
            id: `${sessionId}:${current.turn}`,
            sessionId,
            toolCalls: current.calls,
            at: Date.now()
          };
          completions.push(item);
          if (completions.length > EVENTS_CAP) completions.shift();
          const title = sessionTitle(sessionId);
          const payload = {
            kind: "completed",
            title: title === "" ? "\u672A\u547D\u540D\u4F1A\u8BDD" : title,
            body: `\u4EFB\u52A1\u5B8C\u6210\uFF08${current.calls} \u6B21\u5DE5\u5177\u8C03\u7528\uFF09\uFF0C\u70B9\u51FB\u67E5\u770B\u2026`,
            tag: `c:${item.id}`,
            sessionId
          };
          pushOnce(`c:${item.id}`, () => {
            void deliver(payload);
          });
        }
      } catch {
      }
    });
  }
  const icon180 = iconPng(180);
  const icon512 = iconPng(512);
  const sw = swSource();
  const manifest = manifestSource();
  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = void 0;
  }
  if (webServer === void 0 && typeof ctx.get === "function") {
    try {
      webServer = ctx.get("webServer");
    } catch {
      webServer = void 0;
    }
  }
  if (webServer !== void 0 && typeof webServer.register === "function") {
    const routes = [
      {
        kind: "exact",
        path: "/plugins/meow-smooth/manifest.json",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-store" });
          res.end(manifest);
        }
      },
      {
        kind: "exact",
        path: "/plugins/meow-smooth/icon-180.png",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
          res.end(icon180);
        }
      },
      {
        kind: "exact",
        path: "/plugins/meow-smooth/icon-512.png",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
          res.end(icon512);
        }
      },
      {
        kind: "exact",
        path: "/plugins/meow-smooth/sw.js",
        handler: (_req, res) => {
          res.writeHead(200, {
            "content-type": "application/javascript; charset=utf-8",
            // 放开 SW scope 到根路径（文件本身在 /plugins/ 下）。
            "service-worker-allowed": "/",
            "cache-control": "no-store"
          });
          res.end(sw);
        }
      },
      {
        kind: "exact",
        path: "/plugins/meow-smooth/push-config",
        handler: (_req, res) => {
          void ensurePush().then((enabled) => {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify(enabled && vapidPublicKey !== void 0 ? { enabled: true, publicKey: vapidPublicKey } : { enabled: false }));
          });
        }
      },
      {
        kind: "exact",
        path: "/plugins/meow-smooth/push-subscribe",
        handler: (req, res) => {
          if (req?.method !== "POST") {
            res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
            res.end('{"error":"method not allowed"}');
            return;
          }
          let raw = "";
          req?.on?.("data", (chunk) => {
            raw += chunk.toString("utf8");
          });
          req?.on?.("end", () => {
            try {
              const sub = JSON.parse(raw);
              if (typeof sub.endpoint !== "string" || sub.endpoint === "") {
                res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
                res.end('{"error":"bad subscription"}');
                return;
              }
              subscriptions = subscriptions.filter((item) => item.endpoint !== sub.endpoint);
              subscriptions.push(sub);
              saveSubscriptions();
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end('{"ok":true}');
            } catch {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end('{"error":"bad json"}');
            }
          });
        }
      },
      {
        kind: "exact",
        path: "/plugins/meow-smooth/debug-fail",
        handler: (req, res) => {
          if (req?.method !== "POST") {
            res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
            res.end('{"error":"method not allowed"}');
            return;
          }
          const item = {
            id: `debug:${Date.now()}`,
            sessionId: "debug-session",
            toolCalls: 0,
            at: Date.now(),
            kind: "failed",
            message: "\u3010\u8C03\u8BD5\u3011\u6A21\u62DF\u56DE\u5408\u5931\u8D25\u2014\u2014\u9A8C\u8BC1\u901A\u77E5\u94FE\u8DEF\uFF08\u53EF\u5FFD\u7565\uFF09",
            code: "DEBUG",
            title: "\u8C03\u8BD5\u4F1A\u8BDD\uFF08\u53EF\u5FFD\u7565\uFF09"
          };
          completions.push(item);
          if (completions.length > EVENTS_CAP) completions.shift();
          const payload = {
            kind: "failed",
            title: "\u8C03\u8BD5\u4F1A\u8BDD\uFF08\u53EF\u5FFD\u7565\uFF09",
            body: "\u8FD0\u884C\u5931\u8D25\uFF1A\u3010\u8C03\u8BD5\u3011\u6A21\u62DF\u56DE\u5408\u5931\u8D25\u2014\u2014\u9A8C\u8BC1\u901A\u77E5\u94FE\u8DEF",
            tag: `f:${item.id}`,
            sessionId: item.sessionId
          };
          pushOnce(item.id, () => {
            void deliver(payload);
          });
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, id: item.id }));
        }
      },
      {
        kind: "exact",
        path: "/plugins/meow-smooth/diag-log",
        handler: (req, res) => {
          if (req?.method !== "POST") {
            res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
            res.end('{"error":"method not allowed"}');
            return;
          }
          let raw = "";
          req?.on?.("data", (chunk) => {
            raw += chunk.toString("utf8");
          });
          req?.on?.("end", () => {
            try {
              const body = JSON.parse(raw);
              if (typeof body.msg === "string" && body.msg !== "") {
                diagLog.push({ at: Date.now(), msg: body.msg.slice(0, 200) });
                if (diagLog.length > 100) diagLog.splice(0, diagLog.length - 100);
              }
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end('{"ok":true}');
            } catch {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end('{"error":"bad json"}');
            }
          });
        }
      },
      {
        kind: "exact",
        path: "/plugins/meow-smooth/diag",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ diag: diagLog }));
        }
      }
    ];
    for (const route of routes) {
      if (typeof ctx.effect === "function") {
        ctx.effect(() => webServer.register(route), `meow-smooth: ${route.path}`);
      } else {
        webServer.register(route);
      }
    }
    if (typeof webServer.tapIndex === "function" && typeof ctx.effect === "function") {
      ctx.effect(() => webServer.tapIndex((html) => {
        const links = '<link rel="manifest" href="/plugins/meow-smooth/manifest.json"><link rel="apple-touch-icon" href="/plugins/meow-smooth/icon-180.png">';
        if (html.includes("/plugins/meow-smooth/manifest.json")) return html;
        return html.replace("<head>", `<head>${links}`);
      }), "meow-smooth: pwa manifest tap");
    }
  }
  return {
    completionEvents,
    noteFocus,
    pushApproval(info) {
      const title = sessionTitle(info.sessionId);
      const payload = {
        kind: "approval",
        title: title === "" ? "\u672A\u547D\u540D\u4F1A\u8BDD" : title,
        body: "\u6709\u6743\u9650\u7533\u8BF7\u5F85\u5904\u7406\uFF0C\u70B9\u51FB\u67E5\u770B\u2026",
        tag: `a:${info.approvalId}`,
        sessionId: info.sessionId
      };
      pushOnce(`a:${info.approvalId}`, () => {
        void deliver(payload);
      });
    }
  };
}

// src/compress-proxy.ts
import http from "node:http";
import zlib from "node:zlib";
function resolveTargetPort() {
  const argv = process.argv;
  const idx = argv.indexOf("--port");
  if (idx !== -1 && idx + 1 < argv.length) {
    const value = Number(argv[idx + 1]);
    if (Number.isFinite(value) && value > 0 && value < 65536) return value;
  }
  return 3080;
}
function startCompressProxy(options) {
  const { port, targetPort } = options;
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method,
        // Host/Origin/Accept-Encoding 等全部原样透传：信任围栏按原 Host 校验，
        // 手机域名（node.tailxxxx.ts.net:8443）在 trusted-host 白名单内放行。
        headers: { ...req.headers }
      },
      (up) => {
        const contentType = up.headers["content-type"] ?? "";
        const wantsGzip = (req.headers["accept-encoding"] ?? "").includes("gzip");
        const isUnaryJson = req.method === "POST" && (req.url ?? "").startsWith("/api/") && contentType.includes("application/json");
        if (isUnaryJson && wantsGzip) {
          const headers = { ...up.headers };
          delete headers["content-length"];
          res.writeHead(up.statusCode ?? 200, { ...headers, "content-encoding": "gzip", "vary": "accept-encoding" });
          up.pipe(zlib.createGzip()).pipe(res);
        } else {
          res.writeHead(up.statusCode ?? 200, up.headers);
          up.pipe(res);
        }
      }
    );
    upstream.on("error", (error) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`meow-smooth compress-proxy: upstream error: ${error.message}`);
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: targetPort,
      path: req.url,
      method: req.method,
      // 显式 Upgrade/Connection 头：Node http.request 默认按 keep-alive 管理
      // connection，不显式传会把 Upgrade 请求降级成普通请求（上游 426）。
      headers: { ...req.headers, connection: "Upgrade", upgrade: "websocket" }
    });
    upstream.on("upgrade", (upRes, upSocket, upHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r
${Object.entries(upRes.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r
\r
`);
      if (upHead.length > 0) socket.write(upHead);
      socket.pipe(upSocket).pipe(socket);
    });
    upstream.on("response", (upRes) => {
      socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ""}\r
\r
`);
      socket.end();
      upRes.resume();
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.warn(`[meow-smooth] compress proxy port ${port} already in use \u2014 set proxy.port in config`);
    } else {
      console.warn(`[meow-smooth] compress proxy error: ${error.message}`);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[meow-smooth] compress proxy on 127.0.0.1:${port} -> 127.0.0.1:${targetPort} (gzip unary /api/* JSON)`);
  });
  return server;
}

// src/index.ts
var name = "meow-smooth";
var HOST_VERSION = "0.5.0";
var inject = ["sessions", "webServer"];
function apply(ctx, config) {
  let webServer;
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = void 0;
  }
  if (webServer === void 0 && typeof ctx.get === "function") {
    try {
      webServer = ctx.get("webServer");
    } catch {
      webServer = void 0;
    }
  }
  const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
  const notify = installNotifyHost(ctx, config);
  const proxyCfg = config?.proxy;
  if (proxyCfg?.enabled === true) {
    const server = startCompressProxy({
      port: proxyCfg.port ?? 8444,
      targetPort: proxyCfg.targetPort ?? resolveTargetPort()
    });
    if (typeof ctx.effect === "function") {
      ctx.effect(() => () => {
        server.close();
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      }, "meow-smooth: compress proxy");
    }
  }
  const pending = /* @__PURE__ */ new Map();
  const pendingQuestions = /* @__PURE__ */ new Map();
  const reasons = /* @__PURE__ */ new Map();
  let requestSeen = 0;
  if (typeof ctx.on === "function") {
    ctx.on("approval/request", (req, next) => {
      try {
        requestSeen++;
        if (requestSeen % 50 === 0) {
          const cutoff = Date.now() - 10 * 6e4;
          for (const [key, value] of reasons) {
            if (value.at < cutoff) reasons.delete(key);
          }
        }
        const sessionId = req?.agent?.session?.id;
        const callId = req?.callId;
        if (typeof sessionId === "string" && typeof req?.reason === "string" && req.reason !== "") {
          reasons.set(`${sessionId}|${callId ?? ""}`, { text: req.reason, at: Date.now() });
        }
      } catch {
      }
      return next();
    });
  }
  const planReviewOf = (raw) => {
    try {
      const args = JSON.parse(typeof raw === "string" ? raw : "");
      const questions = args?.questions;
      return Array.isArray(questions) && questions.some((q) => q?.intent?.kind === "plan-review");
    } catch {
      return false;
    }
  };
  const sessionTitleOf = (session) => {
    try {
      const events = session?.events;
      if (!Array.isArray(events)) return "";
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type === "session/title" && typeof event.data?.title === "string" && event.data.title !== "") {
          return event.data.title;
        }
      }
    } catch {
    }
    return "";
  };
  const onEvent = (session, event) => {
    try {
      const data = event?.data;
      if (event?.type === "approval/asked") {
        const id = data?.id ?? "";
        if (id === "") return;
        const sessionId = session?.id ?? "";
        const callId = data?.callId;
        const reason = reasons.get(`${sessionId}|${callId ?? ""}`);
        if (reason !== void 0) reasons.delete(`${sessionId}|${callId ?? ""}`);
        pending.set(id, {
          sessionId,
          approvalId: id,
          toolName: data?.toolName ?? "",
          ...callId !== void 0 ? { callId } : {},
          ...reason !== void 0 ? { reason: reason.text } : {},
          askedAt: Date.now(),
          orphan: false
        });
        notify.pushApproval({
          sessionId,
          approvalId: id,
          toolName: data?.toolName ?? "",
          ...reason !== void 0 ? { reason: reason.text } : {}
        });
      } else if (event?.type === "approval/decided") {
        const id = data?.id ?? "";
        if (id !== "") pending.delete(id);
      } else if (event?.type === "tool/call" && data?.name === "ask_user_question") {
        const callId = data?.callId ?? "";
        if (callId === "" || pendingQuestions.has(callId)) return;
        const sessionId = session?.id ?? "";
        pendingQuestions.set(callId, {
          sessionId,
          callId,
          askedAt: Date.now(),
          planReview: planReviewOf(data?.arguments),
          orphan: false,
          ...sessionTitleOf(session) !== "" ? { title: sessionTitleOf(session) } : {}
        });
      } else if (event?.type === "tool/result") {
        const callId = data?.message?.source?.callId;
        if (typeof callId === "string") pendingQuestions.delete(callId);
      }
    } catch {
    }
  };
  if (typeof ctx.on === "function") ctx.on("session/event", onEvent);
  try {
    if (sessions !== void 0 && typeof sessions.list === "function") {
      for (const session of sessions.list()) {
        const events = session?.events;
        if (!Array.isArray(events)) continue;
        const decided = /* @__PURE__ */ new Set();
        for (const event of events) {
          if (event?.type === "approval/decided" && typeof event.data?.id === "string") {
            decided.add(event.data.id);
          }
        }
        for (const event of events) {
          if (event?.type !== "approval/asked") continue;
          const id = event.data?.id;
          if (typeof id !== "string" || id === "") continue;
          if (decided.has(id) || pending.has(id)) continue;
          const callId = event.data?.callId;
          pending.set(id, {
            sessionId: session.id,
            approvalId: id,
            toolName: typeof event.data?.toolName === "string" ? event.data.toolName : "",
            ...typeof callId === "string" ? { callId } : {},
            askedAt: Date.now(),
            orphan: true
          });
        }
        const decidedCalls = /* @__PURE__ */ new Set();
        for (const event of events) {
          const resultCallId = event?.data?.message?.source?.callId;
          if (event?.type === "tool/result" && typeof resultCallId === "string") {
            decidedCalls.add(resultCallId);
          }
        }
        for (const event of events) {
          if (event?.type !== "tool/call" || event.data?.name !== "ask_user_question") continue;
          const callId = event.data?.callId;
          if (typeof callId !== "string" || callId === "") continue;
          if (decidedCalls.has(callId) || pendingQuestions.has(callId)) continue;
          pendingQuestions.set(callId, {
            sessionId: session.id,
            callId,
            askedAt: Date.now(),
            planReview: planReviewOf(event.data?.arguments),
            orphan: true,
            ...sessionTitleOf(session) !== "" ? { title: sessionTitleOf(session) } : {}
          });
        }
      }
    }
  } catch {
  }
  const commandFor = (view) => {
    if (view.callId === void 0) return void 0;
    try {
      const session = sessions?.get?.(view.sessionId);
      const events = session?.events;
      if (!Array.isArray(events)) return void 0;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type !== "tool/call" || event.data?.callId !== view.callId) continue;
        try {
          const args = JSON.parse(event.data.arguments ?? "");
          return typeof args.command === "string" ? args.command : void 0;
        } catch {
          return void 0;
        }
      }
    } catch {
    }
    return void 0;
  };
  if (webServer !== void 0 && typeof webServer.register === "function") {
    const dispose = webServer.register({
      kind: "exact",
      path: "/plugins/meow-smooth/pending",
      handler: (req, res) => {
        try {
          const headers = req?.headers;
          const focus = headers?.["x-meow-focus"];
          if (focus === "1" || focus === "0") {
            notify.noteFocus(headers?.["host"], focus === "1");
          }
          const approvals = [...pending.values()].map((view) => {
            const command = commandFor(view);
            return {
              sessionId: view.sessionId,
              approvalId: view.approvalId,
              toolName: view.toolName,
              ...view.callId !== void 0 ? { callId: view.callId } : {},
              ...view.reason !== void 0 ? { reason: view.reason } : {},
              ...command !== void 0 ? { command } : {},
              askedAt: view.askedAt,
              orphan: view.orphan
            };
          });
          const questions = [...pendingQuestions.values()].map((view) => ({
            sessionId: view.sessionId,
            callId: view.callId,
            planReview: view.planReview,
            askedAt: view.askedAt,
            orphan: view.orphan,
            ...view.title !== void 0 ? { title: view.title } : {}
          }));
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store"
          });
          res.end(JSON.stringify({ hostVersion: HOST_VERSION, approvals, questions, events: notify.completionEvents() }));
        } catch {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end('{"error":"internal"}');
        }
      }
    });
    if (typeof ctx.effect === "function") {
      ctx.effect(() => dispose, "meow-smooth: pending route");
    }
  }
}
export {
  HOST_VERSION,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
