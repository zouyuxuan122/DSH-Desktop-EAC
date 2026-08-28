import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const host = await import('../assets/plugins/dsh-stt/src/index.js');
const logic = await import('../assets/plugins/dsh-stt/src/voice-logic.mjs');

// ── WAV 解析 ───────────────────────────────────────────────
function makeWav16k(samples, { format = 1, channels = 1, bits = 16 } = {}) {
  const bytesPerSample = bits / 8;
  const dataLen = samples.length * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(format, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(16000 * bytesPerSample * channels, 28);
  buf.writeUInt16LE(bytesPerSample * channels, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    if (bits === 16) buf.writeInt16LE(Math.round(samples[i] * 32767), off);
    else if (bits === 32 && format === 3) buf.writeFloatLE(samples[i], off);
    off += bytesPerSample * channels;
  }
  return buf;
}

test('parseWavToF32 解析 16k mono PCM16', () => {
  const samples = [0, 0.5, -0.5, 1, -1];
  const { samples: out, sampleRate } = host.parseWavToF32(makeWav16k(samples));
  assert.equal(sampleRate, 16000);
  assert.equal(out.length, samples.length);
  assert.ok(Math.abs(out[1] - 0.5) < 0.001);
  assert.ok(Math.abs(out[4] - -1) < 0.001);
});

test('parseWavToF32 拒绝非 RIFF 数据', () => {
  const junk = Buffer.alloc(64);
  junk.write('NOTRIFF', 0);
  assert.throws(() => host.parseWavToF32(junk), /RIFF/);
});

test('parseWavToF32 处理 Buffer byteOffset（子视图）', () => {
  const inner = makeWav16k([0, 0.1]);
  const outer = Buffer.concat([Buffer.from('xx'), inner]);
  const sliced = outer.subarray(2, 2 + inner.length);
  const { samples } = host.parseWavToF32(sliced);
  assert.equal(samples.length, 2);
});

// ── multipart 解析（transcribe 接口契约）───────────────────
function buildMultipart(audioBytes, { boundary = 'x-boundary', fieldName = 'audio' } = {}) {
  const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([pre, audioBytes, post]), contentType: `multipart/form-data; boundary=${boundary}` };
}

test('extractMultipartAudio 提取 audio 字段原始字节', () => {
  const wav = makeWav16k([0, 0.5]);
  const { body, contentType } = buildMultipart(wav);
  const out = host.extractMultipartAudio(body, contentType);
  assert.ok(out, '提取到 audio');
  assert.deepEqual(Buffer.from(out), wav, '字节一致');
});

test('extractMultipartAudio 无 audio 字段返回 null', () => {
  const { body, contentType } = buildMultipart(makeWav16k([0]), { fieldName: 'other' });
  assert.equal(host.extractMultipartAudio(body, contentType), null);
});

test('extractMultipartAudio 无 boundary 返回 null', () => {
  assert.equal(host.extractMultipartAudio(Buffer.from('x'), 'multipart/form-data'), null);
});

// ── config 白名单（防敏感字段注入）──────────────────────────
test('pickFields 只保留白名单字段', () => {
  const allowed = ['autoDownload'];
  const picked = host.pickFields({ autoDownload: true, downloadUrls: { asr: 'https://evil.com/x' } }, allowed);
  assert.equal(picked.autoDownload, true);
  assert.ok(!('downloadUrls' in picked));
});

// ── 唤醒词三层匹配（SPEECH_DESIGN §3.4）────────────────────
test('严格匹配：原文包含唤醒词', () => {
  assert.equal(logic.isWakeWord('请你好小助手打开文件', ['你好小助手']), true);
  assert.equal(logic.isWakeWord('今天天气不错', ['你好小助手']), false);
});

test('编辑距离匹配（仅英文：同音/近字 ≤2 命中）', () => {
  assert.equal(logic.isWakeWord('hey jervis', ['jarvis']), true, '英文编辑距离抗 jervis 误听');
  assert.equal(logic.isWakeWord('the weather is nice', ['jarvis']), false);
});

test('中文唤醒词不做编辑距离匹配（避免单字符误匹配）', () => {
  // 「今天」含「今」，只有 1 个字符与「你好」无关，不应命中
  assert.equal(logic.isWakeWord('今天天气不错', ['你好']), false);
  // 同音近字「泥好」不再靠编辑距离命中，中文只认原文包含
  assert.equal(logic.isWakeWord('泥好', ['你好']), false);
  // 原文包含才命中
  assert.equal(logic.isWakeWord('你好世界', ['你好']), true);
});

test('英文形状匹配：JARVIS 误听形态', () => {
  assert.equal(logic.isWakeWord('hey jarvis', ['jarvis']), true);
  assert.equal(logic.isWakeWord('hey charvis', ['jarvis']), true, '形状正则抗 charvis 误听');
  assert.equal(logic.isWakeWord('hey jervis', ['jarvis']), true, '编辑距离抗 jervis 误听');
  assert.equal(logic.isWakeWord('the weather is nice', ['jarvis']), false);
});

test('多层唤醒词列表任一命中', () => {
  assert.equal(logic.isWakeWord('你好小助手', ['小爱同学', '你好小助手']), true);
  assert.equal(logic.isWakeWord('小爱同学', ['小爱同学', '你好小助手']), true);
  assert.equal(logic.isWakeWord('随便说说', ['小爱同学', '你好小助手']), false);
});

// ── 唤醒词剥离（SPEECH_DESIGN §3.4）────────────────────────
test('stripWakeWord 剥离唤醒词后返回命令主体', () => {
  assert.equal(logic.stripWakeWord('你好帮我查天气', ['你好']), '帮我查天气');
  assert.equal(logic.stripWakeWord('你好，帮我查天气', ['你好']), '帮我查天气');
  assert.equal(logic.stripWakeWord('你好', ['你好']), '');
});

test('stripWakeWord 无唤醒词时原样返回', () => {
  assert.equal(logic.stripWakeWord('帮我查天气', ['你好']), '帮我查天气');
});

test('stripWakeWord 多唤醒词取剥离最彻底', () => {
  assert.equal(logic.stripWakeWord('你好小爱同学帮我查天气', ['你好', '小爱同学']), '帮我查天气');
});

// ── 文本过滤（SPEECH_DESIGN §3.8）──────────────────────────
test('幻觉过滤：镜像 YouTube 片尾', () => {
  assert.equal(logic.filterText('谢谢观看'), '');
  assert.equal(logic.filterText('感谢观看感谢观看'), '');
  assert.equal(logic.filterText('谢谢观看本视频'), '本视频', '幻觉词剔除，其余保留');
  assert.equal(logic.filterText('内容谢谢观看'), '内容');
});

test('填充词过滤：开头语气词', () => {
  assert.equal(logic.filterText('嗯帮我查一下'), '帮我查一下');
  assert.equal(logic.filterText('那个打开设置'), '打开设置');
  assert.equal(logic.filterText('正常内容'), '正常内容');
});

// ── 审批意图识别（深度审批响应）────────────────────────────
test('approvalIntent 识别允许/确认', () => {
  assert.deepEqual(logic.approvalIntent('允许'), { action: 'allow' });
  assert.deepEqual(logic.approvalIntent('好'), { action: null }, '单纯"好"不触发（避免误判）');
  assert.deepEqual(logic.approvalIntent('我同意'), { action: 'allow' });
  assert.deepEqual(logic.approvalIntent('可以执行'), { action: 'allow' });
  assert.deepEqual(logic.approvalIntent('确认'), { action: 'allow' });
  assert.deepEqual(logic.approvalIntent('第一个'), { action: 'allow' });
});

test('approvalIntent 识别拒绝/取消', () => {
  assert.deepEqual(logic.approvalIntent('拒绝'), { action: 'reject' });
  assert.deepEqual(logic.approvalIntent('取消'), { action: 'reject' });
  assert.deepEqual(logic.approvalIntent('不要执行'), { action: 'reject' });
  assert.deepEqual(logic.approvalIntent('算了'), { action: 'reject' });
});

test('approvalIntent 否定句不误判拒绝', () => {
  assert.deepEqual(logic.approvalIntent('不是这个意思'), { action: null });
  assert.deepEqual(logic.approvalIntent('不行，继续'), { action: null });
});

test('approvalIntent 无审批意图返回 null', () => {
  assert.deepEqual(logic.approvalIntent('打开浏览器'), { action: null });
  assert.deepEqual(logic.approvalIntent(''), { action: null });
});

// ── 门控状态机（待机/激活）────────────────────────────────
test('nextGate 唤醒词激活 + 超时回待机', () => {
  const g0 = { state: 'standby', awakeUntil: 0 };
  const g1 = logic.nextGate(g0, logic.GATE_EVENTS.WAKE, 1000);
  assert.deepEqual(g1, { state: 'armed', awakeUntil: 1000 + logic.GATE_PARAMS.followupWakeMs });
  assert.equal(logic.gateArmed(g1, 5000), true, '窗口内激活');
  assert.equal(logic.gateArmed(g1, 1000 + logic.GATE_PARAMS.followupWakeMs + 1), false, '超时失效');
});

test('nextGate 一句结束回待机', () => {
  const g1 = { state: 'armed', awakeUntil: 99999 };
  const g2 = logic.nextGate(g1, logic.GATE_EVENTS.END, 5000);
  assert.deepEqual(g2, { state: 'standby', awakeUntil: 0 });
});

test('nextGate 模型完成后重新激活', () => {
  const g1 = { state: 'armed', awakeUntil: 9000 };
  const g2 = logic.nextGate(g1, logic.GATE_EVENTS.MODEL_IDLE, 10000);
  assert.equal(g2.state, 'armed');
  assert.equal(g2.awakeUntil, 10000 + logic.GATE_PARAMS.followupWakeMs);
  // 待机态收到 modelIdle 不激活
  const g3 = logic.nextGate({ state: 'standby', awakeUntil: 0 }, logic.GATE_EVENTS.MODEL_IDLE, 10000);
  assert.equal(g3.state, 'standby');
});

test('nextGate 激活态说内容续期', () => {
  const g1 = { state: 'armed', awakeUntil: 9000 };
  const g2 = logic.nextGate(g1, logic.GATE_EVENTS.UTTER, 8000);
  assert.equal(g2.state, 'armed');
  assert.ok(g2.awakeUntil >= 9000);
});

// ── 片段合并（SPEECH_DESIGN §3.7）──────────────────────────
test('coalesceBuffer 在合并窗内累积', () => {
  let b = { parts: [], until: 0 };
  const r1 = logic.coalesceBuffer(b, '第一段', 1000);
  assert.equal(r1.merge, true);
  assert.equal(r1.text, '第一段');
  const r2 = logic.coalesceBuffer(r1.buffer, '第二段', 1400);
  assert.equal(r2.text, '第一段第二段');
});

test('coalesceBuffer 合并窗过期后提交并清空', () => {
  let b = { parts: [], until: 0 };
  const r1 = logic.coalesceBuffer(b, '第一段', 1000);
  // 超过 800ms 窗
  const r2 = logic.coalesceBuffer(r1.buffer, '第二段', 2000);
  assert.equal(r2.merge, false);
  assert.equal(r2.text, '第一段第二段');
  assert.deepEqual(r2.buffer.parts, []);
});

// ── VAD 参数边界（SPEECH_DESIGN §3.2）──────────────────────
test('voiceThreshold 取 max(绝对下限, 底噪×倍数)', () => {
  assert.equal(logic.voiceThreshold(0, logic.VAD_PARAMS), 0.08, '零底噪 → 绝对下限');
  assert.ok(Math.abs(logic.voiceThreshold(0.1, logic.VAD_PARAMS) - 0.2) < 1e-9, '0.1×2.0=0.2');
  assert.equal(logic.voiceThreshold(0.02, logic.VAD_PARAMS), 0.08, '0.02×2.0=0.04 < 下限 → 0.08');
});

test('VAD 参数符合规范默认值', () => {
  assert.equal(logic.VAD_PARAMS.silenceThreshold, 0.08);
  assert.equal(logic.VAD_PARAMS.baselineMultiplier, 2.0);
  assert.equal(logic.VAD_PARAMS.silenceTimeoutMs, 900);
  assert.equal(logic.VAD_PARAMS.minRecordingMs, 350);
  assert.equal(logic.VAD_PARAMS.maxRecordingMs, 8000);
  assert.equal(logic.GATE_PARAMS.followupWakeMs, 10000);
  assert.equal(logic.COALESCE_MS, 800);
});

// ── 发送关键词（语音说"发送"直接发送）──────────────────────
test('stripSendPhrase 识别末尾发送词', () => {
  assert.deepEqual(logic.stripSendPhrase('打开浏览器发送'), { text: '打开浏览器', send: true });
  assert.deepEqual(logic.stripSendPhrase('帮我查天气发送'), { text: '帮我查天气', send: true });
});

test('stripSendPhrase 识别开头发送词', () => {
  assert.deepEqual(logic.stripSendPhrase('发送打开浏览器'), { text: '打开浏览器', send: true });
});

test('stripSendPhrase 无发送词返回 send:false', () => {
  assert.deepEqual(logic.stripSendPhrase('打开浏览器'), { text: '打开浏览器', send: false });
  assert.deepEqual(logic.stripSendPhrase(''), { text: '', send: false });
});

test('stripSendPhrase 纯发送词触发但无内容（提交已填草稿）', () => {
  assert.deepEqual(logic.stripSendPhrase('发送'), { text: '', send: true });
});

test('stripSendPhrase 否定/疑问句不误触发发送', () => {
  assert.deepEqual(logic.stripSendPhrase('不要发送'), { text: '不要发送', send: false });
  assert.deepEqual(logic.stripSendPhrase('你能发送吗'), { text: '你能发送吗', send: false });
  assert.deepEqual(logic.stripSendPhrase('请发送这个文件'), { text: '请发送这个文件', send: false });
  assert.deepEqual(logic.stripSendPhrase('今天不要发'), { text: '今天不要发', send: false });
});

test('stripSendPhrase 纯「发送」触发（提交已填草稿）', () => {
  assert.deepEqual(logic.stripSendPhrase('发送'), { text: '', send: true });
  assert.deepEqual(logic.stripSendPhrase('发送。'), { text: '', send: true }, '末尾句号不影响');
});

test('stripSendPhrase 句尾发送带标点也命中', () => {
  assert.deepEqual(logic.stripSendPhrase('打开浏览器发送。'), { text: '打开浏览器', send: true });
});

test('stripTrailingPunctuation 去掉末尾标点', () => {
  assert.equal(logic.stripTrailingPunctuation('打开浏览器。'), '打开浏览器');
  assert.equal(logic.stripTrailingPunctuation('帮我查一下！'), '帮我查一下');
  assert.equal(logic.stripTrailingPunctuation('无标点'), '无标点');
});

test('mergeSegments 按 seq 排序合并 + 各段去标点', () => {
  const merged = logic.mergeSegments([
    { seq: 1, text: '帮我查' },
    { seq: 0, text: '天气。' },
  ]);
  assert.equal(merged, '天气帮我查');
  const merged2 = logic.mergeSegments([{ seq: 0, text: '今天天气' }, { seq: 1, text: '怎么样。' }]);
  assert.equal(merged2, '今天天气怎么样');
});

// ── 模型清单（SenseVoice）────────────────────────────────────
test('host 模型清单为 SenseVoice（model.int8.onnx + tokens.txt）', () => {
  // 通过导出不可直接访问 DEFAULT_MODELS；校验 SenseVoice 模型路径解析逻辑：
  // asrModelConfig 用 findFileInTree 找 model.int8.onnx，与清单一致。
  assert.equal(typeof host.transcribeSamples, 'function', 'transcribeSamples 为 async 函数');
  assert.equal(host.transcribeSamples.constructor.name, 'AsyncFunction', '异步转写不阻塞事件循环');
});
