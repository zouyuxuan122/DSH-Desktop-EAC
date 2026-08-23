window.__ModuleLoader__.load({
	id: "@vlln/dsh-navbar",
	factory: (require) => {
		var module = { exports: {} };
		module.exports;
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
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#endregion
		module.exports = {
			name: "navbar-client",
			inject: ["locale", "slots"],
			apply(ctx) {
				const body = document.body;
				if (body === null) return;
				const STYLE_ID = "dsh-navbar-style";
				if (document.getElementById(STYLE_ID) === null) {
					const style = document.createElement("style");
					style.id = STYLE_ID;
					style.textContent = `
[data-dsh-navbar] {
  position: fixed; top: 50%; transform: translateY(-50%); z-index: 950;
  display: flex; flex-direction: column; gap: 10px; padding: 8px;
  border-radius: 12px; font-family: system-ui;
  max-height: calc(100vh - 32px); overflow-y: auto;
  scrollbar-width: none;
  background: transparent; border: 1px solid transparent;
  transition: background .18s ease, border-color .18s ease;
}
[data-dsh-navbar]::-webkit-scrollbar { display: none; }
[data-dsh-navbar]:hover {
  /* 无背景无边框：用户不要悬停时的胶囊圆角矩形（节点自身 hover 已够）。 */
}
[data-vlln-dot] {
  width: 7px; height: 7px; border-radius: 999px; padding: 0; border: none;
  background: rgba(128, 128, 140, .45); cursor: pointer; flex: none; position: relative;
  /* width 过渡只挂在增长态（active/hover/pinned）上：获得时平滑拉长，
   * 失去时立即缩回——否则旧激活药丸会在 .22s 收缩动画里以"灰色宽药丸"
   * 形态残留（点击跳转后底部出现幻影药丸）。 */
  transition: background .22s ease, transform .22s ease;
}
/* 命中区放大：视觉药丸仍 7px，::after 向四周扩 3px（13px 热区）。整条可点
 * 已覆盖点击，命中区只需小幅放大辅助直接点中药丸。 */
[data-vlln-dot]::after {
  content: ''; position: absolute; inset: -3px; border-radius: 999px;
}
/* :hover 伪类无视觉效果：hover 视觉统一由 .hover class（applyHover 门控）提供。
 * 伪类由 ::after 命中区触发、超出节点串范围时不受门控，scale 会造成
 * 边缘药丸 28px/9px 等不一致状态。 */
[data-vlln-dot]:hover { }
/* 增长态挂宽度过渡：获得 active/hover/pinned 时平滑拉长。 */
[data-vlln-dot].active, [data-vlln-dot].hover, [data-vlln-dot].pinned {
  transition: width .22s ease, height .22s ease, background .22s ease, transform .22s ease;
}
[data-vlln-dot].active {
  width: 22px; border-radius: 999px;
  background: var(--dsw-alias-text-accent, #4c9aff);
}
/* 悬停跟随：最近药丸加长（灰色，非品牌蓝），指示"整条可点"的点击落点。
 * transform:none 抵消 :hover 的 scale(1.25)——加长后宽度统一 22px。 */
[data-vlln-dot].hover {
  width: 22px; border-radius: 999px; transform: none;
  background: rgba(128, 128, 140, .8);
}
/* 悬停中的激活药丸保持品牌蓝（active 优先）。 */
[data-vlln-dot].active.hover { background: var(--dsw-alias-text-accent, #4c9aff); }
[data-vlln-preview] {
  /* 与官方 session 预览卡（HoverCard）同款：实色 #2C2C2E 双主题一致、
   * 244 宽、r12、lv3 阴影——同类型 hover 预览卡视觉统一，不用玻璃。 */
  position: fixed; z-index: 910; width: 244px; box-sizing: border-box;
  padding: 12px 16px; border-radius: 12px; font-size: 12px; line-height: 1.55;
  color: var(--dsw-alias-text-1, #eee);
  background: var(--dsw-hovercard-bg, #2C2C2E);
  box-shadow: var(--dsw-shadow-lv3);
  overflow: hidden; white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical;
  pointer-events: none;
}
[data-vlln-more] { width: 3px; height: 3px; border-radius: 999px; background: rgba(128,128,140,.5); flex: none; }
[data-vlln-dot].pinned {
  /* 精选轮次：金色细长椭圆盘——与普通深灰圆点（7×7）和激活蓝药丸
   * （22×7）都不同的第三形态，尺寸适中、hover 不膨胀突兀。 */
  width: 14px; height: 8px; border-radius: 999px; background: #f0b429;
}
/* 精选盘 hover 同样加长（保持金色，与普通药丸一致的 hover 反馈）。 */
[data-vlln-dot].pinned.hover {
  width: 22px; height: 8px; background: #f0b429;
}
[data-vlln-dot].active.pinned {
  /* 激活中的精选点：拉长为金色胶囊，保持"盘"的细长形态语义。 */
  width: 22px; height: 8px; border-radius: 999px;
  background: #f0b429; filter: none;
}
[data-vlln-pin-button] {
  width: 28px; height: 28px; padding: 6px; border: none; border-radius: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-tertiary); background: transparent; cursor: pointer;
  transition: background .18s ease, color .18s ease;
}
[data-vlln-pin-button]:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
[data-vlln-pin-button][data-active] { color: #f0b429; }
@media (prefers-reduced-motion: reduce) {
  [data-dsh-navbar], [data-vlln-dot], [data-vlln-dot].active {
    transition: none; animation: none;
  }
}
`;
					document.head.appendChild(style);
				}
				const bar = document.createElement("nav");
				bar.setAttribute("data-dsh-navbar", "");
				bar.setAttribute("aria-label", "用户消息导航");
				body.appendChild(bar);
				const preview = document.createElement("div");
				preview.setAttribute("data-vlln-preview", "");
				preview.style.display = "none";
				body.appendChild(preview);
				const flowOf = () => document.querySelector("[data-chat-flow=\"\"]") ?? document.querySelector("[data-focus-flow=\"\"]");
				const scrollerOf = () => {
					const flow = flowOf();
					if (flow === null) return null;
					let n = flow.parentElement;
					while (n !== null) {
						const s = getComputedStyle(n);
						if (s.overflowY === "auto" || s.overflowY === "scroll") return n;
						n = n.parentElement;
					}
					return null;
				};
				const allRows = () => [...document.querySelectorAll("[data-time-hover-root]")].filter((row) => !row.hasAttribute("data-pending-steering"));
				const userRows = () => allRows().filter((row) => !row.hasAttribute("data-turn-tail") && row.querySelector("[class*=\"bubble\"]") !== null);
				const position = () => {
					const flow = flowOf();
					if (flow === null) return;
					const right = flow.getBoundingClientRect().right;
					// 布局重排瞬间（会话切换 / 侧栏折叠动画中）flow 的 rect 可能是
					// 0 或 NaN：此时移动 bar 会把它钉到错误位置（视觉上"消失"）。
					// 保留原位，等 observer 在布局稳定后再次触发 position。
					if (!Number.isFinite(right) || right <= 0) return;
					const next = Math.round(Math.min(right + 12, window.innerWidth - bar.offsetWidth - 8));
					const nextLeft = `${Math.max(8, next)}px`;
					if (bar.style.left !== nextLeft) bar.style.left = nextLeft;
				};
				let posScheduled = false;
				const requestPosition = () => {
					if (posScheduled) return;
					posScheduled = true;
					requestAnimationFrame(() => {
						posScheduled = false;
						position();
					});
				};
				let activeIndex = -1;
				const computeActive = () => {
					const rows = userRows();
					if (rows.length === 0) return -1;
					let best = 0;
					let found = false;
					let bestTop = Number.POSITIVE_INFINITY;
					for (let i = 0; i < rows.length; i++) {
						const top = rows[i].getBoundingClientRect().top;
						if (top >= 0 && top < bestTop) {
							bestTop = top;
							best = i;
							found = true;
						}
					}
					return found ? best : rows.length - 1;
				};
				const WINDOW = 11;
				const HALF_WINDOW = 5;
				let lo = 0;
				let builtRows = [];
				let currentSessionId = null;
				const syncSessionId = () => {
					const btn = document.querySelector("[data-vlln-pin-button][data-session-id]");
					if (btn !== null) currentSessionId = btn.getAttribute("data-session-id") ?? currentSessionId;
				};
				const pinStore = {
					key(sessionId) {
						return `dsh-navbar:pins:${sessionId}`;
					},
					load(sessionId) {
						try {
							return JSON.parse(localStorage.getItem(this.key(sessionId)) ?? "[]");
						} catch {
							return [];
						}
					},
					isPinned(sessionId, messageId) {
						return this.load(sessionId).some((p) => p.messageId === messageId);
					},
					textOf(sessionId, messageId) {
						return this.load(sessionId).find((p) => p.messageId === messageId)?.text;
					},
					turnsOf(sessionId) {
						const s = /* @__PURE__ */ new Set();
						for (const p of this.load(sessionId)) if (p.turn !== void 0 && Number.isFinite(p.turn)) s.add(p.turn);
						return s;
					},
					textOfTurn(sessionId, turn) {
						return this.load(sessionId).find((p) => p.turn === turn)?.text;
					},
					toggle(sessionId, messageId, text, turn) {
						const pins = this.load(sessionId);
						const i = pins.findIndex((p) => p.messageId === messageId);
						if (i >= 0) pins.splice(i, 1);
						else pins.push({
							messageId,
							text,
							ts: Date.now(),
							turn
						});
						localStorage.setItem(this.key(sessionId), JSON.stringify(pins));
						return i < 0;
					}
				};
				const positionPreview = (anchor) => {
					const r = anchor.getBoundingClientRect();
					preview.style.right = `${window.innerWidth - r.left + 14}px`;
					preview.style.top = `${Math.min(window.innerHeight - 120, r.top - 12)}px`;
				};
				const showPreview = (row, anchor, pinnedRow = null) => {
					let text;
					if (pinnedRow !== null) {
						const turn = Number(pinnedRow.getAttribute("data-turn-tail") ?? NaN);
						text = ((Number.isFinite(turn) && currentSessionId !== null ? pinStore.textOfTurn(currentSessionId, turn) : void 0) ?? pinnedRow.getAttribute("data-vlln-pin-text") ?? "").trim();
						if (text === "") text = ((row.querySelector("[class*=\"bubble\"]") ?? row).textContent ?? "").trim();
					} else text = ((row.querySelector("[class*=\"bubble\"]") ?? row).textContent ?? "").trim();
					if (text === "") return;
					preview.textContent = text;
					preview.style.display = "block";
					positionPreview(anchor);
				};
				const hidePreview = () => {
					preview.style.display = "none";
				};
				const pinnedRowOf = (all, rows, i, turns) => {
					let start = -1;
					for (let k = 0; k < all.length; k++) if (all[k] === rows[i]) {
						start = k;
						break;
					}
					if (start < 0) return null;
					const end = i + 1 < rows.length ? all.indexOf(rows[i + 1]) : all.length;
					if (end < 0) return null;
					for (let k = start; k < end; k++) {
						const row = all[k];
						if (row.hasAttribute("data-vlln-pinned")) return row;
						const turn = Number(row.getAttribute("data-turn-tail") ?? NaN);
						if (Number.isFinite(turn) && turns.has(turn)) return row;
					}
					return null;
				};
				const render = () => {
					position();
					if (flowOf() === null) {
						bar.style.display = "none";
						return;
					}
					const rows = userRows();
					if (rows.length < 2) {
						bar.style.display = "none";
						return;
					}
					bar.style.display = "flex";
					const active = computeActive();
					activeIndex = active;
					const all = allRows();
					syncSessionId();
					const pinnedTurns = currentSessionId !== null ? pinStore.turnsOf(currentSessionId) : /* @__PURE__ */ new Set();
					const pinnedRowOfTurn = (i) => pinnedRowOf(all, rows, i, pinnedTurns);
					const pinnedIndexes = [];
					for (let i = 0; i < rows.length; i++) if (pinnedRowOfTurn(i) !== null) pinnedIndexes.push(i);
					const windowed = rows.length > WINDOW;
					lo = windowed ? Math.max(0, active - HALF_WINDOW) : 0;
					let hi = windowed ? Math.min(rows.length - 1, active + HALF_WINDOW) : rows.length - 1;
					if (pinnedIndexes.length > 0) {
						lo = Math.min(lo, pinnedIndexes[0]);
						hi = Math.max(hi, pinnedIndexes[pinnedIndexes.length - 1]);
					}
					const expectedCount = hi - lo + 1 + (lo > 0 ? 1 : 0) + (hi < rows.length - 1 ? 1 : 0);
					if (rows.length === builtRows.length && rows.every((row, i) => row === builtRows[i]) && bar.childElementCount === expectedCount) {
						updateActiveClass(active);
						[...bar.querySelectorAll("[data-vlln-dot]")].forEach((dot, i) => {
							if (pinnedRowOfTurn(i + lo) !== null) dot.classList.add("pinned");
							else dot.classList.remove("pinned");
						});
						return;
					}
					bar.textContent = "";
					if (windowed && lo > 0) {
						const more = document.createElement("span");
						more.setAttribute("data-vlln-more", "");
						bar.appendChild(more);
					}
					for (let i = lo; i <= hi; i++) {
						const dot = document.createElement("button");
						dot.type = "button";
						dot.setAttribute("data-vlln-dot", "");
						const pinnedRow = pinnedRowOfTurn(i);
						dot.setAttribute("aria-label", `user #${i + 1}${pinnedRow !== null ? "（已精选）" : ""}（点击跳转）`);
						const p = i - lo;
						dot.addEventListener("focus", () => {
							const row = userRows()[lo + p];
							if (row !== void 0) showPreview(row, dot, pinnedRowOfTurn(lo + p));
						});
						dot.addEventListener("blur", hidePreview);
						dot.addEventListener("click", () => {
							const row = userRows()[lo + p];
							if (row !== void 0) jumpToRow(pinnedRowOfTurn(lo + p) ?? row);
						});
						if (i === active) dot.classList.add("active");
						if (pinnedRow !== null) dot.classList.add("pinned");
						bar.appendChild(dot);
					}
					if (windowed && hi < rows.length - 1) {
						const more = document.createElement("span");
						more.setAttribute("data-vlln-more", "");
						bar.appendChild(more);
					}
					builtRows = rows;
				};
				const jumpToRow = (row) => {
					const scroller = scrollerOf();
					if (scroller === null) return;
					scroller.dispatchEvent(new WheelEvent("wheel", {
						deltaY: -1,
						bubbles: true,
						cancelable: true
					}));
					scroller.scrollTop = scroller.scrollTop + row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
				};
				const updateActiveClass = (active) => {
					[...bar.querySelectorAll("[data-vlln-dot]")].forEach((dot, i) => {
						if (i + lo === active) dot.classList.add("active");
						else dot.classList.remove("active");
					});
				};
				const updateActive = () => {
					const next = computeActive();
					if (next === activeIndex) return;
					activeIndex = next;
					render();
				};
				let flow = flowOf();
				let sizeObserver = null;
				const bindFlow = () => {
					const next = flowOf();
					if (next === flow) return false;
					flow = next;
					sizeObserver?.disconnect();
					sizeObserver = null;
					if (flow !== null) {
						sizeObserver = new ResizeObserver(() => {
							requestPosition();
						});
						let el = flow;
						while (el !== null && el !== document.body) {
							sizeObserver.observe(el);
							el = el.parentElement;
						}
					}
					position();
					return true;
				};
				bindFlow();
				window.addEventListener("resize", requestPosition);
				let scrollScheduled = false;
				const runUpdate = () => {
					scrollScheduled = false;
					updateActive();
				};
				let io = null;
				const bindIO = () => {
					io?.disconnect();
					const root = scrollerOf();
					if (root === null) return;
					io = new IntersectionObserver(() => {
						if (scrollScheduled) return;
						scrollScheduled = true;
						requestAnimationFrame(runUpdate);
					}, {
						root,
						rootMargin: "0px 0px -15% 0px",
						threshold: [
							0,
							.25,
							.5,
							.75,
							1
						]
					});
					userRows().forEach((row) => {
						io?.observe(row);
					});
				};
				bindIO();
				render();
				let scheduled = false;
				const schedule = () => {
					if (scheduled) return;
					scheduled = true;
					requestAnimationFrame(() => {
						scheduled = false;
						render();
					});
				};
				const observer = new MutationObserver((mutations) => {
					if (bindFlow()) {
						bindIO();
						schedule();
						return;
					}
					bindIO();
					// 任何非 bar/preview 自身的 DOM 变化都触发重渲染：
					// 侧栏折叠/展开、better-sidebar 面板开关、浮窗出现等兄弟节点
					// 布局变化同样会改变对话流的几何位置，只响应 flow 内部变化
					// 会让 bar 停在旧位置（视觉上"消失"）。schedule 自带 rAF 节流。
					for (const m of mutations) {
						if (m.target === bar || bar.contains(m.target)) continue;
						if (m.target === preview || preview.contains(m.target)) continue;
						schedule();
						return;
					}
				});
				observer.observe(body, {
					childList: true,
					subtree: true
				});
				const nearestDot = (y) => {
					const dots = [...bar.querySelectorAll("[data-vlln-dot]")];
					if (dots.length === 0) return null;
					let best = null;
					let bestDist = Number.POSITIVE_INFINITY;
					for (const dot of dots) {
						const r = dot.getBoundingClientRect();
						const d = Math.abs(r.top + r.height / 2 - y);
						if (d < bestDist) {
							bestDist = d;
							best = dot;
						}
					}
					if (best === null) return null;
					const row = userRows()[lo + dots.indexOf(best)];
					if (row === void 0) return null;
					return {
						dot: best,
						row
					};
				};
				const hoverableDot = (y) => {
					const dots = [...bar.querySelectorAll("[data-vlln-dot]")];
					if (dots.length === 0) return null;
					const first = dots[0].getBoundingClientRect();
					const last = dots[dots.length - 1].getBoundingClientRect();
					if (y < first.top - 1 || y > last.bottom + 1) return null;
					return nearestDot(y);
				};
				let hoverScheduled = false;
				let hoverRow = null;
				let hoverAnchor = null;
				let hoverDotEl = null;
				let lastHoverY = null;
				const setHoverDot = (dot) => {
					if (hoverDotEl === dot) return;
					hoverDotEl?.classList.remove("hover");
					hoverDotEl = dot;
					dot?.classList.add("hover");
				};
				const applyHover = (y) => {
					const hit = hoverableDot(y);
					setHoverDot(hit !== null ? hit.dot : null);
					if (hit === null) {
						hoverRow = null;
						hoverAnchor = null;
						hidePreview();
						return;
					}
					if (hoverRow === hit.row && hoverAnchor === hit.dot) return;
					hoverRow = hit.row;
					hoverAnchor = hit.dot;
					const dots = [...bar.querySelectorAll("[data-vlln-dot]")];
					const turns = currentSessionId !== null ? pinStore.turnsOf(currentSessionId) : /* @__PURE__ */ new Set();
					const pinned = pinnedRowOf(allRows(), userRows(), lo + dots.indexOf(hit.dot), turns);
					showPreview(hit.row, hit.dot, pinned);
				};
				const onBarMove = (e) => {
					lastHoverY = e.clientY;
					if (hoverScheduled) return;
					hoverScheduled = true;
					requestAnimationFrame(() => {
						hoverScheduled = false;
						if (lastHoverY !== null) applyHover(lastHoverY);
					});
				};
				bar.addEventListener("mousemove", onBarMove);
				bar.addEventListener("mouseleave", () => {
					lastHoverY = null;
					setHoverDot(null);
					hoverRow = null;
					hoverAnchor = null;
					hidePreview();
				});
				bar.addEventListener("click", (e) => {
					const t = e.target;
					if (t !== null && t.closest("[data-vlln-dot]") !== null) return;
					const hit = nearestDot(e.clientY);
					if (hit === null) return;
					const dots = [...bar.querySelectorAll("[data-vlln-dot]")];
					const turns = currentSessionId !== null ? pinStore.turnsOf(currentSessionId) : /* @__PURE__ */ new Set();
					const pinned = pinnedRowOf(allRows(), userRows(), lo + dots.indexOf(hit.dot), turns);
					jumpToRow(pinned ?? hit.row);
				});
				let lastWheelAt = 0;
				bar.addEventListener("wheel", (e) => {
					e.preventDefault();
					const now = performance.now();
					if (now - lastWheelAt < 120) return;
					lastWheelAt = now;
					const rows = userRows();
					if (rows.length < 2) return;
					const base = activeIndex >= 0 ? activeIndex : computeActive();
					if (base < 0) return;
					const next = Math.min(rows.length - 1, Math.max(0, base + (e.deltaY > 0 ? 1 : -1)));
					if (next === base) return;
					jumpToRow(rows[next]);
				}, { passive: false });
				const pinRowText = (button) => {
					let el = button?.closest("[data-time-hover-root]") ?? null;
					while (el !== null) {
						const bubble = el.querySelector("[class*=\"bubble\"]");
						if (el.hasAttribute("data-time-hover-root") && bubble !== null) {
							const text = ((bubble ?? el).textContent ?? "").trim();
							return text.length > 160 ? `${text.slice(0, 160)}…` : text;
						}
						el = el.previousElementSibling;
					}
					return "";
				};
				const syncPinRow = (button, isPinned, text) => {
					const row = button?.closest("[data-time-hover-root]");
					if (row === null || row === void 0) return;
					if (isPinned) {
						row.setAttribute("data-vlln-pinned", "");
						row.setAttribute("data-vlln-pin-text", text ?? "");
					} else {
						row.removeAttribute("data-vlln-pinned");
						row.removeAttribute("data-vlln-pin-text");
					}
					schedule();
				};
				function PinAction(props) {
					const { messageId, sessionId, t } = props;
					const [active, setActive] = react.default.useState(() => pinStore.isPinned(sessionId, messageId));
					const ref = react.default.useRef(null);
					react.default.useEffect(() => {
						syncPinRow(ref.current, pinStore.isPinned(sessionId, messageId), pinStore.textOf(sessionId, messageId));
					}, [messageId, sessionId]);
					const label = active ? t("action.unpin") : t("action.pin");
					return react.default.createElement(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label,
						side: "bottom"
					}, react.default.createElement("button", {
						type: "button",
						ref,
						"data-vlln-pin-button": "",
						"data-session-id": sessionId,
						"data-active": active || void 0,
						"aria-pressed": active,
						"aria-label": label,
						onClick: () => {
							const text = pinRowText(ref.current);
							const turn = Number(ref.current?.closest("[data-time-hover-root]")?.getAttribute("data-turn-tail") ?? NaN);
							const next = pinStore.toggle(sessionId, messageId, text, Number.isFinite(turn) ? turn : void 0);
							setActive(next);
							syncPinRow(ref.current, next, text);
						}
					}, react.default.createElement("svg", {
						width: 16,
						height: 16,
						viewBox: "0 0 24 24",
						fill: "currentColor",
						"aria-hidden": true
					}, react.default.createElement("path", { d: "M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" }))));
				}
				const PIN_NS = "pin";
				ctx.effect(() => ctx.locale.register(PIN_NS, {
					zh: {
						"action.pin": "精选",
						"action.unpin": "取消精选"
					},
					en: {
						"action.pin": "Pin",
						"action.unpin": "Unpin"
					}
				}), "navbar: pin dictionaries");
				ctx.slots.inject("conversation.chat.assistant-actions", () => {
					const dispose = ctx.slots.register({
						name: "conversation.chat.assistant-actions",
						id: "pin",
						order: 5,
						locale: PIN_NS,
						inject: (sessionId) => ({ sessionId })
					}, PinAction);
					return () => {
						dispose();
					};
				});
				return () => {
					observer.disconnect();
					sizeObserver?.disconnect();
					io?.disconnect();
					window.removeEventListener("resize", requestPosition);
					bar.remove();
					preview.remove();
					document.getElementById(STYLE_ID)?.remove();
				};
			}
		};
		return module.exports;
	}
});
