#!/usr/bin/env node
/**
 * 微信 iLink Bot API 裸调 Demo
 * 无需 openclaw，直接 HTTP 调用 ilinkai.weixin.qq.com
 *
 * 用法:
 *   node demo.mjs          # 首次扫码登录，收消息后自动回复
 *   node demo.mjs --login  # 强制重新扫码登录
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

// 加载 .env
const require = createRequire(import.meta.url);
try {
  const dotenv = require("dotenv");
  dotenv.config();
} catch {}

import { query } from "@anthropic-ai/claude-agent-sdk";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const TOKEN_FILE = ".weixin-token.json";
const CHANNEL_VERSION = "1.0.2";

// ─── 二维码渲染 ───────────────────────────────────────────────────────────────

const IMGCAT = "/Applications/iTerm.app/Contents/Resources/utilities/imgcat";

/** 渲染二维码：iTerm2 内联图片优先，降级 ASCII art */
async function renderQR(url) {
  try {
    const { default: QRCode } = await import("qrcode");
    const { execFileSync, spawnSync } = await import("node:child_process");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmp = join(tmpdir(), `weixin-qr-${Date.now()}.png`);
    await QRCode.toFile(tmp, url, { width: 360, margin: 2 });

    // 尝试 iTerm2 imgcat
    const result = spawnSync(IMGCAT, [tmp], { stdio: ["ignore", "inherit", "ignore"] });
    unlinkSync(tmp);

    if (result.status !== 0) throw new Error("imgcat failed");
    console.log();
  } catch {
    // 降级：ASCII art
    try {
      const { default: qrterm } = await import("qrcode-terminal");
      await new Promise((resolve) => {
        qrterm.generate(url, { small: true }, (qr) => { console.log(qr); resolve(); });
      });
    } catch {
      console.log("  二维码 URL:", url, "\n");
    }
  }
}

// ─── HTTP 工具 ────────────────────────────────────────────────────────────────

/** X-WECHAT-UIN: 随机 uint32 → 十进制字符串 → base64 */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token, body) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(body), "utf-8"));
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiGet(baseUrl, path) {
  const url = `${baseUrl.replace(/\/$/, "")}/${path}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function apiPost(baseUrl, endpoint, body, token, timeoutMs = 15_000) {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const payload = { ...body, base_info: { channel_version: CHANNEL_VERSION } };
  const bodyStr = JSON.stringify(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token, payload),
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return null; // 长轮询超时，正常
    throw err;
  }
}

// ─── 登录流程 ─────────────────────────────────────────────────────────────────

async function login() {
  console.log("\n🔐 开始微信扫码登录...\n");

  // 1. 获取二维码
  const qrResp = await apiGet(DEFAULT_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`);
  const qrcode = qrResp.qrcode;
  const qrcodeUrl = qrResp.qrcode_img_content;

  console.log("📱 请用微信扫描以下二维码：\n");

  // 终端渲染二维码：优先 iTerm2 内联图片，降级 ASCII
  await renderQR(qrcodeUrl);

  // 2. 轮询扫码状态
  console.log("⏳ 等待扫码...");
  const deadline = Date.now() + 5 * 60_000;
  let refreshCount = 0;
  let currentQrcode = qrcode;
  let currentQrcodeUrl = qrcodeUrl;

  while (Date.now() < deadline) {
    const statusResp = await apiGet(
      DEFAULT_BASE_URL,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcode)}`,
    );

    switch (statusResp.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        process.stdout.write("\n👀 已扫码，请在微信端确认...\n");
        break;
      case "expired": {
        refreshCount++;
        if (refreshCount > 3) {
          throw new Error("二维码多次过期，请重新运行");
        }
        console.log(`\n⏳ 二维码过期，刷新中 (${refreshCount}/3)...`);
        const newQr = await apiGet(DEFAULT_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`);
        currentQrcode = newQr.qrcode;
        currentQrcodeUrl = newQr.qrcode_img_content;
        console.log("  新二维码 URL:", currentQrcodeUrl);
        break;
      }
      case "confirmed": {
        console.log("\n✅ 登录成功！\n");
        const tokenData = {
          token: statusResp.bot_token,
          baseUrl: statusResp.baseurl || DEFAULT_BASE_URL,
          accountId: statusResp.ilink_bot_id,
          userId: statusResp.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), "utf-8");
        fs.chmodSync(TOKEN_FILE, 0o600);
        console.log(`  Bot ID : ${tokenData.accountId}`);
        console.log(`  Base URL: ${tokenData.baseUrl}`);
        console.log(`  Token 已保存到 ${TOKEN_FILE}\n`);
        return tokenData;
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("登录超时");
}

// ─── 消息收发 ─────────────────────────────────────────────────────────────────

/** 长轮询获取新消息，返回 { msgs, get_updates_buf } */
async function getUpdates(baseUrl, token, getUpdatesBuf) {
  const resp = await apiPost(
    baseUrl,
    "ilink/bot/getupdates",
    { get_updates_buf: getUpdatesBuf ?? "" },
    token,
    38_000, // 长轮询，服务器最多 hold 35s
  );
  return resp ?? { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
}

/** 发送文本消息 */
async function sendMessage(baseUrl, token, toUserId, text, contextToken) {
  const clientId = `demo-${crypto.randomUUID()}`;
  await apiPost(
    baseUrl,
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [
          { type: 1, text_item: { text } }, // TEXT
        ],
      },
    },
    token,
  );
  return clientId;
}

/** 从消息 item_list 提取纯文本 */
function extractText(msg) {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    if (item.type === 3 && item.voice_item?.text) return `[语音] ${item.voice_item.text}`;
    if (item.type === 2) return "[图片]";
    if (item.type === 4) return `[文件] ${item.file_item?.file_name ?? ""}`;
    if (item.type === 5) return "[视频]";
  }
  return "[空消息]";
}

// ─── Claude Agent SDK ─────────────────────────────────────────────────────────

/** 调用 Claude Code agent，返回最终文本回复 */
async function askClaude(userText) {
  async function* messages() {
    yield {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: userText },
    };
  }

  let result = "";
  for await (const msg of query({
    prompt: messages(),
    options: {
      model: "sonnet",
      baseTools: [{ preset: "default" }],
      deniedTools: ["AskUserQuestion"],
      cwd: process.cwd(),
      env: process.env,
      abortController: new AbortController(),
    },
  })) {
    if (msg.type === "result") {
      result = msg.result ?? "";
    }
  }
  return result || "（Claude 无回复）";
}

// ─── 主循环 ───────────────────────────────────────────────────────────────────

async function main() {
  const forceLogin = process.argv.includes("--login");

  // 加载或获取 token
  let session;
  if (!forceLogin && fs.existsSync(TOKEN_FILE)) {
    session = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    console.log(`✅ 已加载 token（Bot: ${session.accountId}，保存于 ${session.savedAt}）`);
    console.log(`   如需重新登录，运行: node demo.mjs --login\n`);
  } else {
    session = await login();
  }

  const { token, baseUrl, accountId } = session;

  console.log("🚀 开始长轮询收消息（Ctrl+C 退出）...\n");

  let getUpdatesBuf = "";

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

      // 更新 buf（服务器下发的游标，下次请求带上）
      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
      }

      for (const msg of resp.msgs ?? []) {
        // 只处理用户发来的消息（message_type=1）
        if (msg.message_type !== 1) continue;

        const from = msg.from_user_id;
        const text = extractText(msg);
        const contextToken = msg.context_token;

        console.log(`📩 [${new Date().toLocaleTimeString()}] 收到消息`);
        console.log(`   From: ${from}`);
        console.log(`   Text: ${text}`);

        // 调用 Claude 生成回复
        process.stdout.write(`   🤔 Claude 思考中...`);
        const reply = await askClaude(text);
        process.stdout.write(` 完成\n`);

        await sendMessage(baseUrl, token, from, reply, contextToken);
        console.log(`   ✅ 已回复: ${reply.slice(0, 60)}${reply.length > 60 ? "…" : ""}\n`);
      }
    } catch (err) {
      if (err.message?.includes("session timeout") || err.message?.includes("-14")) {
        console.error("❌ Session 已过期，请重新登录: node demo.mjs --login");
        process.exit(1);
      }
      console.error(`⚠️  轮询出错: ${err.message}，3 秒后重试...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
