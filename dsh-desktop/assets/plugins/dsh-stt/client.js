/**
 * dsh-stt — 语音识别（仅 STT）client 半区。
 *
 * 对齐 SPEECH_DESIGN.md「采集与识别分离」：浏览器负责「何时录 + 是否理」，
 * 服务端只负责「说了什么」。多轮语音交互：
 *   · 点按切换待机：点麦克风 = 打开监听（清晰开关），再点 = 关闭
 *   · 唤醒词激活：待机时说唤醒词 → 激活（armed）
 *   · 激活后说内容 → 填输入框；说「发送」→ 直接发送
 *   · 一句结束自动取消激活（回待机）；提交后重新激活窗口（模型处理后可继续说）
 *   · 深度审批响应：模型返回选择/确认时，语音说「允许/是」或「拒绝/取消」直接响应
 *
 * 纯逻辑（VAD/唤醒匹配/过滤/合并/发送词/审批意图/门控）与 src/voice-logic.mjs
 * 同步，单测覆盖 voice-logic.mjs；此处内联同一实现。
 *
 * Hand-written ModuleLoader bundle — no build step.
 */

window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-stt",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    var NS = "dsh-stt";
    var inject = ["slots", "locale", "settingsScope"];

    var zh = {
      nav: "语音识别",
      intro: "语音识别：点麦克风打开监听，说唤醒词后说话，识别文本填输入框；说「发送」直接发送。",
      micOff: "语音关闭",
      micStandby: "待机 · 说唤醒词",
      micInput: "输入中",
      micRecognizing: "识别中",
      micSent: "已发送",
      wakeWords: "唤醒词",
      wakeWordsHint: "逗号分隔。待机时说任一唤醒词激活",
      device: "输入设备",
      deviceHint: "选择采集用的麦克风；默认可能选错为线路输入",
      deviceDefault: "系统默认",
      deviceRefresh: "刷新设备列表",
      diagTitle: "麦克风自测",
      diagHint: "点「开始自测」后对着麦克风说话，每句说完自动识别，实时显示结果",
      diagStart: "开始测试",
      diagStop: "结束测试",
      diagRecHint: "录音中…对着麦克风说话，识别结果实时显示",
      diagLayer1: "设备",
      diagLayer2: "电平",
      diagLayer3: "识别结果",
      model: "识别模型",
      modelReady: "已就绪",
      modelMissing: "未下载",
      modelDownloading: "下载中",
      modelError: "下载失败",
      downloadModels: "下载模型",
      modelNeeded: "模型未就绪，请先在设置中下载",
      micDenied: "无法访问麦克风，请在系统设置中允许",
      micTimeout: "麦克风无响应，请重试",
      noSpeak: "没听清，请重说",
      noDraft: "没有可发送的内容，请先说话",
      saveFailed: "保存失败",
      enabled: "开启",
      disabled: "关闭",
      approved: "已允许",
      rejected: "已拒绝",
      placeholder: "当前唤醒词：{w}。对着麦克风说发送即可发送",
    };
    var en = {
      nav: "Speech to Text",
      intro: "Click mic to listen. Say a wake word, then speak. Text is inserted; say 'send' to send.",
      micOff: "Voice off",
      micStandby: "Standby · say wake word",
      micInput: "Listening",
      micRecognizing: "Recognizing",
      micSent: "Sent",
      wakeWords: "Wake words",
      wakeWordsHint: "Comma-separated. Any match arms listening.",
      device: "Input device",
      deviceHint: "Pick the microphone to capture from; default may be a line-in",
      deviceDefault: "System default",
      deviceRefresh: "Refresh devices",
      diagTitle: "Microphone test",
      diagHint: "Click Start and speak — each sentence auto-recognizes, results show live",
      diagStart: "Start test",
      diagStop: "Stop test",
      diagRecHint: "Recording… speak now, results appear live",
      diagLayer1: "Device",
      diagLayer2: "Level",
      diagLayer3: "Result",
      model: "Model",
      modelReady: "Ready",
      modelMissing: "Not downloaded",
      modelDownloading: "Downloading",
      modelError: "Download failed",
      downloadModels: "Download model",
      modelNeeded: "Model not ready — download it in settings first",
      micDenied: "Microphone access denied",
      micTimeout: "Microphone timed out, retry",
      noSpeak: "Could not hear clearly, please repeat",
      noDraft: "Nothing to send — speak some content first",
      saveFailed: "Failed to save",
      enabled: "On",
      disabled: "Off",
      approved: "Approved",
      rejected: "Rejected",
      placeholder: "Wake word: {w}. Say 'send' to submit",
    };

    // ── CSS（theme tokens）──────────────────────────────────
    var CSS =
      ".__stt_root{display:flex;flex-direction:column;gap:10px}" +
      ".__stt_field{display:flex;flex-direction:column;gap:4px}" +
      ".__stt_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__stt_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__stt_row{display:flex;align-items:center;gap:8px}" +
      ".__stt_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__stt_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__stt_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__stt_btn:disabled{opacity:.5;cursor:default}" +
      ".__stt_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__stt_micBtn{width:28px;height:28px;flex:none;cursor:pointer;border:none;border-radius:999px;display:grid;place-items:center;color:var(--dsw-alias-label-secondary);background:transparent;transition:background-color .12s ease;position:relative}" +
      ".__stt_micBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".__stt_micBtnStandby{background:var(--dsw-alias-state-business-primary);color:#fff;animation:__stt_pulse 1.6s ease-in-out infinite}" +
      ".__stt_micBtnRecognizing{background:var(--dsw-alias-state-warn-primary,#e0a800);color:#fff;animation:__stt_pulse 1s ease-in-out infinite}" +
      ".__stt_micBtnArmed{box-shadow:0 0 0 2px var(--dsw-alias-state-success-primary,#2ea043)}" +
      ".__stt_spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:__stt_spin .8s linear infinite}" +
      "@keyframes __stt_pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}" +
      "@keyframes __stt_spin{to{transform:rotate(360deg)}}" +
      ".__stt_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__stt_statusPulse{font-size:12px;color:var(--dsw-alias-state-business-primary)}" +
      ".__stt_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__stt_ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#2ea043)}" +
      ".__stt_modelRow{display:flex;align-items:center;gap:8px;font-size:12px}" +
      ".__stt_modelName{flex:1;color:var(--dsw-alias-label-primary)}" +
      ".__stt_modelState{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__stt_toggle{display:flex;align-items:center;gap:8px}";
    var tagId = "dsh-stt/main.css";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-stt";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── 纯逻辑（与 src/voice-logic.mjs 同步）────────────────
    var SILENCE_THRESHOLD = 0.08;
    var BASELINE_MULTIPLIER = 2.0;
    var BASELINE_FRAMES = 33;         // ~1s @30ms（对齐参考 BASELINE_WINDOW_MS=1000）
    var SILENCE_TIMEOUT_MS = 900;
    var MIN_RECORDING_MS = 350;
    var MAX_RECORDING_MS = 8000;
    var FOLLOWUP_WAKE_MS = 10000;
    var MIC_TIMEOUT_MS = 3000;

    var HALLUCINATION_RE = /(感谢观看|谢谢观看|谢谢收看|thanks for watching|subscribe to|点赞关注|喜欢本视频)/gi;
    var FILLER_RE = /^(嗯|啊|哦|呃|诶|唉|那个|这个|就是|然后|那么|其实|对吧|对吧嘛)\s*/;
    var SEND_PHRASES = ['发送', '发出去', '发一下', 'send', 'sent', 'submit'];
    var ALLOW_RE = /(允许|同意|确认|可以|好的|第一个|选1|approve|allow|yes|ok)/i;
    var REJECT_RE = /(拒绝|取消|不要|不用|算了|stop|cancel|no)/i;

    function filterText(text) {
      if (!text) return '';
      var t = String(text);
      t = t.replace(HALLUCINATION_RE, ' ').replace(/\s+/g, ' ').trim();
      t = t.replace(FILLER_RE, '').trim();
      return t;
    }

    // 只在开头/结尾匹配发送词（说完内容后说"发送"，或"发送"+内容）；拒绝否定/疑问。
    // 纯"发送" → { text:'', send:true }（提交当前已填草稿）
    function stripSendPhrase(text) {
      var t = String(text || '').trim();
      if (!t) return { text: t, send: false };
      if (/(不要|别|不用|不想|能.{0,3}吗|是否|应该).{0,2}(发送|发出|send)/.test(t)) return { text: t, send: false };
      var lower = t.toLowerCase();
      for (var i = 0; i < SEND_PHRASES.length; i++) {
        var phrase = SEND_PHRASES[i];
        if (lower.startsWith(phrase)) {
          var rest = t.slice(phrase.length).replace(/^\s+/, '');
          return { text: rest, send: true };
        }
        if (lower.endsWith(phrase)) {
          var head = t.slice(0, t.length - phrase.length).replace(/\s+$/, '');
          return { text: head, send: true };
        }
      }
      return { text: t, send: false };
    }

    // 去掉末尾标点（SenseVoice ITN 输出带句号）
    function stripTrailingPunctuation(text) {
      return String(text || '').replace(/[。！？!?.,，、；;：:]+$/g, '').trim();
    }

    // 片段合并：按 seq 排序拼接，各段去末尾标点
    function mergeSegments(parts) {
      var sorted = parts.slice().sort(function (a, b) { return a.seq - b.seq; });
      var text = sorted.map(function (p) { return stripTrailingPunctuation(p.text); }).join('').replace(/\s+/g, ' ').trim();
      return stripTrailingPunctuation(text);
    }

    function approvalIntent(text) {
      var t = String(text || '').trim();
      if (!t) return { action: null };
      if (REJECT_RE.test(t) && !/(不是|不行|不能|不会)/.test(t)) return { action: 'reject' };
      if (ALLOW_RE.test(t)) return { action: 'allow' };
      return { action: null };
    }

    function levenshtein(a, b) {
      var m = a.length, n = b.length;
      if (m === 0) return n;
      if (n === 0) return m;
      var dp = new Uint32Array((m + 1) * (n + 1));
      for (var i = 0; i <= m; i++) dp[i * (n + 1)] = i;
      for (var j = 0; j <= n; j++) dp[j] = j;
      for (var i = 1; i <= m; i++) {
        for (var j = 1; j <= n; j++) {
          var cost = a[i - 1] === b[j - 1] ? 0 : 1;
          dp[i * (n + 1) + j] = Math.min(
            dp[(i - 1) * (n + 1) + j] + 1,
            dp[i * (n + 1) + j - 1] + 1,
            dp[(i - 1) * (n + 1) + j - 1] + cost);
        }
      }
      return dp[m * (n + 1) + n];
    }

    function editDistanceIn(text, word, maxDist) {
      var n = text.length, m = word.length;
      if (n < Math.max(1, m - maxDist)) return false;
      for (var i = 0; i < n; i++) {
        for (var len = Math.max(1, m - maxDist); len <= Math.min(n - i, m + maxDist); len++) {
          if (levenshtein(text.slice(i, i + len), word) <= maxDist) return true;
        }
      }
      return false;
    }

    function shapePatternOf(word) {
      if (/[一-鿿]/.test(word)) return null;
      var CONSONANT = 'bcdfghjklmnpqrstvwxyz';
      var VOWEL = 'aeiouy';
      var pat = '';
      for (var k = 0; k < word.length; k++) {
        var ch = word[k];
        if (CONSONANT.indexOf(ch) !== -1) pat += '[' + CONSONANT + ']';
        else if (VOWEL.indexOf(ch) !== -1) pat += '[' + VOWEL + ']';
        else pat += '\\' + ch;
      }
      try { return new RegExp(pat); } catch (e) { return null; }
    }

    function isWakeWord(text, wakeWords) {
      var t = String(text || '').trim().toLowerCase();
      if (!t) return false;
      for (var i = 0; i < wakeWords.length; i++) {
        var w = String(wakeWords[i]).trim().toLowerCase();
        if (!w) continue;
        // 中文唤醒词：只做裸包含匹配（参考设计 §3.4）。CJK 无拼写错误场景，
        // 编辑距离 maxDist=2 会让「你好」误匹配任意单字符（如「今天」的「今」），
        // 导致普通话语被误判成唤醒词。
        if (/[一-鿿]/.test(w)) {
          if (t.indexOf(w) !== -1) return true;
          continue;
        }
        if (t.indexOf(w) !== -1) return true;
        var shape = shapePatternOf(w);
        if (shape && shape.test(t)) return true;
        if (editDistanceIn(t, w, 2)) return true;
      }
      return false;
    }

    // 剥离唤醒词（参考设计 §3.4 stripWakeWord）：连续删除句中所有出现的唤醒词，
    // 剩余内容作为命令（大小写不敏感，兼容英文唤醒词）。
    function stripWakeWord(text, wakeWords) {
      var t = String(text || '').trim();
      for (var i = 0; i < wakeWords.length; i++) {
        var w = String(wakeWords[i]).trim();
        if (!w) continue;
        var re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        t = t.replace(re, '');
      }
      return t.replace(/^[，。！？、；：,.\s]+/, '').trim();
    }

    // ── 音频工具 ─────────────────────────────────────────────
    function decodeToPcm16(arrayBuffer, sampleRate) {
      return new Promise(function (resolve, reject) {
        var audioCtx = new AudioContext({ sampleRate: 16000 });
        audioCtx.decodeAudioData(arrayBuffer, function (audioBuffer) {
          var src = audioBuffer.getChannelData(0);
          var targetRate = 16000;
          var out = new Float32Array(Math.ceil(src.length * targetRate / (audioBuffer.sampleRate || sampleRate)));
          var ratio = src.length / out.length;
          for (var i = 0; i < out.length; i++) {
            var pos = i * ratio;
            var i0 = Math.floor(pos);
            var i1 = Math.min(i0 + 1, src.length - 1);
            var frac = pos - i0;
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

    function f32ToWav(samples) {
      var numSamples = samples.length;
      var buffer = new ArrayBuffer(44 + numSamples * 2);
      var view = new DataView(buffer);
      function writeStr(offset, str) { for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
      writeStr(0, "RIFF"); view.setUint32(4, 36 + numSamples * 2, true); writeStr(8, "WAVE");
      writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 16000 * 2, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      writeStr(36, "data"); view.setUint32(40, numSamples * 2, true);
      var offset = 44;
      for (var i = 0; i < numSamples; i++) {
        var s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
      return new Blob([buffer], { type: "audio/wav" });
    }

    function postWavForTranscribe(wav) {
      var fd = new FormData();
      fd.append('audio', wav, 'speech.wav');
      return fetch('/api/dsh-stt/transcribe', { method: 'POST', body: fd })
        .then(function (res) { return res.json().catch(function () { return {}; }); });
    }

    function getUserMediaWithTimeout(constraints) {
      var gum = navigator.mediaDevices.getUserMedia({ audio: constraints });
      var timer = new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('mic-timeout')); }, MIC_TIMEOUT_MS);
      });
      return Promise.race([gum, timer]);
    }

    // 深度审批响应：识别到审批意图时，DOM 点审批面板的 allow/reject 按钮
    function respondToApproval(intent) {
      var panel = document.querySelector('[data-approval-key]');
      if (!panel) return false;
      var buttons = panel.querySelectorAll('button');
      var target = null;
      for (var i = 0; i < buttons.length; i++) {
        var txt = (buttons[i].textContent || '').trim();
        if (intent === 'allow' && /允许|同意|Allow|Approve|Allow once|Yes/.test(txt)) { target = buttons[i]; break; }
        if (intent === 'reject' && /拒绝|取消|Reject|Deny|No/.test(txt)) { target = buttons[i]; break; }
      }
      if (!target) return false;
      target.click();
      return true;
    }

    // ── 状态管理（模块级，跨组件共享）────────────────────────
    var state = {
      micOn: false,          // 待机开关
      gate: { state: 'standby', awakeUntil: 0 },  // standby=待机 / armed=激活
      phase: 'idle',         // idle | recording | recognizing
      wakeWords: (function () { var D = '你好'; try { var v = localStorage.getItem('dsh-stt-wakewords'); if (v === '你好小助手') v = null; return v || D; } catch (e) { return D; } })(),
      deviceId: (function () { try { return localStorage.getItem('dsh-stt-device') || ''; } catch (e) { return ''; } })(),
      devices: [],
      diagPhase: 'idle',       // idle | recording（自测独立状态）
      diagLayers: [            // 3 层实时铺开：设备/电平/识别结果
        { status: 'wait', text: '' },
        { status: 'wait', text: '' },
        { status: 'wait', text: '' },
      ],
      models: {}, download: {}, engine: null, error: null,
      recognized: "", sent: false, lastError: null,
    };
    var listeners = [];
    function setState(patch) {
      Object.assign(state, patch);
      listeners.forEach(function (l) { try { l(); } catch (e) {} });
    }
    function useSttState() {
      var reactState = react.useState(0);
      react.useEffect(function () {
        var i = listeners.push(function () { reactState[1](function (c) { return c + 1; }); });
        return function () { listeners.splice(i - 1, 1); };
      }, []);
      return state;
    }

    function refreshStatus() {
      fetch('/api/dsh-stt/status').then(function (res) {
        return res.json().then(function (s) {
          setState({ models: s.models, download: s.download, engine: s.engine, error: null });
        }).catch(function () { setState({ status: "init" }); });
      }).catch(function () { setState({ status: "init" }); });
    }

    // 枚举音频输入设备（纯枚举，不请求权限）。浏览器隐私机制：未授权麦克风时
    // enumerateDevices 返回空 deviceId，会被过滤掉——所以列表可能为空。
    function refreshDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      navigator.mediaDevices.enumerateDevices().then(function (list) {
        var inputs = list.filter(function (d) { return d.kind === 'audioinput' && d.deviceId; })
          .map(function (d) { return { id: d.deviceId, label: d.label || ('设备 ' + d.deviceId.slice(0, 8)) }; });
        setState({ devices: inputs });
      }).catch(function () {});
    }

    // 请求麦克风权限后再枚举（拿到真实设备列表）。授权弹窗只在这里触发——
    // 由「刷新设备列表」按钮主动调用，不绑到启动或自测。
    function requestDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
        if (tmp) { tmp.getTracks().forEach(function (t) { t.stop(); }); }
        refreshDevices();
      }).catch(function () {});
    }

    // 麦克风自测（3 层实时铺开）：
    //   ① 设备 —— 点开始立即显示打开结果（成功后回填设备列表）
    //   ② 电平 —— 录音中实时电平条 + 百分比（DOM 直写，不卡）
    //   ③ 识别结果 —— 每句说完自动转写显示（复用采集核心，实时）
    function setLayer(i, status, text) {
      var layers = state.diagLayers.slice();
      layers[i] = { status: status, text: text };
      setState({ diagLayers: layers });
    }

    function diagStart() {
      if (state.diagPhase !== 'idle') return;
      // 互斥：自测开启前先停掉正式麦克风，避免两个采集实例抢麦克风
      if (controller) stopMic();
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
        onLevel: function (lvl, now, recording, recStart) {
          var bar = document.getElementById('dsh-stt-diag-bar');
          var pct = document.getElementById('dsh-stt-diag-pct');
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

    function diagStop() {
      if (state.diagPhase === 'idle') return;
      setState({ diagPhase: 'idle' });
      if (diagController) { diagController.stop(); diagController = null; }
    }

    // ── VAD 控制器（点按切换后持续运行）─────────────────────
    var moduleInputActions = null;
    var controller = null;       // 正式语音识别采集实例
    var diagController = null;   // 自测采集实例（独立，互不干扰）
    var pending = { parts: [], timer: null };   // 激活态累积的待提交片段（长句分段合并）
    var COALESCE_WINDOW_MS = 800;               // 合并窗口（对齐参考设计 STT_COALESCE_MS=800）

    function getWakeWords() {
      return (state.wakeWords || '').split(',').map(function (w) { return w.trim(); }).filter(Boolean);
    }

    function clearPendingTimer() {
      if (pending.timer) { clearTimeout(pending.timer); pending.timer = null; }
    }

    // 提交累积片段（合并窗口到/说"发送"触发）
    function commitPending(extraText) {
      clearPendingTimer();
      var parts = pending.parts.slice();
      pending.parts = [];
      if (extraText) parts.push({ seq: 1e9, text: extraText });
      if (!parts.length) return;
      var combined = mergeSegments(parts);
      if (!combined) return;
      // 追加到输入框，不覆盖已有内容；两句话之间用逗号分隔，避免连成一团
      var existing = readComposerDraft();
      var finalText = existing ? existing + '，' + combined : combined;
      setComposerDraft(finalText);
      // 保持 armed 并续期：连续说话免唤醒；只有「发送」或「长时间没说话超时」才回待机
      setState({ recognized: finalText, sent: false, lastError: null, gate: { state: 'armed', awakeUntil: Date.now() + FOLLOWUP_WAKE_MS } });
    }

    // 激活态说话：累积到 pending，合并窗口后一次提交（长句被切段不丢）
    function bufferUtterance(text, seq) {
      pending.parts.push({ seq: seq, text: text });
      clearPendingTimer();
      pending.timer = setTimeout(function () { commitPending(); }, COALESCE_WINDOW_MS);
    }

    // 纯采集核心：getUserMedia + VAD + MediaRecorder + 转写。
    // 只负责「采集音频、判句末、送转写」，通过回调输出，不关心门控/填框/自测。
    // 正式模式和自测各自 new 一个实例，互不干扰。
    //   opts.deviceId            —— 输入设备（空 = 系统默认）
    //   opts.onDeviceReady(label) —— 设备打开成功
    //   opts.onLevel(lvl,now,recording,recStart) —— 每帧电平
    //   opts.onRecordingStart()   —— 开始录音
    //   opts.onRecordingStop(tooShort) —— 录音停止（tooShort=true 片段被丢弃）
    //   opts.onTranscript(text,seq) —— 转写成功（已 filterText，短片段不触发）
    //   opts.onError(msg)         —— 转写失败
    function createCaptureCore(opts) {
      var stream = null, audioCtx = null, analyser = null, data = null, source = null;
      var recorder = null, chunks = [];
      var baseline = 0, baseFrames = 0;
      var recording = false, recStart = 0, lastVoiceAt = 0;
      var timerId = 0, active = false;
      var generation = 0;   // 会话代号：stop() 后 bump，让在途异步转写结果失效
      var segSeq = 0;   // 每段录音递增序号，合并时按序拼接（解决返回乱序）

      function start() {
        if (active) return Promise.resolve();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          return Promise.reject(new Error('getUserMedia unavailable'));
        }
        var audioCfg = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        // 用户指定了输入设备时，用 exact deviceId 精确锁定，避免系统默认选成线路输入
        if (opts.deviceId) { audioCfg.deviceId = { exact: opts.deviceId }; }
        return getUserMediaWithTimeout(audioCfg).then(function (s) {
          stream = s;
          var tk = s.getAudioTracks()[0];
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
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i];
        var lvl = sum / data.length / 255;
        var now = performance.now();
        if (opts.onLevel) opts.onLevel(lvl, now, recording, recStart);
        if (!recording) {
          if (baseFrames < BASELINE_FRAMES) {
            baseline = baseline === 0 ? lvl : baseline * 0.9 + lvl * 0.1;
            baseFrames++;
          }
          var thr = Math.max(SILENCE_THRESHOLD, baseline * BASELINE_MULTIPLIER);
          if (lvl > thr) startRecording(now);
        } else {
          var thr2 = Math.max(SILENCE_THRESHOLD, baseline * BASELINE_MULTIPLIER);
          if (lvl > thr2) lastVoiceAt = now;
          else if (now - lastVoiceAt > SILENCE_TIMEOUT_MS) { stopRecording(); }
          else if (now - recStart > MAX_RECORDING_MS) { stopRecording(); }
        }
      }

      function startRecording(now) {
        recording = true; recStart = now; lastVoiceAt = now; chunks = [];
        if (opts.onRecordingStart) opts.onRecordingStart();
        var mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
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
        var duration = performance.now() - recStart;
        recorder = null;
        var tooShort = duration < MIN_RECORDING_MS;
        if (opts.onRecordingStop) opts.onRecordingStop(tooShort);
        if (tooShort) return;
        var myGen = generation;   // 捕获当前会话代号
        var mySeq = segSeq++;
        var mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
        var blob = new Blob(chunks, { type: mime || 'audio/webm' });
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

    // 读取当前输入框草稿（DOM value）。避免在组件里条件调用 useInput hook
    // 破坏 hook 顺序导致 MicButton 崩溃；这里直接读可见 textarea 的 value。
    function findComposerTextarea() {
      var list = document.querySelectorAll('textarea');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.getClientRects().length > 0) return el;
      }
      return null;
    }

    function readComposerDraft() {
      var el = findComposerTextarea();
      return el ? (el.value || '').trim() : '';
    }

    // 写草稿：优先走 dsh 官方 setDraft（machine state，正确更新 draft/undo/发送态），
    // 找不到 actions 时用 React 兼容的原生 value setter 兜底。
    function setComposerDraft(text) {
      var actions = moduleInputActions;
      if (actions && actions.setDraft) {
        try { actions.setDraft(text); return; } catch (e) {}
      }
      var el = findComposerTextarea();
      if (el) {
        try {
          var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) {
          try { el.value = text; } catch (e2) {}
        }
      }
    }

    // 识别结果统一处理（审批响应优先，然后发送触发，然后门控 + 合并累积）
    function handleTranscribed(text, seq) {
      if (!text) { setState({ lastError: 'noSpeak' }); return; }
      // 1. 审批响应：页面有审批面板时，识别到允许/拒绝直接响应
      var hasApproval = !!document.querySelector('[data-approval-key]');
      if (hasApproval) {
        var intent = approvalIntent(text);
        if (intent.action) {
          var done = respondToApproval(intent.action);
          if (done) {
            setState({ recognized: intent.action === 'allow' ? 'approved' : 'rejected', sent: false, lastError: null, gate: { state: 'standby', awakeUntil: 0 } });
            clearPendingTimer();
            pending.parts = [];
            return;
          }
        }
        setState({ gate: { state: 'standby', awakeUntil: 0 }, lastError: null });
        return;
      }
      // 2. 发送触发：识别到「发送」→ 提交累积内容 + 本次去发送词内容（不依赖激活态）
      var stripped = stripSendPhrase(text);
      if (stripped.send) {
        var actions0 = moduleInputActions;
        if (actions0 && actions0.submit) {
          var allParts = pending.parts.slice();
          clearPendingTimer();
          pending.parts = [];
          var combined = mergeSegments(stripped.text ? allParts.concat([{ seq: 1e9, text: stripped.text }]) : allParts);
          if (combined) setComposerDraft(combined);
          // 修复：combined 空且输入框草稿也空 → 无内容可发，不 submit（否则空消息 no-op 造成「闪一下」）
          var effective = combined || readComposerDraft() || '';
          if (!effective) {
            setState({ recognized: '', sent: false, lastError: 'noDraft', gate: { state: 'standby', awakeUntil: 0 } });
            return;
          }
          setState({ recognized: effective, sent: true, lastError: null, gate: { state: 'standby', awakeUntil: 0 } });
          setTimeout(function () {
            try { actions0.submit(); }
            catch (e) {}
          }, 50);
        }
        return;
      }
      // 3. 门控：待机 → 仅唤醒词激活；激活 → 内容累积合并
      var words = getWakeWords();
      var gate = state.gate;
      var now = Date.now();
      if (gate.state === 'armed' && now >= gate.awakeUntil) {
        gate = { state: 'standby', awakeUntil: 0 };
        setState({ gate: gate });
      }
      if (gate.state === 'standby') {
        if (words.length && isWakeWord(text, words)) {
          // 剥离唤醒词，剩余内容若非空则在同一句内直接作为命令处理
          // （「你好帮我查天气」→ 激活 + 填「帮我查天气」，不再丢整句）
          var rest = stripWakeWord(text, words);
          if (rest) {
            setState({ gate: { state: 'armed', awakeUntil: now + FOLLOWUP_WAKE_MS }, recognized: stripTrailingPunctuation(rest), sent: false, lastError: null });
            bufferUtterance(stripTrailingPunctuation(rest), seq);
          } else {
            setState({ gate: { state: 'armed', awakeUntil: now + FOLLOWUP_WAKE_MS }, recognized: '', sent: false, lastError: null });
          }
        }
        // 待机非唤醒词丢弃（P2 静默丢弃）——绝不填框
        return;
      }
      // armed：累积片段，合并窗口后一次提交（长句被切段不丢，按序拼接）
      bufferUtterance(stripTrailingPunctuation(text), seq);
      setState({ recognized: stripTrailingPunctuation(text), sent: false, lastError: null });
    }

    function startMic() {
      if (controller) return;
      // 互斥：正式麦克风开启前先停掉自测
      if (diagController) diagStop();
      setState({ micOn: true, lastError: null, phase: 'idle', gate: { state: 'standby', awakeUntil: 0 } });
      controller = createCaptureCore({
        deviceId: state.deviceId,
        onLevel: function () {
          // armed 超时回退：激活后长时间没说话自动回待机，下次需重新说唤醒词
          var g = state.gate;
          if (g.state === 'armed' && Date.now() >= g.awakeUntil) {
            setState({ gate: { state: 'standby', awakeUntil: 0 } });
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

    function stopMic() {
      if (controller) { controller.stop(); controller = null; }
      clearPendingTimer();
      pending.parts = [];
      setState({ micOn: false, phase: 'idle', gate: { state: 'standby', awakeUntil: 0 } });
    }

    // ── 麦克风按钮（点按切换待机）────────────────────────────
    var MicButton = function (props) {
      var stt = useSttState();
      if (props.inputActions) moduleInputActions = props.inputActions;

      function onToggle() {
        if (stt.engine !== 'ready') { setState({ lastError: 'modelNeeded', recognized: '', sent: false }); return; }
        if (stt.micOn) stopMic();
        else startMic();
      }

      // 四态：关闭(透明)/待机(蓝底)/激活(蓝底+绿细环)/识别(黄底+环共存)
      var cls = "__stt_micBtn ";
      var title = zh.micOff;
      if (stt.micOn) {
        if (stt.phase === 'recognizing') {
          cls += '__stt_micBtnRecognizing';
          title = zh.micRecognizing;
          if (stt.gate.state === 'armed') cls += ' __stt_micBtnArmed';
        } else if (stt.gate.state === 'armed') {
          cls += '__stt_micBtnStandby __stt_micBtnArmed';
          title = zh.micInput;
        } else {
          cls += '__stt_micBtnStandby';
          title = zh.micStandby;
        }
      }

      return h("button", {
        type: "button",
        className: cls,
        title: title,
        "aria-label": title,
        onClick: onToggle,
      }, stt.phase === 'recognizing' ? h("span", { className: "__stt_spinner" })
        : h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
          h("path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" }),
          h("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
          h("line", { x1: 12, y1: 19, x2: 12, y2: 22 })
        ));
    };

    // ── 设置卡片 ─────────────────────────────────────────────
    var SettingRow = function (props) {
      return h("div", { className: "__stt_field" },
        h("label", { className: "__stt_label" }, props.label, props.hint && h("span", { className: "__stt_hint" }, props.hint)),
        props.children);
    };

    var SettingsCard = function (props) {
      var t = props.t;
      // 订阅 state 变化触发重渲染：setLayer（识别结果）/ setState（diagPhase 按钮切换）
      // 若不加，state 变了但组件不重渲染，UI 不实时刷新（之前空 sync 就是这个 bug）。
      useSttState();
      var wakeState = react.useState(state.wakeWords);
      var wake = wakeState[0];
      var setWake = wakeState[1];

      react.useEffect(function () {
        refreshDevices();
      }, []);

      function save() {
        var v = (wake || '').trim();
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

      var models = state.models || {};
      var modelState = models.asr || 'missing';
      var dl = state.download && state.download.asr;
      var modelLabel = modelState === 'ready' ? t('modelReady')
        : modelState === 'downloading' ? (dl && dl.pct != null ? dl.pct + '% ' : '') + t('modelDownloading')
        : modelState === 'error' ? t('modelError') : t('modelMissing');

      return h("div", { className: "__stt_root" },
        h("p", { className: "__stt_hint" }, t("intro")),
        h(SettingRow, { label: t("wakeWords"), hint: t("wakeWordsHint") },
          h("input", {
            className: "__stt_input",
            value: wake,
            placeholder: zh.wakeWords,
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
              var layerNames = [t("diagLayer1"), t("diagLayer2"), t("diagLayer3")];
              function statusChar(st) {
                if (st === 'ok') return { ch: '✓', cls: '__stt_ok' };
                if (st === 'fail') return { ch: '✗', cls: '__stt_error' };
                if (st === 'live') return { ch: '…', cls: '__stt_statusPulse' };
                return { ch: '·', cls: '__stt_status' };
              }
              return (state.diagLayers || []).map(function (layer, i) {
                var sc = statusChar(layer.status);
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
          h("div", { className: "__stt_modelRow" },
            h("span", { className: "__stt_modelName" }, "ASR"),
            h("span", { className: "__stt_modelState" }, modelLabel),
            h("button", { className: "__stt_btn", onClick: downloadModel, disabled: modelState === 'ready' }, t("downloadModels")))));
    };

    // ── 插件体 ───────────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-stt: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: NS });

      ctx.slots.inject("conversation.input.right", function () {
        return ctx.slots.register({ name: "conversation.input.right", id: "dsh-stt", order: 100 }, MicButton);
      });

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section", id: "dsh-stt", order: 40,
          label: function () { return t("nav"); }, locale: NS,
        }, function (props) {
          return h(SettingsCard, Object.assign({}, props, { scope: scope, t: t }));
        });
      });

      refreshStatus();
      var timer = setInterval(refreshStatus, 5000);
      ctx.effect(function () { return function () { clearInterval(timer); }; }, "dsh-stt: poll");

      // ── 输入框虚字提示（placeholder）────────────────────────
      // 语音识别开启时，把用法提示写进主输入框 placeholder；关闭时恢复原值。
      // 主输入框 textarea 由 dsh 内部渲染（className 哈希不可引用），用「可见
      // textarea」启发式定位；1s 轮询对抗 React 重渲染覆盖 placeholder。
      function composerPlaceholderText() {
        var w = (state.wakeWords || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean).join('、') || '你好';
        return t('placeholder').replace('{w}', w);
      }
      function findComposerTextarea() {
        var list = document.querySelectorAll('textarea');
        for (var i = 0; i < list.length; i++) {
          var el = list[i];
          if (el.getClientRects().length > 0) return el;
        }
        return null;
      }
      var sttPlaceholderOrig = null;
      function syncComposerPlaceholder() {
        var ta = findComposerTextarea();
        if (!ta) return;
        if (sttPlaceholderOrig === null) sttPlaceholderOrig = ta.getAttribute('placeholder') || '';
        var want = state.micOn ? composerPlaceholderText() : sttPlaceholderOrig;
        if (ta.getAttribute('placeholder') !== want) ta.setAttribute('placeholder', want);
      }
      var placeholderPoll = setInterval(syncComposerPlaceholder, 1000);
      ctx.effect(function () { return function () { clearInterval(placeholderPoll); }; }, "dsh-stt: placeholder");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
