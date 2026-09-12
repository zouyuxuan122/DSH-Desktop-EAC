// dsh-stt — 麦克风按钮（迁移自原 client.js L807-871）。
// 点按切换待机。禁用形有两种：
//   · 引擎缺失（engine=missing，分发未带 sherpa-onnx）→ 灰化，点击只提示
//   · 模型未就绪（missing/error）→ 灰化 + 斜线图标，点击展开下载引导条
// 词典访问统一走 tt(key)：slot 渲染不传 props.t，直接用 zh 对象兜底。
import * as React from "react";
import { state, setState, useSttState } from "../lib/state.js";
import { startMic, stopMic } from "../lib/session.js";
import { setInputActions } from "../lib/composer.js";
import { zh } from "../lib/i18n.js";

const h = React.createElement;

export const MicButton = function (props) {
  const stt = useSttState();
  if (props.inputActions) setInputActions(props.inputActions);
  const tt = function (k) { return props.t ? props.t(k) : zh[k]; };
  // binary=missing：分发未带 sherpa-onnx 引擎（构建/安装时未拉取），无法通过
  // 下载模型解决，按钮只提示；modelNotReady：走既有下载引导。
  const engineMissing = stt.binary === 'missing';
  const modelState = (stt.models && stt.models.asr) || 'missing';
  const modelNotReady = !engineMissing && modelState !== 'ready';

  function onToggle() {
    if (engineMissing) {
      setState({ lastError: 'engineMissing', recognized: '', sent: false });
      return;
    }
    if (modelNotReady) {
      setState({ showGuide: true, lastError: 'modelNeeded', recognized: '', sent: false });
      return;
    }
    if (stt.micOn) stopMic();
    else startMic();
  }

  // 四态：关闭(透明)/待机(蓝底)/激活(蓝底+绿细环)/识别(黄底+环共存)
  let cls = "__stt_micBtn ";
  let title = tt('micOff');
  if (engineMissing || modelNotReady) {
    cls += '__stt_micBtnMissing';
    title = engineMissing ? tt('engineMissing') : tt('micModelNeeded');
  } else if (stt.micOn) {
    if (stt.phase === 'recognizing') {
      cls += '__stt_micBtnRecognizing';
      title = tt('micRecognizing');
      if (stt.gate.state === 'armed') cls += ' __stt_micBtnArmed';
    } else if (stt.gate.state === 'armed') {
      cls += '__stt_micBtnStandby __stt_micBtnArmed';
      title = tt('micInput');
    } else {
      cls += '__stt_micBtnStandby';
      title = tt('micStandby');
    }
  }

  // 禁用图标：麦克风 + 左上到右下斜线（经典禁用形）
  let icon;
  if (engineMissing || modelNotReady) {
    icon = h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" }),
      h("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
      h("line", { x1: 12, y1: 19, x2: 12, y2: 22 }),
      h("line", { x1: 3, y1: 3, x2: 21, y2: 21 }));
  } else if (stt.phase === 'recognizing') {
    icon = h("span", { className: "__stt_spinner" });
  } else {
    icon = h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" }),
      h("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
      h("line", { x1: 12, y1: 19, x2: 12, y2: 22 }));
  }

  return h("button", {
    type: "button",
    className: cls,
    title: title,
    "aria-label": title,
    onClick: onToggle,
  }, icon);
};
