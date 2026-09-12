// dsh-stt — 模型引导条（迁移自原 client.js L873-920）。
// 输入框上方 / 设置卡内共用：模型未就绪时展示文案 + 下载按钮；
// 下载中显示进度条（轮询 status 已有，useSttState 订阅触发刷新）；
// 失败显示原因 + 重试。可「暂不」收起。
// 词典访问统一走 tt(key)：composer.dock slot 不传 t，zh 对象兜底。
import * as React from "react";
import { state, setState, useSttState, refreshStatus } from "../lib/state.js";
import { zh } from "../lib/i18n.js";

const h = React.createElement;

export const ModelGuideBar = function (props) {
  const stt = useSttState();
  const tt = function (k) { return props.t ? props.t(k) : zh[k]; };
  const modelState = (stt.models && stt.models.asr) || 'missing';
  const dl = stt.download && stt.download.asr;
  if (modelState === 'ready') return null;
  if (!stt.showGuide && !props.always) return null;

  function startDownload() {
    setState({ downloadError: null });
    fetch('/api/dsh-stt/download', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (r) {
        // r.ok=false 且 error=downloading 是 host 端并发去重，不是失败
        if (r && !r.ok) {
          const first = r.results && r.results[0] || {};
          if (first.error !== 'downloading') setState({ downloadError: first.error || 'unknown' });
        }
        refreshStatus();
      })
      .catch(function (err) { setState({ downloadError: err && err.message || String(err) }); });
  }

  let body;
  if (modelState === 'downloading') {
    const pct = dl && dl.pct != null ? dl.pct : 0;
    body = h("div", { className: "__stt_row", style: { flex: 1 } },
      h("span", null, tt('modelDownloadingBar').replace('{pct}', pct)),
      h("div", { className: "__stt_guideBar", style: { maxWidth: 220 } },
        h("div", { style: { width: Math.max(2, pct) + '%' } })));
  } else if (modelState === 'error') {
    body = h("div", { className: "__stt_row", style: { flex: 1, flexWrap: 'wrap' } },
      h("span", { className: "__stt_error", style: { flex: 1, minWidth: 0 } },
        tt('modelDownloadFailed').replace('{err}', (stt.downloadError || dl && dl.error || '').slice(0, 80))),
      h("button", { className: "__stt_btn __stt_btnPrimary", onClick: startDownload }, tt('modelGuideDownload')));
  } else {
    body = h("div", { className: "__stt_row", style: { flex: 1, flexWrap: 'wrap' } },
      h("span", { style: { flex: 1, minWidth: 0 } }, tt('modelGuide')),
      h("button", { className: "__stt_btn __stt_btnPrimary", onClick: startDownload }, tt('modelGuideDownload')));
  }
  return h("div", { className: "__stt_guide", role: "status" },
    body,
    h("button", { className: "__stt_btn", onClick: function () { setState({ showGuide: false }); } }, tt('modelGuideHide')));
};
