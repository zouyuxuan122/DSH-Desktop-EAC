//#region src/client/pickers.ts
/** 从字符串池里等概率随机抽一个；exclude 排除某个名字（避免连续重复） */
const pick = (pool, exclude) => {
	const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
	const src = entries.length ? entries : pool;
	return src[Math.floor(Math.random() * src.length)];
};
/** 生成 [min, max) 区间内的随机整数 */
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
/**
* 按权重在分类池中选一个分类；noMirror 分类在镜像(facing=right)时被排除，
* 剩余权重自动归一化。分类池为空时返回 null。
*/
const pickWeightedCategory = (categories, facing) => {
	const cats = categories.filter((c) => c.actions.length > 0);
	if (!cats.length) return null;
	const filtered = cats.filter((c) => !(c.noMirror && facing === "right"));
	const eligible = filtered.length ? filtered : cats;
	const totalW = eligible.reduce((s, c) => s + c.weight, 0) || 1;
	let t = Math.random() * totalW;
	for (const c of eligible) {
		t -= c.weight;
		if (t <= 0) return c;
	}
	return eligible[eligible.length - 1];
};
/**
* 按权重掷骰：roll ∈ [0,1) → 下一个动画类别（纯函数，可单测）。
* topEnd = (idle+turn+move)/100：三档权重占比之和，剩余概率归入 'action'。
*/
const rollKind = (roll, w) => {
	const topEnd = (w.idle + w.turn + w.move) / 100;
	if (roll < w.idle / 100) return "idle";
	if (roll < (w.idle + w.turn) / 100) return "turn";
	if (roll < topEnd) return "move";
	return "action";
};
/** 从分类池选一个动作；无可用分类时回退 idle 池（返回 {id, name}，纯函数）。
* facing 用于 noMirror 镜像过滤；current 用于避免连续重复（pick 的 exclude）。 */
const pickCategoryAction = (categories, idlePool, facing, current) => {
	const cat = pickWeightedCategory(categories, facing);
	if (!cat) return {
		id: "FALLBACK",
		name: pick(idlePool, current)
	};
	return {
		id: cat.id,
		name: pick(cat.actions, current)
	};
};
//#endregion
//#region src/client/motion.ts
/** 计算一次移动的起点/终点比例坐标；目标越出视口边缘（含边距）时返回 null */
const planMove = (o) => {
	const distance = randomBetween(o.minDist, o.maxDist);
	const target = o.cx + o.dir * distance;
	const leftBound = o.margin + o.halfW;
	const rightBound = o.W - o.margin - o.halfW;
	if (target < leftBound || target > rightBound) return null;
	return {
		startRatio: o.cx / o.W,
		startYRatio: o.cy / o.H,
		targetRatio: target / o.W,
		totalRatio: Math.abs(target - o.cx) / o.W
	};
};
//#endregion
//#region src/client/config.ts
/** 剥除 JSONC 注释（行注释 // 与块注释），得到纯 JSON 字符串 */
const stripJsonc = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\\:])\/\/.*$/gm, "$1").trim();
/** corner 合法性检查用的 string 集合（Corner[] 的 includes 要求 Corner 参数，无法接收未知 string） */
const CORNER_SET = /* @__PURE__ */ new Set([
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
]);
/** ClientConfig 类型占位（data-less；PetMulti 加载后由 assertClientConfig 赋真实值） */
const EMPTY_CONF = {
	notificationsEnabled: true,
	pets: [],
	animations: {
		idle: [],
		turn: [],
		drag: [],
		clicks: [],
		moves: {
			default: {},
			actions: []
		},
		categories: [],
		events: {}
	},
	animationWeights: {
		idle: 0,
		turn: 0,
		move: 0
	},
	eventsRefreshSec: {}
};
/** 校验 config.jsonc 解析结果并返回 ClientConfig；任一字段缺失/非法即视为配置错误抛出 */
function assertClientConfig(raw) {
	if (!raw || typeof raw !== "object") throw new Error("dsh-pet: config 非对象");
	const cfg = raw;
	const petsArr = cfg.pets;
	if (!Array.isArray(petsArr) || !petsArr.length) throw new Error("dsh-pet: 缺少 pets");
	const seen = /* @__PURE__ */ new Set();
	const pets = [];
	for (const p of petsArr) {
		const id = String(p?.id ?? "");
		if (!id || seen.has(id)) throw new Error("dsh-pet: pet id 非法或重复「" + id + "」");
		const size = Number(p?.size);
		if (!Number.isFinite(size) || size <= 0) throw new Error("dsh-pet: pet「" + id + "」大小非法");
		const balanceEnabled = p?.balanceEnabled;
		if (typeof balanceEnabled !== "boolean") throw new Error("dsh-pet: pet「" + id + "」缺少 balanceEnabled（需为布尔值 true/false）");
		const corner = p?.position?.corner;
		if (typeof corner !== "string" || !CORNER_SET.has(corner)) throw new Error("dsh-pet: pet「" + id + "」corner 非法");
		const marginX = Number(p?.position?.marginX);
		const marginY = Number(p?.position?.marginY);
		if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) throw new Error("dsh-pet: pet「" + id + "」边距非法");
		seen.add(id);
		pets.push({
			id,
			size,
			balanceEnabled,
			position: {
				corner,
				marginX,
				marginY
			}
		});
	}
	const a = cfg.animations;
	if (!a || typeof a !== "object") throw new Error("dsh-pet: 缺少 animations");
	for (const key of [
		"idle",
		"turn",
		"drag",
		"clicks"
	]) if (!Array.isArray(a[key])) throw new Error("dsh-pet: animations." + key + " 缺失");
	if (!a.moves || typeof a.moves !== "object" || typeof a.moves.default !== "object" || a.moves.default === null || !Array.isArray(a.moves.actions)) throw new Error("dsh-pet: animations.moves 结构非法");
	if (!Array.isArray(a.categories)) throw new Error("dsh-pet: animations.categories 缺失");
	const ev = a.events;
	if (!ev || typeof ev !== "object" || Array.isArray(ev)) throw new Error("dsh-pet: 缺少 animations.events");
	for (const [eventName, pool] of Object.entries(ev)) {
		if (!Array.isArray(pool) || pool.length === 0) throw new Error("dsh-pet: animations.events." + eventName + " 必须是非空动画名数组");
		for (const name of pool) if (typeof name !== "string" || name.length === 0) throw new Error("dsh-pet: animations.events." + eventName + " 含非法动画名");
	}
	const balance = ev.balance;
	if (!Array.isArray(balance) || balance.length === 0) throw new Error("dsh-pet: animations.events.balance 缺失或为空（余额事件必备）");
	const w = cfg.animationWeights;
	if (!w || typeof w !== "object") throw new Error("dsh-pet: 缺少 animationWeights");
	for (const key of [
		"idle",
		"turn",
		"move"
	]) {
		const v = Number(w[key]);
		if (!Number.isFinite(v) || v < 0) throw new Error("dsh-pet: animationWeights." + key + " 非法");
		w[key] = v;
	}
	const ers = cfg.eventsRefreshSec;
	if (!ers || typeof ers !== "object" || Array.isArray(ers)) throw new Error("dsh-pet: 缺少 eventsRefreshSec");
	const cleaned = {};
	for (const [eventName, sec] of Object.entries(ers)) {
		const n = Number(sec);
		if (!Number.isFinite(n) || n <= 0) throw new Error("dsh-pet: eventsRefreshSec." + eventName + " 非法（需为正数秒）");
		cleaned[eventName] = n;
	}
	if (cleaned.balance === void 0) throw new Error("dsh-pet: eventsRefreshSec.balance 缺失（余额事件周期必备）");
	const notificationsEnabled = cfg.notificationsEnabled;
	if (typeof notificationsEnabled !== "boolean") throw new Error("dsh-pet: 缺少 notificationsEnabled（需为布尔值 true/false）");
	return {
		notificationsEnabled,
		pets,
		animations: a,
		animationWeights: w,
		eventsRefreshSec: cleaned
	};
}
/** 合并宠物：用户层（{ pets }，与 jsonc 同构）全量替换默认；无用户层回落默认 */
function resolvePets(defaults, user) {
	if (user && Array.isArray(user.pets)) return user.pets.length ? user.pets : defaults;
	return defaults;
}
/** 合并用户覆盖片段到完全体配置：pets / animations / animationWeights / eventsRefreshSec 有则整体替换，缺省回落默认 */
function applyUserOverrides(base, user) {
	const next = {
		...base,
		pets: resolvePets(base.pets, user)
	};
	if (user.animations) next.animations = user.animations;
	if (user.animationWeights) next.animationWeights = user.animationWeights;
	if (user.eventsRefreshSec) next.eventsRefreshSec = user.eventsRefreshSec;
	if (user.notificationsEnabled !== void 0) next.notificationsEnabled = user.notificationsEnabled;
	return next;
}
//#endregion
//#region src/client/balance.ts
const TIMEOUT_MS = 2e4;
const RETRIES = 2;
/** 带超时 + 重试的 GET（host 已内置重试，这里再兜底网络抖动） */
async function getWithRetry(url) {
	let last;
	for (let i = 0; i <= RETRIES; i++) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
			if (res.ok) return res;
			last = /* @__PURE__ */ new Error("HTTP " + res.status);
		} catch (e) {
			last = e;
		}
		if (i < RETRIES) await new Promise((r) => setTimeout(r, 600));
	}
	throw last instanceof Error ? last : new Error(String(last));
}
/** 拉取当前状态的余额；网络/解析失败显式抛错（上层决定报错方式，绝不静默 0） */
async function fetchBalanceState() {
	const raw = await (await getWithRetry("/dsh-pet-7340/balance")).json().catch(() => null);
	if (!raw || typeof raw !== "object") throw new Error("dsh-pet: /dsh-pet-7340/balance 响应非法");
	const provider = String(raw.provider ?? "unknown");
	if (raw.ok !== true) return {
		provider,
		ok: false,
		reason: raw.reason === "unsupported" || raw.reason === "credential-missing" || raw.reason === "fetch-error" ? raw.reason : "fetch-error",
		message: typeof raw.message === "string" ? raw.message : void 0
	};
	if (raw.kind === "opencode") {
		const d = raw.data;
		if (!d || typeof d !== "object") throw new Error("dsh-pet: /dsh-pet-7340/balance opencode 数据非法");
		const rolling = Number(d.rolling);
		const weekly = Number(d.weekly);
		const monthly = Number(d.monthly);
		if (![
			rolling,
			weekly,
			monthly
		].every(Number.isFinite)) throw new Error("dsh-pet: /dsh-pet-7340/balance opencode 百分比非数字");
		return {
			provider,
			kind: "opencode",
			ok: true,
			rolling,
			weekly,
			monthly,
			rollingResetsAt: typeof d.rollingResetsAt === "string" ? d.rollingResetsAt : void 0,
			weeklyResetsAt: typeof d.weeklyResetsAt === "string" ? d.weeklyResetsAt : void 0,
			monthlyResetsAt: typeof d.monthlyResetsAt === "string" ? d.monthlyResetsAt : void 0
		};
	}
	if (raw.kind === "deepseek") {
		const d = raw.data;
		if (!d || typeof d !== "object") throw new Error("dsh-pet: /dsh-pet-7340/balance deepseek 数据非法");
		return {
			provider,
			kind: "deepseek",
			ok: true,
			currency: typeof d.currency === "string" ? d.currency : void 0,
			total: typeof d.total === "string" ? d.total : void 0,
			granted: typeof d.granted === "string" ? d.granted : void 0,
			toppedUp: typeof d.toppedUp === "string" ? d.toppedUp : void 0
		};
	}
	throw new Error("dsh-pet: /dsh-pet-7340/balance kind 非法");
}
/** DeepSeek 满额基准（¥）：余额 ≥ 该值视为 100%（未消耗），余额按比例折算为已用百分比 */
const DEEPSEEK_FULL_BALANCE_CNY = 20;
/**
* 事件档位百分比（已用百分比语义：0 = 未消耗，100 = 耗尽）：
* - opencode：取三窗口最大（风险最高者为准）
* - deepseek：余额按 DEEPSEEK_FULL_BALANCE_CNY（¥20 = 100%）折算为已用百分比
*   （余额 20 元 → 0%，10 元 → 50%，0 元 → 100%）
*/
function balancePercent(v) {
	if (v.kind === "opencode") return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
	if (v.kind === "deepseek") {
		const total = Number(v.total);
		if (!Number.isFinite(total)) return void 0;
		const remaining = Math.max(0, total) / DEEPSEEK_FULL_BALANCE_CNY * 100;
		return Math.max(0, Math.min(100, 100 - remaining));
	}
}
/**
* 余额事件档位索引（与 assets/config.jsonc 注释一致）：
* index = p === 100 ? 5 : Math.floor(p / 20)
*/
function balanceEventIndex(p) {
	if (p === 100) return 5;
	const i = Math.floor(p / 20);
	return i < 5 ? i : 4;
}
/** OpenCode 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月 */
const OPENCODE_QUOTA_USD = {
	rolling: 12,
	weekly: 30,
	monthly: 60
};
/** 窗口展示名（联想框文案用）：5h = 5 小时额度窗口、周、月 */
const WINDOW_LABELS = {
	rolling: "5h",
	weekly: "周",
	monthly: "月"
};
/** 取三窗口剩余额度最少的那个（最先到达满额度/最先用完） */
function urgentWindow(v) {
	if (v.kind !== "opencode") return void 0;
	const windows = [
		"rolling",
		"weekly",
		"monthly"
	];
	const resets = {
		rolling: v.rollingResetsAt,
		weekly: v.weeklyResetsAt,
		monthly: v.monthlyResetsAt
	};
	let best;
	for (const w of windows) {
		const percent = v[w] ?? 0;
		const quota = OPENCODE_QUOTA_USD[w];
		const remaining = quota * (100 - percent) / 100;
		const cand = {
			label: WINDOW_LABELS[w],
			percent,
			quotaUsd: quota,
			remainingUsd: remaining,
			resetsAt: resets[w]
		};
		if (best === void 0 || remaining < best.remainingUsd) best = cand;
	}
	return best;
}
/**
* 重置时间 → 相对文案（保留 1 位小数）：
* - 距重置 ≥ 4 天 → 「N.x 天」
* - 距重置 < 4 天 → 「N.x 小时」
* - 已过重置点 → 「已重置」；未知时间 → 空串
*/
function resetInText(iso) {
	if (!iso) return "";
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return "";
	const delta = t - Date.now();
	if (delta <= 0) return "已重置";
	const hoursF = delta / 36e5;
	if (hoursF >= 96) return (Math.round(hoursF / 24 * 10) / 10).toFixed(1) + " 天";
	return Math.max(.1, Math.round(hoursF * 10) / 10).toFixed(1) + " 小时";
}
/** 当前时刻的 DeepSeek 计价档位（按北京时间 Asia/Shanghai，UTC+8 无夏令时） */
function deepseekPricingTier(now = /* @__PURE__ */ new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(now);
	const pick = (type) => parts.find((p) => p.type === type)?.value;
	const weekday = pick("weekday");
	const hour = Number(pick("hour"));
	if (weekday === "Sat" || weekday === "Sun") return "idle";
	return hour >= 9 && hour < 12 || hour >= 14 && hour < 18 ? "peak" : "idle";
}
//#endregion
//#region src/client/bubble.ts
/** 气泡内联样式：白色半透明圆润泡 + 底部小尾巴指向宠物；字体用上首软糖体（本地打包，稳定）。
* 所有尺寸基于 `--dsh-pet-size`（宠物宽度 px）等比缩放——宠物放大/缩小，气泡跟随。
* 系数按默认 462px 设计：21px 字号 → ×0.0455、120px 最小宽 → 0.26、230px 最大宽 → 0.5 等。 */
const bubbleCss = [
	"@font-face{font-family:\"ShangshouSoftCandy\";src:url(\"/dsh-pet-7340/font/上首软糖体.ttf\") format(\"truetype\");font-display:swap;font-weight:400}",
	".dsh-pet-bubble{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% - var(--dsh-pet-size)*0.108);min-width:calc(var(--dsh-pet-size)*0.26);max-width:calc(var(--dsh-pet-size)*0.5);padding:calc(var(--dsh-pet-size)*0.022) calc(var(--dsh-pet-size)*0.030);border-radius:calc(var(--dsh-pet-size)*0.035);background:rgba(255,255,255,.92);color:#2b2b2b;font-family:\"ShangshouSoftCandy\",\"Yuanti SC\",\"YouYuan\",\"幼圆\",\"Comic Sans MS\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif;font-size:calc(var(--dsh-pet-size)*0.0455);line-height:1.6;z-index:3;pointer-events:none;box-shadow:0 calc(var(--dsh-pet-size)*0.009) calc(var(--dsh-pet-size)*0.035) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease;white-space:nowrap}",
	".dsh-pet-bubble::after{content:\"\";position:absolute;left:50%;bottom:calc(var(--dsh-pet-size)*-0.017);transform:translateX(-50%);border:calc(var(--dsh-pet-size)*0.017) solid transparent;border-top-color:rgba(255,255,255,.92);border-bottom:none}",
	".dsh-pet-bubble.is-on{opacity:1}",
	".dsh-pet-bubble .pet-bub-title{font-size:calc(var(--dsh-pet-size)*0.035);color:rgba(43,43,43,.6);margin-bottom:calc(var(--dsh-pet-size)*0.009)}",
	".dsh-pet-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--dsh-pet-size)*0.030)}",
	".dsh-pet-bubble .pet-bub-sub{font-size:calc(var(--dsh-pet-size)*0.035);color:rgba(43,43,43,.6)}",
	".dsh-pet-bubble .pet-bub-val{font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}",
	".dsh-pet-bubble .pet-bub-err{color:#d94f3d;font-size:calc(var(--dsh-pet-size)*0.035)}",
	".dsh-pet-bubble .pet-bub-tag{margin-left:calc(var(--dsh-pet-size)*0.013);font-size:calc(var(--dsh-pet-size)*0.022);color:rgba(43,43,43,.55);border:1px solid rgba(43,43,43,.25);border-radius:calc(var(--dsh-pet-size)*0.013);padding:0 calc(var(--dsh-pet-size)*0.009);vertical-align:1px}",
	".dsh-pet-bubble .pet-bub-tier{font-weight:700}",
	".dsh-pet-bubble .pet-bub-tier-peak{color:#e53935}",
	".dsh-pet-bubble .pet-bub-tier-idle{color:#2e9e4f}"
].join("\n");
/** 只注入一次 */
function injectBubbleCss() {
	if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-pet/bubble\"]") === null) {
		const tag = document.createElement("style");
		tag.dataset.plugin = "dsh-pet";
		tag.dataset.pluginCss = "dsh-pet/bubble";
		tag.textContent = bubbleCss;
		document.head.appendChild(tag);
	}
}
/**
* 制造余额气泡（工厂）。
* 工厂内注入样式一次（与 pet.ts 的 injectCss 同模式）；组件为哑组件，props = { state, on }。
*/
function makeBalanceBubble(rt) {
	const { h } = rt;
	injectBubbleCss();
	return function BalanceBubble({ state, on }) {
		const rows = [];
		if (state.ok) {
			if (state.kind === "opencode") {
				const w = urgentWindow(state);
				if (w) {
					const reset = resetInText(w.resetsAt);
					rows.push(h("div", {
						className: "pet-bub-row",
						children: w.label + "额度已用 " + Math.round(w.percent) + "%"
					}));
					rows.push(h("div", {
						className: "pet-bub-row pet-bub-sub",
						children: reset ? reset + "重置" : "已重置"
					}));
				} else rows.push(h("div", {
					className: "pet-bub-row",
					children: "额度数据不可用"
				}));
			} else {
				const tier = deepseekPricingTier();
				rows.push(h("div", {
					className: "pet-bub-row",
					children: h("span", { children: [
						"余额（",
						h("span", {
							className: "pet-bub-tier pet-bub-tier-" + tier,
							children: tier === "peak" ? "峰" : "谷"
						}),
						"）¥" + (state.total ?? "-")
					] })
				}));
			}
		} else {
			const msg = state.reason === "unsupported" ? "当前服务商暂不支持余额查询" : state.reason === "credential-missing" ? "缺少凭证：" + (state.message ?? "") : "余额查询失败";
			rows.push(h("div", {
				className: "pet-bub-err",
				children: msg
			}));
		}
		return h("div", {
			className: "dsh-pet-bubble" + (on ? " is-on" : ""),
			children: rows
		});
	};
}
//#endregion
//#region src/client/constants.ts
/** 点击/拖拽命中矩形（thumb 640×360 像素坐标） */
const HIT_BOX = {
	x0: 200,
	y0: 50,
	x1: 440,
	y1: 335
};
//#endregion
//#region src/client/notify.ts
let pageVisible = typeof document !== "undefined" && !document.hidden;
let pageFocused = typeof document !== "undefined" && document.hasFocus();
function refreshVisible() {
	pageVisible = !document.hidden;
}
function refreshFocused() {
	pageFocused = document.hasFocus();
}
/** 注册聚焦/可见性监听，返回解绑函数 */
function initFocusTracking() {
	if (typeof document === "undefined") return () => {};
	document.addEventListener("visibilitychange", refreshVisible);
	window.addEventListener("focus", refreshFocused);
	window.addEventListener("blur", refreshFocused);
	return () => {
		document.removeEventListener("visibilitychange", refreshVisible);
		window.removeEventListener("focus", refreshFocused);
		window.removeEventListener("blur", refreshFocused);
	};
}
/** 用户是否在看本页（页面可见且持有焦点）——是则跳过通知 */
function isPageActive() {
	return pageVisible && pageFocused;
}
const MAX_BODY = 80;
function truncate(text) {
	return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "…" : text;
}
/** 当前生效的总开关（运行中可被 reloadNotifications 更新——设置页保存后即时生效，无需刷新） */
let notifyEnabled = true;
/** 发一条系统通知；总开关关闭 / 环境不支持 / 未授权 / 聚焦本页 时静默跳过。
* 日志（【弹窗】类型：内容）在门之后记录——只有真正发出通知时才记，被门拦下的触发不产生日志。 */
function toast(title, body, icon) {
	if (!notifyEnabled) return;
	if (isPageActive()) return;
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	console.log("【弹窗】" + title + (body ? "：" + body : ""));
	try {
		const opts = {};
		if (body) opts.body = truncate(body);
		if (icon) opts.icon = icon;
		const n = new Notification(title, opts);
		n.onclick = () => {
			window.focus();
			n.close();
		};
	} catch {}
}
/** 申请浏览器通知权限。务必在用户手势（点击）下调用——无手势的自动申请可能被浏览器静默压制；
* 失败时区分原因：unsupported=环境无 Notification、denied=浏览器已标记阻止、
* rejected=用户在询问弹窗里选了阻止、error=申请过程异常/弹窗被跳过。 */
async function requestNotificationPermission() {
	if (typeof Notification === "undefined") return {
		ok: false,
		reason: "unsupported"
	};
	if (Notification.permission === "granted") return { ok: true };
	if (Notification.permission === "denied") return {
		ok: false,
		reason: "denied"
	};
	try {
		const p = await Notification.requestPermission();
		if (p === "granted") return { ok: true };
		if (p === "denied") return {
			ok: false,
			reason: "rejected"
		};
		return {
			ok: false,
			reason: "error",
			message: "权限未授予（" + p + "）"
		};
	} catch (e) {
		return {
			ok: false,
			reason: "error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
}
/** 读取系统通知总开关：与宠物配置同一条合并路径（用户层 main-config.json 优先，缺省回落默认）；
* 拉取/解析失败时不阻塞（默认开启）。 */
async function readNotificationsEnabled() {
	try {
		const base = assertClientConfig(JSON.parse(stripJsonc(await (await fetch("/dsh-pet-7340/config.jsonc")).text())));
		let user = {};
		try {
			const r = await fetch("/dsh-pet-7340/config");
			if (r.ok && r.status !== 204) {
				const parsed = await r.json().catch(() => null);
				if (parsed && typeof parsed === "object") user = parsed;
			}
		} catch {}
		return applyUserOverrides(base, user).notificationsEnabled;
	} catch {
		return true;
	}
}
/** 重读总开关（设置页保存开关后调用）；之后新触发的通知按新值执行，无需刷新页面 */
async function reloadNotifications() {
	notifyEnabled = await readNotificationsEnabled();
}
/** 通知图标 URL（pic 路由由宿主提供：assets/pic → /dsh-pet-7340/pic/<file>） */
const ICON = {
	done: "/dsh-pet-7340/pic/notify-done.png",
	error: "/dsh-pet-7340/pic/notify-error.png",
	truncated: "/dsh-pet-7340/pic/notify-truncated.png",
	approval: "/dsh-pet-7340/pic/notify-approval.png",
	question: "/dsh-pet-7340/pic/notify-question.png",
	test: "/dsh-pet-7340/pic/notify-test.png"
};
/** 图标 URL 表（设置页「获取权限」成功确认的测试通知也用） */
const NOTIFY_ICONS = ICON;
async function runMuxLoop(api, signal) {
	const seen = /* @__PURE__ */ new Set();
	for await (const env of api.events.mux({}, signal)) {
		const frame = env?.payload;
		if (!frame) continue;
		switch (frame.type) {
			case "session/event": {
				const ev = frame.event ?? {};
				if (ev.type !== "turn/end") break;
				const reason = ev.data?.reason ?? {};
				const kind = reason.kind;
				if (kind === "completed") toast("对话完成", void 0, ICON.done);
				else if (kind === "error") toast("生成失败", reason.error?.message ?? "", ICON.error);
				else if (kind === "max-tokens") toast("输出被截断", "已达到输出 token 上限", ICON.truncated);
				break;
			}
			case "approval/requested": {
				if (seen.has(env.rpcId)) break;
				seen.add(env.rpcId);
				const toolName = String(frame.toolName ?? "");
				const reason = typeof frame.reason === "string" && frame.reason ? frame.reason : "";
				toast("正在申请权限", (toolName ? "工具「" + toolName + "」" : "") + (reason ? "：" + reason : ""), ICON.approval);
				break;
			}
			case "question/requested":
				if (seen.has(env.rpcId)) break;
				seen.add(env.rpcId);
				toast("模型在等你回答", Array.isArray(frame.questions) && frame.questions[0]?.question || "", ICON.question);
		}
	}
}
async function runHostLoop(api, signal) {
	for await (const env of api.events.host({}, signal)) {
		const frame = env?.payload;
		if (!frame) continue;
		if (frame.type === "host/agent-error") toast("生成失败", typeof frame.message === "string" ? frame.message : "", ICON.error);
	}
}
/**
* 启动系统通知。引擎常驻（开关在触发时按实时值判断，不用重启）；
* 总开关开启且权限未决定时兜底申请一次权限，并行消费 mux + host 两条流。
* 流关闭/出错即整体静默退出：DSH 连接层自身负责重连，页面刷新或下个 socket 代际会重新启动。
*/
async function startNotify(api, signal) {
	notifyEnabled = await readNotificationsEnabled();
	if (typeof Notification !== "undefined" && notifyEnabled && Notification.permission === "default") requestNotificationPermission();
	const disposeFocus = initFocusTracking();
	try {
		await Promise.allSettled([runMuxLoop(api, signal), runHostLoop(api, signal)]);
	} finally {
		disposeFocus();
	}
}
//#endregion
//#region src/client/settings.ts
/**
* 桌宠配置管理设置页（settings.section 插槽，id: pet-config）
*
* - 多开：管理多个桌宠，每个宠物独立 id/size/位置（corner + marginX/Y）
* - 数据流：设置页持有「合并后的完整宠物列表」→ 保存时全量 PUT /dsh-pet-7340/config
*   （用户覆盖层 = 完整列表，加载时全量替换默认，天然支持增删）
* - 即时生效：保存/恢复默认后调用 petBridge.sync 通知容器重新渲染，无需刷新页面
*
* 样式对齐官方设置页：max-width 720px、全走 --dsw-alias-* 语义 token（主题跟随）。
*/
/** 容器与设置页共享的桥（同一 bundle 单例）：
* current=最新完整宠物列表（默认空）；sync=容器注册的重渲染回调（未注册时为无操作函数）；
* template=config.jsonc 默认宠物模板（pets[0]），「添加宠物」用它作为默认配置 */
const petBridge = {
	current: [],
	sync: () => {},
	template: void 0
};
/** 字典命名空间 */
const NS = "pet.config";
const zh = {
	nav: "桌宠配置",
	intro: "管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。",
	petsLabel: "宠物列表",
	add: "添加宠物",
	remove: "删除",
	confirmRemove: "确定删除宠物「{id}」吗？",
	confirmTitle: "确认操作",
	cancel: "取消",
	atLeastOne: "至少保留一个宠物。",
	emptyPets: "暂无宠物，点击「添加宠物」创建。",
	sizeLabel: "大小（宽度 px）",
	sizeHint: "高度自动 = 宽度 × 9/16。",
	balanceEnabled: "余额功能",
	balanceEnabledHint: "启用后该宠物触发余额动画并显示余额气泡。",
	cornerLabel: "位置",
	"corner.top-left": "左上角",
	"corner.top-right": "右上角",
	"corner.bottom-left": "左下角",
	"corner.bottom-right": "右下角",
	marginX: "水平偏移",
	marginY: "垂直偏移",
	save: "保存",
	reset: "恢复默认",
	confirmReset: "确定恢复默认吗？将删除整个用户配置（含自定义的动画池与播放权重）。",
	resetHint: "「重置」会删除整个用户配置（含自定义的动画池与播放权重），不只是宠物列表。",
	configMeta: "高级配置（文件）",
	configMetaHint: "用户配置可覆盖宠物列表 / 动画池 / 播放权重，修改后刷新或重启生效；默认配置为完整参考。",
	defaultConfig: "默认配置（只读，完整参考）",
	userConfig: "用户配置（自定义覆盖）",
	animationDir: "动画素材目录（可自定义/扩充动画）",
	saved: "已保存，桌宠即时生效。",
	loadError: "加载配置失败",
	invalid: "请检查输入：大小需为正数，边距可为任意数字。",
	busy: "保存中…",
	notifyToggle: "系统通知",
	notifyToggleHint: "对话完成 / 生成失败 / 权限申请 / 用户选择，在窗口失焦时弹出系统级通知（桌面右下角）。",
	notifyGetPermission: "获取权限",
	notifyPermissionOk: "已获得通知权限，右下角出现测试通知。",
	notifyDenyUnsupported: "当前环境不支持系统通知（浏览器无 Notification API）。",
	notifyDenyBlocked: "通知权限已被浏览器标记为「阻止」。",
	notifyDenyRejected: "你在权限询问弹窗中选择了「阻止」。",
	notifyDenyError: "申请权限时出错",
	notifyGuide: "引导：点击地址栏左侧 🔒/ⓘ →「网站设置」→「通知」→ 改为「允许」，刷新页面后重试。"
};
const en = {
	nav: "Pet Config",
	intro: "Manage multiple pets: each pet has its own size and position (applies instantly after saving).",
	petsLabel: "Pets",
	add: "Add pet",
	remove: "Remove",
	confirmRemove: "Delete pet \"{id}\"?",
	confirmTitle: "Confirm action",
	cancel: "Cancel",
	atLeastOne: "Keep at least one pet.",
	emptyPets: "No pets yet — click \"Add pet\" to create one.",
	sizeLabel: "Size (width px)",
	sizeHint: "Height is automatic = width × 9/16.",
	balanceEnabled: "Balance",
	balanceEnabledHint: "When enabled, this pet plays balance animations and shows the balance bubble.",
	cornerLabel: "Position",
	"corner.top-left": "Top-left",
	"corner.top-right": "Top-right",
	"corner.bottom-left": "Bottom-left",
	"corner.bottom-right": "Bottom-right",
	marginX: "Horizontal offset",
	marginY: "Vertical offset",
	save: "Save",
	reset: "Reset to default",
	confirmReset: "Reset to default? This deletes the whole user config (including custom animation pools & weights).",
	resetHint: "\"Reset\" deletes the whole user config (including custom animation pools & weights), not just the pet list.",
	configMeta: "Advanced (files)",
	configMetaHint: "User config may override pets / animation pools / weights — refresh or restart to apply. The default config is the complete reference.",
	defaultConfig: "Default config (read-only, complete reference)",
	userConfig: "User config (custom overrides)",
	animationDir: "Animation assets dir (add/customize animations here)",
	saved: "Saved — the pets updated instantly.",
	loadError: "Failed to load config",
	invalid: "Check your input: size must be positive; margins can be any number.",
	busy: "Saving…",
	notifyToggle: "System notifications",
	notifyToggleHint: "OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.",
	notifyGetPermission: "Get permission",
	notifyPermissionOk: "Notification permission granted — a test notification was sent.",
	notifyDenyUnsupported: "System notifications are not supported in this environment (no Notification API).",
	notifyDenyBlocked: "Notification permission is blocked by the browser.",
	notifyDenyRejected: "You chose \"Block\" in the permission prompt.",
	notifyDenyError: "Failed to request permission",
	notifyGuide: "Guide: click the 🔒/ⓘ icon next to the address bar → Site settings → Notifications → set to \"Allow\", then refresh and retry."
};
/**
* 制造「桌宠配置」设置页组件（工厂函数）。
*
* 为什么是工厂而非直接定义组件：client 半侧是 __ModuleLoader__ 单文件形态，
* react 能力不能顶层 import，只能由 DSH 的 require('react') 在运行时注入，
* 因此把组件依赖作为参数传入，在工厂内制造出可用的组件后再注册进设置页插槽。
*
* @param rt        运行时注入的依赖集合
* @param rt.h      react/jsx-runtime 的 jsx 函数（即 factory 里的 `h`）——
*                  用于手写 React 元素，如 `h('button', { onClick, children: '保存' })`
* @param rt.useState react 的 useState hook——管理页面内可变状态
*                  （宠物列表 / 选中项 / 忙碌 / 保存消息），值变化时自动重渲染
* @param rt.t      locale 绑定到本插件的翻译函数（ctx.locale.bind(NS)）——
*                  取中英文文案，如 `t('nav')` → '桌宠配置' / 'Pet Config'
* @returns PetConfigSection 组件：即整个「桌宠配置」设置页
*          （props 仅有 close，由设置页外壳提供，本页当前未使用）
*/
function makePetConfigSection(rt) {
	const { h, useState, useEffect, t } = rt;
	const CORNERS = [
		"top-left",
		"top-right",
		"bottom-left",
		"bottom-right"
	];
	const cornerLabel = (c) => t("corner." + c);
	const inputStyle = {
		boxSizing: "border-box",
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: "8px",
		background: "var(--dsw-alias-bg-layer-1)",
		color: "var(--dsw-alias-label-primary)",
		padding: "5px 10px",
		fontSize: "13px",
		minHeight: "28px",
		outline: "none"
	};
	/** 生成一个未占用的宠物 id（pet-2、pet-3…） */
	const nextId = (list) => {
		let n = 2;
		for (;; n++) {
			const id = "pet-" + n;
			if (!list.some((p) => p.id === id)) return id;
		}
	};
	return function PetConfigSection() {
		const initPets = petBridge.current;
		const [pets, setPets] = useState(initPets.map((p) => ({
			...p,
			position: { ...p.position }
		})));
		const [selId, setSelId] = useState(initPets[0]?.id ?? "");
		const [busy, setBusy] = useState(false);
		const [msg, setMsg] = useState({
			kind: "",
			text: ""
		});
		const [confirm, setConfirm] = useState(null);
		const [paths, setPaths] = useState(null);
		useEffect(() => {
			fetch("/dsh-pet-7340/config/meta").then((r) => r.ok ? r.json() : null).then((p) => setPaths(p)).catch(() => console.warn("[dsh-pet] 读取配置文件路径失败"));
		}, []);
		const [notifyEnabled, setNotifyEnabled] = useState(true);
		const [permMsg, setPermMsg] = useState({
			kind: "",
			text: ""
		});
		useEffect(() => {
			let alive = true;
			fetch("/dsh-pet-7340/config").then((r) => r.ok && r.status !== 204 ? r.json() : null).then((d) => {
				if (alive && d && typeof d.notificationsEnabled === "boolean") setNotifyEnabled(d.notificationsEnabled);
			}).catch(() => {});
			return () => {
				alive = false;
			};
		}, []);
		const toggleNotify = async (v) => {
			setBusy(true);
			setMsg({
				kind: "",
				text: ""
			});
			try {
				if (v) await requestNotificationPermission();
				const res = await fetch("/dsh-pet-7340/config", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						pets,
						notificationsEnabled: v
					})
				});
				if (!res.ok) throw new Error("HTTP " + res.status);
				setNotifyEnabled(v);
				petBridge.current = pets;
				petBridge.sync(pets);
				reloadNotifications();
				setMsg({
					kind: "ok",
					text: t("saved")
				});
			} catch {
				setMsg({
					kind: "err",
					text: t("loadError")
				});
			} finally {
				setBusy(false);
			}
		};
		const grantNotifyPermission = async () => {
			setPermMsg({
				kind: "",
				text: ""
			});
			const r = await requestNotificationPermission();
			if (!r.ok) {
				const reason = r.reason === "unsupported" ? t("notifyDenyUnsupported") : r.reason === "denied" ? t("notifyDenyBlocked") : r.reason === "rejected" ? t("notifyDenyRejected") : t("notifyDenyError") + (r.message ? "：" + r.message : "");
				setPermMsg({
					kind: "err",
					text: reason + (r.reason === "unsupported" ? "" : " " + t("notifyGuide"))
				});
				return;
			}
			try {
				new Notification("测试通知", {
					body: "【dsh-pet】系统通知已就绪。",
					icon: NOTIFY_ICONS.test
				});
			} catch {}
			setPermMsg({
				kind: "ok",
				text: t("notifyPermissionOk")
			});
		};
		const cur = pets.find((p) => p.id === selId) ?? null;
		const updateSel = (patch) => setPets((list) => list.map((p) => {
			if (p.id !== selId) return p;
			const { position: posPatch, ...rest } = patch;
			return {
				...p,
				...rest,
				position: posPatch ? {
					...p.position,
					...posPatch
				} : p.position
			};
		}));
		const validated = () => {
			for (const p of pets) if (!Number.isFinite(p.size) || p.size <= 0 || !Number.isFinite(p.position.marginX) || !Number.isFinite(p.position.marginY)) {
				setMsg({
					kind: "err",
					text: t("invalid")
				});
				return false;
			}
			return true;
		};
		const save = async () => {
			if (!validated()) return;
			setBusy(true);
			setMsg({
				kind: "",
				text: ""
			});
			try {
				let notificationsEnabled;
				try {
					const prev = await fetch("/dsh-pet-7340/config");
					if (prev.ok && prev.status !== 204) {
						const pj = await prev.json().catch(() => null);
						if (pj && typeof pj.notificationsEnabled === "boolean") notificationsEnabled = pj.notificationsEnabled;
					}
				} catch {}
				const body = { pets };
				if (notificationsEnabled !== void 0) body.notificationsEnabled = notificationsEnabled;
				const res = await fetch("/dsh-pet-7340/config", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
				if (!res.ok) throw new Error("HTTP " + res.status);
				petBridge.current = pets;
				petBridge.sync(pets);
				setMsg({
					kind: "ok",
					text: t("saved")
				});
			} catch {
				setMsg({
					kind: "err",
					text: t("loadError")
				});
			} finally {
				setBusy(false);
			}
		};
		const reset = () => setConfirm("reset");
		const doReset = async () => {
			setBusy(true);
			setMsg({
				kind: "",
				text: ""
			});
			try {
				await fetch("/dsh-pet-7340/config", { method: "DELETE" });
				const defRes = await fetch("/dsh-pet-7340/config.jsonc");
				const defs = assertClientConfig(JSON.parse(stripJsonc(await defRes.text()))).pets;
				setPets(defs.map((p) => ({
					...p,
					position: { ...p.position }
				})));
				setSelId(defs[0]?.id ?? "");
				petBridge.current = defs;
				petBridge.sync(defs);
				setMsg({
					kind: "ok",
					text: t("saved")
				});
			} catch {
				setMsg({
					kind: "err",
					text: t("loadError")
				});
			} finally {
				setBusy(false);
			}
		};
		const addPet = () => {
			const tpl = petBridge.template;
			if (!tpl) return;
			const id = nextId(pets);
			setPets((list) => [...list, {
				id,
				size: tpl.size,
				balanceEnabled: tpl.balanceEnabled,
				position: { ...tpl.position }
			}]);
			setSelId(id);
		};
		const removeSel = () => {
			if (pets.length <= 1) {
				setMsg({
					kind: "err",
					text: t("atLeastOne")
				});
				return;
			}
			setConfirm("remove");
		};
		const doRemove = () => {
			const list = pets.filter((p) => p.id !== selId);
			setPets(list);
			setSelId(list[0].id);
		};
		const field = (key, value, setter, width) => h("input", {
			type: "number",
			step: key === "size" ? "10" : "1",
			min: key === "size" ? "120" : "",
			value: String(value),
			disabled: busy,
			onChange: (e) => setter(Number(e.target.value)),
			style: {
				width,
				...inputStyle
			}
		});
		return h("section", {
			style: {
				maxWidth: "720px",
				color: "var(--dsw-alias-label-primary)",
				display: "flex",
				flexDirection: "column",
				gap: "6px"
			},
			children: [
				h("h2", {
					style: {
						margin: 0,
						fontSize: "16px",
						fontWeight: 500,
						lineHeight: "24px"
					},
					children: t("nav")
				}),
				h("p", {
					style: {
						margin: 0,
						fontSize: "14px",
						color: "var(--dsw-alias-label-tertiary)",
						lineHeight: "22px"
					},
					children: t("intro")
				}),
				h("div", {
					style: {
						display: "flex",
						gap: "8px",
						flexWrap: "wrap",
						alignItems: "center",
						marginTop: "4px"
					},
					children: [
						h("span", {
							style: {
								fontSize: "12px",
								color: "var(--dsw-alias-label-secondary)"
							},
							children: t("petsLabel")
						}),
						...pets.map((p) => h("button", {
							key: p.id,
							type: "button",
							onClick: () => setSelId(p.id),
							style: {
								border: "1px solid " + (p.id === selId ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-border-l2)"),
								background: p.id === selId ? "var(--dsw-alias-interactive-bg-active)" : "transparent",
								color: "var(--dsw-alias-label-primary)",
								borderRadius: "8px",
								padding: "4px 12px",
								fontSize: "13px",
								cursor: "pointer"
							},
							children: p.id + " (" + p.size + "px)"
						})),
						h("button", {
							type: "button",
							onClick: addPet,
							disabled: busy,
							style: {
								border: "1px dashed var(--dsw-alias-border-l2)",
								background: "transparent",
								color: "var(--dsw-alias-label-secondary)",
								borderRadius: "8px",
								padding: "4px 12px",
								fontSize: "13px",
								cursor: "pointer"
							},
							children: "+ " + t("add")
						})
					]
				}),
				cur ? h("div", {
					style: {
						display: "flex",
						gap: "16px",
						flexWrap: "wrap",
						marginTop: "8px",
						padding: "12px 14px",
						border: "1px solid var(--dsw-alias-border-l2)",
						borderRadius: "12px"
					},
					children: [
						h("label", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: "4px",
								fontSize: "12px",
								color: "var(--dsw-alias-label-secondary)"
							},
							children: [
								t("sizeLabel"),
								field("size", cur.size, (v) => updateSel({ size: v }), "150px"),
								h("span", {
									style: {
										fontSize: "11px",
										color: "var(--dsw-alias-label-tertiary)"
									},
									children: t("sizeHint")
								})
							]
						}),
						h("label", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: "4px",
								fontSize: "12px",
								color: "var(--dsw-alias-label-secondary)"
							},
							children: [t("cornerLabel"), h("select", {
								value: cur.position.corner,
								disabled: busy,
								onChange: (e) => updateSel({ position: { corner: e.target.value } }),
								style: {
									width: "160px",
									...inputStyle
								},
								children: CORNERS.map((c) => h("option", {
									key: c,
									value: c,
									children: cornerLabel(c)
								}))
							})]
						}),
						h("label", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: "4px",
								fontSize: "12px",
								color: "var(--dsw-alias-label-secondary)"
							},
							children: [t("marginX"), field("marginX", cur.position.marginX, (v) => updateSel({ position: { marginX: v } }), "120px")]
						}),
						h("label", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: "4px",
								fontSize: "12px",
								color: "var(--dsw-alias-label-secondary)"
							},
							children: [t("marginY"), field("marginY", cur.position.marginY, (v) => updateSel({ position: { marginY: v } }), "120px")]
						}),
						h("label", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: "4px",
								fontSize: "12px",
								color: "var(--dsw-alias-label-secondary)"
							},
							children: [
								t("balanceEnabled"),
								h("input", {
									type: "checkbox",
									checked: !!cur.balanceEnabled,
									disabled: busy,
									onChange: (e) => updateSel({ balanceEnabled: e.target.checked }),
									style: {
										width: "16px",
										height: "16px",
										accentColor: "var(--dsw-alias-state-business-primary)"
									}
								}),
								h("span", {
									style: {
										fontSize: "11px",
										color: "var(--dsw-alias-label-tertiary)"
									},
									children: t("balanceEnabledHint")
								})
							]
						}),
						h("button", {
							type: "button",
							onClick: removeSel,
							disabled: busy,
							title: t("remove"),
							style: {
								alignSelf: "flex-end",
								border: "1px solid var(--dsw-alias-state-error-secondary)",
								background: "transparent",
								color: "var(--dsw-alias-state-error-primary)",
								borderRadius: "8px",
								padding: "4px 12px",
								fontSize: "12px",
								cursor: "pointer"
							},
							children: t("remove")
						})
					]
				}) : h("p", {
					style: {
						margin: 0,
						fontSize: "13px",
						color: "var(--dsw-alias-label-tertiary)"
					},
					children: t("emptyPets")
				}),
				h("label", {
					style: {
						display: "flex",
						gap: "8px",
						alignItems: "center",
						marginTop: "8px",
						fontSize: "13px",
						color: "var(--dsw-alias-label-primary)"
					},
					children: [
						h("input", {
							type: "checkbox",
							checked: notifyEnabled,
							disabled: busy,
							onChange: (e) => void toggleNotify(e.target.checked),
							style: {
								width: "16px",
								height: "16px",
								accentColor: "var(--dsw-alias-state-business-primary)"
							}
						}),
						h("span", { children: t("notifyToggle") }),
						h("span", {
							style: {
								fontSize: "11px",
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: t("notifyToggleHint")
						})
					]
				}),
				h("div", {
					style: {
						display: "flex",
						gap: "8px",
						alignItems: "center",
						marginTop: "4px"
					},
					children: [h("button", {
						type: "button",
						onClick: () => void grantNotifyPermission(),
						style: {
							border: "1px solid var(--dsw-alias-border-l2)",
							background: "transparent",
							color: "var(--dsw-alias-label-primary)",
							borderRadius: "8px",
							padding: "4px 14px",
							fontSize: "12px",
							cursor: "pointer"
						},
						children: t("notifyGetPermission")
					}), permMsg.text ? h("span", {
						style: {
							fontSize: "12px",
							color: permMsg.kind === "err" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-state-ok-primary)",
							lineHeight: "18px"
						},
						children: permMsg.text
					}) : null]
				}),
				h("div", {
					style: {
						display: "flex",
						gap: "8px",
						alignItems: "center",
						marginTop: "4px"
					},
					children: [
						h("button", {
							type: "button",
							disabled: busy,
							onClick: save,
							style: {
								border: "1px solid var(--dsw-alias-button-info-fill)",
								background: "var(--dsw-alias-button-info-fill)",
								color: "#fff",
								borderRadius: "8px",
								padding: "4px 14px",
								fontSize: "12px",
								cursor: "pointer",
								opacity: busy ? .5 : 1
							},
							children: t("save")
						}),
						h("button", {
							type: "button",
							disabled: busy,
							onClick: reset,
							style: {
								border: "1px solid var(--dsw-alias-border-l2)",
								background: "transparent",
								color: "var(--dsw-alias-label-primary)",
								borderRadius: "8px",
								padding: "4px 14px",
								fontSize: "12px",
								cursor: "pointer",
								opacity: busy ? .5 : 1
							},
							children: t("reset")
						}),
						msg.text ? h("span", {
							style: {
								fontSize: "12px",
								color: msg.kind === "err" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-state-ok-primary)",
								marginLeft: "4px"
							},
							children: msg.text
						}) : null
					]
				}),
				h("p", {
					style: {
						margin: 0,
						fontSize: "11px",
						color: "var(--dsw-alias-label-tertiary)",
						lineHeight: "16px"
					},
					children: t("resetHint")
				}),
				paths ? h("div", {
					style: {
						marginTop: "12px",
						padding: "10px 14px",
						border: "1px solid var(--dsw-alias-border-l2)",
						borderRadius: "12px",
						display: "flex",
						flexDirection: "column",
						gap: "6px",
						fontSize: "12px",
						color: "var(--dsw-alias-label-secondary)"
					},
					children: [
						h("div", {
							style: {
								fontSize: "12px",
								color: "var(--dsw-alias-label-primary)",
								fontWeight: 500
							},
							children: t("configMeta")
						}),
						h("div", {
							style: {
								fontSize: "12px",
								lineHeight: "20px"
							},
							children: t("configMetaHint")
						}),
						h("div", {
							style: {
								fontSize: "12px",
								lineHeight: "18px",
								wordBreak: "break-all"
							},
							children: t("defaultConfig") + "：" + paths.default
						}),
						h("div", {
							style: {
								fontSize: "12px",
								lineHeight: "18px",
								wordBreak: "break-all"
							},
							children: t("userConfig") + "：" + paths.user
						}),
						h("div", {
							style: {
								fontSize: "12px",
								lineHeight: "18px",
								wordBreak: "break-all"
							},
							children: t("animationDir") + "：" + paths.animations
						})
					]
				}) : null,
				confirm ? h("div", {
					style: {
						position: "fixed",
						inset: 0,
						zIndex: 2147483647,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						background: "rgba(0, 0, 0, 0.45)"
					},
					onClick: () => setConfirm(null),
					children: h("div", {
						style: {
							width: "340px",
							maxWidth: "calc(100vw - 40px)",
							background: "var(--dsw-alias-bg-layer-1)",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: "12px",
							padding: "16px 18px",
							boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)",
							display: "flex",
							flexDirection: "column",
							gap: "12px"
						},
						onClick: (e) => e.stopPropagation(),
						children: [
							h("div", {
								style: {
									fontSize: "14px",
									fontWeight: 500,
									color: "var(--dsw-alias-label-primary)"
								},
								children: t("confirmTitle")
							}),
							h("div", {
								style: {
									fontSize: "13px",
									lineHeight: "20px",
									color: "var(--dsw-alias-label-secondary)"
								},
								children: confirm === "remove" ? t("confirmRemove").replace("{id}", selId) : t("confirmReset")
							}),
							h("div", {
								style: {
									display: "flex",
									gap: "8px",
									justifyContent: "flex-end"
								},
								children: [h("button", {
									type: "button",
									onClick: () => setConfirm(null),
									style: {
										border: "1px solid var(--dsw-alias-border-l2)",
										background: "transparent",
										color: "var(--dsw-alias-label-primary)",
										borderRadius: "8px",
										padding: "4px 14px",
										fontSize: "12px",
										cursor: "pointer"
									},
									children: t("cancel")
								}), h("button", {
									type: "button",
									onClick: () => {
										const k = confirm;
										setConfirm(null);
										if (k === "remove") doRemove();
										else doReset();
									},
									style: confirm === "remove" ? {
										border: "1px solid var(--dsw-alias-state-error-secondary)",
										background: "transparent",
										color: "var(--dsw-alias-state-error-primary)",
										borderRadius: "8px",
										padding: "4px 14px",
										fontSize: "12px",
										cursor: "pointer"
									} : {
										border: "1px solid var(--dsw-alias-button-info-fill)",
										background: "var(--dsw-alias-button-info-fill)",
										color: "#fff",
										borderRadius: "8px",
										padding: "4px 14px",
										fontSize: "12px",
										cursor: "pointer"
									},
									children: confirm === "remove" ? t("remove") : t("reset")
								})]
							})
						]
					})
				}) : null
			]
		});
	};
}
//#endregion
//#region src/client/pet.ts
/** 运行时配置（PetMulti 加载后赋值；PetCard 只读） */
let config = EMPTY_CONF;
/** 余额气泡展示时长（ms）：定时自动消失，与动画生命周期解耦 */
const BUBBLE_DURATION_MS = 1e4;
/** 内联 CSS —— 注入一次（官方插件标准做法） */
const css = [
	".dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}",
	".dsh-pet-root[data-corner=\"bottom-right\"]{right:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}",
	".dsh-pet-root[data-corner=\"bottom-left\"]{left:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}",
	".dsh-pet-root[data-corner=\"top-right\"]{right:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}",
	".dsh-pet-root[data-corner=\"top-left\"]{left:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}",
	".dsh-pet-stage{position:relative;width:var(--dsh-pet-size,462px);height:calc(var(--dsh-pet-size,462px)*9/16);pointer-events:none}",
	".dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}",
	".dsh-pet-video.is-front{opacity:1}",
	".dsh-pet-hit{position:absolute;pointer-events:auto;cursor:default;z-index:1}",
	".dsh-pet-hit.dragging{cursor:grabbing}",
	"@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}"
].join("\n");
const cssTag = "dsh-pet/style.css";
function injectCss() {
	if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + cssTag + "\"]") === null) {
		const tag = document.createElement("style");
		tag.dataset.plugin = "dsh-pet";
		tag.dataset.pluginCss = cssTag;
		tag.textContent = css;
		document.head.appendChild(tag);
	}
}
/**
* 制造宠物页面组件（工厂，与 makePetConfigSection 同理：react 由运行时注入）。
* @param rt 运行时注入的 react 能力（h=jsx / useState / useEffect / useRef）
* @returns PetMulti 多开容器组件（内部渲染多个 PetCard）
*/
function makePetUI(rt) {
	const { h, useState, useEffect, useRef } = rt;
	injectCss();
	/** 余额气泡（哑组件：数据与显隐由 PetCard 传入） */
	const BalanceBubble = makeBalanceBubble({ h });
	/** 单个宠物实例（配置由容器 PetMulti 传入） */
	function PetCard({ cfg, balance, balanceTick }) {
		const [size, setSize] = useState(cfg.size);
		const halfW = size / 2;
		const halfH = size * 9 / 16 / 2;
		const [anim, setAnim] = useState(config.animations.idle[0] ?? "");
		const [once, setOnce] = useState(true);
		const [facing, setFacing] = useState("left");
		const [dragging, setDragging] = useState(false);
		const [customPos, setCustomPos] = useState(null);
		const [corner, setCorner] = useState(cfg.position.corner);
		const [margin, setMargin] = useState({
			x: cfg.position.marginX,
			y: cfg.position.marginY
		});
		const [bubbleOn, setBubbleOn] = useState(false);
		const bubbleTimerRef = useRef(null);
		useEffect(() => {
			setSize(cfg.size);
			setCorner(cfg.position.corner);
			setMargin({
				x: cfg.position.marginX,
				y: cfg.position.marginY
			});
		}, [
			cfg.size,
			cfg.position.corner,
			cfg.position.marginX,
			cfg.position.marginY
		]);
		const [seq, setSeq] = useState(0);
		const rootRef = useRef(null);
		const stageRef = useRef(null);
		const videoARef = useRef(null);
		const videoBRef = useRef(null);
		const frontRef = useRef(0);
		const pendingRef = useRef(null);
		const genRef = useRef(0);
		const dragRef = useRef({
			active: false,
			dragging: false,
			sx: 0,
			sy: 0,
			offX: 0,
			offY: 0
		});
		const justDraggedRef = useRef(false);
		const animRef = useRef(anim);
		animRef.current = anim;
		const switchTo = (next, nextOnce) => {
			if (!next) return;
			const pending = pendingRef.current;
			if (pending && pending.anim === next && pending.once === nextOnce) return;
			const gen = ++genRef.current;
			pendingRef.current = {
				anim: next,
				once: nextOnce,
				gen
			};
			const el = (frontRef.current === 0 ? videoBRef : videoARef).current;
			if (!el) return;
			el.src = "/dsh-pet-7340/thumb/" + encodeURIComponent(next) + ".webm";
			el.loop = !nextOnce;
			el.muted = true;
			el.autoplay = true;
			el.playsInline = true;
			el.onended = nextOnce ? handleEnded : null;
			el.load();
			const onReady = () => {
				el.removeEventListener("loadeddata", onReady);
				if (pendingRef.current?.gen !== gen) return;
				const old = frontRef.current === 0 ? videoARef : videoBRef;
				el.classList.add("is-front");
				if (old.current && old.current !== el) {
					old.current.classList.remove("is-front");
					old.current.onended = null;
					old.current.pause();
				}
				frontRef.current = frontRef.current === 0 ? 1 : 0;
				pendingRef.current = null;
				el.style.transform = facingRef.current === "right" ? "scaleX(-1)" : "";
				el.play().catch(() => {});
				if (pendingMoveRef.current) startMoveDrive(el);
			};
			el.addEventListener("loadeddata", onReady);
			if (el.readyState >= 2) onReady();
		};
		useEffect(() => {
			switchTo(anim, once);
		}, [
			anim,
			once,
			seq
		]);
		useEffect(() => () => stopMove(), []);
		useEffect(() => () => {
			if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
		}, []);
		const prevTickRef = useRef(0);
		useEffect(() => {
			if (!cfg.balanceEnabled) return;
			if (balanceTick === 0 || balanceTick === prevTickRef.current) return;
			prevTickRef.current = balanceTick;
			if (!balance || !balance.ok) return;
			const p = balancePercent(balance);
			if (p === void 0) return;
			const pool = config.animations.events?.balance;
			if (!pool || pool.length === 0) {
				console.error("[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画");
				return;
			}
			const idx = balanceEventIndex(p);
			const name = pool[idx];
			if (!name) {
				console.error("[dsh-pet] balance 档位索引越界：p=" + p + " idx=" + idx);
				return;
			}
			console.log("[dsh-pet] " + (/* @__PURE__ */ new Date()).toTimeString().slice(0, 8) + " balance pet=" + cfg.id + " p=" + p.toFixed(1) + "% -> [档" + idx + "] " + name);
			stopMove();
			setBubbleOn(true);
			if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
			bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
			setOnce(true);
			setAnim(name);
		}, [balanceTick]);
		useEffect(() => {
			const onResize = () => setCustomPos((prev) => prev ? { ...prev } : prev);
			window.addEventListener("resize", onResize);
			return () => window.removeEventListener("resize", onResize);
		}, []);
		const pickNext = () => {
			const { animations, animationWeights } = config;
			const roll = Math.random();
			const k = rollKind(roll, animationWeights);
			let kind;
			let next;
			if (k === "idle") {
				kind = "IDLE";
				next = pick(animations.idle, animRef.current);
				setAnim(next);
			} else if (k === "turn") {
				kind = "TURN";
				next = pick(animations.turn, animRef.current);
				setAnim(next);
			} else if (k === "move") {
				const moved = tryMove();
				if (moved === false) {
					const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
					kind = act.id;
					next = act.name;
					setAnim(next);
				} else {
					kind = "MOVES";
					next = typeof moved === "string" ? moved : "移动进行中(不重播)";
				}
			} else {
				const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
				kind = act.id;
				next = act.name;
				setAnim(next);
			}
			console.log("[dsh-pet] " + (/* @__PURE__ */ new Date()).toTimeString().slice(0, 8) + " pet=" + cfg.id + " facing=" + facingRef.current + " roll=" + roll.toFixed(4) + " -> [" + kind + "] " + next);
			setOnce(true);
			setSeq((s) => s + 1);
		};
		const handleEnded = (e) => {
			const evEl = e && e.currentTarget;
			if (evEl && !evEl.classList.contains("is-front")) return;
			const { animations } = config;
			if (dragRef.current.active) return;
			if (Object.values(animations.events ?? {}).some((pool) => pool.includes(animRef.current))) {
				if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
				setOnce(true);
				setSeq((s) => s + 1);
				return;
			}
			if (animations.turn.includes(animRef.current)) {
				const next = facing === "left" ? "right" : "left";
				setFacing(next);
				facingRef.current = next;
			}
			if (animations.drag.includes(animRef.current) || animations.clicks.includes(animRef.current)) {
				if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
				setOnce(true);
				setSeq((s) => s + 1);
				return;
			}
			pickNext();
		};
		const moveRef = useRef(null);
		const moveTokenRef = useRef(0);
		const pendingMoveRef = useRef(null);
		const customPosRef = useRef(customPos);
		customPosRef.current = customPos;
		const currentCenterX = () => {
			const cp = customPosRef.current;
			if (cp) return cp.rx * window.innerWidth;
			const rootEl = rootRef.current;
			if (rootEl) return rootEl.getBoundingClientRect().left + halfW;
			return window.innerWidth - 24 - halfW;
		};
		const currentCenterY = () => {
			const cp = customPosRef.current;
			if (cp) return cp.ry * window.innerHeight;
			const rootEl = rootRef.current;
			if (rootEl) return rootEl.getBoundingClientRect().top + halfH;
			return window.innerHeight - 20 - halfH;
		};
		const startMoveDrive = (el) => {
			const pm = pendingMoveRef.current;
			if (!pm || moveRef.current !== null) return;
			pendingMoveRef.current = null;
			const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
			const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
			const travelWindow = Math.max(.1, duration - leadSec - tailSec);
			const token = ++moveTokenRef.current;
			const step = () => {
				if (moveTokenRef.current !== token) return;
				const t = el.currentTime || 0;
				const rootEl = rootRef.current;
				if (rootEl) {
					const W = window.innerWidth;
					const H = window.innerHeight;
					let ratioX;
					if (t <= leadSec) ratioX = startRatio;
					else if (t >= duration - tailSec) ratioX = targetRatio;
					else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
					const px = ratioX * W;
					const py = startYRatio * H;
					rootEl.style.left = px - halfW + "px";
					rootEl.style.top = py - halfH + "px";
					rootEl.style.right = "auto";
					rootEl.style.bottom = "auto";
				}
				if (t < duration - tailSec) moveRef.current = requestAnimationFrame(step);
				else {
					moveRef.current = null;
					setCustomPos({
						rx: targetRatio,
						ry: startYRatio
					});
				}
			};
			moveRef.current = requestAnimationFrame(step);
		};
		/** 尝试发起一次移动：占用中返回 true（不重播），无法移动返回 false，成功返回动作名（供日志显示具体动作） */
		const tryMove = () => {
			if (moveRef.current !== null || pendingMoveRef.current) return true;
			const moves = config.animations.moves;
			const actions = moves.actions;
			if (!actions.length) return false;
			const chosen = actions[Math.floor(Math.random() * actions.length)];
			const mp = Object.assign({}, moves.default, chosen.params || {});
			const dir = facingRef.current === "right" !== config.animations.turn.includes(animRef.current) ? 1 : -1;
			const W = window.innerWidth;
			const distScale = size / 462;
			const plan = planMove({
				cx: currentCenterX(),
				cy: currentCenterY(),
				W,
				H: window.innerHeight,
				dir,
				minDist: mp.minDist * distScale,
				maxDist: mp.maxDist * distScale,
				margin: mp.margin,
				halfW
			});
			if (!plan) return false;
			pendingMoveRef.current = {
				...plan,
				dir,
				leadSec: mp.leadSec,
				tailSec: mp.tailSec
			};
			setOnce(true);
			setAnim(chosen.name);
			return chosen.name;
		};
		const stopMove = () => {
			pendingMoveRef.current = null;
			moveTokenRef.current++;
			if (moveRef.current !== null) {
				cancelAnimationFrame(moveRef.current);
				moveRef.current = null;
			}
		};
		const facingRef = useRef(facing);
		facingRef.current = facing;
		const handlePointerDown = (e) => {
			e.currentTarget.classList.add("dragging");
			stopMove();
			e.currentTarget.setPointerCapture(e.pointerId);
			const rootEl = rootRef.current;
			let offX = 0;
			let offY = 0;
			if (rootEl) {
				const rr = rootEl.getBoundingClientRect();
				offX = e.clientX - (rr.left + rr.width / 2);
				offY = e.clientY - (rr.top + rr.height / 2);
			}
			dragRef.current = {
				active: true,
				dragging: false,
				sx: e.clientX,
				sy: e.clientY,
				offX,
				offY
			};
		};
		const handlePointerMove = (e) => {
			const d = dragRef.current;
			if (!d.active) return;
			const dx = e.clientX - d.sx;
			const dy = e.clientY - d.sy;
			if (!d.dragging) {
				if (Math.hypot(dx, dy) < 5) return;
				d.dragging = true;
				setDragging(true);
				setOnce(true);
				if (config.animations.drag.length) {
					const name = pick(config.animations.drag);
					console.log("[dsh-pet] " + (/* @__PURE__ */ new Date()).toTimeString().slice(0, 8) + " pet=" + cfg.id + " -> [DRAG] " + name);
					setAnim(name);
				}
			}
			const rootEl = rootRef.current;
			if (rootEl) {
				rootEl.style.left = e.clientX - d.offX - halfW + "px";
				rootEl.style.top = e.clientY - d.offY - halfH + "px";
				rootEl.style.right = "auto";
				rootEl.style.bottom = "auto";
			}
			const stageEl = stageRef.current;
			if (stageEl) stageEl.style.transform = "none";
		};
		const handlePointerUp = (e) => {
			const d = dragRef.current;
			const wasDragging = d.dragging;
			d.active = false;
			d.dragging = false;
			e.currentTarget.classList.remove("dragging");
			if (wasDragging) {
				justDraggedRef.current = true;
				setTimeout(() => {
					justDraggedRef.current = false;
				}, 100);
				setDragging(false);
				setCustomPos({
					rx: (e.clientX - d.offX) / window.innerWidth,
					ry: (e.clientY - d.offY) / window.innerHeight
				});
				const stageEl = stageRef.current;
				if (stageEl) stageEl.style.transform = "translateY(" + bottomPad + "px)";
				if (config.animations.idle.length) setAnim(pick(config.animations.idle, animRef.current));
				setOnce(false);
			}
		};
		const handleClick = () => {
			const d = dragRef.current;
			if (d.active || d.dragging || justDraggedRef.current) return;
			stopMove();
			setOnce(true);
			if (!config.animations.clicks.length) return;
			const name = pick(config.animations.clicks);
			console.log("[dsh-pet] " + (/* @__PURE__ */ new Date()).toTimeString().slice(0, 8) + " pet=" + cfg.id + " -> [CLICK] " + name);
			setAnim(name);
		};
		const bottomPad = size * (9 / 16) * 30 / 360;
		const stageStyle = dragging ? { transform: "none" } : { transform: "translateY(" + bottomPad + "px)" };
		const rootStyle = customPos ? (() => {
			const rx = customPos.rx;
			const ry = customPos.ry;
			const left = Math.min(Math.max(rx * window.innerWidth - halfW, 0), window.innerWidth - size);
			const top = Math.min(Math.max(ry * window.innerHeight - halfH, 0), window.innerHeight - size * 9 / 16);
			return {
				left: left + "px",
				top: top + "px",
				right: "auto",
				bottom: "auto"
			};
		})() : {};
		const commonVideoProps = {
			muted: true,
			playsInline: true,
			autoPlay: true,
			title: "dsh-pet"
		};
		const hitProps = {
			className: "dsh-pet-hit",
			style: {
				left: HIT_BOX.x0 / 640 * 100 + "%",
				top: HIT_BOX.y0 / 360 * 100 + "%",
				width: (HIT_BOX.x1 - HIT_BOX.x0) / 640 * 100 + "%",
				height: (HIT_BOX.y1 - HIT_BOX.y0) / 360 * 100 + "%"
			},
			onMouseEnter: (e) => {
				if (!dragRef.current.active) e.currentTarget.style.cursor = "grab";
			},
			onMouseLeave: (e) => {
				if (!dragRef.current.active) e.currentTarget.style.cursor = "default";
			},
			onClick: handleClick,
			onPointerDown: handlePointerDown,
			onPointerMove: handlePointerMove,
			onPointerUp: handlePointerUp,
			onPointerCancel: handlePointerUp,
			title: "dsh-pet"
		};
		return h("div", {
			ref: rootRef,
			className: "dsh-pet-root",
			"data-corner": corner,
			"data-facing": facing,
			style: Object.assign({
				"--dsh-pet-size": size + "px",
				"--dsh-pet-mx": margin.x + "px",
				"--dsh-pet-my": margin.y + "px"
			}, rootStyle),
			children: [balance && balance.ok && cfg.balanceEnabled ? h(BalanceBubble, {
				state: balance,
				on: bubbleOn
			}) : null, h("div", {
				ref: stageRef,
				className: "dsh-pet-stage",
				style: stageStyle,
				children: [
					h("video", Object.assign({}, commonVideoProps, {
						ref: videoARef,
						className: "dsh-pet-video is-front"
					})),
					h("video", Object.assign({}, commonVideoProps, {
						ref: videoBRef,
						className: "dsh-pet-video"
					})),
					h("div", hitProps)
				]
			})]
		});
	}
	/** 多开容器：拉取配置 → 合并默认+用户层 pets → 渲染多个 PetCard */
	function PetMulti() {
		const [pets, setPets] = useState([]);
		const [ready, setReady] = useState(false);
		const [balance, setBalance] = useState(null);
		const [balanceTick, setBalanceTick] = useState(0);
		useEffect(() => {
			let alive = true;
			(async () => {
				try {
					const r1 = await fetch("/dsh-pet-7340/config.jsonc");
					if (!r1.ok) throw new Error("config.jsonc HTTP " + r1.status);
					config = assertClientConfig(JSON.parse(stripJsonc(await r1.text())));
					const defaults = config.pets;
					let user = {};
					try {
						const r2 = await fetch("/dsh-pet-7340/config");
						if (r2.ok && r2.status !== 204) user = await r2.json().catch(() => ({}));
					} catch {}
					config = assertClientConfig(applyUserOverrides(config, user));
					const merged = config.pets;
					if (!alive) return;
					petBridge.current = merged;
					petBridge.template = defaults.length ? defaults[0] : void 0;
					petBridge.sync = (list) => {
						setPets(list);
						petBridge.current = list;
					};
					setPets(merged);
					setReady(true);
				} catch (e) {
					console.error("[dsh-pet] 配置加载失败", e);
				}
			})();
			return () => {
				alive = false;
				petBridge.sync = () => {};
			};
		}, []);
		const anyBalanceEnabled = pets.some((p) => p.balanceEnabled);
		useEffect(() => {
			if (!ready || !anyBalanceEnabled) return;
			let alive = true;
			const refresh = async () => {
				try {
					const state = await fetchBalanceState();
					if (!alive) return;
					setBalance(state);
					if (state.ok) setBalanceTick((t) => t + 1);
					else if (state.reason === "unsupported") {} else console.error("[dsh-pet] 余额查询失败 reason=" + state.reason + (state.message ? " " + state.message : ""));
				} catch (e) {
					if (alive) console.error("[dsh-pet] 余额拉取异常", e);
				}
			};
			refresh();
			const intervalMs = Math.max(1e3, (config.eventsRefreshSec?.balance ?? 1800) * 1e3);
			const timer = window.setInterval(() => void refresh(), intervalMs);
			return () => {
				alive = false;
				window.clearInterval(timer);
			};
		}, [ready, anyBalanceEnabled]);
		useEffect(() => {
			if (!ready || !anyBalanceEnabled) return;
			let alive = true;
			let prev = -1;
			const poll = async () => {
				try {
					const r = await fetch("/dsh-pet-7340/balance/trigger");
					if (!alive || !r.ok) return;
					const data = await r.json().catch(() => null);
					const count = data && typeof data.count === "number" ? data.count : -1;
					if (count < 0) return;
					if (prev === -1) {
						prev = count;
						return;
					}
					if (count === prev) return;
					prev = count;
					const state = await fetchBalanceState();
					if (!alive) return;
					setBalance(state);
					if (state.ok) setBalanceTick((t) => t + 1);
					else console.error("[dsh-pet] 手动触发余额查询失败 reason=" + state.reason + (state.message ? " " + state.message : ""));
				} catch {}
			};
			poll();
			const timer = window.setInterval(() => void poll(), 1e3);
			return () => {
				alive = false;
				window.clearInterval(timer);
			};
		}, [ready, anyBalanceEnabled]);
		return ready ? pets.map((p) => h(PetCard, {
			key: p.id,
			cfg: p,
			balance,
			balanceTick
		})) : null;
	}
	return PetMulti;
}
//#endregion
//#region src/client/app.ts
/**
* 返回 DSH 插件 factory：`(require) => module`。
* 插件三件套（name / inject / apply）都在其返回的 module 上。
*/
function makeFactory() {
	return (require) => {
		const module = { exports: {} };
		const { useEffect, useRef, useState } = require("react");
		const { jsx: h } = require("react/jsx-runtime");
		const PetMulti = makePetUI({
			h,
			useState,
			useEffect,
			useRef
		});
		const name = "pet";
		const inject = [
			"slots",
			"locale",
			"connection"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-pet: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.effect(() => {
				const api = ctx.connection?.api;
				if (api && typeof api?.events?.mux === "function" && typeof api?.events?.host === "function") {
					const ac = new AbortController();
					startNotify(api, ac.signal);
					return () => ac.abort();
				}
				console.warn("[dsh-pet] 系统通知未启动：connection 服务不可用");
				return () => {};
			}, "dsh-pet: notifications");
			ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "pet",
					order: 1e3
				}, () => h(PetMulti, {}));
			});
			const PetConfigSection = makePetConfigSection({
				h,
				useState,
				useEffect,
				t
			});
			ctx.slots.inject("settings.section", function* () {
				yield ctx.slots.register({
					name: "settings.section",
					id: "pet-config",
					order: 30,
					label: () => t("nav"),
					inject: () => ({ t })
				}, PetConfigSection);
			});
		}
		module.exports = {
			apply,
			inject,
			name
		};
		return module.exports;
	};
}
//#endregion
//#region src/client/index.ts
window.__ModuleLoader__.load({
	id: "dsh-pet",
	factory: makeFactory()
});
//#endregion
export {};
