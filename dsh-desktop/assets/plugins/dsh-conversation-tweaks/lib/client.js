window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-conversation-tweaks",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		const { useSyncExternalStore, useRef, useMemo, useEffect, useDebugValue } = react;
		// rc.2 内核 dsh-client-ui-renderer 的 client 包未导出 useSyncExternalStoreWithSelector
		// （仅导出 apply/inject），故在此内联 use-sync-external-store 1.2.0 的 with-selector
		// shim（React 官方实现，MIT），bindSnapshotSelector 语义与旧包 bind.ts 逐行等价。
		const objectIs = (a, b) => (a === b && (a !== 0 || 1 / a === 1 / b)) || (a !== a && b !== b);
		const defaultIsEqual = typeof Object.is === "function" ? Object.is : objectIs;
		function useSyncExternalStoreWithSelector(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
			const instRef = useRef(null);
			let inst;
			if (instRef.current === null) {
				inst = { hasValue: false, value: null };
				instRef.current = inst;
			} else {
				inst = instRef.current;
			}
			const [getSelection, getServerSelection] = useMemo(() => {
				let hasMemo = false;
				let memoizedSnapshot;
				let memoizedSelection;
				const memoizedSelector = (nextSnapshot) => {
					if (!hasMemo) {
						hasMemo = true;
						memoizedSnapshot = nextSnapshot;
						const nextSelection = selector(nextSnapshot);
						if (isEqual !== undefined && inst.hasValue) {
							const currentSelection = inst.value;
							if (isEqual(currentSelection, nextSelection)) {
								memoizedSelection = currentSelection;
								return currentSelection;
							}
						}
						memoizedSelection = nextSelection;
						return nextSelection;
					}
					const prevSnapshot = memoizedSnapshot;
					const prevSelection = memoizedSelection;
					if (defaultIsEqual(prevSnapshot, nextSnapshot)) return prevSelection;
					const nextSelection = selector(nextSnapshot);
					if (isEqual !== undefined && isEqual(prevSelection, nextSelection)) return prevSelection;
					memoizedSnapshot = nextSnapshot;
					memoizedSelection = nextSelection;
					return nextSelection;
				};
				const getSnapshotWithSelector = () => memoizedSelector(getSnapshot());
				const getServerSnapshotWithSelector = getServerSnapshot === undefined ? undefined : () => memoizedSelector(getServerSnapshot());
				return [getSnapshotWithSelector, getServerSnapshotWithSelector];
			}, [getSnapshot, getServerSnapshot, selector, isEqual]);
			const value = useSyncExternalStore(subscribe, getSelection, getServerSelection);
			useEffect(() => {
				inst.hasValue = true;
				inst.value = value;
			}, [value]);
			useDebugValue(value);
			return value;
		}
		const bindSnapshotSelector = (w) => {
			const subscribe = (fn) => w.subscribe(fn);
			const getSnapshot = () => w.getSnapshot();
			return (sel, eq) => useSyncExternalStoreWithSelector(subscribe, getSnapshot, void 0, sel, eq);
		};

		// ------------------------------------------------------------------
		// Settings
		// ------------------------------------------------------------------
		const NS = "dsh-conversation-tweaks";
		const L = {
			quietTitle: "隐藏对话输出",
			quietDesc: "开启后隐藏大量工具调用、工具结果与思考过程，只显示每一轮的最终总结输出。",
			quietOn: "已隐藏",
			quietOff: "显示全部"
		};

		const CSS = [
			// 通用设置行
			".dct-row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}",
			".dct-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}",
			".dct-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
			".dct-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}",
			".dct-switch{width:44px;height:26px;background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;border:none;border-radius:999px;flex:none;position:relative;transition:background .15s}",
			".dct-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary)}",
			".dct-switch:disabled{opacity:.5;cursor:default}",
			".dct-knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .15s}",
			".dct-switch[aria-checked=true] .dct-knob{transform:translateX(18px)}",

			// 隐藏大量工具调用、工具结果与思考过程；每一轮最终总结文字由
			// refreshQuietMarkers 标记 data-dsh-keep-summary 后保持可见。
			'body[data-dsh-quiet-output] .Md3f7G_flowItem[data-chat-flow-kind="tool-call"]{display:none!important}',
			'body[data-dsh-quiet-output] .Md3f7G_flowItem[data-chat-flow-kind="tool-result"]{display:none!important}',
			'body[data-dsh-quiet-output] .QWLzlG_root{display:none!important}',
			'body[data-dsh-quiet-output] .Sxvs8a_root .Sxvs8a_body > ._markdown_1nba0_5{display:none!important}',
			'body[data-dsh-quiet-output] .Sxvs8a_root[data-dsh-keep-summary] .Sxvs8a_body > ._markdown_1nba0_5{display:block!important}'
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			const tagId = "@deepseek-ai/dsh-conversation-tweaks/client.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-conversation-tweaks";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------
		// 设置-通用：隐藏对话输出
		// ------------------------------------------------------------------
		function QuietOutputRow({ useScope, scope }) {
			const snap = useScope((s) => s);
			const ready = snap && snap.status === "ready";
			const enabled = !!(ready && snap.value && snap.value.quietOutput === true);
			return jsxs("div", {
				className: "dct-row",
				children: [
					jsxs("div", {
						className: "dct-rowText",
						children: [
							jsx("div", { className: "dct-title", children: L.quietTitle }),
							jsx("div", { className: "dct-desc", children: L.quietDesc })
						]
					}),
					jsx("button", {
						type: "button",
						role: "switch",
						"aria-checked": enabled,
						"aria-label": L.quietTitle,
						title: enabled ? L.quietOn : L.quietOff,
						className: "dct-switch",
						disabled: !ready || !snap.writable,
						onClick: () => { scope.set("quietOutput", !enabled).catch(() => {}); },
						children: jsx("span", { className: "dct-knob" })
					})
				]
			});
		}


		// ------------------------------------------------------------------
		// 隐藏输出：工具调用/工具结果/思考行由 CSS 整体隐藏；这里把每一轮
		// 最后一个带 Markdown 正文的助手消息标记为「总结」，保持最终输出可见。
		// DOM 高频变化时用 250ms 防抖。
		// ------------------------------------------------------------------
		function refreshQuietMarkers() {
			if (typeof document === "undefined") return;
			const roots = Array.from(document.querySelectorAll(".Sxvs8a_root"));
			for (const root of roots) root.removeAttribute("data-dsh-keep-summary");
			if (!document.body.hasAttribute("data-dsh-quiet-output")) return;

			// 按 DOM 顺序扫描聊天流：每个 user 节点表示新的一轮；轮到下一个
			// user（或流末尾）时，把本轮最后一个带正文的助手消息标记为总结。
			const flowItems = Array.from(document.querySelectorAll(".Md3f7G_flowItem[data-chat-flow-kind]"));
			let turnSummary = null;
			const flushTurn = () => {
				if (turnSummary) turnSummary.setAttribute("data-dsh-keep-summary", "1");
				turnSummary = null;
			};
			for (const item of flowItems) {
				const kind = item.getAttribute("data-chat-flow-kind");
				if (kind === "assistant" || kind === "assistant-step") {
					const root = item.querySelector(".Sxvs8a_root");
					if (root && root.querySelector(".Sxvs8a_body > ._markdown_1nba0_5")) turnSummary = root;
				} else if (kind === "user") {
					flushTurn();
				}
			}
			flushTurn();
		}

		function setupQuietMarkers() {
			if (typeof document === "undefined") return () => {};
			let pending = null;
			const schedule = () => {
				if (pending) return;
				// 隐藏输出关闭时不跟跑 body 观察器；开关切换由 applyQuiet 直接刷新。
				if (!document.body.hasAttribute("data-dsh-quiet-output")) return;
				pending = setTimeout(() => {
					pending = null;
					refreshQuietMarkers();
				}, 250);
			};
			refreshQuietMarkers();
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			return () => {
				if (pending) clearTimeout(pending);
				observer.disconnect();
			};
		}

		// ------------------------------------------------------------------
		// 插件入口
		// ------------------------------------------------------------------
		function apply(ctx) {
			ensureCss();

			const scope = ctx.settingsScope.bind({ namespace: NS });
			const useScope = bindSnapshotSelector(scope);

			const applyQuiet = () => {
				if (typeof document === "undefined") return;
				const snap = scope.getSnapshot();
				const enabled = snap && snap.status === "ready" && snap.value && snap.value.quietOutput === true;
				if (enabled) document.body.setAttribute("data-dsh-quiet-output", "1");
				else document.body.removeAttribute("data-dsh-quiet-output");
				refreshQuietMarkers();
			};
			applyQuiet();
			scope.subscribe(applyQuiet);

			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "quiet-output",
				order: 25,
				inject: () => ({ useScope, scope })
			}, QuietOutputRow), "dsh-conversation-tweaks: quiet output row");

			ctx.effect(() => setupQuietMarkers(), "dsh-conversation-tweaks: quiet summary markers");
		}

		exports.apply = apply;
		exports.inject = ["slots", "settingsScope"];
		return module.exports;
	}
});
