// @deepseek-ai/dsh-openclaw-bridge 客户端半边：DSH 设置页的「ClawBot」配置栏。
// 两个区块：
//  1) 桥接设置：接收模型 + 桥接 Token（settingsScope 读写 openclaw-bridge 命名空间）
//  2) 微信连接：iLink 渠道状态 / 扫码绑定 / 配对码 / 断开（回环控制路由）
// 打包格式与 dsh-client-ui-settings-models 的 lib/client.js 相同。
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-openclaw-bridge",
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
		const { Button, Input } = require("@deepseek-ai/dsh-client-ui-primitives");

		const NS = "openclaw-bridge";

		const L = {
			nav: "ClawBot",
			navSub: "微信 ClawBot / 网关 → DSH 会话桥接",
			modelLabel: "接收模型",
			modelHint: "形如 provider/model（如 deepseek-official/deepseek-v4-pro）；留空 = 使用 DSH 默认模型",
			tokenLabel: "桥接 Token",
			tokenHint: "留空保存 = 保持现状（回环地址访问无需 Token）",
			workspaceLabel: "微信工作目录（远程办公）",
			workspaceHint: "绝对路径，如 C:\\Users\\you\\Desktop\\work；留空 = 隔离的桥接工作区",
			allowlistLabel: "微信用户白名单",
			allowlistHint: "逗号分隔的微信用户 id（xxx@im.wechat）；留空 = 允许所有发消息的人",
			customTitle: "第三方模型端点（OpenAI 兼容）",
			customBaseLabel: "baseURL",
			customBaseHint: "填了它就改用这个端点（如 https://api.siliconflow.cn/v1）；留空 = 用上面的接收模型",
			customKeyLabel: "API Key",
			customKeyHint: "留空保存 = 保持现状",
			customModelLabel: "模型名",
			customModelHint: "该端点上的模型 id（如 deepseek-ai/DeepSeek-V3）",
			endpoint: "接入端点（OpenAI 兼容）：",
			endpointPath: "/openclaw-bridge/v1/chat/completions",
			save: "保存",
			saving: "保存中…",
			saved: "已保存",
			loading: "加载中…",
			unavailable: "设置不可用（需要在本机浏览器中打开）",
			wechatTitle: "微信连接（iLink 直连，不经 OpenClaw）",
			wxDisconnected: "未连接",
			wxWaitingQr: "正在生成二维码…",
			wxWaitingScan: "请用微信扫码绑定（ClawBot 插件里点绑定，扫这个码）：",
			wxNeedVerify: "微信已扫码，请输入微信上显示的配对码：",
			wxConnected: "已连接",
			wxExpired: "会话已过期，请重新扫码",
			connect: "连接微信",
			disconnect: "断开",
			submitCode: "提交配对码",
			codePlaceholder: "数字配对码",
			hoursLeft: "剩余约 X 小时（每 24h 需重扫）",
			scanLink: "也可以点开链接绑定："
		};

		function fieldRow(label, hint, input) {
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 4 },
				children: [
					jsx("span", { children: label }),
					input,
					hint ? jsx("span", { style: { fontSize: 12, opacity: 0.65 }, children: hint }) : null
				]
			});
		}

		function SettingsBlock(props) {
			const { useScope, scope } = props;
			const snap = useScope((s) => s);
			const [model, setModel] = react.useState("");
			const [token, setToken] = react.useState("");
			const [workspace, setWorkspace] = react.useState("");
			const [allowlist, setAllowlist] = react.useState("");
			const [customBaseURL, setCustomBaseURL] = react.useState("");
			const [customApiKey, setCustomApiKey] = react.useState("");
			const [customModel, setCustomModel] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [saved, setSaved] = react.useState(false);

			react.useEffect(() => {
				if (snap.status !== "ready") return;
				setModel((snap.value && snap.value.model) || "");
				setToken("");
				setWorkspace((snap.value && snap.value.workspace) || "");
				setAllowlist((snap.value && snap.value.allowlist) || "");
				setCustomBaseURL((snap.value && snap.value.customBaseURL) || "");
				setCustomApiKey("");
				setCustomModel((snap.value && snap.value.customModel) || "");
			}, [snap.status]);

			if (snap.status !== "ready") {
				return jsx("div", { children: snap.status === "loading" ? L.loading : L.unavailable });
			}

			const save = async () => {
				setBusy(true);
				setSaved(false);
				try {
					const wantModel = model.trim();
					const haveModel = (snap.value && snap.value.model) || "";
					if (wantModel !== haveModel) await scope.set("model", wantModel);
					const wantToken = token.trim();
					if (wantToken !== "") await scope.set("token", wantToken);
					const wantWorkspace = workspace.trim();
					const haveWorkspace = (snap.value && snap.value.workspace) || "";
					if (wantWorkspace !== haveWorkspace) await scope.set("workspace", wantWorkspace);
					const wantAllowlist = allowlist.trim();
					const haveAllowlist = (snap.value && snap.value.allowlist) || "";
					if (wantAllowlist !== haveAllowlist) await scope.set("allowlist", wantAllowlist);
					const wantCustomBase = customBaseURL.trim();
					const haveCustomBase = (snap.value && snap.value.customBaseURL) || "";
					if (wantCustomBase !== haveCustomBase) await scope.set("customBaseURL", wantCustomBase);
					const wantCustomKey = customApiKey.trim();
					if (wantCustomKey !== "") await scope.set("customApiKey", wantCustomKey);
					const wantCustomModel = customModel.trim();
					const haveCustomModel = (snap.value && snap.value.customModel) || "";
					if (wantCustomModel !== haveCustomModel) await scope.set("customModel", wantCustomModel);
					setSaved(true);
				} finally {
					setBusy(false);
				}
			};

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 12 },
				children: [
					fieldRow(L.modelLabel, L.modelHint, jsx(Input, {
						value: model,
						placeholder: "provider/model",
						onChange: (e) => setModel(e.target.value)
					})),
					fieldRow(L.tokenLabel, L.tokenHint, jsx(Input, {
						value: token,
						placeholder: "（留空保持现状）",
						onChange: (e) => setToken(e.target.value)
					})),
					fieldRow(L.workspaceLabel, L.workspaceHint, jsx(Input, {
						value: workspace,
						placeholder: "留空 = 隔离工作区",
						onChange: (e) => setWorkspace(e.target.value)
					})),
					fieldRow(L.allowlistLabel, L.allowlistHint, jsx(Input, {
						value: allowlist,
						placeholder: "user1@im.wechat,user2@im.wechat",
						onChange: (e) => setAllowlist(e.target.value)
					})),
					jsx("h3", { children: L.customTitle }),
					fieldRow(L.customBaseLabel, L.customBaseHint, jsx(Input, {
						value: customBaseURL,
						placeholder: "https://api.example.com/v1",
						onChange: (e) => setCustomBaseURL(e.target.value)
					})),
					fieldRow(L.customKeyLabel, L.customKeyHint, jsx(Input, {
						value: customApiKey,
						placeholder: "sk-...",
						onChange: (e) => setCustomApiKey(e.target.value)
					})),
					fieldRow(L.customModelLabel, L.customModelHint, jsx(Input, {
						value: customModel,
						placeholder: "model-id",
						onChange: (e) => setCustomModel(e.target.value)
					})),
					jsx("div", { style: { fontSize: 12, opacity: 0.65 }, children: L.endpoint + " " + L.endpointPath }),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: 8 },
						children: [
							jsx(Button, {
								variant: "primary",
								size: "sm",
								disabled: busy || !snap.writable,
								onClick: save,
								children: busy ? L.saving : L.save
							}),
							saved ? jsx("span", { children: L.saved }) : null
						]
					})
				]
			});
		}

		function WechatBlock() {
			const [st, setSt] = react.useState(null);
			const [code, setCode] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");

			const refresh = react.useCallback(async () => {
				try {
					const r = await fetch("/openclaw-bridge/wechat/status", { cache: "no-store" });
					if (r.ok) setSt(await r.json());
					else setSt(null);
				} catch {
					setSt(null);
				}
			}, []);

			react.useEffect(() => {
				refresh();
				const timer = setInterval(refresh, 4000);
				return () => clearInterval(timer);
			}, [refresh]);

			const post = async (path, body) => {
				setBusy(true);
				setErr("");
				try {
					const r = await fetch(path, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: body === void 0 ? "{}" : JSON.stringify(body),
					});
					const data = await r.json().catch(() => ({}));
					setSt(data);
					if (!r.ok && data && data.error) setErr(String(data.error));
				} catch (e) {
					setErr(String(e));
				} finally {
					setBusy(false);
				}
			};

			const stateLabel = () => {
				if (!st) return L.unavailable;
				if (st.state === "disconnected") return L.wxDisconnected;
				if (st.state === "waiting-qr") return L.wxWaitingQr;
				if (st.state === "waiting-scan") return L.wxWaitingScan;
				if (st.state === "need-verifycode") return L.wxNeedVerify;
				if (st.state === "connected") return L.wxConnected;
				if (st.state === "expired") return L.wxExpired;
				return st.state;
			};

			const qrImg = st && st.qrcodeUrl
				? "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(st.qrcodeUrl)
				: null;

			const hoursLeft = st && st.expiresAt
				? Math.max(0, Math.round((st.expiresAt - Date.now()) / 3600000))
				: null;

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 10 },
				children: [
					jsx("h3", { children: L.wechatTitle }),
					jsx("span", { children: stateLabel() }),
					st && st.botId ? jsx("span", { style: { fontSize: 12, opacity: 0.65 }, children: st.botId }) : null,
					hoursLeft !== null ? jsx("span", { style: { fontSize: 12, opacity: 0.65 }, children: L.hoursLeft.replace("X", String(hoursLeft)) }) : null,
					qrImg ? jsx("img", { src: qrImg, alt: "ClawBot QR", style: { width: 220, height: 220 } }) : null,
					st && st.qrcodeUrl ? jsx("a", { href: st.qrcodeUrl, target: "_blank", rel: "noreferrer", children: L.scanLink }) : null,
					st && st.state === "need-verifycode" ? jsxs("div", {
						style: { display: "flex", gap: 8, alignItems: "center" },
						children: [
							jsx(Input, { value: code, placeholder: L.codePlaceholder, onChange: (e) => setCode(e.target.value) }),
							jsx(Button, { variant: "primary", size: "sm", disabled: busy, onClick: () => post("/openclaw-bridge/wechat/verify", { code }), children: L.submitCode })
						]
					}) : null,
					jsxs("div", {
						style: { display: "flex", gap: 8 },
						children: [
							st && (st.state === "disconnected" || st.state === "expired") ? jsx(Button, {
								variant: "primary",
								size: "sm",
								disabled: busy,
								onClick: () => post("/openclaw-bridge/wechat/login"),
								children: L.connect
							}) : null,
							st && st.state === "connected" ? jsx(Button, {
								size: "sm",
								disabled: busy,
								onClick: () => post("/openclaw-bridge/wechat/logout"),
								children: L.disconnect
							}) : null
						]
					}),
					err ? jsx("span", { style: { color: "#c0392b" }, children: err }) : null
				]
			});
		}

		function ClawBotCard(props) {
			const { useScope, scope } = props;
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 16, padding: 16, maxWidth: 560 },
				children: [
					jsx("h2", { children: L.navSub }),
					jsx(SettingsBlock, { useScope, scope }),
					jsx(WechatBlock, {})
				]
			});
		}

		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: NS });
			const useScope = bindSnapshotSelector(scope);
			const injected = () => ({ useScope, scope });
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "openclaw-bridge",
				order: 50,
				label: () => L.nav,
				inject: injected
			}, ClawBotCard), "dsh-openclaw-bridge: settings section entry");
		}

		const inject = ["slots", "settingsScope"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
