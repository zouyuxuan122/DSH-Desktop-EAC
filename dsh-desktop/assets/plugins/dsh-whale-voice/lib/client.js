window.__ModuleLoader__.load({
  id: "dsh-whale-voice",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const name = "whale-voice";
    const inject = ["slots"];
    const URL = "/plugins/dsh-whale-voice/config.json";
    const PREPARE_URL = "/plugins/dsh-whale-voice/prepare.json";
    const TRANSCRIBE_URL = "/plugins/dsh-whale-voice/transcribe.json";

    const LABELS = {
      models: {
        "onnx-community/whisper-tiny": "tiny · 最快，约 40MB",
        "onnx-community/whisper-base": "base · 更准确，约 150MB",
        "onnx-community/whisper-small": "small · 最准确但较慢，约 460MB"
      },
      languages: { auto: "自动判断", zh: "中文（推荐，避免翻译成英文）", en: "English", ja: "日本語", ko: "한국어" },
      devices: { cpu: "CPU（稳定默认）", wasm: "WASM", gpu: "GPU（不可用时自动回落 CPU）" }
    };

    function VoicePanel() {
      const [payload, setPayload] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState("正在读取本地设置…");
      const [microphones, setMicrophones] = React.useState([]);
      const refreshMicrophones = React.useCallback(async () => {
        try {
          if (!navigator.mediaDevices?.enumerateDevices) throw new Error("当前浏览器不支持设备枚举");
          const devices = await navigator.mediaDevices.enumerateDevices();
          setMicrophones(devices.filter((device) => device.kind === "audioinput").map((device, index) => ({ id: device.deviceId, label: device.label || `麦克风 ${index + 1}（首次授权后可显示名称）` })));
        } catch (error) { setStatus("读取麦克风失败：" + String(error?.message || error)); }
      }, []);
      React.useEffect(() => {
        fetch(URL, { cache: "no-store" }).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        }).then((next) => { setPayload(next); setDraft({ ...next.config }); setStatus(""); }).catch((error) => setStatus("语音设置服务不可用：" + String(error?.message || error)));
      }, []);
      React.useEffect(() => { refreshMicrophones(); }, [refreshMicrophones]);
      const save = async (prepareModel) => {
        try {
          setStatus(prepareModel ? "保存中，正在准备本地模型…" : "正在保存…");
          const response = await fetch(URL, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: draft }) });
          const next = await response.json();
          if (!response.ok) throw new Error(next.error || `HTTP ${response.status}`);
          setDraft({ ...next.config });
          if (prepareModel) {
            const prepared = await fetch(PREPARE_URL, { method: "POST" });
            const body = await prepared.json();
            if (!prepared.ok) throw new Error(body.error || "模型准备失败");
          }
          setStatus(prepareModel ? "模型已准备好，设置已生效" : "设置已保存并生效");
        } catch (error) { setStatus("保存失败：" + String(error?.message || error)); }
      };
      if (!payload || !draft) return React.createElement("div", { className: "wv-page" }, status);
      const select = (label, key, options, labels) => React.createElement("label", { className: "wv-field", key }, React.createElement("span", null, label), React.createElement("select", { value: draft[key], onChange: (event) => setDraft({ ...draft, [key]: event.target.value }) }, options.map((value) => React.createElement("option", { value, key: value }, labels[value] || value))));
      const pickDirectory = async () => {
        if (!window.whaleVoice?.pickDir) return setStatus("请直接输入已有的本地目录路径");
        const value = await window.whaleVoice.pickDir();
        if (value) setDraft({ ...draft, cacheDir: value });
      };
      const chooseIcon = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type) || file.size > 256 * 1024) {
          event.target.value = "";
          setStatus("图标仅支持 PNG、JPG、WebP 或 GIF，文件不能超过 256 KB");
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => setStatus("读取图标失败，请换一张图片");
        reader.onload = () => {
          setDraft({ ...draft, micIcon: String(reader.result || "") });
          setStatus("图标已选好，点击“保存”后生效");
        };
        reader.readAsDataURL(file);
      };
      return React.createElement("div", { className: "wv-page" },
        React.createElement("style", null, `.wv-page{max-width:760px;padding:8px 4px 40px;color:#edf3ff}.wv-page h2,.wv-page h3{color:#fff}.wv-group{border:1px solid #536983;border-radius:14px;padding:18px;background:#151e2a}.wv-field{display:flex;flex-direction:column;gap:6px;margin:13px 0;font-size:13px;color:#f2f6ff}.wv-field select,.wv-field input{padding:9px;border:1px solid #627996;border-radius:8px;background:#101722;color:#f7f9ff;color-scheme:dark}.wv-field select option{background:#101722;color:#f7f9ff}.wv-field input::placeholder{color:#afbed3;opacity:1}.wv-field select:focus,.wv-field input:focus{outline:2px solid #73baff;outline-offset:1px}.wv-row{display:flex;gap:8px;align-items:center}.wv-row input{flex:1}.wv-actions{display:flex;gap:8px;margin-top:16px}.wv-actions button,.wv-row button{padding:8px 12px;border-radius:8px;border:1px solid #6f89a8;background:#1b2a3b;color:#fff;cursor:pointer}.wv-actions button:hover,.wv-row button:hover{background:#27415c}.wv-muted{color:#c3d0e3;opacity:1;font-size:12px}.wv-icon-preview{width:32px;height:32px;object-fit:cover;border-radius:50%;border:1px solid #627996;background:#101722}`),
        React.createElement("h2", null, "语音输入"),
        React.createElement("p", { className: "wv-muted" }, "识别在本机 DSH host 中运行；音频和文字不会为了识别发送到云端。"),
        React.createElement("section", { className: "wv-group" },
            select("Whisper 模型", "model", payload.models, LABELS.models),
            select("识别语言", "language", payload.languages, LABELS.languages),
            React.createElement("label", { className: "wv-check" }, React.createElement("input", { type: "checkbox", checked: draft.simplifyChinese !== false, disabled: draft.language !== "zh", onChange: (event) => setDraft({ ...draft, simplifyChinese: event.target.checked }) }), React.createElement("span", null, "识别结果自动转为简体中文（仅中文可用）")),
            select("运行设备", "device", payload.devices, LABELS.devices),
          React.createElement("label", { className: "wv-field" }, React.createElement("span", null, "输入麦克风"), React.createElement("div", { className: "wv-row" }, React.createElement("select", { value: draft.microphoneId || "", onChange: (event) => setDraft({ ...draft, microphoneId: event.target.value }) }, React.createElement("option", { value: "" }, "系统默认麦克风"), microphones.map((device) => React.createElement("option", { value: device.id, key: device.id }, device.label))), React.createElement("button", { type: "button", onClick: refreshMicrophones }, "刷新"))),
          React.createElement("label", { className: "wv-field" }, React.createElement("span", null, "麦克风图标（固定显示为 32 × 32 像素）"), React.createElement("div", { className: "wv-row" }, draft.micIcon ? React.createElement("img", { className: "wv-icon-preview", src: draft.micIcon, alt: "当前图标" }) : React.createElement("span", { className: "wv-icon-preview", "aria-hidden": "true" }), React.createElement("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", onChange: chooseIcon }), React.createElement("button", { type: "button", onClick: () => setDraft({ ...draft, micIcon: "" }) }, "恢复默认")), React.createElement("span", { className: "wv-muted" }, "支持 PNG、JPG、WebP、GIF；最大 256 KB。图片作为本地设置保存，不会上传。")),
          React.createElement("label", { className: "wv-field" }, React.createElement("span", null, "模型存放目录（留空使用默认缓存）"), React.createElement("div", { className: "wv-row" }, React.createElement("input", { value: draft.cacheDir, placeholder: "默认缓存目录", onChange: (event) => setDraft({ ...draft, cacheDir: event.target.value }) }), React.createElement("button", { type: "button", onClick: pickDirectory }, "浏览…"))),
          React.createElement("div", { className: "wv-actions" }, React.createElement("button", { onClick: () => save(false) }, "保存"), React.createElement("button", { onClick: () => save(true) }, "保存并下载运行库和模型")),
          React.createElement("p", { className: "wv-muted" }, status || "配置保存在本机 DSH 数据目录。")
        )
      );
    }

    function installMic() {
      let stopped = false;
      const state = { listening: false, ctx: null, source: null, processor: null, stream: null, chunks: [] };
      const editable = () => document.querySelector('[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea[role="textbox"], textarea');
      const appendText = (text) => {
        const el = editable(); if (!el || !text) return;
        el.focus();
        if (el.isContentEditable) document.execCommand("insertText", false, " " + text);
        else { el.value = el.value ? el.value.replace(/\s+$/, "") + " " + text : text; el.dispatchEvent(new Event("input", { bubbles: true })); }
      };
      const stopStream = () => { try { state.processor?.disconnect(); state.source?.disconnect(); state.stream?.getTracks().forEach((track) => track.stop()); state.ctx?.close(); } catch {} };
      const resample = async (flat, rate) => {
        const length = Math.ceil(flat.length / rate * 16000);
        const context = new OfflineAudioContext(1, length, 16000);
        const buffer = context.createBuffer(1, flat.length, rate);
        buffer.copyToChannel(Float32Array.from(flat), 0);
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination); source.start();
        return (await context.startRendering()).getChannelData(0);
      };
      const setButtonAppearance = (button, mode, icon) => {
        button.replaceChildren();
        if (mode === "idle" && icon) {
          const image = document.createElement("img"); image.src = icon; image.alt = "";
          image.style.cssText = "display:block;width:32px;height:32px;object-fit:cover;border-radius:50%;";
          button.appendChild(image);
        } else button.textContent = mode === "recording" ? "⏹" : mode === "working" ? "⏳" : "🎤";
      };
      const attach = () => {
        if (stopped || document.querySelector("[data-whale-voice-mic]")) return;
        const input = editable(); if (!input) return;
        const host = input.closest("form, [class*=composer], [class*=Composer], [role=toolbar]") || input.parentElement;
        if (!host) return;
        const button = document.createElement("button");
        let micIcon = "";
        button.type = "button"; setButtonAppearance(button, "idle", micIcon); button.title = "本地 Whisper 语音输入"; button.setAttribute("data-whale-voice-mic", "1");
        button.style.cssText = "margin:0 4px;width:36px;height:36px;padding:1px;border-radius:50%;border:1px solid rgba(128,128,128,.45);background:transparent;cursor:pointer;font-size:15px;line-height:1;overflow:hidden;";
        button.onclick = async () => {
          if (state.listening) {
            const rate = state.ctx?.sampleRate || 16000; stopStream(); state.listening = false; setButtonAppearance(button, "working"); button.title = "正在识别…";
            try {
              const flat = state.chunks.flatMap((chunk) => Array.from(chunk)); state.chunks = [];
              const pcm = await resample(flat, rate);
              const response = await fetch(TRANSCRIBE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ samples: Array.from(pcm) }) });
              const body = await response.json(); if (!response.ok) throw new Error(body.error || "识别失败"); appendText(body.text);
              button.title = body.text ? "本地 Whisper 语音输入" : "未识别到内容";
            } catch (error) { button.title = "识别失败：" + String(error?.message || error); }
            setButtonAppearance(button, "idle", micIcon); return;
          }
          try {
            const configResponse = await fetch(URL, { cache: "no-store" }); const config = (await configResponse.json()).config || {}; micIcon = config.micIcon || ""; setButtonAppearance(button, "idle", micIcon);
            const constraints = config.microphoneId ? { audio: { deviceId: { exact: config.microphoneId } } } : { audio: true };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const Audio = window.AudioContext || window.webkitAudioContext; const context = new Audio(); const source = context.createMediaStreamSource(stream); const processor = context.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (event) => state.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
            source.connect(processor); processor.connect(context.destination); Object.assign(state, { listening: true, ctx: context, source, processor, stream, chunks: [] }); setButtonAppearance(button, "recording"); button.title = "正在录音，点击停止并识别";
          } catch (error) { button.title = "麦克风不可用：" + String(error?.message || error); }
        };
        const buttons = host.querySelectorAll("button, [role=button]"); const send = [...buttons].find((node) => /发送|send/i.test((node.getAttribute("aria-label") || "") + " " + node.textContent));
        if (send?.parentNode) send.parentNode.insertBefore(button, send); else host.appendChild(button);
      };
      const timer = window.setInterval(attach, 1200); attach();
      return () => { stopped = true; window.clearInterval(timer); stopStream(); };
    }

    function apply(ctx) {
      try {
        ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "whale-voice", order: 61, label: "语音" }, VoicePanel));
      } catch (error) {
        console.warn("[whale-voice] settings section unavailable", error);
      }
      if (typeof ctx.effect === "function") ctx.effect(() => installMic(), "whale-voice: microphone button");
      else installMic();
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    exports.default = { apply, inject, name };
    return module.exports;
  }
});
