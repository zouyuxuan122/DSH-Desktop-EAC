// dsh-stt — 麦克风自测（迁移自原 client.js L445-500）。
// 3 层实时铺开：
//   ① 设备 —— 点开始立即显示打开结果（成功后回填设备列表）
//   ② 电平 —— 录音中实时电平条 + 百分比（DOM 直写，不卡）
//   ③ 识别结果 —— 每句说完自动转写显示（复用采集核心，实时）
// 与正式麦克风互斥：自测开启前先停掉正式采集（session.stopMic），
// 正式开启前也会经 session.startMic 停掉自测。
import { state, setState } from "./state.js";
import { createCaptureCore } from "./capture.js";
import { getController, stopMic } from "./session.js";

let diagController = null;   // 自测采集实例（独立于 session.controller）

function setLayer(i, status, text) {
  const layers = state.diagLayers.slice();
  layers[i] = { status: status, text: text };
  setState({ diagLayers: layers });
}

export function diagStart() {
  if (state.diagPhase !== 'idle') return;
  // 互斥：自测开启前先停掉正式麦克风，避免两个采集实例抢麦克风
  if (getController()) stopMic();
  setState({
    diagPhase: 'recording',
    diagLayers: [
      { status: 'live', text: '打开中…' },
      { status: 'live', text: '0%' },
      { status: 'wait', text: '' },
    ],
  });
  diagController = createCaptureCore({
    deviceId: state.deviceId,
    onDeviceReady: function (label) {
      setLayer(0, 'ok', label || '已打开');
    },
    onLevel: function (lvl) {
      const bar = document.getElementById('dsh-stt-diag-bar');
      const pct = document.getElementById('dsh-stt-diag-pct');
      if (bar) bar.style.width = Math.min(100, lvl * 200) + '%';
      if (pct) pct.textContent = Math.round(lvl * 100) + '%';
    },
    onRecordingStop: function (tooShort) {
      if (tooShort) setLayer(2, 'fail', '说话太短，请再说一遍');
      else setLayer(2, 'live', '识别中…');
    },
    onTranscript: function (text) {
      setLayer(2, text ? 'ok' : 'fail', text || '没听清');
    },
    onError: function (msg) {
      setLayer(2, 'fail', '识别失败: ' + msg);
    },
  });
  diagController.start().catch(function (err) {
    diagController = null;
    setLayer(0, 'fail', '打开失败: ' + ((err && err.message) || err));
    setState({ diagPhase: 'idle' });
  });
}

export function diagStop() {
  if (state.diagPhase === 'idle') return;
  setState({ diagPhase: 'idle' });
  if (diagController) { diagController.stop(); diagController = null; }
}
