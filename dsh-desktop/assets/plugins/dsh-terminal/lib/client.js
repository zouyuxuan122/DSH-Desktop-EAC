window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/**
		 * 「终端」视图：注册到 conversation.view，与 对话/轨迹/文件 并列。
		 * 宿主插件通过 SSE 提供当前会话项目目录下的持久 shell（cmd.exe/sh），
		 * 支持历史、清屏、重启、断线自动重连与 snapshot 回放。
		 * 轻量 ANSI 渲染（SGR 前景色/加粗）；非 PTY，全屏交互程序（vim 等）不支持。
		 */

		const TOKEN_KEY = "dsh.term.token";
		// A1 修复：token 按会话隔离——不同会话各自持有持久 shell，
		// 避免第一个会话的 shell 被全局 token 复用导致终端"钉"在它的目录。
		const tokenKeyFor = (sid) => (sid ? TOKEN_KEY + "." + sid : TOKEN_KEY);

		function newToken(key) {
			const t = (crypto && typeof crypto.randomUUID === "function")
				? crypto.randomUUID()
				: "t-" + Date.now() + "-" + Math.random().toString(36).slice(2);
			try { localStorage.setItem(key, t); } catch {}
			return t;
		}
		function savedToken(key) {
			try { return localStorage.getItem(key) || ""; } catch { return ""; }
		}

		// -----------------------------------------------------------------------
		// 轻量 ANSI：把文本块解析成 [{text, cls}] 行；支持 SGR 前景色/加粗，
		// 其余控制序列剥离；\r 覆盖当前行（进度条场景）。
		// -----------------------------------------------------------------------

		const SGR_COLORS = {
			30: "c30", 31: "c31", 32: "c32", 33: "c33", 34: "c34",
			35: "c35", 36: "c36", 37: "c37",
			90: "c90", 91: "c91", 92: "c92", 93: "c93", 94: "c94",
			95: "c95", 96: "c96", 97: "c97"
		};

		function parseAnsiChunk(chunk, out, carry) {
			// carry: { lines: [{text, cls}], cur: {text, cls} }
			let text = String(chunk);
			let i = 0;
			const { cur, lines } = carry;
			const flush = (replace) => {
				if (replace) lines[lines.length - 1] = { text: cur.text, cls: cur.cls };
				else {
					lines.push({ text: cur.text, cls: cur.cls });
					if (lines.length > 8000) lines.splice(0, lines.length - 8000);
				}
				cur.text = "";
			};
			while (i < text.length) {
				const ch = text[i];
				if (ch === "\x1b") {
					const m = text.slice(i).match(/^\x1b\[([0-9;]*)m/);
					if (m) {
						i += m[0].length;
						let cls = cur.cls || "";
						for (const code of m[1].split(";")) {
							if (code === "" || code === "0") cls = "";
							else if (SGR_COLORS[code]) cls = (cls ? cls + " " : "") + SGR_COLORS[code];
							else if (code === "1") cls = (cls ? cls + " " : "") + "bold";
						}
						cur.cls = cls;
						continue;
					}
					const m2 = text.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
					if (m2) { i += m2[0].length; continue; } // 光标等控制序列：剥离
					i += 1; // 孤立 ESC
					continue;
				}
				if (ch === "\r") {
					if (cur.text !== "") flush(true);
					i += 1;
					continue;
				}
				if (ch === "\n") {
					flush(false);
					i += 1;
					continue;
				}
				if (ch === "\b") { cur.text = cur.text.slice(0, -1); i += 1; continue; }
				let j = i;
				while (j < text.length && text[j] !== "\n" && text[j] !== "\r" && text[j] !== "\x1b" && text[j] !== "\b") j++;
				cur.text += text.slice(i, j);
				i = j;
			}
			return out;
		}

		function renderChunk(chunk, state) {
			const carry = state.carry || (state.carry = { lines: [], cur: { text: "", cls: "" } });
			parseAnsiChunk(chunk, null, carry);
			return carry.lines;
		}

		function TerminalView(props) {
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

			const [lines, setLines] = react.useState([]);
			const [status, setStatus] = react.useState("connecting");
			const [diag, setDiag] = react.useState("");
			const [input, setInput] = react.useState("");
			const [history, setHistory] = react.useState([]);
			const [histIdx, setHistIdx] = react.useState(-1);
			// A1：token 跟随会话——切换会话时按新 sessionId 取/建 token；
			// 同一会话内保持稳定（切标签页/刷新 15 分钟内不丢 shell 状态）。
			const tokenRef = react.useRef("");
			const lastSessionRef = react.useRef(null);
			react.useEffect(() => {
				const sid = sessionId || "";
				if (lastSessionRef.current === sid) return;
				lastSessionRef.current = sid;
				const key = tokenKeyFor(sessionId);
				tokenRef.current = savedToken(key) || newToken(key);
			}, [sessionId]);
			const carryRef = react.useRef({ lines: [], cur: { text: "", cls: "" } });
			const scrollRef = react.useRef(null);
			const stickRef = react.useRef(true);

			const append = react.useCallback((more) => {
				setLines((prev) => {
					const next = prev.concat(more);
					if (next.length > 8000) next.splice(0, next.length - 8000);
					return next;
				});
			}, []);

			// 连接管理：cwd 用 ref 读取，避免 restart/connect 的闭包过期问题。
			// 通道用 WebSocket（升级连接不占浏览器对同主机的 HTTP/1.1 六连接池，
			// web UI 自身的长连接已把池占满，SSE 会被排队永远连不上）。
			const cwdRef = react.useRef("");
			cwdRef.current = cwd;
			const watchRef = react.useRef(null);
			const wsRef = react.useRef(null);
			const intentionalRef = react.useRef(false);
			const retryDelayRef = react.useRef(1000);
			const retryTimerRef = react.useRef(null);

			const connect = react.useCallback(() => {
				const cur = cwdRef.current;
				if (!cur) { setStatus("failed"); return; }
				let ws;
				try {
					const proto = window.location.protocol === "https:" ? "wss" : "ws";
					ws = new WebSocket(
						proto + "://" + window.location.host +
						"/dsh-files/term/ws?token=" + encodeURIComponent(tokenRef.current) +
						"&cwd=" + encodeURIComponent(cur)
					);
				} catch (err) {
					setStatus("failed");
					return;
				}
				wsRef.current = ws;
				intentionalRef.current = false;
				setStatus("connecting");
				if (watchRef.current) clearTimeout(watchRef.current);
				watchRef.current = setTimeout(() => {
					setStatus((s) => {
						if (s !== "connecting") return s;
						// 失败时用普通 fetch 探测宿主可达性（ports 路由无副作用）。
						fetch("/api/dsh-files/ports", {
							signal: AbortSignal.timeout(4000)
						}).then((r) => {
							setDiag("探测 fetch: HTTP " + r.status);
						}).catch((err) => {
							setDiag("探测 fetch 失败: " + String((err && err.message) || err));
						});
						return "failed";
					});
				}, 6000);
				const clearWatch = () => { if (watchRef.current) { clearTimeout(watchRef.current); watchRef.current = null; } };
				const applyText = (text, replace) => {
					carryRef.current.lines = [];
					carryRef.current.cur = { text: "", cls: "" };
					const rendered = renderChunk(text, carryRef.current);
					if (replace) setLines(rendered);
					else append(rendered);
				};
				const handleMsg = (msg) => {
					if (!msg || typeof msg !== "object") return;
					if (msg.event === "snapshot") { try { applyText(String(msg.data && msg.data.text || ""), true); } catch {} }
					else if (msg.event === "ready") {
						clearWatch();
						retryDelayRef.current = 1000;
						setStatus(msg.data && msg.data.exited ? "exited" : "ready");
					} else if (msg.event === "data") {
						try { applyText(String(msg.data && msg.data.text || ""), false); } catch {}
					} else if (msg.event === "exit") {
						clearWatch();
						const code = msg.data && msg.data.code;
						setStatus("exited");
						append([{ text: "[进程已退出" + (code === null || code === 0 || code === undefined ? "" : " · code " + code) + "，回车或点「重启」开启新会话]", cls: "exit" }]);
					}
				};
				ws.onopen = () => { setStatus("connecting"); };
				ws.onmessage = (e) => {
					let msg;
					try { msg = JSON.parse(e.data); } catch { return; }
					handleMsg(msg);
				};
				ws.onclose = () => {
					clearWatch();
					if (intentionalRef.current) return;
					// 非主动关闭：退避重连（1s→2s→…→15s 封顶）。
					setStatus((s) => (s === "exited" ? s : "retrying"));
					const delay = retryDelayRef.current;
					retryDelayRef.current = Math.min(delay * 2, 15000);
					if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
					retryTimerRef.current = setTimeout(() => connect(), delay);
				};
				ws.onerror = () => {};
			}, [append]);

			const restart = react.useCallback(() => {
				intentionalRef.current = true;
				if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
				if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
				const old = tokenRef.current;
				tokenRef.current = newToken();
				if (old) {
					try {
						fetch("/dsh-files/term/close", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ token: old }),
							keepalive: true
						}).catch(() => {});
					} catch {}
				}
				carryRef.current = { lines: [], cur: { text: "", cls: "" } };
				setLines([]);
				retryDelayRef.current = 1000;
				connect();
			}, [connect]);

			react.useEffect(() => {
				if (!cwd) return;
				connect();
				return () => {
					intentionalRef.current = true;
					if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
					if (watchRef.current) { clearTimeout(watchRef.current); watchRef.current = null; }
					if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
				};
			}, [cwd, connect]);

			react.useEffect(() => {
				const el = scrollRef.current;
				if (!el) return;
				if (stickRef.current) el.scrollTop = el.scrollHeight;
			}, [lines]);

			const onScroll = () => {
				const el = scrollRef.current;
				if (!el) return;
				stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
			};

			const send = (line) => {
				const t = line.trim();
				if (!t) return;
				append([{ text: "❯ " + t, cls: "cmd" }]);
				setHistory((h) => [t, ...h].slice(0, 200));
				setHistIdx(-1);
				setInput("");
				const ws = wsRef.current;
				if (ws && ws.readyState === 1) {
					try { ws.send(JSON.stringify({ type: "input", line: t })); } catch {}
				} else {
					append([{ text: "[未连接：命令未发送]", cls: "exit" }]);
				}
			};

			const onSubmit = (e) => {
				e.preventDefault();
				if (status === "exited") { restart(); return; }
				send(input);
			};

			const onKeyDown = (e) => {
				if (e.key === "ArrowUp") {
					e.preventDefault();
					if (!history.length) return;
					const idx = Math.min(histIdx + 1, history.length - 1);
					setHistIdx(idx);
					setInput(history[idx]);
				} else if (e.key === "ArrowDown") {
					e.preventDefault();
					if (histIdx <= 0) { setHistIdx(-1); setInput(""); return; }
					const idx = histIdx - 1;
					setHistIdx(idx);
					setInput(history[idx]);
				}
			};

			if (!cwd) {
				return react_jsx_runtime.jsx("div", {
					className: "dsh-term-root",
					children: react_jsx_runtime.jsx("div", {
						className: "dsh-term-hint",
						children: cwdLoading ? "正在获取项目目录…" : "当前会话没有项目目录，无法启动终端。"
					})
				});
			}

			return react_jsx_runtime.jsxs("div", {
				className: "dsh-term-root",
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "dsh-term-head",
						children: [
							react_jsx_runtime.jsx("span", {
								className: "dsh-term-cwd",
								title: cwd + " · session: " + (sessionId || "?"),
								children: cwd
							}),
							react_jsx_runtime.jsx("span", {
								className: "dsh-term-status dsh-term-status-" + status,
								children: status === "ready" ? "运行中" : status === "exited" ? "已退出" : status === "retrying" ? "重连中…" : status === "failed" ? "连接失败（点重启重试）" : "连接中…"
							}),
							react_jsx_runtime.jsx("button", {
								className: "dsh-term-btn",
								title: "清屏",
								onClick: () => setLines([]),
								children: "清屏"
							}),
							react_jsx_runtime.jsx("button", {
								className: "dsh-term-btn",
								title: "重启终端",
								onClick: restart,
								children: "重启"
							})
						]
					}),
					react_jsx_runtime.jsx("div", {
						className: "dsh-term-body",
						ref: scrollRef,
						onScroll,
						children: [
							status === "failed" && react_jsx_runtime.jsxs("div", {
								className: "dsh-term-line dsh-term-fail",
								children: ["无法建立连接：宿主路由 /dsh-files/term/events 无响应（session: ", sessionId || "?", "，目录: ", cwd, "）。", diag ? " " + diag : "", " 可点右上「重启」重试，或重启桌面端后重试。"]
							}),
							lines.map((l, i) => react_jsx_runtime.jsx("div", {
								key: i,
								className: "dsh-term-line" + (l.cls ? " " + l.cls : ""),
								children: l.text || " "
							}))
						]
					}),
					react_jsx_runtime.jsxs("form", {
						className: "dsh-term-input",
						onSubmit,
						children: [
							react_jsx_runtime.jsx("span", { className: "dsh-term-prompt", children: status === "exited" ? "⏻" : "❯" }),
							react_jsx_runtime.jsx("input", {
								value: input,
								onChange: (e) => setInput(e.target.value),
								onKeyDown,
								placeholder: status === "exited" ? "回车重启终端…" : "输入命令，回车执行（PowerShell 语法；非 PTY：vim 等全屏程序不支持）",
								autoFocus: true,
								spellCheck: false
							})
						]
					})
				]
			});
		}

		const CSS = [
			".dsh-term-root{display:flex;flex-direction:column;height:100%;background:#16161a;color:#d4d4d4;font-family:var(--ds-font-family-code,Consolas,'Courier New',monospace);box-sizing:border-box}",
			".dsh-term-hint{display:flex;align-items:center;justify-content:center;height:100%;color:#8a8a8a;font-size:12px}",
			".dsh-term-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #2b2b31;flex:none}",
			".dsh-term-cwd{flex:1;min-width:0;font-size:11px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}",
			".dsh-term-status{font-size:10.5px;flex:none}",
			".dsh-term-status-ready{color:#4ec97c}",
			".dsh-term-status-exited{color:#e08a4e}",
			".dsh-term-status-retrying{color:#d8b64e}",
			".dsh-term-status-failed{color:#ff8a8a}",
			".dsh-term-status-connecting{color:#8a8a8a}",
			".dsh-term-btn{appearance:none;border:1px solid #33333b;background:transparent;color:#b8b8c0;border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer;flex:none}",
			".dsh-term-btn:hover{background:#26262c;color:#e4e4e8}",
			".dsh-term-body{flex:1;min-height:0;overflow-y:auto;padding:8px 10px;box-sizing:border-box}",
			".dsh-term-line{white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:18px;min-height:18px}",
			".dsh-term-line.cmd{color:#7fc8ff}",
			".dsh-term-line.exit{color:#e08a4e}",
			".dsh-term-line.dsh-term-fail{color:#ff8a8a;background:#3a1f24;border-radius:6px;padding:6px 8px;margin-bottom:6px;white-space:normal}",
			".dsh-term-line.bold{font-weight:700}",
			".dsh-term-line.c30{color:#1a1a1a}.dsh-term-line.c31{color:#e06c75}.dsh-term-line.c32{color:#98c379}.dsh-term-line.c33{color:#e5c07b}.dsh-term-line.c34{color:#61afef}.dsh-term-line.c35{color:#c678dd}.dsh-term-line.c36{color:#56b6c2}.dsh-term-line.c37{color:#d4d4d4}",
			".dsh-term-line.c90{color:#5c6370}.dsh-term-line.c91{color:#f27d86}.dsh-term-line.c92{color:#a9d491}.dsh-term-line.c93{color:#eacf8e}.dsh-term-line.c94{color:#79b7f0}.dsh-term-line.c95{color:#d39be2}.dsh-term-line.c96{color:#67c6d2}.dsh-term-line.c97{color:#e4e4e8}",
			".dsh-term-input{display:flex;align-items:center;gap:6px;padding:6px 10px;border-top:1px solid #2b2b31;flex:none}",
			".dsh-term-prompt{color:#4ec97c;font-size:12px;flex:none}",
			".dsh-term-input input{flex:1;min-width:0;background:transparent;border:none;outline:none;color:#d4d4d4;font-family:inherit;font-size:12px;line-height:20px;padding:0}"
		].join("");

		const TAG = "@deepseek-ai/dsh-terminal/client.css";
		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-terminal";
			tag.dataset.pluginCss = TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ensureCss();
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "terminal",
				order: 30,
				label: () => "终端"
			}, TerminalView), "dsh-terminal: conversation view entry");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
