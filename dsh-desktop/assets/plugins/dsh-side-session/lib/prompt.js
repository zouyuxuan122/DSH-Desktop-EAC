function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export function buildFinalPrompt(body, fileBlock = "") {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const firstIsSystem = msgs.length && msgs[0] && msgs[0].role === "system";
  const clientSystem = firstIsSystem ? contentText(msgs[0].content) : "";
  const restAll = (firstIsSystem ? msgs.slice(1) : msgs)
    .filter((message) => message && typeof message === "object")
    .map((message) => ({
      role: String(message.role || ""),
      content: contentText(message.content),
    }))
    .filter((message) => message.content.trim().length > 0);

  // Assistant history is folded into system because replaying it through ctx.llm.stream can
  // produce a finish chunk without reason.kind in some providers.
  let lastUserIndex = -1;
  for (let i = restAll.length - 1; i >= 0; i--) {
    if (restAll[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  const rest = lastUserIndex >= 0 ? [restAll[lastUserIndex]] : [];
  const tempHistory = restAll
    .slice(0, lastUserIndex)
    .map((message) => {
      const who = message.role === "assistant" ? "助手" : "用户";
      return `[${who}] ${message.content}`;
    })
    .join("\n");
  const tempBlock = tempHistory ? `==== 临时会话上下文 ====\n${tempHistory}` : "";
  const system = [fileBlock, tempBlock, clientSystem].filter(Boolean).join("\n\n");
  return { system, rest };
}
