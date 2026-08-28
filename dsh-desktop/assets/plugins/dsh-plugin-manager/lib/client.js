window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-plugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");

		const L = {
			tab: "管理",
			tabHint: "搜索插件、点击分类标签过滤；配套/其他插件可一键关闭，「移除」为卸载语义（不再随启动同步），完全退出并重启 DSH Desktop 后生效。",
			searchPlaceholder: "搜索插件（名称 / id / 描述）…",
			viewCompact: "简洁",
			viewDetail: "详情",
			catAll: "全部",
			groupCompanion: "配套插件",
			groupOther: "其他插件",
			groupCore: "核心组件",
			groupToggleableNote: "可开关",
			groupReadonlyNote: "不可关闭",
			descFallback: "（无描述）",
			badgeEnabled: "已启用",
			badgeDisabled: "已关闭",
			badgeRemoved: "已移除",
			badgePending: "重启后生效",
			badgeFailed: "挂载失败",
			badgePendingLoad: "加载中",
			remove: "移除",
			restore: "恢复",
			removeHint: "移除后不再随启动同步（下次启动不还原）",
			loading: "加载中…",
			errorPrefix: "插件清单加载失败：",
			noBridge: "插件管理桥接不可用（请确认已更新到最新版 DSH Desktop）",
			toastFailed: "操作失败：",
			refresh: "刷新",
			noMatch: "没有匹配的插件",
			localOnlyHint: "（清单来自本地文件，实时注册表暂不可用）",
			countSuffix: "个插件"
		};

		function bridge() {
			const b = window.dshDesktop;
			if (!b || !b.pluginManager || typeof b.pluginManager.list !== "function") return null;
			return b.pluginManager;
		}

		const badge = (text, color) => jsx("span", {
			style: { fontSize: 11, padding: "1px 8px", borderRadius: 8, border: "1px solid currentColor", color, marginLeft: 6, whiteSpace: "nowrap" },
			children: text
		});

		// 简洁视图卡片网格的窄屏适配（与官方清单页同款：≤680px 收成单列）。
		const PM_CSS_ID = "@deepseek-ai/dsh-plugin-manager/compact-grid.css";
		if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"" + PM_CSS_ID + "\"]")) {
			const st = document.createElement("style");
			st.dataset.plugin = "@deepseek-ai/dsh-plugin-manager";
			st.dataset.pluginCss = PM_CSS_ID;
			st.textContent = "@media (width <= 680px){.dshpm-cards{grid-template-columns:minmax(0,1fr) !important}}";
			document.head.appendChild(st);
		}

		/** 包名短名（去掉 @scope/ 前缀，如 @deepseek-ai/dsh-balance → dsh-balance）。 */
		const pkgShort = (name) => {
			const s = String(name || "");
			const i = s.indexOf("/");
			return i >= 0 ? s.slice(i + 1) : s;
		};

		/** 迷你开关（简洁视图卡片用）。 */
		const switchControl = (row, on, onToggle, pending) => {
			const disabled = !row.toggleable || pending;
			return jsx("button", {
				type: "button",
				role: "switch",
				"aria-checked": on,
				"aria-label": row.id,
				disabled,
				onClick: () => onToggle(row, !on),
				style: {
					position: "relative",
					width: 32,
					height: 18,
					borderRadius: 999,
					border: "1px solid " + (on ? "var(--dsw-alias-state-success-primary, #4caf7d)" : "var(--dsw-alias-border-l2, rgba(128,128,128,0.35))"),
					background: on ? "color-mix(in srgb, var(--dsw-alias-state-success-primary, #4caf7d) 30%, transparent)" : "transparent",
					cursor: row.toggleable ? "pointer" : "not-allowed",
					flex: "none",
					padding: 0,
					opacity: disabled ? 0.55 : 1
				},
				children: jsx("span", {
					style: {
						position: "absolute",
						top: 2,
						left: on ? 18 : 2,
						width: 12,
						height: 12,
						borderRadius: 999,
						background: on ? "var(--dsw-alias-state-success-primary, #4caf7d)" : "var(--dsw-alias-label-tertiary, rgba(128,128,128,0.6))",
						transition: "left .14s var(--ds-ease-in-out, ease)"
					}
				})
			});
		};

		/** 归一化 live 注册表返回：可能 {ok,value} / {entries} / 数组。 */
		function normalizeLive(result) {
			if (Array.isArray(result)) return result;
			if (result && Array.isArray(result.entries)) return result.entries;
			if (result && result.ok && Array.isArray(result.value)) return result.value;
			if (result && result.ok && result.value && Array.isArray(result.value.entries)) return result.value.entries;
			return null;
		}

		function PluginManagerTab({ list }) {
			const [rows, setRows] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [localOnly, setLocalOnly] = react.useState(false);
			const [pendingId, setPendingId] = react.useState(null);
			// 乐观 UI：点击立即反映到勾选框与「重启后生效」标记（id → 期望值）
			const [pendingMap, setPendingMap] = react.useState({});
			const [query, setQuery] = react.useState("");
			const [view, setView] = react.useState("detail"); // compact | detail
			const [cat, setCat] = react.useState("all"); // all | companion | other | core
			const [refreshTick, setRefreshTick] = react.useState(0);

			react.useEffect(() => {
				let cancelled = false;
				(async () => {
					setError(null);
					// 1) 本地桥：完整（配套/用户/核心 bundle）+ 描述 + 可开关集合 —— 主数据源
					const b = bridge();
					let mine = [];
					if (b && typeof b.list === "function") {
						try {
							const data = await b.list();
							if (Array.isArray(data)) mine = data;
						} catch (err) {
							console.error("[dsh-plugin-manager] 本地桥 list 失败:", err);
						}
					}
					// 2) live 注册表：尽力补充（核心组件全集），失败不阻塞
					let live = [];
					let liveOk = false;
					try {
						const raw = await list();
						const entries = normalizeLive(raw);
						if (entries) { live = entries; liveOk = true; }
						else console.warn("[dsh-plugin-manager] live list 返回异常形状:", raw);
					} catch (err) {
						console.warn("[dsh-plugin-manager] live list 失败（降级本地清单）:", err);
					}
					if (cancelled) return;

					const toggleableById = new Map(mine.filter((r) => r && r.toggleable).map((r) => [r.id, r]));
					const descById = new Map(mine.map((r) => [r.id, r.description]));
					const liveIds = new Set(live.filter((e) => e && e.entryId !== void 0).map((e) => e.entryId));
					const byId = new Map();
					for (const r of mine) {
						// live 可用时：本地推导的占位核心行（manifest 包名 ≠ 真实 loader 条目 id，
						// 如 dsh-web-app → web-runtime）不展示，避免与「全部」标签对不上；
						// 可开关行即使当前未加载（如已禁用的 balance）也必须展示，否则无法重新打开。
						if (liveOk && !r.toggleable && !r.removed && !liveIds.has(r.id)) continue;
						if (!byId.has(r.id)) byId.set(r.id, {
							id: r.id,
							title: r.name || r.id,
							enabled: !!r.enabled && !r.removed,
							phase: "",
							description: r.description || "",
							toggleable: !!r.toggleable,
							removable: !!r.removable,
							removed: !!r.removed,
							from: "local"
						});
					}
					for (const e of live) {
						if (!e || typeof e !== "object" || e.entryId === void 0) continue;
						const row = byId.get(e.entryId);
						if (row) {
							row.enabled = row.removed ? false : !!e.enabled;
							row.phase = e.fiberPhase || row.phase;
						} else {
							byId.set(e.entryId, {
								id: e.entryId,
								title: e.moduleName || e.entryId,
								enabled: !!e.enabled,
								phase: e.fiberPhase || "",
								description: descById.get(e.entryId) || "",
								toggleable: toggleableById.has(e.entryId),
								from: "live"
							});
						}
					}
					const mapped = [...byId.values()].sort((a, b) => {
						const ga = a.toggleable ? 0 : 1, gb = b.toggleable ? 0 : 1;
						return ga - gb || a.title.localeCompare(b.title);
					});
					if (!cancelled) {
						setRows(mapped);
						setLocalOnly(!liveOk && mapped.length > 0);
					}
				})();
				return () => { cancelled = true; };
			}, [list, refreshTick]);

			const onToggle = (row, enabled) => {
				const b = bridge();
				if (!b || !row || !row.toggleable) return;
				// 1) 立即反映到 UI（打勾/取消 + 「重启后生效」标记）
				setPendingMap((prev) => ({ ...prev, [row.id]: enabled }));
				setPendingId(row.id);
				// 2) 写盘（失败则回滚 UI 并提示）
				b.setEnabled(row.id, enabled).then((res) => {
					setPendingId(null);
					if (res && res.ok) {
						// pendingMap 保留：重启前一直显示新状态 + 标记
					} else {
						setPendingMap((prev) => {
							const next = { ...prev };
							delete next[row.id];
							return next;
						});
						setError(L.toastFailed + String((res && res.error) || "未知错误"));
					}
				}).catch((err) => {
					setPendingId(null);
					setPendingMap((prev) => {
						const next = { ...prev };
						delete next[row.id];
						return next;
					});
					setError(L.toastFailed + String((err && err.message) || err));
				});
			};

			/** 行当前显示值：有未生效的点击 → 新值；否则实际状态。 */
			const rowValue = (row) => (row.id in pendingMap ? pendingMap[row.id] : row.enabled);
			const rowDirty = (row) => row.id in pendingMap;
			const rowCat = (row) => (row.removed || row.removable ? "companion" : row.toggleable ? (row.id === "llm-deepseek" ? "other" : "companion") : "core");

			/** 移除/恢复（卸载语义）：成功后重拉清单刷新状态。 */
			const onSetRemoved = (row, removed) => {
				const b = bridge();
				if (!b || !row) return;
				setPendingId(row.id);
				b.setRemoved(row.id, removed).then((res) => {
					setPendingId(null);
					if (res && res.ok) {
						setRefreshTick((v) => v + 1);
					} else {
						setError(L.toastFailed + String((res && res.error) || "未知错误"));
					}
				}).catch((err) => {
					setPendingId(null);
					setError(L.toastFailed + String((err && err.message) || err));
				});
			};

			/** 小号文字按钮（移除/恢复用）。 */
			const textBtn = (label, color, onClick, disabled) => jsx("button", {
				type: "button",
				disabled,
				title: L.removeHint,
				onClick,
				style: {
					fontSize: 11,
					padding: "2px 10px",
					borderRadius: 8,
					cursor: disabled ? "not-allowed" : "pointer",
					border: "1px solid " + color,
					color,
					background: "transparent",
					flex: "none",
					opacity: disabled ? 0.55 : 1
				},
				children: label
			});

			const matches = (row) => {
				if (!query) return true;
				const q = query.toLowerCase();
				return (row.title + " " + row.id + " " + row.description).toLowerCase().includes(q);
			};

			const phaseBadge = (row) => {
				if (row.phase === "failed") return badge(L.badgeFailed, "var(--dsw-alias-state-error-primary, #ff7a85)");
				if (row.phase === "loading" || row.phase === "pending") return badge(L.badgePendingLoad, "var(--dsw-alias-state-info-primary, #5b9bd5)");
				return null;
			};

			/** 行显示名：名称（可读 id）+ 包名（moduleName/package）；匿名 id 退化为只显包名。 */
			const rowName = (row) => (/^[0-9a-f]{8}$/i.test(row.id) ? null : row.id);
			const rowPkg = (row) => row.title;
			const usesEnglishUi = () => String(document.documentElement.lang || "").toLowerCase().startsWith("en");
			const rowDescription = (row) => {
				const description = row.description || L.descFallback;
				return usesEnglishUi() && /[\u3400-\u9fff]/u.test(description)
					? "Plugin package: " + rowPkg(row)
					: description;
			};

			/** 简洁视图卡片（官方清单页同款：标题 + 状态圆点 + 开关）。 */
			const renderCompactCard = (row) => {
				const on = rowValue(row);
				const failed = row.phase === "failed";
				const dotColor = failed
					? "var(--dsw-alias-state-error-primary, #ff7a85)"
					: on
						? "var(--dsw-alias-state-success-primary, #4caf7d)"
						: "var(--dsw-alias-label-tertiary, rgba(128,128,128,0.5))";
				const name = rowName(row) || rowPkg(row);
				const short = rowName(row) ? pkgShort(rowPkg(row)) : null;
				return jsxs("div", {
					key: row.id,
					title: rowDescription(row),
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 10,
						minWidth: 0,
						padding: "10px 12px",
						border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
						borderRadius: 10,
						background: "var(--dsw-alias-bg-layer-3, transparent)",
						opacity: on ? 1 : 0.62
					},
					children: [
						jsxs("span", {
							style: { display: "flex", alignItems: "baseline", minWidth: 0, overflow: "hidden" },
							children: [
								jsx("span", { style: { fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: name }),
								short ? jsx("span", { style: { fontSize: 11, opacity: 0.5, marginLeft: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: short }) : null
							]
						}),
						jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" }, children: [
							rowDirty(row) ? badge(L.badgePending, "var(--dsw-alias-state-info-primary, #5b9bd5)") : null,
							row.removed ? badge(L.badgeRemoved, "var(--dsw-alias-state-warning-primary, #d99a3d)") : null,
							jsx("span", { style: { width: 7, height: 7, borderRadius: 999, background: dotColor, flex: "none" } }),
							row.removed
								? textBtn(L.restore, "var(--dsw-alias-state-info-primary, #5b9bd5)", () => onSetRemoved(row, false), pendingId === row.id)
								: switchControl(row, on, onToggle, pendingId === row.id)
						] })
					]
				});
			};

			/** 详情视图行：名称 + 包名 + 状态徽章 + 描述 + 开关。 */
			const renderDetailRow = (row) => jsx("div", {
				key: row.id,
				style: { display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--dsw-alias-divider-weak, rgba(128,128,128,0.16))" },
				children: [
					jsx("div", {
						style: { flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
						children: [
							jsxs("div", { children: [
								jsx("span", { style: { fontWeight: 600 }, children: rowName(row) || rowPkg(row) }),
								jsx("span", { style: { fontSize: 12, opacity: 0.55, marginLeft: 8 }, children: rowPkg(row) }),
								row.removed
									? badge(L.badgeRemoved, "var(--dsw-alias-state-warning-primary, #d99a3d)")
									: rowValue(row)
										? badge(L.badgeEnabled, "var(--dsw-alias-state-success-primary, #4caf7d)")
										: badge(L.badgeDisabled, "var(--dsw-alias-state-warning-primary, #d99a3d)"),
								phaseBadge(row),
								rowDirty(row) ? badge(L.badgePending, "var(--dsw-alias-state-info-primary, #5b9bd5)") : null
							] }),
							jsx("span", { style: { fontSize: 12, opacity: 0.65, lineHeight: 1.5 }, children: rowDescription(row) })
						]
					}),
					row.removed
						? textBtn(L.restore, "var(--dsw-alias-state-info-primary, #5b9bd5)", () => onSetRemoved(row, false), pendingId === row.id)
						: jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" }, children: [
							row.removable
								? textBtn(L.remove, "var(--dsw-alias-state-warning-primary, #d99a3d)", () => onSetRemoved(row, true), pendingId === row.id)
								: null,
							jsx("input", {
								type: "checkbox",
								checked: rowValue(row),
								disabled: !row.toggleable || pendingId === row.id,
								onChange: () => onToggle(row, !rowValue(row)),
								style: { marginTop: 2, cursor: row.toggleable ? "pointer" : "not-allowed" }
							})
						] })
				]
			});

			const renderBody = () => {
				if (error) return jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #ff7a85)", marginTop: 8 }, children: error });
				if (!rows) return jsx("div", { style: { fontSize: 12, opacity: 0.7, marginTop: 8 }, children: L.loading });
				const base = rows.filter(matches);
				if (base.length === 0) return jsx("div", { style: { fontSize: 12, opacity: 0.7, marginTop: 8 }, children: L.noMatch });
				const groups = {
					companion: base.filter((r) => rowCat(r) === "companion"),
					other: base.filter((r) => rowCat(r) === "other"),
					core: base.filter((r) => rowCat(r) === "core")
				};
				const shown = cat === "all" ? base : groups[cat];
				if (shown.length === 0) return jsx("div", { style: { fontSize: 12, opacity: 0.7, marginTop: 8 }, children: L.noMatch });
				const compact = view === "compact";
				const group = (title, note, items) => items.length === 0 ? null : jsxs("div", {
					children: [
						jsxs("div", { style: { fontWeight: 600, fontSize: 13, margin: "14px 0 2px" }, children: [
							jsx("span", { children: title }),
							jsx("span", { style: { fontSize: 12, opacity: 0.55, marginLeft: 8 }, children: note + " · " + items.length }),
							jsx("span", { style: { fontSize: 12, opacity: 0.4, marginLeft: 8 }, children: usesEnglishUi()
								? items.filter((r) => rowValue(r)).length + " enabled / " + items.filter((r) => !rowValue(r)).length + " disabled"
								: items.filter((r) => rowValue(r)).length + " 启用 / " + items.filter((r) => !rowValue(r)).length + " 关闭" })
						] }),
						compact
							? jsx("div", { className: "dshpm-cards", style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginTop: 6 }, children: items.map(renderCompactCard) })
							: items.map(renderDetailRow)
					]
				});
				if (cat !== "all") {
					const meta = { companion: [L.groupCompanion, L.groupToggleableNote], other: [L.groupOther, L.groupToggleableNote], core: [L.groupCore, L.groupReadonlyNote] };
					const [title, note] = meta[cat];
					return group(title, note, shown);
				}
				return jsxs("div", {
					children: [
						group(L.groupCompanion, L.groupToggleableNote, groups.companion),
						group(L.groupOther, L.groupToggleableNote, groups.other),
						group(L.groupCore, L.groupReadonlyNote, groups.core)
					]
				});
			};

			/** 分类标签（可点击过滤）。 */
			const chipStyle = (active) => ({
				fontSize: 12,
				padding: "3px 12px",
				borderRadius: 12,
				border: "1px solid " + (active ? "var(--dsw-alias-state-info-primary, #5b9bd5)" : "var(--dsw-alias-border-l2, rgba(128,128,128,0.35))"),
				background: active ? "color-mix(in srgb, var(--dsw-alias-state-info-primary, #5b9bd5) 12%, transparent)" : "transparent",
				color: active ? "var(--dsw-alias-state-info-primary, #5b9bd5)" : "inherit",
				cursor: "pointer"
			});
			const chip = (key, label, count) => jsx("button", {
				type: "button",
				key: key,
				onClick: () => setCat((c) => (c === key ? "all" : key)),
				style: chipStyle(cat === key),
				children: label + " · " + count
			});

			const renderChips = () => {
				if (!rows) return null;
				const base = rows.filter(matches);
				const n = (k) => base.filter((r) => rowCat(r) === k).length;
				return jsxs("div", { style: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }, children: [
					chip("all", L.catAll, base.length),
					chip("companion", L.groupCompanion, n("companion")),
					chip("other", L.groupOther, n("other")),
					chip("core", L.groupCore, n("core"))
				] });
			};

			return jsxs("div", { children: [
				jsx("span", { style: { fontSize: 12, opacity: 0.65 }, children: L.tabHint }),
				rows ? jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 10 }, children: [
					jsx("input", {
						type: "search",
						placeholder: L.searchPlaceholder,
						value: query,
						onChange: (e) => setQuery(e.target.value),
						style: { flex: 1, maxWidth: 360, fontSize: 13, padding: "5px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))", background: "transparent", color: "inherit" }
					}),
					jsx("span", { style: { fontSize: 12, opacity: 0.6 }, children: rows.length + " " + L.countSuffix }),
					jsxs("div", { style: { display: "flex", gap: 4 }, children: [
						jsx("button", {
							type: "button",
							onClick: () => setView("compact"),
							style: { fontSize: 12, padding: "3px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (view === "compact" ? "var(--dsw-alias-state-info-primary, #5b9bd5)" : "var(--dsw-alias-border-l2, rgba(128,128,128,0.35))"), color: view === "compact" ? "var(--dsw-alias-state-info-primary, #5b9bd5)" : "inherit" },
							children: L.viewCompact
						}),
						jsx("button", {
							type: "button",
							onClick: () => setView("detail"),
							style: { fontSize: 12, padding: "3px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (view === "detail" ? "var(--dsw-alias-state-info-primary, #5b9bd5)" : "var(--dsw-alias-border-l2, rgba(128,128,128,0.35))"), color: view === "detail" ? "var(--dsw-alias-state-info-primary, #5b9bd5)" : "inherit" },
							children: L.viewDetail
						})
					] }),
					jsx("button", {
						type: "button",
						onClick: () => setRefreshTick((v) => v + 1),
						style: { fontSize: 12, cursor: "pointer" },
						children: L.refresh
					})
				] }) : null,
				renderChips(),
				localOnly ? jsx("div", { style: { fontSize: 12, opacity: 0.6, marginTop: 6 }, children: L.localOnlyHint }) : null,
				renderBody()
			] });
		}

		function apply(ctx) {
			const list = async () => {
				const result = await ctx.remote.pluginInventory.list();
				if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`);
				return result.value;
			};
			const injected = () => ({ list });
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "manage",
				order: 20,
				label: () => L.tab,
				inject: injected
			}, PluginManagerTab), "dsh-plugin-manager: plugins management tab");
		}

		const inject = ["slots", "remote", "remote.pluginInventory"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
