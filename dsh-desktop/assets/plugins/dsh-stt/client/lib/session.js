// dsh-stt — 语音会话编排（迁移自原 client.js L502-539、L699-805）。
// 持有正式/自测采集实例与合并缓冲，负责门控调度：审批响应 → 发送触发 →
// 唤醒/累积。门控状态转换统一走 src/voice-logic.mjs 的 nextGate/gateArmed
// 状态机（原来散落各处的手写 gate 赋值已收编）。
import {
  GATE_PARAMS,
  GATE_EVENTS,
  nextGate,
  gateArmed,
  stripSendPhrase,
  mergeSegments,
  isWakeWord,
  stripWakeWord,
  stripTrailingPunctuation,
  approvalIntent,
  COALESCE_MS,
} from "../../src/voice-logic.mjs";
import { state, setState } from "./state.js";
import { createCaptureCore } from "./capture.js";
import { readComposerDraft, setComposerDraft, getInputActions } from "./composer.js";
import { respondToApproval } from "./approval.js";
import { diagStop } from "./diag.js";

let controller = null;       // 正式语音识别采集实例
let diagController = null;   // 自测采集实例（独立，互不干扰）
const pending = { parts: [], timer: null };   // 激活态累积的待提交片段（长句分段合并）

export function getController() {
  return controller;
}

export function getDiagController() {
  return diagController;
}

export function getWakeWords() {
  return (state.wakeWords || '').split(',').map(function (w) { return w.trim(); }).filter(Boolean);
}

function clearPendingTimer() {
  if (pending.timer) { clearTimeout(pending.timer); pending.timer = null; }
}

// 提交累积片段（合并窗口到/说"发送"触发）
function commitPending(extraText) {
  clearPendingTimer();
  const parts = pending.parts.slice();
  pending.parts = [];
  if (extraText) parts.push({ seq: 1e9, text: extraText });
  if (!parts.length) return;
  const combined = mergeSegments(parts);
  if (!combined) return;
  // 追加到输入框，不覆盖已有内容；两句话之间用逗号分隔，避免连成一团
  const existing = readComposerDraft();
  const finalText = existing ? existing + '，' + combined : combined;
  setComposerDraft(finalText);
  // 保持 armed 并续期：连续说话免唤醒；只有「发送」或「长时间没说话超时」才回待机
  setState({ recognized: finalText, sent: false, lastError: null, gate: nextGate(state.gate, GATE_EVENTS.UTTER, Date.now()) });
}

// 激活态说话：累积到 pending，合并窗口后一次提交（长句被切段不丢）
function bufferUtterance(text, seq) {
  pending.parts.push({ seq: seq, text: text });
  clearPendingTimer();
  pending.timer = setTimeout(function () { commitPending(); }, COALESCE_MS);
}

// 识别结果统一处理（审批响应优先，然后发送触发，然后门控 + 合并累积）
export function handleTranscribed(text, seq) {
  if (!text) { setState({ lastError: 'noSpeak' }); return; }
  // 1. 审批响应：页面有审批面板时，识别到允许/拒绝直接响应
  const hasApproval = !!document.querySelector('[data-approval-key]');
  if (hasApproval) {
    const intent = approvalIntent(text);
    if (intent.action) {
      const done = respondToApproval(intent.action);
      if (done) {
        setState({ recognized: intent.action === 'allow' ? 'approved' : 'rejected', sent: false, lastError: null, gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()) });
        clearPendingTimer();
        pending.parts = [];
        return;
      }
    }
    setState({ gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()), lastError: null });
    return;
  }
  // 2. 发送触发：识别到「发送」→ 提交累积内容 + 本次去发送词内容（不依赖激活态）
  const stripped = stripSendPhrase(text);
  if (stripped.send) {
    const actions0 = getInputActions();
    if (actions0 && actions0.submit) {
      const allParts = pending.parts.slice();
      clearPendingTimer();
      pending.parts = [];
      const combined = mergeSegments(stripped.text ? allParts.concat([{ seq: 1e9, text: stripped.text }]) : allParts);
      if (combined) setComposerDraft(combined);
      // combined 空且输入框草稿也空 → 无内容可发，不 submit（否则空消息 no-op 造成「闪一下」）
      const effective = combined || readComposerDraft() || '';
      if (!effective) {
        setState({ recognized: '', sent: false, lastError: 'noDraft', gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()) });
        return;
      }
      setState({ recognized: effective, sent: true, lastError: null, gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()) });
      setTimeout(function () {
        try { actions0.submit(); }
        catch (e) {}
      }, 50);
    }
    return;
  }
  // 3. 门控：待机 → 仅唤醒词激活；激活 → 内容累积合并。
  //    armed 超时（awakeUntil 已过）先经 END 归位 standby，再按待机处理。
  const words = getWakeWords();
  const now = Date.now();
  let gate = state.gate;
  if (gate.state === 'armed' && !gateArmed(gate, now)) {
    gate = nextGate(gate, GATE_EVENTS.END, now);
    setState({ gate: gate });
  }
  if (gate.state !== 'armed') {
    if (words.length && isWakeWord(text, words)) {
      // 剥离唤醒词，剩余内容若非空则在同一句内直接作为命令处理
      // （「你好帮我查天气」→ 激活 + 填「帮我查天气」，不再丢整句）
      gate = nextGate(gate, GATE_EVENTS.WAKE, now);
      const rest = stripWakeWord(text, words);
      if (rest) {
        setState({ gate: gate, recognized: stripTrailingPunctuation(rest), sent: false, lastError: null });
        bufferUtterance(stripTrailingPunctuation(rest), seq);
      } else {
        setState({ gate: gate, recognized: '', sent: false, lastError: null });
      }
    }
    // 待机非唤醒词丢弃（P2 静默丢弃）——绝不填框
    return;
  }
  // armed：累积片段，合并窗口后一次提交（长句被切段不丢，按序拼接）
  bufferUtterance(stripTrailingPunctuation(text), seq);
  setState({ recognized: stripTrailingPunctuation(text), sent: false, lastError: null });
}

export function startMic() {
  if (controller) return;
  // 互斥：正式麦克风开启前先停掉自测
  if (diagController) diagStop();
  setState({ micOn: true, lastError: null, phase: 'idle', gate: { state: 'standby', awakeUntil: 0 } });
  controller = createCaptureCore({
    deviceId: state.deviceId,
    onLevel: function () {
      // armed 超时回退：激活后长时间没说话自动回待机，下次需重新说唤醒词
      if (state.gate.state === 'armed' && !gateArmed(state.gate, Date.now())) {
        setState({ gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()) });
      }
    },
    onRecordingStart: function () { setState({ phase: 'recording' }); },
    onRecordingStop: function (tooShort) {
      setState({ phase: tooShort ? 'idle' : 'recognizing' });
    },
    onTranscript: function (text, seq) {
      handleTranscribed(text, seq);
      setState({ phase: 'idle' });
    },
    onError: function () { setState({ phase: 'idle', lastError: 'noSpeak' }); },
  });
  controller.start().catch(function (err) {
    controller = null;
    setState({ micOn: false, lastError: err && err.message === 'mic-timeout' ? 'micTimeout' : 'micDenied' });
  });
}

export function stopMic() {
  if (controller) { controller.stop(); controller = null; }
  clearPendingTimer();
  pending.parts = [];
  setState({ micOn: false, phase: 'idle', gate: { state: 'standby', awakeUntil: 0 } });
}
