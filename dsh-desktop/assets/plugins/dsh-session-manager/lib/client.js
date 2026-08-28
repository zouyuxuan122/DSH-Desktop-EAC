// @dsh-external/dsh-session-manager 客户端半边（DSH Desktop 内置）：
//   1. 设置页「归档对话管理」栏：列出全部已归档会话（标题/项目/更新时间），
//      每条提供「恢复」与「删除」；
//   2. 暴露 window.__dshSessionManager 桥，供官方会话行 ⋯ 菜单补丁
//      （patch-session-manage.js 注入的「删除对话」项）调用。
// 底层 RPC：workspace.unarchiveSession / workspace.deleteSession（由
// patch-session-manage.js 补进 dsh-host-apiproxy 与 dsh-client-connection）；
// 状态更新走官方 host 帧（archived-sessions-changed / session-removed），
// 无需重启、无需手动刷新。
window.__ModuleLoader__.load({
	id: "dsh-session-manager",
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
		const { Button } = require("@deepseek-ai/dsh-client-ui-primitives");

		const NS = "dsh-session-manager";
		const L = {
			nav: "归档对话管理",
			navSub: "管理已归档的对话：可恢复（回到原工作区与顺序）或彻底删除（会话日志与附件一并移除，不可恢复）。删除运行中的会话会被拒绝。",
			empty: "暂无已归档的对话",
			restore: "恢复",
			restoreHint: "把该对话恢复到归档前的位置",
			delete: "删除",
			deleteHint: "彻底删除该对话及其日志（不可恢复）",
			confirmDelete: "确定要彻底删除这个对话吗？会话日志与附件将一并移除，此操作不可恢复。",
			confirmDeleteTitle: "删除对话",
			runningRejected: "该对话正在运行，无法删除：请先停止它再删除",
			ok: "已操作",
			failed: "操作失败",
			unknownSession: "未知会话",
			updatedAt: "更新时间",
			workspace: "项目",
			loading: "加载中…",
			unavailable: "设置不可用（需要在本机浏览器中打开）"
		};

		const CSS = [
			".dsm-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
			".dsm-main{flex:1;min-width:0}",
			".dsm-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsm-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsm-actions{flex:none;display:flex;align-items:center;gap:8px}",
			".dsm-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:12px 0}",
			".dsm-btn{padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:18px}",
			".dsm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsm-btn-danger{color:#c43f50;border-color:color-mix(in srgb,#c43f50 35%,transparent)}",
			".dsm-btn-danger:hover{background:color-mix(in srgb,#c43f50 8%,transparent)}"
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-session-manager/client.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-manager";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------
		// 数据：workspaces.list（含 archivedSessionIds）+ sessions.list（byId 摘要）
		// ------------------------------------------------------------------
		function useStore(store) {
			const [snap, setSnap] = react.useState(() => store.getSnapshot());
			react.useEffect(() => store.subscribe(() => setSnap(store.getSnapshot())), [store]);
			return snap;
		}

		function useArchivedRows(workspaces, sessions) {
			const wsSnap = useStore(workspaces.list);
			const sessSnap = useStore(sessions.list);
			const archived = wsSnap.archivedSessionIds || [];
			const byId = sessSnap.byId || {};
			const wsBySession = new Map();
			for (const item of wsSnap.items || []) {
				for (const id of item.sessionIds || []) if (!wsBySession.has(id)) wsBySession.set(id, item);
			}
			return archived.map((id) => {
				const summary = byId[id];
				const ws = wsBySession.get(id);
				return {
					id,
					title: summary && summary.title ? summary.title : id,
					cwd: summary && summary.cwd ? summary.cwd : "",
					updatedAt: summary && summary.updatedAt ? summary.updatedAt : 0,
					workspaceTitle: ws ? ws.title : ""
				};
			});
		}

		// ------------------------------------------------------------------
		// RPC 封装
		// ------------------------------------------------------------------
		function workspaceApi(context) {
			return context.connection.api.workspace;
		}

		function rpcErrorMessage(result) {
			if (result && result.error) return result.error.message || JSON.stringify(result.error);
			return "unknown error";
		}

		async function unarchiveSession(context, sessionId) {
			try {
				const { result } = await workspaceApi(context).unarchiveSession({ sessionId });
				if (!result.ok) window.alert(L.failed + ": " + rpcErrorMessage(result));
				return result.ok === true;
			} catch (error) {
				window.alert(L.failed + ": " + ((error && error.message) || error));
				return false;
			}
		}

		async function deleteSession(context, sessionId, { confirmText } = {}) {
			if (!window.confirm(confirmText || L.confirmDelete)) return false;
			try {
				const { result } = await workspaceApi(context).deleteSession({ sessionId });
				if (!result.ok) {
					const message = rpcErrorMessage(result);
					window.alert(message && /running|live/.test(message) ? L.runningRejected : L.failed + ": " + message);
					return false;
				}
				return true;
			} catch (error) {
				window.alert(L.failed + ": " + ((error && error.message) || error));
				return false;
			}
		}

		// ------------------------------------------------------------------
		// 设置页面板
		// ------------------------------------------------------------------
		function ArchiveManagerCard(props) {
			const { workspaces, sessions, connection } = props;
			const rows = useArchivedRows(workspaces, sessions);
			const [busy, setBusy] = react.useState(false);
			const fmtTime = (ts) => {
				if (!ts) return "";
				try {
					return new Date(ts).toLocaleString();
				} catch {
					return String(ts);
				}
			};
			const run = async (fn) => {
				if (busy) return;
				setBusy(true);
				try { await fn(); } finally { setBusy(false); }
			};
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 4 },
				children: [
					rows.length === 0 ? jsx("div", { className: "dsm-empty", children: L.empty }) : rows.map((row) => jsxs("div", {
						className: "dsm-row",
						key: row.id,
						children: [
							jsxs("div", {
								className: "dsm-main",
								children: [
									jsx("div", { className: "dsm-title", title: row.title, children: row.title }),
									jsx("div", {
										className: "dsm-meta",
										children: [row.workspaceTitle ? L.workspace + ": " + row.workspaceTitle : "", row.cwd ? " · " + row.cwd : "", row.updatedAt ? " · " + L.updatedAt + ": " + fmtTime(row.updatedAt) : ""].join("")
									})
								]
							}),
							jsxs("div", {
								className: "dsm-actions",
								children: [
									jsx("button", {
										type: "button",
										className: "dsm-btn",
										title: L.restoreHint,
										disabled: busy,
										onClick: () => run(() => unarchiveSession({ connection }, row.id)),
										children: L.restore
									}),
									jsx("button", {
										type: "button",
										className: "dsm-btn dsm-btn-danger",
										title: L.deleteHint,
										disabled: busy,
										onClick: () => run(() => deleteSession({ connection }, row.id)),
										children: L.delete
									})
								]
							})
						]
					}))
				]
			});
		}

		function ArchiveManagerSection(props) {
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 16, padding: 16, maxWidth: 640 },
				children: [
					jsx("h2", { children: L.navSub }),
					jsx(ArchiveManagerCard, props)
				]
			});
		}

		// ------------------------------------------------------------------
		// 插件入口：设置栏 + 行菜单桥
		// ------------------------------------------------------------------
		function apply(ctx) {
			ensureCss();

			// 官方会话行 ⋯ 菜单补丁的「删除对话」入口走这里（含确认与错误提示）。
			window.__dshSessionManager = {
				deleteSession: (sessionId) => deleteSession(ctx, String(sessionId)),
				unarchiveSession: (sessionId) => unarchiveSession(ctx, String(sessionId))
			};

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: NS,
				order: 80,
				label: () => L.nav,
				inject: () => ({ workspaces: ctx.workspaces, sessions: ctx.sessions, connection: ctx.connection })
			}, ArchiveManagerSection), "dsh-session-manager: archived conversations manager");
		}

		exports.apply = apply;
		exports.inject = ["slots", "settingsScope", "workspaces", "sessions", "connection"];
		return module.exports;
	}
});
