// dsh-stt — 纯采集核心（迁移自原 client.js L541-661）。
// getUserMedia + 动态基线 VAD + MediaRecorder + WAV 转写上传。
// 只负责「采集音频、判句末、送转写」，通过回调输出，不关心门控/填框/自测。
// 正式模式和自测各自 new 一个实例，互不干扰。
// 纯逻辑参数取自 src/voice-logic.mjs 的 VAD_PARAMS（单一事实源）。
import { VAD_PARAMS, voiceThreshold, filterText } from "../../src/voice-logic.mjs";
import {
  getUserMediaWithTimeout,
  decodeToPcm16,
  f32ToWav,
  postWavForTranscribe,
} from "./audio.js";

// 底噪学习窗（帧数）：采样间隔 30ms，对齐 VAD_PARAMS.baselineWindowMs=1000ms
const BASELINE_FRAMES = Math.max(1, Math.round(VAD_PARAMS.baselineWindowMs / 30));

//   opts.deviceId            —— 输入设备（空 = 系统默认）
//   opts.onDeviceReady(label) —— 设备打开成功
//   opts.onLevel(lvl,now,recording,recStart) —— 每帧电平
//   opts.onRecordingStart()   —— 开始录音
//   opts.onRecordingStop(tooShort) —— 录音停止（tooShort=true 片段被丢弃）
//   opts.onTranscript(text,seq) —— 转写成功（已 filterText，短片段不触发）
//   opts.onError(msg)         —— 转写失败
export function createCaptureCore(opts) {
  let stream = null, audioCtx = null, analyser = null, data = null, source = null;
  let recorder = null, chunks = [];
  let baseline = 0, baseFrames = 0;
  let recording = false, recStart = 0, lastVoiceAt = 0;
  let timerId = 0, active = false;
  let generation = 0;   // 会话代号：stop() 后 bump，让在途异步转写结果失效
  let segSeq = 0;   // 每段录音递增序号，合并时按序拼接（解决返回乱序）

  function start() {
    if (active) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('getUserMedia unavailable'));
    }
    const audioCfg = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    // 用户指定了输入设备时，用 exact deviceId 精确锁定，避免系统默认选成线路输入
    if (opts.deviceId) { audioCfg.deviceId = { exact: opts.deviceId }; }
    return getUserMediaWithTimeout(audioCfg).then(function (s) {
      stream = s;
      const tk = s.getAudioTracks()[0];
      if (opts.onDeviceReady) opts.onDeviceReady(tk && tk.label);
      audioCtx = new AudioContext();
      // Chromium 在 getUserMedia 的异步回调里创建的 AudioContext 常处于
      // suspended 态，analyser 拿不到数据 → VAD 永远检测不到声音。显式 resume。
      if (audioCtx.state === 'suspended') { audioCtx.resume().catch(function () {}); }
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      data = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      active = true;
      // 用 setInterval 采样：requestAnimationFrame 在 WebView2 失焦/后台
      // 会被节流甚至停掉，导致 VAD 永远采不到声音。
      timerId = setInterval(frame, 30);
    });
  }

  function stop() {
    active = false;
    generation++;   // 使所有在途异步转写结果失效，杜绝跨会话串结果
    if (timerId) { clearInterval(timerId); timerId = 0; }
    if (recorder && recording) { try { recorder.stop(); } catch (e) {} }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (audioCtx) { audioCtx.close().catch(function () {}); audioCtx = null; }
  }

  function frame() {
    if (!active) return;
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const lvl = sum / data.length / 255;
    const now = performance.now();
    if (opts.onLevel) opts.onLevel(lvl, now, recording, recStart);
    const thr = voiceThreshold(baseline);
    if (!recording) {
      if (baseFrames < BASELINE_FRAMES) {
        baseline = baseline === 0 ? lvl : baseline * 0.9 + lvl * 0.1;
        baseFrames++;
      }
      if (lvl > thr) startRecording(now);
    } else {
      if (lvl > thr) lastVoiceAt = now;
      else if (now - lastVoiceAt > VAD_PARAMS.silenceTimeoutMs) { stopRecording(); }
      else if (now - recStart > VAD_PARAMS.maxRecordingMs) { stopRecording(); }
    }
  }

  function startRecording(now) {
    recording = true; recStart = now; lastVoiceAt = now; chunks = [];
    if (opts.onRecordingStart) opts.onRecordingStart();
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = onRecordingStopped;
    recorder.start(100);
  }

  function stopRecording() {
    recording = false;
    if (recorder) { try { recorder.stop(); } catch (e) {} }
  }

  function onRecordingStopped() {
    const duration = performance.now() - recStart;
    recorder = null;
    const tooShort = duration < VAD_PARAMS.minRecordingMs;
    if (opts.onRecordingStop) opts.onRecordingStop(tooShort);
    if (tooShort) return;
    const myGen = generation;   // 捕获当前会话代号
    const mySeq = segSeq++;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    blob.arrayBuffer().then(function (ab) {
      return decodeToPcm16(ab, 48000).then(f32ToWav);
    }).then(function (wav) {
      return postWavForTranscribe(wav);
    }).then(function (r) {
      // 会话已结束（stop 后 generation bump），丢弃过期结果
      if (myGen !== generation) return;
      if (opts.onTranscript) opts.onTranscript(filterText(r.text || ''), mySeq);
    }).catch(function (e) {
      if (myGen !== generation) return;
      if (opts.onError) opts.onError((e && e.message) || String(e));
    });
  }

  return { start: start, stop: stop };
}
