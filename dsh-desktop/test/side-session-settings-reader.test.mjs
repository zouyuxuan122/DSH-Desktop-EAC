import assert from "node:assert/strict";
import test from "node:test";

import { readAgentDefaultField } from "../assets/plugins/dsh-side-session/lib/settings-reader.js";

test("side session reads only direct fields from agent-default-model", () => {
  const settings = [
    "agent-default-model:",
    "  provider: q",
    "  model: gpt-5.6-sol",
    "  reasoningEffort: high",
    "other-plugin:",
    "  model: must-not-leak",
  ].join("\n");

  assert.equal(readAgentDefaultField(settings, "provider", "fallback"), "q");
  assert.equal(readAgentDefaultField(settings, "model", "fallback"), "gpt-5.6-sol");
  assert.equal(readAgentDefaultField(settings, "reasoningEffort", ""), "high");
});

test("side session does not read a model from the following YAML section", () => {
  const settings = "agent-default-model:\n  provider: q\nother-plugin:\n  model: wrong";
  assert.equal(readAgentDefaultField(settings, "model", "deepseek-v4-flash"), "deepseek-v4-flash");
});

test("side session handles BOM, quoted scalars and inline comments", () => {
  const settings =
    '\uFEFFagent-default-model:\r\n  provider: "q" # selected provider\r\n  model: \'gpt-5.6-sol\'\r\n';
  assert.equal(readAgentDefaultField(settings, "provider", "fallback"), "q");
  assert.equal(readAgentDefaultField(settings, "model", "fallback"), "gpt-5.6-sol");
});
