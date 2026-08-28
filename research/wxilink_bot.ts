import { getUpdates, sendTextMessage, extractTextFromMessage } from "./weixin/api.js";
import { MessageType } from "./weixin/types.js";
import type { LoginCredentials, WeixinMessage } from "./weixin/types.js";
import { AIChat } from "./ai/chat.js";

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

const contextTokens = new Map<string, string>();

export class Bot {
  private credentials: LoginCredentials;
  private ai: AIChat;
  private running = false;
  private getUpdatesBuf = "";

  constructor(credentials: LoginCredentials, ai: AIChat) {
    this.credentials = credentials;
    this.ai = ai;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("[bot] 机器人已启动，开始监听消息...");

    let failures = 0;

    while (this.running) {
      try {
        const resp = await getUpdates(
          this.credentials.baseUrl,
          this.credentials.token,
          this.getUpdatesBuf,
        );

        if (resp.ret !== undefined && resp.ret !== 0) {
          failures++;
          console.error(`[bot] getUpdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[bot] 连续失败 ${failures} 次，等待 ${BACKOFF_DELAY_MS / 1000}s 后重试`);
            failures = 0;
            await sleep(BACKOFF_DELAY_MS);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        failures = 0;

        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
        }

        const messages = resp.msgs ?? [];
        for (const msg of messages) {
          await this.handleMessage(msg);
        }
      } catch (err) {
        failures++;
        console.error(`[bot] 轮询异常: ${err}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log("[bot] 机器人已停止");
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== MessageType.USER) return;

    const fromUser = msg.from_user_id;
    if (!fromUser) return;

    if (msg.context_token) {
      contextTokens.set(fromUser, msg.context_token);
    }

    const text = extractTextFromMessage(msg);
    if (!text.trim()) return;

    console.log(`[bot] 收到消息 from=${fromUser}: ${text.slice(0, 100)}`);

    if (text.trim() === "/clear") {
      this.ai.clearSession(fromUser);
      await this.reply(fromUser, "对话已重置 ✅");
      return;
    }

    try {
      const aiReply = await this.ai.chat(fromUser, text);
      console.log(`[bot] AI 回复 to=${fromUser}: ${aiReply.slice(0, 100)}`);
      await this.reply(fromUser, aiReply);
    } catch (err) {
      console.error(`[bot] AI 调用失败: ${err}`);
      await this.reply(fromUser, "抱歉，AI 暂时无法回复，请稍后再试。");
    }
  }

  private async reply(to: string, text: string): Promise<void> {
    const contextToken = contextTokens.get(to);
    try {
      await sendTextMessage(
        this.credentials.baseUrl,
        this.credentials.token,
        to,
        text,
        contextToken,
      );
    } catch (err) {
      console.error(`[bot] 发送消息失败 to=${to}: ${err}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
