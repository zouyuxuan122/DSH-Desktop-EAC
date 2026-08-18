/**
 * ============================================================================
 * dsh-pet 浏览器半侧（browser half）—— 宠物插件的"前端"部分
 * ============================================================================
 *
 * 【这个文件是什么】
 *   本文件是宠物在浏览器里运行的代码。它：
 *   1. 以官方规定的"客户端 bundle 形态"注册自己（window.__ModuleLoader__.load）
 *   2. 把宠物组件挂到 DSH 界面的 `shell.overlay` 槽位（右下角的浮动层）
 *   3. 负责宠物的所有视觉与交互：播放动画、随机行为、点击/拖拽、屏幕漫游
 *
 * 【为什么长这样（重要背景）】
 *   DSH 的浏览器插件必须是一个特殊格式的 JS 文件：
 *   - 用 `window.__ModuleLoader__.load({ id, factory })` 注册
 *   - factory 接收一个同步的 `require`，用它拿 React 和 DSH 提供的模块
 *   - **不能**自己打包 React（React 由 DSH 外壳提供，这里直接 require）
 *   - CSS 以字符串形式内联注入 <style> 标签
 *   官方插件（如 dsh-client-ui-goal）的 lib/client.js 就是这种形态，
 *   本文件是手写等价实现，零构建依赖，方便直接阅读和修改。
 *
 * 【动画文件从哪来】
 *   动画视频通过 /pet/thumb/<动画名>.webm 加载——这个路由由宿主半侧
 *   （lib/index.js）提供，把 assets/thumb/ 下的 WebM 文件发给浏览器。
 *
 * ============================================================================
 */
window.__ModuleLoader__.load({
	// 插件唯一 ID，必须与 package.json 里声明的一致
	id: 'dsh-pet',

	// factory：浏览器加载本 bundle 时执行，返回插件的导出
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// ---- 从 DSH 外壳拿 React（不能自己打包） ----
		let react = require('react');
		let { useEffect, useRef, useState } = react;
		// jsx 是 React 18 的新 JSX 转换函数，这里起个别名 h 方便书写
		let { jsx: h } = require('react/jsx-runtime');

		// ============================================================================
		// 内联 CSS —— 注入一次，官方插件标准做法
		// ============================================================================
		// 说明：
		// - .dsh-pet-root       宠物的根容器，fixed 定位（相对视口），默认右下角
		// - .dsh-pet-stage      内部舞台，承载两个 video 的层叠
		// - .dsh-pet-video      动画视频；opacity 默认 0（隐藏），.is-front 时显示
		// - 双 video 层叠：一个显示、一个预加载，切换时交叉淡入避免闪空白
		const css = [
			// 根容器：fixed 固定定位、层级 40（在界面之上）、整体点击穿透（不挡界面操作）、禁止选中
			// EAC 本地补丁：40 会被右侧栏（dsh-better-sidebar 面板 z-index:50）盖住，
			// 提到 CSS 最大值保证页面桌宠始终是最高显示优先级（root 点击穿透不受影响）。
			'.dsh-pet-root{position:fixed;z-index:2147483647;pointer-events:none;user-select:none}',
			// EAC 本地补丁 2（根治）：官方 shell.overlay 容器（data-shell-overlay，
			// z-index:20）创建独立层叠上下文，把上面 root 的 2147483647 限制在容器
			// 内部、整体仍低于右侧栏(z-index:50)。这里把容器本身抬到最高 —— 容器
			// pointer-events:none 不挡操作，其它 overlay 条目一并浮最上（符合覆盖层语义）。
			'[data-shell-overlay]{z-index:2147483647!important}',
			// 右下角默认位置（right:24px 距右缘、bottom:0 贴底）
			'.dsh-pet-root[data-corner="bottom-right"]{right:24px;bottom:0}',
			// 左下角位置
			'.dsh-pet-root[data-corner="bottom-left"]{left:24px;bottom:0}',
			// 舞台：正方形（尺寸由 --dsh-pet-size 控制，默认 260px），本身不响应鼠标
			'.dsh-pet-stage{position:relative;width:var(--dsh-pet-size,260px);height:var(--dsh-pet-size,260px);pointer-events:none}',
			// 视频：铺满舞台、保持比例、可交互（pointer-events:auto 重新开启）、抓取光标
			// opacity:0 初始隐藏，transition 做 180ms 淡入淡出
			'.dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:auto;cursor:grab;opacity:0;transition:opacity .18s ease;transform-origin:center}',
			// 显示中的视频（is-front 类）
			'.dsh-pet-video.is-front{opacity:1}',
			// 按住时显示"抓取中"光标
			'.dsh-pet-video:active{cursor:grabbing}',
			// 朝向镜像说明：不用 CSS 全局规则（data-facing）控制镜像——facing 翻转会
			// 同步镜像所有 video（含仍在显示的旧视频），造成"旧帧被镜像"的闪烁。
			// 镜像改为在 switchTo 的 onReady 里按实际朝向给每个 video 设置 inline
			// transform（见 onReady）：新视频按新朝向显示、旧视频保持自己的 transform
			// 淡出，两者互不影响，facing 翻转时机因此无关紧要。
			// 无障碍：用户系统开启"减少动态效果"时关闭过渡动画
			'@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}',
			// V4.2 桌宠设置：悬停工具条（设置 ⚙ / 关闭 ×）、设置面板、召唤按钮、
			// 自动挂边（空闲折叠）。面板内按钮全部 pointer-events:auto。
			// 工具条定位在 root 顶部内侧（top:10px），与宠物本体零间隙 —— 指针
			// 从宠物移到按钮全程都在 root 子树内，:hover 不会断（旧版 top:-30px
			// 悬在宠物上方 30px，移动路径穿过空隙导致工具条在到达前消失）。
			'.dsh-pet-toolbar{position:absolute;top:10px;right:10px;display:flex;gap:4px;opacity:0;transition:opacity .15s ease;pointer-events:none}',
			'.dsh-pet-root:hover .dsh-pet-toolbar{opacity:1;pointer-events:auto}',
			'.dsh-pet-tbtn{width:26px;height:24px;border:none;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#101828) 90%,transparent);color:var(--dsw-alias-label-secondary,#b8c5ea);cursor:pointer;font-size:12px;line-height:1;display:grid;place-items:center;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));padding:0;font-family:inherit}',
			'.dsh-pet-tbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.14));color:var(--dsw-alias-label-primary,#eef2ff)}',
			'.dsh-pet-tbtn.danger:hover{background:#e81123;color:#fff}',
			'.dsh-pet-panel{position:absolute;bottom:calc(100% + 34px);right:0;width:236px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 94%,white));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:12px;color:var(--dsw-alias-label-primary,#e6ecff);z-index:6;pointer-events:auto;box-sizing:border-box;user-select:none}',
			'.dsh-pet-panel h4{margin:0 0 6px;font-size:12px;font-weight:600}',
			'.dsh-pet-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0}',
			'.dsh-pet-row label{color:var(--dsw-alias-label-secondary,#b8c5ea);flex:none}',
			'.dsh-pet-row input[type=range]{flex:1;min-width:0;accent-color:#5b8cff}',
			'.dsh-pet-row select{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e6ecff);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;padding:2px 6px;font-size:11px;max-width:128px}',
			'.dsh-pet-switch{appearance:none;width:30px;height:17px;border-radius:999px;border:1px solid rgba(128,128,128,.4);background:transparent;position:relative;cursor:pointer;flex:none;margin:0}',
			'.dsh-pet-switch:checked{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#4caf7d) 30%,transparent);border-color:var(--dsw-alias-state-success-primary,#4caf7d)}',
			'.dsh-pet-switch::after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:999px;background:rgba(128,128,128,.6);transition:left .14s ease}',
			'.dsh-pet-switch:checked::after{left:15px;background:var(--dsw-alias-state-success-primary,#4caf7d)}',
			'.dsh-pet-close-btn{width:100%;margin-top:8px;padding:6px 0;border:none;border-radius:8px;background:rgba(232,17,35,.16);color:#ff7a85;cursor:pointer;font-size:12px;font-family:inherit}',
			'.dsh-pet-close-btn:hover{background:rgba(232,17,35,.3)}',
			'.dsh-pet-root{transition:transform .25s ease}',
			'.dsh-pet-root.collapsed{transform:scale(.45) translateY(38%);transform-origin:center bottom}',
			'.dsh-pet-root.collapsed:hover{transform:scale(.75) translateY(10%)}',
			'.dsh-pet-call{position:fixed;z-index:2147483647;pointer-events:auto;padding:6px 12px;border:none;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#101828) 92%,transparent);color:var(--dsw-alias-label-secondary,#b8c5ea);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));cursor:pointer;font-size:11px;box-shadow:0 4px 14px rgba(0,0,0,.35);opacity:.85;transition:opacity .15s ease;font-family:inherit}',
			'.dsh-pet-call:hover{opacity:1;color:var(--dsw-alias-label-primary,#eef2ff)}',
			'@media (prefers-reduced-motion: reduce){.dsh-pet-toolbar,.dsh-pet-call,.dsh-pet-root,.dsh-pet-panel{transition:none}}',
		].join('\n');
		const cssTag = 'dsh-pet/style.css';
		// 只在页面还没有这个 style 标签时才注入（防止热重载/重复挂载时重复）
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTag + '"]') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-pet';
			tag.dataset.pluginCss = cssTag;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ============================================================================
		// 动画目录（animation catalog）—— 所有动画名和参数的"事实来源"
		// ============================================================================
		// 对齐说明：thumb 视频是 360×360 画布，人物的"脚底"在 y=330 处。
		// (360-330)/360 = 30/360 = 0.0833，与 1200 母版 (1200-1100)/1200 比例一致，
		// 所以用这个比例做落地对齐，缩放后依然准确。
		const CANVAS_H = 360; // thumb 画布高度
		const FEET_Y = 330;   // thumb 画布上"脚底"的 y 坐标（人物站在 y=330 线上）

		// 主体待机动画（唯一常驻、循环播放）
		const IDLE = '待机呼吸休闲';
		// 转向动画（东张西望本身内容就是"从偏左看到偏右"，播完翻转 facing）
		const TURN = '东张西望';
		// 随机动作池：纯字符串数组，全部等概率抽取。
		// 含"打瞌睡被惊醒"（原独立闲置动画，已统一纳入）。
		// 注意：原地漂浮踏步不在这里，它是移动动画（在 MOVES 里）。
		const ACTS = [
			'悠闲哼歌',
			'超大伸懒腰',
			'原地专心玩魔方',
			'原地敲击桌面互动',
			'原地重力下蹲压缩',
			'哈欠连天',
			'原地小憩沉眠',
			'原地蹲下玩玩具汽车',
			'鲸鱼吐泡泡特效',
			'女仆屈膝礼仪',
			'被吓一跳（炸毛）',
			'原地跳跃抓碎头顶物品',
			'小幅度原地 360 度旋转展示',
			'偷吃零食被抓住',
			'玩游戏气急败坏',
			'用鲸鱼尾巴拍打地面',
			'打瞌睡被惊醒', // 原独立闲置动画，已并入
			'玩水枪',
			'小提琴演奏',
		];
		// 点击回应动画池（3 选 1）
		const CLICKS = ['点击回应 - 开心跃动', '点击回应 - 害羞惊讶', '点击回应 - 傲娇生气（侧身展示）'];
		// 拖拽动画（按住时播放）
		const DRAG = '被鼠标拖拽悬空反馈';
		// 移动动画池：动画只提供"走路姿态"，实际位置移动由代码（rAF）驱动
		const MOVES = ['螃蟹走路', '原地漂浮踏步', '原地左转奔跑'];
		// 移动参数：
		const MOVE_MIN_PX = 60;  // 每次移动的最短距离（px）
		const MOVE_MAX_PX = 240; // 每次移动的最长距离（px）
		const MOVE_MARGIN = 20;  // 屏幕边缘安全边距（px），防止宠物贴边/出屏
		const MOVE_LEAD_SEC = 2; // 动画开头 2s 是"准备动作"，位置不动
		const MOVE_TAIL_SEC = 2; // 动画结尾 2s 是"收尾动作"，位置不动

		// 生成 [min, max) 区间内的随机整数
		const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
		// 从字符串池里等概率随机抽一个；exclude 排除某个名字（避免连续重复）
		const pick = (pool, exclude) => {
			const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
			return entries[Math.floor(Math.random() * entries.length)];
		};

		// ============================================================================
		// 桌宠设置（V4.2）—— 面板 + 持久化
		// ============================================================================
		// 说明：DSH 客户端配置管线暂未把 patch 配置下发到浏览器（client 收到
		// 空对象），所以设置面板把用户选择存到 localStorage（dsh-pet:settings:v1），
		// 优先级：localStorage > config（patch 里若有 size/position 兜底）> 默认值。
		const SETTINGS_KEY = 'dsh-pet:settings:v1';
		const DEFAULT_SETTINGS = {
			size: 260,          // 显示尺寸（px）
			corner: 'bottom-right', // 角落位置；'free' = 跟随拖拽的自定义位置
			interactions: true, // 互动开关（点击回应 / 随机动作）
			autoHide: false,    // 自动挂边（空闲折叠成小图标）
			hidden: false,      // 是否已关闭（隐藏）——面板「关闭桌宠」/ 工具条 ×
		};
		const PET_CORNERS = [
			{ value: 'bottom-right', label: '右下角' },
			{ value: 'bottom-left', label: '左下角' },
			{ value: 'top-right', label: '右上角' },
			{ value: 'top-left', label: '左上角' },
			{ value: 'free', label: '自由位置（拖拽）' },
		];
		const readSettings = (config) => {
			let saved = {};
			try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch {}
			return {
				...DEFAULT_SETTINGS,
				size: (config && config.size) || DEFAULT_SETTINGS.size,
				corner: (config && config.position) || DEFAULT_SETTINGS.corner,
				...saved,
			};
		};
		const saveSettings = (s) => {
			try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
		};
		// 角落 → 召唤按钮的固定坐标（hidden 时显示）
		const CALL_POS = {
			'bottom-right': { right: 24, bottom: 24 },
			'bottom-left': { left: 24, bottom: 24 },
			'top-right': { right: 24, top: 52 },
			'top-left': { left: 24, top: 52 },
		};

		// ============================================================================
		// Pet 组件 —— 宠物本体
		// ============================================================================
		/**
		 * 核心组件。职责：
		 * 1. 渲染"双缓冲"的一对 <video>（A/B 交替显示），切换动画时交叉淡入，永无空白帧
		 * 2. 状态机：待机 →（定时器随机）→ 转向/移动/动作；点击/拖拽可打断
		 * 3. 朝向（facing）渲染：right 时 CSS 镜像
		 *
		 * 参数 config：来自 patch 配置。当前 DSH 客户端配置管线尚未打通，
		 * 实际收到的是空对象，所以全部由 readSettings 的 localStorage 优先级兜底。
		 */
		function Pet({ config }) {
			// ---- 设置（localStorage 优先，config 兜底） ----
			const [settings, setSettings] = useState(() => readSettings(config));
			const [panelOpen, setPanelOpen] = useState(false);
			const [collapsed, setCollapsed] = useState(false); // 自动挂边折叠
			const lastInteractRef = useRef(Date.now());
			// 写入即持久化
			useEffect(() => { saveSettings(settings); }, [settings]);
			const patchSetting = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));

			const size = settings.size;
			const corner = settings.corner === 'free' ? 'bottom-right' : settings.corner;
			const interactions = settings.interactions;
			// 挂边折叠的 idle 计时：设置里没开自动挂边时永不折叠
			useEffect(() => {
				if (!settings.autoHide) { setCollapsed(false); return; }
				const timer = setInterval(() => {
					if (Date.now() - lastInteractRef.current > 8000) setCollapsed(true);
				}, 1000);
				return () => clearInterval(timer);
			}, [settings.autoHide]);
			const touch = () => { lastInteractRef.current = Date.now(); setCollapsed(false); };

			// ---- React 状态 ----
			const [anim, setAnim] = useState(IDLE);   // 当前动画名
			const [once, setOnce] = useState(true);   // 是否一次性播放——链式模型全部一次性
			const [facing, setFacing] = useState('left'); // 朝向：left | right
			const [dragging, setDragging] = useState(false); // 是否正在拖拽
			// 自定义位置（拖拽/移动后宠物停留的视口坐标）；null = 回到默认角落
			const [customPos, setCustomPos] = useState(null);
			// 播放序号：每次切换 +1。即使连续选中同一个动画（如待机播完又选待机），
			// seq 变化也能保证 switchTo 重新执行、视频重新播放（否则 anim 没变 React 不重渲染）。
			const [seq, setSeq] = useState(0);
			// ---- DOM 引用 ----
			const rootRef = useRef(null);  // 根容器（fixed 定位）
			const stageRef = useRef(null); // 内部舞台（落地对齐）
			const videoARef = useRef(null); // 视频 A
			const videoBRef = useRef(null); // 视频 B
			// ---- 双缓冲/竞态相关 ref ----
			const frontRef = useRef(0);  // 当前显示的是哪个视频：0=A, 1=B
			const pendingRef = useRef(null); // 正在加载中的 {anim, once, gen}
			const genRef = useRef(0);    // 切换代数：每次切换 +1，用于识别"过期回调"
			// ---- 交互相关 ref ----
			const dragRef = useRef({ active: false, dragging: false, sx: 0, sy: 0 }); // 拖拽状态
			const justDraggedRef = useRef(false); // 刚拖拽完（用于抑制拖拽后的误点击）
			const animRef = useRef(IDLE); // 动画名镜像（供异步回调读当前值）
			animRef.current = anim;

			// ============================================================================
			// 双缓冲切换（switchTo）—— 核心播放逻辑
			// ============================================================================
			// 思路：两个 video 层叠。切换动画时：
			//   1. 把目标动画 src 设到"非当前显示"的那个 video 上
			//   2. 等它 loadeddata（数据加载完成）
			//   3. 新 video 淡入（加 is-front），旧 video 淡出（去 is-front）
			//   4. frontRef 翻转，下次切换用另一个
			// 这样切换时旧画面一直显示到新画面就绪，永远不会闪空白。
			//
			// 竞态防护（重要）：快速连点/连续切换时，可能前一个动画还没加载完
			// 就又要切下一个。每个切换有一个递增的"代数" gen，loadeddata 回调
			// 执行时检查自己是否还是最新代——不是就放弃（避免两个 video 都被
			// 移除 is-front 而全部透明、宠物消失）。
			const switchTo = (next, nextOnce) => {
				// 如果目标动画已经在加载中，直接跳过（避免重复加载）
				const pending = pendingRef.current;
				if (pending && pending.anim === next && pending.once === nextOnce) return;
				const gen = ++genRef.current; // 本次切换的代数
				pendingRef.current = { anim: next, once: nextOnce, gen };

				// 目标 video = 当前"非显示"的那个（front 是 A 就用 B，反之用 A）
				const target = frontRef.current === 0 ? videoBRef : videoARef;
				const el = target.current;
				if (!el) return;
				// 设置视频属性并开始加载
				el.src = '/pet/thumb/' + encodeURIComponent(next) + '.webm';
				el.loop = !nextOnce;           // 一次性动画不循环
				el.muted = true;               // 静音（动画无声音）
				el.autoplay = true;            // 自动播放
				el.playsInline = true;         // 行内播放（移动端不弹全屏）
				el.onended = nextOnce ? handleEnded : undefined; // 一次性动画播完 → 回待机
				el.load();

				// 数据加载完成后的回调
				const onReady = () => {
					el.removeEventListener('loadeddata', onReady);
					// 过期检查：如果期间又有更新的切换，本回调作废
					if (pendingRef.current?.gen !== gen) return;
					// 交换前后台：新 video 加 is-front（淡入），旧 video 移除（淡出）
					const old = frontRef.current === 0 ? videoARef : videoBRef;
					el.classList.add('is-front');
					// old !== el 守卫：防止把自己刚加的 is-front 又移除
					if (old.current && old.current !== el) old.current.classList.remove('is-front');
					frontRef.current = frontRef.current === 0 ? 1 : 0;
					pendingRef.current = null;
					// 按实际朝向设置新视频镜像（inline transform，不依赖全局 CSS）：
					// facing=right 时 scaleX(-1)。onReady 时 facingRef 已是翻转后的值
					// （setFacing 的渲染先于 switchTo 执行）；旧视频 transform 不动，
					// 淡出时保持原朝向，不会露出未镜像的原画面。
					el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
					el.play().catch(() => {}); // 开始播放（捕获自动播放策略异常）
					// 如果这是"计划中的移动"的动画，现在动画就绪了，
					// 开始驱动位置移动（见 startMoveDrive）
					if (pendingMoveRef.current) startMoveDrive(el);
				};
				el.addEventListener('loadeddata', onReady);
				// 如果视频已缓存就绪（readyState>=2），立即触发回调
				if (el.readyState >= 2) onReady();
			};

			// ============================================================================
			// 随机事件定时器 —— 待机时的"自主行为"
			// ---- 状态驱动播放：anim/once/seq 一变就切换视频 ----
			// seq 参与依赖：即使 anim/once 没变（连续选中同一动画），seq 变化也强制重播。
			useEffect(() => {
				switchTo(anim, once);
			}, [anim, once, seq]);

			// ---- 组件卸载时清理移动 rAF ----
			useEffect(() => () => { stopMove(); }, []);

			// ---- 窗口尺寸变化：重算比例位置（触发重渲染，宠物保持相对窗口位置） ----
			useEffect(() => {
				const onResize = () => {
					// 有自定义位置时，用同值 setCustomPos 触发重渲染；
					// 渲染逻辑会用新窗口尺寸 × 比例重算坐标。
					setCustomPos((prev) => (prev ? { ...prev } : prev));
				};
				window.addEventListener('resize', onResize);
				return () => window.removeEventListener('resize', onResize);
			}, []);

			// ============================================================================
			// 动画链：每次动画播完 → 按概率选下一个
			// ============================================================================
			// 链式模型（无常驻待机、无定时器）：
			//   每个动画（含待机呼吸休闲）都是一次性播放，播完 handleEnded 触发，
			//   按概率选下一个：30% 待机 / 10% 转向 / 40% 动作 / 20% 移动。
			//   点击/拖拽打断的动画播完后先回待机（作为缓冲），待机播完再进随机链。
			const pickNext = () => {
				if (!interactions) { setAnim(IDLE); setOnce(true); setSeq((s) => s + 1); return; }
				const roll = Math.random();
				if (roll < 0.3) {
					// 30% 待机：待机呼吸休闲（也是一次性，播完再选）
					setAnim(IDLE);
				} else if (roll < 0.4) {
					// 10% 转向：东张西望，播完 handleEnded 里翻转 facing
					setAnim(TURN);
				} else if (roll < 0.8) {
					// 40% 随机动作（等概率 + 去重）
					setAnim(pick(ACTS, animRef.current));
				} else {
					// 20% 尝试移动：tryMove 先检查空间，不够就回退随机动作
					if (!tryMove()) {
						setAnim(pick(ACTS, animRef.current));
					}
				}
				setOnce(true);        // 链式模型全部一次性
				setSeq((s) => s + 1); // 保证即使 anim 没变也重新播放
			};

			// 一次性动画播完的回调：决定下一个动画。
			// 拖拽中途不响应（让拖拽动画继续）。
			const handleEnded = () => {
				if (dragRef.current.active) return; // 拖拽中：不打断
				if (animRef.current === TURN) {
					// 东张西望播完 → 翻转朝向
					setFacing((f) => (f === 'left' ? 'right' : 'left'));
				}
				// 点击回应/拖拽动画（用户打断触发的）播完 → 先回待机缓冲
				if (animRef.current === DRAG || CLICKS.includes(animRef.current)) {
					setAnim(IDLE);
					setOnce(true);
					setSeq((s) => s + 1);
					return;
				}
				// 自主链动画播完 → 按概率选下一个
				pickNext();
			};

			// ============================================================================
			// 移动系统 —— 动画提供姿态，代码驱动位置
			// ============================================================================
			const moveRef = useRef(null);        // 移动中的 rAF id
			const moveTokenRef = useRef(0);      // 移动令牌：每次取消 +1 使旧回调失效
			const pendingMoveRef = useRef(null); // 计划中的移动 {startX,startY,target,dir,total}
			const customPosRef = useRef(null);   // customPos 的 ref 镜像（供异步读取）
			customPosRef.current = customPos;

			// 当前宠物中心 x（视口坐标）：
			// customPos 存"相对窗口比例"（rx = centerX/innerWidth），渲染时乘当前窗口尺寸。
			// 窗口 resize 后按新尺寸重算 → 宠物保持相对位置。
			const currentCenterX = () => {
				const cp = customPosRef.current;
				if (cp) return cp.rx * window.innerWidth;
				const rootEl = rootRef.current;
				if (rootEl) return rootEl.getBoundingClientRect().left + size / 2;
				return window.innerWidth - 24 - size / 2;
			};
			// 当前宠物中心 y（视口坐标）
			const currentCenterY = () => {
				const cp = customPosRef.current;
				if (cp) return cp.ry * window.innerHeight;
				const rootEl = rootRef.current;
				if (rootEl) return rootEl.getBoundingClientRect().top + size / 2;
				return window.innerHeight - 20 - size / 2;
			};

			/**
			 * 启动"位置驱动"循环。只在移动动画真正加载完成并开始播放后调用
			 * （在 switchTo 的 onReady 里），保证人物姿态先出现在屏幕上、位置才开始动。
			 *
			 * 关键设计：位置跟随动画的播放时钟（video.currentTime）——
			 *   动画开头 MOVE_LEAD_SEC(2s) 是准备动作：位置不动
			 *   中间窗口：位置按 (t-LEAD)/window 比例从起点走向终点
			 *   结尾 MOVE_TAIL_SEC(2s) 是收尾动作：位置已到终点不动
			 * 这样踏步节奏和位移完全同步，不会有"滑步"。
			 */
			const startMoveDrive = (el) => {
				const pm = pendingMoveRef.current;
				if (!pm || moveRef.current !== null) return; // 没有计划或已在移动
				pendingMoveRef.current = null;
				const { startRatio, startYRatio, targetRatio, dir, totalRatio } = pm;
				// 动画时长驱动节奏（10.09s），取不到时兜底
				const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
				// 真正移动的窗口 = 总时长 - 前后 2s（至少 0.1s 防除零）
				// 命名注意：不能叫 window——会遮蔽全局 window，导致 window.innerWidth 变 undefined（历史 bug）
				const travelWindow = Math.max(0.1, duration - MOVE_LEAD_SEC - MOVE_TAIL_SEC);
				const token = ++moveTokenRef.current;
				const step = () => {
					if (moveTokenRef.current !== token) return;
					const t = el.currentTime || 0; // 动画当前播放进度（秒）
					const rootEl = rootRef.current;
					if (rootEl) {
						// 每帧用"当前窗口尺寸 × 比例"算实际坐标——resize 后自动跟随
						const W = window.innerWidth;
						const H = window.innerHeight;
						let ratioX;
						if (t <= MOVE_LEAD_SEC) {
							ratioX = startRatio; // 准备动作：原地
						} else if (t >= duration - MOVE_TAIL_SEC) {
							ratioX = targetRatio; // 收尾动作：已到终点
						} else {
							// 移动窗口：按进度插值（比例制）
							const progress = (t - MOVE_LEAD_SEC) / travelWindow;
							ratioX = startRatio + dir * totalRatio * progress;
						}
						const px = ratioX * W;
						const py = startYRatio * H;
						// 直接改 DOM style（不触发 React 重渲染，保证 60fps 平滑）
						rootEl.style.left = (px - size / 2) + 'px';
						rootEl.style.top = (py - size / 2) + 'px';
						rootEl.style.right = 'auto';
						rootEl.style.bottom = 'auto';
					}
					if (t < duration - MOVE_TAIL_SEC) {
						moveRef.current = requestAnimationFrame(step); // 继续下一帧
					} else {
						// 到位：提交终点位置（存相对窗口比例），让动画自然播完最后 2s 收尾——
						// 它是一次性动画，ended 事件会带我们回待机
						moveRef.current = null;
						setCustomPos({ rx: targetRatio, ry: startYRatio });
					}
				};
				moveRef.current = requestAnimationFrame(step);
			};

			/**
			 * 尝试计划一次移动（朝当前 facing 方向）。
			 * 只做两件事：检查空间是否够 + 记录计划；真正的位置驱动
			 * 等移动动画就绪后由 switchTo 的 onReady 触发。
			 * @returns {boolean} true=移动已计划；false=空间不够（调用方回退随机动作）
			 */
			const tryMove = () => {
				if (moveRef.current !== null || pendingMoveRef.current) return true; // 已在移动/已计划
				// 方向按"实际朝向"计算：若刚播完东张西望（animRef 仍为 TURN），
				// facing 即将翻转，方向取反——否则人物"脸朝新方向、却往旧方向走"。
				const dir = (facingRef.current === 'right') !== (animRef.current === TURN) ? 1 : -1; // 朝右=+1，朝左=-1
				const W = window.innerWidth;
				const cx = currentCenterX();
				const distance = randomBetween(MOVE_MIN_PX, MOVE_MAX_PX);
				const target = cx + dir * distance;
				// 【播放前检查一次距离】目标点必须在屏幕安全边距内，否则不移动
				const leftBound = MOVE_MARGIN + size / 2;
				const rightBound = W - MOVE_MARGIN - size / 2;
				if (target < leftBound || target > rightBound) return false; // 空间不够
				// 记录计划（存"比例"而非绝对坐标，resize 后仍正确）：
				// 起点比例、目标比例、Y 比例、方向、总距离比例
				pendingMoveRef.current = {
					startRatio: cx / W,
					startYRatio: currentCenterY() / window.innerHeight,
					targetRatio: target / W,
					dir,
					totalRatio: Math.abs(target - cx) / W,
				};
				// 移动动画一次性播放（10s），播完 ended 触发 handleEnded → 进入动画链
				setOnce(true);
				setAnim(pick(MOVES));
				return true;
			};
			// 停止移动（点击/拖拽打断时调用）：取消计划 + 使 rAF 失效 + 取消帧
			const stopMove = () => {
				pendingMoveRef.current = null;
				moveTokenRef.current++;
				if (moveRef.current !== null) {
					cancelAnimationFrame(moveRef.current);
					moveRef.current = null;
				}
			};

			// facing 的 ref 镜像（tryMove/定时器读取当前朝向）
			const facingRef = useRef(facing);
			facingRef.current = facing;

			// ============================================================================
			// 点击 vs 拖拽的区分
			// ============================================================================
			// 问题：按下+松开可能是一次"点击"，也可能是一次"拖拽"。
			// 方案：pointerdown 只记录起点；pointermove 超过 5px 才判定为拖拽
			// （播放拖拽动画并跟手）；松手时若没拖过，click 事件正常触发点击回应。
			const DRAG_THRESHOLD = 5; // 拖拽判定阈值（px）

			// 按下：只记录，不立即切动画
			const handlePointerDown = (e) => {
				touch(); // 交互刷新 idle 计时（取消挂边折叠）
				stopMove(); // 用户交互打断正在进行的移动
				e.currentTarget.setPointerCapture(e.pointerId); // 捕获指针（拖出元素也能收到 move）
				dragRef.current = { active: true, dragging: false, sx: e.clientX, sy: e.clientY };
			};
			// 移动：超过阈值才进入拖拽模式
			const handlePointerMove = (e) => {
				const d = dragRef.current;
				if (!d.active) return;
				const dx = e.clientX - d.sx;
				const dy = e.clientY - d.sy;
				if (!d.dragging) {
					// 还没超过阈值：仍是"点击候选"，不动
					if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
					// 进入拖拽：播放拖拽动画
					d.dragging = true;
					setDragging(true);
					setOnce(true);
					setAnim(DRAG);
				}
				// 跟手：直接改 root 的 style（不触发 React 重渲染 → 60fps 平滑）
				const rootEl = rootRef.current;
				if (rootEl) {
					rootEl.style.left = (e.clientX - size / 2) + 'px';
					rootEl.style.top = (e.clientY - size / 2) + 'px';
					rootEl.style.right = 'auto';
					rootEl.style.bottom = 'auto';
				}
				const stageEl = stageRef.current;
				if (stageEl) stageEl.style.transform = 'none'; // 拖拽时去掉落地偏移
			};
			// 松手：真拖拽则停留 + 回待机；没拖过则等 click 事件
			const handlePointerUp = (e) => {
				const d = dragRef.current;
				const wasDragging = d.dragging;
				d.active = false;
				d.dragging = false;
				if (wasDragging) {
					// 抑制拖拽结束后的"幽灵点击"（浏览器在拖完也会发 click）
					justDraggedRef.current = true;
					setTimeout(() => { justDraggedRef.current = false; }, 100);
					setDragging(false);
					// 停在松手处（存相对窗口比例，窗口变化时位置跟随）
					setCustomPos({
						rx: e.clientX / window.innerWidth,
						ry: e.clientY / window.innerHeight,
					});
					const stageEl = stageRef.current;
					if (stageEl) stageEl.style.transform = 'translateY(' + bottomPad + 'px)'; // 恢复落地对齐
					setAnim(IDLE);
					setOnce(false);
				}
				// 没拖过：交给 handleClick
			};

			// ---- 点击回应（仅真点击触发，拖拽后的 click 被忽略） ----
			const handleClick = () => {
				setPanelOpen(false); // 点宠物本体时收起设置面板
				const d = dragRef.current;
				if (d.active || d.dragging || justDraggedRef.current) return; // 拖拽中/刚拖完：忽略
				if (!interactions) return; // 互动开关关闭：不回应
				if (once && animRef.current !== IDLE) return; // 正在播一次性动画：不打断
				stopMove(); // 点击打断移动
				setOnce(true);
				setAnim(pick(CLICKS)); // 随机一个点击回应动画
			};

			// ============================================================================
			// 渲染
			// ============================================================================
			// 落地对齐：视频是 360 画布、脚在 y=330，脚底距画布底 30px。
			// bottomPad = size × (360-330)/360，把舞台向下平移这么多，
			// 让"脚"正好落在视口底线上（宠物看起来站在地上而不是悬空）。
			const bottomPad = (size * (CANVAS_H - FEET_Y)) / CANVAS_H;
			// 舞台样式：拖拽中无偏移；平时 translateY(bottomPad) 落地
			const stageStyle = dragging
				? { transform: 'none' }
				: { transform: 'translateY(' + bottomPad + 'px)' };

			// 根容器样式：有自定义位置（拖过/走过）就按"相对窗口比例 × 当前窗口尺寸"定位；
			// 否则不设（走 CSS 的 data-corner 默认角落，天然响应式）。
			// resize 后重渲染会用新尺寸重算 → 宠物保持相对位置；
			// 同时钳制到窗口内，防止窗口缩小到宠物放不下时跑出屏幕。
			const rootStyle = customPos
				? (() => {
					const half = size / 2;
					const rx = customPos.rx;
					const ry = customPos.ry;
					const left = Math.min(Math.max(rx * window.innerWidth - half, 0), window.innerWidth - size);
					const top = Math.min(Math.max(ry * window.innerHeight - half, 0), window.innerHeight - size);
					return { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' };
				})()
				: {};

			// 两个 video 共用的 props（事件绑定 + 播放属性）
			const commonVideoProps = {
				muted: true,
				playsInline: true,
				autoPlay: true,
				onClick: handleClick,
				onPointerDown: handlePointerDown,
				onPointerMove: handlePointerMove,
				onPointerUp: handlePointerUp,
				onPointerCancel: handlePointerUp,
				title: 'dsh-pet',
			};

			// 渲染树：root > [toolbar, panel, stage > [video A, video B]]
			// A 初始带 is-front（显示），B 隐藏待命
			// 位置选择为非自由（角落）时，清掉拖拽自定义位置，回到 CSS 角落定位
			useEffect(() => { if (settings.corner !== 'free') setCustomPos(null); }, [settings.corner]);
			// hidden=true 时整个 root 不渲染，只留「召唤桌宠」按钮（CALL_POS 定位）。
			if (settings.hidden) {
				return h('button', {
					type: 'button',
					className: 'dsh-pet-call',
					style: CALL_POS[settings.corner] || CALL_POS['bottom-right'],
					title: '点击召唤桌宠',
					onClick: () => { touch(); patchSetting('hidden', false); },
					children: '召唤桌宠',
				});
			}

			const rootClass = 'dsh-pet-root' + (collapsed ? ' collapsed' : '');
			return h('div', {
				ref: rootRef,
				className: rootClass,
				'data-corner': corner,   // CSS 决定默认角落
				'data-facing': facing,   // CSS 决定是否镜像
				onMouseEnter: () => setCollapsed(false),
				onMouseLeave: () => touch(),
				style: Object.assign({ '--dsh-pet-size': size + 'px' }, rootStyle),
				children: [
					// 悬停工具条：设置 ⚙ / 关闭 ×（stopPropagation 防止触发宠物点击回应）
					h('div', {
						className: 'dsh-pet-toolbar',
						children: [
							h('button', {
								type: 'button',
								className: 'dsh-pet-tbtn',
								title: '桌宠设置',
								'aria-label': '桌宠设置',
								onClick: (e) => { e.stopPropagation(); setPanelOpen((v) => !v); },
								children: '设',
							}),
							h('button', {
								type: 'button',
								className: 'dsh-pet-tbtn danger',
								title: '关闭桌宠',
								'aria-label': '关闭桌宠',
								onClick: (e) => { e.stopPropagation(); touch(); patchSetting('hidden', true); },
								children: '\u00d7',
							}),
						],
					}),
					// 设置面板
					panelOpen ? h('div', {
						className: 'dsh-pet-panel',
						onClick: (e) => e.stopPropagation(),
						children: [
							h('h4', { children: '桌宠设置' }),
							h('div', {
								className: 'dsh-pet-row',
								children: [
									h('label', { children: '大小' }),
									h('input', {
										type: 'range',
										min: 120,
										max: 420,
										step: 10,
										value: settings.size,
										onChange: (e) => patchSetting('size', Number(e.target.value)),
									}),
									h('span', { style: { color: 'var(--dsw-alias-label-tertiary,#7c8fc0)', fontVariantNumeric: 'tabular-nums', flex: 'none', minWidth: 34, textAlign: 'right' }, children: settings.size + 'px' }),
								],
							}),
							h('div', {
								className: 'dsh-pet-row',
								children: [
									h('label', { children: '位置' }),
									h('select', {
										value: settings.corner,
										onChange: (e) => { patchSetting('corner', e.target.value); if (e.target.value === 'free') { setPanelOpen(false); } },
										children: PET_CORNERS.map((c) => h('option', { key: c.value, value: c.value, children: c.label })),
									}),
								],
							}),
							h('div', {
								className: 'dsh-pet-row',
								children: [
									h('label', { children: '互动（点击回应 / 随机动作）' }),
									h('input', {
										type: 'checkbox',
										className: 'dsh-pet-switch',
										checked: settings.interactions,
										onChange: (e) => patchSetting('interactions', e.target.checked),
									}),
								],
							}),
							h('div', {
								className: 'dsh-pet-row',
								children: [
									h('label', { children: '自动挂边隐藏（空闲折叠）' }),
									h('input', {
										type: 'checkbox',
										className: 'dsh-pet-switch',
										checked: settings.autoHide,
										onChange: (e) => patchSetting('autoHide', e.target.checked),
									}),
								],
							}),
							h('button', {
								type: 'button',
								className: 'dsh-pet-close-btn',
								onClick: () => { touch(); setPanelOpen(false); patchSetting('hidden', true); },
								children: '关闭桌宠',
							}),
						],
					}) : null,
					// 舞台：两个 video 层叠
					h('div', {
						ref: stageRef,
						className: 'dsh-pet-stage',
						style: stageStyle,
						children: [
							h('video', Object.assign({}, commonVideoProps, { ref: videoARef, className: 'dsh-pet-video is-front' })),
							h('video', Object.assign({}, commonVideoProps, { ref: videoBRef, className: 'dsh-pet-video' })),
						],
					}),
				],
			});
		}

		// ============================================================================
		// 插件主体（Cordis 插件三件套：name / inject / apply）
		// ============================================================================
		const name = 'pet';        // 插件行 id（与 cordis.patch.yml 一致）
		const inject = ['slots'];  // 需要注入的服务：slots（槽位注册表）

		// apply：插件被激活时调用
		function apply(ctx, config) {
			// 官方"叠加式"注册模式：
			// slots.inject 等 shell.overlay 槽位被声明后，再注册我们的条目。
			// 用 generator + yield 形式（与官方 dsh-client-ui-directory-picker-native 一致），
			// 这样不会替换其他条目，而是以 id='pet' 叠加进列表槽。
			ctx.slots.inject('shell.overlay', function* () {
				yield ctx.slots.register({
					name: 'shell.overlay',
					id: 'pet',       // 列表槽的条目 id（唯一）
					order: 1000,     // 排序（大 = 靠后渲染）
				}, (ownerProps) => h(Pet, { config, ...ownerProps }));
			});
		}

		// 导出插件三件套（Cordis Loader 需要）
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
