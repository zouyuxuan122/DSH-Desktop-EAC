import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface ChatSession {
  history: ChatCompletionMessageParam[];
}

export class AIChat {
  private client: OpenAI;
  private model: string;
  private systemPrompt: string;
  private sessions = new Map<string, ChatSession>();
  private maxHistory: number;

  constructor(opts: {
    apiKey: string;
    baseURL?: string;
    model?: string;
    systemPrompt?: string;
    maxHistory?: number;
  }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
    this.model = opts.model || "gpt-4o";
    this.systemPrompt = opts.systemPrompt || "你是一个友好的AI助手，简洁明了地回答问题。";
    this.maxHistory = opts.maxHistory ?? 20;
  }

  private getSession(userId: string): ChatSession {
    let session = this.sessions.get(userId);
    if (!session) {
      session = { history: [] };
      this.sessions.set(userId, session);
    }
    return session;
  }

  clearSession(userId: string): void {
    this.sessions.delete(userId);
  }

  async chat(userId: string, userMessage: string): Promise<string> {
    const session = this.getSession(userId);

    session.history.push({ role: "user", content: userMessage });

    if (session.history.length > this.maxHistory) {
      session.history = session.history.slice(-this.maxHistory);
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt },
      ...session.history,
    ];

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
    });

    const reply = completion.choices[0]?.message?.content || "（AI 未返回内容）";

    session.history.push({ role: "assistant", content: reply });

    return reply;
  }
}
