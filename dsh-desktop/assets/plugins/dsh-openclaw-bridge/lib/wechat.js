// @deepseek-ai/dsh-openclaw-bridge — 微信 ClawBot iLink 直连客户端。
// 依据腾讯官方 npm 包 @tencent-weixin/openclaw-weixin 公开的 Backend API Protocol
// （域名 ilinkai.weixin.qq.com，HTTP/JSON 长轮询）。纯出站客户端：不监听任何端口，
// 手机与 PC 均只出站连腾讯云，无需公网 IP/端口映射/内网穿透。
//
// 端点：get_bot_qrcode / get_qrcode_status（扫码登录）、getupdates（长轮询收）、
// sendmessage（发）。token 约 24h 过期需重新扫码；用户发消息后 24h 内最多主动发 10 条。
// baseUrl 可用环境变量 OPENCLAW_BRIDGE_ILINK_BASE 覆盖（测试/私有部署用）。

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_BASE = process.env.OPENCLAW_BRIDGE_ILINK_BASE || "https://ilinkai.weixin.qq.com";
const SESSION_TTL_MS = 23 * 60 * 60 * 1000; // 提前 1h 判过期，留缓冲
const CHANNEL_VERSION = "2.4.6";

// iLink-App-ClientVersion: uint32 编码 0x00MMNNPP 的十进制字符串
// （官方实现：major<<16 | minor<<8 | patch，如 2.4.6 -> "131590"）。
function packClientVersion(version) {
  const parts = String(version).split(".").map((p) => parseInt(p, 10));
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}
const CLIENT_VERSION = packClientVersion(CHANNEL_VERSION);
const BOT_AGENT = "dsh-openclaw-bridge/0.6.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseHeaders(token) {
  const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString("base64");
  const headers = {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": uin,
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
  if (token) headers.Authorization = "Bearer " + token;
  return headers;
}

/** 从响应里宽容地取业务 payload（兼容 {ret,data} 与裸字段）。 */
function payloadOf(data) {
  if (data && typeof data === "object" && data.data && typeof data.data === "object") return data.data;
  return data || {};
}

function textOfMessage(msg) {
  const items = (msg && msg.item_list) || [];
  let out = "";
  for (const item of items) {
    if (item && item.type === 1 && item.text_item && item.text_item.text) out += item.text_item.text;
  }
  return out;
}

export function createWechatClient(options = {}) {
  const base = String(options.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const sessionFile = options.sessionFile;
  const onState = options.onState || (() => {});
  const onMessage = options.onMessage || (() => {});

  let state = "disconnected"; // disconnected | waiting-qr | waiting-scan | need-verifycode | connected | expired
  let qrcode = "";
  let qrcodeUrl = "";
  let pendingVerify = "";
  let session = null; // { token, botId, userId, baseurl, savedAt, cursor }
  let loopRunning = false;
  let loopEpoch = 0; // M1 修复：轮询代际标记，stopLoop/重登后旧循环立即失效
  let disposed = false;

  function loadSession() {
    if (!sessionFile) return;
    try {
      if (existsSync(sessionFile)) {
        const parsed = JSON.parse(readFileSync(sessionFile, "utf8"));
        // S2 修复：只接受"结构合法"的会话（logout 落盘的 {} 不再误判为已连接）
        if (parsed && typeof parsed.token === "string" && parsed.token && Number.isFinite(parsed.savedAt)) {
          session = parsed;
        } else {
          session = null;
        }
      }
    } catch {
      session = null;
    }
  }

  function saveSession() {
    if (!sessionFile) return;
    try {
      mkdirSync(dirname(sessionFile), { recursive: true });
      if (session) writeFileSync(sessionFile, JSON.stringify(session));
      else if (existsSync(sessionFile)) writeFileSync(sessionFile, "{}");
    } catch {
      // 持久化失败不影响运行
    }
  }

  function setState(next) {
    state = next;
    onState(status());
  }

  function status() {
    return {
      state,
      qrcodeUrl,
      verifyNeeded: state === "need-verifycode",
      botId: session ? session.botId : void 0,
      savedAt: session ? session.savedAt : void 0,
      expiresAt: session ? session.savedAt + SESSION_TTL_MS : void 0,
    };
  }

  async function fetchJson(url, init) {
    const resp = await fetch(url, init);
    let data;
    try {
      data = await resp.json();
    } catch {
      data = {};
    }
    return data;
  }

  /** 开始扫码登录流程。 */
  async function startLogin() {
    stopLoop();
    pendingVerify = "";
    setState("waiting-qr");
    const data = await fetchJson(base + "/ilink/bot/get_bot_qrcode?bot_type=3", {
      method: "GET",
      headers: baseHeaders(),
    });
    const p = payloadOf(data);
    qrcode = p.qrcode || data.qrcode || "";
    qrcodeUrl = p.qrcode_img_content || p.qrcode_url || data.qrcode_img_content || "";
    if (!qrcode) throw new Error("get_bot_qrcode: response has no qrcode");
    setState("waiting-scan");
    void pollQrStatus();
  }

  /** 扫码状态轮询：wait → scaned → (need_verifycode) → confirmed/expired。 */
  async function pollQrStatus() {
    while (!disposed && (state === "waiting-scan" || state === "need-verifycode" || state === "waiting-qr")) {
      await sleep(2000);
      if (disposed || !qrcode) return;
      let data;
      try {
        let url = base + "/ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qrcode);
        if (pendingVerify) url += "&verify_code=" + encodeURIComponent(pendingVerify);
        data = await fetchJson(url, { method: "GET", headers: baseHeaders() });
      } catch {
        continue;
      }
      const p = payloadOf(data);
      const st = p.status || data.status || "";
      if (st === "need_verifycode") {
        setState("need-verifycode");
        continue;
      }
      if (st === "verified" || st === "confirmed" || st === "binded_redirect") {
        const info = p;
        const token = info.bot_token || info.token;
        if (!token) continue;
        session = {
          token,
          botId: info.ilink_bot_id || info.bot_id || "",
          userId: info.ilink_user_id || info.user_id || "",
          baseurl: info.baseurl || base,
          savedAt: Date.now(),
          cursor: "",
        };
        saveSession();
        setState("connected");
        startLoop();
        return;
      }
      if (st === "expired" || st === "verify_code_blocked") {
        setState("expired");
        return;
      }
      // wait / scaned / scaned_but_redirect → 继续轮询
    }
  }

  /** 提交微信侧显示的数字配对码。 */
  function submitVerify(code) {
    const c = String(code || "").trim();
    if (!c) return false;
    pendingVerify = c;
    setState("need-verifycode");
    return true;
  }

  /** 长轮询主循环：hold 由腾讯云侧 ~35s，本地每轮 sleep 兜底。 */
  async function startLoop() {
    if (loopRunning) return;
    const epoch = loopEpoch;
    loopRunning = true;
    while (loopRunning && !disposed && session && epoch === loopEpoch) {
      if (Date.now() - session.savedAt > SESSION_TTL_MS) {
        session = null;
        saveSession();
        setState("expired");
        loopRunning = false;
        return;
      }
      let data;
      try {
        data = await fetchJson(base + "/ilink/bot/getupdates", {
          method: "POST",
          headers: baseHeaders(session.token),
          body: JSON.stringify({
            get_updates_buf: session.cursor || "",
            base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
          }),
        });
      } catch {
        await sleep(3000);
        continue;
      }
      const p = payloadOf(data);
      const msgs = Array.isArray(p.msgs) ? p.msgs : [];
      if (p.get_updates_buf !== void 0 && p.get_updates_buf !== "" && p.get_updates_buf !== session.cursor) {
        session.cursor = p.get_updates_buf;
        saveSession();
      }
      for (const msg of msgs) {
        if (!msg || msg.message_type !== 1) continue; // 只处理用户消息
        const text = textOfMessage(msg);
        if (!text.trim()) continue;
        try {
          await onMessage({
            from: msg.from_user_id || "",
            to: msg.to_user_id || "",
            text,
            contextToken: msg.context_token || "",
            raw: msg,
          });
        } catch (err) {
          console.error("[openclaw-bridge] wechat message handler failed: " + String(err && err.message));
        }
      }
      await sleep(500);
    }
  }

  function stopLoop() {
    loopRunning = false;
    loopEpoch += 1;
  }

  /** 发送文本回复（与官方 2.4.6 实现同构：run_id 每次新生成、context_token 缺省省略）。 */
  async function sendText(toUserId, text, contextToken) {
    if (!session) throw new Error("wechat: not connected");
    const msg = {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: String(text).slice(0, 2000) } }],
      ...(contextToken ? { context_token: contextToken } : {}),
      run_id: randomUUID(),
    };
    const data = await fetchJson(base + "/ilink/bot/sendmessage", {
      method: "POST",
      headers: baseHeaders(session.token),
      body: JSON.stringify({
        msg,
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
      }),
    });
    const p = payloadOf(data);
    const ret = p.ret !== void 0 ? p.ret : data.ret;
    const errmsg = String(p.errmsg || data.errmsg || "");
    // 官方语义：ret 非 0 才视为失败（ret 缺省 = 成功）
    const failed = ret !== void 0 && Number(ret) !== 0;
    return { ok: !failed, ret: ret === void 0 ? void 0 : Number(ret), errmsg };
  }

  function logout() {
    stopLoop();
    session = null;
    pendingVerify = "";
    qrcode = "";
    qrcodeUrl = "";
    saveSession();
    setState("disconnected");
  }

  function dispose() {
    disposed = true;
    stopLoop();
  }

  // 启动时恢复会话：24h 内自动重连轮询，过期则进入 expired 等待重扫。
  loadSession();
  if (session) {
    if (Date.now() - session.savedAt > SESSION_TTL_MS) {
      session = null;
      saveSession();
      setState("expired");
    } else {
      setState("connected");
      void startLoop();
    }
  }

  return { startLogin, submitVerify, sendText, logout, dispose, status };
}
