import assert from "node:assert/strict";
import test from "node:test";

import {
  isUnsupportedReasoningEffortError,
  normalizeReasoningEffort,
  shouldRetryWithoutReasoning,
} from "../assets/plugins/dsh-side-session/lib/reasoning-compat.js";

test("side session omits disabled reasoning instead of sending off", () => {
  assert.equal(normalizeReasoningEffort(undefined), undefined);
  assert.equal(normalizeReasoningEffort(""), undefined);
  assert.equal(normalizeReasoningEffort("off"), undefined);
  assert.equal(normalizeReasoningEffort(" OFF "), undefined);
});

test("side session preserves provider-supported reasoning levels", () => {
  assert.equal(normalizeReasoningEffort("low"), "low");
  assert.equal(normalizeReasoningEffort("none"), "none");
  assert.equal(normalizeReasoningEffort("max"), "max");
});

test("side session recognizes unsupported reasoning errors", () => {
  assert.equal(
    isUnsupportedReasoningEffortError(
      'provider "q" model "gpt-5.6-sol" does not support reasoning effort "off"'
    ),
    true
  );
  assert.equal(
    isUnsupportedReasoningEffortError({
      failure: { message: "invalid reasoning_effort value: max" },
    }),
    true
  );
  assert.equal(isUnsupportedReasoningEffortError("rate limit exceeded"), false);
});

test("side session only falls back before response text is written", () => {
  const error = "unsupported reasoningEffort value";
  assert.equal(shouldRetryWithoutReasoning(error, false, { reasoningEffort: "max" }), true);
  assert.equal(shouldRetryWithoutReasoning(error, true, { reasoningEffort: "max" }), false);
  assert.equal(shouldRetryWithoutReasoning(error, false, {}), false);
});
