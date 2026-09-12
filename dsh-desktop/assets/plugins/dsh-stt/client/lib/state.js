// dsh-stt — 模块级 UI 状态 store + 宿主状态轮询（迁移自原 client.js L384-443）。
import * as React from "react";

export const state = {
  micOn: false,          // 待机开关
  gate: { state: 'standby', awakeUntil: 0 },  // standby=待机 / armed=激活
  phase: 'idle',         // idle | recording | recognizing
  wakeWords: (function () { const D = '你好'; try { let v = localStorage.getItem('dsh-stt-wakewords'); if (v === '你好小助手') v = null; return v || D; } catch (e) { return D; } })(),
  deviceId: (function () { try { return localStorage.getItem('dsh-stt-device') || ''; } catch (e) { return ''; } })(),
  devices: [],
  diagPhase: 'idle',       // idle | recording（自测独立状态）
  diagLayers: [            // 3 层实时铺开：设备/电平/识别结果
    { status: 'wait', text: '' },
    { status: 'wait', text: '' },
    { status: 'wait', text: '' },
  ],
  models: {}, download: {}, engine: null, binary: null, error: null,
  recognized: "", sent: false, lastError: null,
  showGuide: false, downloadError: null,
};

const listeners = [];

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach(function (l) { try { l(); } catch (e) {} });
}

export function useSttState() {
  const reactState = React.useState(0);
  React.useEffect(function () {
    const i = listeners.push(function () { reactState[1](function (c) { return c + 1; }); });
    return function () { listeners.splice(i - 1, 1); };
  }, []);
  return state;
}

export function refreshStatus() {
  fetch('/api/dsh-stt/status').then(function (res) {
    return res.json().then(function (s) {
      setState({ models: s.models, download: s.download, engine: s.engine, binary: s.binary, error: null });
    }).catch(function () { setState({ status: "init" }); });
  }).catch(function () { setState({ status: "init" }); });
}

// 枚举音频输入设备（纯枚举，不请求权限）。浏览器隐私机制：未授权麦克风时
// enumerateDevices 返回空 deviceId，会被过滤掉——所以列表可能为空。
export function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  navigator.mediaDevices.enumerateDevices().then(function (list) {
    const inputs = list.filter(function (d) { return d.kind === 'audioinput' && d.deviceId; })
      .map(function (d) { return { id: d.deviceId, label: d.label || ('设备 ' + d.deviceId.slice(0, 8)) }; });
    setState({ devices: inputs });
  }).catch(function () {});
}

// 请求麦克风权限后再枚举（拿到真实设备列表）。授权弹窗只在这里触发——
// 由「刷新设备列表」按钮主动调用，不绑到启动或自测。
export function requestDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
    if (tmp) { tmp.getTracks().forEach(function (t) { t.stop(); }); }
    refreshDevices();
  }).catch(function () {});
}
