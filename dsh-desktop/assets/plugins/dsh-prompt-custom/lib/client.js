// @deepseek-ai/dsh-prompt-custom 客户端半边：DSH 设置页的「自定义提示词」栏。
// 命名空间 dsh-prompt：
//   - enabled：是否启用自定义提示词
//   - mode：replace（替换整体）/ append（追加到末尾）
//   - text：自定义提示词内容
// 打包格式与 dsh-client-ui-settings-models 的 lib/client.js 相同。
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-prompt-custom",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		const bindSnapshotSelector = (source) => {
			const subscribe = (listener) => source.subscribe(listener);
			const getSnapshot = () => source.getSnapshot();
			return (select) => select(react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot));
		};
		const Button = ({ variant, size, loading, ...props }) => jsx("button", { type: "button", disabled: loading || props.disabled, ...props });

		const NS = "dsh-prompt";

		const L = {
			nav: "自定义提示词",
			navSub: "修改官方内核注入的系统提示词（应用到 standard 完整 Agent 基准预设）",
			enabledLabel: "启用自定义提示词",
			enabledHint: "关闭后回落为官方默认提示词",
			modeLabel: "注入方式",
			modeReplace: "替换整体（覆盖默认人设）",
			modeAppend: "追加到末尾（保留默认人设，在其后追加）",
			textLabel: "提示词内容",
			textPlaceholder: "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
			textHint: "按原样注入；可用 {{model}} 等占位符。建议包含对你的全面要求与项目约定。",
			save: "保存",
			saving: "保存中…",
			saved: "已保存",
			loading: "加载中…",
			unavailable: "设置不可用（需要在本机浏览器中打开）",
			preview: "预览官方提示词",
			previewLoading: "加载中…",
			previewHint: "渲染后的官方默认 system prompt（不含自定义节），供对照编辑。",
			previewError: "预览加载失败"
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
			const [enabled, setEnabled] = react.useState(false);
			const [mode, setMode] = react.useState("append");
			const [text, setText] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [saved, setSaved] = react.useState(false);
			const [previewText, setPreviewText] = react.useState("");
			const [previewLoading, setPreviewLoading] = react.useState(false);
			const [previewError, setPreviewError] = react.useState("");

			react.useEffect(() => {
				if (snap.status !== "ready") return;
				setEnabled(!!(snap.value && snap.value.enabled));
				setMode((snap.value && snap.value.mode) || "append");
				setText((snap.value && snap.value.text) || "");
			}, [snap.status]);

			if (snap.status !== "ready") {
				return jsx("div", { children: snap.status === "loading" ? L.loading : L.unavailable });
			}

			const save = async () => {
				setBusy(true);
				setSaved(false);
				try {
					const wantEnabled = !!enabled;
					const haveEnabled = !!(snap.value && snap.value.enabled);
					if (wantEnabled !== haveEnabled) await scope.set("enabled", wantEnabled);
					const wantMode = mode.trim() || "append";
					const haveMode = (snap.value && snap.value.mode) || "append";
					if (wantMode !== haveMode) await scope.set("mode", wantMode);
					const wantText = text.trim();
					const haveText = (snap.value && snap.value.text) || "";
					if (wantText !== haveText) await scope.set("text", wantText);
					setSaved(true);
				} finally {
					setBusy(false);
				}
			};

			const loadPreview = async () => {
				setPreviewLoading(true);
				setPreviewError("");
				setPreviewText("");
				try {
					const resp = await fetch("/api/dsh-prompt-custom/preview");
					let data = null;
					try { data = await resp.json(); } catch { data = null; }
					if (!resp.ok || !data || data.ok === false) {
						setPreviewError((data && data.message) || (L.previewError + "（HTTP " + resp.status + "）"));
						return;
					}
					setPreviewText(typeof data.text === "string" ? data.text : "");
					if (data.message) setPreviewError(data.message);
				} catch (error) {
					setPreviewError(L.previewError + "：" + String((error && error.message) || error));
				} finally {
					setPreviewLoading(false);
				}
			};

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 12 },
				children: [
					fieldRow(L.enabledLabel, L.enabledHint, jsx("input", {
						type: "checkbox",
						checked: enabled,
						onChange: (e) => setEnabled(e.target.checked)
					})),
					fieldRow(L.modeLabel, null, jsx("select", {
						value: mode,
						style: { padding: "4px 8px" },
						onChange: (e) => setMode(e.target.value),
						children: [
							jsx("option", { value: "append", children: L.modeAppend }),
							jsx("option", { value: "replace", children: L.modeReplace })
						]
					})),
					fieldRow(L.textLabel, L.textHint, jsx("textarea", {
						value: text,
						rows: 8,
						placeholder: L.textPlaceholder,
						style: { width: "100%", fontFamily: "inherit", padding: "6px 8px", boxSizing: "border-box" },
						onChange: (e) => setText(e.target.value)
					})),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: 8 },
						children: [
							jsx(Button, {
								variant: "outline",
								size: "sm",
								disabled: previewLoading,
								onClick: loadPreview,
								children: previewLoading ? L.previewLoading : L.preview
							}),
							jsx(Button, {
								variant: "primary",
								size: "sm",
								disabled: busy || !snap.writable,
								onClick: save,
								children: busy ? L.saving : L.save
							}),
							saved ? jsx("span", { children: L.saved }) : null
						]
					}),
					previewError ? jsx("div", {
						style: { fontSize: 12, opacity: 0.75 },
						children: previewError
					}) : null,
					previewText ? jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: 4 },
						children: [
							jsx("span", { children: L.previewHint }),
							jsx("textarea", {
								value: previewText,
								readOnly: true,
								rows: 12,
								style: {
									width: "100%",
									fontFamily: "monospace, inherit",
									fontSize: 12,
									padding: "6px 8px",
									boxSizing: "border-box",
									resize: "vertical"
								}
							})
						]
					}) : null
				]
			});
		}

		function PromptCustomCard(props) {
			const { useScope, scope } = props;
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 16, padding: 16, maxWidth: 560 },
				children: [
					jsx("h2", { children: L.navSub }),
					jsx(SettingsBlock, { useScope, scope })
				]
			});
		}

		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: NS });
			const useScope = bindSnapshotSelector(scope);
			const injected = () => ({ useScope, scope });
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-prompt",
				order: 60,
				label: () => L.nav,
				inject: injected
			}, PromptCustomCard), "dsh-prompt-custom: settings section entry");
		}

		const inject = ["slots", "settingsScope"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
