window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-plugin-marketplace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region marketplace css
		const css = ".pm_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}.pm_search{display:flex;align-items:center;gap:8px}.pm_search input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:36px;flex:1;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 12px;font-size:13px}.pm_search input::placeholder{color:var(--dsw-alias-label-tertiary)}.pm_search input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}.pm_searchBtn{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:var(--dsw-alias-bg-layer-3);border-radius:8px;height:36px;padding:0 14px;font-size:13px}.pm_searchBtn:hover{border-color:var(--dsw-alias-label-dimmed)}.pm_searchBtn:disabled{opacity:.5;cursor:default}.pm_catalogHeading{display:flex;align-items:baseline;gap:7px;padding:0 2px;margin:0}.pm_catalogHeading h3{margin:0;font-size:13px;font-weight:600;line-height:20px}.pm_catalogHeading span{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px}.pm_status{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.pm_notice{margin:0;font-size:13px;line-height:20px}.pm_notice[data-kind=error]{color:var(--dsw-alias-state-error-primary)}.pm_notice[data-kind=success]{color:var(--dsw-alias-state-success-primary)}.pm_failure{color:var(--dsw-alias-state-error-primary);display:flex;align-items:center;gap:10px;margin:0;font-size:13px;line-height:20px}.pm_failure p{margin:0;flex:1;min-width:0}.pm_failure button{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:6px;padding:4px 10px}.pm_restart{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;display:flex;align-items:center;gap:10px;padding:10px 14px;font-size:13px}.pm_restart span{flex:1;color:var(--dsw-alias-label-secondary)}.pm_restart button{border:1px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);font:inherit;cursor:pointer;background:0 0;border-radius:8px;padding:5px 12px;font-size:13px}.pm_cards{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px;margin:0;padding:0;list-style:none;display:grid}.pm_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;min-width:0;padding:12px 14px;flex-direction:column;gap:6px;display:flex}.pm_card:hover{border-color:var(--dsw-alias-label-dimmed)}.pm_cardHead{justify-content:space-between;align-items:flex-start;gap:8px;display:flex}.pm_cardTitleWrap{flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0;display:flex}.pm_cardName{font-size:13px;font-weight:600;line-height:18px;overflow-wrap:anywhere}.pm_cardVersion{color:var(--dsw-alias-label-tertiary);font-size:11px}.pm_installedBadge{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap}.pm_cardDesc{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.pm_cardMeta{align-items:center;gap:10px;margin-top:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex}.pm_cardMeta a{color:var(--dsw-alias-state-business-primary);text-decoration:none}.pm_installBtn,.pm_dangerBtn{border:1px solid var(--dsw-alias-border-l2);font:inherit;cursor:pointer;border-radius:8px;padding:4px 12px;font-size:12px;line-height:18px;white-space:nowrap;background:0 0}.pm_installBtn{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pm_installBtn:hover{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)}.pm_dangerBtn{color:var(--dsw-alias-label-secondary)}.pm_dangerBtn:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.pm_installBtn:disabled,.pm_dangerBtn:disabled{opacity:.5;cursor:default}.pm_installedList{margin:0;padding:0;list-style:none;flex-direction:column;gap:8px;display:flex}.pm_installedRow{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;align-items:center;gap:10px;padding:10px 14px;display:flex}.pm_installedInfo{flex:1;min-width:0;flex-direction:column;gap:2px;display:flex}.pm_installedName{font-size:13px;font-weight:600;line-height:18px;overflow-wrap:anywhere}.pm_installedMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.pm_visuallyHidden{width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;position:absolute}";
		const tagId = "@deepseek-ai/dsh-plugin-marketplace/marketplace.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-plugin-marketplace";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const s = {
			section: "pm_section", search: "pm_search", searchBtn: "pm_searchBtn",
			catalogHeading: "pm_catalogHeading", status: "pm_status", notice: "pm_notice",
			failure: "pm_failure", restart: "pm_restart", cards: "pm_cards", card: "pm_card",
			cardHead: "pm_cardHead", cardTitleWrap: "pm_cardTitleWrap", cardName: "pm_cardName",
			cardVersion: "pm_cardVersion", installedBadge: "pm_installedBadge", cardDesc: "pm_cardDesc",
			cardMeta: "pm_cardMeta", installBtn: "pm_installBtn", dangerBtn: "pm_dangerBtn",
			installedList: "pm_installedList", installedRow: "pm_installedRow", installedInfo: "pm_installedInfo",
			installedName: "pm_installedName", installedMeta: "pm_installedMeta", visuallyHidden: "pm_visuallyHidden"
		};
		//#endregion
		//#region locales
		const zh = {
			tab: "插件市场",
			search: "搜索插件",
			searchPlaceholder: "搜索 npm 上的 dsh 插件（关键词 dsh-plugin）…",
			searchButton: "搜索",
			searching: "正在搜索 npm 插件…",
			searchFailed: "搜索失败：",
			retry: "重试",
			catalog: "插件市场",
			empty: "没有匹配的插件。",
			install: "安装",
			installing: "安装中…",
			uninstall: "卸载",
			uninstalling: "卸载中…",
			installedTag: "已安装",
			installedTitle: "已安装的插件",
			installedEmpty: "还没有从市场安装过插件。安装后重启服务即可生效。",
			active: "已加入激活层",
			installDone: "安装成功：",
			installFailed: "安装失败：",
			uninstallDone: "已卸载：",
			uninstallFailed: "卸载失败：",
			restartHint: "新插件将在服务重启后生效。",
			restartConfirm: "重启会中断当前正在运行的会话（历史记录保留）。确定现在重启服务吗？",
			restartNow: "立即重启服务",
			openNpm: "npm",
			loadingInstalled: "正在读取已安装插件…",
			updateTab: "更新",
			update: "更新",
			updating: "更新中…",
			updateDone: "已更新：",
			updateFailed: "更新失败：",
			updateAll: "全部更新",
			upToDate: "已是最新",
			updateAvailableBadge: "可更新",
			updatesEmpty: "没有可更新的插件",
			updatesBuiltin: "内置插件",
			updatesMarket: "市场插件",
			updatesHint: "内置插件随应用分发（版本固定），可从 npm / GitHub 上游直接更新；市场插件由 npm 安装。更新后重启服务生效。",
			checkUpdates: "检查更新",
			checkingUpdates: "正在检查更新…",
			autoUpdateLabel: "内置插件自动更新",
			autoUpdateHint: "默认关闭：只检测并提示；开启后自动下载新版本，重启服务生效。",
			updateAllDone: "已全部更新",
			updatePartDone: "部分更新完成",
			noAutoUpdateBridge: "自动更新开关不可用（桌面桥接缺失）",
			autoUpdateOn: "内置插件自动更新已开启",
			autoUpdateOff: "内置插件自动更新已关闭",
			updateSkipped: "已跳过此版本"
		};
		const en = {
			tab: "Marketplace",
			search: "Search plugins",
			searchPlaceholder: "Search dsh plugins on npm (keyword dsh-plugin)…",
			searchButton: "Search",
			searching: "Searching npm…",
			searchFailed: "Search failed: ",
			retry: "Retry",
			catalog: "Marketplace",
			empty: "No matching plugins.",
			install: "Install",
			installing: "Installing…",
			uninstall: "Uninstall",
			uninstalling: "Uninstalling…",
			installedTag: "Installed",
			installedTitle: "Installed plugins",
			installedEmpty: "Nothing installed from the marketplace yet. Plugins activate after a service restart.",
			active: "in activation layer",
			installDone: "Installed: ",
			installFailed: "Install failed: ",
			uninstallDone: "Uninstalled: ",
			uninstallFailed: "Uninstall failed: ",
			restartHint: "New plugins take effect after the service restarts.",
			restartConfirm: "Restarting interrupts the running session (history is kept). Restart the service now?",
			restartNow: "Restart service now",
			openNpm: "npm",
			loadingInstalled: "Reading installed plugins…",
			updateTab: "Updates",
			update: "Update",
			updating: "Updating…",
			updateDone: "Updated: ",
			updateFailed: "Update failed: ",
			updateAll: "Update all",
			upToDate: "Up to date",
			updateAvailableBadge: "update available",
			updatesEmpty: "No plugins with updates.",
			updatesBuiltin: "Built-in plugins",
			updatesMarket: "Marketplace plugins",
			updatesHint: "Built-in plugins ship with the app (pinned versions) and can be updated straight from their npm / GitHub upstream; marketplace plugins are npm-installed. Updates take effect after a service restart.",
			checkUpdates: "Check for updates",
			checkingUpdates: "Checking for updates…",
			autoUpdateLabel: "Auto-update built-in plugins",
			autoUpdateHint: "Off by default: only detect and notify; when enabled, new versions download automatically and apply after a service restart.",
			updateAllDone: "All plugins updated",
			updatePartDone: "Some plugins updated",
			noAutoUpdateBridge: "Auto-update toggle unavailable (desktop bridge missing)",
			autoUpdateOn: "Auto-update of built-in plugins enabled",
			autoUpdateOff: "Auto-update of built-in plugins disabled",
			updateSkipped: "version skipped"
		};
		const NS = "settings.pluginMarketplace";
		//#endregion
		//#region remote face
		const looseCodec = () => ({
			mode: "strict",
			typeSymbol: "@deepseek-ai/dsh-plugin-marketplace/types#Json",
			schema: { parse: (value) => value }
		});
		const descriptor = (method, parameters) => ({
			id: `@deepseek-ai/dsh-plugin-marketplace#pluginMarketplace/${method}`,
			service: "pluginMarketplace",
			namespace: "pluginMarketplace",
			method,
			invocation: { kind: "direct" },
			parameters: parameters.map((name) => ({ name, wire: name, source: "json", codec: looseCodec() })),
			result: looseCodec()
		});
		const REMOTE = {
			package: "@deepseek-ai/dsh-plugin-marketplace",
			descriptors: [
				descriptor("search", ["query"]),
				descriptor("installed", []),
				descriptor("installPlugin", ["packageName"]),
				descriptor("uninstallPlugin", ["packageName"]),
				descriptor("updatePlugin", ["packageName"])
			]
		};
		const failureText = (result) => result.error?.message ?? String(result.error ?? "remote failed");
		//#endregion
		//#region components
		/** Live snapshot of the profile's installed plugins. */
		function useInstalled(props) {
			const [state, setState] = react.useState({ status: "loading", plugins: [] });
			const [tick, setTick] = react.useState(0);
			react.useEffect(() => {
				let alive = true;
				props.installed().then((result) => {
					if (!alive) return;
					if (!result.ok) { setState({ status: "error", plugins: [] }); return; }
					setState({ status: "ready", plugins: result.value.plugins ?? [] });
				}, () => { if (alive) setState({ status: "error", plugins: [] }); });
				return () => { alive = false; };
			}, [tick]);
			return { state, refresh: () => setTick((value) => value + 1) };
		}
		/** One search-result card with its install/uninstall action. */
		function ResultCard(props) {
			const t = props.t;
			const item = props.item;
			const installedVersion = item.installed?.version ?? null;
			return (0, react_jsx_runtime.jsxs)("li", {
				className: s.card,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: s.cardHead,
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: s.cardTitleWrap,
								children: [
									(0, react_jsx_runtime.jsx)("strong", {
										className: s.cardName,
										title: item.name,
										children: item.name
									}),
									(0, react_jsx_runtime.jsx)("span", {
										className: s.cardVersion,
										children: "v" + item.version
									}),
									installedVersion !== null ? (0, react_jsx_runtime.jsxs)("span", {
										className: s.installedBadge,
										children: item.installed && item.installed.hasUpdate
											? [t("updateAvailableBadge"), " v", installedVersion, " → v", item.installed.latest ?? ""]
											: [t("installedTag"), " v", installedVersion]
									}) : null
								]
							}),
							installedVersion !== null ? (0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", alignItems: "center", gap: 8, flex: "none" },
								children: [
									item.installed && item.installed.hasUpdate ? (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: s.installBtn,
										disabled: props.busy !== undefined,
										onClick: props.onUpdate,
										children: props.busy === "updating" ? t("updating") : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
											children: [t("update"), " v", item.installed.latest ?? ""]
										})
									}) : null,
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: s.dangerBtn,
										disabled: props.busy !== undefined,
										onClick: props.onUninstall,
										children: props.busy === "uninstalling" ? t("uninstalling") : t("uninstall")
									})
								]
							}) : (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: s.installBtn,
								disabled: props.busy !== undefined,
								onClick: props.onInstall,
								children: props.busy === "installing" ? t("installing") : t("install")
							})
						]
					}),
					item.description ? (0, react_jsx_runtime.jsx)("p", {
						className: s.cardDesc,
						children: item.description
					}) : null,
					(0, react_jsx_runtime.jsxs)("div", {
						className: s.cardMeta,
						children: [
							item.license ? (0, react_jsx_runtime.jsx)("span", { children: item.license }) : null,
							item.date ? (0, react_jsx_runtime.jsx)("span", { children: item.date.slice(0, 10) }) : null,
							item.links?.npm ? (0, react_jsx_runtime.jsx)("a", {
								href: item.links.npm,
								target: "_blank",
								rel: "noreferrer noopener",
								children: t("openNpm")
							}) : null
						]
					})
				]
			});
		}
		/** The marketplace tab: npm search + one-click install, installed list. */
		function MarketplaceTab(props) {
			const t = props.t;
			const [query, setQuery] = react.useState("");
			const [catalog, setCatalog] = react.useState({ status: "idle", results: [], error: "" });
			const [busy, setBusy] = react.useState({});
			const [notice, setNotice] = react.useState(null);
			const [restart, setRestart] = react.useState({ needed: false, available: false });
			const installed = useInstalled(props);
			const runRef = react.useRef(0);
			react.useEffect(() => {
				// 只探测桥接是否存在,绝不触发真正的重启。
				const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
				setRestart((current) => ({ ...current, available: bridge !== undefined && typeof bridge.restartService === "function" }));
			}, []);
			const search = react.useCallback((text) => {
				const run = ++runRef.current;
				setCatalog({ status: "loading", results: [], error: "" });
				props.search(text).then((result) => {
					if (run !== runRef.current) return;
					if (!result.ok) { setCatalog({ status: "error", results: [], error: failureText(result) }); return; }
					setCatalog({ status: "ready", results: result.value.results ?? [], error: "" });
				}, (error) => {
					if (run === runRef.current) setCatalog({ status: "error", results: [], error: String(error?.message ?? error) });
				});
			}, []);
			react.useEffect(() => { search(""); }, [search]);
			const run = (name, verb, call, successPrefix, failPrefix) => {
				setBusy((current) => ({ ...current, [name]: verb }));
				setNotice(null);
				call(name).then((result) => {
					setBusy((current) => { const next = { ...current }; delete next[name]; return next; });
					if (!result.ok) { setNotice({ kind: "error", text: failPrefix + failureText(result) }); return; }
					setNotice({ kind: "success", text: successPrefix + name + (result.value.version ? " v" + result.value.version : "") });
					// 只有需要重启的变更才亮起重启提示条（noop 更新不打扰）。
					if (result.value && (result.value.restartRequired || result.value.needsRestart)) {
						setRestart((current) => ({ ...current, needed: true }));
					}
					installed.refresh();
					search(query);
				}, (error) => {
					setBusy((current) => { const next = { ...current }; delete next[name]; return next; });
					setNotice({ kind: "error", text: failPrefix + String(error?.message ?? error) });
				});
			};
			const doInstall = (name) => run(name, "installing", props.install, t("installDone"), t("installFailed"));
			const doUninstall = (name) => run(name, "uninstalling", props.uninstall, t("uninstallDone"), t("uninstallFailed"));
			const doUpdate = (name) => run(name, "updating", props.update, t("updateDone"), t("updateFailed"));
			const requestRestart = () => {
				if (typeof window !== "undefined" && window.confirm(t("restartConfirm"))) props.restartService().catch(() => {});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: s.section,
				children: [
					(0, react_jsx_runtime.jsxs)("label", {
						className: s.search,
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: s.visuallyHidden,
								children: t("search")
							}),
							(0, react_jsx_runtime.jsx)("input", {
								type: "search",
								value: query,
								placeholder: t("searchPlaceholder"),
								"aria-label": t("search"),
								onChange: (event) => setQuery(event.currentTarget.value),
								onKeyDown: (event) => { if (event.key === "Enter") search(event.currentTarget.value); }
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: s.searchBtn,
								disabled: catalog.status === "loading",
								onClick: () => search(query),
								children: t("searchButton")
							})
						]
					}),
					notice !== null ? (0, react_jsx_runtime.jsx)("p", {
						className: s.notice,
						"data-kind": notice.kind,
						role: "status",
						children: notice.text
					}) : null,
					restart.needed ? (0, react_jsx_runtime.jsxs)("div", {
						className: s.restart,
						role: "status",
						children: [
							(0, react_jsx_runtime.jsx)("span", { children: t("restartHint") }),
							restart.available ? (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: requestRestart,
								children: t("restartNow")
							}) : null
						]
					}) : null,
					(0, react_jsx_runtime.jsxs)("div", {
						className: s.catalogHeading,
						children: [
							(0, react_jsx_runtime.jsx)("h3", { children: t("catalog") }),
							(0, react_jsx_runtime.jsx)("span", { children: catalog.status === "ready" ? catalog.results.length : "…" })
						]
					}),
					catalog.status === "loading" ? (0, react_jsx_runtime.jsx)("p", {
						className: s.status,
						children: t("searching")
					}) : null,
					catalog.status === "error" ? (0, react_jsx_runtime.jsxs)("div", {
						className: s.failure,
						role: "alert",
						children: [
							(0, react_jsx_runtime.jsx)("p", { children: t("searchFailed") + catalog.error }),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => search(query),
								children: t("retry")
							})
						]
					}) : null,
					catalog.status === "ready" && catalog.results.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: s.status,
						children: t("empty")
					}) : null,
					catalog.status === "ready" && catalog.results.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
						className: s.cards,
						children: catalog.results.map((item) => (0, react_jsx_runtime.jsx)(ResultCard, {
							t,
							item,
							busy: busy[item.name],
							onInstall: () => doInstall(item.name),
							onUninstall: () => doUninstall(item.name),
							onUpdate: () => doUpdate(item.name)
						}, item.name))
					}) : null,
					(0, react_jsx_runtime.jsxs)("div", {
						className: s.catalogHeading,
						children: [
							(0, react_jsx_runtime.jsx)("h3", { children: t("installedTitle") }),
							(0, react_jsx_runtime.jsx)("span", { children: installed.state.status === "ready" ? installed.state.plugins.length : "…" })
						]
					}),
					installed.state.status === "loading" ? (0, react_jsx_runtime.jsx)("p", {
						className: s.status,
						children: t("loadingInstalled")
					}) : null,
					installed.state.status === "ready" && installed.state.plugins.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: s.status,
						children: t("installedEmpty")
					}) : null,
					installed.state.status === "ready" && installed.state.plugins.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
						className: s.installedList,
						children: installed.state.plugins.map((plugin) => (0, react_jsx_runtime.jsxs)("li", {
							className: s.installedRow,
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: s.installedInfo,
									children: [
										(0, react_jsx_runtime.jsx)("span", {
											className: s.installedName,
											children: plugin.name
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: s.installedMeta,
											children: "v" + plugin.version + (plugin.hasUpdate ? " → v" + (plugin.latest ?? "") : "") + (plugin.isBundle ? " · bundle" : "") + (plugin.isClient ? " · client" : "") + (plugin.inBundles ? " · " + t("active") : "")
										})
									]
								}),
								plugin.hasUpdate ? (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: s.installBtn,
									disabled: busy[plugin.name] !== undefined,
									onClick: () => doUpdate(plugin.name),
									children: busy[plugin.name] === "updating" ? t("updating") : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
										children: [t("update"), " v", plugin.latest ?? ""]
									})
								}) : null,
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: s.dangerBtn,
									disabled: busy[plugin.name] !== undefined,
									onClick: () => doUninstall(plugin.name),
									children: busy[plugin.name] === "uninstalling" ? t("uninstalling") : t("uninstall")
								})
							]
						}, plugin.name))
					}) : null
				]
			});
		}
		//#endregion
		/**
		 * 「更新」标签（V4.3）：聚合两类插件的上游更新 ——
		 *   内置插件：桌面端 IPC（dshDesktop.pluginUpdates，npm/GitHub 上游）；
		 *   市场插件：npm registry 最新版（Remote installed() 已带 hasUpdate）。
		 * 更新动作全在主进程/Remote 完成，这里只负责展示与触发。
		 */
		function UpdatesTab(props) {
			const t = props.t;
			const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
			const [builtin, setBuiltin] = react.useState({ status: "idle", list: [], autoUpdate: false, checkedAt: null, error: "" });
			const [market, setMarket] = react.useState({ status: "idle", list: [], error: "" });
			const [busy, setBusy] = react.useState({});
			const [notice, setNotice] = react.useState(null);
			const [restart, setRestart] = react.useState({ needed: false, available: false });
			const runRef = react.useRef(0);
			react.useEffect(() => {
				setRestart((current) => ({ ...current, available: bridge !== undefined && typeof bridge.restartService === "function" }));
			}, []);
			const refresh = react.useCallback((force) => {
				const run = ++runRef.current;
				if (bridge !== undefined && typeof bridge.pluginUpdates === "object") {
					setBuiltin((current) => ({ ...current, status: "loading", error: "" }));
					bridge.pluginUpdates.list(!!force).then((res) => {
						if (run !== runRef.current) return;
						if (res === null || res === undefined) {
							setBuiltin({ status: "error", list: [], autoUpdate: false, checkedAt: null, error: t("noAutoUpdateBridge") });
							return;
						}
						setBuiltin({ status: "ready", list: res.list ?? [], autoUpdate: !!res.autoUpdate, checkedAt: res.checkedAt ?? null, error: res.error ?? "" });
					}, (error) => {
						if (run === runRef.current) setBuiltin({ status: "error", list: [], autoUpdate: false, checkedAt: null, error: String(error?.message ?? error) });
					});
				} else {
					setBuiltin({ status: "unavailable", list: [], autoUpdate: false, checkedAt: null, error: "" });
				}
				setMarket((current) => ({ ...current, status: "loading", error: "" }));
				props.installed().then((result) => {
					if (run !== runRef.current) return;
					if (!result.ok) { setMarket({ status: "error", list: [], error: failureText(result) }); return; }
					setMarket({ status: "ready", list: (result.value.plugins ?? []).filter((p) => p.hasUpdate), error: "" });
				}, (error) => {
					if (run === runRef.current) setMarket({ status: "error", list: [], error: String(error?.message ?? error) });
				});
			}, [props]);
			react.useEffect(() => { refresh(false); }, [refresh]);
			const run = (key, verb, call, successPrefix, failPrefix) => {
				setBusy((current) => ({ ...current, [key]: verb }));
				setNotice(null);
				call().then((result) => {
					setBusy((current) => { const next = { ...current }; delete next[key]; return next; });
					if (!result.ok) { setNotice({ kind: "error", text: failPrefix + failureText(result) }); return; }
					setNotice({ kind: "success", text: successPrefix + (result.version ? " v" + result.version : "") });
					if (result.restartRequired) setRestart((current) => ({ ...current, needed: true }));
					refresh(false);
				}, (error) => {
					setBusy((current) => { const next = { ...current }; delete next[key]; return next; });
					setNotice({ kind: "error", text: failPrefix + String(error?.message ?? error) });
				});
			};
			const updatable = [
				...builtin.list.filter((x) => x.hasUpdate).map((x) => ({
					kind: "builtin",
					key: "builtin:" + x.id,
					name: x.name,
					current: x.current,
					latest: x.latest,
					skipped: !!x.skipped,
					call: () => props.updateBuiltin(x.id)
				})),
				...market.list.map((p) => ({
					kind: "market",
					key: "market:" + p.name,
					name: p.name,
					current: p.version,
					latest: p.latest,
					skipped: false,
					call: () => props.update(p.name)
				}))
			];
			const updateAll = () => {
				for (const item of updatable) if (!item.skipped) run(item.key, "updating", item.call, t("updateDone"), t("updateFailed"));
			};
			const toggleAuto = (enabled) => {
				if (bridge === undefined || typeof bridge.pluginUpdates !== "object") { setNotice({ kind: "error", text: t("noAutoUpdateBridge") }); return; }
				bridge.pluginUpdates.setAutoUpdate(enabled).then((res) => {
					if (res && res.ok) {
						setBuiltin((current) => ({ ...current, autoUpdate: enabled }));
						setNotice({ kind: "success", text: enabled ? t("autoUpdateOn") : t("autoUpdateOff") });
					} else {
						setNotice({ kind: "error", text: t("noAutoUpdateBridge") });
					}
				}, () => setNotice({ kind: "error", text: t("noAutoUpdateBridge") }));
			};
			const requestRestart = () => {
				if (typeof window !== "undefined" && window.confirm(t("restartConfirm"))) props.restartService().catch(() => {});
			};
			const checking = builtin.status === "loading" || market.status === "loading";
			return (0, react_jsx_runtime.jsxs)("div", {
				className: s.section,
				children: [
					notice !== null ? (0, react_jsx_runtime.jsxs)("div", {
						className: notice.kind === "success" ? s.success : s.failure,
						role: "status",
						children: [notice.text, (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: s.dangerBtn,
							onClick: () => setNotice(null),
							children: "×"
						})]
					}) : null,
					restart.needed ? (0, react_jsx_runtime.jsxs)("div", {
						className: s.restart,
						role: "status",
						children: [
							(0, react_jsx_runtime.jsx)("span", { children: t("restartHint") }),
							restart.available ? (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: requestRestart,
								children: t("restartNow")
							}) : null
						]
					}) : null,
					(0, react_jsx_runtime.jsx)("p", { className: s.installedMeta, children: t("updatesHint") }),
					(0, react_jsx_runtime.jsxs)("div", {
						className: s.catalogHeading,
						children: [
							(0, react_jsx_runtime.jsx)("h3", { children: t("updateTab") }),
							(0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", gap: 8, alignItems: "center", flex: "none" },
								children: [
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: s.installBtn,
										disabled: checking,
										onClick: () => refresh(true),
										children: checking ? t("checkingUpdates") : t("checkUpdates")
									}),
									updatable.length > 0 ? (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: s.installBtn,
										disabled: checking || updatable.every((x) => x.skipped),
										onClick: updateAll,
										children: t("updateAll")
									}) : null
								]
							})
						]
					}),
					bridge !== undefined && typeof bridge.pluginUpdates === "object" ? (0, react_jsx_runtime.jsxs)("label", {
						className: s.search,
						style: { display: "flex", alignItems: "center", gap: 8 },
						children: [
							(0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: builtin.autoUpdate,
								onChange: (event) => toggleAuto(event.target.checked)
							}),
							(0, react_jsx_runtime.jsx)("span", { children: t("autoUpdateLabel") }),
							(0, react_jsx_runtime.jsx)("span", { className: s.installedMeta, children: t("autoUpdateHint") })
						]
					}) : null,
					builtin.status === "error" ? (0, react_jsx_runtime.jsxs)("div", {
						className: s.failure,
						role: "alert",
						children: [
							(0, react_jsx_runtime.jsx)("p", { children: t("updateFailed") + builtin.error }),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => refresh(true),
								children: t("retry")
							})
						]
					}) : null,
					market.status === "error" ? (0, react_jsx_runtime.jsx)("p", {
						className: s.status,
						children: t("updateFailed") + market.error
					}) : null,
					builtin.list.length > 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: s.catalogHeading,
						children: [
							(0, react_jsx_runtime.jsx)("h3", { children: t("updatesBuiltin") }),
							(0, react_jsx_runtime.jsx)("span", { children: builtin.list.length })
						]
					}) : null,
					builtin.list.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
						className: s.installedList,
						children: builtin.list.map((plugin) => (0, react_jsx_runtime.jsxs)("li", {
							className: s.installedRow,
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: s.installedInfo,
									children: [
										(0, react_jsx_runtime.jsx)("span", {
											className: s.installedName,
											children: plugin.name
										}),
										(0, react_jsx_runtime.jsxs)("span", {
											className: s.installedMeta,
											children: ["v", plugin.current ?? "?", " → v", plugin.latest ?? "?", plugin.skipped ? " · " + t("updateSkipped") : ""]
										})
									]
								}),
								plugin.skipped ? null : (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: s.installBtn,
									disabled: busy["builtin:" + plugin.id] !== undefined,
									onClick: () => run("builtin:" + plugin.id, "updating", () => props.updateBuiltin(plugin.id), t("updateDone"), t("updateFailed")),
									children: busy["builtin:" + plugin.id] === "updating" ? t("updating") : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
										children: [t("update"), " v", plugin.latest ?? ""]
									})
								})
							]
						}, plugin.id))
					}) : null,
					market.list.length > 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: s.catalogHeading,
						children: [
							(0, react_jsx_runtime.jsx)("h3", { children: t("updatesMarket") }),
							(0, react_jsx_runtime.jsx)("span", { children: market.list.length })
						]
					}) : null,
					market.list.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
						className: s.installedList,
						children: market.list.map((plugin) => (0, react_jsx_runtime.jsxs)("li", {
							className: s.installedRow,
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: s.installedInfo,
									children: [
										(0, react_jsx_runtime.jsx)("span", {
											className: s.installedName,
											children: plugin.name
										}),
										(0, react_jsx_runtime.jsxs)("span", {
											className: s.installedMeta,
											children: ["v", plugin.version, " → v", plugin.latest ?? ""]
										})
									]
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: s.installBtn,
									disabled: busy[plugin.name] !== undefined,
									onClick: () => run("market:" + plugin.name, "updating", () => props.update(plugin.name), t("updateDone"), t("updateFailed")),
									children: busy[plugin.name] === "updating" ? t("updating") : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
										children: [t("update"), " v", plugin.latest ?? ""]
									})
								})
							]
						}, plugin.name))
					}) : null,
					checking ? (0, react_jsx_runtime.jsx)("p", {
						className: s.status,
						children: t("checkingUpdates")
					}) : null,
					!checking && updatable.length === 0 && builtin.status !== "error" && builtin.status !== "unavailable" ? (0, react_jsx_runtime.jsx)("p", {
						className: s.status,
						children: t("updatesEmpty")
					}) : null
				]
			});
		}
		//#region client index
		/** Required browser services. */
		const inject = ["slots", "locale", "remote"];
		/**
		 * Mount the marketplace tab into Settings → Plugins. The tab itself is
		 * registered unconditionally; the dynamic Remote face is mounted in the
		 * background and every call resolves it lazily, so a mount problem shows
		 * up as an error banner inside the tab instead of the tab silently
		 * disappearing.
		 * @param ctx - browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-marketplace: dictionaries");
			const t = ctx.locale.bind(NS);
			let mountFailure = null;
			const mountPromise = ctx.remote.$mount(REMOTE).then((dispose) => {
				ctx.effect(() => dispose, "dsh-plugin-marketplace: remote face");
				return true;
			}, (error) => {
				mountFailure = String((error && error.message) || error);
				console.error("dsh-plugin-marketplace: remote face mount failed", error);
				return false;
			});
			/** Resolve the mounted namespace service, waiting for the mount. */
			const remote = async () => {
				await mountPromise;
				if (mountFailure !== null) throw new Error("pluginMarketplace 远程接口未就绪: " + mountFailure);
				const service = ctx.get("remote.pluginMarketplace");
				if (service === void 0 || service === null || typeof service !== "object") {
					// 已挂载但 cordis 服务尚未出现:再等一个微任务重试一次。
					await new Promise((resolve) => setTimeout(resolve, 50));
					const retry = ctx.get("remote.pluginMarketplace");
					if (retry === void 0 || retry === null || typeof retry !== "object") throw new Error("pluginMarketplace 远程接口未注册");
					return retry;
				}
				return service;
			};
			const injected = () => ({
				search: async (query) => (await remote()).search(query),
				installed: async () => (await remote()).installed(),
				install: async (name) => (await remote()).installPlugin(name),
				uninstall: async (name) => (await remote()).uninstallPlugin(name),
				update: async (name) => (await remote()).updatePlugin(name),
				updateBuiltin: (id) => {
					const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
					if (bridge === undefined || typeof bridge.pluginUpdates !== "object") {
						return Promise.resolve({ ok: false, error: "desktop bridge missing (pluginUpdates)" });
					}
					return bridge.pluginUpdates.update(String(id));
				},
				restartService: () => {
					const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
					if (bridge !== undefined && typeof bridge.restartService === "function") return bridge.restartService();
					return Promise.resolve({ available: false });
				}
			});
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "marketplace",
				order: 20,
				label: () => t("tab"),
				locale: NS,
				inject: injected
			}, MarketplaceTab));
			// 「更新」标签（V4.3）：内置插件 + 市场插件更新聚合。
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "updates",
				order: 21,
				label: () => t("updateTab"),
				locale: NS,
				inject: injected
			}, UpdatesTab));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map