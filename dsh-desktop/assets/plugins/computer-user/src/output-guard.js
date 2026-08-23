/**
 * computer-user / output-guard.js — LLM output filter (host side).
 *
 * Sits on the provider `stream()` exit and inspects the assistant TEXT output:
 *
 *  - If the model writes pseudo tool-call / XML markup as CONVERSATION TEXT
 *    (e.g. `computer_click({ coordinate: [1,2] })` or `<invoke ...>` typed out
 *    instead of a real tool call), that text is REJECTED (stripped from the
 *    stream) and replaced with a one-time coaching note telling the model to
 *    either call the tool properly or, if it really means to output that text,
 *    output it again — the SECOND occurrence of the same fingerprint passes
 *    through untouched (no infinite loop).
 *
 * The DSH adapter stream emits raw chunks: text arrives as `{ type:
 * 'text-delta', text }`. We buffer text deltas, sniff the buffer, and decide
 * per fingerprint.
 *
 * @module computer-user/output-guard
 */

import { createHash } from 'node:crypto';

/** Regexes for "fake tool call written as conversation text". */
const FAKE_CALL_RE = [
  // pseudo XML invoke / usage (e.g. <invoke name="computer_click">, <使用工具：…>)
  /<\s*(?:invoke|use|使用|tool)[^>]*>/i,
  // a bare tool-call-like snippet: computer_xxx({ ... })
  /computer_[a-z_]+\s*\(\s*\{[^}]*\}\s*\)/i,
  // leading "await computer_…" call line
  /(?:\bawait\s+)?computer_[a-z_]+\(/,
  // stray XML-ish closing or opening tags like </invoke> <tool_call>
  /<\s*\/\s*(?:invoke|use|tool)[^>]*>/i,
];

/** Hash a fingerprint string for the pass-after-N decision. */
function fingerprintOf(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 24);
}

/**
 * Detect whether a buffered text chunk contains a fake tool-call written as
 * plain conversation text. Returns the matched fingerprint or null.
 * @param {string} text
 * @returns {string|null}
 */
export function detectFakeToolText(text) {
  if (!text || typeof text !== 'string') return null;
  for (const re of FAKE_CALL_RE) {
    const m = re.exec(text);
    if (m) return fingerprintOf(m[0]);
  }
  return null;
}

/**
 * Output guard state machine. Feed it text deltas as they stream; it keeps a
 * buffer (pruned to a tail window) and a per-fingerprint counter.
 *
 * decide() returns:
 *   { kind: 'pass' }              — nothing suspicious
 *   { kind: 'reject', note }      — first occurrence: strip & emit coaching note
 *   { kind: 'pass-second' }       — same fingerprint re-issued → allow through
 */
export function createOutputGuard({
  bufferWindow = 4000,
  allowAfter = 2, // allow the Nth same-fingerprint occurrence
  noteFactory,
} = {}) {
  let buffer = '';
  const counts = new Map();
  const noteFactory2 = noteFactory || (() => (
    '（输出已过滤：检测到把工具调用以对话文本形式输出了。' +
    '若确实需要调用工具请改为真正的工具调用；若确实要原样输出该文本，请再输出一次，第二次将放行不拦截。）'
  ));

  /**
   * Append one text delta (or full text piece) and optionally decide.
   * @param {string} delta
   * @returns {import('./output-guard.js').Decision}
   */
  function sniff(delta) {
    if (typeof delta !== 'string') return { kind: 'pass' };
    buffer = (buffer + delta).slice(-bufferWindow);
    const fp = detectFakeToolText(buffer);
    if (!fp) return { kind: 'pass' };
    const n = (counts.get(fp) ?? 0) + 1;
    counts.set(fp, n);
    // reset buffer after consuming a hit so we don't re-detect the same text
    buffer = '';
    if (n >= allowAfter) return { kind: 'pass-second', fingerprint: fp, occurrence: n };
    return { kind: 'reject', fingerprint: fp, occurrence: n, note: noteFactory2() };
  }

  return { sniff, counts, detectFakeToolText };
}

export default { detectFakeToolText, createOutputGuard };