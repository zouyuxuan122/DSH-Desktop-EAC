window.__ModuleLoader__.load({
	id: "zat-dsh-engine",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		/**
		* Zat-DSH Engine — browser half.
		*
		* Mounts the strict Remote descriptors for the host's `pluginMarket`
		* namespace (wire field names mirror the host methods' parameter names, in
		* the same order — SRC contract), then registers the marketplace tab next to
		* the built-in plugin list in Settings → Plugins.
		*/
		const jsonCodec = {
			mode: "strict",
			typeSymbol: "zat-dsh-engine/json",
			schema: { parse: (value) => value }
		};
		function params(...names) {
			return names.map((name) => ({
				name,
				wire: name,
				source: "json",
				codec: jsonCodec
			}));
		}
		function desc(method, parameterNames) {
			return {
				id: `zat-dsh-engine#pluginMarket/${method}`,
				service: "pluginMarket",
				namespace: "pluginMarket",
				method,
				invocation: { kind: "direct" },
				parameters: params(...parameterNames),
				result: jsonCodec
			};
		}
		const marketDescriptors = [
			desc("list", [
				"page",
				"sort",
				"q",
				"category"
			]),
			desc("versions", []),
			desc("translate", ["items"]),
			desc("installed", []),
			desc("detail", ["owner", "repo"]),
			desc("selfupdate", ["doUpdate"]),
			desc("subpackages", ["owner", "repo"]),
			desc("installPlugin", [
				"owner",
				"repo",
				"subdir"
			]),
			desc("update", [
				"owner",
				"repo",
				"subdir"
			]),
			desc("updateNpm", ["name"]),
			desc("uninstall", ["name"]),
			desc("setEnabled", ["name", "enabled"]),
			desc("healthCheck", []),
			desc("repair", []),
			desc("taskStatus", ["taskId"]),
			desc("installedList", []),
			desc("osMap", ["fullNames"]),
			desc("listSessions", []),
			desc("deleteSession", ["sessionId"]),
			desc("star", ["owner", "repo"]),
			desc("starredList", []),
			desc("setToken", ["token"])
		];
		function isZh(id) {
			return id === "zh" || id === "zh-CN" || id === "zh-TW" || id === "zh-Hans" || id === "zh-Hant";
		}
		const css = `
.zat-panel{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;color:var(--color-fg1,#e6e9ef);font-family:inherit;
--color-bg1:var(--dsw-alias-bg-base,transparent);
--color-bg2:var(--dsw-alias-bg-layer-1,#151a24);
--color-bg3:var(--dsw-alias-bg-layer-2,#232a3a);
--color-fg1:var(--dsw-alias-label-primary,#e6e9ef);
--color-fg2:var(--dsw-alias-label-secondary,#dbe2ee);
--color-fg3:var(--dsw-alias-label-tertiary,#7c8698);
--color-border:var(--dsw-alias-border-l1,#ffffff14);
--zat-accent:#4d6bfe;
--zat-edge:rgba(77,107,254,.32)}
.zat-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;position:sticky;top:0;z-index:20;background:var(--color-bg1,#121826);padding:4px 2px}
.zat-title{font-size:15px;font-weight:700;color:var(--color-fg1,#eef1f7);white-space:nowrap}
.zat-title small{font-size:11px;color:var(--color-fg3,#7c8698);font-weight:400;margin-left:6px}
.zat-updbtn{background:linear-gradient(90deg,#0ea5e9,#22d3ee);border:none;color:#fff;font-weight:600;border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.zat-updbtn:hover{filter:brightness(1.1)}
.zat-search{flex:1;min-width:160px;display:flex;align-items:center;gap:6px;background:var(--color-bg2,#181d28);border:1px solid var(--color-border,#ffffff14);border-radius:8px;padding:6px 10px}
.zat-search input{flex:1;background:transparent;border:none;outline:none;color:var(--color-fg1,#e6e9ef);font-size:13px}
.zat-search input::placeholder{color:var(--color-fg3,#5d6676)}
.zat-token{flex:1;min-width:200px;background:var(--color-bg2,#181d28);border:1px solid var(--color-border,#ffffff14);border-radius:8px;padding:5px 10px;font-size:12px;color:var(--color-fg1,#e6e9ef);outline:none}
.zat-token:focus{border-color:rgba(93,140,255,.5)}
.zat-btn{background:var(--color-bg2,#232a3a);color:var(--color-fg2,#dbe2ee);border:1px solid var(--color-border,#ffffff14);border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .15s;text-decoration:none;display:inline-flex;align-items:center}
.zat-btn:hover{background:var(--color-bg3,#2e3750)}
.zat-btn.zat-primary{background:linear-gradient(90deg,#3d6bff,#7a4dff);border:none;color:#fff;font-weight:600}
.zat-btn.zat-danger{background:#2a1a1e;color:#f87171;border:1px solid rgba(248,113,113,.4)}
.zat-btn.zat-delete{background:rgba(77,107,254,.14);color:#6d8bff;border:1px solid rgba(77,107,254,.5)}
.zat-btn.zat-delete:hover{background:rgba(77,107,254,.26);color:#93abff;border-color:rgba(77,107,254,.8)}
.zat-btn.zat-danger:hover{background:#3a2026}
.zat-btn.zat-update{background:linear-gradient(90deg,#0ea5e9,#22d3ee);border:none;color:#fff;font-weight:600}
.zat-btn.zat-installed{background:var(--color-bg3,#1d2b21);color:#34d399;border:1px solid rgba(52,211,153,.35)}
.zat-btn:disabled{opacity:.55;cursor:default}
.zat-sel{background:var(--color-bg2,#181d28);color:var(--color-fg2,#dbe2ee);border:1px solid var(--color-border,#ffffff14);border-radius:8px;padding:5px 8px;font-size:12.5px;outline:none;max-width:200px}
.zat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:12px;overflow-y:auto;min-height:0;padding:2px}
.zat-card{background:var(--color-bg2,#151a24);border:1px solid var(--zat-edge);border-radius:12px;overflow:hidden;cursor:pointer;transition:transform .18s,box-shadow .18s,border-color .18s;display:flex;flex-direction:column}
.zat-card:hover{transform:translateY(-2px);box-shadow:0 8px 22px rgba(0,0,0,.4);border-color:rgba(93,140,255,.4)}
.zat-cover{position:relative;aspect-ratio:16/9;background:linear-gradient(135deg,#1c2333,#26304a);overflow:hidden}
.zat-cover img{width:100%;height:100%;object-fit:cover;display:block}
.zat-coverfallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:800;color:rgba(255,255,255,.85);letter-spacing:2px}
.zat-badge{position:absolute;top:8px;right:8px;background:rgba(16,185,129,.92);color:#fff;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.zat-kindbadge{position:absolute;top:8px;left:8px;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.zat-kind-skill{background:rgba(217,119,6,.92);color:#fff}
.zat-kind-nonplugin{background:rgba(90,100,120,.92);color:#fff}
.zat-kind-multi{background:rgba(79,70,229,.92);color:#fff}
.zat-updbadge{position:absolute;top:8px;right:8px;background:rgba(14,165,233,.95);color:#fff;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.zat-zhbadge{position:absolute;bottom:6px;left:8px;background:rgba(20,30,60,.85);color:#9fc1ff;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;border:1px solid rgba(93,140,255,.3)}
.zat-body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;flex:1}
.zat-name{font-size:13.5px;font-weight:650;color:var(--color-fg1,#eef1f7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zat-owner{font-size:11px;color:var(--color-fg3,#7c8698);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zat-desc{font-size:11.5px;color:var(--color-fg2,#a8b2c4);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:34px}
.zat-meta{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--color-fg3,#7c8698);margin-top:auto;flex-wrap:wrap}
.zat-star{color:#f5b942;font-weight:600;cursor:pointer;user-select:none}
.zat-star:hover{filter:brightness(1.25)}
.zat-star.zat-staroff{color:#8b94a5}
.zat-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.zat-cardbtn{margin-top:8px;padding:6px 0;border-radius:8px;border:none;font-size:12px;font-weight:600;cursor:pointer;text-align:center;transition:filter .15s}
.zat-cardbtn.zat-install{background:linear-gradient(90deg,#3d6bff,#7a4dff);color:#fff}
.zat-cardbtn.zat-update{background:linear-gradient(90deg,#0ea5e9,#22d3ee);color:#fff}
.zat-cardbtn.zat-installed{background:var(--color-bg3,#1d2b21);color:#34d399;border:1px solid rgba(52,211,153,.35)}
.zat-cardbtn.zat-noninstall{background:#3a2414;color:#fb923c;border:1px solid rgba(251,146,60,.4)}
.zat-cardbtn.zat-disabled{background:#33271a;color:#f0a94b;border:1px solid rgba(240,169,75,.35)}
.zat-mini{margin-left:auto;background:rgba(251,146,60,.14);border:1px solid rgba(251,146,60,.55);color:#fdba74;border-radius:8px;padding:2px 10px;font-size:11.5px;font-weight:600;line-height:18px;cursor:pointer;white-space:nowrap}
.zat-mini:hover{background:rgba(251,146,60,.28);color:#ffd8a8;border-color:rgba(251,146,60,.85)}
.zat-cardbtn.zat-nonplugin{background:var(--color-bg3,#22252e);color:var(--color-fg3,#8b94a5);border:1px solid var(--color-border,#ffffff14)}
.zat-status{text-align:center;padding:40px 0;color:var(--color-fg3,#7c8698);font-size:13px}
.zat-status.zat-error{color:#f87171}
.zat-foot{display:flex;justify-content:center;align-items:center;gap:10px;padding:6px 0;flex-wrap:wrap}
.zat-count{font-size:11.5px;color:var(--color-fg3,#5d6676)}
.zat-legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;background:var(--color-bg2,#151a24);border:1px solid var(--color-border,#ffffff0f);border-radius:10px;padding:6px 12px;font-size:11px;color:var(--color-fg3,#9aa4b5)}
.zat-legend .zat-lghead{font-weight:650;color:var(--color-fg2,#c3ccdb)}
.zat-legend .zat-lgi{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.zat-legend .zat-lgwrap{white-space:normal;word-break:break-word;line-height:1.6;flex:1;min-width:0}
.zat-legend .zat-lgi i{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.zat-hitem{background:var(--color-bg2,#151a24);border:1px solid var(--color-border,#ffffff0f);border-radius:10px;padding:10px 14px}
.zat-hitem.zat-h-error{border-color:rgba(248,113,113,.45);background:rgba(248,113,113,.06)}
.zat-hitem.zat-h-warn{border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.06)}
.zat-hitem.zat-h-ok{border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.06)}
.zat-htitle{font-size:13px;font-weight:650;margin-bottom:4px}
.zat-h-error .zat-htitle{color:#f87171}
.zat-h-warn .zat-htitle{color:#fbbf24}
.zat-h-ok .zat-htitle{color:#34d399}
.zat-h-info .zat-htitle{color:var(--color-fg2,#c3ccdb)}
.zat-hdetail{font-size:12px;color:var(--color-fg2,#a8b2c4);line-height:1.6}
.zat-loading{color:var(--color-fg3,#7c8698);font-size:12px;text-align:center;padding:8px}
.zat-progress{margin:2px 0}
.zat-cardprogress{margin-top:8px}
.zat-srow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:var(--color-bg2,#151a24);border:1px solid var(--zat-edge);border-radius:10px}
.zat-smeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.zat-sid{font-size:12px;color:var(--color-fg2,#c3ccdb);font-family:monospace;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.zat-stitle{font-size:13px;font-weight:600;color:var(--color-fg1,#eef1f7);overflow:hidden;text-overflow:ellipsis;max-width:220px;white-space:nowrap}
.zat-stime{font-size:11.5px;color:var(--color-fg3,#7c8698)}
.zat-tag{font-size:10.5px;padding:1px 8px;border-radius:10px;background:var(--color-bg3,#232a3a);color:var(--color-fg2,#a8b2c4)}
.zat-tag-live{background:rgba(52,211,153,.15);color:#34d399}
.zat-osbadge{font-size:10.5px;padding:1px 8px;border-radius:10px;background:rgba(93,140,255,.14);color:#8ea6e8;border:1px solid rgba(93,140,255,.25);white-space:nowrap}
.zat-pbar{height:8px;border-radius:6px;background:var(--color-bg3,#232a3a);overflow:hidden}
.zat-pfill{height:100%;background:linear-gradient(90deg,#3d6bff,#7a4dff);border-radius:6px;transition:width .5s}
.zat-ptext{font-size:11.5px;color:var(--color-fg2,#a8b2c4);margin-top:3px;line-height:1.5}
.zat-detail{display:flex;flex-direction:column;gap:12px;overflow-y:auto;min-height:0;padding:2px}
.zat-cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;flex:1;min-height:0;align-items:stretch}
.zat-col{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}
.zat-col .zat-detail{flex:1}
.zat-colhead{font-size:13px;font-weight:700;color:var(--color-fg1,#eef1f7);display:flex;align-items:center;gap:8px}
.zat-colhead small{font-size:11.5px;color:var(--color-fg3,#7c8698);font-weight:400}
@media (max-width:820px){.zat-cols{grid-template-columns:1fr}}
.zat-dcover{width:100%;max-width:480px;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:var(--color-bg2,#1c2333);border:1px solid var(--color-border,#ffffff14)}
.zat-dcover img{width:100%;height:100%;object-fit:cover}
.zat-dtitle{font-size:22px;font-weight:750;color:var(--color-fg1,#f2f5fa)}
.zat-downer{font-size:12.5px;color:var(--color-fg3,#7c8698);margin-top:2px}
.zat-dstats{display:flex;gap:16px;font-size:12.5px;color:var(--color-fg2,#a8b2c4);flex-wrap:wrap}
.zat-ver{background:var(--color-bg3,#1c2436);border:1px solid rgba(93,140,255,.25);border-radius:8px;padding:4px 10px;font-size:11.5px;color:#8ea6e8}
.zat-ver.zat-verold{color:#f87171;border-color:rgba(248,113,113,.4)}
.zat-summary{background:var(--color-bg2,#151a24);border:1px solid var(--color-border,#ffffff0f);border-radius:10px;padding:14px 16px;font-size:12.5px;line-height:1.75;color:var(--color-fg2,#c3ccdb);white-space:pre-wrap}
.zat-topics{display:flex;flex-wrap:wrap;gap:6px}
.zat-topic{background:var(--color-bg3,#1c2436);color:#8ea6e8;border:1px solid rgba(93,140,255,.25);border-radius:14px;padding:2px 10px;font-size:11px}
.zat-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.zat-notice{color:#fbbf24;font-size:12.5px;padding:4px 0;white-space:pre-wrap;line-height:1.6}
.zat-zhlabel{color:#9fc1ff;font-size:11px;font-weight:600;margin-right:4px}
.zat-monobadge{background:#3a2a1a;color:#fbbf24;border:1px solid rgba(251,191,36,.35);border-radius:8px;padding:6px 12px;font-size:12px;display:inline-block}
.zat-subchoices{background:var(--color-bg2,#151a24);border:1px solid rgba(251,191,36,.35);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.zat-subchoices-title{font-size:12.5px;color:#fbbf24;font-weight:600}
.zat-subrow{display:flex;align-items:center;justify-content:space-between;gap:10px}
.zat-subname{font-size:12.5px;color:var(--color-fg1,#eef1f7)}
.zat-subname small{color:var(--color-fg3,#7c8698);margin-left:6px}
`;
		function injectCss() {
			const tagId = "zat-dsh-engine/market";
			if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "zat-dsh-engine";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		const CATEGORIES = [
			{
				label: "全部",
				en: "All"
			},
			{
				label: "皮肤 / 主题",
				en: "Theme"
			},
			{
				label: "工具 / 终端",
				en: "Tools"
			},
			{
				label: "浏览器 / 自动化",
				en: "Browser"
			},
			{
				label: "技能 Skills",
				en: "Skills"
			},
			{
				label: "视觉 / 多媒体",
				en: "Vision"
			},
			{
				label: "网络 / MCP",
				en: "Network"
			},
			{
				label: "多智能体 / 编排",
				en: "Agents"
			},
			{
				label: "数据 / 存储 / 记忆",
				en: "Data"
			},
			{
				label: "硬件 / 桌面",
				en: "Hardware"
			},
			{
				label: "设计 / 文档",
				en: "Design"
			},
			{
				label: "安全 / 通知",
				en: "Security"
			}
		];
		const LANG_COLORS = {
			TypeScript: "#3178c6",
			JavaScript: "#f1e05a",
			Python: "#3572A5",
			"C#": "#178600",
			HTML: "#e34c26",
			CSS: "#563d7c",
			Rust: "#dea584",
			Go: "#00ADD8",
			Java: "#b07219",
			C: "#555555",
			"C++": "#f34b7d",
			Shell: "#89e051",
			Lua: "#000080",
			Swift: "#F05138",
			Kotlin: "#A97BFF",
			Vue: "#41b883",
			Svelte: "#ff3e00",
			Ruby: "#701516",
			PHP: "#4F5D95"
		};
		function formatStars(n) {
			if (n >= 1e4) return (n / 1e4).toFixed(1) + "w";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
			return String(n);
		}
		/** Map an npm `os` array to a short display string (Windows / macOS / Linux). */
		function osNames(os) {
			const name = (s) => s === "win32" ? "Windows" : s === "darwin" ? "macOS" : s === "linux" ? "Linux" : s;
			const neg = os.filter((e) => e.startsWith("!")).map((e) => e.slice(1));
			if (neg.length > 0) return "! " + neg.map(name).join("/");
			return os.map(name).join("/");
		}
		function MarketPanel({ pm, locale }) {
			const [zh, setZh] = (0, react.useState)(() => {
				const snap = locale.getLocale();
				return snap?.active ? isZh(String(snap.active)) : true;
			});
			const [items, setItems] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [query, setQuery] = (0, react.useState)("");
			const [sort, setSort] = (0, react.useState)("stars");
			const [category, setCategory] = (0, react.useState)("全部");
			const [instFilter, setInstFilter] = (0, react.useState)("all");
			const [installedMode, setInstalledMode] = (0, react.useState)(false);
			const [page, setPage] = (0, react.useState)(1);
			const [total, setTotal] = (0, react.useState)(0);
			const [loading, setLoading] = (0, react.useState)(false);
			const [installing, setInstalling] = (0, react.useState)("");
			const [detail, setDetail] = (0, react.useState)(null);
			const [detailData, setDetailData] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)("");
			const [selfUpdate, setSelfUpdate] = (0, react.useState)(null);
			const [subChoices, setSubChoices] = (0, react.useState)(null);
			const [profileInfo, setProfileInfo] = (0, react.useState)(null);
			const [showLegend, setShowLegend] = (0, react.useState)(true);
			const [hasToken, setHasToken] = (0, react.useState)(null);
			const [tokenInput, setTokenInput] = (0, react.useState)("");
			const [health, setHealth] = (0, react.useState)(null);
			const [checking, setChecking] = (0, react.useState)(false);
			const [progress, setProgress] = (0, react.useState)(null);
			const [selfUpdating, setSelfUpdating] = (0, react.useState)(false);
			const [taskStates, setTaskStates] = (0, react.useState)({});
			const pollTimerRef = (0, react.useRef)(null);
			const loadingRef = (0, react.useRef)(false);
			const debounceRef = (0, react.useRef)(null);
			const starredSetRef = (0, react.useRef)(null);
			const t = (zhText, enText) => zh ? zhText : enText;
			/** Stamp `starred` onto a list from the cached starred-set (filled async). */
			function applyStars(list) {
				const set = starredSetRef.current;
				if (!set) return list;
				return list.map((it) => ({
					...it,
					starred: set.has(it.fullName.toLowerCase())
				}));
			}
			/** Fetch the current user's starred repos and restamp all visible cards. */
			function syncStars() {
				pm.starredList().then((res) => {
					if (!res.ok || !res.value.ok) {
						setHasToken(false);
						return;
					}
					const list = Array.isArray(res.value.starred) ? res.value.starred : [];
					const set = new Set(list);
					starredSetRef.current = set;
					setHasToken(true);
					setItems((prev) => prev ? prev.map((it) => ({
						...it,
						starred: set.has(it.fullName.toLowerCase())
					})) : prev);
				}).catch(() => {
					setHasToken(false);
				});
			}
			/** One-click star / unstar; falls back to the repo page when no credential. */
			function onStar(item) {
				pm.star(item.owner, item.name).then((res) => {
					const value = res.ok ? res.value : null;
					if (res.ok && value && value.ok && typeof value.starred === "boolean") {
						const key = item.fullName.toLowerCase();
						if (value.starred) starredSetRef.current?.add(key);
						else starredSetRef.current?.delete(key);
						setItems((prev) => prev ? prev.map((it) => it.fullName === item.fullName ? {
							...it,
							starred: value.starred,
							stars: Math.max(0, it.stars + (value.starred ? 1 : -1))
						} : it) : prev);
						setNotice(String(value.message || ""));
					} else if (res.ok && value && value.needToken) setNotice(String(value.message || t("需要 GitHub 凭据才能一键星标", "A GitHub credential is required to star")));
					else setNotice(res.ok ? String(value?.message || t("星标失败", "Star failed")) : res.error.message);
				}).catch((err) => {
					setNotice(String(err?.message || err));
				});
			}
			function saveToken() {
				const tok = tokenInput.trim();
				if (!tok) {
					setNotice(t("先粘贴一个 Token 再保存", "Paste a token first"));
					return;
				}
				pm.setToken(tok).then((res) => {
					if (res.ok && res.value.ok) {
						setHasToken(Boolean(res.value.hasToken));
						setTokenInput("");
						setNotice(String(res.value.message || ""));
						starredSetRef.current = null;
						syncStars();
					} else setNotice(res.ok ? String(res.value.message || "") : res.error.message);
				}).catch((err) => setNotice(String(err?.message || err)));
			}
			function clearToken() {
				pm.setToken("").then((res) => {
					if (res.ok && res.value.ok) {
						setHasToken(false);
						starredSetRef.current = null;
						setItems((prev) => prev ? prev.map((it) => ({
							...it,
							starred: false
						})) : prev);
						setNotice(String(res.value.message || ""));
					} else setNotice(res.ok ? String(res.value.message || "") : res.error.message);
				}).catch((err) => setNotice(String(err?.message || err)));
			}
			(0, react.useEffect)(() => {
				const off = locale.subscribe(() => {
					const snap = locale.getLocale();
					setZh(snap?.active ? isZh(String(snap.active)) : true);
				});
				return () => {
					off?.();
				};
			}, [locale]);
			(0, react.useEffect)(() => () => {
				if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
			}, []);
			(0, react.useEffect)(() => {
				if (!notice) return;
				const timer = setTimeout(() => setNotice(""), 5500);
				return () => clearTimeout(timer);
			}, [notice]);
			(0, react.useEffect)(() => {
				return injectCss();
			}, []);
			function load(p, s, q, cat, append) {
				if (loadingRef.current) return;
				loadingRef.current = true;
				setLoading(true);
				setError("");
				pm.list(p, s, q, cat).then((res) => {
					loadingRef.current = false;
					setLoading(false);
					if (!res.ok || !res.value.ok) {
						setError(res.ok ? String(res.value.message || "") : res.error.message);
						return;
					}
					const data = res.value;
					setItems((prev) => {
						if (!append || !prev) return applyStars(data.items);
						const merged = prev.slice();
						for (const it of applyStars(data.items)) if (!merged.some((m) => m.fullName === it.fullName)) merged.push(it);
						return merged;
					});
					setTotal(data.total || 0);
					setPage(p);
					requestZh(data.items);
					requestVersions(data.items);
					requestOs(data.items);
				}).catch((err) => {
					loadingRef.current = false;
					setLoading(false);
					setError(String(err?.message || err));
				});
			}
			/** The installed filter: every installed plugin in one shot, no paging. */
			function loadInstalled() {
				setLoading(true);
				setError("");
				pm.installedList().then((res) => {
					setLoading(false);
					if (!res.ok || !res.value.ok) {
						setError(res.ok ? String(res.value.message || "") : res.error.message);
						return;
					}
					const data = res.value;
					setItems(applyStars(data.items));
					setTotal(data.total || 0);
					setPage(1);
					setInstalledMode(true);
					requestZh(data.items);
					requestVersions(data.items);
					requestOs(data.items);
					for (const it of data.items) if (it.taskId && it.installing) watchTask(it.taskId, it.fullName);
				}).catch((err) => {
					setLoading(false);
					setError(String(err?.message || err));
				});
			}
			function requestZh(list) {
				if (!zh) return;
				const needZh = list.filter((it) => it.needZh).map((it) => ({
					fullName: it.fullName,
					description: it.description || ""
				}));
				if (!needZh.length) return;
				pm.translate(needZh).then((tr) => {
					if (tr.ok && tr.value.ok && tr.value.map) setItems((prev) => prev ? prev.map((it) => tr.value.map[it.fullName] ? {
						...it,
						zhIntro: tr.value.map[it.fullName],
						needZh: false
					} : it) : prev);
				}).catch(() => {});
			}
			function requestVersions(list) {
				if (!list.filter((it) => it.installed).length) return;
				pm.versions().then((vr) => {
					if (vr.ok && vr.value.ok && vr.value.map) setItems((prev) => prev ? prev.map((it) => {
						const entry = vr.value.map[it.fullName.toLowerCase()];
						if (!entry) return it;
						return {
							...it,
							installedVersion: entry.local,
							latestVersion: entry.remote,
							hasUpdate: entry.hasUpdate
						};
					}) : prev);
				}).catch(() => {});
			}
			/** 批量解析卡片上的"支持系统"标签(新插件也会自动补齐)。 */
			function requestOs(list) {
				const names = list.filter((it) => it.os === void 0 && !it.noRepo).map((it) => it.fullName);
				if (!names.length) return;
				pm.osMap(names).then((res) => {
					if (!res.ok || !res.value.ok || !res.value.map) return;
					const map = res.value.map;
					setItems((prev) => prev ? prev.map((it) => {
						const hit = map[it.fullName.toLowerCase()];
						if (hit && it.os === void 0) return {
							...it,
							os: hit.os ?? []
						};
						return it;
					}) : prev);
				}).catch(() => {});
			}
			(0, react.useEffect)(() => {
				load(1, sort, "", category, false);
				pm.selfupdate(false).then((r) => {
					if (r.ok && r.value.ok && r.value.hasUpdate) setSelfUpdate({
						latestVersion: r.value.latestVersion,
						changes: Array.isArray(r.value.changes) ? r.value.changes : void 0
					});
				}).catch(() => {});
				pm.installed().then((r) => {
					if (r.ok && r.value.ok) setProfileInfo({
						profileName: String(r.value.profileName || ""),
						profileDir: String(r.value.profileDir || "")
					});
				}).catch(() => {});
				syncStars();
			}, []);
			(0, react.useEffect)(() => {
				if (debounceRef.current) clearTimeout(debounceRef.current);
				debounceRef.current = setTimeout(() => {
					load(1, sort, query, category, false);
				}, 300);
				return () => {
					if (debounceRef.current) clearTimeout(debounceRef.current);
				};
			}, [
				query,
				sort,
				category
			]);
			function refreshItem(fullName, patch) {
				setItems((prev) => prev ? prev.map((it) => it.fullName === fullName ? {
					...it,
					...patch
				} : it) : prev);
				setDetail((d) => d && d.fullName === fullName ? {
					...d,
					...patch
				} : d);
			}
			/**
			* Watch a background task that belongs to a card (survives leaving and
			* re-entering the market): updates the card's progress and, on completion,
			* refreshes the item state and shows the result.
			*/
			function watchTask(taskId, fullName) {
				const tick = () => {
					pm.taskStatus(taskId).then((res) => {
						if (!res.ok) {
							setTaskStates((prev) => {
								const nx = { ...prev };
								delete nx[fullName];
								return nx;
							});
							return;
						}
						const task = res.value && res.value.task;
						if (!task) {
							setTaskStates((prev) => {
								const nx = { ...prev };
								delete nx[fullName];
								return nx;
							});
							return;
						}
						if (task.done) {
							setTaskStates((prev) => {
								const nx = { ...prev };
								delete nx[fullName];
								return nx;
							});
							const result = task.result || {
								ok: false,
								message: t("任务无结果", "No task result")
							};
							if (result.ok) {
								setNotice(String(result.message || t("✅ 完成!", "✅ Done!")));
								refreshItem(fullName, {
									installed: true,
									disabled: false,
									installing: false,
									installedName: result.packageName || null,
									hasUpdate: false
								});
							} else {
								setNotice(String(result.message || t("安装失败", "Install failed")));
								refreshItem(fullName, { installing: false });
							}
							return;
						}
						setTaskStates((prev) => ({
							...prev,
							[fullName]: {
								pct: Math.max(1, Math.min(99, Number(task.progress) || 1)),
								message: String(task.message || t("处理中…", "Working…"))
							}
						}));
						setTimeout(tick, 600);
					}).catch(() => {
						setTaskStates((prev) => {
							const nx = { ...prev };
							delete nx[fullName];
							return nx;
						});
					});
				};
				tick();
			}
			/** Poll a background task, rendering its progress until it finishes. */
			function pollTask(taskId, onDone) {
				if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
				const tick = () => {
					pm.taskStatus(taskId).then((res) => {
						if (!res.ok) {
							setProgress(null);
							setInstalling("");
							setNotice(String(res.error.message));
							return;
						}
						const task = res.value && res.value.task;
						if (!task) {
							setProgress(null);
							setInstalling("");
							setNotice(t("任务状态丢失", "Task status lost"));
							return;
						}
						if (task.done) {
							setProgress(null);
							setInstalling("");
							onDone(task.result || {
								ok: false,
								message: t("任务无结果", "No task result")
							});
							return;
						}
						setProgress({
							pct: Math.max(1, Math.min(99, Number(task.progress) || 1)),
							message: String(task.message || t("处理中…", "Working…"))
						});
						pollTimerRef.current = setTimeout(tick, 600);
					}).catch((err) => {
						setProgress(null);
						setInstalling("");
						setNotice(String(err?.message || err));
					});
				};
				tick();
			}
			function doInstall(item) {
				if (installing || item.installing) {
					setNotice(t("这个插件正在安装中,请稍候", "This plugin is already installing — please wait"));
					return;
				}
				setInstalling(item.fullName);
				setProgress({
					pct: 2,
					message: t("正在准备安装…", "Preparing install…")
				});
				pm.installPlugin(item.owner, item.name, "").then((res) => {
					const value = res.ok ? res.value : null;
					if (!res.ok) {
						setProgress(null);
						setInstalling("");
						setNotice(res.error.message);
						return;
					}
					if (value && value.kind === "multi" && Array.isArray(value.packages) && value.packages.length > 0) {
						setProgress(null);
						setInstalling("");
						setSubChoices({
							owner: item.owner,
							repo: item.name,
							packages: value.packages
						});
						setNotice(String(value.message || ""));
						return;
					}
					const taskId = value && typeof value.taskId === "string" ? value.taskId : "";
					if (taskId) {
						pollTask(taskId, (result) => {
							if (result && result.ok) {
								setNotice(String(result.message || t("✅ 已安装!重启 dsh 后生效。", "✅ Installed! Restart dsh to activate.")));
								refreshItem(item.fullName, {
									installed: true,
									disabled: false,
									installedName: result.packageName || null,
									hasUpdate: false
								});
							} else setNotice(String(result && result.message || t("安装失败", "Install failed")));
						});
						return;
					}
					setProgress(null);
					setInstalling("");
					setNotice(String(value?.message || ""));
					if (value && value.ok) refreshItem(item.fullName, {
						installed: true,
						disabled: false,
						installedName: value.packageName || null,
						hasUpdate: false
					});
				}).catch((err) => {
					setProgress(null);
					setInstalling("");
					setNotice(t("安装出错:", "Install error: ") + String(err?.message || err));
				});
			}
			function doInstallSub(choice, sub) {
				setInstalling(choice.owner + "/" + choice.repo + "/" + sub.dir);
				setProgress({
					pct: 2,
					message: t("正在准备安装…", "Preparing install…")
				});
				pm.installPlugin(choice.owner, choice.repo, sub.dir).then((res) => {
					const value = res.ok ? res.value : null;
					if (!res.ok) {
						setProgress(null);
						setInstalling("");
						setNotice(res.error.message);
						return;
					}
					const taskId = value && typeof value.taskId === "string" ? value.taskId : "";
					if (taskId) {
						pollTask(taskId, (result) => {
							if (result && result.ok) {
								setSubChoices(null);
								setNotice(String(result.message || t("✅ 已安装!重启 dsh 后生效。", "✅ Installed! Restart dsh to activate.")));
								refreshItem(choice.owner + "/" + choice.repo, {
									installed: true,
									disabled: false,
									installedName: result.packageName || null,
									hasUpdate: false
								});
							} else setNotice(String(result && result.message || t("安装失败", "Install failed")));
						});
						return;
					}
					setProgress(null);
					setInstalling("");
					setNotice(String(value?.message || ""));
					if (value && value.ok) {
						setSubChoices(null);
						refreshItem(choice.owner + "/" + choice.repo, {
							installed: true,
							disabled: false,
							installedName: value.packageName || null,
							hasUpdate: false
						});
					}
				}).catch((err) => {
					setProgress(null);
					setInstalling("");
					setNotice(String(err?.message || err));
				});
			}
			function doUpdate(item) {
				if (item.noRepo) {
					const name = item.installedName || item.name;
					setInstalling(item.fullName);
					pm.updateNpm(name).then((res) => {
						setInstalling("");
						setNotice(res.ok ? String(res.value?.message || "") : res.error.message);
						if (res.ok && res.value?.ok) refreshItem(item.fullName, {
							hasUpdate: false,
							installedVersion: res.value.version || null,
							latestVersion: res.value.version || null
						});
					}).catch((err) => {
						setInstalling("");
						setNotice(String(err?.message || err));
					});
					return;
				}
				setInstalling(item.fullName);
				setProgress({
					pct: 2,
					message: t("正在准备更新…", "Preparing update…")
				});
				pm.update(item.owner, item.name, "").then((res) => {
					const value = res.ok ? res.value : null;
					if (!res.ok) {
						setProgress(null);
						setInstalling("");
						setNotice(res.error.message);
						return;
					}
					const taskId = value && typeof value.taskId === "string" ? value.taskId : "";
					if (taskId) {
						pollTask(taskId, (result) => {
							if (result && result.ok) {
								setNotice(String(result.message || t("✅ 已更新!重启 dsh 后生效。", "✅ Updated! Restart dsh to activate.")));
								refreshItem(item.fullName, {
									hasUpdate: false,
									installedVersion: result.version || null,
									latestVersion: result.version || null
								});
							} else setNotice(String(result && result.message || t("更新失败", "Update failed")));
						});
						return;
					}
					setProgress(null);
					setInstalling("");
					setNotice(String(value?.message || ""));
					if (value && value.ok) refreshItem(item.fullName, {
						hasUpdate: false,
						installedVersion: value.version || null,
						latestVersion: value.version || null
					});
				}).catch((err) => {
					setProgress(null);
					setInstalling("");
					setNotice(String(err?.message || err));
				});
			}
			/** Toggle a plugin between the enabled/disabled bundle list. */
			function runHealth() {
				setChecking(true);
				pm.healthCheck().then((res) => {
					setChecking(false);
					if (!res.ok || !res.value.ok) {
						setNotice(res.ok ? String(res.value.message || "") : res.error.message);
						return;
					}
					setHealth(Array.isArray(res.value.issues) ? res.value.issues : []);
				}).catch((err) => {
					setChecking(false);
					setNotice(String(err?.message || err));
				});
			}
			function runRepair() {
				setChecking(true);
				pm.repair().then((res) => {
					setChecking(false);
					const value = res.ok ? res.value : null;
					setNotice(res.ok ? String(value?.message || "") : res.error.message);
					if (res.ok && value?.ok) runHealth();
				}).catch((err) => {
					setChecking(false);
					setNotice(String(err?.message || err));
				});
			}
			function doSetEnabled(item, enabled) {
				const name = item.installedName;
				if (!name) return;
				setInstalling(item.fullName);
				pm.setEnabled(name, enabled).then((res) => {
					setInstalling("");
					const value = res.ok ? res.value : null;
					setNotice(res.ok ? String(value?.message || "") : res.error.message);
					if (res.ok && value?.ok) refreshItem(item.fullName, enabled ? {
						installed: true,
						disabled: false
					} : {
						installed: false,
						disabled: true,
						hasUpdate: false
					});
				}).catch((err) => {
					setInstalling("");
					setNotice(String(err?.message || err));
				});
			}
			function doUninstall(item) {
				const name = item.installedName;
				if (!name) return;
				setInstalling(item.fullName);
				setProgress({
					pct: 2,
					message: t("正在准备卸载…", "Preparing uninstall…")
				});
				pm.uninstall(name).then((res) => {
					const value = res.ok ? res.value : null;
					if (!res.ok) {
						setProgress(null);
						setInstalling("");
						setNotice(res.error.message);
						return;
					}
					const taskId = value && typeof value.taskId === "string" ? value.taskId : "";
					if (taskId) {
						pollTask(taskId, (result) => {
							if (result && result.ok) {
								setNotice(String(result.message || t("已卸载", "Uninstalled")));
								refreshItem(item.fullName, {
									installed: false,
									disabled: false,
									installedName: null,
									hasUpdate: false,
									installedVersion: null,
									latestVersion: null
								});
								setDetail(null);
							} else setNotice(String(result && result.message || t("卸载失败", "Uninstall failed")));
						});
						return;
					}
					setProgress(null);
					setInstalling("");
					setNotice(String(value?.message || ""));
					if (value && value.ok) {
						refreshItem(item.fullName, {
							installed: false,
							disabled: false,
							installedName: null,
							hasUpdate: false,
							installedVersion: null,
							latestVersion: null
						});
						setDetail(null);
					}
				}).catch((err) => {
					setProgress(null);
					setInstalling("");
					setNotice(String(err?.message || err));
				});
			}
			function cardAction(item) {
				if (item.isHarness) {
					setDetail(item);
					return;
				}
				if (item.disabled) {
					doSetEnabled(item, true);
					return;
				}
				if (item.kind === "skill" || item.kind === "nonplugin") {
					setDetail(item);
					return;
				}
				if (item.installed && item.hasUpdate) doUpdate(item);
				else if (!item.installed) doInstall(item);
				else setDetail(item);
			}
			function openDetail(item) {
				setDetail(item);
				setDetailData(null);
				if (item.noRepo) return;
				pm.detail(item.owner, item.name).then((res) => {
					if (!res.ok || !res.value.ok) {
						setDetailData(null);
						return;
					}
					setDetailData(res.value);
				}).catch(() => setDetailData(null));
			}
			function onScroll(e) {
				const el = e.currentTarget;
				if (!el || loadingRef.current) return;
				if (el.scrollTop + el.clientHeight >= el.scrollHeight - 260) {
					if (page * 100 < total) load(page + 1, sort, query, category, true);
				}
			}
			const filtered = items ? items.filter((it) => {
				if (instFilter === "installed" && !(it.installed || it.disabled)) return false;
				if (instFilter === "uninstalled" && (it.installed || it.disabled)) return false;
				if (instFilter === "installable" && it.kind !== "plugin" && it.kind !== "multi") return false;
				return true;
			}) : [];
			if (detail) {
				const dd = detailData;
				const ddesc = zh && detail.zhIntro ? detail.zhIntro : detail.description || "";
				const mainBtn = detail.isHarness || Boolean(dd && dd.notPlugin) ? null : !detail.installed && !detail.disabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					className: "zat-btn zat-primary",
					onClick: () => doInstall(detail),
					disabled: !!installing,
					children: installing ? t("安装中…", "Installing…") : t("安装插件", "Install")
				}) : detail.installed && detail.hasUpdate ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					className: "zat-btn zat-update",
					onClick: () => doUpdate(detail),
					disabled: !!installing,
					children: installing ? t("更新中…", "Updating…") : `↑ ${t("更新到 v", "Update to v")}${detail.latestVersion || ""}`
				}) : detail.installed ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					className: "zat-btn zat-installed",
					disabled: true,
					children: ["✓ ", detail.noRepo ? t("已安装", "Installed") : t("已是最新", "Up to date")]
				}) : null;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "zat-panel",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "zat-bar",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "zat-btn",
								onClick: () => setDetail(null),
								children: t("← 返回市场", "← Back")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "zat-title",
								children: detail.name
							})]
						}),
						progress && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "zat-progress",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "zat-pbar",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-pfill",
									style: { width: progress.pct + "%" }
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "zat-ptext",
								children: ["⏳ ", progress.message]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "zat-detail",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-dcover",
									children: detail.noRepo ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "zat-coverfallback",
										children: String(detail.name || "?").slice(0, 1).toUpperCase()
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
										src: detail.cover,
										onError: (e) => {
											e.currentTarget.style.display = "none";
										},
										alt: detail.name
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-dtitle",
									children: detail.name
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-downer",
									children: detail.fullName
								}),
								detail.os !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-dstats",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "zat-osbadge",
										children: [
											t("支持系统:", "Supported:"),
											" ",
											detail.os.length === 0 ? t("跨平台", "Cross-platform") : osNames(detail.os)
										]
									})
								}),
								detail.noRepo && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-subchoices",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "zat-subchoices-title",
										children: t("这个插件是 npm/本地直接安装的,没有 GitHub 仓库地址,不支持更新、点星和查看仓库详情;可以在这里卸载或停用。", "This plugin was installed from npm or locally with no GitHub repo, so update, star and repo detail are unavailable — you can uninstall or disable it here.")
									})
								}),
								detail.noRepo ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-dstats",
									children: (detail.installed || detail.disabled) && detail.installedVersion && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "zat-ver",
										children: [t("已装 v", "v"), detail.installedVersion]
									})
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "zat-dstats",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											"⭐ ",
											formatStars(detail.stars),
											" stars"
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											"⑂ ",
											formatStars(detail.forks),
											" forks"
										] }),
										detail.language && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "zat-dot",
												style: { background: LANG_COLORS[detail.language] || "#8b949e" }
											}),
											" ",
											detail.language
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t("更新 ", "Updated "), String(detail.updatedAt || "").slice(0, 10)] }),
										(detail.installed || detail.disabled) && detail.installedVersion && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "zat-ver" + (detail.hasUpdate ? " zat-verold" : ""),
											children: [t("已装 v", "v"), detail.installedVersion]
										}),
										detail.hasUpdate && detail.latestVersion && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "zat-ver",
											children: [t("最新 v", "Latest v"), detail.latestVersion]
										})
									]
								}),
								detail.isHarness && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "zat-summary",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "zat-zhlabel",
											children: t("DeepSeek Harness 本体:", "DeepSeek Harness itself:")
										}),
										dd && dd.harnessVersion ? `${t("你正在使用 v", "You are running v")}${String(dd.harnessVersion)}。` : `${t("你正在使用它。", "You are using it.")}`,
										dd && dd.harnessHasUpdate && dd.harnessRemote ? ` ${t("官方已发布新版本 v", "A newer version v")}${String(dd.harnessRemote)}${t(",请到官方 Release 页面按你的安装方式更新。", ", please update through the official release page using your install method.")}` : ""
									]
								}),
								Boolean(dd && dd.notPlugin) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-subchoices",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "zat-subchoices-title",
										children: t("这不是可安装的 dsh 插件:仓库里没有插件声明,它可能是一个技能包或代码仓库(只是打了 dsh-plugin 标签)。请到 GitHub 查看它的使用方式。", "Not an installable dsh plugin: this repository declares no plugin — it may be a skill pack or code repo that merely carries the dsh-plugin topic. Check GitHub for usage instructions.")
									})
								}),
								detail.disabled && !detail.isHarness && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-subchoices",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "zat-subchoices-title",
										children: [t("这个插件已安装,但不在启用列表里——重启 dsh 也不会加载。", "This plugin is installed but missing from the bundle list — it will not load even after a restart."), " " + t("点下面的「启用插件」即可一键修复。", "Click \"Enable\" below to fix it in one click.")]
									})
								}),
								ddesc && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "zat-summary",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "zat-zhlabel",
										children: t("简介:", "About:")
									}), ddesc]
								}),
								dd && Array.isArray(dd.usage) && dd.usage.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "zat-summary",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "zat-zhlabel",
										children: t("怎么用:", "How to use:")
									}), dd.usage.join(";")]
								}),
								detail.topics && detail.topics.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-topics",
									children: detail.topics.map((tp) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "zat-topic",
										children: ["#", tp]
									}, tp))
								}),
								!detail.noRepo && (dd ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "zat-summary",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "zat-zhlabel",
										children: t("README 摘要:", "README:")
									}), String(dd.summary || t("该仓库暂无 README 摘要", "No README summary")).slice(0, 1200)]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-status",
									children: t("正在读取 README 简介…", "Loading README…")
								})),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "zat-actions",
									children: [
										mainBtn,
										detail.disabled && !detail.isHarness && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "zat-btn zat-primary",
											onClick: () => doSetEnabled(detail, true),
											disabled: !!installing,
											children: installing ? t("处理中…", "...") : t("启用插件", "Enable")
										}),
										canDisable(detail) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "zat-btn",
											onClick: () => doSetEnabled(detail, false),
											disabled: !!installing,
											children: installing ? t("处理中…", "...") : t("停用插件", "Disable")
										}),
										(detail.installed || detail.disabled) && !detail.isHarness && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "zat-btn zat-danger",
											onClick: () => doUninstall(detail),
											disabled: !!installing,
											children: t("卸载插件", "Uninstall")
										}),
										!detail.noRepo && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
											className: "zat-btn",
											href: detail.htmlUrl,
											target: "_blank",
											rel: "noreferrer",
											children: t("在 GitHub 查看 ↗", "View on GitHub ↗")
										})
									]
								}),
								notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-notice",
									children: notice
								})
							]
						})
					]
				});
			}
			if (health) {
				const counts = {
					error: 0,
					warn: 0,
					info: 0,
					ok: 0
				};
				for (const it of health) {
					const c = counts;
					if (it.level in c) c[it.level] += 1;
				}
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "zat-panel",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "zat-bar",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "zat-btn",
								onClick: () => setHealth(null),
								children: t("← 返回市场", "← Back")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-title",
								children: [t("插件体检报告", "Health check"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
									counts.error > 0 && `${t("冲突", "conflicts")} ${counts.error} · `,
									counts.warn > 0 && `${t("风险", "warnings")} ${counts.warn} · `,
									counts.ok > 0 && t("通过", "passed")
								] })]
							})]
						}),
						notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "zat-notice",
							children: notice
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "zat-detail",
							children: [health.map((it, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "zat-hitem zat-h-" + (it.level === "error" ? "error" : it.level === "warn" ? "warn" : it.level === "ok" ? "ok" : "info"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-htitle",
									children: it.title
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-hdetail",
									children: it.detail
								})]
							}, i)), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "zat-actions",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "zat-btn",
										onClick: () => setHealth(null),
										children: t("返回市场", "Back to market")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "zat-btn",
										onClick: runHealth,
										disabled: checking,
										children: checking ? t("检测中…", "Checking…") : t("再测一次", "Run again")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "zat-btn zat-primary",
										onClick: runRepair,
										disabled: checking,
										children: checking ? t("修复中…", "Fixing…") : t("🔧 一键修复", "Fix all")
									})
								]
							})]
						})
					]
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "zat-panel",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-bar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-title",
								children: [t("插件市场", "Plugin Market"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: total ? `${t("共 ", "")}${total}${t(" 个", "")}` : "" })]
							}),
							selfUpdate && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "zat-updbtn",
								disabled: selfUpdating,
								title: t("检测到插件市场新版本 v", "Plugin Market update available v") + (selfUpdate.latestVersion || ""),
								onClick: () => {
									if (selfUpdating) return;
									setSelfUpdating(true);
									pm.selfupdate(true).then((r) => {
										if (!r.ok) {
											setSelfUpdating(false);
											setNotice(r.error.message);
											return;
										}
										const value = r.value;
										const taskId = value && typeof value.taskId === "string" ? value.taskId : "";
										if (taskId) {
											pollTask(taskId, (result) => {
												setSelfUpdating(false);
												if (result && result.ok) {
													setSelfUpdate(null);
													setNotice(String(result.message || t("✅ 已更新!重启 dsh 后生效。", "✅ Updated! Restart dsh to activate.")));
												} else setNotice(String(result && result.message || t("更新失败", "Update failed")));
											});
											return;
										}
										setSelfUpdating(false);
										setNotice(String(value?.message || ""));
										if (value && value.ok) setSelfUpdate(null);
									}).catch((err) => {
										setSelfUpdating(false);
										setNotice(String(err?.message || err));
									});
								},
								children: selfUpdating ? t("更新中…", "Updating…") : `↑ ${t("更新 v", "Update v")}${selfUpdate.latestVersion || ""}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "zat-search",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "🔍" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									placeholder: t("输入即搜索…", "Type to search…"),
									value: query,
									onChange: (e) => setQuery(e.currentTarget.value)
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								className: "zat-sel",
								value: category,
								onChange: (e) => setCategory(e.currentTarget.value),
								title: t("分类", "Category"),
								children: CATEGORIES.map((cat) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: cat.label,
									children: zh ? cat.label : cat.en
								}, cat.label))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "zat-sel",
								value: sort,
								onChange: (e) => setSort(e.currentTarget.value),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "stars",
									children: t("最热门", "Most stars")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "updated",
									children: t("最新更新", "Recently updated")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "zat-sel",
								value: instFilter,
								onChange: (e) => {
									const v = e.currentTarget.value;
									setInstFilter(v);
									if (v === "installed") loadInstalled();
									else {
										setInstalledMode(false);
										load(1, sort, query, category, false);
									}
								},
								title: t("安装状态", "Install status"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "all",
										children: t("全部插件", "All")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "installed",
										children: t("已安装", "Installed")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "uninstalled",
										children: t("未安装", "Not installed")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "installable",
										children: t("可安装", "Installable")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-count",
								children: [
									t("显示 ", "Showing "),
									filtered.length,
									"/",
									items ? items.length : 0
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "zat-btn",
								onClick: runHealth,
								disabled: checking,
								title: t("检查已装插件的冲突、依赖矛盾与风险", "Check installed plugins for conflicts and risks"),
								children: checking ? t("检测中…", "Checking…") : t("🩺 一键检测", "🩺 Health check")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "zat-btn",
								onClick: () => setShowLegend((v) => !v),
								title: t("标签颜色说明", "Badge color guide"),
								children: t("🏷 图例", "🏷 Legend")
							})
						]
					}),
					progress && !installing && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-progress",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "zat-pbar",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "zat-pfill",
								style: { width: progress.pct + "%" }
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "zat-ptext",
							children: ["⏳ ", progress.message]
						})]
					}),
					showLegend && (selfUpdate && selfUpdate.changes && selfUpdate.changes.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-legend",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "zat-lghead",
							children: [
								"↑ ",
								t("更新 v", "Update v"),
								selfUpdate.latestVersion || "",
								t(" 内容:", " — what changed:")
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "zat-lgi zat-lgwrap",
							children: [selfUpdate.changes.slice(0, 3).map((c) => c.replace(/[（(][^)）]*[)）]/g, "")).join("、"), selfUpdate.changes.length > 3 ? t(" 等", " …") : ""]
						})]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-legend",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-lghead",
								children: [t("标签说明", "Badge guide"), ":"]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-lgi",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { background: "#10b981" } }),
									"✓ ",
									t("已安装(已启用)", "Installed (enabled)")
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-lgi",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { background: "#0ea5e9" } }),
									"↑ ",
									t("有更新", "Update available")
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-lgi",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { background: "#7a4dff" } }), t("安装", "Install")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-lgi",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { background: "#d97706" } }), t("技能·不可安装", "Skill · not installable")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-lgi",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { background: "#5a6478" } }), t("非插件·不可安装", "Not a plugin · not installable")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-lgi",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { background: "#4f46e5" } }), t("多插件·装时选择", "Multi · pick one to install")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-lgi",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { background: "#f5b942" } }),
									"★ ",
									t("已星标(点击切换)", "Starred (click to toggle)")
								]
							})
						]
					})),
					notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "zat-notice",
						children: notice
					}),
					subChoices && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-subchoices",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "zat-subchoices-title",
								children: t("这个插件包含多个部分,请选择要安装的:", "This plugin bundles several parts — choose one to install:")
							}),
							subChoices.packages.map((sub) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "zat-subrow",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "zat-subname",
									children: [sub.name, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
										"(",
										sub.dir,
										sub.version ? ` v${sub.version}` : "",
										")"
									] })]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "zat-btn zat-primary",
									onClick: () => doInstallSub(subChoices, sub),
									disabled: !!installing,
									children: installing ? t("处理中…", "...") : t("安装", "Install")
								})]
							}, sub.dir)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "zat-btn",
								onClick: () => setSubChoices(null),
								children: t("取消", "Cancel")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-grid",
						onScroll,
						children: [
							error && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "zat-status zat-error",
								children: ["⚠ ", error]
							}),
							!items && !error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "zat-status",
								children: t("正在加载插件列表…", "Loading plugins…")
							}),
							items && items.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "zat-status",
								children: t("没有找到插件", "No plugins found")
							}),
							items && items.length > 0 && filtered.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "zat-status",
								children: t("当前筛选条件下没有插件", "No plugins match filters")
							}),
							filtered.map((it) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarketCard, {
								item: it,
								zh,
								t,
								installing: installing === it.fullName,
								progress: installing === it.fullName ? progress : null,
								taskProgress: taskStates[it.fullName] || null,
								onOpen: openDetail,
								onAction: cardAction,
								onStar,
								onToggle: doSetEnabled
							}, it.fullName)),
							loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "zat-loading",
								children: t("正在加载…", "Loading…")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-foot",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "zat-count",
							children: [
								profileInfo && profileInfo.profileName ? `${t("当前 profile:", "Profile: ")}${profileInfo.profileName} · ${profileInfo.profileDir} · ` : "",
								t("已加载 ", "Loaded "),
								items ? items.length : 0,
								" / ",
								total,
								t(" · 滚动到底自动加载 · GitHub 搜索上限 1000", " · scroll to load more · GitHub cap 1000")
							]
						}), !installedMode && page * 100 < total && !loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "zat-btn",
							onClick: () => load(page + 1, sort, query, category, true),
							children: t("加载更多 ↓", "Load more ↓")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-legend",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "zat-lghead",
								children: "GitHub Token:"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "zat-token",
								type: "password",
								placeholder: t("可选,用于一键星标;只保存在本机 profile 目录", "Optional, for one-click star; stored only in your local profile"),
								value: tokenInput,
								onChange: (e) => setTokenInput(e.currentTarget.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "zat-btn",
								onClick: saveToken,
								children: t("保存", "Save")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "zat-btn",
								onClick: clearToken,
								children: t("清除", "Clear")
							}),
							hasToken === true && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-count",
								children: ["✓ ", t("已配置,卡片上的★即当前账号的星标", "Configured — ★ shows your account stars")]
							})
						]
					})
				]
			});
		}
		/** A plugin can be disabled unless it is official core or the market itself. */
		function canDisable(item) {
			if (!item.installed || item.disabled || item.isHarness) return false;
			if ((item.installedName || "").startsWith("@deepseek-ai/")) return false;
			if (item.fullName.toLowerCase() === "mishibeikejie/zat-dsh-engine") return false;
			return true;
		}
		function MarketCard({ item, zh, t, installing, progress, taskProgress, onOpen, onAction, onStar, onToggle }) {
			const [coverErr, setCoverErr] = (0, react.useState)(false);
			const desc = zh && item.zhIntro ? item.zhIntro : item.description || t("暂无简介", "No description");
			const hasUpdate = item.installed && item.hasUpdate;
			const nonInstallable = item.kind === "skill" || item.kind === "nonplugin";
			const busy = installing || Boolean(item.installing && !item.installed);
			const shownProgress = installing && progress ? progress : taskProgress;
			const btnClass = item.disabled ? "zat-disabled" : nonInstallable ? item.kind === "skill" ? "zat-noninstall" : "zat-nonplugin" : hasUpdate ? "zat-update" : item.installed ? "zat-installed" : "zat-install";
			const btnText = busy ? t("处理中…", "...") : item.isHarness ? zh ? "✓ 使用中" : "✓ In use" : item.disabled ? zh ? "已装·未启用 → 点此启用" : "Installed, disabled → click to enable" : nonInstallable ? item.kind === "skill" ? zh ? "技能 · 不可安装" : "Skill · not installable" : zh ? "非插件 · 不可安装" : "Not a plugin" : hasUpdate ? t("更新", "Update") : item.installed ? t("已安装", "Installed") : t("安装", "Install");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "zat-card",
				onClick: () => onOpen(item),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "zat-cover",
					children: [
						coverErr || item.noRepo ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "zat-coverfallback",
							children: String(item.name || "?").slice(0, 1).toUpperCase()
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							src: item.cover,
							loading: "lazy",
							onError: () => setCoverErr(true),
							alt: item.name
						}),
						item.noRepo && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "zat-kindbadge zat-kind-nonplugin",
							children: zh ? "npm/本地" : "npm/local"
						}),
						item.kind === "skill" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "zat-kindbadge zat-kind-skill",
							children: zh ? "技能" : "Skill"
						}),
						item.kind === "nonplugin" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "zat-kindbadge zat-kind-nonplugin",
							children: zh ? "非插件" : "Not a plugin"
						}),
						item.kind === "multi" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "zat-kindbadge zat-kind-multi",
							children: zh ? "多插件" : "Multi"
						}),
						hasUpdate ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "zat-updbadge",
							children: ["↑ ", t("有更新", "Update")]
						}) : item.installed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "zat-badge",
							children: item.isHarness ? zh ? "本机" : "Local" : `✓ ${t("已安装", "Installed")}`
						}) : null,
						zh && item.zhIntro ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "zat-zhbadge",
							children: "中文简介"
						}) : null
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "zat-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "zat-name",
							title: item.fullName,
							children: item.name
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "zat-owner",
							children: item.fullName
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "zat-desc",
							children: desc
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "zat-meta",
							children: [
								!item.noRepo && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "zat-star" + (item.starred ? "" : " zat-staroff"),
									title: item.starred ? t("已星标,点击取消", "Starred — click to unstar") : t("点击星标", "Click to star"),
									onClick: (e) => {
										e.stopPropagation();
										onStar(item);
									},
									children: [
										item.starred ? "★" : "☆",
										" ",
										formatStars(item.stars)
									]
								}),
								item.language && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "zat-dot",
										style: { background: LANG_COLORS[item.language] || "#8b949e" }
									}),
									" ",
									item.language
								] }),
								item.os !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "zat-osbadge",
									title: t("支持的系统", "Supported systems"),
									children: item.os.length === 0 ? t("跨平台", "Cross-platform") : osNames(item.os)
								}),
								canDisable(item) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "zat-mini",
									title: t("停用此插件,重启后不再加载", "Disable — not loaded after restart"),
									onClick: (e) => {
										e.stopPropagation();
										onToggle(item, false);
									},
									children: t("停用", "Disable")
								})
							]
						}),
						shownProgress ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "zat-cardprogress",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "zat-pbar",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "zat-pfill",
									style: { width: shownProgress.pct + "%" }
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "zat-ptext",
								children: shownProgress.message
							})]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: `zat-cardbtn ${btnClass}`,
							onClick: (e) => {
								e.stopPropagation();
								onAction(item);
							},
							disabled: !!installing,
							children: btnText
						})
					]
				})]
			});
		}
		function SessionManagerPanel({ pm, locale, refreshSessions }) {
			const [zh, setZh] = (0, react.useState)(true);
			const [sessions, setSessions] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				const off = locale.subscribe(() => {
					const snap = locale.getLocale();
					setZh(snap?.active ? isZh(String(snap.active)) : true);
				});
				return () => {
					off?.();
				};
			}, [locale]);
			(0, react.useEffect)(() => {
				if (!notice) return;
				const timer = setTimeout(() => setNotice(""), 5500);
				return () => clearTimeout(timer);
			}, [notice]);
			const t = (zhText, enText) => zh ? zhText : enText;
			function reload() {
				setError("");
				pm.listSessions().then((res) => {
					if (!res.ok || !res.value.ok) {
						setError(res.ok ? String(res.value.message || "") : res.error.message);
						setSessions(null);
						return;
					}
					setSessions(Array.isArray(res.value.sessions) ? res.value.sessions : []);
				}).catch((err) => {
					setError(String(err?.message || err));
					setSessions(null);
				});
			}
			(0, react.useEffect)(() => {
				reload();
			}, []);
			function remove(item) {
				if (item.live) {
					setNotice(t("运行中的会话不能删除,等它跑完再删", "A running session cannot be deleted — wait for it to finish"));
					return;
				}
				if (item.subagent) {
					setNotice(t("子代理会话不能直接删除", "Subagent sessions cannot be deleted directly"));
					return;
				}
				if (!window.confirm(t(`确定永久删除会话 ${item.id}?此操作不可恢复。`, `Delete session ${item.id} permanently? This cannot be undone.`))) return;
				setBusy(item.id);
				pm.deleteSession(item.id).then((res) => {
					setBusy("");
					setNotice(res.ok ? String(res.value.message || "") : res.error.message);
					if (res.ok && res.value.ok) {
						reload();
						refreshSessions(item.id);
					}
				}).catch((err) => {
					setBusy("");
					setNotice(String(err?.message || err));
				});
			}
			const active = sessions ? sessions.filter((s) => !s.archived) : null;
			const archived = sessions ? sessions.filter((s) => s.archived) : null;
			function renderList(list, head, empty) {
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "zat-col",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-colhead",
						children: [head, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
							t("共 ", ""),
							list.length,
							t(" 个", "")
						] })]
					}), list.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "zat-status",
						children: empty
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "zat-detail",
						children: list.map((it) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "zat-srow",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "zat-smeta",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "zat-stitle",
										title: it.id,
										children: it.title || t("(无标题)", "(untitled)")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "zat-sid",
										title: it.id,
										children: it.id
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "zat-stime",
										children: new Date(Number(it.createdAt)).toLocaleString()
									}),
									it.live && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "zat-tag zat-tag-live",
										children: t("运行中", "Running")
									}),
									it.subagent && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "zat-tag",
										children: t("子代理", "Subagent")
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "zat-btn zat-delete",
								onClick: () => remove(it),
								disabled: !!busy || it.live || it.subagent,
								children: busy === it.id ? t("删除中…", "Deleting…") : t("删除", "Delete")
							})]
						}, it.id))
					})]
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "zat-panel",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-bar",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "zat-title",
							children: [t("对话管理", "Sessions"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: sessions ? `${t("共 ", "")}${sessions.length}${t(" 个会话", "")}` : "" })]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "zat-btn",
							onClick: reload,
							children: t("刷新", "Refresh")
						})]
					}),
					notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "zat-notice",
						children: notice
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-status zat-error",
						children: ["⚠ ", error]
					}),
					sessions === null && !error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "zat-status",
						children: t("正在读取会话列表…", "Loading sessions…")
					}),
					sessions !== null && active !== null && archived !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "zat-cols",
						children: [renderList(active, t("对话管理", "Sessions"), t("没有进行中的会话", "No active sessions")), renderList(archived, t("归档管理", "Archived"), t("没有已归档的会话", "No archived sessions"))]
					})
				]
			});
		}
		const inject = [
			"slots",
			"locale",
			"remote",
			"sessions"
		];
		async function apply(ctx) {
			const dispose = await ctx.remote.$mount({
				package: "zat-dsh-engine",
				descriptors: marketDescriptors
			});
			injectCss();
			const slots = ctx.slots;
			const locale = ctx.locale;
			const pm = ctx.get("remote.pluginMarket");
			slots.inject("settings.plugins.tab", () => slots.register({
				name: "settings.plugins.tab",
				id: "plugin-market",
				order: 20,
				label: () => {
					const snap = locale.getLocale();
					return (snap?.active ? isZh(String(snap.active)) : true) ? "🛒 插件市场" : "🛒 Plugin Market";
				},
				inject: () => ({
					pm,
					locale
				})
			}, MarketPanel));
			const refreshSessions = (deletedId) => {
				const svc = ctx.get("sessions");
				if (!svc) return;
				try {
					if (svc.list && svc.list.getSnapshot().current === deletedId) svc.clear();
				} catch {}
				svc.refresh().catch(() => {});
			};
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "session-manager",
				order: 21,
				label: () => {
					const snap = locale.getLocale();
					return (snap?.active ? isZh(String(snap.active)) : true) ? "🗑 对话管理" : "🗑 Sessions";
				},
				inject: () => ({
					pm,
					locale,
					refreshSessions
				})
			}, SessionManagerPanel));
			return async () => {
				await dispose();
			};
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map