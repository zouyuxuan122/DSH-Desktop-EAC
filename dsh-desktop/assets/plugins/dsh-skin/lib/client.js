window.__ModuleLoader__.load({
  id: "dsh-skin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var DEFAULT_ACCENT = "#2f2f2c";
    var DEFAULT_TEXT = "#1b1b19";

    var IMAGE_SLOTS = [
      { key: "wallpaper", label: "全局背景图" },
      { key: "sidebar", label: "侧栏纹理" },
      { key: "chat", label: "聊天区纹理" },
      { key: "input", label: "输入框卡片" },
      { key: "bubble", label: "输入气泡" }
    ];
    var REGIONS = [
      { key: "workspace", label: "工作区" },
      { key: "output", label: "输出界面" },
      { key: "input", label: "输入框" }
    ];
    var REGION_SELECTORS = {
      workspace: "html body .hHd-Xa_root",
      output: "html body .Md3f7G_column",
      input: "html body .uV2eYG_card"
    };

    // ---- color utils ----
    function hexToRgb(hex) {
      var h = String(hex).replace("#", "");
      if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
      var n = parseInt(h, 16);
      if (isNaN(n)) return { r: 47, g: 47, b: 44 };
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    function clamp(v) { return v < 0 ? 0 : (v > 255 ? 255 : Math.round(v)); }
    function mix(a, b, t) { return { r: clamp(a.r + (b.r - a.r) * t), g: clamp(a.g + (b.g - a.g) * t), b: clamp(a.b + (b.b - a.b) * t) }; }
    function rgbHex(c) { return "#" + [c.r, c.g, c.b].map(function (v) { var s = v.toString(16); return s.length < 2 ? "0" + s : s; }).join(""); }
    function rgba(c, a) { return "rgba(" + c.r + "," + c.g + "," + c.b + "," + a + ")"; }
    function lighten(hex, t) { return rgbHex(mix(hexToRgb(hex), { r: 255, g: 255, b: 255 }, t)); }
    function darken(hex, t) { return rgbHex(mix(hexToRgb(hex), { r: 0, g: 0, b: 0 }, t)); }

    var SLOT_SELECTORS = {
      wallpaper: ["html body"],
      sidebar: ["html body .pI_x6G_sidebarCol", "html body .hHd-Xa_root"],
      chat: ["html body .wSkVaW_root"],
      input: ["html body .uV2eYG_card"],
      bubble: ["html body .gdEzaW_bubble"]
    };
    var SLOT_VEIL = {
      wallpaper: "var(--dsh-skin-veil-chat)",
      sidebar: "var(--dsh-skin-veil-sidebar)",
      chat: "var(--dsh-skin-veil-chat)",
      input: "var(--dsh-skin-veil-input)",
      bubble: "var(--dsh-skin-veil-bubble)"
    };
    var DEFAULT_IMG_OPACITY = { wallpaper: 0.4, sidebar: 1, chat: 1, input: 1, bubble: 1 };
    var VIDEO_TARGET = {
      wallpaper: "body",
      sidebar: ".pI_x6G_sidebarCol",
      chat: ".wSkVaW_root",
      input: ".uV2eYG_card",
      bubble: ".gdEzaW_bubble"
    };
    var VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v)([?#].*)?$/i;
    function isVideoUrl(url) {
      if (!url) return false;
      return VIDEO_EXT.test(url);
    }

    function imgUrl(img) {
      if (!img || typeof img.url !== "string") return null;
      return img.url;
    }
    function imgOpacity(img) {
      if (!img) return 1;
      var o = typeof img.opacity === "number" ? img.opacity : 1;
      return o < 0 ? 0 : (o > 1 ? 1 : o);
    }

    function paletteCss(accentHex, textHex, wallpaper) {
      var acc = hexToRgb(accentHex);
      var accDarkHex = rgbHex(mix(acc, { r: 255, g: 255, b: 255 }, 0.30));
      var text = textHex || DEFAULT_TEXT;
      var textDarkHex = lighten(text, 0.80);
      var accSoftLight = rgba(mix(acc, { r: 255, g: 255, b: 255 }, 0.86), 1);
      var accSoftDark = rgba(mix(acc, { r: 0, g: 0, b: 0 }, 0.45), 1);
      var w = wallpaper > 0 ? wallpaper : 0;
      if (w > 1) w = 1;
      var a = 1 - w;
      function surf(r, g, b, opaque) { return w > 0 ? rgba({ r: r, g: g, b: b }, a) : opaque; }

      var L = {};
      L["--dsw-alias-bg-base"] = surf(247, 247, 245, "#f7f7f5");
      L["--dsw-alias-bg-layer-1"] = surf(255, 255, 255, "#ffffff");
      L["--dsw-alias-bg-layer-2"] = surf(255, 255, 255, "#ffffff");
      L["--dsw-alias-bg-layer-3"] = surf(242, 242, 240, "#f2f2f0");
      L["--dsw-alias-bg-overlay"] = "#ffffff";
      L["--dsw-alias-border-l1"] = "rgba(17,17,16,0.05)";
      L["--dsw-alias-border-l2"] = "rgba(17,17,16,0.10)";
      L["--dsw-alias-border-l3"] = "rgba(17,17,16,0.14)";
      L["--dsw-alias-border-l4"] = "rgba(17,17,16,0.20)";
      L["--dsw-alias-brand-primary"] = accentHex;
      L["--dsw-alias-brand-text"] = accentHex;
      L["--dsw-alias-button-primary-fill"] = accentHex;
      L["--dsw-alias-button-primary-hover"] = darken(accentHex, 0.12);
      L["--dsw-alias-label-primary"] = text;
      L["--dsw-alias-label-secondary"] = "#6a6a67";
      L["--dsw-alias-label-tertiary"] = "#97948e";
      L["--dsw-alias-markdown-code-block"] = surf(244, 244, 242, "#f4f4f2");
      L["--dsw-alias-state-business-primary"] = accentHex;
      L["--dsw-alias-state-business-tertiary"] = accSoftLight;
      L["--dsw-specific-bubble"] = surf(238, 238, 236, "#eeeeec");
      L["--dsw-specific-input-major"] = surf(255, 255, 255, "#ffffff");
      L["--dsw-specific-sidebar-fill"] = surf(240, 240, 238, "#f0f0ee");
      L["--dsw-specific-sidebar-nav-item-active-accent"] = accSoftLight;
      L["--dsh-skin-veil-sidebar"] = "#f0f0ee";
      L["--dsh-skin-veil-chat"] = "#f7f7f5";
      L["--dsh-skin-veil-input"] = "#ffffff";
      L["--dsh-skin-veil-bubble"] = "#eeeeec";

      var D = {};
      D["--dsw-alias-bg-base"] = surf(22, 22, 21, "#161615");
      D["--dsw-alias-bg-layer-1"] = surf(29, 29, 27, "#1d1d1b");
      D["--dsw-alias-bg-layer-2"] = surf(36, 36, 34, "#242422");
      D["--dsw-alias-bg-layer-3"] = surf(42, 42, 40, "#2a2a28");
      D["--dsw-alias-bg-overlay"] = "#262624";
      D["--dsw-alias-border-l1"] = "rgba(255,255,255,0.06)";
      D["--dsw-alias-border-l2"] = "rgba(255,255,255,0.11)";
      D["--dsw-alias-border-l3"] = "rgba(255,255,255,0.16)";
      D["--dsw-alias-border-l4"] = "rgba(255,255,255,0.22)";
      D["--dsw-alias-brand-primary"] = accDarkHex;
      D["--dsw-alias-brand-text"] = accDarkHex;
      D["--dsw-alias-button-primary-fill"] = accDarkHex;
      D["--dsw-alias-button-primary-hover"] = lighten(accentHex, 0.10);
      D["--dsw-alias-label-primary"] = textDarkHex;
      D["--dsw-alias-label-secondary"] = "#a9a7a1";
      D["--dsw-alias-label-tertiary"] = "#77746e";
      D["--dsw-alias-markdown-code-block"] = surf(28, 28, 26, "#1c1c1a");
      D["--dsw-alias-state-business-primary"] = accDarkHex;
      D["--dsw-alias-state-business-tertiary"] = accSoftDark;
      D["--dsw-specific-bubble"] = surf(38, 38, 36, "#262624");
      D["--dsw-specific-input-major"] = surf(30, 30, 28, "#1e1e1c");
      D["--dsw-specific-sidebar-fill"] = surf(19, 19, 18, "#131312");
      D["--dsw-specific-sidebar-nav-item-active-accent"] = accSoftDark;
      D["--dsh-skin-veil-sidebar"] = "#131312";
      D["--dsh-skin-veil-chat"] = "#161615";
      D["--dsh-skin-veil-input"] = "#1e1e1c";
      D["--dsh-skin-veil-bubble"] = "#262624";

      function block(sel, map) {
        var lines = [];
        for (var k in map) lines.push("  " + k + ": " + map[k] + ";");
        return sel + " {\n" + lines.join("\n") + "\n}";
      }
      return block("html body", L) + "\n" + block("html body[data-ds-dark-theme]", D);
    }

    function regionCss(region) {
      if (!region) return "";
      var rules = [];
      for (var k in REGION_SELECTORS) {
        var color = region[k];
        if (!color) continue;
        rules.push(REGION_SELECTORS[k] + " { --dsw-alias-label-primary: " + color + "; }");
      }
      return rules.join("\n");
    }

    function imageCss(images) {
      if (!images) return "";
      var rules = [];
      for (var key in SLOT_SELECTORS) {
        var m = images[key];
        if (!m || m.type === "video") continue;
        var url = imgUrl(m);
        if (!url) continue;
        var sels = SLOT_SELECTORS[key];
        if (key === "wallpaper") {
          for (var i = 0; i < sels.length; i++) {
            rules.push(sels[i] + ' { background-image: url("' + url + '"); background-size: cover; background-position: center; background-attachment: fixed; }');
          }
          continue;
        }
        var o = imgOpacity(images[key]);
        var pct = Math.round((1 - o) * 100);
        var veil = SLOT_VEIL[key];
        var mix = "color-mix(in srgb, " + veil + " " + pct + "%, transparent)";
        var layer = "linear-gradient(" + mix + ", " + mix + "), url(\"" + url + "\")";
        for (var j = 0; j < sels.length; j++) {
          rules.push(sels[j] + ' { background-image: ' + layer + '; background-size: cover, cover; background-position: center, center; }');
        }
      }
      return rules.join("\n");
    }

    function buildCss(cfg) {
      if (!cfg || !cfg.enabled) return "";
      var p = paletteCss(cfg.accent || DEFAULT_ACCENT, cfg.text || DEFAULT_TEXT, (cfg.images && cfg.images.wallpaper) ? imgOpacity(cfg.images.wallpaper) : 0);
      return p + "\n" + regionCss(cfg.region) + "\n" + imageCss(cfg.images);
    }

    function defaultCfg() {
      return {
        enabled: true,
        accent: DEFAULT_ACCENT,
        text: DEFAULT_TEXT,
        region: { workspace: null, output: null, input: null },
        images: { wallpaper: null, sidebar: null, chat: null, input: null, bubble: null },
        presets: []
      };
    }
    function normalizeImg(img) {
      if (!img || typeof img !== "object") return null;
      var url = null;
      if (typeof img.url === "string") url = img.url;
      else if (img.kind === "data" && typeof img.url === "string") url = img.url;
      else if (img.kind === "path" && typeof img.path === "string") url = "/api/dsh-skin-image?path=" + encodeURIComponent(img.path);
      if (!url) return null;
      if (url.indexOf("blob:") === 0) return null; // object URL expired after reload
      var opacity = typeof img.opacity === "number" ? img.opacity : 1;
      if (opacity < 0) opacity = 0;
      if (opacity > 1) opacity = 1;
      var type = (img.type === "video" || isVideoUrl(url)) ? "video" : "image";
      return { url: url, type: type, opacity: opacity };
    }
    function normalizeCfg(c) {
      var d = defaultCfg();
      if (!c || typeof c !== "object") return d;
      return {
        enabled: c.enabled !== false,
        accent: typeof c.accent === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c.accent) ? c.accent : d.accent,
        text: typeof c.text === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c.text) ? c.text : d.text,
        region: (c.region && typeof c.region === "object") ? {
          workspace: typeof c.region.workspace === "string" ? c.region.workspace : null,
          output: typeof c.region.output === "string" ? c.region.output : null,
          input: typeof c.region.input === "string" ? c.region.input : null
        } : d.region,
        images: (c.images && typeof c.images === "object") ? {
          wallpaper: normalizeImg(c.images.wallpaper),
          sidebar: normalizeImg(c.images.sidebar),
          chat: normalizeImg(c.images.chat),
          input: normalizeImg(c.images.input) || normalizeImg(c.images.cards),
          bubble: normalizeImg(c.images.bubble) || normalizeImg(c.images.cards)
        } : d.images,
        presets: Array.isArray(c.presets) ? c.presets : []
      };
    }
    function urlsFromCfg(c) {
      var out = { wallpaper: "", sidebar: "", chat: "", input: "", bubble: "" };
      if (c && c.images) {
        for (var k in out) {
          var img = c.images[k];
          if (img && img.url && img.url.indexOf("data:") !== 0) out[k] = img.url;
        }
      }
      return out;
    }

    function readFileAsDataUrl(file) {
      return new Promise(function (resolve, reject) {
        if (typeof FileReader === "undefined") { reject(new Error("当前环境不支持 FileReader，请改用 URL 方式")); return; }
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(new Error("图片读取失败")); };
        fr.readAsDataURL(file);
      });
    }

    var STATIC_CSS = "\n.dsh-skin-root{position:fixed;right:20px;bottom:20px;z-index:2147483000;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;}\n.dsh-skin-fab{pointer-events:auto;position:relative;width:44px;height:44px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 6px 20px rgba(0,0,0,0.14);cursor:pointer;display:flex;align-items:center;justify-content:center;margin-left:auto;transition:transform .15s ease,box-shadow .15s ease;}\n.dsh-skin-fab:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(0,0,0,0.18);}\n.dsh-skin-fab-on::after{content:'';position:absolute;top:2px;right:2px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#34c55e);border:2px solid var(--dsw-alias-bg-layer-1,#fff);}\n.dsh-skin-panel{pointer-events:auto;width:320px;max-height:74vh;overflow-y:auto;margin-top:10px;margin-left:auto;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 12px 40px rgba(0,0,0,0.2);}\n.dsh-skin-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.05));position:sticky;top:0;background:inherit;z-index:1;}\n.dsh-skin-title{font-size:13px;font-weight:600;}\n.dsh-skin-close{border:none;background:none;cursor:pointer;font-size:20px;line-height:1;color:var(--dsw-alias-label-secondary,#666);padding:0;}\n.dsh-skin-body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:14px;}\n.dsh-skin-section{display:flex;flex-direction:column;gap:8px;}\n.dsh-skin-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--dsw-alias-label-tertiary,#999);}\n.dsh-skin-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}\n.dsh-skin-chip{flex:1;min-width:0;padding:7px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));background:transparent;color:inherit;font-size:12px;cursor:pointer;}\n.dsh-skin-chip-on{background:var(--dsw-alias-brand-primary,#111);color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent;}\n.dsh-skin-btn{padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));background:transparent;color:inherit;font-size:12px;cursor:pointer;}\n.dsh-skin-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05));}\n.dsh-skin-btn:disabled{opacity:0.5;cursor:default;}\n.dsh-skin-btn-danger{color:var(--dsw-alias-state-error-primary,#d33);}\n.dsh-skin-color{width:40px;height:30px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));border-radius:8px;background:none;cursor:pointer;flex:none;}\n.dsh-skin-text{flex:1;min-width:90px;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));background:var(--dsw-alias-bg-base,#f7f7f5);color:inherit;font-size:12px;box-sizing:border-box;}\n.dsh-skin-img{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.05));}\n.dsh-skin-img-title{font-size:12px;color:var(--dsw-alias-label-secondary,#666);flex:none;}\n.dsh-skin-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);}\n.dsh-skin-preview{height:56px;border-radius:8px;background-size:cover;background-position:center;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.05));}\n.dsh-skin-preset-row{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.05));}\n.dsh-skin-preset-name{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}\n.dsh-skin-err{padding:8px 10px;border-radius:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#d33);background:rgba(236,19,19,0.06);}\n";

    var EXTRA_CSS = ".dsh-skin-range{flex:1;min-width:56px;height:30px;margin:0;accent-color:var(--dsw-alias-brand-primary,#111);}.dsh-skin-num{width:60px;height:28px;padding:0 4px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.1));background:var(--dsw-alias-bg-base,#f7f7f5);color:inherit;font-size:12px;box-sizing:border-box;}.dsh-skin-preview{width:100%;object-fit:cover;object-position:center;}.dsh-skin-vh{position:relative;z-index:0;background:transparent !important;}.dsh-skin-vh .hHd-Xa_root{background:transparent !important;}";

    var inject = ["slots", "theme"];

    function apply(ctx) {
      function persist(cfgObj) {
        var json = JSON.stringify(cfgObj);
        fetch("/api/dsh-skin-state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: json })
        }).then(function (r) { if (!r.ok) console.error("dsh-skin save failed: HTTP " + r.status); })
          .catch(function (e) { console.error("dsh-skin save failed", e); });
      }

      var staticEl = document.createElement("style");
      staticEl.setAttribute("data-plugin", "dsh-skin");
      staticEl.setAttribute("data-plugin-css", "dsh-skin/static");
      staticEl.textContent = STATIC_CSS + EXTRA_CSS;
      document.head.appendChild(staticEl);

      var dynEl = document.createElement("style");
      dynEl.setAttribute("data-plugin", "dsh-skin");
      dynEl.setAttribute("data-plugin-css", "dsh-skin/dynamic");
      dynEl.textContent = "";
      document.head.appendChild(dynEl);

      ctx.effect(function () {
        return function () {
          if (staticEl.parentNode) staticEl.parentNode.removeChild(staticEl);
          if (dynEl.parentNode) dynEl.parentNode.removeChild(dynEl);
          for (var key in SLOT_SELECTORS) {
            var vid = document.getElementById("dsh-skin-video-" + key);
            if (vid && vid.parentNode) vid.parentNode.removeChild(vid);
          }
        };
      });

      function manageVideos(cfg) {
        for (var key in SLOT_SELECTORS) {
          var m = (cfg && cfg.images && cfg.images[key]) || null;
          var isVideo = m && m.type === "video" && m.url;
          var id = "dsh-skin-video-" + key;
          var vid = document.getElementById(id);
          var host = document.querySelector(VIDEO_TARGET[key]);
          if (!isVideo) {
            if (vid && vid.parentNode) vid.parentNode.removeChild(vid);
            if (host && key !== "wallpaper") host.classList.remove("dsh-skin-vh");
            continue;
          }
          if (!host) continue;
          if (!vid) {
            vid = document.createElement("video");
            vid.id = id;
            vid.setAttribute("autoplay", "");
            vid.setAttribute("muted", "");
            vid.setAttribute("loop", "");
            vid.setAttribute("playsinline", "");
            vid.setAttribute("webkit-playsinline", "");
            vid.style.cssText = "position:" + (key === "wallpaper" ? "fixed" : "absolute") + ";inset:0;width:100%;height:100%;object-fit:cover;object-position:center;pointer-events:none;z-index:" + (key === "wallpaper" ? "0" : "-1") + ";display:block;border-radius:inherit;";
            host.insertBefore(vid, host.firstChild);
          }
          if (key !== "wallpaper") host.classList.add("dsh-skin-vh");
          if (vid.src !== m.url) vid.src = m.url;
          vid.style.opacity = String(imgOpacity(m));
          var p = vid.play && vid.play();
          if (p && p.catch) p.catch(function () {});
        }
      }

      var h = React.createElement;

      function Icon() {
        return h("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
          h("circle", { cx: "13.5", cy: "6.5", r: "1.2", fill: "currentColor", stroke: "none" }),
          h("circle", { cx: "17.5", cy: "10.5", r: "1.2", fill: "currentColor", stroke: "none" }),
          h("circle", { cx: "8.5", cy: "7.5", r: "1.2", fill: "currentColor", stroke: "none" }),
          h("circle", { cx: "6.5", cy: "12.5", r: "1.2", fill: "currentColor", stroke: "none" }),
          h("path", { d: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8z" })
        );
      }

      function Control() {
        var openState = React.useState(false);
        var open = openState[0], setOpen = openState[1];
        var cfgState = React.useState(defaultCfg());
        var cfg = cfgState[0], setCfg = cfgState[1];
        var loadedState = React.useState(false);
        var loaded = loadedState[0], setLoaded = loadedState[1];
        var schemeState = React.useState("light");
        var scheme = schemeState[0], setScheme = schemeState[1];
        var presetNameState = React.useState("");
        var presetName = presetNameState[0], setPresetName = presetNameState[1];
        var urlsState = React.useState({ wallpaper: "", sidebar: "", chat: "", input: "", bubble: "" });
        var urlDrafts = urlsState[0], setUrlDrafts = urlsState[1];
        var errState = React.useState(null);
        var err = errState[0], setErr = errState[1];

        React.useEffect(function () {
          fetch("/api/dsh-skin-state").then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
            var json = data && typeof data.config === "string" ? data.config : "";
            if (json) {
              try {
                var p = JSON.parse(json);
                if (p && typeof p === "object") { setCfg(normalizeCfg(p)); setUrlDrafts(urlsFromCfg(p)); }
              } catch (e) {}
            }
          }).catch(function (e) { console.error("dsh-skin load failed", e); }).then(function () { setLoaded(true); });
          return function () {};
        }, []);

        React.useEffect(function () {
          function read() {
            var id = "light";
            try { var t = ctx.theme.getTheme(); if (t && typeof t.id === "string") id = t.id; } catch (e) {}
            setScheme(id === "dark" ? "dark" : "light");
          }
          read();
          return ctx.on("theme/change", read);
        }, []);

        React.useEffect(function () {
          dynEl.textContent = buildCss(cfg);
          manageVideos(cfg);
          if (loaded) persist(cfg);
        }, [cfg, loaded]);

        function pickScheme(id) {
          setScheme(id);
          try { ctx.theme.setTheme(id); } catch (e) {}
        }
        function setAccent(v) { setCfg(function (c) { return Object.assign({}, c, { enabled: true, accent: v }); }); }
        function setText(v) { setCfg(function (c) { return Object.assign({}, c, { enabled: true, text: v }); }); }
        function setRegionColor(k, v) {
          setCfg(function (c) { var r = Object.assign({}, c.region); r[k] = v || null; return Object.assign({}, c, { enabled: true, region: r }); });
        }
        function setImage(k, img) {
          setCfg(function (c) {
            var im = Object.assign({}, c.images);
            if (img && img.url) {
              var prev = c.images[k];
              var opacity = typeof img.opacity === "number" ? img.opacity : (prev && typeof prev.opacity === "number" ? prev.opacity : (DEFAULT_IMG_OPACITY[k] !== undefined ? DEFAULT_IMG_OPACITY[k] : 1));
              var type = img.type === "video" ? "video" : (img.type === "image" ? "image" : (isVideoUrl(img.url) ? "video" : "image"));
              im[k] = { url: img.url, type: type, opacity: opacity };
            } else {
              im[k] = img;
            }
            return Object.assign({}, c, { enabled: true, images: im });
          });
        }
        function onUpload(k, e) {
          var file = e.target && e.target.files && e.target.files[0];
          if (!file) return;
          var isVideo = typeof file.type === "string" && file.type.indexOf("video/") === 0;
          if (isVideo) {
            if (file.size > 100 * 1024 * 1024) { setErr("视频超过 100MB 限制"); e.target.value = ""; return; }
            try {
              var objUrl = URL.createObjectURL(file);
              setImage(k, { url: objUrl, type: "video" });
              setErr(null);
            } catch (er) { setErr("视频加载失败"); }
          } else {
            if (file.size > 30 * 1024 * 1024) { setErr("图片超过 30MB 限制，请使用更小的图或 URL"); e.target.value = ""; return; }
            readFileAsDataUrl(file).then(function (dataUrl) {
              setImage(k, { url: dataUrl, type: "image" });
              setErr(null);
            }).catch(function (er) { setErr(String(er && er.message ? er.message : er)); });
          }
          e.target.value = "";
        }
        function onLoadUrl(k) {
          var u = (urlDrafts[k] || "").trim();
          if (!u) return;
          if (u.indexOf("http://") !== 0 && u.indexOf("https://") !== 0 && u.indexOf("data:") !== 0) {
            setErr("请输入 http(s):// 或 data: 开头的地址");
            return;
          }
          setImage(k, { url: u, type: isVideoUrl(u) ? "video" : "image" });
          setErr(null);
        }
        function setImageOpacity(k, v) {
          var o = parseFloat(v);
          if (isNaN(o)) return;
          if (o < 0) o = 0;
          if (o > 1) o = 1;
          setCfg(function (c) {
            var im = Object.assign({}, c.images);
            var prev = im[k];
            if (!prev) return c;
            im[k] = { url: prev.url, type: prev.type, opacity: o };
            return Object.assign({}, c, { images: im });
          });
        }
        function onClear(k) {
          setImage(k, null);
          setUrlDrafts(function (d) { var n = Object.assign({}, d); n[k] = ""; return n; });
        }

        function savePreset() {
          var name = presetName.trim();
          if (!name) { setErr("请输入预设名称"); return; }
          setCfg(function (c) {
            var skin = { accent: c.accent, text: c.text, region: c.region, images: c.images };
            var presets = c.presets.slice();
            var idx = -1;
            for (var i = 0; i < presets.length; i++) if (presets[i].name === name) { idx = i; break; }
            var entry = { name: name, skin: skin };
            if (idx >= 0) presets[idx] = entry; else presets.push(entry);
            return Object.assign({}, c, { presets: presets });
          });
          setPresetName("");
          setErr(null);
        }
        function applyPreset(name) {
          setCfg(function (c) {
            for (var i = 0; i < c.presets.length; i++) {
              if (c.presets[i].name === name) {
                var s = c.presets[i].skin || {};
                return Object.assign({}, c, {
                  enabled: true,
                  accent: s.accent || c.accent,
                  text: s.text || c.text,
                  region: s.region || c.region,
                  images: s.images || c.images
                });
              }
            }
            return c;
          });
          setErr(null);
        }
        function deletePreset(name) {
          setCfg(function (c) {
            var presets = c.presets.filter(function (p) { return p.name !== name; });
            return Object.assign({}, c, { presets: presets });
          });
        }

        function restoreOfficial() {
          setCfg(function (c) { return Object.assign({}, c, { enabled: false }); });
          try { ctx.theme.setTheme("system"); } catch (e) {}
          setErr(null);
        }
        function restoreThemeDefault() {
          setCfg(function (c) {
            return Object.assign({}, c, {
              enabled: true,
              accent: DEFAULT_ACCENT,
              text: DEFAULT_TEXT,
              region: { workspace: null, output: null, input: null },
              images: { wallpaper: null, sidebar: null, chat: null, input: null, bubble: null }
            });
          });
          try { ctx.theme.setTheme("light"); } catch (e) {}
          setUrlDrafts({ wallpaper: "", sidebar: "", chat: "", input: "", bubble: "" });
          setErr(null);
        }

        function chip(id, label) {
          return h("button", { className: "dsh-skin-chip" + (scheme === id ? " dsh-skin-chip-on" : ""), onClick: function () { pickScheme(id); } }, label);
        }
        function regionRow(r) {
          var color = cfg.region[r.key];
          return h("div", { className: "dsh-skin-row" },
            h("span", { className: "dsh-skin-img-title" }, r.label),
            h("input", { className: "dsh-skin-color", type: "color", value: color || cfg.text || "#000000", onChange: function (e) { setRegionColor(r.key, e.target.value); } }),
            color ? h("button", { className: "dsh-skin-btn dsh-skin-btn-danger", onClick: function () { setRegionColor(r.key, null); } }, "继承") : h("span", { className: "dsh-skin-hint" }, "继承全局")
          );
        }
        function imageRow(s) {
          var val = cfg.images[s.key];
          var previewUrl = imgUrl(val);
          var opacity = imgOpacity(val);
          return h("div", { className: "dsh-skin-img" },
            h("div", { className: "dsh-skin-img-title" }, s.label),
            h("div", { className: "dsh-skin-row" },
              h("label", { className: "dsh-skin-btn" },
                "上传",
                h("input", { type: "file", accept: "image/*,video/*", style: { display: "none" }, onChange: function (e) { onUpload(s.key, e); } })
              ),
              h("input", { className: "dsh-skin-text", type: "text", placeholder: "url地址", value: urlDrafts[s.key], onChange: function (e) { setUrlDrafts(function (d) { var n = Object.assign({}, d); n[s.key] = e.target.value; return n; }); } }),
              h("button", { className: "dsh-skin-btn", onClick: function () { onLoadUrl(s.key); } }, "加载"),
              val ? h("button", { className: "dsh-skin-btn dsh-skin-btn-danger", onClick: function () { onClear(s.key); } }, "清除") : null
            ),
            val ? h("div", { className: "dsh-skin-row" },
              h("span", { className: "dsh-skin-hint" }, "不透明度"),
              h("input", { className: "dsh-skin-range", type: "range", min: 0, max: 1, step: 0.01, value: opacity, onChange: function (e) { setImageOpacity(s.key, e.target.value); } }),
              h("input", { className: "dsh-skin-num", type: "number", min: 0, max: 1, step: 0.01, value: opacity, onChange: function (e) { setImageOpacity(s.key, e.target.value); } })
            ) : null,
            previewUrl ? (val && val.type === "video"
              ? h("video", { className: "dsh-skin-preview", src: previewUrl, muted: true, loop: true, playsInline: true, preload: "metadata" })
              : h("div", { className: "dsh-skin-preview", style: { backgroundImage: 'url("' + previewUrl + '")' } })) : null
          );
        }

        return h("div", { className: "dsh-skin-root" },
          h("button", { className: "dsh-skin-fab" + (cfg.enabled ? " dsh-skin-fab-on" : ""), title: "外观皮肤", onClick: function () { setOpen(!open); } }, Icon()),
          open ? h("div", { className: "dsh-skin-panel" },
            h("div", { className: "dsh-skin-head" },
              h("span", { className: "dsh-skin-title" }, "外观皮肤"),
              h("button", { className: "dsh-skin-close", onClick: function () { setOpen(false); } }, "×")
            ),
            h("div", { className: "dsh-skin-body" },
              h("div", { className: "dsh-skin-section" },
                h("div", { className: "dsh-skin-label" }, "主题"),
                h("div", { className: "dsh-skin-row" }, chip("light", "极简浅色"), chip("dark", "极简深色"))
              ),
              h("div", { className: "dsh-skin-section" },
                h("div", { className: "dsh-skin-label" }, "主色"),
                h("div", { className: "dsh-skin-row" },
                  h("input", { className: "dsh-skin-color", type: "color", value: cfg.accent, onChange: function (e) { setAccent(e.target.value); } }),
                  h("span", { className: "dsh-skin-hint" }, "按钮 / 激活态 / 运行中")
                )
              ),
              h("div", { className: "dsh-skin-section" },
                h("div", { className: "dsh-skin-label" }, "文字颜色"),
                h("div", { className: "dsh-skin-row" },
                  h("input", { className: "dsh-skin-color", type: "color", value: cfg.text, onChange: function (e) { setText(e.target.value); } }),
                  h("span", { className: "dsh-skin-hint" }, "全局文字色，深浅自动适配")
                )
              ),
              h("div", { className: "dsh-skin-section" },
                h("div", { className: "dsh-skin-label" }, "区域文字色"),
                REGIONS.map(function (r) { return regionRow(r); })
              ),
              h("div", { className: "dsh-skin-section" },
                h("div", { className: "dsh-skin-label" }, "图片换肤"),
                IMAGE_SLOTS.map(function (s) { return imageRow(s); })
              ),
              h("div", { className: "dsh-skin-section" },
                h("div", { className: "dsh-skin-label" }, "预设"),
                h("div", { className: "dsh-skin-row" },
                  h("input", { className: "dsh-skin-text", type: "text", placeholder: "预设名称", value: presetName, onChange: function (e) { setPresetName(e.target.value); } }),
                  h("button", { className: "dsh-skin-btn", onClick: savePreset }, "保存当前")
                ),
                cfg.presets.map(function (p) {
                  return h("div", { className: "dsh-skin-preset-row", key: p.name },
                    h("span", { className: "dsh-skin-preset-name" }, p.name),
                    h("button", { className: "dsh-skin-btn", onClick: function () { applyPreset(p.name); } }, "应用"),
                    h("button", { className: "dsh-skin-btn dsh-skin-btn-danger", onClick: function () { deletePreset(p.name); } }, "删除")
                  );
                })
              ),
              h("div", { className: "dsh-skin-section" },
                h("div", { className: "dsh-skin-label" }, "恢复"),
                h("div", { className: "dsh-skin-row" },
                  h("button", { className: "dsh-skin-btn", onClick: restoreOfficial }, "恢复到官方默认"),
                  h("button", { className: "dsh-skin-btn", onClick: restoreThemeDefault }, "恢复到主题默认")
                )
              ),
              err ? h("div", { className: "dsh-skin-err" }, err) : null
            )
          ) : null
        );
      }

      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({ name: "shell.overlay", id: "dsh-skin-control", order: 0 }, Control);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
