export function normalizeReasoningEffort(value) {
  const effort = String(value == null ? "" : value).trim();
  if (!effort || effort.toLowerCase() === "off") return undefined;
  return effort;
}

function errorText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;

  const parts = [];
  if (typeof value.message === "string") parts.push(value.message);
  if (typeof value.detail === "string") parts.push(value.detail);
  if (typeof value.code === "string") parts.push(value.code);
  if (value.error && value.error !== value) parts.push(errorText(value.error));
  if (value.failure && value.failure !== value) parts.push(errorText(value.failure));
  try {
    parts.push(JSON.stringify(value));
  } catch {}
  return parts.join(" ");
}

export function isUnsupportedReasoningEffortError(value) {
  const detail = errorText(value).toLowerCase();
  const namesReasoningEffort =
    detail.includes("reasoning effort") ||
    detail.includes("reasoning_effort") ||
    detail.includes("reasoningeffort");
  const rejectsValue =
    detail.includes("does not support") ||
    detail.includes("not supported") ||
    detail.includes("unsupported") ||
    detail.includes("invalid") ||
    detail.includes("not allowed");
  return namesReasoningEffort && rejectsValue;
}

export function shouldRetryWithoutReasoning(value, wroteText, options) {
  return (
    !wroteText &&
    Object.prototype.hasOwnProperty.call(options || {}, "reasoningEffort") &&
    isUnsupportedReasoningEffortError(value)
  );
}
