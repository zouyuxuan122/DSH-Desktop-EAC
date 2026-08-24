import crypto from "node:crypto";
import type {
  GetUpdatesResp,
  WeixinMessage,
  MessageItem,
  LoginCredentials,
} from "./types.js";
import { MessageType, MessageItemType, MessageState } from "./types.js";

const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
): Promise<T> {
  const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const bodyStr = JSON.stringify(body);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(bodyStr, "utf-8"));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API ${endpoint} responded ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  buf: string,
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
): Promise<GetUpdatesResp> {
  try {
    return await apiPost<GetUpdatesResp>(
      baseUrl,
      "ilink/bot/getupdates",
      { get_updates_buf: buf },
      token,
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

export async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  const clientId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const items: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];

  await apiPost(
    baseUrl,
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: items.length ? items : undefined,
        context_token: contextToken,
      } satisfies WeixinMessage,
    },
    token,
  );
}

export function extractTextFromMessage(msg: WeixinMessage): string {
  const items = msg.item_list;
  if (!items?.length) return "";

  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const ref = item.ref_msg;
      const text = item.text_item.text;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
  }
  return "";
}
