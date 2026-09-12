// dsh-stt — 浏览器音频工具（迁移自原 client.js L309-366）。

export const MIC_TIMEOUT_MS = 3000;

// 录音 Blob → 16kHz Float32 PCM（WebAudio 重采样）
export function decodeToPcm16(arrayBuffer, sampleRate) {
  return new Promise(function (resolve, reject) {
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    audioCtx.decodeAudioData(arrayBuffer, function (audioBuffer) {
      const src = audioBuffer.getChannelData(0);
      const targetRate = 16000;
      const out = new Float32Array(Math.ceil(src.length * targetRate / (audioBuffer.sampleRate || sampleRate)));
      const ratio = src.length / out.length;
      for (let i = 0; i < out.length; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, src.length - 1);
        const frac = pos - i0;
        out[i] = src[i0] * (1 - frac) + src[i1] * frac;
      }
      audioCtx.close();
      resolve(out);
    }, function (err) {
      audioCtx.close();
      reject(err);
    });
  });
}

// Float32 PCM → 16kHz WAV Blob（手写 RIFF 头）
export function f32ToWav(samples) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  function writeStr(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
  writeStr(0, "RIFF"); view.setUint32(4, 36 + numSamples * 2, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 16000 * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, numSamples * 2, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function postWavForTranscribe(wav) {
  const fd = new FormData();
  fd.append('audio', wav, 'speech.wav');
  return fetch('/api/dsh-stt/transcribe', { method: 'POST', body: fd })
    .then(function (res) { return res.json().catch(function () { return {}; }); });
}

export function getUserMediaWithTimeout(constraints) {
  const gum = navigator.mediaDevices.getUserMedia({ audio: constraints });
  const timer = new Promise(function (_, reject) {
    setTimeout(function () { reject(new Error('mic-timeout')); }, MIC_TIMEOUT_MS);
  });
  return Promise.race([gum, timer]);
}
