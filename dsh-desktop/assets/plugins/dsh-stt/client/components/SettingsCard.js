// dsh-stt — 设置卡片（迁移自原 client.js L922-1035）。
// settings.section slot 的主体：唤醒词、输入设备、麦克风自测、保存、
// 识别模型行（未就绪时常显引导条）。
import * as React from "react";
import { state, setState, useSttState, refreshDevices, requestDevices, refreshStatus } from "../lib/state.js";
import { diagStart, diagStop } from "../lib/diag.js";
import { ModelGuideBar } from "./ModelGuideBar.js";

const h = React.createElement;

const SettingRow = function (props) {
  return h("div", { className: "__stt_field" },
    h("label", { className: "__stt_label" }, props.label, props.hint && h("span", { className: "__stt_hint" }, props.hint)),
    props.children);
};

export const SettingsCard = function (props) {
  const t = props.t;
  // 订阅 state 变化触发重渲染：setLayer（识别结果）/ setState（diagPhase 按钮切换）
  // 若不加，state 变了但组件不重渲染，UI 不实时刷新（之前空 sync 就是这个 bug）。
  useSttState();
  const wakeState = React.useState(state.wakeWords);
  const wake = wakeState[0];
  const setWake = wakeState[1];

  React.useEffect(function () {
    refreshDevices();
  }, []);

  function save() {
    const v = (wake || '').trim();
    try { localStorage.setItem('dsh-stt-wakewords', v); } catch (e) {}
    setState({ wakeWords: v, error: null });
  }

  function saveDevice(id) {
    try { localStorage.setItem('dsh-stt-device', id || ''); } catch (e) {}
    setState({ deviceId: id || '' });
  }

  function downloadModel() {
    setState({ error: null });
    fetch('/api/dsh-stt/download', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function () { refreshStatus(); })
      .catch(function () { setState({ error: 'saveFailed' }); });
  }

  const models = state.models || {};
  const modelState = models.asr || 'missing';
  const dl = state.download && state.download.asr;
  const modelLabel = modelState === 'ready' ? t('modelReady')
    : modelState === 'downloading' ? (dl && dl.pct != null ? dl.pct + '% ' : '') + t('modelDownloading')
    : modelState === 'error' ? t('modelError') : t('modelMissing');

  return h("div", { className: "__stt_root" },
    h("p", { className: "__stt_hint" }, t("intro")),
    h(SettingRow, { label: t("wakeWords"), hint: t("wakeWordsHint") },
      h("input", {
        className: "__stt_input",
        value: wake,
        placeholder: state.wakeWords,
        onChange: function (e) { setWake(e.target.value); },
      })),
    h(SettingRow, { label: t("device"), hint: t("deviceHint") },
      h("div", { className: "__stt_row" },
        h("select", {
          className: "__stt_input",
          value: state.deviceId,
          onChange: function (e) { saveDevice(e.target.value); },
        },
          h("option", { value: "" }, t("deviceDefault")),
          (state.devices || []).map(function (d) {
            return h("option", { key: d.id, value: d.id }, d.label);
          })),
        h("button", { className: "__stt_btn", onClick: requestDevices }, t("deviceRefresh")))),
    h(SettingRow, { label: t("diagTitle"), hint: t("diagHint") },
      h("div", { className: "__stt_root" },
        h("div", { className: "__stt_row" },
          state.diagPhase === 'idle'
            ? h("button", { className: "__stt_btn __stt_btnPrimary", onClick: diagStart }, t("diagStart"))
            : h("button", { className: "__stt_btn __stt_btnPrimary", onClick: diagStop }, t("diagStop")),
          state.diagPhase === 'recording' && h("span", { className: "__stt_statusPulse" }, t("diagRecHint"))),
        (function () {
          const layerNames = [t("diagLayer1"), t("diagLayer2"), t("diagLayer3")];
          function statusChar(st) {
            if (st === 'ok') return { ch: '✓', cls: '__stt_ok' };
            if (st === 'fail') return { ch: '✗', cls: '__stt_error' };
            if (st === 'live') return { ch: '…', cls: '__stt_statusPulse' };
            return { ch: '·', cls: '__stt_status' };
          }
          return (state.diagLayers || []).map(function (layer, i) {
            const sc = statusChar(layer.status);
            // 电平层：带实时进度条
            if (i === 1) {
              return h("div", { key: i, className: "__stt_row", style: { alignItems: 'center' } },
                h("span", { className: sc.cls }, sc.ch),
                h("span", { className: "__stt_label", style: { minWidth: 52 } }, layerNames[i]),
                h("div", { style: { flex: 1, height: 6, background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 3, overflow: 'hidden' } },
                  h("div", { id: "dsh-stt-diag-bar", style: { width: '0%', height: '100%', background: 'var(--dsw-alias-state-business-primary)', transition: 'width .1s linear' } })),
                h("span", { id: "dsh-stt-diag-pct", className: "__stt_status", style: { minWidth: 40, textAlign: 'right' } }, layer.text));
            }
            // 设备层 / 识别结果层：纯文本
            return h("div", { key: i, className: "__stt_row", style: { alignItems: 'flex-start' } },
              h("span", { className: sc.cls }, sc.ch),
              h("span", { className: "__stt_label", style: { minWidth: 52 } }, layerNames[i]),
              h("span", { className: "__stt_status" }, layer.text));
          });
        })())),
    h("div", { className: "__stt_row" },
      h("button", { className: "__stt_btn __stt_btnPrimary", onClick: save }, "保存"),
      state.error && h("span", { className: "__stt_error" }, t(state.error) || state.error),
      state.lastError && h("span", { className: "__stt_error" }, t(state.lastError) || state.lastError),
      state.recognized && h("span", { className: "__stt_ok" }, (state.sent ? t('micSent') : '') + ": " + state.recognized.slice(0, 30))),
    h(SettingRow, { label: t("model") },
      h("div", null,
        h("div", { className: "__stt_modelRow" },
          h("span", { className: "__stt_modelName" }, "ASR"),
          h("span", { className: "__stt_modelState" }, modelLabel),
          h("button", { className: "__stt_btn", onClick: downloadModel, disabled: modelState === 'ready' }, t("downloadModels"))),
        // 模型未就绪：设置卡内常显引导条（进度/失败原因/重试）
        modelState !== 'ready' && h(ModelGuideBar, { t: t, always: true }))));
};
