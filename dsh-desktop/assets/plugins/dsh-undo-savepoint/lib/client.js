window.__ModuleLoader__.load({
	id: "dsh-undo-savepoint",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region dsh-undo-savepoint styles
		const css = ".u_actions{display:flex;align-items:center;gap:4px;padding:0 2px}.u_btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35));background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-secondary, inherit);border-radius:8px;height:24px;padding:0 9px;font-size:12px;line-height:22px;display:inline-flex;align-items:center;gap:3px;white-space:nowrap}.u_btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15));color:var(--dsw-alias-label-primary, inherit)}.u_btn:disabled{opacity:.4;cursor:default}.u_undo{color:#e5484d;border-color:rgba(229,72,77,.45)}.u_undo:hover{background:rgba(229,72,77,.12);color:#e5484d}.u_redo{color:#30a46c;border-color:rgba(48,164,108,.45)}.u_redo:hover{background:rgba(48,164,108,.12);color:#30a46c}.u_list{color:var(--dsw-alias-label-secondary, inherit)}.u_list:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))}.u_msg{max-width:min(280px,40vw);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;padding:0 6px}.u_ok{color:var(--dsw-alias-label-tertiary, #888)}.u_err{color:var(--dsw-state-error-primary, #d9534f)}.u_overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px}.u_panel{width:min(860px,96vw);max-height:80vh;display:flex;flex-direction:column;background:var(--dsw-specific-panel, #fff);border:1px solid var(--dsw-alias-border-inverted, rgba(128,128,128,.4));border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden}.u_head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));flex:none}.u_title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary, inherit);flex:1}.u_toolbar{display:flex;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));flex-wrap:wrap;flex:none}.u_tbody{overflow-y:auto;padding:6px 14px 12px;flex:1}.u_table{width:100%;border-collapse:collapse;font-size:12px}.u_table th{text-align:left;color:var(--dsw-alias-label-tertiary, #888);font-weight:500;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));white-space:nowrap}.u_table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12));vertical-align:middle}.u_time{white-space:nowrap;color:var(--dsw-alias-label-secondary, inherit)}.u_kind{white-space:nowrap}.u_reason{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary, inherit)}.u_loc{white-space:nowrap;font-size:11px;opacity:.8}.u_rowbtn{cursor:pointer;border:none;background:0 0;color:var(--dsw-alias-label-secondary, inherit);font-size:12px;padding:2px 6px;border-radius:6px}.u_rowbtn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))}.u_rowbtn.u_okc{color:#30a46c}.u_rowbtn.u_errc{color:#e5484d}.u_empty{color:var(--dsw-alias-label-tertiary, #888);text-align:center;padding:24px 0;font-size:13px}.u_foot{display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));flex:none}.u_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;padding:10px 16px;box-sizing:border-box}.u_pair{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.u_keyLabel{color:var(--dsw-alias-label-primary, inherit);font-size:13px;flex:none;min-width:96px}.u_browseBtn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-secondary, inherit);border-radius:6px;width:28px;height:28px;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0}.u_browseBtn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))}.u_keyInput{width:110px;height:28px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));background:var(--dsw-alias-bg-base, transparent);color:var(--dsw-alias-label-primary, inherit);border-radius:6px;outline:none;padding:0 8px;font-size:12px;box-sizing:border-box}.u_keyInput:focus{border-color:var(--dsw-state-business-primary, #4a90d9)}.u_num{width:84px}.u_dir{width:280px}.u_hint{color:var(--dsw-alias-label-tertiary, #888);font-size:12px;flex:none}.u_save{cursor:pointer;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-primary, inherit);border-radius:8px;height:26px;padding:0 12px;font-size:12px}.u_save:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))}.u_close{cursor:pointer;border:none;background:0 0;color:var(--dsw-alias-label-tertiary, #888);font-size:18px;line-height:1;padding:2px 6px;border-radius:6px}.u_close:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))}.u_diffbox{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(720px,92vw);max-height:70vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-inverted, rgba(128,128,128,.4));border-radius:12px;background:var(--dsw-specific-panel, #fff);box-shadow:0 12px 40px rgba(0,0,0,.4);z-index:20000;font-size:12px}.u_diffhead{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));flex:none}.u_diffbody{overflow-y:auto;padding:2px 0 8px;flex:1}.u_difffile{font-weight:600;padding:6px 10px 2px;color:var(--dsw-alias-label-primary, inherit)}.u_diffadd{color:#30a46c;padding:0 10px 0 22px;white-space:pre-wrap;word-break:break-all}.u_diffdel{color:#e5484d;padding:0 10px 0 22px;white-space:pre-wrap;word-break:break-all}";
		const tagId = "dsh-undo-savepoint/undo.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-undo-savepoint";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		// v0.3.4 UI 增强补充样式:图标对齐 / 状态徽章 / 面板副标题
		const css2 = ".u_icon{display:inline-block;vertical-align:-2px;flex:none;line-height:0}.u_badge{cursor:pointer;border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35));background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-secondary, inherit);border-radius:999px;height:20px;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;flex:none}.u_badge:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15));color:var(--dsw-alias-label-primary, inherit)}.u_dot{width:6px;height:6px;border-radius:50%;background:#30a46c;flex:none}.u_subtitle{font-size:11px;color:var(--dsw-alias-label-tertiary, #888);font-weight:400;white-space:nowrap;max-width:min(220px,30vw);text-overflow:ellipsis;overflow:hidden}";
		const tagId2 = "dsh-undo-savepoint/undo.enhance.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-undo-savepoint";
			tag.dataset.pluginCss = tagId2;
			tag.textContent = css2;
			document.head.appendChild(tag);
		}
		var styles = {
			actions: "u_actions", btn: "u_btn", undo: "u_undo", redo: "u_redo", list: "u_list",
			icon: "u_icon", badge: "u_badge", dot: "u_dot", subtitle: "u_subtitle",
			msg: "u_msg", ok: "u_ok", err: "u_err",
			overlay: "u_overlay", panel: "u_panel", head: "u_head", title: "u_title", toolbar: "u_toolbar",
			tbody: "u_tbody", table: "u_table", time: "u_time", kind: "u_kind", reason: "u_reason", loc: "u_loc",
			rowbtn: "u_rowbtn", okc: "u_okc", errc: "u_errc", empty: "u_empty", foot: "u_foot",
			row: "u_row", pair: "u_pair", keyLabel: "u_keyLabel", keyInput: "u_keyInput", num: "u_num", dir: "u_dir", hint: "u_hint", browseBtn: "u_browseBtn",
			save: "u_save", close: "u_close", diffbox: "u_diffbox", diffhead: "u_diffhead", diffbody: "u_diffbody", difffile: "u_difffile", diffadd: "u_diffadd", diffdel: "u_diffdel"
		};
		//#endregion
		//#region locales
		const NS = "undo";
		const zh = {
			"undo": "撤销",
			"redo": "恢复",
			"snapshots": "快照",
			"undo.aria": "撤销上一步(回退最近一次配置变更)",
			"redo.aria": "恢复(重做上一次撤销)",
			"snapshots.aria": "立即手动存档当前配置",
			"badge.count": "已存 {n} 份快照",
			"badge.just": "刚刚",
			"badge.min": "{n} 分钟前",
			"badge.hour": "{n} 小时前",
			"badge.day": "{n} 天前",
			"badge.title": "自动快照状态,点击打开快照管理",
			"ok.undo": "已撤销 → {id}",
			"ok.redo": "已恢复",
			"ok.snapshot": "已存档 {id}",
			"err": "失败:{msg}",
			"err.busy": "有会话正在运行(agent 执行中),撤销/恢复会中断所有会话;请先等待当前任务结束或手动中断它,再重试。",
			"busy": "处理中…",
			"keys.undo": "撤销快捷键",
			"keys.redo": "恢复快捷键",
			"keys.none": "(未设置)",
			"keys.press": "请按组合键…",
			"keys.hint": "点击输入框后按下组合键;Backspace 清除;默认 Ctrl+Alt+Z / Ctrl+Alt+Y",
			"panel.title": "快照管理",
			"panel.profile": "profile: {profile}",
			"panel.refresh": "刷新",
			"panel.save": "手动保存",
			"panel.restore": "回退所选",
			"panel.delete": "删除所选",
			"panel.close": "关闭",
			"panel.col.time": "时间",
			"panel.col.kind": "类型",
			"panel.col.reason": "原因",
			"panel.col.files": "文件",
			"panel.col.loc": "库",
			"panel.col.ops": "操作",
			"panel.op.restore": "回退到此版本",
			"panel.op.delete": "删除",
			"panel.op.diff": "差异",
			"panel.diff.title": "差异预览",
			"panel.diff.none": "(无差异)",
			"panel.cleanup": "清理过期",
			"panel.export": "导出",
			"panel.import": "导入",
			"ok.export": "已导出 {n} 个快照 → {path}",
			"export.sensitive.warn": "⚠️ 该导出包含真实密钥(.env / .credentials.yaml 处于 keep 模式或旧快照),请勿外传!",
			"ok.import": "已导入 {n} 个快照(跳过 {s} 个重复)",
			"boot.alert": "⚠️ 检测到上次 DSH 异常退出,建议回退到上次正常状态",
			"boot.rollback": "回退到最后正常状态",
			"restart.required": "已回退。重启 DSH 后恢复内容才会生效。",
			"safe.mode": "安全模式",
			"safe.on.confirm": "开启安全模式:除撤销系统外的所有用户插件将被临时禁用(先自动快照并备份配置),重启 DSH 后生效。继续?",
			"safe.off.confirm": "退出安全模式:恢复进入前的完整插件配置,重启 DSH 后生效。继续?",
			"ok.prune": "已清理 {a} 个自动档、{p} 个后悔档",
			"settings.autoCleanup": "自动清理(超量自动删除)",
			"settings.keepPre": "后悔档保留数量",
			"settings.cleanupNote": "自动档保留 {keepAuto} 份;后悔档保留 {keepPre} 份;手动存档永不清除;关闭自动清理则全部保留",
			"panel.empty": "暂无快照。配置变化会自动存档;也可点「手动保存」立即存档。",
			"panel.confirm.restore": "确认回退到该快照?当前状态会先保存为后悔档,可再恢复。",
			"panel.confirm.delete": "确认删除该快照?此操作不可恢复。",
			"panel.updated": "已刷新 {n} 条",
			"type.manual": "手动",
			"type.auto": "自动",
			"type.baseline": "基线",
			"type.pre-restore": "后悔档",
			"loc.manual": "手动库",
			"loc.auto": "自动库",
			"loc.legacy": "旧库",
			"settings.title": "快照设置",
			"settings.nav": "快照",
			"settings.auto": "自动保存(配置变化自动存档)",
			"settings.debounce": "自动保存防抖(毫秒)",
			"settings.keep": "自动档保留数量",
			"settings.manualDir": "手动快照目录",
			"settings.autoDir": "自动快照目录",
			"settings.sensitive": "敏感模式",
			"settings.sensitive.redact": "脱敏(默认,值替换为***REDACTED***,本机回滚完整)",
			"settings.sensitive.keep": "明文(兼容旧行为,快照含真实值)",
			"settings.pluginDirs": "插件目录白名单(逗号分隔,留空=自动发现)",
			"settings.save": "保存设置",
			"settings.browse": "浏览并选择目录…",
			"settings.saved": "设置已保存并即时生效",
			"settings.error": "保存失败:{msg}"
		};
		const en = {
			"undo": "Undo",
			"redo": "Redo",
			"snapshots": "Snapshots",
			"undo.aria": "Undo the last config change",
			"redo.aria": "Redo the last undone change",
			"snapshots.aria": "Save a snapshot of the current config now",
			"badge.count": "{n} snapshot(s)",
			"badge.just": "just now",
			"badge.min": "{n} min ago",
			"badge.hour": "{n} h ago",
			"badge.day": "{n} d ago",
			"badge.title": "Auto-snapshot status; click to open",
			"ok.undo": "Undone → {id}",
			"ok.redo": "Redone",
			"ok.snapshot": "Snapshot {id}",
			"err": "Failed: {msg}",
			"err.busy": "A session is running (agent in progress). Undo/redo would interrupt every session; wait for the task to finish or interrupt it first, then retry.",
			"busy": "Working…",
			"keys.undo": "Undo shortcut",
			"keys.redo": "Redo shortcut",
			"keys.none": "(unset)",
			"keys.press": "Press keys…",
			"keys.hint": "Click the box then press a combo; Backspace clears; defaults Ctrl+Alt+Z / Ctrl+Alt+Y",
			"panel.title": "Snapshot Manager",
			"panel.profile": "profile: {profile}",
			"panel.refresh": "Refresh",
			"panel.save": "Save",
			"panel.restore": "Restore",
			"panel.delete": "Delete",
			"panel.close": "Close",
			"panel.col.time": "Time",
			"panel.col.kind": "Type",
			"panel.col.reason": "Reason",
			"panel.col.files": "Files",
			"panel.col.loc": "Store",
			"panel.col.ops": "Actions",
			"panel.op.restore": "Restore to this",
			"panel.op.delete": "Delete",
			"panel.op.diff": "Diff",
			"panel.diff.title": "Diff preview",
			"panel.diff.none": "(no differences)",
			"panel.cleanup": "Clean up",
			"panel.export": "Export",
			"panel.import": "Import",
			"ok.export": "Exported {n} snapshot(s) → {path}",
			"export.sensitive.warn": "⚠️ This archive contains REAL secrets (.env / .credentials.yaml in keep mode or legacy snapshots) — do NOT share it!",
			"ok.import": "Imported {n} snapshot(s) ({s} duplicate(s) skipped)",
			"boot.alert": "⚠️ Previous DSH run exited abnormally — roll back to the last good state",
			"boot.rollback": "Roll back to last good state",
			"restart.required": "Rolled back. A DSH restart is required for the restored state to take effect.",
			"safe.mode": "Safe mode",
			"safe.on.confirm": "Enable SAFE MODE? All user plugins except the undo system will be temporarily disabled (a snapshot and a config backup are taken first). Takes effect after a DSH restart.",
			"safe.off.confirm": "Exit SAFE MODE? The full plugin set from before safe mode will be restored. Takes effect after a DSH restart.",
			"ok.prune": "Pruned {a} auto and {p} pre-restore snapshot(s)",
			"settings.autoCleanup": "Auto-cleanup (delete excess automatically)",
			"settings.keepPre": "Pre-restore snapshots kept",
			"settings.cleanupNote": "Auto keeps {keepAuto}, pre-restore keeps {keepPre}; manual snapshots are never deleted; disabling auto-cleanup keeps everything",
			"panel.empty": "No snapshots yet. Config changes auto-archive; or click Save now.",
			"panel.confirm.restore": "Restore to this snapshot? Current state is kept as a redo point.",
			"panel.confirm.delete": "Delete this snapshot? This cannot be undone.",
			"panel.updated": "Refreshed {n} items",
			"type.manual": "Manual",
			"type.auto": "Auto",
			"type.baseline": "Baseline",
			"type.pre-restore": "Pre-restore",
			"loc.manual": "Manual",
			"loc.auto": "Auto",
			"loc.legacy": "Legacy",
			"settings.title": "Snapshot Settings",
			"settings.nav": "Snapshots",
			"settings.auto": "Auto-save (snapshot on config change)",
			"settings.debounce": "Auto-save debounce (ms)",
			"settings.keep": "Auto snapshots kept",
			"settings.manualDir": "Manual snapshot dir",
			"settings.autoDir": "Auto snapshot dir",
			"settings.sensitive": "Sensitive mode",
			"settings.sensitive.redact": "Redact (default: values become ***REDACTED***, local rollback restores fully)",
			"settings.sensitive.keep": "Plaintext (legacy: snapshots hold real values)",
			"settings.pluginDirs": "Plugin dirs whitelist (comma-separated, empty = auto-detect)",
			"settings.save": "Save settings",
			"settings.browse": "Browse for directory…",
			"settings.saved": "Settings saved and applied",
			"settings.error": "Save failed: {msg}"
		};
		//#endregion
		//#region keyboard config (localStorage; shared with the settings row)
		const KEY_STORAGE = "dsh-undo-savepoint-keys";
		const DEFAULT_KEYS = {
			undo: { ctrl: true, alt: true, shift: false, key: "z" },
			redo: { ctrl: true, alt: true, shift: false, key: "y" }
		};
		function loadKeys() {
			try {
				const raw = localStorage.getItem(KEY_STORAGE);
				if (raw) {
					const j = JSON.parse(raw);
					return {
						undo: j && j.undo ? j.undo : DEFAULT_KEYS.undo,
						redo: j && j.redo ? j.redo : DEFAULT_KEYS.redo
					};
				}
			} catch (e) { /* fall through */ }
			return { undo: DEFAULT_KEYS.undo, redo: DEFAULT_KEYS.redo };
		}
		function saveKeys(keys) {
			try { localStorage.setItem(KEY_STORAGE, JSON.stringify(keys)); } catch (e) { /* ignore */ }
		}
		function formatKey(k) {
			if (!k || !k.key) return "";
			return [k.ctrl ? "Ctrl" : null, k.alt ? "Alt" : null, k.shift ? "Shift" : null, String(k.key).toUpperCase()].filter(Boolean).join("+");
		}
		function keyEventMatches(e, k) {
			if (!k || !k.key) return false;
			return !!e.ctrlKey === !!k.ctrl && !!e.altKey === !!k.alt && !!e.shiftKey === !!k.shift
				&& e.key.toLowerCase() === String(k.key).toLowerCase();
		}
		function api(path, method, body) {
			return fetch(path, {
				method: method || "GET",
				headers: body ? { "content-type": "application/json" } : undefined,
				body: body ? JSON.stringify(body) : undefined
			}).then((r) => r.json()).catch((e) => ({ ok: false, error: { message: String(e && e.message || e) } }));
		}
		const RESULT_EVENT = "dsh-undo-savepoint-result";
		/** After a successful undo/redo/restore the config files changed; the page
		 * reloads so the UI re-reads them (settings UI does not hot-follow files). */
		function maybeReload(r, label) {
			if (r && r.ok && !r.unchanged && (label === "undo" || label === "redo" || label === "restore")) {
				setTimeout(() => { try { location.reload(); } catch (e) { /* noop */ } }, 350);
			}
		}
		function publishResult(r, label) {
			let text = "";
			if (r && r.ok) {
				if (r.message) {
					text = r.message;
				} else {
					const id = r.targetId || (r.snapshot && r.snapshot.id) || "";
					text = label === "undo" ? (id ? "已撤销 → " + id : "已撤销") : label === "snapshot" ? ("已存档 " + id) : "已恢复";
				}
			} else {
				text = "失败:" + ((r && (r.error && (r.error.message || r.error) || r)) || "unknown");
			}
			try { window.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: { ok: !!(r && r.ok), text } })); } catch (e) { /* noop */ }
		}
		const KIND_KEYS = { manual: "type.manual", auto: "type.auto", baseline: "type.baseline", "pre-restore": "type.pre-restore" };
		const LOC_KEYS = { manual: "loc.manual", auto: "loc.auto", legacy: "loc.legacy" };
		//#endregion
		//#region UndoHeader (session header actions)
		/** 语义图标(单色 currentColor,随主题/按钮色自适应):撤销 ↶ / 恢复 ↷ / 相机。 */
		function UndoIcon({ size = 13 }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg",
				children: [
					(0, react_jsx_runtime.jsx)("path", { d: "M6.2 3.6 3.4 6.4l2.8 2.8", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M3.4 6.4h6.1a3.2 3.2 0 0 1 0 6.4", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" })
				]
			});
		}
		function RedoIcon({ size = 13 }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg",
				children: [
					(0, react_jsx_runtime.jsx)("path", { d: "M9.8 3.6l2.8 2.8-2.8 2.8", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M12.6 6.4H6.5a3.2 3.2 0 0 0 0 6.4", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" })
				]
			});
		}
		function CameraIcon({ size = 14 }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg",
				children: [
					(0, react_jsx_runtime.jsx)("path", { d: "M6 2.8h4v1.1h1.2c.94 0 1.7.76 1.7 1.7v5.5c0 .94-.76 1.7-1.7 1.7H4.8a1.7 1.7 0 0 1-1.7-1.7V5.6c0-.94.76-1.7 1.7-1.7h1.2z", fill: "currentColor" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M8 6.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zm0 .9a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z", fill: "currentColor", fillRule: "evenodd" })
				]
			});
		}
		/** 相对时间文案(徽章用):刚刚 / N 分钟前 / N 小时前 / N 天前。 */
		function relativeTime(ts, t) {
			if (!ts) return null;
			const diff = Date.now() - new Date(ts).getTime();
			if (diff < 60 * 1000) return t("badge.just");
			const min = Math.floor(diff / 60000);
			if (min < 60) return t("badge.min", { n: min });
			const hr = Math.floor(min / 60);
			if (hr < 24) return t("badge.hour", { n: hr });
			return t("badge.day", { n: Math.floor(hr / 24) });
		}
		/** Undo/redo/snapshot buttons in the conversation header. */
		function UndoHeader({ t, onOpenPanel }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [msg, setMsg] = (0, react.useState)(null);
			const [msgOk, setMsgOk] = (0, react.useState)(true);
			const timer = (0, react.useRef)(null);
			const keys = loadKeys();
			// 状态徽章:总数(/api/undo/status)+ 最新快照时间(/api/undo/list 首条),30s 轮询
			const [stat, setStat] = (0, react.useState)(null);
			const refreshStat = (0, react.useCallback)(async () => {
				const r = await api("/api/undo/status");
				if (!(r && r.ok)) return;
				const l = await api("/api/undo/list");
				const latest = l && l.ok && l.snapshots && l.snapshots.length ? l.snapshots[0].time : null;
				setStat({ total: r.total, latest });
			}, []);
			const flash = (ok, text) => {
				setMsg(text);
				setMsgOk(ok);
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => setMsg(null), 6000);
			};
			const run = async (label, path) => {
				if (busy) return;
				setBusy(true);
				try {
					const r = await api(path, "POST");
					publishResult(r, label);
					maybeReload(r, label);
					let text;
					if (r && r.ok) {
						text = r.message || (label === "undo" ? t("ok.undo", { id: r.targetId || "" }) : label === "redo" ? t("ok.redo") : t("ok.snapshot", { id: (r && r.snapshot && r.snapshot.id) || "" }));
					} else if (r && r.error && r.error.code === 'busy') {
						text = t("err.busy");
					} else {
						text = t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" });
					}
					flash(!!(r && r.ok), text);
					// 手动快照落地后立刻刷新徽章(不用等 30s 轮询)
					if (label === "snapshot" && r && r.ok) refreshStat();
				} finally {
					setBusy(false);
				}
			};
			(0, react.useEffect)(() => {
				const onResult = (ev) => {
					const d = ev && ev.detail;
					if (!d) return;
					flash(d.ok, d.text);
				};
				window.addEventListener(RESULT_EVENT, onResult);
				return () => {
					window.removeEventListener(RESULT_EVENT, onResult);
					if (timer.current) clearTimeout(timer.current);
				};
			}, []);
			(0, react.useEffect)(() => {
				refreshStat();
				const id = setInterval(refreshStat, 30000);
				return () => clearInterval(id);
			}, [refreshStat]);
			return (0, react_jsx_runtime.jsx)("div", {
				className: styles.actions,
				"data-undo-header": true,
				children: [
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.btn + " " + styles.undo,
						disabled: busy,
						title: t("undo.aria") + (keys.undo ? " (" + formatKey(keys.undo) + ")" : ""),
						"aria-label": t("undo.aria"),
						onClick: () => { run("undo", "/api/undo/undo"); },
						children: [(0, react_jsx_runtime.jsx)(UndoIcon, { size: 13 }), t("undo")]
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.btn + " " + styles.redo,
						disabled: busy,
						title: t("redo.aria") + (keys.redo ? " (" + formatKey(keys.redo) + ")" : ""),
						"aria-label": t("redo.aria"),
						onClick: () => { run("redo", "/api/undo/redo"); },
						children: [(0, react_jsx_runtime.jsx)(RedoIcon, { size: 13 }), t("redo")]
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.btn + " " + styles.list,
						disabled: busy,
						title: t("snapshots.aria"),
						"aria-label": t("snapshots.aria"),
						onClick: () => { run("snapshot", "/api/undo/snapshot"); },
						children: [(0, react_jsx_runtime.jsx)(CameraIcon, { size: 14 }), t("snapshots")]
					}),
					stat !== null && (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.badge,
						title: t("badge.title"),
						"aria-label": t("badge.title"),
						onClick: () => { onOpenPanel(); },
						children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.dot }),
							t("badge.count", { n: stat.total }),
							stat.latest ? " · " + (relativeTime(stat.latest, t) || "") : ""
						]
					}),
					msg !== null && (0, react_jsx_runtime.jsx)("span", {
						className: styles.msg + " " + (msgOk ? styles.ok : styles.err),
						children: msg
					})
				]
			});
		}
		//#endregion
		//#region SnapshotPanel
		/** Modal snapshot manager: list, restore-to-version, delete, manual save. */
		function SnapshotPanel({ onClose, t }) {
			const [snaps, setSnaps] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [msg, setMsg] = (0, react.useState)(null);
			const [msgOk, setMsgOk] = (0, react.useState)(true);
			const [diff, setDiff] = (0, react.useState)(null); // {id, items} for the diff preview box
			const [bootAlert, setBootAlert] = (0, react.useState)(null); // { lastGoodSnapshotId } | null
			const load = (0, react.useCallback)(async () => {
				const r = await api("/api/undo/list");
				setSnaps(r && r.ok ? (r.snapshots || []) : []);
				const st = await api("/api/undo/status");
				setBootAlert(st && st.ok && st.bootAlert ? { lastGoodSnapshotId: st.lastGoodSnapshotId || null } : null);
			}, []);
			(0, react.useEffect)(() => { load(); }, [load]);
			const act = async (label, path, body) => {
				if (busy) return;
				setBusy(true);
				try {
					const r = await api(path, "POST", body);
					publishResult(r, label);
					maybeReload(r, label);
					if (r && r.ok && r.needsRestart) window.alert(t("restart.required"));
					setMsgOk(!!(r && r.ok));
					if (r && r.ok) {
						setMsg(r.message || t("ok.undo", { id: r.targetId || "" }));
					} else if (r && r.error && r.error.code === 'busy') {
						setMsg(t("err.busy"));
					} else {
						setMsg(t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
					}
					await load();
				} finally {
					setBusy(false);
				}
			};
			const fetchDiff = async (id) => {
				const r = await api("/api/undo/diff?id=" + encodeURIComponent(id));
				return r && r.ok ? (r.diff || []) : [];
			};
			const restoreOne = async (s) => {
				// preview the differences first, then confirm with a summary
				const items = await fetchDiff(s.id);
				const summary = items.length === 0
					? t("panel.diff.none")
					: items.map((f) => "  " + f.name + "  +" + f.added + " -" + f.removed).join("\n");
				if (!window.confirm(t("panel.confirm.restore") + "\n\n" + summary)) return;
				act("restore", "/api/undo/restore", { id: s.id });
			};
			const showDiff = async (s) => {
				const items = await fetchDiff(s.id);
				setDiff({ id: s.id, items });
			};
			const toggleSafeMode = async () => {
				if (busy) return;
				const st = await api("/api/undo/safe-mode", "POST", { action: "status" });
				const on = !!(st && st.ok && st.active);
				if (!window.confirm(on ? t("safe.off.confirm") : t("safe.on.confirm"))) return;
				act("safe-mode", "/api/undo/safe-mode", { action: on ? "off" : "on" });
			};
			const deleteOne = (s) => {
				if (!window.confirm(t("panel.confirm.delete"))) return;
				act("delete", "/api/undo/remove", { id: s.id });
			};
			const saveNow = async () => {
				await act("save", "/api/undo/snapshot", { reason: "manual:ui" });
				await load();
			};
			const cleanupNow = async () => {
				const r = await api("/api/undo/prune", "POST");
				setMsgOk(!!(r && r.ok));
				setMsg(r && r.ok ? t("ok.prune", { a: r.removedAuto || 0, p: r.removedPre || 0 }) : t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
				await load();
			};
			const exportNow = async () => {
				const r = await api("/api/undo/export", "POST");
				setMsgOk(!!(r && r.ok));
				if (r && r.ok && r.sensitiveWarning) window.alert(t("export.sensitive.warn"));
				setMsg(r && r.ok ? t("ok.export", { n: r.count || 0, path: r.path || "" }) : t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
			};
			const importNow = async () => {
				const picked = await api("/api/undo/pick-file", "POST", {});
				if (!(picked && picked.ok && picked.path)) return;
				const r = await api("/api/undo/import", "POST", { path: picked.path });
				setMsgOk(!!(r && r.ok));
				setMsg(r && r.ok ? t("ok.import", { n: r.imported || 0, s: r.skipped || 0 }) : t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
				await load();
			};
			// 面板副标题:v0.3.3 起 manifest 记录 profile,首条(最新)快照的归属即当前 profile
			const profile = snaps && snaps.length ? (snaps[0].profile || null) : null;
			return (0, react_jsx_runtime.jsx)("div", {
				className: styles.overlay,
				"data-undo-panel": true,
				onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
				children: (0, react_jsx_runtime.jsx)("div", {
					className: styles.panel,
					children: [
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.head,
							children: [
								(0, react_jsx_runtime.jsx)(CameraIcon, { size: 16 }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.title, children: t("panel.title") }),
								profile !== null && (0, react_jsx_runtime.jsx)("span", { className: styles.subtitle, title: t("panel.profile", { profile }), children: t("panel.profile", { profile }) }),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button", className: styles.close, "aria-label": t("panel.close"),
									onClick: onClose, children: "×"
								})
							]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.toolbar,
							children: [
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.save, disabled: busy, onClick: saveNow, children: t("panel.save") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + " " + styles.undo, disabled: busy, onClick: () => act("undo", "/api/undo/undo"), children: t("undo") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + " " + styles.redo, disabled: busy, onClick: () => act("redo", "/api/undo/redo"), children: t("redo") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: load, children: t("panel.refresh") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: cleanupNow, children: t("panel.cleanup") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: exportNow, children: t("panel.export") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: importNow, children: t("panel.import") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: toggleSafeMode, children: t("safe.mode") })
							]
						}),
						diff !== null && (0, react_jsx_runtime.jsx)("div", {
							className: styles.diffbox,
							"data-undo-diff": true,
							children: [
								(0, react_jsx_runtime.jsx)("div", {
									className: styles.diffhead,
									children: [
										(0, react_jsx_runtime.jsx)("span", { className: styles.title, children: t("panel.diff.title") + " " + diff.id }),
										(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.close, onClick: () => setDiff(null), children: "×" })
									]
								}),
								(0, react_jsx_runtime.jsx)("div", {
									className: styles.diffbody,
									children: diff.items.length === 0
										? (0, react_jsx_runtime.jsx)("div", { className: styles.empty, children: t("panel.diff.none") })
										: diff.items.map((f) => (0, react_jsx_runtime.jsxs)("div", {
											children: [
												(0, react_jsx_runtime.jsx)("div", { className: styles.difffile, children: f.name + "  +" + f.added + "  -" + f.removed }),
												f.removedLines.map((l, i) => (0, react_jsx_runtime.jsx)("div", { className: styles.diffdel, children: "- " + l }, f.name + "-" + i)),
												f.addedLines.map((l, i) => (0, react_jsx_runtime.jsx)("div", { className: styles.diffadd, children: "+ " + l }, f.name + "+" + i))
											]
										}, f.name))
								})
							]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.tbody,
							children: snaps === null ? (0, react_jsx_runtime.jsx)("div", { className: styles.empty, children: t("busy") })
								: snaps.length === 0 ? (0, react_jsx_runtime.jsx)("div", { className: styles.empty, children: t("panel.empty") })
									: (0, react_jsx_runtime.jsx)("table", {
										className: styles.table,
										children: [
											(0, react_jsx_runtime.jsx)("thead", {
												children: (0, react_jsx_runtime.jsx)("tr", {
													children: [
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.time") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.kind") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.reason") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.files") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.loc") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.ops") })
													]
												})
											}),
											(0, react_jsx_runtime.jsx)("tbody", {
												children: snaps.map((s) => (0, react_jsx_runtime.jsxs)("tr", {
													children: [
														(0, react_jsx_runtime.jsx)("td", { className: styles.time, children: new Date(s.time).toLocaleString() }),
														(0, react_jsx_runtime.jsx)("td", { className: styles.kind, children: t(KIND_KEYS[s.kind] || s.kind) }),
														(0, react_jsx_runtime.jsx)("td", { className: styles.reason, title: s.reason || "", children: s.reason || "—" }),
														(0, react_jsx_runtime.jsx)("td", { children: String(s.files ? s.files.length : 0) }),
														(0, react_jsx_runtime.jsx)("td", { className: styles.loc, children: t(LOC_KEYS[s.location] || s.location) }),
														(0, react_jsx_runtime.jsxs)("td", {
															children: [
																(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn, disabled: busy, onClick: () => showDiff(s), children: t("panel.op.diff") }),
																(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn + " " + styles.okc, disabled: busy, onClick: () => restoreOne(s), children: t("panel.op.restore") }),
																(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn + " " + styles.errc, disabled: busy, onClick: () => deleteOne(s), children: t("panel.op.delete") })
															]
														})
													]
												}, s.id))
											})
										]
									})
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.foot,
							children: [
								bootAlert && (0, react_jsx_runtime.jsx)("span", { className: styles.msg + " " + styles.err, children: [
									t("boot.alert"),
									bootAlert.lastGoodSnapshotId && (0, react_jsx_runtime.jsx)("button", {
										type: "button", className: styles.rowbtn + " " + styles.okc, style: { marginLeft: 6 },
										onClick: () => act("restore", "/api/undo/restore", { id: bootAlert.lastGoodSnapshotId }),
										children: t("boot.rollback")
									})
								] }),
								msg !== null && (0, react_jsx_runtime.jsx)("span", {
									className: styles.msg + " " + (msgOk ? styles.ok : styles.err),
									children: msg
								}),
								snaps !== null && (0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("panel.updated", { n: snaps.length }) })
							]
						})
					]
				})
			});
		}
		//#endregion
		//#region KeyBindRow (settings.general.item)
		/** Custom shortcut settings row: capture combos for undo/redo. */
		function KeyBindRow({ t }) {
			const [keys, setKeysState] = (0, react.useState)(loadKeys);
			const [capturing, setCapturing] = (0, react.useState)(null);
			const capture = (which) => (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (e.key === "Backspace" || e.key === "Delete") {
					const next = { ...keys, [which]: null };
					setKeysState(next);
					saveKeys(next);
					setCapturing(null);
					return;
				}
				if (["Control", "Alt", "Shift", "Meta", "Escape", "Tab", "CapsLock"].indexOf(e.key) >= 0) return;
				const next = { ...keys, [which]: { ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, key: e.key } };
				setKeysState(next);
				saveKeys(next);
				setCapturing(null);
			};
			const bind = (which) => {
				const cur = keys[which];
				return (0, react_jsx_runtime.jsx)("input", {
					type: "text",
					readOnly: true,
					className: styles.keyInput,
					"data-undo-key-input": "1",
					placeholder: cur ? formatKey(cur) : t("keys.none"),
					value: capturing === which ? t("keys.press") : (cur ? formatKey(cur) : ""),
					onFocus: () => { setCapturing(which); },
					onBlur: () => { setCapturing(null); },
					onKeyDown: capture(which),
					"aria-label": t(which === "undo" ? "keys.undo" : "keys.redo")
				});
			};
			return (0, react_jsx_runtime.jsx)("div", {
				className: styles.row,
				"data-undo-keys": true,
				children: [
					(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("keys.undo") }),
					bind("undo"),
					(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("keys.redo") }),
					bind("redo"),
					(0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("keys.hint") })
				]
			});
		}
		//#endregion
		//#region UndoMainPage + UndoSettingsSection (own sidebar section)
		/** Full snapshot settings page shown in its own sidebar section. */
		function UndoMainPage({ t }) {
			const [s, setS] = (0, react.useState)(null);
			const [msg, setMsg] = (0, react.useState)(null);
			const [msgOk, setMsgOk] = (0, react.useState)(true);
			const load = (0, react.useCallback)(async () => {
				const r = await api("/api/undo/settings");
				if (r && r.ok) setS(r.settings);
			}, []);
			(0, react.useEffect)(() => { load(); }, [load]);
			const set = (k, v) => setS((prev) => (prev ? { ...prev, [k]: v } : prev));
			const pickDir = async (k) => {
				const r = await api("/api/undo/pick-dir", "POST", {});
				if (r && r.ok && r.path) set(k, r.path);
			};
			const save = async () => {
				const r = await api("/api/undo/settings", "POST", s);
				setMsgOk(!!(r && r.ok));
				setMsg(r && r.ok ? t("settings.saved") : t("settings.error", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
			};
			return s === null ? (0, react_jsx_runtime.jsx)("div", { className: styles.row, children: t("busy") })
				: (0, react_jsx_runtime.jsx)("div", {
					"data-undo-settings-page": true,
					style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 680, padding: "4px 2px" },
					children: [
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("label", { className: styles.keyLabel, children: [
								(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: !!s.autoEnabled, onChange: (e) => set("autoEnabled", e.target.checked) }),
								" " + t("settings.auto")
							] })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.debounce") }),
							(0, react_jsx_runtime.jsx)("input", { type: "number", className: styles.keyInput + " " + styles.num, value: s.watchDebounceMs, onChange: (e) => set("watchDebounceMs", Number(e.target.value)) })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.keep") }),
							(0, react_jsx_runtime.jsx)("input", { type: "number", className: styles.keyInput + " " + styles.num, value: s.keepAuto, onChange: (e) => set("keepAuto", Number(e.target.value)) })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.keepPre") }),
							(0, react_jsx_runtime.jsx)("input", { type: "number", className: styles.keyInput + " " + styles.num, value: s.keepPre, onChange: (e) => set("keepPre", Number(e.target.value)) })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("label", { className: styles.keyLabel, children: [
								(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: !!s.autoCleanup, onChange: (e) => set("autoCleanup", e.target.checked) }),
								" " + t("settings.autoCleanup")
							] })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("settings.cleanupNote", { keepAuto: s.keepAuto, keepPre: s.keepPre }) })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.sensitive") }),
							(0, react_jsx_runtime.jsx)("select", {
								className: styles.keyInput,
								value: s.sensitiveMode || "redact",
								onChange: (e) => set("sensitiveMode", e.target.value),
								children: [
									(0, react_jsx_runtime.jsx)("option", { value: "redact", children: t("settings.sensitive.redact") }),
									(0, react_jsx_runtime.jsx)("option", { value: "keep", children: t("settings.sensitive.keep") })
								]
							})
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.pluginDirs") }),
							(0, react_jsx_runtime.jsx)("input", {
								type: "text",
								className: styles.keyInput + " " + styles.dir,
								value: Array.isArray(s.pluginDirs) ? s.pluginDirs.join(", ") : "",
								onChange: (e) => set("pluginDirs", e.target.value)
							})
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.manualDir") }),
							(0, react_jsx_runtime.jsx)("input", { type: "text", className: styles.keyInput + " " + styles.dir, value: s.manualDir, onChange: (e) => set("manualDir", e.target.value) }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.browseBtn, title: t("settings.browse"), "aria-label": t("settings.browse"), onClick: () => pickDir("manualDir"), children: "📁" })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.autoDir") }),
							(0, react_jsx_runtime.jsx)("input", { type: "text", className: styles.keyInput + " " + styles.dir, value: s.autoDir, onChange: (e) => set("autoDir", e.target.value) }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.browseBtn, title: t("settings.browse"), "aria-label": t("settings.browse"), onClick: () => pickDir("autoDir"), children: "📁" })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.save, onClick: save, children: t("settings.save") }),
							msg !== null && (0, react_jsx_runtime.jsx)("span", { className: styles.msg + " " + (msgOk ? styles.ok : styles.err), children: msg })
						] })
					]
				});
		}
		/** Sidebar section shell: renders the settings page registered under it. */
		function UndoSettingsSection({ t, renderSlot }) {
			return (0, react_jsx_runtime.jsx)("div", {
				"data-undo-settings-section": true,
				style: { display: "flex", flexDirection: "column", gap: 8 },
				children: renderSlot("settings.undo.item", {})
			});
		}
		//#endregion
		//#region client entry
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-undo-savepoint: dictionaries");
			const t = ctx.locale.bind(NS);
			let panelOpen = false;
			const panelHandlers = new Set();
			const setPanelOpen = (v) => { panelOpen = v; for (const h of panelHandlers) h(v); };
			// Undo/redo/snapshot buttons in the conversation header
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "undo-buttons",
				order: 10,
				locale: NS,
				inject: () => ({
					onOpenPanel: () => setPanelOpen(true)
				})
			}, (props) => {
				// Subscribe to the panel-open flag so the header button can open the shared panel.
				const [open, setOpen] = (0, react.useState)(panelOpen);
				(0, react.useEffect)(() => {
					panelHandlers.add(setOpen);
					return () => { panelHandlers.delete(setOpen); };
				}, []);
				return (0, react_jsx_runtime.jsxs)(react.Fragment, {
					children: [
						(0, react_jsx_runtime.jsx)(UndoHeader, { t: props.t, onOpenPanel: props.onOpenPanel }),
						open && (0, react_jsx_runtime.jsx)(SnapshotPanel, { t: props.t, onClose: () => setPanelOpen(false) })
					]
				});
			}));
			// Custom shortcut settings row (General settings)
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "undo-keys",
				order: 30,
				locale: NS
			}, KeyBindRow));
			// Snapshot settings: own sidebar section (no longer squeezed into General)
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-undo",
				order: 30,
				label: () => t("settings.nav"),
				locale: NS,
				children: { "settings.undo.item": { kind: "list", scope: "root" } }
			}, UndoSettingsSection));
			ctx.slots.inject("settings.undo.item", () => ctx.slots.register({
				name: "settings.undo.item",
				id: "main",
				order: 0,
				locale: NS
			}, UndoMainPage));
			// Global keyboard shortcuts
			ctx.effect(() => {
				const onKeyDown = (e) => {
					if (e.defaultPrevented || e.repeat) return;
					const target = e.target;
					if (target && target.dataset && target.dataset.undoKeyInput === "1") return; // the settings inputs themselves
					const keys = loadKeys();
					if (keys.undo && keyEventMatches(e, keys.undo)) {
						e.preventDefault();
						api("/api/undo/undo", "POST").then((r) => { publishResult(r, "undo"); maybeReload(r, "undo"); });
						return;
					}
					if (keys.redo && keyEventMatches(e, keys.redo)) {
						e.preventDefault();
						api("/api/undo/redo", "POST").then((r) => { publishResult(r, "redo"); maybeReload(r, "redo"); });
					}
				};
				window.addEventListener("keydown", onKeyDown, true);
				return () => window.removeEventListener("keydown", onKeyDown, true);
			}, "dsh-undo-savepoint: keyboard");
		}
		//#endregion
		exports.UndoHeader = UndoHeader;
		exports.SnapshotPanel = SnapshotPanel;
		exports.KeyBindRow = KeyBindRow;
		exports.UndoMainPage = UndoMainPage;
		exports.UndoSettingsSection = UndoSettingsSection;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
