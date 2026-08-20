window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-file-changes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/**
		 * 「文件」视图：注册到 conversation.view（与 对话/轨迹 并列的标签页）。
		 *
		 * 两个子视图：
		 *  1. 本会话修改 —— dsh-file-changes 投影（useProjection("fileChanges")），
		 *     即官方已持久化在会话日志里的 tool/result meta.diffs，只读、零侵入。
		 *     文件还原通过 window.dshDesktop.revertFiles(changes) 交给 DSH Desktop
		 *     壳层执行（内容精确匹配后替换，安全可逆）。
		 *  2. 全部文件 —— 项目目录树（VSCode 风格）：宿主插件在 webServer 上提供
		 *     GET /api/dsh-files/list，逐层懒加载；本会话修改过的文件带绿点标记；
		 *     点击文件在壳层中通过系统默认程序打开（window.dshDesktop.openPath）。
		 */

		/** 简单行级 diff：公共前缀/后缀裁剪，中间部分作为变更块。 */
		function lineDiff(oldText, newText) {
			const a = String(oldText || "").split("\n");
			const b = String(newText || "").split("\n");
			let p = 0;
			while (p < a.length && p < b.length && a[p] === b[p]) p++;
			let sa = a.length - 1, sb = b.length - 1;
			while (sa >= p && sb >= p && a[sa] === b[sb]) { sa--; sb--; }
			return {
				contextBefore: a.slice(Math.max(0, p - 3), p),
				removed: a.slice(p, sa + 1),
				added: b.slice(p, sb + 1),
				contextAfter: b.slice(sb + 1, sb + 4)
			};
		}

		const OP_LABEL = { create: "新建", edit: "修改", delete: "删除" };

		function basename(p) {
			const parts = String(p).split(/[\\/]/);
			return parts[parts.length - 1] || p;
		}
		function dirname(p) {
			const idx = Math.max(String(p).lastIndexOf("\\"), String(p).lastIndexOf("/"));
			return idx > 0 ? String(p).slice(0, idx) : "";
		}

		/** 规范化路径用于比较：统一分隔符、去尾部斜杠、Windows 大小写不敏感。 */
		function normPath(p) {
			return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		}

		/** 按路径聚合：首条 oldText → 末条 newText 的累计视图；还原时按逆序下发。 */
		function groupChanges(changes) {
			const map = new Map();
			for (const c of changes) {
				const entry = map.get(c.path) || { path: c.path, items: [], first: c, last: c };
				entry.items.push(c);
				entry.last = c;
				map.set(c.path, entry);
			}
			return [...map.values()];
		}

		function FileRow({ entry, onRevert, busy, feedback }) {
			const [open, setOpen] = react.useState(false);
			const first = entry.first, last = entry.last;
			const diff = lineDiff(first.oldText, last.op === "delete" ? "" : last.newText);
			const total = diff.removed.length + diff.added.length;
			const fb = feedback && feedback[entry.path];
			const reverted = fb && fb.status === "reverted";
			const canPreview = last.op !== "delete" && /\.html?$/i.test(basename(entry.path));
			return react_jsx_runtime.jsxs("div", {
				className: "dsh-fc-file" + (open ? " dsh-fc-open" : ""),
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "dsh-fc-row",
						children: [
							react_jsx_runtime.jsx("button", {
								className: "dsh-fc-toggle",
								onClick: () => setOpen((v) => !v),
								children: open ? "▾" : "▸"
							}),
							react_jsx_runtime.jsx("span", {
								className: "dsh-fc-name",
								title: entry.path,
								children: basename(entry.path)
							}),
							react_jsx_runtime.jsx("span", {
								className: "dsh-fc-dir",
								title: dirname(entry.path),
								children: dirname(entry.path)
							}),
							react_jsx_runtime.jsxs("span", {
								className: "dsh-fc-badges",
								children: [
									react_jsx_runtime.jsx("span", {
										className: "dsh-fc-badge dsh-fc-" + last.op,
										children: OP_LABEL[last.op] || last.op
									}),
									total > 0 && react_jsx_runtime.jsxs("span", {
										className: "dsh-fc-count",
										children: ["+", diff.added.length, " −", diff.removed.length]
									})
								]
							}),
							canPreview && react_jsx_runtime.jsx("button", {
								className: "dsh-fc-preview",
								title: "站内预览此文件",
								onClick: () => openPreview(entry.path, { kind: "file", filePath: entry.path }),
								children: "预览"
							}),
							reverted
								? react_jsx_runtime.jsx("span", { className: "dsh-fc-done", children: "已还原" })
								: react_jsx_runtime.jsx("button", {
										className: "dsh-fc-revert",
										disabled: busy || !window.dshDesktop,
										title: "还原此文件的全部变更",
										onClick: () => onRevert(entry),
										children: "还原"
									})
						]
					}),
					open && react_jsx_runtime.jsxs("div", {
						className: "dsh-fc-diff",
						children: [
							react_jsx_runtime.jsxs("div", {
								className: "dsh-fc-hint",
								children: ["共 ", entry.items.length, " 次变更 · ", last.op === "delete" ? "文件已删除" : ""]
							}),
							diff.contextBefore.map((l, i) => react_jsx_runtime.jsx("div", { className: "dsh-fc-line dsh-fc-ctx", key: "cb" + i, children: l || " " })),
							diff.removed.map((l, i) => react_jsx_runtime.jsx("div", { className: "dsh-fc-line dsh-fc-del", key: "rm" + i, children: (l || " ").slice(0, 400) })),
							diff.added.map((l, i) => react_jsx_runtime.jsx("div", { className: "dsh-fc-line dsh-fc-add", key: "ad" + i, children: (l || " ").slice(0, 400) })),
							diff.contextAfter.map((l, i) => react_jsx_runtime.jsx("div", { className: "dsh-fc-line dsh-fc-ctx", key: "ca" + i, children: l || " " })),
							fb && fb.status === "conflict" && react_jsx_runtime.jsx("div", {
								className: "dsh-fc-warn",
								children: "文件已被后续修改，无法自动还原（可手工处理）。"
							}),
							fb && fb.status === "failed" && react_jsx_runtime.jsx("div", {
								className: "dsh-fc-warn",
								children: "还原失败：" + (fb.error || "未知错误")
							})
						]
					})
				]
			});
		}

		// -----------------------------------------------------------------------
		// 侧边预览面板（可拖宽）：HTML 文件站内预览 + 本机端口预览
		// 纯 DOM 实现，挂到 document.body —— 不依赖 react-dom，切标签页也不丢。
		// -----------------------------------------------------------------------

		const PREVIEW_PANEL_ID = "__dsh_file_preview__";

		/** 文件绝对路径 → 静态服务 URL。桌面壳有独立端口的静态服务器
		 *  （不占 UI 连接池），否则回退到宿主 /dsh-files/static/。 */
		let staticBasePromise = null;
		function staticBaseUrl() {
			if (!window.dshDesktop || typeof window.dshDesktop.getInfo !== "function") return Promise.resolve("");
			if (!staticBasePromise) {
				staticBasePromise = window.dshDesktop.getInfo()
					.then((i) => (i && i.staticPort) ? "http://127.0.0.1:" + i.staticPort : "")
					.catch(() => "");
			}
			return staticBasePromise;
		}
		function staticUrlForPath(p) {
			const segs = String(p).replace(/\\/g, "/").split("/").filter(Boolean);
			return "/dsh-files/static/" + segs.map((s) => encodeURIComponent(s)).join("/");
		}
		function shellStaticUrlForPath(base, p) {
			const segs = String(p).replace(/\\/g, "/").split("/").filter(Boolean);
			return base + "/" + segs.map((s) => encodeURIComponent(s)).join("/");
		}

		/** 把用户输入规范成 URL：3000 / :3000 / localhost:3000 → http://127.0.0.1:3000/ */
		function normalizeEntryUrl(text) {
			const t = String(text || "").trim();
			if (!t) return "";
			let m = t.match(/^(?:https?:\/\/)?localhost:(\d{2,5})(\/.*)?$/i);
			if (!m) m = t.match(/^:?(\d{2,5})(\/.*)?$/);
			if (m) return "http://127.0.0.1:" + m[1] + (m[2] || "/");
			if (!/^https?:\/\//i.test(t)) return "http://" + t;
			return t;
		}

		function buildPreviewPanel() {
			if (typeof document === "undefined" || !document.body) return null;
			const existing = document.getElementById(PREVIEW_PANEL_ID);
			if (existing) return existing;

			const root = document.createElement("div");
			root.id = PREVIEW_PANEL_ID;
			root.className = "dsh-pv";
			root.style.top = window.dshDesktop ? "36px" : "0px";
			root.innerHTML =
				'<div class="dsh-pv-resizer" title="拖动调整宽度"></div>' +
				'<div class="dsh-pv-head">' +
				'<button class="dsh-pv-btn" data-act="back" title="后退">←</button>' +
				'<button class="dsh-pv-btn" data-act="fwd" title="前进">→</button>' +
				'<button class="dsh-pv-btn" data-act="reload" title="刷新">⟳</button>' +
				'<input class="dsh-pv-url" spellcheck="false" placeholder="http://127.0.0.1:3000 或项目 HTML 文件" />' +
				'<button class="dsh-pv-btn" data-act="external" title="在外部打开">↗</button>' +
				'<button class="dsh-pv-btn" data-act="close" title="关闭预览">✕</button>' +
				'</div>' +
				'<div class="dsh-pv-chips"></div>' +
				'<div class="dsh-pv-body"><iframe class="dsh-pv-frame" title="preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe></div>' +
				'<div class="dsh-pv-status">未加载</div>';
			document.body.appendChild(root);

			const frame = root.querySelector(".dsh-pv-frame");
			const input = root.querySelector(".dsh-pv-url");
			const statusEl = root.querySelector(".dsh-pv-status");
			const chipsEl = root.querySelector(".dsh-pv-chips");

			const state = {
				history: [],
				index: -1,
				filePath: null,
				ports: [],
				portsAt: 0
			};
			root.__state = state;

			function setWidth(w) {
				const max = Math.max(320, Math.floor(window.innerWidth * 0.85));
				const v = Math.min(max, Math.max(280, w));
				root.style.width = v + "px";
			}
			function setStatus(text, cls) {
				statusEl.textContent = text;
				statusEl.className = "dsh-pv-status" + (cls ? " " + cls : "");
			}
			function navigate(url) {
				if (!url) return;
				if (state.history[state.index] !== url) {
					state.history = state.history.slice(0, state.index + 1);
					state.history.push(url);
					state.index = state.history.length - 1;
				}
				input.value = url;
				// 同源（宿主 /dsh-files/static/ 回退）→ 去掉 sandbox 以加载相对资源；
				// 跨源（壳层静态端口 / 端口预览）→ sandbox 隔离（跨源下
				// allow-same-origin 无逃逸风险，页面自身 origin 保持可用）。
				if (/^\//.test(url)) frame.removeAttribute("sandbox");
				else frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-modals");
				frame.src = url;
				setStatus("加载中… " + url);
				checkOnline(url);
			}
			async function checkOnline(url) {
				if (!/^https?:\/\//i.test(url)) return;
				try {
					const res = await fetch("/api/dsh-files/check?url=" + encodeURIComponent(url));
					const j = await res.json();
					if (j && j.ok) setStatus("在线 · HTTP " + j.status + " · " + url);
					else setStatus("离线 · " + ((j && j.error) || "连接失败") + " · " + url);
				} catch {}
			}
			frame.addEventListener("load", () => {
				if (frame.src && frame.src !== "about:blank") setStatus("已加载 · " + state.history[state.index]);
			});
			async function refreshChips() {
				try {
					const res = await fetch("/api/dsh-files/ports");
					const j = await res.json();
					state.ports = Array.isArray(j.ports) ? j.ports : [];
				} catch {
					state.ports = [];
				}
				chipsEl.textContent = "";
				const addChip = (label, title, onClick) => {
					const b = document.createElement("button");
					b.className = "dsh-pv-chip";
					b.textContent = label;
					if (title) b.title = title;
					b.addEventListener("click", onClick);
					chipsEl.appendChild(b);
				};
				addChip("端口", "本机回环监听端口（点击预览）");
				for (const p of state.ports.slice(0, 40)) {
					addChip(String(p), "预览 http://127.0.0.1:" + p + "/", () => navigate("http://127.0.0.1:" + p + "/"));
				}
				addChip("⟳", "重新探测端口", refreshChips);
			}
			function show() {
				root.style.display = "flex";
				root.setAttribute("data-open", "1");
				setWidth(Number(localStorage.getItem("dsh.pv.width")) || 440);
				refreshChips();
			}
			function hide() {
				root.style.display = "none";
				root.setAttribute("data-open", "0");
			}

			root.querySelector('[data-act="back"]').addEventListener("click", () => {
				if (state.index > 0) {
					state.index -= 1;
					navigate(state.history[state.index]);
				}
			});
			root.querySelector('[data-act="fwd"]').addEventListener("click", () => {
				if (state.index < state.history.length - 1) {
					state.index += 1;
					navigate(state.history[state.index]);
				}
			});
			root.querySelector('[data-act="reload"]').addEventListener("click", () => {
				const cur = state.history[state.index];
				if (cur) {
					frame.src = "about:blank";
					setTimeout(() => { frame.src = cur; }, 30);
				}
			});
			root.querySelector('[data-act="close"]').addEventListener("click", hide);
			root.querySelector('[data-act="external"]').addEventListener("click", () => {
				const url = state.history[state.index];
				if (state.filePath && window.dshDesktop && typeof window.dshDesktop.openPath === "function") {
					window.dshDesktop.openPath(state.filePath).catch(() => {});
				} else if (url) {
					if (window.dshDesktop && typeof window.dshDesktop.openExternal === "function") {
						window.dshDesktop.openExternal(url).catch(() => {});
					} else {
						window.open(url, "_blank", "noopener");
					}
				}
			});
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					const url = normalizeEntryUrl(input.value);
					state.filePath = null;
					if (url) navigate(url);
				}
			});

			// 左缘拖拽调宽；拖拽期间禁用 iframe 鼠标事件。
			root.querySelector(".dsh-pv-resizer").addEventListener("mousedown", (e) => {
				e.preventDefault();
				const startX = e.clientX;
				const startW = root.getBoundingClientRect().width;
				const onMove = (ev) => setWidth(startW + (startX - ev.clientX));
				const onUp = () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
					frame.style.pointerEvents = "";
					document.body.style.userSelect = "";
					localStorage.setItem("dsh.pv.width", String(root.getBoundingClientRect().width));
				};
				frame.style.pointerEvents = "none";
				document.body.style.userSelect = "none";
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
			});

			state.navigate = navigate;
			state.show = show;
			state.hide = hide;
			state.frame = frame;
			return root;
		}

		/** 打开侧边预览：file 目标传 {kind:"file", filePath}，端口传 URL/端口号。 */
		function openPreview(target, meta) {
			const panel = buildPreviewPanel();
			if (!panel) return;
			const st = panel.__state;
			if (meta && meta.kind === "file") {
				st.filePath = meta.filePath || target;
				st.show();
				// 优先走壳层独立端口静态服务；取不到（非壳层环境/旧壳层）回退宿主路由。
				staticBaseUrl().then((base) => {
					st.navigate(base ? shellStaticUrlForPath(base, target) : staticUrlForPath(target));
				});
			} else {
				st.filePath = null;
				const url = normalizeEntryUrl(target);
				if (!url) return;
				st.show();
				st.navigate(url);
			}
		}

		// -----------------------------------------------------------------------
		// 全部文件：VSCode 风格项目目录树（懒加载）
		// -----------------------------------------------------------------------

		function formatSize(n) {
			if (!n || n <= 0) return "";
			if (n < 1024) return n + " B";
			const units = ["KB", "MB", "GB", "TB"];
			let v = n, i = -1;
			do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
			return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + " " + units[i];
		}

		/** 上级目录；根（如 C:\ 或 /）返回空串。 */
		function parentDir(p) {
			const s = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
			if (!s) return "";
			const idx = s.lastIndexOf("/");
			if (idx < 0) return "";
			if (idx === 0) return "/";
			// Windows 盘符根：C:/x -> C:/
			if (s.length === 3 && s[1] === ":") return s + "/";
			return s.slice(0, idx);
		}

		async function fetchDirList(dir) {
			const res = await fetch("/api/dsh-files/list?path=" + encodeURIComponent(dir));
			if (!res.ok) {
				let msg = "HTTP " + res.status;
				try {
					const j = await res.json();
					if (j && j.error) msg = j.error;
				} catch {}
				throw new Error(msg);
			}
			const j = await res.json();
			return Array.isArray(j.entries) ? j.entries : [];
		}

		function TreeRow({ path, name, dir, size, depth, changedPaths, onOpenFile }) {
			const [open, setOpen] = react.useState(false);
			const [state, setState] = react.useState({ status: "idle", entries: null, error: null });
			const load = react.useCallback(async () => {
				setState((s) => ({ ...s, status: "loading" }));
				try {
					const entries = await fetchDirList(path);
					setState({ status: "loaded", entries, error: null });
				} catch (err) {
					setState({ status: "error", entries: null, error: String((err && err.message) || err) });
				}
			}, [path]);
			const toggle = () => {
				if (!dir) return;
				if (open) setOpen(false);
				else {
					setOpen(true);
					if (state.status === "idle" || state.status === "error") load();
				}
			};
			const changed = !dir && changedPaths.has(normPath(path));
			const isHtml = !dir && /\.html?$/i.test(name);
			return react_jsx_runtime.jsxs("div", {
				className: "dsh-ft-node",
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "dsh-ft-row" + (changed ? " dsh-ft-changed" : ""),
						style: { paddingLeft: 6 + depth * 14 },
						title: path,
						onClick: () => {
							if (dir) toggle();
							else onOpenFile(path);
						},
						children: [
							react_jsx_runtime.jsx("span", {
								className: "dsh-ft-chevron" + (dir ? "" : " dsh-ft-chevron-empty"),
								children: !dir ? " " : state.status === "loading" ? "…" : open ? "▾" : "▸"
							}),
							react_jsx_runtime.jsx("span", {
								className: "dsh-ft-icon",
								children: dir ? (open ? "📂" : "📁") : "📄"
							}),
							react_jsx_runtime.jsx("span", {
								className: "dsh-ft-name",
								children: name
							}),
							isHtml && react_jsx_runtime.jsx("button", {
								className: "dsh-ft-preview",
								title: "站内预览",
								onClick: (e) => { e.stopPropagation(); openPreview(path, { kind: "file", filePath: path }); },
								children: "▶"
							}),
							changed && react_jsx_runtime.jsx("span", {
								className: "dsh-ft-dot",
								title: "本会话修改过"
							}),
							!dir && react_jsx_runtime.jsx("span", {
								className: "dsh-ft-size",
								children: formatSize(size)
							})
						]
					}),
					open && state.status === "error" && react_jsx_runtime.jsxs("div", {
						className: "dsh-ft-error",
						style: { paddingLeft: 6 + (depth + 1) * 14 },
						children: [state.error, " ", react_jsx_runtime.jsx("button", { className: "dsh-ft-retry", onClick: load, children: "重试" })]
					}),
					open && state.status === "loaded" && state.entries.map((e) => react_jsx_runtime.jsx(TreeRow, {
						key: e.name,
						path: path.replace(/[\\/]+$/, "") + "/" + e.name,
						name: e.name,
						dir: !!e.dir,
						size: e.size,
						mtime: e.mtime,
						depth: depth + 1,
						changedPaths,
						onOpenFile
					}))
				]
			});
		}

		function FileTree({ cwd, changedPaths }) {
			const [root, setRoot] = react.useState(cwd);
			const [version, setVersion] = react.useState(0);
			react.useEffect(() => { setRoot(cwd); }, [cwd]);
			const up = parentDir(root);
			const openFile = (path) => {
				if (window.dshDesktop && typeof window.dshDesktop.openPath === "function") {
					window.dshDesktop.openPath(path).catch(() => {});
				}
			};
			if (!cwd) {
				// 修复：cwdLoading 从未传入（引用未定义变量），删掉死分支。
				return react_jsx_runtime.jsx("div", {
					className: "dsh-fc-empty",
					children: react_jsx_runtime.jsx("div", { className: "dsh-fc-empty-sub", children: "当前会话没有项目目录。" })
				});
			}
			return react_jsx_runtime.jsxs("div", {
				className: "dsh-ft-root",
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "dsh-ft-toolbar",
						children: [
							react_jsx_runtime.jsx("span", {
								className: "dsh-ft-path",
								title: root,
								children: root
							}),
							react_jsx_runtime.jsxs("span", {
								className: "dsh-ft-actions",
								children: [
									react_jsx_runtime.jsx("button", {
										className: "dsh-ft-btn",
										disabled: !up,
										title: "上级目录",
										onClick: () => setRoot(up),
										children: "↑"
									}),
									react_jsx_runtime.jsx("button", {
										className: "dsh-ft-btn",
										disabled: normPath(root) === normPath(cwd),
										title: "回到项目根目录",
										onClick: () => setRoot(cwd),
										children: "⌂"
									}),
									react_jsx_runtime.jsx("button", {
										className: "dsh-ft-btn",
										title: "刷新",
										onClick: () => setVersion((v) => v + 1),
										children: "⟳"
									})
								]
							})
						]
					}),
					react_jsx_runtime.jsx(TreeRow, {
						key: normPath(root) + "@" + version,
						path: root.replace(/[\\/]+$/, ""),
						name: basename(root) || root,
						dir: true,
						depth: 0,
						changedPaths,
						onOpenFile: openFile
					})
				]
			});
		}

		// -----------------------------------------------------------------------
		// 主视图：本会话修改 / 全部文件 双模式
		// -----------------------------------------------------------------------

		function FileChangesView(props) {
			const useProjection = props.useProjection;
			const sessionId = props.sessionId;
			// 项目根目录：从宿主路由按会话 ID 查会话日志头（不依赖页面内部 hooks）。
			const [cwd, setCwd] = react.useState("");
			const [cwdLoading, setCwdLoading] = react.useState(true);
			react.useEffect(() => {
				let alive = true;
				setCwdLoading(true);
				if (sessionId) {
					fetch("/api/dsh-files/session-cwd?sessionId=" + encodeURIComponent(sessionId))
						.then((r) => r.json())
						.then((j) => { if (alive && j && typeof j.cwd === "string") setCwd(j.cwd); })
						.catch(() => {})
						.finally(() => { if (alive) setCwdLoading(false); });
				} else {
					setCwdLoading(false);
				}
				return () => { alive = false; };
			}, [sessionId]);
			const value = typeof useProjection === "function" ? useProjection("fileChanges") : void 0;
			const changes = value && Array.isArray(value.changes) ? value.changes : [];
			const groups = react.useMemo(() => groupChanges(changes), [changes]);
			const changedPaths = react.useMemo(() => {
				const s = new Set();
				for (const c of changes) s.add(normPath(c.path));
				return s;
			}, [changes]);
			const [mode, setMode] = react.useState("changes");
			const [busy, setBusy] = react.useState(false);
			const [feedback, setFeedback] = react.useState(null);

			const revertPaths = async (entries) => {
				if (!window.dshDesktop || typeof window.dshDesktop.revertFiles !== "function") return;
				const flat = [];
				for (const entry of entries) {
					// 逆序还原：末次变更先还原，逐层回到首次写前状态。
					for (let i = entry.items.length - 1; i >= 0; i--) flat.push(entry.items[i]);
				}
				setBusy(true);
				setFeedback(null);
				try {
					const { results } = (await window.dshDesktop.revertFiles(flat)) || { results: [] };
					const fb = {};
					for (const r of results || []) fb[r.path] = r;
					setFeedback(fb);
				} catch (err) {
					setFeedback({ __global: { status: "failed", error: String((err && err.message) || err) } });
				} finally {
					setBusy(false);
				}
			};

			return react_jsx_runtime.jsxs("div", {
				className: "dsh-fc-root",
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "dsh-fc-toolbar",
						children: [
							react_jsx_runtime.jsxs("div", {
								className: "dsh-fc-modes",
								children: [
									react_jsx_runtime.jsx("button", {
										className: "dsh-fc-mode" + (mode === "changes" ? " dsh-fc-mode-active" : ""),
										onClick: () => setMode("changes"),
										children: "本会话修改"
									}),
									react_jsx_runtime.jsx("button", {
										className: "dsh-fc-mode" + (mode === "tree" ? " dsh-fc-mode-active" : ""),
										onClick: () => setMode("tree"),
										children: "全部文件"
									})
								]
							}),
							mode === "changes" && react_jsx_runtime.jsx("span", {
								className: "dsh-fc-total",
								children: groups.length + " 个文件 · " + changes.length + " 次变更" + (value && value.truncated ? "（已截断）" : "")
							})
						]
					}),
					mode === "tree"
						? react_jsx_runtime.jsx(FileTree, { cwd, changedPaths })
						: groups.length === 0
							? react_jsx_runtime.jsxs("div", {
									className: "dsh-fc-empty",
									children: [
										react_jsx_runtime.jsx("div", { className: "dsh-fc-empty-title", children: "暂无文件更改记录" }),
										react_jsx_runtime.jsx("div", { className: "dsh-fc-empty-sub", children: "本会话中 agent 用 write/edit 等文件工具修改过的文件会显示在这里（支持还原）；通过代码执行类工具（run_code/pwsh/bash）改的文件无法生成 diff，不会出现在此。" }),
										react_jsx_runtime.jsx("div", { className: "dsh-fc-empty-sub", children: "也可以切到「全部文件」浏览项目目录。" }),
										react_jsx_runtime.jsx("div", {
											className: "dsh-fc-empty-sub",
											children: "投影诊断: " + (value === undefined ? "undefined（投影未返回）" : JSON.stringify(value).slice(0, 240))
										})
									]
								})
							: react_jsx_runtime.jsxs("div", {
									className: "dsh-fc-list",
									children: [
										feedback && feedback.__global && react_jsx_runtime.jsx("div", {
											className: "dsh-fc-warn",
											children: "还原失败：" + (feedback.__global.error || "未知错误")
										}),
										groups.map((g) => react_jsx_runtime.jsx(FileRow, {
											key: g.path,
											entry: g,
											busy,
											feedback,
											onRevert: (entry) => revertPaths([entry])
										}))
									]
								})
				]
			});
		}

		const CSS = [
			".dsh-fc-root{padding:12px;display:flex;flex-direction:column;gap:6px;height:100%;box-sizing:border-box}",
			".dsh-fc-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}",
			".dsh-fc-modes{display:inline-flex;gap:2px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px}",
			".dsh-fc-mode{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px;padding:2px 10px;border-radius:6px;cursor:pointer}",
			".dsh-fc-mode-active{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}",
			".dsh-fc-total{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsh-fc-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0;flex:1}",
			".dsh-fc-file{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;overflow:hidden}",
			".dsh-fc-row{display:flex;align-items:center;gap:6px;padding:6px 8px;min-width:0}",
			".dsh-fc-toggle{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;width:18px;height:18px;border-radius:5px;padding:0;font-size:10px;flex:none}",
			".dsh-fc-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-fc-name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;white-space:nowrap;flex:none}",
			".dsh-fc-dir{color:var(--dsw-alias-label-caption);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;direction:rtl;text-align:left}",
			".dsh-fc-badges{display:inline-flex;align-items:center;gap:4px;flex:none}",
			".dsh-fc-badge{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
			".dsh-fc-create{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}",
			".dsh-fc-delete{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}",
			".dsh-fc-count{font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dsh-fc-revert{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:2px 10px;font-size:11.5px;line-height:16px;cursor:pointer;flex:none}",
			".dsh-fc-revert:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-fc-revert:disabled{opacity:.5;cursor:default}",
			".dsh-fc-done{font-size:11.5px;color:var(--dsw-alias-state-success-primary);flex:none}",
			".dsh-fc-diff{font-family:var(--ds-font-family-code,Consolas,monospace);font-size:11px;line-height:17px;border-top:1px solid var(--dsw-alias-border-l2);padding:6px 8px;overflow-x:auto}",
			".dsh-fc-hint{color:var(--dsw-alias-label-caption);font-size:10.5px;margin-bottom:4px}",
			".dsh-fc-line{white-space:pre;min-height:17px}",
			".dsh-fc-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}",
			".dsh-fc-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}",
			".dsh-fc-ctx{color:var(--dsw-alias-label-tertiary)}",
			".dsh-fc-warn{color:var(--dsw-alias-state-warn-label);font-size:11.5px;margin-top:6px;padding:4px 8px;background:var(--dsw-alias-bg-module-platform);border-radius:6px}",
			".dsh-fc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;padding:24px}",
			".dsh-fc-empty-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}",
			".dsh-fc-empty-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;max-width:280px;line-height:18px}",
			// 目录树
			".dsh-ft-root{display:flex;flex-direction:column;gap:6px;min-height:0;flex:1}",
			".dsh-ft-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:4px 8px;min-width:0}",
			".dsh-ft-path{font-family:var(--ds-font-family-code,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;direction:rtl;text-align:left}",
			".dsh-ft-actions{display:inline-flex;gap:2px;flex:none}",
			".dsh-ft-btn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;width:22px;height:22px;border-radius:5px;padding:0;font-size:12px;line-height:1}",
			".dsh-ft-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-ft-btn:disabled{opacity:.4;cursor:default}",
			".dsh-ft-node{min-width:0}",
			".dsh-ft-row{display:flex;align-items:center;gap:5px;height:24px;padding-right:8px;border-radius:6px;cursor:default;user-select:none;min-width:0}",
			".dsh-ft-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-ft-chevron{width:12px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;text-align:center}",
			".dsh-ft-chevron-empty{visibility:hidden}",
			".dsh-ft-icon{flex:none;font-size:12px;line-height:1}",
			".dsh-ft-name{font-size:12.5px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}",
			".dsh-ft-changed .dsh-ft-name{color:var(--dsw-alias-state-success-primary)}",
			".dsh-ft-dot{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-success-primary);flex:none}",
			".dsh-ft-size{font-size:10.5px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;flex:none}",
			".dsh-ft-error{color:var(--dsw-alias-state-error-primary);font-size:11px;padding:2px 8px 6px;display:flex;align-items:center;gap:6px}",
			".dsh-ft-retry{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:5px;font-size:10.5px;padding:0 6px;cursor:pointer}",
			// 侧边预览面板
			".dsh-pv{position:fixed;top:0;right:0;bottom:0;width:440px;max-width:85vw;display:none;flex-direction:column;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-10px 0 28px rgba(0,0,0,.18);z-index:2147482990;box-sizing:border-box}",
			".dsh-pv[data-open=\"1\"]{display:flex}",
			".dsh-pv-resizer{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:3}",
			".dsh-pv-resizer:hover,.dsh-pv-resizer:active{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-pv-head{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}",
			".dsh-pv-btn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;width:24px;height:24px;border-radius:6px;padding:0;font-size:12px;line-height:1;flex:none}",
			".dsh-pv-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-pv-url{flex:1;min-width:0;height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px;font-family:var(--ds-font-family-code,Consolas,monospace);outline:none;box-sizing:border-box}",
			".dsh-pv-url:focus{border-color:var(--dsw-alias-interactive-focus,var(--dsw-alias-state-info-primary))}",
			".dsh-pv-chips{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;max-height:60px;overflow-y:auto}",
			".dsh-pv-chip{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;font-size:10.5px;line-height:16px;padding:0 8px;cursor:pointer;font-variant-numeric:tabular-nums}",
			".dsh-pv-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-pv-body{flex:1;min-height:0;position:relative;background:#fff}",
			".dsh-pv-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}",
			".dsh-pv-status{padding:4px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l2);flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-ft-preview{display:none;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;width:20px;height:18px;border-radius:5px;font-size:10px;flex:none;padding:0}",
			".dsh-ft-row:hover .dsh-ft-preview{display:inline-block}",
			".dsh-ft-preview:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-fc-preview{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:2px 10px;font-size:11.5px;line-height:16px;cursor:pointer;flex:none}",
			".dsh-fc-preview:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"
		].join("");

		const TAG = "@deepseek-ai/dsh-client-file-changes/client.css";
		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-file-changes";
			tag.dataset.pluginCss = TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ensureCss();
			buildPreviewPanel();
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "file-changes",
				order: 20,
				label: () => "文件"
			}, FileChangesView), "dsh-client-file-changes: conversation view entry");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
