import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinalPrompt,
  hasNonEmptyUserMessage,
} from "../assets/plugins/dsh-side-session/lib/prompt.js";

test("side session folds prior turns into system and sends only the latest user message", () => {
  const { system, rest } = buildFinalPrompt({
    mode: "3",
    sessionId: "",
    messages: [
      { role: "system", content: "你是临时会话助手" },
      { role: "user", content: "我叫大肥鱼" },
      { role: "assistant", content: "你好，大肥鱼。" },
      { role: "user", content: "请只回复系统提示里用户的名字。" },
    ],
  });

  assert.deepEqual(rest, [
    { role: "user", content: "请只回复系统提示里用户的名字。" },
  ]);
  assert.equal(
    system,
    "==== 临时会话上下文 ====\n" +
      "[用户] 我叫大肥鱼\n" +
      "[助手] 你好，大肥鱼。\n\n" +
      "你是临时会话助手"
  );
});

test("side session ignores empty text blocks and supports array content", () => {
  const { system, rest } = buildFinalPrompt({
    sessionId: "",
    messages: [
      { role: "system", content: [{ type: "text", text: "系统" }] },
      { role: "user", content: [{ type: "text", text: "   " }] },
      { role: "assistant", content: [{ type: "text", text: "历史" }] },
      { role: "user", content: [{ type: "text", text: "问题" }] },
    ],
  });

  assert.deepEqual(rest, [{ role: "user", content: "问题" }]);
  assert.equal(system, "==== 临时会话上下文 ====\n[助手] 历史\n\n系统");
});

test("side session rejects message lists without a non-empty user turn", () => {
  const assistantOnly = [
    { role: "assistant", content: "first" },
    { role: "assistant", content: "second" },
  ];
  assert.equal(hasNonEmptyUserMessage(assistantOnly), false);
  assert.equal(hasNonEmptyUserMessage([{ role: "user", content: "   " }]), false);
  assert.equal(hasNonEmptyUserMessage([{ role: "user", content: "question" }]), true);
  assert.deepEqual(buildFinalPrompt({ messages: assistantOnly }), { system: "", rest: [] });
});
