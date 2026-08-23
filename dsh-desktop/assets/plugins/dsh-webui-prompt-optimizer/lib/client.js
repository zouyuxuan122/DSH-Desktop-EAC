window.__ModuleLoader__.load({
	id: "dsh-webui-prompt-optimizer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/prompt-optimize/styles.ts
		/**
		* webui — 提示词优化入口样式（运行时幂等注入 <style>）。
		*
		* 图标按钮规格对齐 DSH 官方工具行小控件（与模型座位 .webui-ms-trigger 同源）：
		* 28px 高、胶囊圆角、透明底、hover 用 interactive-bg-hover，主题变量一律走 DSH 令牌。
		* popover 面板规格对齐模型座位弹出菜单（菜单底色/阴影/圆角同源）；开关对齐官方
		* 开关规范（开启态 business-primary + 白钮，关闭态 border-l2 + 灰钮）。
		*/
		/** 类名常量（组件引用）。 */
		const css = {
			root: "webui-po-root",
			trigger: "webui-po-trigger",
			busy: "webui-po-busy",
			panel: "webui-po-panel",
			panelTitle: "webui-po-panel-title",
			caption: "webui-po-caption",
			status: "webui-po-status",
			statusOptimizing: "webui-po-status-optimizing",
			statusDone: "webui-po-status-done",
			statusError: "webui-po-status-error",
			options: "webui-po-options",
			option: "webui-po-option",
			optionLabel: "webui-po-option-label",
			switch: "webui-po-switch",
			switchOn: "webui-po-switch-on",
			knob: "webui-po-switch-knob",
			knobOn: "webui-po-switch-knob-on",
			stop: "webui-po-stop",
			panelMulti: "webui-po-panel-multi",
			panelClosing: "webui-po-panel-closing",
			multiBody: "webui-po-multi-body",
			sourceBlock: "webui-po-source",
			sourceLabel: "webui-po-source-label",
			sourceText: "webui-po-source-text",
			candidates: "webui-po-candidates",
			candidate: "webui-po-candidate",
			candidateHead: "webui-po-candidate-head",
			candidateLabel: "webui-po-candidate-label",
			candidateText: "webui-po-candidate-text",
			recommendBadge: "webui-po-recommend",
			closeCard: "webui-po-close"
		};
		const STYLE_ID = "dsh-webui-prompt-optimizer-styles";
		const SHEET = `
.webui-po-root{position:relative;display:grid;place-items:center}
.webui-po-trigger{display:grid;place-items:center;width:28px;height:28px;padding:0;border:none;border-radius:14px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.webui-po-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.webui-po-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.webui-po-trigger:disabled{opacity:.5;cursor:default}
.webui-po-busy{animation:webui-po-spin 1s linear infinite}
@keyframes webui-po-spin{to{transform:rotate(360deg)}}
.webui-po-panel{position:absolute;right:0;bottom:calc(100% + 10px);z-index:20;width:max-content;min-width:236px;max-width:320px;padding:14px 16px;border:1px solid var(--dsw-alias-border-inverted);border-radius:14px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);animation:webui-po-slide-in 160ms cubic-bezier(.2,.8,.2,1)}
/* 透明桥接：覆盖卡片与图标之间的间隙，鼠标移动时命中卡片不中断 hover。 */
.webui-po-panel::before{content:'';position:absolute;left:0;right:0;bottom:-10px;height:10px}
@keyframes webui-po-slide-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
.webui-po-panel-title{font-size:14px;font-weight:600;line-height:20px;margin-bottom:4px}
.webui-po-caption{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.webui-po-options{display:flex;flex-direction:column;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.webui-po-option{display:flex;align-items:center;justify-content:space-between;gap:12px}
.webui-po-option-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.webui-po-switch{position:relative;width:34px;height:18px;border-radius:9px;border:none;padding:0;cursor:pointer;flex:none;background:var(--dsw-alias-border-l2);transition:background .15s}
.webui-po-switch-on{background:var(--dsw-alias-state-business-primary)}
.webui-po-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:left .15s,background .15s;box-shadow:0 1px 2px rgba(0,0,0,.15)}
.webui-po-switch-knob-on{left:18px;background:#fff}
.webui-po-status{display:flex;align-items:center;gap:6px;margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.webui-po-status-optimizing{color:var(--dsw-alias-state-business-primary)}
.webui-po-status-done{color:var(--dsw-alias-state-success-primary)}
.webui-po-status-error{color:var(--dsw-alias-state-error-primary)}
.webui-po-stop{display:flex;align-items:center;justify-content:center;width:100%;height:28px;margin-top:10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
.webui-po-stop:hover{background:var(--dsw-alias-state-error-primary);color:#fff}
/* 多轮候选卡片：滑出动画（滑入沿用 .webui-po-panel 的 slide-in / glass rise）。
 * important 覆盖玻璃模式 html[data-dsh-glass] 的 rise 强制 animation。 */
.webui-po-panel-closing{animation:webui-po-slide-out 140ms cubic-bezier(.4,0,.6,1) forwards!important}
@keyframes webui-po-slide-out{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(6px)}}
.webui-po-panel-multi{position:fixed;left:0;right:0;top:0;bottom:0;margin:auto;width:800px;max-width:calc(100vw - 32px);height:fit-content;max-height:82vh;padding:20px 24px;overflow-y:auto;z-index:1000}
.webui-po-multi-body{display:flex;flex-direction:column;gap:14px;min-width:0}
.webui-po-source{margin-top:2px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.webui-po-source-label{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.webui-po-source-text{font-size:15px;line-height:24px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.webui-po-candidates{display:flex;flex-direction:column;gap:12px;min-width:0}
.webui-po-candidate{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:transparent;text-align:left;cursor:pointer;transition:border-color .15s,background .15s}
.webui-po-candidate:hover{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.webui-po-candidate-head{display:flex;align-items:center;gap:10px}
.webui-po-candidate-label{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.webui-po-recommend{font-size:13px;line-height:18px;font-weight:600;padding:0 8px;border-radius:6px;background:var(--dsw-alias-state-business-primary);color:#fff}
.webui-po-candidate-text{font-size:15px;line-height:24px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.webui-po-close{display:flex;align-items:center;justify-content:center;width:100%;height:36px;margin-top:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
.webui-po-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
`;
		/** 注入样式表（幂等；loader 卸载插件时会移除其 style 标签）。 */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.dataset.plugin = "dsh-webui-prompt-optimizer";
			tag.dataset.pluginCss = "dsh-webui-prompt-optimizer/styles";
			tag.textContent = SHEET;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/prompt-optimize/PromptOptimizeButton.tsx
		/**
		* PromptOptimizeButton — 对话框「自动优化提示词」图标按钮。
		*
		* 注册在 `conversation.input.right`（order 5，位于供应商标签 order 10 的左侧）。
		* 点击后用当前会话选中的模型（ModelDirectory store 的 `current`）优化输入框
		* 草稿：草稿与选中模型 → 独立插件 SSE 路由 → 边收
		* text 增量边写回草稿，图标上方 popover 展示优化链路与实时进度。
		*
		* 草稿读取走 owner 共享（InputZone.input，随 skeleton 重渲染实时更新），
		* 写回走标准 kit 的 `inputActions.setDraft`（唯一公开写入路径），不碰 DOM。
		*/
		function classNames(...values) {
			return values.filter((value) => typeof value === "string" && value !== "").join(" ");
		}
		/** 把毫秒格式化为可读耗时。 */
		function formatMs(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "已完成";
			if (ms < 1e3) return `已完成 · ${String(Math.round(ms))}ms`;
			return `已完成 · ${(ms / 1e3).toFixed(1)}s`;
		}
		/** 「设定目标提示词」开关的 localStorage 键。 */
		const TARGET_KEY = "dsh-webui-prompt-optimizer:set-target";
		/** 「使用 AI 浏览器验证」开关的 localStorage 键。 */
		const VERIFY_KEY = "dsh-webui-prompt-optimizer:verify-browser";
		/** 「多轮优化」开关的 localStorage 键。 */
		const MULTI_KEY = "dsh-webui-prompt-optimizer:multi-round";
		/** 多轮优化候选数量（固定 3，与 host 端 MULTI_VARIANTS 顺序一致）。 */
		const CANDIDATE_COUNT = 3;
		/** 多轮候选展示标签（候选 0 额外加「推荐」徽标）。 */
		const CANDIDATE_LABELS = [
			"均衡优化",
			"精简高效",
			"详尽具体"
		];
		/** 从 localStorage 读开关状态；缺省值在首次（从未点过）时生效。 */
		function readFlag(key, fallback) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? fallback : raw !== "0";
			} catch {
				return fallback;
			}
		}
		/** 把开关状态写入 localStorage（选择过即持久化）。 */
		function writeFlag(key, value) {
			try {
				window.localStorage.setItem(key, value ? "1" : "0");
			} catch {}
		}
		/**
		* 渲染「自动优化提示词」图标按钮。
		* @param props - injected face + owner + standard kit。
		* @returns 图标按钮，或 null（subagent 会话不渲染）。
		*/
		function PromptOptimizeButton({ available, directory, input, inputActions, sessionId }) {
			ensureStyles();
			const state = (0, react.useSyncExternalStore)((fn) => directory.subscribe(fn), () => directory.getSnapshot());
			const [phase, setPhase] = (0, react.useState)("idle");
			const [detail, setDetail] = (0, react.useState)("");
			const [hovered, setHovered] = (0, react.useState)(false);
			const [setTarget, setSetTarget] = (0, react.useState)(() => readFlag(TARGET_KEY, true));
			const [verifyWithBrowser, setVerifyWithBrowser] = (0, react.useState)(() => readFlag(VERIFY_KEY, false));
			const [multiRound, setMultiRound] = (0, react.useState)(() => readFlag(MULTI_KEY, false));
			const [candidates, setCandidates] = (0, react.useState)([]);
			const [sourceText, setSourceText] = (0, react.useState)("");
			const [round, setRound] = (0, react.useState)(1);
			const [closing, setClosing] = (0, react.useState)(false);
			const closeTimer = (0, react.useRef)(null);
			const hoverLeaveTimer = (0, react.useRef)(null);
			const abortRef = (0, react.useRef)(null);
			const sourceRef = (0, react.useRef)("");
			const lastWrittenRef = (0, react.useRef)("");
			const roundRef = (0, react.useRef)(1);
			const busy = phase === "optimizing";
			(0, react.useEffect)(() => () => {
				if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
				if (hoverLeaveTimer.current !== null) window.clearTimeout(hoverLeaveTimer.current);
			}, []);
			if (!available) return null;
			const cancelHoverHide = () => {
				if (hoverLeaveTimer.current !== null) {
					window.clearTimeout(hoverLeaveTimer.current);
					hoverLeaveTimer.current = null;
				}
			};
			const showPanel = () => {
				cancelHoverHide();
				setHovered(true);
			};
			const scheduleHide = () => {
				if (phase === "multi") return;
				cancelHoverHide();
				hoverLeaveTimer.current = window.setTimeout(() => {
					hoverLeaveTimer.current = null;
					setHovered(false);
				}, 80);
			};
			const finish = (next, text) => {
				setPhase(next);
				setDetail(text);
				if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
				closeTimer.current = window.setTimeout(() => {
					setPhase("idle");
					setDetail("");
				}, next === "done" ? 2400 : 3800);
			};
			const toggleTarget = () => {
				setSetTarget((prev) => {
					const next = !prev;
					writeFlag(TARGET_KEY, next);
					return next;
				});
			};
			const toggleVerify = () => {
				setVerifyWithBrowser((prev) => {
					const next = !prev;
					writeFlag(VERIFY_KEY, next);
					return next;
				});
			};
			const toggleMulti = () => {
				setMultiRound((prev) => {
					const next = !prev;
					writeFlag(MULTI_KEY, next);
					return next;
				});
			};
			/** 紧急停止：中止 fetch，并显式通知 host 中止模型调用（不依赖 TCP 断开检测）。 */
			const stop = () => {
				abortRef.current?.abort();
				fetch("/api/dsh-webui-prompt-optimizer/stop", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				}).catch(() => {});
			};
			const current = state.current;
			const modelName = state.groups.flatMap((group) => group.models).find((model) => model.id === current?.model)?.name ?? current?.model ?? "未选模型";
			const optimize = async () => {
				if (busy) return;
				if (input.draft.trim() === "") {
					finish("error", "请先输入要优化的提示词");
					return;
				}
				if (current === null || current.provider === void 0 || current.model === void 0) {
					finish("error", "请先选择模型");
					return;
				}
				const provider = current.provider;
				const model = current.model;
				if (multiRound) await optimizeMulti(provider, model);
				else await optimizeSingle(provider, model);
			};
			/** 单轮优化：流式边收边写回草稿（现有行为，保留实时体验）。 */
			const optimizeSingle = async (provider, model) => {
				const draft = input.draft.trim();
				const original = input.draft;
				setPhase("optimizing");
				setDetail("正在调用模型…");
				const controller = new AbortController();
				abortRef.current = controller;
				let reader = null;
				let wroteDraft = false;
				try {
					const response = await fetch("/api/dsh-webui-prompt-optimizer", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							provider,
							model,
							text: draft,
							setTarget,
							verifyWithBrowser,
							sessionId
						}),
						signal: controller.signal
					});
					if (!response.ok) throw new Error(`优化请求失败（HTTP ${String(response.status)}）`);
					if (response.body === null) throw new Error("无响应流");
					reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					let accumulated = "";
					let sawTerminal = false;
					const onFrame = (payload) => {
						if (payload.type === "delta" && typeof payload.text === "string") {
							accumulated += payload.text;
							inputActions.setDraft(accumulated);
							wroteDraft = true;
							setDetail(`正在优化 · 已生成 ${String(accumulated.length)} 字`);
							return;
						}
						if (payload.type === "done") {
							sawTerminal = true;
							const objective = accumulated.trim();
							if (objective === "") {
								finish("done", formatMs(payload.elapsedMs));
								return;
							}
							if (setTarget) {
								inputActions.setDraft(`/goal ${objective}`);
								finish("done", "已完成 · 已生成 /goal");
							} else if (verifyWithBrowser) {
								inputActions.setDraft(`${objective}\n\n请用 AI 浏览器实际验证上面这条提示词能否正常工作，并简要报告验证结论。`);
								finish("done", "已完成 · 已附加浏览器验证");
							} else finish("done", formatMs(payload.elapsedMs));
							return;
						}
						if (payload.type === "error") {
							sawTerminal = true;
							throw new Error(payload.message ?? "优化失败");
						}
					};
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						let idx;
						while ((idx = buffer.indexOf("\n\n")) !== -1) {
							const frame = buffer.slice(0, idx);
							buffer = buffer.slice(idx + 2);
							for (const line of frame.split("\n")) {
								if (!line.startsWith("data: ")) continue;
								const data = line.slice(6);
								if (data === "") continue;
								let payload;
								try {
									payload = JSON.parse(data);
								} catch {
									continue;
								}
								onFrame(payload);
							}
						}
					}
					buffer += decoder.decode();
					if (!sawTerminal) {
						if (controller.signal.aborted) throw new Error("stopped");
						if (wroteDraft) finish("done", "已完成");
						else throw new Error("响应流意外结束");
					}
				} catch (error) {
					if (wroteDraft) inputActions.setDraft(original);
					if (controller.signal.aborted) finish("error", "已停止优化");
					else finish("error", `失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					if (abortRef.current === controller) abortRef.current = null;
					if (reader !== null) reader.cancel().catch(() => {});
				}
			};
			/** 多轮优化：每轮基于当前草稿（上一轮选中的候选）继续优化，卡片顶部固定展示最初「原话」。 */
			const optimizeMulti = async (provider, model) => {
				if (input.draft !== lastWrittenRef.current) {
					sourceRef.current = input.draft;
					setSourceText(input.draft);
					roundRef.current = 1;
					setRound(1);
				} else {
					roundRef.current += 1;
					setRound(roundRef.current);
				}
				const text = input.draft.trim();
				setPhase("optimizing");
				setDetail(`第 ${String(roundRef.current)} 轮 · 正在生成 ${String(CANDIDATE_COUNT)} 个候选…`);
				setCandidates([]);
				const controller = new AbortController();
				abortRef.current = controller;
				let reader = null;
				try {
					const response = await fetch("/api/dsh-webui-prompt-optimizer", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							provider,
							model,
							text,
							multi: true,
							count: CANDIDATE_COUNT,
							sessionId
						}),
						signal: controller.signal
					});
					if (!response.ok) throw new Error(`优化请求失败（HTTP ${String(response.status)}）`);
					if (response.body === null) throw new Error("无响应流");
					reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					let sawTerminal = false;
					let received = 0;
					const onFrame = (payload) => {
						if (payload.type === "candidate" && typeof payload.index === "number" && typeof payload.text === "string") {
							const index = payload.index;
							const text = payload.text;
							setCandidates((prev) => {
								const next = prev.slice();
								next[index] = text;
								return next;
							});
							received += 1;
							setDetail(`正在生成候选 ${String(received)}/${String(CANDIDATE_COUNT)}…`);
							return;
						}
						if (payload.type === "done") {
							sawTerminal = true;
							setPhase("multi");
							setDetail("");
							return;
						}
						if (payload.type === "error") {
							sawTerminal = true;
							throw new Error(payload.message ?? "优化失败");
						}
					};
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						let idx;
						while ((idx = buffer.indexOf("\n\n")) !== -1) {
							const frame = buffer.slice(0, idx);
							buffer = buffer.slice(idx + 2);
							for (const line of frame.split("\n")) {
								if (!line.startsWith("data: ")) continue;
								const data = line.slice(6);
								if (data === "") continue;
								let payload;
								try {
									payload = JSON.parse(data);
								} catch {
									continue;
								}
								onFrame(payload);
							}
						}
					}
					buffer += decoder.decode();
					if (!sawTerminal) {
						if (controller.signal.aborted) throw new Error("stopped");
						throw new Error("响应流意外结束");
					}
				} catch (error) {
					if (controller.signal.aborted) finish("error", "已停止优化");
					else finish("error", `失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					if (abortRef.current === controller) abortRef.current = null;
					if (reader !== null) reader.cancel().catch(() => {});
				}
			};
			/** 点选某个候选：写回草稿并滑出关闭卡片。 */
			const pickCandidate = (text) => {
				inputActions.setDraft(text);
				lastWrittenRef.current = text;
				closeMultiCard();
			};
			/** 滑出并关闭多轮候选卡片（播完动画再卸载）。 */
			const closeMultiCard = () => {
				if (closing) return;
				setClosing(true);
				window.setTimeout(() => {
					setClosing(false);
					setPhase((prev) => prev === "multi" ? "idle" : prev);
					setCandidates([]);
					setDetail("");
				}, 150);
			};
			const panelVisible = hovered || phase !== "idle";
			const statusClass = phase === "optimizing" ? css.statusOptimizing : phase === "done" ? css.statusDone : phase === "error" ? css.statusError : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: css.root,
				onMouseEnter: showPanel,
				onMouseLeave: scheduleHide,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: css.trigger,
						"aria-label": "自动优化提示词",
						title: "自动优化提示词",
						disabled: busy,
						onClick: () => {
							optimize();
						},
						children: busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { className: css.busy }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSparkle16, {})
					}),
					panelVisible && phase !== "multi" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: `${css.panel} dsh-glass-anim-in`,
						role: "group",
						"aria-label": "提示词优化面板",
						onMouseEnter: showPanel,
						onMouseLeave: scheduleHide,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: css.panelTitle,
								children: "优化提示词"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: css.caption,
								children: [
									"用 ",
									modelName,
									" 优化当前草稿"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: css.options,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: css.option,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: css.optionLabel,
											children: "多轮优化"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "switch",
											"aria-checked": multiRound,
											"aria-label": "多轮优化",
											className: classNames(css.switch, multiRound && css.switchOn),
											onClick: toggleMulti,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: classNames(css.knob, multiRound && css.knobOn) })
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: css.option,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: css.optionLabel,
											children: "设定目标"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "switch",
											"aria-checked": setTarget,
											"aria-label": "设定目标提示词",
											className: classNames(css.switch, setTarget && css.switchOn),
											onClick: toggleTarget,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: classNames(css.knob, setTarget && css.knobOn) })
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: css.option,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: css.optionLabel,
											children: "浏览器验证"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "switch",
											"aria-checked": verifyWithBrowser,
											"aria-label": "使用 AI 浏览器验证",
											className: classNames(css.switch, verifyWithBrowser && css.switchOn),
											onClick: toggleVerify,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: classNames(css.knob, verifyWithBrowser && css.knobOn) })
										})]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: classNames(css.status, statusClass),
								children: [phase === "optimizing" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { className: css.busy }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: phase === "idle" ? multiRound ? "点击生成多个候选" : "点击用当前模型优化" : detail })]
							}),
							busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: css.stop,
								onClick: stop,
								children: "停止优化"
							})
						]
					}),
					phase === "multi" && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classNames(css.panel, css.panelMulti, closing ? css.panelClosing : "dsh-glass-anim-in"),
						role: "group",
						"aria-label": "多轮优化候选",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: css.multiBody,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: css.panelTitle,
									children: [
										"多轮优化候选 · 第 ",
										round,
										" 轮"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: css.caption,
									children: "点选任意候选即可写入对话框，再点优化进入下一轮；顶部「原话」始终保留你最初写的内容。"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: css.sourceBlock,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: css.sourceLabel,
										children: "原话"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: css.sourceText,
										children: sourceText
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: css.candidates,
									children: candidates.map((text, index) => text.trim() === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: css.candidate,
										onClick: () => {
											pickCandidate(text);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: css.candidateHead,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: css.candidateLabel,
												children: CANDIDATE_LABELS[index] ?? `候选 ${String(index + 1)}`
											}), index === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: css.recommendBadge,
												children: "推荐"
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: css.candidateText,
											children: text
										})]
									}, index))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: css.closeCard,
									onClick: closeMultiCard,
									children: "关闭"
								})
							]
						})
					}), document.body)
				]
			});
		}
		//#endregion
		//#region src/client/prompt-optimize/index.ts
		/**
		* 挂载提示词优化图标入口。
		* @param ctx - client root context。
		*/
		function applyPromptOptimize(ctx) {
			ctx.inject([
				"slots",
				"modelDirectories",
				"sessions"
			], (scope) => {
				const models = scope.modelDirectories;
				const sessions = scope.sessions;
				scope.slots.inject("conversation.input.right", () => scope.slots.register({
					name: "conversation.input.right",
					id: "dsh-webui-prompt-optimizer",
					order: 5,
					inject: (sessionId) => {
						const directory = models.directoryFor(sessionId);
						return {
							available: sessions.subagentAddress(sessionId) === void 0,
							directory: directory.store,
							sessionId
						};
					}
				}, PromptOptimizeButton));
			});
		}
		//#endregion
		//#region src/client/index.ts
		const name = "dsh-webui-prompt-optimizer-client";
		const inject = [
			"slots",
			"modelDirectories",
			"sessions"
		];
		function apply(ctx) {
			applyPromptOptimize(ctx);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map