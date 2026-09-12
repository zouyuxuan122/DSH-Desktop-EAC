// dsh-stt 前端纯逻辑（可单测源）。
// client.js（浏览器 bundle）内联同一实现 —— 两处保持同步，改动需同时更新。
// 对齐 SPEECH_DESIGN.md 第 3 章：动态基线 VAD 参数、唤醒词三层匹配、
// 文本过滤、片段合并。

// ── VAD 参数（SPEECH_DESIGN §3.2）────────────────────────
export const VAD_PARAMS = {
  silenceThreshold: 0.08,      // 绝对音量下限，防零底噪时阈值过低
  baselineWindowMs: 1000,      // 学习底噪的时间窗
  baselineMultiplier: 2.0,     // 底噪之上的裕度；越大越不易误触发
  silenceTimeoutMs: 900,       // 静音判定句末的时长
  minRecordingMs: 350,         // 短于它的片段丢弃（咳嗽/点击）
  maxRecordingMs: 8000,        // 超长语音强制截断
};

// 动态阈值 = max(绝对下限, 底噪 × 倍数)
export function voiceThreshold(baseline, params = VAD_PARAMS) {
  return Math.max(params.silenceThreshold, baseline * params.baselineMultiplier);
}

// 滚动更新底噪（指数移动平均）
export function updateBaseline(baseline, lvl, count, params = VAD_PARAMS) {
  if (count < Math.ceil(params.baselineWindowMs / 16.7)) {
    return baseline === 0 ? lvl : baseline * 0.9 + lvl * 0.1;
  }
  return baseline;
}

// ── 门控参数（SPEECH_DESIGN §3.5）────────────────────────
export const GATE_PARAMS = {
  followupWakeMs: 10000,   // 唤醒后免唤醒词窗口
};

// ── 合并参数（SPEECH_DESIGN §3.7）────────────────────────
export const COALESCE_MS = 800;

// ── 文本过滤（SPEECH_DESIGN §3.8，无 TTS 故无睡眠短语）──────
const HALLUCINATION_RE = /(感谢观看|谢谢观看|谢谢收看|thanks for watching|subscribe to|点赞关注|喜欢本视频)/gi;
const FILLER_RE = /^(嗯|啊|哦|呃|诶|唉|那个|这个|就是|然后|那么|其实|对吧|对吧嘛)\s*/;

export function filterText(text) {
  if (!text) return '';
  let t = String(text);
  t = t.replace(HALLUCINATION_RE, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(FILLER_RE, '').trim();
  return t;
}

// ── 发送关键词（语音说"发送"直接发送）────────────────
// 只在文本开头或末尾匹配发送词（用户说完内容停顿后说"发送"，或"发送"+内容）。
// 拒绝否定句（不要/别发送）与疑问句（能发送吗）。避免任意 indexOf 误触发。
const SEND_PHRASES = ['发送', '发出去', '发一下', 'send', 'sent', 'submit'];

export function stripSendPhrase(text) {
  const t = String(text || '').trim();
  if (!t) return { text: t, send: false };
  // 否定/疑问：不发送
  if (/(不要|别|不用|不想|能.{0,3}吗|是否|应该).{0,2}(发送|发出|send)/.test(t)) return { text: t, send: false };
  // 匹配前去掉末尾标点（"打开浏览器发送。" 也能命中）
  const base = stripTrailingPunctuation(t);
  const lower = base.toLowerCase();
  for (const phrase of SEND_PHRASES) {
    // 开头：发送<内容> / send <content>
    if (lower.startsWith(phrase)) {
      const rest = base.slice(phrase.length).replace(/^\s+/, '');
      // 纯"发送" → send:true 且 text 空（提交当前已填草稿）
      return rest ? { text: rest, send: true } : { text: '', send: true };
    }
    // 结尾：<内容>发送 / <content> send（前面至少有内容）
    if (lower.endsWith(phrase)) {
      const head = base.slice(0, base.length - phrase.length).replace(/\s+$/, '');
      return head ? { text: head, send: true } : { text: '', send: true };
    }
  }
  return { text: t, send: false };
}

// ── 文本清理：去掉末尾标点（SenseVoice ITN 输出带句号）──────
export function stripTrailingPunctuation(text) {
  return String(text || '').replace(/[。！？!?.,，、；;：:]+$/g, '').trim();
}

// ── 片段合并（长句被 VAD 切段后按 seq 排序拼接，各段去末尾标点）────
export function mergeSegments(parts) {
  const sorted = parts.slice().sort((a, b) => a.seq - b.seq);
  const text = sorted.map((p) => stripTrailingPunctuation(p.text)).join('').replace(/\s+/g, ' ').trim();
  return stripTrailingPunctuation(text);
}

// ── 唤醒词三层匹配（SPEECH_DESIGN §3.4）───────────────────
// 中文唤醒词：严格（原文包含）+ 编辑距离（同音/近字 ≤2）
// 英文唤醒词：+ 形状正则（辅音簇+元音形态，抗 ASR 误听）

export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i * (n + 1) + j] = Math.min(
        dp[(i - 1) * (n + 1) + j] + 1,
        dp[i * (n + 1) + j - 1] + 1,
        dp[(i - 1) * (n + 1) + j - 1] + cost
      );
    }
  }
  return dp[m * (n + 1) + n];
}

// 在整句中找与唤醒词编辑距离 ≤ maxDist 的滑动窗口
export function editDistanceIn(text, word, maxDist) {
  const n = text.length, m = word.length;
  if (n < Math.max(1, m - maxDist)) return false;
  for (let i = 0; i < n; i++) {
    for (let len = Math.max(1, m - maxDist); len <= Math.min(n - i, m + maxDist); len++) {
      if (levenshtein(text.slice(i, i + len), word) <= maxDist) return true;
    }
  }
  return false;
}

// 英文形状正则：把单词转成「辅音簇+元音」松散形态，容忍 ASR 元音误听
export function shapePatternOf(word) {
  if (/[一-鿿]/.test(word)) return null; // 中文不适用形状正则
  const CONSONANT = 'bcdfghjklmnpqrstvwxyz';
  const VOWEL = 'aeiouy';
  let pat = '';
  for (const ch of word.toLowerCase()) {
    if (CONSONANT.includes(ch)) pat += `[${CONSONANT}]`;
    else if (VOWEL.includes(ch)) pat += `[${VOWEL}]`;
    else pat += `\\${ch}`;
  }
  try { return new RegExp(pat); } catch { return null; }
}

export function isWakeWord(text, wakeWords) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  for (const raw of (wakeWords || [])) {
    const w = String(raw).trim().toLowerCase();
    if (!w) continue;
    // 中文唤醒词：只做裸包含匹配（参考设计 §3.4）。CJK 无拼写错误场景，
    // 编辑距离 maxDist=2 会让「你好」误匹配任意单字符（如「今天」的「今」），
    // 导致普通话语被误判成唤醒词。与 client.js 保持一致。
    if (/[一-鿿]/.test(w)) {
      if (t.includes(w)) return true;
      continue;
    }
    // 层 1 严格：原文包含
    if (t.includes(w)) return true;
    // 层 2 形状：英文辅音簇+元音形态
    const shape = shapePatternOf(w);
    if (shape && shape.test(t)) return true;
    // 层 3 编辑距离 ≤ 2（窗口）
    if (editDistanceIn(t, w, 2)) return true;
  }
  return false;
}

// 剥离唤醒词（SPEECH_DESIGN §3.4 stripWakeWord）：连续删除句中所有出现的
// 唤醒词，剩余内容作为命令（大小写不敏感，兼容英文唤醒词）。
export function stripWakeWord(text, wakeWords) {
  let t = String(text || '').trim();
  for (const raw of (wakeWords || [])) {
    const w = String(raw).trim();
    if (!w) continue;
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    t = t.replace(re, '');
  }
  return t.replace(/^[，。！？、；：,.\s]+/, '').trim();
}

// ── 片段合并缓冲（SPEECH_DESIGN §3.7）─────────────────────
// 返回 { merge, text, buffer }：merge=true 表示仍处合并窗内（拼接累积）；
// 窗从首片段到达起算，过期后提交并清空。
export function coalesceBuffer(buffer, text, now, coalesceMs = COALESCE_MS) {
  const parts = (buffer.parts || []).concat(text);
  const until = buffer.until || (now + coalesceMs);
  if (now < until) {
    return { merge: true, buffer: { parts, until }, text: parts.join('') };
  }
  return { merge: false, buffer: { parts: [], until: 0 }, text: parts.join('') };
}

// ── 审批意图识别（深度审批响应）────────────────────────────
// 识别语音文本是对审批的允许或拒绝。返回 { action: 'allow'|'reject'|null }。
const ALLOW_RE = /(允许|同意|确认|可以|好的|第一个|选1|approve|allow|yes|ok)/i;
const REJECT_RE = /(拒绝|取消|不要|不用|算了|stop|cancel|no)/i;

export function approvalIntent(text) {
  const t = String(text || '').trim();
  if (!t) return { action: null };
  // 拒绝优先（"不要"、"取消"更明确），排除否定句
  if (REJECT_RE.test(t) && !/(不是|不行|不能|不会)/.test(t)) return { action: 'reject' };
  if (ALLOW_RE.test(t)) return { action: 'allow' };
  return { action: null };
}

// ── 门控状态机（待机/激活）─────────────────────────────────
// gate: { state: 'standby'|'armed', awakeUntil }（standby=待机 dormant）
// 事件:
//   wakeword  识别到唤醒词 → armed（awakeUntil = now + followupWakeMs）
//   utterance 激活态说内容 → 保持 armed（续期）
//   end       一句结束(静音) → 回 standby（取消激活）
//   modelIdle 模型运行完成 → 重新 armed（若曾激活，续期）
//   timeout   超过 awakeUntil → 回 standby
export const GATE_EVENTS = { WAKE: 'wakeword', UTTER: 'utterance', END: 'end', MODEL_IDLE: 'modelIdle' };

export function nextGate(gate, event, now, params = GATE_PARAMS) {
  const g = gate || { state: 'standby', awakeUntil: 0 };
  switch (event) {
    case GATE_EVENTS.WAKE:
      return { state: 'armed', awakeUntil: now + params.followupWakeMs };
    case GATE_EVENTS.UTTER:
      return g.state === 'armed'
        ? { state: 'armed', awakeUntil: Math.max(g.awakeUntil, now + params.followupWakeMs) }
        : g;
    case GATE_EVENTS.END:
      return { state: 'standby', awakeUntil: 0 };
    case GATE_EVENTS.MODEL_IDLE:
      // 模型完成后重新激活：仅当之前处于 armed（最近激活过）
      return g.state === 'armed'
        ? { state: 'armed', awakeUntil: now + params.followupWakeMs }
        : g;
    default:
      return g;
  }
}

// 判断 gate 是否仍激活（未超时）
export function gateArmed(gate, now) {
  return gate && gate.state === 'armed' && now < gate.awakeUntil;
}
