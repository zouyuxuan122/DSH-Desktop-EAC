import { login, clearCredentials } from "./weixin/auth.js";
import { AIChat } from "./ai/chat.js";
import { Bot } from "./bot.js";

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("请设置环境变量 OPENAI_API_KEY");
    process.exit(1);
  }

  if (process.argv.includes("--logout")) {
    clearCredentials();
    console.log("已清除登录凭证，下次启动需要重新扫码。");
    return;
  }

  const credentials = await login();

  const ai = new AIChat({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.OPENAI_MODEL,
    systemPrompt: process.env.SYSTEM_PROMPT,
  });

  const bot = new Bot(credentials, ai);

  const shutdown = () => {
    console.log("\n正在关闭...");
    bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.start();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
