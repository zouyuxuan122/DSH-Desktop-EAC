window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-skin-switch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region skin-switch css
		const css = ".sks_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}.sks_header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.sks_header p{margin:0;flex:1;min-width:200px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}.sks_reset{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:var(--dsw-alias-bg-layer-3);border-radius:8px;height:32px;padding:0 12px;font-size:12.5px}.sks_reset:hover{border-color:var(--dsw-alias-label-dimmed)}.sks_reset:disabled{opacity:.5;cursor:default}.sks_grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}.sks_card{position:relative;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column}.sks_card[data-active=\"1\"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}.sks_accent{height:5px;flex:none}.sks_body{display:flex;flex-direction:column;gap:8px;padding:12px 14px 14px;flex:1}.sks_cardHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.sks_name{font-size:14px;font-weight:600;line-height:20px}.sks_nameEn{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}.sks_active{font-size:10.5px;line-height:16px;padding:1px 7px;border-radius:999px;color:var(--dsw-alias-state-success-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);margin-left:auto}.sks_tagline{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.sks_tags{display:flex;gap:6px;flex-wrap:wrap}.sks_tag{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2)}.sks_desc{margin:0;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.sks_src{margin-top:auto;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2);font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);display:flex;flex-direction:column;gap:3px}.sks_src a{color:var(--dsw-alias-state-business-primary);text-decoration:none}.sks_src a:hover{text-decoration:underline}.sks_credit{color:var(--dsw-alias-label-secondary)}.sks_apply{margin-top:10px;border:none;border-radius:8px;height:32px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-state-business-primary)}.sks_apply:hover{filter:brightness(1.08)}.sks_apply:disabled{opacity:.55;cursor:default}.sks_apply[data-applied=\"1\"]{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary);cursor:default;border:1px solid var(--dsw-alias-border-l2)}.sks_status{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.sks_notice{margin:0;font-size:13px;line-height:20px}.sks_notice[data-kind=error]{color:var(--dsw-alias-state-error-primary)}.sks_notice[data-kind=success]{color:var(--dsw-alias-state-success-primary)}.sks_failure{color:var(--dsw-alias-state-error-primary);display:flex;align-items:center;gap:10px;margin:0;font-size:13px;line-height:20px}.sks_failure p{margin:0;flex:1;min-width:0}.sks_failure button{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:6px;padding:4px 10px}.sks_restart{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;line-height:20px}.sks_restart span{flex:1;min-width:160px}.sks_restart button{border:none;border-radius:8px;height:30px;padding:0 12px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-state-business-primary)}.sks_credits{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:8px}.sks_credits h3{margin:0;font-size:13px;font-weight:600;line-height:20px}.sks_credits p{margin:0;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}.sks_credits a{color:var(--dsw-alias-state-business-primary);text-decoration:none}.sks_credits a:hover{text-decoration:underline}.sks_credits small{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}.sks_preview{position:relative;flex:none;height:118px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:center}.sks_preview img{width:100%;height:100%;object-fit:cover;display:block}.sks_preview .sks_previewFallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}.sks_preview .sks_previewFallback i{display:block;width:34px;height:34px;border-radius:10px}";
		const tagId = "@deepseek-ai/dsh-skin-switch/skin-switch.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-skin-switch";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const s = {
			section: "sks_section", header: "sks_header", reset: "sks_reset", grid: "sks_grid", card: "sks_card",
			accent: "sks_accent", preview: "sks_preview", previewFallback: "sks_previewFallback", body: "sks_body", cardHead: "sks_cardHead", name: "sks_name", nameEn: "sks_nameEn",
			active: "sks_active", tagline: "sks_tagline", tags: "sks_tags", tag: "sks_tag", desc: "sks_desc",
			src: "sks_src", credit: "sks_credit", apply: "sks_apply", status: "sks_status", notice: "sks_notice",
			failure: "sks_failure", restart: "sks_restart", credits: "sks_credits"
		};
		//#endregion
		//#region locales
		const zh = {
			tab: "皮肤",
			intro: "皮肤由社区作者制作，随 DSH Desktop 内置分发；切换后重启服务生效。每款皮肤的出处与许可标注在卡片与文末「来源与版权」。",
			loading: "正在读取皮肤列表…",
			loadFailed: "读取皮肤列表失败：",
			retry: "重试",
			defaultSkin: "默认皮肤",
			reset: "恢复默认皮肤",
			resetting: "恢复中…",
			active: "当前生效",
			apply: "应用此皮肤",
			applying: "应用中…",
			applyDone: "已应用皮肤：",
			applyFailed: "应用皮肤失败：",
			resetDone: "已恢复默认皮肤",
			resetFailed: "恢复失败：",
			restartHint: "新皮肤将在服务重启后生效。",
			restartConfirm: "重启会中断当前正在运行的会话（历史记录保留）。确定现在重启服务吗？",
			restartNow: "立即重启服务",
			byAuthor: "作者",
			openRepo: "查看仓库",
			srcDshWebUi: "dsh-web-ui 系列皮肤",
			licBsd: "许可：BSD-3-Clause",
			srcMaid: "deep-whale-day-night · 鲸鱼娘昼夜工坊",
			licMaid: "许可：CC BY-NC-SA 4.0（署名-非商业性使用-相同方式共享，禁止商业使用）",
			creditMaid: "角色原作：上善（Pixiv 62155430 · B站「上善无形」）；DeepSeek 元素二次设计：ZipZipPipe（Pixiv 18604994 · B站「ZipZipPipe」）",
			noticeMaid: "完整版权链见皮肤包 NOTICE（assets/skins/maid-atelier/）。",
			srcUnknown: "出处见皮肤包内 LICENSE",
			creditsTitle: "来源与版权",
			creditsIntro: "以下皮肤均为第三方开源作品，版权归原作者所有，DSH Desktop 仅负责内置分发与切换管理：",
			repoDshWebUi: "dsh-web-ui（zhu1090093659）· https://github.com/zhu1090093659/dsh-web-ui",
			repoMaid: "deep-whale-day-night（GGBond2424648901 / Small-tailqwq）· https://github.com/GGBond2424648901/deep-whale-day-night-theme",
			creditsNote: "皮肤内容遵循各自许可；maid-atelier 禁止商业使用。"
		};
		const en = {
			tab: "Skins",
			intro: "Skins are made by community authors and shipped with DSH Desktop; changes take effect after the service restarts. Attribution and licenses are shown on each card and in “Sources & Credits” below.",
			loading: "Reading skins…",
			loadFailed: "Failed to read skins: ",
			retry: "Retry",
			defaultSkin: "Default skin",
			reset: "Restore default skin",
			resetting: "Restoring…",
			active: "Active",
			apply: "Apply this skin",
			applying: "Applying…",
			applyDone: "Skin applied: ",
			applyFailed: "Failed to apply skin: ",
			resetDone: "Default skin restored",
			resetFailed: "Failed to restore: ",
			restartHint: "The new skin takes effect after the service restarts.",
			restartConfirm: "Restarting interrupts the running session (history is kept). Restart the service now?",
			restartNow: "Restart service now",
			byAuthor: "Author",
			openRepo: "Repository",
			srcDshWebUi: "dsh-web-ui skin series",
			licBsd: "License: BSD-3-Clause",
			srcMaid: "deep-whale-day-night · Deep Whale Day & Night",
			licMaid: "License: CC BY-NC-SA 4.0 (Attribution-NonCommercial-ShareAlike, no commercial use)",
			creditMaid: "Character original: 上善 (Pixiv 62155430 · Bilibili “上善无形”); DeepSeek-flavored redesign: ZipZipPipe (Pixiv 18604994 · Bilibili “ZipZipPipe”)",
			noticeMaid: "Full credit chain is in the skin package NOTICE (assets/skins/maid-atelier/).",
			srcUnknown: "See LICENSE inside the skin package",
			creditsTitle: "Sources & Credits",
			creditsIntro: "The skins below are third-party open-source works. All rights belong to their original authors; DSH Desktop only bundles and manages them:",
			repoDshWebUi: "dsh-web-ui (zhu1090093659) · https://github.com/zhu1090093659/dsh-web-ui",
			repoMaid: "deep-whale-day-night (GGBond2424648901 / Small-tailqwq) · https://github.com/GGBond2424648901/deep-whale-day-night-theme",
			creditsNote: "Each skin follows its own license; maid-atelier is non-commercial."
		};
		const NS = "settings.dshSkinSwitch";
		//#endregion
		//#region attribution
		// 皮肤出处：kind → 文案/许可；所有 dsh-web-ui 系列皮肤同源。
		const SKIN_SOURCE_KIND = {
			"ui-skin-xp": "dsh-web-ui",
			"ui-skin-minecraft": "dsh-web-ui",
			"ui-skin-blue-fantasy": "dsh-web-ui",
			"ui-skin-whale-song": "dsh-web-ui",
			"ui-skin-trading": "dsh-web-ui",
			"ui-skin-qq98": "dsh-web-ui",
			"ui-skin-ths": "dsh-web-ui",
			"ui-skin-dragon-heir": "dsh-web-ui",
			"ui-skin-miku": "dsh-web-ui",
			"ui-skin-maid-atelier": "maid"
		};
		//#endregion
		//#region remote face
		const looseCodec = () => ({
			mode: "strict",
			typeSymbol: "@deepseek-ai/dsh-skin-switch/types#Json",
			schema: { parse: (value) => value }
		});
		const descriptor = (method, parameters) => ({
			id: `@deepseek-ai/dsh-skin-switch#skinSwitch/${method}`,
			service: "skinSwitch",
			namespace: "skinSwitch",
			method,
			invocation: { kind: "direct" },
			parameters: parameters.map((name) => ({ name, wire: name, source: "json", codec: looseCodec() })),
			result: looseCodec()
		});
		const REMOTE = {
			package: "@deepseek-ai/dsh-skin-switch",
			descriptors: [
				descriptor("list", []),
				descriptor("apply", ["id"]),
				descriptor("reset", [])
			]
		};
		const failureText = (result) => result.error?.message ?? String(result.error ?? "remote failed");
		//#endregion
		//#region components
		/** Live skin roster + the currently active skin id. */
		function useSkins(props) {
			const [state, setState] = react.useState({ status: "loading", skins: [], activeId: null, error: "" });
			const [tick, setTick] = react.useState(0);
			react.useEffect(() => {
				let alive = true;
				props.list().then((result) => {
					if (!alive) return;
					if (!result.ok) { setState({ status: "error", skins: [], activeId: null, error: failureText(result) }); return; }
					setState({ status: "ready", skins: result.value.skins ?? [], activeId: result.value.activeId ?? null, error: "" });
				}, (error) => { if (alive) setState({ status: "error", skins: [], activeId: null, error: String(error?.message ?? error) }); });
				return () => { alive = false; };
			}, [tick]);
			return { state, refresh: () => setTick((value) => value + 1) };
		}
		/** 皮肤预览图：按系统亮/暗主题取对应图，加载失败回退为主色块。 */
		function SkinPreview(props) {
			const [failed, setFailed] = react.useState(false);
			const prefersDark = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
			const src = props.preview ? props.preview[prefersDark ? "dark" : "light"] || props.preview.light : "";
			return (0, react_jsx_runtime.jsx)("div", {
				className: s.preview,
				children: failed || !src ? (0, react_jsx_runtime.jsx)("div", {
					className: s.previewFallback,
					children: (0, react_jsx_runtime.jsx)("i", { style: props.accent ? { background: props.accent } : undefined })
				}) : (0, react_jsx_runtime.jsx)("img", {
					src: src,
					alt: "",
					loading: "lazy",
					onError: () => setFailed(true)
				})
			});
		}
		/** One skin card: accent bar, name, tagline, tags, attribution, apply. */
		function SkinCard(props) {
			const t = props.t;
			const skin = props.skin;
			const kind = SKIN_SOURCE_KIND[skin.id] ?? "unknown";
			const isActive = props.activeId === skin.id;
			const busy = props.busy;
			return (0, react_jsx_runtime.jsx)("li", {
				className: s.card,
				"data-active": isActive ? "1" : "0",
				children: (0, react_jsx_runtime.jsxs)("div", {
					children: [
						(0, react_jsx_runtime.jsx)(SkinPreview, {
							skin: skin,
							active: isActive,
							accent: skin.accent,
							preview: skin.preview && typeof skin.preview === "object" ? skin.preview : null
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: s.body,
							children: [
								(0, react_jsx_runtime.jsx)("div", {
									className: s.accent,
									style: skin.accent ? { background: skin.accent } : undefined
								}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: s.cardHead,
							children: [
								(0, react_jsx_runtime.jsx)("strong", { className: s.name, children: skin.name }),
								skin.nameEn ? (0, react_jsx_runtime.jsx)("span", { className: s.nameEn, children: skin.nameEn }) : null,
								isActive ? (0, react_jsx_runtime.jsx)("span", { className: s.active, children: t("active") }) : null
							]
						}),
						skin.tagline ? (0, react_jsx_runtime.jsx)("p", { className: s.tagline, children: skin.tagline }) : null,
						skin.tags && skin.tags.length > 0 ? (0, react_jsx_runtime.jsx)("div", {
							className: s.tags,
							children: skin.tags.map((tag) => (0, react_jsx_runtime.jsx)("span", { className: s.tag, children: tag }, tag))
						}) : null,
						skin.description ? (0, react_jsx_runtime.jsx)("p", { className: s.desc, children: skin.description }) : null,
						(0, react_jsx_runtime.jsxs)("div", {
							className: s.src,
							children: [
								kind === "maid" ? (0, react_jsx_runtime.jsxs)("span", {
									children: [
										t("srcMaid") + " · " + t("byAuthor") + " Small-tailqwq · ",
										(0, react_jsx_runtime.jsx)("a", {
											href: "https://github.com/GGBond2424648901/deep-whale-day-night-theme",
											target: "_blank",
											rel: "noreferrer noopener",
											children: t("openRepo")
										}),
										" · " + t("licMaid")
									]
								}) : kind === "dsh-web-ui" ? (0, react_jsx_runtime.jsxs)("span", {
									children: [
										t("srcDshWebUi") + " · " + t("byAuthor") + " zhu1090093659 · ",
										(0, react_jsx_runtime.jsx)("a", {
											href: "https://github.com/zhu1090093659/dsh-web-ui",
											target: "_blank",
											rel: "noreferrer noopener",
											children: t("openRepo")
										}),
										" · " + t("licBsd")
									]
								}) : (0, react_jsx_runtime.jsx)("span", { children: t("srcUnknown") }),
								kind === "maid" ? (0, react_jsx_runtime.jsx)("span", { className: s.credit, children: t("creditMaid") }) : null,
								kind === "maid" ? (0, react_jsx_runtime.jsx)("small", { children: t("noticeMaid") }) : null
							]
						}),
						(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: s.apply,
							"data-applied": isActive ? "1" : "0",
							disabled: busy !== undefined || isActive,
							onClick: props.onApply,
							children: busy === "applying" ? t("applying") : isActive ? t("active") : t("apply")
						})
					]
				})
					]
				})
			});
		}
		/** The 皮肤 tab: skin cards + attribution block + restart banner. */
		function SkinTab(props) {
			const t = props.t;
			const [notice, setNotice] = react.useState(null);
			const [busy, setBusy] = react.useState({});
			const [restart, setRestart] = react.useState({ needed: false, available: false });
			const [localActive, setLocalActive] = react.useState(null);
			const skins = useSkins(props);
			react.useEffect(() => {
				// 只探测桥接是否存在,绝不触发真正的重启。
				const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
				setRestart((current) => ({ ...current, available: bridge !== undefined && typeof bridge.restartService === "function" }));
			}, []);
			const activeId = localActive !== null ? localActive : skins.state.activeId;
			const run = (verb, call, okPrefix, failPrefix) => {
				setBusy((current) => ({ ...current, [verb]: verb }));
				setNotice(null);
				call().then((result) => {
					setBusy((current) => { const next = { ...current }; delete next[verb]; return next; });
					if (!result.ok) { setNotice({ kind: "error", text: failPrefix + failureText(result) }); return; }
					setNotice({ kind: "success", text: okPrefix + (result.value.id ?? t("defaultSkin")) });
					setLocalActive(result.value.id ?? null);
					setRestart((current) => ({ ...current, needed: true }));
				}, (error) => {
					setBusy((current) => { const next = { ...current }; delete next[verb]; return next; });
					setNotice({ kind: "error", text: failPrefix + String(error?.message ?? error) });
				});
			};
			const doApply = (id) => run("applying", () => props.apply(id), t("applyDone"), t("applyFailed"));
			const doReset = () => run("resetting", () => props.reset(), t("resetDone"), t("resetFailed"));
			const requestRestart = () => {
				if (typeof window !== "undefined" && window.confirm(t("restartConfirm"))) props.restartService().catch(() => {});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: s.section,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: s.header,
						children: [
							(0, react_jsx_runtime.jsx)("p", { children: t("intro") }),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: s.reset,
								disabled: busy.applying !== undefined || busy.resetting !== undefined,
								onClick: doReset,
								children: busy.resetting === "resetting" ? t("resetting") : t("reset")
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
					skins.state.status === "loading" ? (0, react_jsx_runtime.jsx)("p", { className: s.status, children: t("loading") }) : null,
					skins.state.status === "error" ? (0, react_jsx_runtime.jsxs)("div", {
						className: s.failure,
						role: "alert",
						children: [
							(0, react_jsx_runtime.jsx)("p", { children: t("loadFailed") + (skins.state.error ?? "") }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", onClick: skins.refresh, children: t("retry") })
						]
					}) : null,
					skins.state.status === "ready" && skins.state.skins.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
						className: s.grid,
						children: skins.state.skins.map((skin) => (0, react_jsx_runtime.jsx)(SkinCard, {
							t,
							skin,
							activeId,
							busy: busy.applying,
							onApply: () => doApply(skin.id)
						}, skin.id))
					}) : null,
					(0, react_jsx_runtime.jsxs)("div", {
						className: s.credits,
						children: [
							(0, react_jsx_runtime.jsx)("h3", { children: t("creditsTitle") }),
							(0, react_jsx_runtime.jsx)("p", { children: t("creditsIntro") }),
							(0, react_jsx_runtime.jsx)("p", {
								children: (0, react_jsx_runtime.jsx)("a", {
									href: "https://github.com/zhu1090093659/dsh-web-ui",
									target: "_blank",
									rel: "noreferrer noopener",
									children: t("repoDshWebUi")
								})
							}),
							(0, react_jsx_runtime.jsx)("p", { children: t("licBsd") }),
							(0, react_jsx_runtime.jsx)("p", {
								children: (0, react_jsx_runtime.jsx)("a", {
									href: "https://github.com/GGBond2424648901/deep-whale-day-night-theme",
									target: "_blank",
									rel: "noreferrer noopener",
									children: t("repoMaid")
								})
							}),
							(0, react_jsx_runtime.jsx)("p", { children: t("licMaid") }),
							(0, react_jsx_runtime.jsx)("p", { className: s.credit, children: t("creditMaid") }),
							(0, react_jsx_runtime.jsx)("small", { children: t("noticeMaid") }),
							(0, react_jsx_runtime.jsx)("small", { children: t("creditsNote") })
						]
					})
				]
			});
		}
		//#endregion
		//#region client index
		/** Required browser services. */
		const inject = ["slots", "locale", "remote"];
		/**
		 * Mount the 皮肤 tab into Settings → Plugins. The tab itself is
		 * registered unconditionally; the dynamic Remote face is mounted in the
		 * background and every call resolves it lazily, so a mount problem shows
		 * up as an error banner inside the tab instead of the tab silently
		 * disappearing.
		 * @param ctx - browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-skin-switch: dictionaries");
			const t = ctx.locale.bind(NS);
			let mountFailure = null;
			const mountPromise = ctx.remote.$mount(REMOTE).then((dispose) => {
				ctx.effect(() => dispose, "dsh-skin-switch: remote face");
				return true;
			}, (error) => {
				mountFailure = String((error && error.message) || error);
				console.error("dsh-skin-switch: remote face mount failed", error);
				return false;
			});
			/** Resolve the mounted namespace service, waiting for the mount. */
			const remote = async () => {
				await mountPromise;
				if (mountFailure !== null) throw new Error("skinSwitch 远程接口未就绪: " + mountFailure);
				const service = ctx.get("remote.skinSwitch");
				if (service === void 0 || service === null || typeof service !== "object") {
					// 已挂载但 cordis 服务尚未出现:再等一个微任务重试一次。
					await new Promise((resolve) => setTimeout(resolve, 50));
					const retry = ctx.get("remote.skinSwitch");
					if (retry === void 0 || retry === null || typeof retry !== "object") throw new Error("skinSwitch 远程接口未注册");
					return retry;
				}
				return service;
			};
			const injected = () => ({
				list: async () => (await remote()).list(),
				apply: async (id) => (await remote()).apply(id),
				reset: async () => (await remote()).reset(),
				restartService: () => {
					const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
					if (bridge !== undefined && typeof bridge.restartService === "function") return bridge.restartService();
					return Promise.resolve({ available: false });
				}
			});
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "skin",
				order: 15,
				label: () => t("tab"),
				locale: NS,
				inject: injected
			}, SkinTab));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
