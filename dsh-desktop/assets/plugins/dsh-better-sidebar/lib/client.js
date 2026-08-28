window.__ModuleLoader__.load({
	id: "dsh-better-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom_client = require("react-dom/client");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		/** Fallback prefs used whenever the settings document is unreachable or malformed. */
		const SIDEBAR_PREFS_DEFAULTS = {
			openByDefault: true,
			defaultWidthPercent: 30,
			autoOpenSubagent: true,
			autoOpenJobs: true,
			agentTerminalTools: false,
			bottomPanelAutoTerminal: true,
			terminalFontFamily: "",
			terminalFontSize: 13,
			interceptOpenPath: true,
			titleBarCompat: false,
			titleBarStripPx: 40,
			htmlViewerNoSandbox: false,
			htmlViewerDefaultUnsafe: false,
			browserNoSandbox: false,
			browserInterceptLinks: true,
			browserInterceptHttp: true,
			browserInterceptHttps: false,
			tabsEnabled: {},
			viewersEnabled: {},
			pluginSettings: {}
		};
		/** Clamp one width percent into the contract range (shared by schema and client reads). */
		function clampWidthPercent(value) {
			return Math.min(60, Math.max(20, Math.round(value)));
		}
		/** Clamp one terminal font size into the contract range (shared by schema and client reads). */
		function clampTerminalFontSize(value) {
			return Math.min(32, Math.max(9, Math.round(value)));
		}
		/** Clamp one title-bar strip height into the contract range (shared by schema and client reads). */
		function clampTitleBarStrip(value) {
			return Math.min(120, Math.max(0, Math.round(value)));
		}
		/** Whether a viewport width is narrow (mobile). */
		function isNarrowWidth(width) {
			return width < 768;
		}
		/**
		* Live narrow-viewport flag for components. Reads `window.innerWidth` and
		* re-measures on resize (rAF-throttled, the repo's existing drag pattern).
		* Deliberately avoids `matchMedia` (jsdom does not implement it) — the
		* resize listener is equally exact for a breakpoint that never changes
		* while the page is open.
		*/
		function useNarrowViewport() {
			const [narrow, setNarrow] = (0, react.useState)(() => typeof window !== "undefined" && isNarrowWidth(window.innerWidth));
			(0, react.useEffect)(() => {
				if (typeof window === "undefined") return;
				let frame = null;
				const measure = () => {
					frame = null;
					setNarrow(isNarrowWidth(window.innerWidth));
				};
				const onResize = () => {
					if (frame === null) frame = requestAnimationFrame(measure);
				};
				window.addEventListener("resize", onResize);
				return () => {
					window.removeEventListener("resize", onResize);
					if (frame !== null) cancelAnimationFrame(frame);
				};
			}, []);
			return narrow;
		}
		let nextIdCounter = 0;
		/** Unique pane/tab id within one state instance. */
		function uid(prefix) {
			nextIdCounter += 1;
			return `${prefix}:${nextIdCounter}`;
		}
		/**
		* The largest numeric suffix across a raw persisted state's counter ids
		* (`pane:N` / `tab:N` / `split:N`). The uid counter is module-global and
		* resets on every reload, so a split minted AFTER a reload would collide
		* with the persisted ids (a fresh "pane:1" beside the persisted "pane:1");
		* mapLeaf would then visit BOTH leaves and every open would land in both
		* panes of the split. Seeding the counter past the persisted ids keeps
		* fresh ids disjoint.
		*/
		function maxCounterId(parsed) {
			let max = 0;
			const consider = (id) => {
				if (typeof id !== "string") return;
				const match = /^(?:pane|tab|split):(\d+)$/.exec(id);
				if (match !== null) max = Math.max(max, Number(match[1]));
			};
			const walk = (node) => {
				if (node === null || typeof node !== "object") return;
				const record = node;
				consider(record.id);
				if (Array.isArray(record.tabs)) {
					for (const tab of record.tabs) if (tab !== null && typeof tab === "object") consider(tab.id);
				}
				if (Array.isArray(record.children)) for (const child of record.children) walk(child);
			};
			walk(parsed?.splits);
			walk(parsed?.bottomSplits);
			return max;
		}
		/** A fresh default state: one explorer tab in one pane, open per the caller's
		* preference. `width` is the caller's preferred panel width (default
		* PANEL_DEFAULT) and `panelOpen` whether the panel starts expanded (default
		* true); the store seeds new sessions from the user's side card prefs.
		* `seedExplorer` places the default explorer tab — the store passes false
		* when the user disabled the explorer tab type in settings, so a fresh
		* session starts with an empty pane instead of a tab they turned off. */
		function makeDefaultState(width = 400, panelOpen = true, seedExplorer = true) {
			const leaf = {
				kind: "leaf",
				id: uid("pane"),
				tabs: [],
				active: null
			};
			if (seedExplorer) {
				leaf.tabs = [{
					id: uid("tab"),
					type: "explorer",
					title: "Explorer"
				}];
				leaf.active = leaf.tabs[0].id;
			}
			const bottomLeaf = {
				kind: "leaf",
				id: uid("pane"),
				tabs: [],
				active: null
			};
			return {
				panelOpen,
				width,
				activePane: leaf.id,
				nextTerminal: 1,
				nextBrowser: 1,
				expanded: [],
				splits: leaf,
				bottomOpen: false,
				bottomHeight: 220,
				bottomOpenedOnce: false,
				bottomSplits: bottomLeaf
			};
		}
		/** Whether a tree node (or any descendant) carries the given pane/split id. */
		function treeHasId(node, id) {
			if (node.id === id) return true;
			if (node.kind === "split") return node.children.some((child) => treeHasId(child, id));
			return false;
		}
		/** Which tree owns a pane/split id: 'bottomSplits' when the id lives in the
		*  bottom panel's tree, else 'splits' (the right panel's tree). Ids are
		*  globally unique (the shared uid counter), so an id in neither tree falls
		*  back to the right tree, where tree operations no-op on a missing node —
		*  the pre-bottom-panel behavior. */
		function treeOf(state, id) {
			return treeHasId(state.bottomSplits, id) ? "bottomSplits" : "splits";
		}
		/** Walk the tree and apply `visit` to the leaf with the given id. */
		function mapLeaf(node, paneId, visit) {
			if (node.kind === "leaf") {
				if (node.id === paneId) {
					const copy = {
						...node,
						tabs: [...node.tabs]
					};
					visit(copy);
					return copy;
				}
				return node;
			}
			const split = node;
			return {
				...split,
				sizes: [...split.sizes],
				children: split.children.map((child) => mapLeaf(child, paneId, visit))
			};
		}
		/** The first leaf of the tree (fallback pane when activePane is gone). */
		function firstLeaf(node) {
			if (node.kind === "leaf") return node;
			return firstLeaf(node.children[0]);
		}
		/** Empty every leaf of a tree (the bottom tree after its tabs migrate out). */
		function clearAllTabs(node) {
			if (node.kind === "leaf") return {
				...node,
				tabs: [],
				active: null
			};
			return {
				...node,
				children: node.children.map(clearAllTabs)
			};
		}
		/**
		* Narrow-viewport migration: the bottom panel's tabs are thrown INTO the
		* right sidebar — the "merged display" on mobile is the right panel alone,
		* whose tab strips now carry the bottom tree's tabs (depth-first order,
		* appended to the right tree's FIRST leaf). The bottom tree is emptied (its
		* structure stays — the desktop bottom panel re-renders its welcome cards)
		* and the panel closes. The active pane moves to the right tree's first
		* leaf so every new tab lands in the visible panel.
		*
		* Idempotent: a bottom tree with no tabs and a closed panel returns the
		* same reference. Runs when the viewport enters narrow (see the Sidebar
		* shell); migrating is permanent for the session — the tabs now live in the
		* right tree, exactly like the user "threw them in".
		*/
		function migrateBottomTabs(state) {
			const bottomTabs = allLeaves(state.bottomSplits).flatMap((leaf) => leaf.tabs);
			const activeInBottom = state.activePane !== null && treeHasId(state.bottomSplits, state.activePane);
			if (bottomTabs.length === 0 && !state.bottomOpen && !activeInBottom) return state;
			const target = firstLeaf(state.splits);
			return {
				...state,
				activePane: target.id,
				bottomOpen: false,
				splits: bottomTabs.length > 0 ? mapLeaf(state.splits, target.id, (leaf) => {
					leaf.tabs = [...leaf.tabs, ...bottomTabs];
				}) : state.splits,
				bottomSplits: bottomTabs.length > 0 ? clearAllTabs(state.bottomSplits) : state.bottomSplits
			};
		}
		/** Find the leaf containing a tab id, if any. */
		function leafWithTab(node, tabId) {
			if (node.kind === "leaf") return node.tabs.some((tab) => tab.id === tabId) ? node : void 0;
			for (const child of node.children) {
				const found = leafWithTab(child, tabId);
				if (found !== void 0) return found;
			}
		}
		/** All leaves of the tree, depth-first. */
		function allLeaves(node) {
			if (node.kind === "leaf") return [node];
			return node.children.flatMap(allLeaves);
		}
		/** Whether a tab exists anywhere in a state (either tree, any pane). */
		function tabOpenIn(state, tabId) {
			return allLeaves(state.splits).some((leaf) => leaf.tabs.some((tab) => tab.id === tabId)) || allLeaves(state.bottomSplits).some((leaf) => leaf.tabs.some((tab) => tab.id === tabId));
		}
		/**
		* Split a leaf by inserting a fresh leaf holding `tab` beside it — the
		* VSCode drag-to-edge gesture. `dir` is the split direction ('row' for
		* left/right, 'col' for up/down); `front` places the new leaf first (left/
		* up) or second (right/down).
		* @returns the new tree plus the fresh leaf's id (the drop's active pane).
		*/
		function insertLeafAt(node, paneId, dir, tab, front) {
			const fresh = {
				kind: "leaf",
				id: uid("pane"),
				tabs: [tab],
				active: tab.id
			};
			const leafId = fresh.id;
			return {
				node: mapLeaf(node, paneId, (leaf) => {
					const target = { ...leaf };
					const split = {
						kind: "split",
						id: uid("split"),
						dir,
						sizes: [.5, .5],
						children: front ? [fresh, target] : [target, fresh]
					};
					Object.assign(leaf, split);
				}),
				leafId
			};
		}
		/**
		* The VSCode drag gesture: move a tab out of its pane and either merge it
		* into the target pane (center) or split the target pane with the tab in a
		* fresh leaf (edge). The source pane collapses when it empties.
		*
		* The panes may live in DIFFERENT trees (dragging a tab between the two
		* panels): the tab then leaves its own tree and lands in the other one.
		*/
		function moveTabToEdge(state, fromPane, tabId, toPane, zone) {
			if (fromPane === toPane && zone === "center") return moveTab(state, fromPane, tabId, toPane, -1);
			const key = treeOf(state, fromPane);
			const toKey = treeOf(state, toPane);
			if (key !== toKey) {
				const source = leafWithTab(state[key], tabId);
				if (source === void 0) return state;
				const tab = source.tabs.find((candidate) => candidate.id === tabId);
				let emptied = false;
				let sourceNode = mapLeaf(state[key], source.id, (leaf) => {
					leaf.tabs = leaf.tabs.filter((candidate) => candidate.id !== tabId);
					if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null;
					if (leaf.tabs.length === 0) emptied = true;
				});
				if (emptied) sourceNode = removeLeafAt(sourceNode, source.id);
				let targetNode = state[toKey];
				let activePane;
				if (zone === "center") {
					targetNode = mapLeaf(targetNode, toPane, (leaf) => {
						leaf.tabs = [...leaf.tabs, tab];
						leaf.active = tab.id;
					});
					activePane = toPane;
				} else {
					const result = insertLeafAt(targetNode, toPane, zone === "left" || zone === "right" ? "row" : "col", tab, zone === "left" || zone === "up");
					targetNode = result.node;
					activePane = result.leafId;
				}
				return {
					...state,
					[key]: sourceNode,
					[toKey]: targetNode,
					activePane
				};
			}
			const node = state[key];
			const source = leafWithTab(node, tabId);
			if (source === void 0) return state;
			const tab = source.tabs.find((candidate) => candidate.id === tabId);
			let emptied = false;
			let splits = mapLeaf(node, source.id, (leaf) => {
				leaf.tabs = leaf.tabs.filter((candidate) => candidate.id !== tabId);
				if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null;
				if (leaf.tabs.length === 0) emptied = true;
			});
			if (emptied) splits = removeLeafAt(splits, source.id);
			if (zone === "center") {
				splits = mapLeaf(splits, toPane, (leaf) => {
					leaf.tabs = [...leaf.tabs, tab];
					leaf.active = tab.id;
				});
				return {
					...state,
					[key]: splits,
					activePane: toPane
				};
			}
			const result = insertLeafAt(splits, toPane, zone === "left" || zone === "right" ? "row" : "col", tab, zone === "left" || zone === "up");
			return {
				...state,
				[key]: result.node,
				activePane: result.leafId
			};
		}
		/**
		* Remove a leaf from the tree. A split left with one child promotes that
		* child; removing the last leaf yields an empty leaf.
		*/
		function removeLeafAt(node, paneId) {
			if (node.kind === "leaf") return node.id === paneId ? {
				...node,
				tabs: [],
				active: null
			} : node;
			const children = node.children.filter((child) => !(child.kind === "leaf" && child.id === paneId));
			if (children.length === node.children.length) return {
				...node,
				sizes: [...node.sizes],
				children: node.children.map((child) => removeLeafAt(child, paneId))
			};
			if (children.length === 1) return children[0];
			return {
				...node,
				sizes: [...node.sizes],
				children
			};
		}
		/** Close a tab; an emptied leaf is removed (unless it is the only pane). */
		function closeTab(state, paneId, tabId) {
			const key = treeOf(state, paneId);
			let emptied = false;
			const splits = mapLeaf(state[key], paneId, (leaf) => {
				leaf.tabs = leaf.tabs.filter((tab) => tab.id !== tabId);
				if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null;
				if (leaf.tabs.length === 0) emptied = true;
			});
			return {
				...state,
				[key]: emptied ? removeLeafAt(splits, paneId) : splits
			};
		}
		/** Activate a tab in its pane (the pane's own tree). */
		function activateTab(state, paneId, tabId) {
			const key = treeOf(state, paneId);
			return {
				...state,
				activePane: paneId,
				[key]: mapLeaf(state[key], paneId, (leaf) => {
					if (leaf.tabs.some((tab) => tab.id === tabId)) leaf.active = tabId;
				})
			};
		}
		/** Update the display fields of one open tab (title / path / meta) without
		*  re-opening it. The browser tab persists its current URL and hostname
		*  title through this reducer so a reload restores the visited page. A
		*  missing tab id is a no-op. The tab may live in either tree. */
		function patchTab(state, tabId, patch) {
			let changed = false;
			const walk = (node) => {
				if (node.kind === "leaf") {
					const tabs = node.tabs.map((tab) => {
						if (tab.id !== tabId) return tab;
						changed = true;
						return {
							...tab,
							...patch.title !== void 0 ? { title: patch.title } : {},
							...patch.path !== void 0 ? { path: patch.path } : {},
							...patch.meta !== void 0 ? { meta: patch.meta } : {}
						};
					});
					return tabs === node.tabs ? node : {
						...node,
						tabs
					};
				}
				const children = node.children.map(walk);
				return children === node.children ? node : {
					...node,
					children
				};
			};
			const splits = walk(state.splits);
			const bottomSplits = walk(state.bottomSplits);
			return changed ? {
				...state,
				splits,
				bottomSplits
			} : state;
		}
		/**
		* Land a tab in the active pane (or focus its existing instance by id).
		* Dedup strategies (single-instance, per-path, per-change) are owned by the
		* tab descriptor through {@link BetterSidebarService.openTab} / `dedupeKey`;
		* this reducer only handles the id-based safety net (reconcile and
		* openDiffTab already check existence before calling) and the landing
		* itself — the service's dedupe path delegates here after its dedupeKey
		* check misses.
		*
		* The active pane may live in EITHER tree (pane ids are globally unique):
		* a stale id that survives in neither tree falls back to the right tree's
		* first pane instead of swallowing the open.
		*/
		function openTabInActivePane(state, tab) {
			let targetId = state.activePane ?? firstLeaf(state.splits).id;
			if (!allLeaves(state[treeOf(state, targetId)]).some((leaf) => leaf.id === targetId)) targetId = firstLeaf(state.splits).id;
			const targetKey = treeOf(state, targetId);
			for (const leaf of allLeaves(state.splits).concat(allLeaves(state.bottomSplits))) {
				const existing = leaf.tabs.find((candidate) => candidate.id === tab.id);
				if (existing !== void 0) return activateTab(state, leaf.id, existing.id);
			}
			return {
				...state,
				activePane: targetId,
				[targetKey]: mapLeaf(state[targetKey], targetId, (leaf) => {
					leaf.tabs = [...leaf.tabs, tab];
					leaf.active = tab.id;
				})
			};
		}
		/** Move a tab from one pane to another (insert at index; -1 appends).
		*  The panes may live in DIFFERENT trees — dragging a tab between the two
		*  panels removes it from its own tree and lands it in the other one. */
		function moveTab(state, fromPane, tabId, toPane, index = -1) {
			const fromKey = treeOf(state, fromPane);
			const toKey = treeOf(state, toPane);
			if (fromKey !== toKey) {
				let moved;
				let emptied = false;
				const source = mapLeaf(state[fromKey], fromPane, (leaf) => {
					const found = leaf.tabs.find((tab) => tab.id === tabId);
					if (found === void 0) return;
					moved = found;
					leaf.tabs = leaf.tabs.filter((tab) => tab.id !== tabId);
					if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null;
					if (leaf.tabs.length === 0) emptied = true;
				});
				if (moved === void 0) return state;
				const target = mapLeaf(state[toKey], toPane, (leaf) => {
					const insertAt = index >= 0 && index <= leaf.tabs.length ? index : leaf.tabs.length;
					leaf.tabs = [
						...leaf.tabs.slice(0, insertAt),
						moved,
						...leaf.tabs.slice(insertAt)
					];
					leaf.active = moved.id;
				});
				return {
					...state,
					[fromKey]: emptied ? removeLeafAt(source, fromPane) : source,
					[toKey]: target,
					activePane: toPane
				};
			}
			let moved;
			let emptied = false;
			let splits = mapLeaf(state[fromKey], fromPane, (leaf) => {
				const found = leaf.tabs.find((tab) => tab.id === tabId);
				if (found === void 0) return;
				moved = found;
				leaf.tabs = leaf.tabs.filter((tab) => tab.id !== tabId);
				if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null;
				if (leaf.tabs.length === 0) emptied = true;
			});
			if (moved === void 0) return state;
			if (emptied) splits = removeLeafAt(splits, fromPane);
			splits = mapLeaf(splits, toPane, (leaf) => {
				const insertAt = index >= 0 && index <= leaf.tabs.length ? index : leaf.tabs.length;
				leaf.tabs = [
					...leaf.tabs.slice(0, insertAt),
					moved,
					...leaf.tabs.slice(insertAt)
				];
				leaf.active = moved.id;
			});
			return {
				...state,
				[fromKey]: splits,
				activePane: toPane
			};
		}
		/**
		* Open a diff tab the VSCode way: an existing instance of the same change is
		* focused wherever it lives; otherwise the tab joins the first pane that
		* already holds diff tabs (diff panes are sticky — repeated clicks stack
		* there); on the FIRST diff of a layout the source pane splits vertically so
		* the diff lands in a fresh pane below it ("默认在下半栏新增一个").
		*
		* This is split-tree placement surgery, not registry dispatch: the diff tab
		* descriptor's `dedupeKey` is `(tab) => tab.id`, and the existing-instance
		* check below is exactly that rule — the two agree by construction (asserted
		* in tests). Diff tabs minted by the Git view carry change-derived ids, so
		* the id check is the per-change dedupe.
		* @returns the new state, with the diff pane active.
		*/
		function openDiffTab(state, sourcePaneId, tab) {
			const existingLeaf = leafWithTab(state.splits, tab.id);
			if (existingLeaf !== void 0) return activateTab(state, existingLeaf.id, tab.id);
			const diffLeaf = allLeaves(state.splits).find((leaf) => leaf.tabs.some((candidate) => candidate.type === "diff"));
			if (diffLeaf !== void 0) return {
				...state,
				activePane: diffLeaf.id,
				splits: mapLeaf(state.splits, diffLeaf.id, (leaf) => {
					leaf.tabs = [...leaf.tabs, tab];
					leaf.active = tab.id;
				})
			};
			if (!allLeaves(state.splits).some((leaf) => leaf.id === sourcePaneId)) return openTabInActivePane(state, tab);
			const result = insertLeafAt(state.splits, sourcePaneId, "col", tab, false);
			return {
				...state,
				splits: result.node,
				activePane: result.leafId
			};
		}
		/** Toggle the panel open/closed (opening restores the previous layout). */
		function togglePanel(state) {
			return {
				...state,
				panelOpen: !state.panelOpen
			};
		}
		/** Toggle the bottom panel open/closed (independent of the right panel). */
		function toggleBottomPanel(state) {
			return {
				...state,
				bottomOpen: !state.bottomOpen
			};
		}
		/** Set the panel width (clamped to the contract range; the upper bound is
		* the viewport so the fullscreen expansion can fill the window). */
		function setWidth(state, width) {
			const max = typeof window !== "undefined" ? Math.max(280, window.innerWidth) : 640;
			return {
				...state,
				width: Math.min(max, Math.max(280, Math.round(width)))
			};
		}
		/** Set the bottom panel height (clamped to the contract range). The upper
		* bound leaves the center column (the agent output area) at least PANEL_MIN
		* tall — without the cap the bottom panel could swallow the whole viewport
		* and squeeze the conversation to zero height. */
		function setBottomHeight(state, height) {
			const viewport = typeof window !== "undefined" ? window.innerHeight : Infinity;
			const max = Math.max(120, viewport - 280);
			return {
				...state,
				bottomHeight: Math.min(max, Math.max(120, Math.round(height)))
			};
		}
		/** Toggle a directory in the explorer expansion set. */
		function toggleExpanded(state, path) {
			const expanded = state.expanded.includes(path) ? state.expanded.filter((item) => item !== path) : [...state.expanded, path];
			return {
				...state,
				expanded
			};
		}
		/** Adjust one split divider: `i` is the left/top child index, delta in fractions. */
		function resizeSplit(node, splitId, index, delta) {
			if (node.kind === "leaf") return node;
			if (node.id === splitId) {
				const sizes = [...node.sizes];
				const left = Math.min(.92, Math.max(.08, sizes[index] + delta));
				const right = Math.min(.92, Math.max(.08, sizes[index + 1] - delta));
				sizes[index] = left;
				sizes[index + 1] = right;
				return {
					...node,
					sizes
				};
			}
			return {
				...node,
				sizes: [...node.sizes],
				children: node.children.map((child) => resizeSplit(child, splitId, index, delta))
			};
		}
		/** State-level {@link resizeSplit} route: the divider may live in either
		*  tree (split ids are globally unique). */
		function resizeSplitIn(state, splitId, index, delta) {
			const key = treeOf(state, splitId);
			return {
				...state,
				[key]: resizeSplit(state[key], splitId, index, delta)
			};
		}
		/** Prefix marking a tab id as an agent-owned terminal (suffix is the uuid). */
		const AGENT_TAB_PREFIX = "agent:";
		/** Whether a tab id refers to an agent-owned terminal. */
		function isAgentTabId(tabId) {
			return tabId.startsWith(AGENT_TAB_PREFIX);
		}
		/** Extract the agent terminal uuid from an `agent:<uuid>` tab id. */
		function agentUuidOf(tabId) {
			return tabId.slice(6);
		}
		/** Build the sidebar tab id for one agent terminal uuid. */
		function agentTabId(uuid) {
			return `${AGENT_TAB_PREFIX}${uuid}`;
		}
		/**
		* Reconcile the sidebar's agent-terminal tabs with the host's live list.
		* The host pushes the current list of agent terminals (created by the model
		* through the `terminal_create` tool) over a dedicated WebSocket; this
		* reducer mirrors that list into tabs: new uuids get a tab, vanished uuids
		* lose theirs. The agent owns the lifetime — the user closing a tab sends a
		* WS close frame that kills the pty, which fires a change, which converges
		* the view. Idempotent: a no-op when the lists already match.
		* @param state - the current per-session sidebar state.
		* @param agentTerminals - the live agent terminal snapshots from the host.
		* @returns the next state (or the same reference if no change was needed).
		*/
		function reconcileAgentTerminals(state, agentTerminals) {
			const existingAgentTabs = allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap((leaf) => leaf.tabs).filter((tab) => isAgentTabId(tab.id));
			const existingUuids = new Set(existingAgentTabs.map((tab) => agentUuidOf(tab.id)));
			const serverUuids = new Set(agentTerminals.map((t) => t.uuid));
			const toAdd = agentTerminals.filter((t) => !existingUuids.has(t.uuid));
			const toRemove = existingAgentTabs.filter((tab) => !serverUuids.has(agentUuidOf(tab.id)));
			if (toAdd.length === 0 && toRemove.length === 0) return state;
			let splits = state.splits;
			for (const tab of toRemove) {
				const leaf = leafWithTab(splits, tab.id);
				if (leaf !== void 0) splits = closeTab({
					...state,
					splits
				}, leaf.id, tab.id).splits;
			}
			let next = {
				...state,
				splits
			};
			for (const terminal of toAdd) {
				const tab = {
					id: agentTabId(terminal.uuid),
					type: "terminal",
					title: terminal.title
				};
				next = openTabInActivePane(next, tab);
			}
			return next;
		}
		const STORAGE_PREFIX = "dsh-sidebar:v1";
		/** Default panel width for one viewport: the prefs percent of the window,
		* clamped to the panel floor (a tiny percent must stay usable) and to the
		* viewport (a large one must never cover the whole window). */
		function defaultWidthFor(viewport, percent) {
			return Math.min(viewport, Math.max(280, Math.round(viewport * percent / 100)));
		}
		function loadState(sessionId, prefs) {
			try {
				const raw = localStorage.getItem(`${STORAGE_PREFIX}:${sessionId}`);
				if (raw !== null) {
					const parsed = JSON.parse(raw);
					nextIdCounter = maxCounterId(parsed);
					const sanitized = sanitizeState(parsed);
					if (sanitized !== void 0) return sanitized;
				}
			} catch {}
			const viewport = typeof window !== "undefined" ? window.innerWidth : void 0;
			return makeDefaultState(viewport === void 0 ? 400 : defaultWidthFor(viewport, prefs.defaultWidthPercent), prefs.openByDefault && (viewport === void 0 || !isNarrowWidth(viewport)), prefs.tabsEnabled["explorer"] !== false);
		}
		/**
		* Structural validation of one persisted state. A malformed or stale shape
		* (older layouts, hand-edited storage) must fall back to the default instead
		* of crashing the panel on every reload; the restored width is also clamped
		* to the current viewport so a stale fullscreen width can never crush the
		* app shell (margin-right larger than the window) or cover the whole screen.
		* @returns a clean state, or undefined to fall back to the default.
		*/
		function sanitizeState(parsed) {
			if (parsed === null || typeof parsed !== "object") return void 0;
			const record = parsed;
			if (typeof record.panelOpen !== "boolean") return void 0;
			if (typeof record.width !== "number" || !Number.isFinite(record.width)) return void 0;
			if (typeof record.nextTerminal !== "number" || !Number.isInteger(record.nextTerminal) || record.nextTerminal < 1) return;
			const nextBrowser = typeof record.nextBrowser === "number" && Number.isInteger(record.nextBrowser) && record.nextBrowser >= 1 ? record.nextBrowser : 1;
			if (typeof record.activePane !== "string" && record.activePane !== null) return void 0;
			if (!Array.isArray(record.expanded) || record.expanded.some((item) => typeof item !== "string")) return void 0;
			const seen = /* @__PURE__ */ new Set();
			const reid = /* @__PURE__ */ new Map();
			const splits = sanitizeNode(record.splits, seen, reid);
			if (splits === void 0) return void 0;
			const bottomOpen = record.bottomOpen === true;
			const maxHeight = typeof window !== "undefined" ? window.innerHeight : Infinity;
			const bottomCap = Math.max(120, maxHeight - 280);
			const rawHeight = typeof record.bottomHeight === "number" && Number.isFinite(record.bottomHeight) ? record.bottomHeight : 220;
			const bottomHeight = Math.min(bottomCap, Math.max(120, Math.round(rawHeight)));
			const bottomSplits = sanitizeNode(record.bottomSplits, seen, reid) ?? {
				kind: "leaf",
				id: uid("pane"),
				tabs: [],
				active: null
			};
			const maxWidth = typeof window !== "undefined" ? window.innerWidth : Infinity;
			return {
				panelOpen: record.panelOpen,
				width: Math.max(280, Math.min(record.width, maxWidth)),
				activePane: typeof record.activePane === "string" ? reid.get(record.activePane) ?? record.activePane : null,
				nextTerminal: record.nextTerminal,
				nextBrowser,
				expanded: record.expanded,
				splits,
				bottomOpen,
				bottomHeight,
				bottomOpenedOnce: record.bottomOpenedOnce === true,
				bottomSplits
			};
		}
		/**
		* One tree node id, deduplicated against the ids already seen in this
		* state. Duplicates are exactly the pre-seeding counter-reset corruption
		* (a "pane:1"/"split:1" minted after a reload beside the persisted ones):
		* keeping both would make mapLeaf visit two leaves at once and every open
		* would land in both panes, so the repeat gets a fresh id.
		* @returns the id to use (the original, or a fresh uid for repeats).
		*/
		function uniqueNodeId(id, seen, reid) {
			if (!seen.has(id)) {
				seen.add(id);
				return id;
			}
			const fresh = uid(/^split:\d+$/.test(id) ? "split" : "pane");
			seen.add(fresh);
			reid.set(id, fresh);
			return fresh;
		}
		/** Validate one split-tree node (leaf or split) and rebuild it cleanly. */
		function sanitizeNode(node, seen, reid) {
			if (node === null || typeof node !== "object") return void 0;
			const record = node;
			if (record.kind === "leaf") {
				if (typeof record.id !== "string" || !Array.isArray(record.tabs)) return void 0;
				const tabs = [];
				let droppedDiff = false;
				for (const tab of record.tabs) {
					if (tab === null || typeof tab !== "object") return void 0;
					const candidate = tab;
					if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return void 0;
					if (candidate.type === "diff") {
						droppedDiff = true;
						continue;
					}
					if (typeof candidate.type !== "string") return void 0;
					tabs.push({
						id: candidate.id,
						type: candidate.type,
						title: candidate.title,
						...typeof candidate.path === "string" ? { path: candidate.path } : {},
						...candidate.meta !== void 0 ? { meta: candidate.meta } : {}
					});
				}
				const active = typeof record.active === "string" ? record.active : null;
				if (active !== null && !tabs.some((tab) => tab.id === active) && !droppedDiff) return void 0;
				return {
					kind: "leaf",
					id: uniqueNodeId(record.id, seen, reid),
					tabs,
					active: active !== null && tabs.some((tab) => tab.id === active) ? active : null
				};
			}
			if (record.kind === "split") {
				if (typeof record.id !== "string" || record.dir !== "row" && record.dir !== "col") return void 0;
				if (!Array.isArray(record.children) || !Array.isArray(record.sizes)) return void 0;
				const children = [];
				for (const child of record.children) {
					const clean = sanitizeNode(child, seen, reid);
					if (clean === void 0) return void 0;
					children.push(clean);
				}
				if (children.length < 2) return void 0;
				if (record.sizes.length !== children.length || record.sizes.some((size) => typeof size !== "number" || !Number.isFinite(size) || size <= 0)) return;
				return {
					kind: "split",
					id: uniqueNodeId(record.id, seen, reid),
					dir: record.dir,
					sizes: record.sizes,
					children
				};
			}
		}
		/** The session-scoped store: one state per conversation, localStorage-backed. */
		var SidebarStore = class {
			bySession = /* @__PURE__ */ new Map();
			snapshot = {
				sessionId: void 0,
				state: void 0,
				prefs: { ...SIDEBAR_PREFS_DEFAULTS }
			};
			listeners = /* @__PURE__ */ new Set();
			/** Per-session persist debounce timers (v0.12.0+: one per session, so a
			*  targeted open never cancels another session's pending write). */
			persistTimers = /* @__PURE__ */ new Map();
			/** User-facing side card prefs seeding brand-new session states (defaults until the settings RPC resolves). */
			prefs = { ...SIDEBAR_PREFS_DEFAULTS };
			/**
			* Replace the side card prefs (the settings RPC result / settings page
			* write). Notifies like any store change: the snapshot carries the prefs,
			* so consumers that gate on enable switches (the + menu, derived flows)
			* re-render with the new values immediately.
			*/
			setPrefs(prefs) {
				this.prefs = { ...prefs };
				this.snapshot = {
					...this.snapshot,
					prefs: this.prefs
				};
				this.notify();
			}
			/** The current side card prefs (seeds new sessions; persisted states win). */
			getPrefs() {
				return { ...this.prefs };
			}
			/** Select a session (or none); loads its persisted state. */
			setSession(sessionId) {
				if (this.snapshot.sessionId === sessionId) return;
				if (sessionId === void 0) this.snapshot = {
					sessionId: void 0,
					state: void 0,
					prefs: this.prefs
				};
				else {
					let state = this.bySession.get(sessionId);
					if (state === void 0) {
						state = loadState(sessionId, this.prefs);
						this.bySession.set(sessionId, state);
					} else nextIdCounter = maxCounterId(state);
					this.snapshot = {
						sessionId,
						state,
						prefs: this.prefs
					};
				}
				this.notify();
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			getSnapshot() {
				return this.snapshot;
			}
			/** Mutate the current session's state (no-op without a session). */
			update(mutator) {
				const sessionId = this.snapshot.sessionId;
				const state = this.snapshot.state;
				if (sessionId === void 0 || state === void 0) return;
				const draft = structuredClone(state);
				mutator(draft);
				this.bySession.set(sessionId, draft);
				this.snapshot = {
					sessionId,
					state: draft,
					prefs: this.prefs
				};
				this.schedulePersist(sessionId, draft);
				this.notify();
			}
			/**
			* Whether a tab still exists in its session's state. Views use this on
			* unmount to tell "the tab was closed" (release the terminal now) from
			* "the tree re-rendered / the conversation switched" (the tab is still
			* open — keep the terminal alive through the host's reconnect grace).
			* Checks the session's own map entry (the current snapshot may already
			* point at another session when a conversation switch unmounts the old
			* one's tabs).
			*/
			tabOpen(sessionId, tabId) {
				const state = this.bySession.get(sessionId) ?? (this.snapshot.sessionId === sessionId ? this.snapshot.state : void 0);
				return state !== void 0 && tabOpenIn(state, tabId);
			}
			/** Apply a pure reducer (returns the next state). */
			reduce(reducer) {
				const sessionId = this.snapshot.sessionId;
				const state = this.snapshot.state;
				if (sessionId === void 0 || state === void 0) return;
				const next = reducer(state);
				if (next === state) return;
				this.bySession.set(sessionId, next);
				this.snapshot = {
					sessionId,
					state: next,
					prefs: this.prefs
				};
				this.schedulePersist(sessionId, next);
				this.notify();
			}
			/**
			* Apply a pure reducer to a TARGET session's state (not the active one),
			* loading it on demand and persisting the result — WITHOUT switching the
			* active snapshot or notifying (the UI must not follow along). Used by the
			* service's targeted `openTab(seed, scope)`: the open lands in the target
			* session's layout and is visible whenever the user switches to it.
			*/
			reduceFor(sessionId, reducer) {
				const counterBefore = nextIdCounter;
				let state = this.bySession.get(sessionId);
				if (state === void 0) {
					state = loadState(sessionId, this.prefs);
					this.bySession.set(sessionId, state);
				} else nextIdCounter = maxCounterId(state);
				const next = reducer(state);
				nextIdCounter = Math.max(nextIdCounter, counterBefore);
				if (next === state) return;
				this.bySession.set(sessionId, next);
				this.schedulePersist(sessionId, next);
			}
			schedulePersist(sessionId, state) {
				const existing = this.persistTimers.get(sessionId);
				if (existing !== void 0) window.clearTimeout(existing);
				const timer = window.setTimeout(() => {
					this.persistTimers.delete(sessionId);
					try {
						localStorage.setItem(`${STORAGE_PREFIX}:${sessionId}`, JSON.stringify(state));
					} catch {}
				}, 200);
				this.persistTimers.set(sessionId, timer);
			}
			notify() {
				for (const listener of [...this.listeners]) listener();
			}
		};
		/**
		* Create one sidebar store instance. Production code calls this only from
		* the client plugin's `apply` (the instance is handed to components as a
		* prop); tests call it directly. No module-level singleton: the store's
		* lifetime belongs to the plugin activation, exactly like the official
		* `createXXXStore()` factory rule.
		*/
		function createSidebarStore() {
			return new SidebarStore();
		}
		//#endregion
		//#region src/client/service.ts
		/** Extract the lowercase extension without leading dot from a path. */
		function extOfPath(path) {
			const at = path.lastIndexOf(".");
			if (at === -1) return "";
			const base = path.slice(at + 1).toLowerCase();
			return base.includes("/") || base.includes("\\") ? "" : base;
		}
		/** The file name of a path (both separators). */
		function baseNameOf(path) {
			const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
			return at === -1 ? path : path.slice(at + 1);
		}
		/**
		* Find the tab type that claims an intercepted external-link URL (v0.13.0+).
		* Walks the descriptors in REGISTRATION order and returns the first one
		* that declares `urlTarget` and matches `url`; a throwing predicate is
		* swallowed (console.error, type skipped) so one broken plugin can never
		* break the whole link pipeline. The caller passes the ENABLED tab
		* descriptors (enablement is the caller's prefs domain — filter
		* `service.getTabs()` through `tabsEnabled` before matching) and falls
		* back to the built-in browser tab when nothing claims the URL (the
		* browser never declares `urlTarget` itself, so it can never shadow a
		* plugin claim).
		*/
		function matchUrlTarget(tabs, url) {
			for (const tab of tabs) {
				if (tab.urlTarget === void 0) continue;
				let claimed = false;
				try {
					claimed = tab.urlTarget(url) === true;
				} catch (error) {
					console.error("[dsh-better-sidebar] urlTarget error:", error);
					continue;
				}
				if (claimed) return tab;
			}
		}
		/**
		* The plugin version this service instance reports. Keep in lockstep with
		* `package.json`'s version — `tests/service.spec.ts` asserts the pair.
		*/
		const SIDEBAR_SERVICE_VERSION = "0.12.2";
		/**
		* Monotonic capability list consumers use to gate new API usage (features
		* are never removed). Each string names a v0.12.0+ capability:
		* - 'badge': TabDescriptor.badge
		* - 'tabLifecycle': TabDescriptor.onOpen/onActivate/onClose
		* - 'updateTab': BetterSidebarService.updateTab
		* - 'openFile': BetterSidebarService.openFile
		* - 'targetedOpen': BetterSidebarService.openTab(seed, scope?)
		* - 'stateSubscription': getSnapshot/subscribeState
		* - 'tabMeta': SidebarTab.meta (seeds, createTab, updateTab, persistence)
		* - 'pluginSettings': SidebarSettingsDeclaration.pluginToggles/render
		* - 'urlTarget' (v0.13.0): TabDescriptor.urlTarget (external-link claims)
		*/
		const SIDEBAR_FEATURES = [
			"badge",
			"tabLifecycle",
			"updateTab",
			"openFile",
			"targetedOpen",
			"stateSubscription",
			"tabMeta",
			"pluginSettings",
			"urlTarget"
		];
		/** Run one plugin callback; a throw is logged and never breaks the caller. */
		function safeCall(fn) {
			try {
				fn();
			} catch (error) {
				console.error("[dsh-better-sidebar] plugin callback error:", error);
			}
		}
		/**
		* Create one BetterSidebar service bound to a store. The service owns the
		* tab/viewer registries (Map + listener set) and proxies openTab/closeTab
		* to the store's reducer. One instance per client plugin activation.
		*/
		function createBetterSidebarService(store) {
			const tabs = /* @__PURE__ */ new Map();
			const viewers = /* @__PURE__ */ new Map();
			const listeners = /* @__PURE__ */ new Set();
			const notify = () => {
				for (const fn of [...listeners]) fn();
			};
			const subscribe = (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			};
			const registerTab = (descriptor) => {
				if (tabs.has(descriptor.id)) throw new Error(`[dsh-better-sidebar] tab type "${descriptor.id}" already registered`);
				tabs.set(descriptor.id, descriptor);
				notify();
				return () => {
					if (tabs.get(descriptor.id) === descriptor) {
						tabs.delete(descriptor.id);
						notify();
					}
				};
			};
			const registerFileViewer = (descriptor) => {
				if (viewers.has(descriptor.id)) throw new Error(`[dsh-better-sidebar] file viewer "${descriptor.id}" already registered`);
				viewers.set(descriptor.id, descriptor);
				notify();
				return () => {
					if (viewers.get(descriptor.id) === descriptor) {
						viewers.delete(descriptor.id);
						notify();
					}
				};
			};
			const getTabs = () => Array.from(tabs.values());
			const getFileViewers = () => Array.from(viewers.values());
			const getTab = (id) => tabs.get(id);
			const isTabEnabled = (id) => store.getPrefs().tabsEnabled[id] !== false;
			const isViewerEnabled = (id) => store.getPrefs().viewersEnabled[id] !== false;
			const matchFileViewer = (path, head) => {
				const ext = extOfPath(path);
				for (const v of Array.from(viewers.values()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
					if (!isViewerEnabled(v.id)) continue;
					if (head !== void 0 && v.detect !== void 0) {
						if (v.detect(path, head)) return v;
						if (v.exts.length === 0) continue;
					} else if (v.exts.length === 0) {
						if (v.detect === void 0) return v;
						continue;
					}
					if (v.exts.includes(ext)) return v;
				}
			};
			const openTab = (seed, scope) => {
				if (!isTabEnabled(seed.type)) {
					console.warn(`[dsh-better-sidebar] tab type "${seed.type}" is disabled in the side card settings`);
					return;
				}
				const descriptor = tabs.get(seed.type);
				if (descriptor === void 0) return;
				const targetSessionId = scope?.sessionId ?? store.getSnapshot().sessionId;
				if (targetSessionId === void 0) return;
				const callbackScope = scope ?? { sessionId: targetSessionId };
				const activeSessionId = store.getSnapshot().sessionId;
				const targetsInactiveSession = scope !== void 0 && scope.sessionId !== activeSessionId;
				let created;
				let activated;
				const reducer = (state) => {
					let tab;
					let next;
					if (descriptor.createTab !== void 0) {
						const result = descriptor.createTab(state);
						if (result === null) return state;
						tab = result.tab;
						next = applyDedupe(state, result.tab, descriptor);
						if (result.patch !== void 0) next = {
							...next,
							...result.patch
						};
					} else {
						tab = {
							id: seed.id ?? seed.type,
							type: seed.type,
							title: seed.title ?? (typeof descriptor.title === "function" ? descriptor.title() : descriptor.title),
							...seed.path !== void 0 ? { path: seed.path } : {},
							...seed.diff !== void 0 ? { diff: seed.diff } : {},
							...seed.meta !== void 0 ? { meta: seed.meta } : {}
						};
						next = applyDedupe(state, tab, descriptor);
					}
					const dedupeKey = descriptor.dedupeKey ?? (descriptor.single === true ? () => descriptor.id : void 0);
					const key = dedupeKey?.(tab);
					const inputTabs = allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap((leaf) => leaf.tabs);
					const existedByKey = key !== void 0 && inputTabs.some((candidate) => candidate.type === tab.type && dedupeKey(candidate) === key);
					const existedById = tabOpenIn(state, tab.id);
					const isCreation = !existedByKey && !existedById;
					let landed = next;
					if (seed.url !== void 0 && isCreation) landed = patchTab(next, tab.id, {
						path: seed.url,
						...seed.title !== void 0 ? { title: seed.title } : {}
					});
					if (isCreation) created = allLeaves(landed.splits).concat(allLeaves(landed.bottomSplits)).flatMap((leaf) => leaf.tabs).find((candidate) => candidate.id === tab.id) ?? tab;
					else {
						const candidates = allLeaves(landed.splits).concat(allLeaves(landed.bottomSplits)).flatMap((leaf) => leaf.tabs);
						activated = key !== void 0 ? candidates.find((candidate) => candidate.type === tab.type && dedupeKey(candidate) === key) : candidates.find((candidate) => candidate.id === tab.id);
						activated ??= tab;
					}
					if (!targetsInactiveSession && typeof window !== "undefined" && (seed.path !== void 0 || seed.url !== void 0)) {
						if (isNarrowWidth(window.innerWidth)) {
							if (!landed.panelOpen) return togglePanel(landed);
						} else if (treeOf(landed, landed.activePane ?? "") === "bottomSplits") {
							if (!landed.bottomOpen) return {
								...landed,
								bottomOpen: true
							};
						} else if (!landed.panelOpen) return togglePanel(landed);
					}
					return landed;
				};
				if (targetsInactiveSession) store.reduceFor(scope.sessionId, reducer);
				else store.reduce(reducer);
				if (created !== void 0) safeCall(() => descriptor.onOpen?.(created, callbackScope));
				else if (activated !== void 0) safeCall(() => descriptor.onActivate?.(activated, callbackScope));
			};
			const closeTab$1 = (tabId, scope) => {
				let closed;
				store.reduce((state) => {
					if (!tabOpenIn(state, tabId)) return state;
					const paneId = findPaneIdOf(state, tabId);
					closed = leafWithTab(state[treeOf(state, paneId)], tabId)?.tabs.find((tab) => tab.id === tabId);
					return closeTab(state, paneId, tabId);
				});
				if (closed !== void 0) {
					const sessionId = scope?.sessionId ?? store.getSnapshot().sessionId;
					if (sessionId !== void 0) {
						const descriptor = tabs.get(closed.type);
						safeCall(() => descriptor?.onClose?.(closed, scope ?? { sessionId }));
					}
				}
			};
			/** The snapshot the store publishes (state/prefs carry the active session). */
			const getSnapshot = () => store.getSnapshot();
			/** Store changes: session switch, state mutations, prefs writes. */
			const subscribeState = (listener) => store.subscribe(listener);
			/** Patch an open tab's display fields (a missing tab id is a no-op). */
			const updateTab = (tabId, patch) => {
				store.reduce((state) => patchTab(state, tabId, {
					...patch.title !== void 0 ? { title: patch.title } : {},
					...patch.path !== void 0 ? { path: patch.path } : {},
					...patch.meta !== void 0 ? { meta: patch.meta } : {}
				}));
			};
			/** Activate an open tab (the tab-bar activation path; fires onActivate). */
			const activateTab$1 = (tabId, scope) => {
				let activated;
				store.reduce((state) => {
					if (!tabOpenIn(state, tabId)) return state;
					const paneId = findPaneIdOf(state, tabId);
					activated = leafWithTab(state[treeOf(state, paneId)], tabId)?.tabs.find((tab) => tab.id === tabId);
					return activateTab(state, paneId, tabId);
				});
				if (activated !== void 0) {
					const sessionId = scope?.sessionId ?? store.getSnapshot().sessionId;
					if (sessionId !== void 0) {
						const descriptor = tabs.get(activated.type);
						safeCall(() => descriptor?.onActivate?.(activated, scope ?? { sessionId }));
					}
				}
			};
			/** Open a file in the sidebar editor of `scope`'s session (title defaults
			*  to the file name; the tab id is path-derived, like the internal
			*  open-path interception, so distinct files open side by side). */
			const openFile = (scope, path, title) => {
				openTab({
					type: "editor",
					title: title ?? baseNameOf(path),
					path,
					id: `editor:${path}`
				}, scope);
			};
			return {
				registerTab,
				registerFileViewer,
				getTabs,
				getFileViewers,
				getTab,
				isTabEnabled,
				isViewerEnabled,
				matchFileViewer,
				openTab,
				closeTab: closeTab$1,
				subscribe,
				version: SIDEBAR_SERVICE_VERSION,
				features: SIDEBAR_FEATURES,
				getSnapshot,
				subscribeState,
				updateTab,
				activateTab: activateTab$1,
				openFile
			};
		}
		/**
		* Apply dedup: if a tab whose `dedupeKey` matches an existing tab of the
		* same type exists, focus it; otherwise land the tab through
		* `openTabInActivePane` (the id safety net + active-pane landing are that
		* reducer's job — not re-implemented here).
		* `single: true` resolves to the id-key sugar when no explicit key is given.
		*/
		function applyDedupe(state, tab, descriptor) {
			const dedupeKey = descriptor.dedupeKey ?? (descriptor.single === true ? () => descriptor.id : void 0);
			const key = dedupeKey?.(tab);
			if (key !== void 0) for (const leaf of allLeaves(state.splits).concat(allLeaves(state.bottomSplits))) {
				const existing = leaf.tabs.find((t) => t.type === tab.type && dedupeKey(t) === key);
				if (existing !== void 0) return activateTab(state, leaf.id, existing.id);
			}
			return openTabInActivePane(state, tab);
		}
		/** Find which pane hosts a tab id ('' if none). Either tree is searched. */
		function findPaneIdOf(state, tabId) {
			for (const leaf of allLeaves(state.splits).concat(allLeaves(state.bottomSplits))) if (leaf.tabs.some((t) => t.id === tabId)) return leaf.id;
			return state.activePane ?? "";
		}
		//#endregion
		//#region src/client/chunk-loader.ts
		/**
		* The platform externals a chunk bundle may require (mirror of
		* CLIENT_EXTERNALS in tsdown.config.ts — the chunk builds keep these
		* external and the loader resolves them here). A superset is safe: the
		* require only answers what the chunk actually asks for.
		*/
		const CHUNK_EXTERNALS = [
			"react",
			"react/jsx-runtime",
			"react-dom",
			"react-dom/client",
			"cordis",
			"@deepseek-ai/dsh-client-ui-slots",
			"@deepseek-ai/dsh-client-web-react",
			"@deepseek-ai/dsh-client-ui-primitives",
			"@deepseek-ai/dsh-client-schema-form",
			"@deepseek-ai/dsh-client-runtime/client"
		];
		/** Chunk script endpoint served by the plugin host half (src/bundle-route.ts). */
		const CHUNK_URL = (name) => `/sidebar/bundle/${name}.js`;
		/** Resolve the shell-installed module system (set before any plugin activates). */
		let fallbackModuleSystem;
		function moduleSystem() {
			const globalModules = globalThis.__DSH_MODULES__;
			if (globalModules && typeof globalModules.import === "function") return globalModules;
			// The plugin entry already receives the same resolver from ModuleLoader.
			// Reuse it when the legacy global is absent (older shells / early loads).
			if (fallbackModuleSystem === void 0 && typeof require === "function") {
				fallbackModuleSystem = {
					import: async (specifier) => require(specifier)
				};
			}
			return fallbackModuleSystem;
		}
		function chunkRegistry() {
			const g = globalThis;
			return g.__dshChunks__ ??= {};
		}
		const defaultScriptLoader = (src) => new Promise((resolve, reject) => {
			const el = document.createElement("script");
			el.async = true;
			el.src = src;
			el.addEventListener("load", () => {
				el.remove();
				resolve();
			}, { once: true });
			el.addEventListener("error", () => {
				el.remove();
				reject(/* @__PURE__ */ new Error(`[dsh-better-sidebar] chunk script ${src} failed to load`));
			}, { once: true });
			document.head.append(el);
		});
		let scriptLoader = defaultScriptLoader;
		/** Test/dev hook: resolve a chunk without fetching a script (e.g. vitest). */
		const testLoaders = /* @__PURE__ */ new Map();
		/** Memoized externals require, resolved once per page from the seed table. */
		let externalsRequire;
		async function buildExternalsRequire(modules) {
			if (externalsRequire !== void 0) return externalsRequire;
			const entries = await Promise.all(CHUNK_EXTERNALS.map(async (spec) => {
				try {
					return [spec, await modules.import(spec)];
				} catch {
					return [spec, void 0];
				}
			}));
			const table = new Map(entries);
			externalsRequire = (spec) => {
				if (!table.has(spec)) throw new Error(`[dsh-better-sidebar] chunk require('${spec}') missed the module table`);
				return table.get(spec);
			};
			return externalsRequire;
		}
		/** In-flight/memoized chunk loads; a failure removes its entry so a retry re-fetches. */
		const cache = /* @__PURE__ */ new Map();
		/**
		* Load (once) and materialize a lazy chunk, returning its module exports.
		* Concurrent callers share one in-flight load; a failure clears the cache
		* entry so the next call retries (the script re-executes and overwrites its
		* global registry slot — assignments are idempotent).
		* @param name - the chunk to load.
		*/
		function loadChunk(name) {
			const cached = cache.get(name);
			if (cached !== void 0) return cached;
			const task = (async () => {
				const test = testLoaders.get(name);
				if (test !== void 0) return test();
				const modules = moduleSystem();
				if (modules === void 0) throw new Error(`[dsh-better-sidebar] chunk "${name}": client module system unavailable`);
				await scriptLoader(CHUNK_URL(name));
				const factory = chunkRegistry()[name];
				if (typeof factory !== "function") throw new Error(`[dsh-better-sidebar] chunk "${name}" script did not register its factory`);
				return factory(await buildExternalsRequire(modules));
			})();
			cache.set(name, task);
			task.catch(() => {
				cache.delete(name);
			});
			return task;
		}
		/**
		* Drop all chunk state for a fresh plugin activation (HMR-safe): clear the
		* in-memory cache and any test-registry entries, so the next lazy open
		* re-fetches and re-executes the current chunk scripts (the registry slots
		* are overwritten by the re-execution — no cleanup needed).
		*/
		function resetChunks() {
			cache.clear();
			testLoaders.clear();
			externalsRequire = void 0;
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Minimal zh/en copy for the sidebar. The copy follows the DSH i18n system:
		* the client apply attaches the locale service (`ctx.locale`, provided by
		* `@deepseek-ai/dsh-client-locale`) through {@link attachLocale}, and
		* `t()`/`isZh()` resolve the active locale from it — the Host-backed
		* `locale.preference` wins over the raw browser language and switches live.
		* Without an attached service (standalone/test compositions) the browser
		* language is used, matching the previous behavior. The dictionaries are
		* also registered into the DSH locale registry under {@link LOCALE_NS}.
		*/
		/** The zh dictionary (also registered into the DSH locale registry under {@link LOCALE_NS}). */
		const zh = {
			explorer: "资源管理器",
			git: "源代码管理",
			terminal: "终端",
			editor: "编辑器",
			newTab: "新建标签页",
			openExplorer: "资源管理器",
			openGit: "Git 面板",
			newTerminal: "新终端",
			terminalLimit: "终端数量已达上限 (3)",
			close: "关闭",
			collapse: "折叠侧边栏",
			expand: "展开侧边栏",
			collapseBottomPanel: "折叠底部面板",
			expandBottomPanel: "展开底部面板",
			terminalError: "终端连接失败",
			terminalConnectFailed: "终端多次连接失败",
			terminalRetry: "重试",
			preview: "预览",
			edit: "编辑",
			refresh: "刷新",
			save: "保存",
			saved: "已保存",
			unsaved: "未保存",
			saveFailed: "保存失败",
			truncation: "文件过大，仅显示前 512KB",
			binary: "二进制文件，无法预览",
			loading: "加载中…",
			error: "加载失败",
			retry: "重试",
			splitLeft: "向左分栏",
			splitRight: "向右分栏",
			splitUp: "向上分栏",
			splitDown: "向下分栏",
			notRepo: "当前目录不是 git 仓库",
			noChanges: "没有变更",
			stage: "暂存",
			unstage: "取消暂存",
			stageAll: "全部暂存",
			unstageAll: "全部取消暂存",
			commitPlaceholder: "提交信息 (Ctrl+Enter)",
			commit: "提交",
			commitError: "提交失败",
			branch: "分支",
			checkoutError: "切换分支失败",
			history: "历史",
			changes: "变更",
			staged: "已暂存",
			unstaged: "未暂存",
			cancel: "取消",
			diffEmpty: "没有文本差异",
			diffLoadError: "加载差异失败",
			diffBinary: "二进制",
			diffAdded: "新增",
			diffDeleted: "删除",
			diffRenamed: "重命名",
			diffExpand: "展开其余 {count} 行",
			diffCollapse: "收起",
			discard: "放弃更改",
			discardTitle: "放弃更改",
			discardDesc: "将丢弃「{path}」的工作区修改（不可恢复）。",
			viewCommitDiff: "查看提交差异",
			copyShortHash: "复制短哈希",
			copyFullHash: "复制完整哈希",
			copySubject: "复制提交信息",
			revertCommit: "还原此提交",
			revertTitle: "还原此提交",
			revertDesc: "将在当前分支创建一个反转「{subject}」的新提交。",
			cherryPickCommit: "捡取此提交",
			cherryPickTitle: "捡取此提交",
			cherryPickDesc: "将「{subject}」的更改应用到当前分支。",
			timeJustNow: "刚刚",
			timeMinutesAgo: "{n} 分钟前",
			timeHoursAgo: "{n} 小时前",
			timeYesterday: "昨天",
			loadMore: "加载更多",
			historyLoadError: "加载更多历史失败",
			produced: "本次产出",
			producedOpen: "在侧边栏中打开",
			disconnected: "终端连接断开，重连中…",
			exited: "终端进程已退出",
			noSession: "选择一个会话以使用侧边栏",
			pluginNotLoaded: "插件未加载，标签页暂不可用：",
			hiddenFiles: "隐藏文件",
			parent: "上级目录",
			editorBack: "返回上级",
			copied: "已复制",
			copy: "复制",
			newFile: "新文件",
			openEditor: "打开编辑器",
			gitDetail: "查看变更详情",
			referenceFile: "@文件",
			addToConversation: "添加到对话",
			copyRelative: "复制相对地址",
			copyAbsolute: "复制绝对地址",
			download: "下载",
			settingsNav: "侧边卡片",
			settingsIntro: "管理侧边卡片的显示内容与默认行为",
			settingsPopupDesc: "为「{feature}」配置相关选项",
			settingsDone: "完成",
			settingsOpenTitle: "新会话默认打开",
			settingsOpenDesc: "新建会话时自动展开侧边卡片；已存在的会话保持各自布局",
			settingsWidthTitle: "默认宽度占比",
			settingsWidthDesc: "新建会话时侧边卡片占窗口宽度的百分比 (20–60)",
			settingsWidthSuffix: "%",
			settingsOpenPathTitle: "聊天区文件在侧边栏打开",
			settingsOpenPathDesc: "在聊天里点击文件链接（工具行、产物列表、文件提及）时，在侧边栏编辑器中打开，不再调用系统默认应用",
			settingsTitleBarTitle: "位置兼容模式",
			settingsTitleBarDesc: "为 Windows 右上角的原生标题栏预留空间：侧边栏按钮与侧边栏内容整体下移，避免被标题栏遮挡",
			settingsTitleBarStripTitle: "下移距离",
			settingsTitleBarStripDesc: "标题栏条带高度：侧边栏按钮与内容下移的像素数（0–120，默认 40）",
			settingsSaveFailed: "保存失败",
			settingsConflict: "设置已被其他窗口修改，请重试",
			binaryNoPreview: "此文件类型不支持预览",
			downloadToView: "下载查看",
			settingsSubagentTitle: "检测到子代理时自动展开任务管理页",
			settingsSubagentDesc: "当前会话产生新的子代理时，自动展开侧边栏并打开任务管理页；关闭后需手动打开",
			settingsJobsTitle: "有新后台任务时自动展开后台任务页",
			settingsJobsDesc: "当前会话出现新的后台任务时，自动展开侧边栏并打开后台任务页（每个新任务都会触发）；关闭后需手动打开",
			settingsToolsTitle: "为模型注入终端工具",
			settingsToolsDesc: "开启后，模型可通过 terminal_create 等 8 个工具创建并操作侧边栏终端（默认关闭）",
			settingsBottomTerminalTitle: "底部面板首次展开自动开终端",
			settingsBottomTerminalDesc: "每次会话中第一次展开底部面板时，尝试在底部面板自动打开一个新终端标签（终端数量上限仍会限制；默认开启）",
			settingsFontFamilyTitle: "终端字体",
			settingsFontFamilyDesc: "自定义终端字体族（CSS font-family，如 \"JetBrains Mono\", monospace；留空跟随主题等宽字体）",
			settingsFontFamilyPlaceholder: "\"JetBrains Mono\", monospace",
			settingsFontSizeTitle: "终端字号",
			settingsFontSizeDesc: "终端字号（9–32，默认 13）",
			settingsFontSizeSuffix: "px",
			settingsTabsTitle: "侧边栏内容",
			settingsViewersTitle: "文件预览",
			settingsGeneralTitle: "常规",
			settingsPopup: "功能设置",
			settingsViewerCatchAll: "兜底：任意文件",
			viewerImage: "图片",
			viewerPdf: "PDF",
			viewerMarkdown: "Markdown",
			viewerCode: "代码",
			viewerBinary: "二进制下载",
			viewerHtml: "HTML",
			browser: "浏览器",
			browserPlaceholder: "输入网址，例如 example.com",
			browserGo: "前往",
			browserBack: "后退",
			browserForward: "前进",
			browserStart: "输入网址开始浏览（沙箱模式）",
			browserBlockedScheme: "已阻止：仅支持 http/https 链接",
			browserBlockedLoopback: "已阻止：不允许在浏览器中访问本机或内部地址",
			browserInvalid: "无效的网址",
			browserNoSandboxWarning: "沙箱已关闭：当前页面与界面同源，拥有完整会话权限（可在设置中恢复）",
			htmlNoSandboxWarning: "沙箱已关闭：此 HTML 与界面同源，可读取会话文件与内部接口（可在设置中恢复）",
			sandboxStatusOn: "沙箱模式：已启用 · 页面无法访问界面数据与本地文件，登录态与第三方 Cookie 可能不可用",
			sandboxUnlock: "临时解锁（不安全）",
			sandboxRestore: "恢复沙箱",
			settingsHtmlDefaultUnsafeTitle: "HTML 预览默认以非沙箱模式打开（不安全）",
			settingsHtmlDefaultUnsafeDesc: "开启后，每次打开 HTML 文件时预览默认处于非沙箱状态（与界面同源，可读取会话文件与内部接口）；可在状态行临时恢复沙箱",
			settingsHtmlSandboxTitle: "关闭 HTML 预览沙箱（不安全）",
			settingsHtmlSandboxDesc: "关闭后，预览的 HTML 将与界面同源运行，可读取会话文件、本地存储并调用内部接口。仅对完全可信的文件开启",
			settingsBrowserSandboxTitle: "关闭浏览器沙箱（不安全）",
			settingsBrowserSandboxDesc: "关闭后，访问的任何网站都将与界面同源运行，可读取会话数据并冒充你的登录状态。仅对完全可信的站点开启",
			settingsBrowserLinksTitle: "聊天区外链在侧边栏打开",
			settingsBrowserLinksDesc: "开启后，点击聊天或界面中的外链时在侧边栏打开，不再弹出新窗口；HTTP 与 HTTPS 可分别通过下方开关控制；Ctrl/Cmd 点击可临时放行",
			settingsBrowserHttpTitle: "侧边打开HTTP网页",
			settingsBrowserHttpDesc: "开启后，点击聊天或界面中的 HTTP 外链时在侧边栏打开（声明了 urlTarget 的插件页面优先）；Ctrl/Cmd 点击可临时放行",
			settingsBrowserHttpsTitle: "侧边打开HTTPS网页",
			settingsBrowserHttpsDesc: "开启后，点击聊天或界面中的 HTTPS 外链时在侧边栏打开。默认关闭：多数 HTTPS 站点拒绝被嵌入，走系统浏览器更顺畅",
			browserOpenExternal: "在浏览器中打开",
			browserEmbedBlocked: "{host} 拒绝了嵌入请求",
			browserEmbedBlockedDesc: "该站点通过 X-Frame-Options / frame-ancestors 禁止在其它页面中显示，无法在侧边栏内加载。可在浏览器中直接打开",
			browserEmbedAnyway: "仍然加载",
			subagent: "任务管理",
			openSubagent: "任务管理",
			subagentMainAgent: "主代理",
			subagentEmpty: "暂无子代理",
			subagentEmptyDesc: "当前主代理派生的子代理将显示在这里",
			subagentRunning: "运行中",
			subagentInactive: "空闲",
			subagentModeOneShot: "一次性",
			subagentModeContinuable: "可续接",
			subagentCount: "{count} 个子代理",
			subagentCountRunning: "{count} 个子代理 · {running} 运行中",
			subagentDiagCorrupt: "目录损坏",
			subagentDiagUnsupported: "不支持的条目",
			subagentDiagUnavailable: "不可用",
			subagentThinking: "思考中…",
			jobs: "后台任务",
			jobsCount: "{count} 个后台任务",
			jobsCountRunning: "{count} 个后台任务 · {running} 运行中",
			jobStatusRunning: "运行中",
			jobStatusStopping: "终止中",
			jobStatusCompleted: "已完成",
			jobStatusKilled: "已终止",
			jobStatusFailed: "失败",
			jobDurationSeconds: "{seconds} 秒",
			jobDurationMinutes: "{minutes} 分 {seconds} 秒",
			jobDurationHours: "{hours} 小时 {minutes} 分",
			jobViewOutput: "查看输出",
			jobHideOutput: "收起输出",
			jobNoOutput: "暂无输出",
			jobNotReadYet: "等待模型读取该任务的输出（模型执行 job_output 后，输出会显示在这里）",
			jobOutputTruncated: "输出过长，已截断显示",
			jobOutputError: "输出读取失败",
			jobKill: "终止",
			jobKillConfirm: "再次点击确认终止",
			jobKillError: "终止失败",
			addPluginsTabCard: "添加 Tab 插件",
			addPluginsTabCardDesc: "注册新的侧边栏页面",
			addPluginsViewerCard: "添加预览插件",
			addPluginsViewerCardDesc: "注册新的文件类型预览",
			addPluginsTabDesc: "侧边栏页面（Tab）可以由插件扩展。插件通过 ctx.betterSidebar 服务注册；点击「安装」复制安装命令，粘贴到 DSH 所在环境的终端执行。",
			addPluginsViewerDesc: "文件预览器可以由插件扩展。插件通过 ctx.betterSidebar 服务注册；点击「安装」复制安装命令，粘贴到 DSH 所在环境的终端执行。",
			addPluginsBrowseMore: "在 GitHub 上浏览更多插件（topic: dsh-better-sidebar）",
			addPluginsRecommended: "推荐插件",
			addPluginsEmpty: "暂未收录插件，欢迎在 GitHub topic 下发布你的插件",
			openPlugin: "跳转",
			copyInstall: "复制安装命令",
			pluginOfficeDesc: "为 better-sidebar 编辑器提供 Office 三件套预览（.docx / .xlsx / .pptx），把重型 Office 渲染库拆出主包、按需安装",
			pluginSentinelDesc: "条件驱动的 agent 唤醒系统：文件/进程/端口/HTTP/命令/webhook 传感器，条件达成自动唤醒休眠会话；注册「哨兵」Tab 展示服务器全局监控表",
			pluginSidebarQaDesc: "基于 better-sidebar 的划选提问tab分页: 对话划选 → 右侧面板提问 → 同工作区独立追问会话（❓追问·主题）：快速无思考模型压缩主对话上下文后与引文一起注入，不打断主对话；追问可嵌套、可继续、可归档"
		};
		/** The en dictionary (key-set-equal to zh, enforced by the type annotation). */
		const en = {
			explorer: "Explorer",
			git: "Source Control",
			terminal: "Terminal",
			editor: "Editor",
			newTab: "New tab",
			openExplorer: "Explorer",
			openGit: "Git panel",
			newTerminal: "New terminal",
			terminalLimit: "Terminal limit reached (3)",
			close: "Close",
			collapse: "Collapse sidebar",
			expand: "Expand sidebar",
			collapseBottomPanel: "Collapse bottom panel",
			expandBottomPanel: "Expand bottom panel",
			terminalError: "Terminal connection failed",
			terminalConnectFailed: "Terminal failed to connect repeatedly",
			terminalRetry: "Retry",
			preview: "Preview",
			edit: "Edit",
			refresh: "Refresh",
			save: "Save",
			saved: "Saved",
			unsaved: "Unsaved",
			saveFailed: "Save failed",
			truncation: "File too large — showing the first 512KB",
			binary: "Binary file, preview unavailable",
			loading: "Loading…",
			error: "Failed to load",
			retry: "Retry",
			splitLeft: "Split left",
			splitRight: "Split right",
			splitUp: "Split up",
			splitDown: "Split down",
			notRepo: "This directory is not a git repository",
			noChanges: "No changes",
			stage: "Stage",
			unstage: "Unstage",
			stageAll: "Stage all",
			unstageAll: "Unstage all",
			commitPlaceholder: "Commit message (Ctrl+Enter)",
			commit: "Commit",
			commitError: "Commit failed",
			branch: "Branch",
			checkoutError: "Branch switch failed",
			history: "History",
			changes: "Changes",
			staged: "Staged",
			unstaged: "Unstaged",
			cancel: "Cancel",
			diffEmpty: "No text changes",
			diffLoadError: "Failed to load diff",
			diffBinary: "Binary",
			diffAdded: "Added",
			diffDeleted: "Deleted",
			diffRenamed: "Renamed",
			diffExpand: "Expand {count} more rows",
			diffCollapse: "Collapse",
			discard: "Discard changes",
			discardTitle: "Discard changes",
			discardDesc: "This discards the worktree changes of \"{path}\" (not recoverable).",
			viewCommitDiff: "View commit diff",
			copyShortHash: "Copy short hash",
			copyFullHash: "Copy full hash",
			copySubject: "Copy subject",
			revertCommit: "Revert commit",
			revertTitle: "Revert commit",
			revertDesc: "Create a new commit on the current branch that reverts \"{subject}\".",
			cherryPickCommit: "Cherry-pick commit",
			cherryPickTitle: "Cherry-pick commit",
			cherryPickDesc: "Apply the changes of \"{subject}\" to the current branch.",
			timeJustNow: "just now",
			timeMinutesAgo: "{n} min ago",
			timeHoursAgo: "{n} h ago",
			timeYesterday: "yesterday",
			loadMore: "Load more",
			historyLoadError: "Failed to load more history",
			produced: "Produced",
			producedOpen: "Open in sidebar",
			disconnected: "Terminal disconnected, reconnecting…",
			exited: "Terminal process exited",
			noSession: "Select a conversation to use the sidebar",
			pluginNotLoaded: "Plugin not loaded; tab unavailable:",
			hiddenFiles: "Hidden files",
			parent: "Parent directory",
			editorBack: "Back",
			copied: "Copied",
			copy: "Copy",
			newFile: "New file",
			openEditor: "Open editor",
			gitDetail: "View change details",
			referenceFile: "@file",
			addToConversation: "Add to conversation",
			copyRelative: "Copy relative path",
			copyAbsolute: "Copy absolute path",
			download: "Download",
			settingsNav: "Side card",
			settingsIntro: "Manage what the side card shows and how it behaves",
			settingsPopupDesc: "Configure related options for {feature}",
			settingsDone: "Done",
			settingsOpenTitle: "Open by default for new conversations",
			settingsOpenDesc: "Expand the side card automatically for brand-new conversations; existing conversations keep their own layouts",
			settingsWidthTitle: "Default width share",
			settingsWidthDesc: "The side card's default share of the window width for new conversations (20–60)",
			settingsWidthSuffix: "%",
			settingsOpenPathTitle: "Open chat files in the sidebar",
			settingsOpenPathDesc: "Open file links in the chat (tool rows, produced files, mentions) in the sidebar editor instead of the system default app",
			settingsTitleBarTitle: "Position compatibility mode",
			settingsTitleBarDesc: "Reserve space for the native Windows title bar at the top-right so the sidebar buttons and content sit below it instead of underneath",
			settingsTitleBarStripTitle: "Shift distance",
			settingsTitleBarStripDesc: "Title-bar strip height: how far the sidebar buttons and content move down in px (0–120, default 40)",
			settingsSaveFailed: "Failed to save",
			settingsConflict: "The setting changed in another window — please retry",
			binaryNoPreview: "This file type cannot be previewed",
			downloadToView: "Download to view",
			settingsSubagentTitle: "Auto-open the Tasks page when a subagent appears",
			settingsSubagentDesc: "Expand the side card and open the Tasks page when the current conversation spawns a new subagent; turn off to open it manually",
			settingsJobsTitle: "Auto-open the Jobs page on a new background job",
			settingsJobsDesc: "Expand the side card and open the Jobs page whenever a new background job appears for the current conversation (every new job triggers); turn off to open it manually",
			settingsToolsTitle: "Inject terminal tools for the model",
			settingsToolsDesc: "When enabled, the model can create and drive sidebar terminals through the 8 terminal_* tools (off by default)",
			settingsBottomTerminalTitle: "Auto-open a terminal on the bottom panel's first expansion",
			settingsBottomTerminalDesc: "When the bottom panel is expanded for the first time in a session, try to open a fresh terminal tab there (the terminal quota still applies; on by default)",
			settingsFontFamilyTitle: "Terminal font family",
			settingsFontFamilyDesc: "Custom terminal font family (a CSS font-family stack like \"JetBrains Mono\", monospace; leave empty to follow the theme's monospace font)",
			settingsFontFamilyPlaceholder: "\"JetBrains Mono\", monospace",
			settingsFontSizeTitle: "Terminal font size",
			settingsFontSizeDesc: "Terminal font size in px (9–32, default 13)",
			settingsFontSizeSuffix: "px",
			settingsTabsTitle: "Sidebar content",
			settingsViewersTitle: "File viewers",
			settingsGeneralTitle: "General",
			settingsPopup: "Feature settings",
			settingsViewerCatchAll: "Catch-all: any file",
			viewerImage: "Image",
			viewerPdf: "PDF",
			viewerMarkdown: "Markdown",
			viewerCode: "Code",
			viewerBinary: "Binary download",
			viewerHtml: "HTML",
			browser: "Browser",
			browserPlaceholder: "Enter a URL, e.g. example.com",
			browserGo: "Go",
			browserBack: "Back",
			browserForward: "Forward",
			browserStart: "Enter a URL to start browsing (sandbox mode)",
			browserBlockedScheme: "Blocked: only http/https URLs are allowed",
			browserBlockedLoopback: "Blocked: local and internal addresses cannot be browsed here",
			browserInvalid: "Invalid URL",
			browserNoSandboxWarning: "Sandbox off: the current page runs with full GUI privileges (re-enable in settings)",
			htmlNoSandboxWarning: "Sandbox off: this HTML runs with full GUI privileges (re-enable in settings)",
			sandboxStatusOn: "Sandbox mode: on · pages cannot access the GUI's data or local files; logins and third-party cookies may not work",
			sandboxUnlock: "Temporarily disable (unsafe)",
			sandboxRestore: "Restore sandbox",
			settingsHtmlDefaultUnsafeTitle: "Open HTML previews unsandboxed by default (unsafe)",
			settingsHtmlDefaultUnsafeDesc: "When on, every newly opened HTML preview starts in the unsandboxed state (same origin as the GUI — it can read session files and internal APIs); the status row still offers a one-tap restore",
			settingsHtmlSandboxTitle: "Disable HTML preview sandbox (unsafe)",
			settingsHtmlSandboxDesc: "With the sandbox off, previewed HTML runs with the same origin as the GUI: it can read session files, local storage and call internal APIs. Only enable for fully trusted files",
			settingsBrowserSandboxTitle: "Disable browser sandbox (unsafe)",
			settingsBrowserSandboxDesc: "With the sandbox off, any visited site runs with the same origin as the GUI: it can read session data and act as your logged-in session. Only enable for fully trusted sites",
			settingsBrowserLinksTitle: "Open chat external links in the sidebar",
			settingsBrowserLinksDesc: "When on, clicking an external link in the chat or GUI opens the sidebar instead of a new window; HTTP and HTTPS are controlled separately by the switches below; Ctrl/Cmd+click always bypasses",
			settingsBrowserHttpTitle: "Open HTTP pages in the sidebar",
			settingsBrowserHttpDesc: "When on, clicking an HTTP external link in the chat or GUI opens the sidebar (plugin pages declaring urlTarget win); Ctrl/Cmd+click always bypasses",
			settingsBrowserHttpsTitle: "Open HTTPS pages in the sidebar",
			settingsBrowserHttpsDesc: "When on, clicking an HTTPS external link in the chat or GUI opens the sidebar. Off by default: most HTTPS sites refuse to be embedded, so the system browser is the smoother default",
			browserOpenExternal: "Open in browser",
			browserEmbedBlocked: "{host} refused to be embedded",
			browserEmbedBlockedDesc: "The site forbids being displayed inside other pages (X-Frame-Options / frame-ancestors), so it cannot load in the sidebar. Open it directly in your browser instead.",
			browserEmbedAnyway: "Load anyway",
			subagent: "Tasks",
			openSubagent: "Tasks",
			subagentMainAgent: "Main agent",
			subagentEmpty: "No subagents",
			subagentEmptyDesc: "Subagents spawned under the main agent will appear here",
			subagentRunning: "Running",
			subagentInactive: "Inactive",
			subagentModeOneShot: "One-shot",
			subagentModeContinuable: "Continuable",
			subagentCount: "{count} subagents",
			subagentCountRunning: "{count} subagents · {running} running",
			subagentDiagCorrupt: "Corrupt",
			subagentDiagUnsupported: "Unsupported",
			subagentDiagUnavailable: "Unavailable",
			subagentThinking: "Thinking…",
			jobs: "Background jobs",
			jobsCount: "{count} background jobs",
			jobsCountRunning: "{count} background jobs · {running} running",
			jobStatusRunning: "Running",
			jobStatusStopping: "Stopping",
			jobStatusCompleted: "Completed",
			jobStatusKilled: "Killed",
			jobStatusFailed: "Failed",
			jobDurationSeconds: "{seconds}s",
			jobDurationMinutes: "{minutes}m {seconds}s",
			jobDurationHours: "{hours}h {minutes}m",
			jobViewOutput: "View output",
			jobHideOutput: "Hide output",
			jobNoOutput: "No output yet",
			jobNotReadYet: "Waiting for the model to read this job; its output appears here once the model runs job_output",
			jobOutputTruncated: "Output truncated",
			jobOutputError: "Failed to read output",
			jobKill: "Kill",
			jobKillConfirm: "Click again to confirm kill",
			jobKillError: "Kill failed",
			addPluginsTabCard: "Add tab plugins",
			addPluginsTabCardDesc: "Register a new sidebar page",
			addPluginsViewerCard: "Add preview plugins",
			addPluginsViewerCardDesc: "Register a file-type preview",
			addPluginsTabDesc: "Sidebar pages (tabs) can be extended by plugins. Plugins register through the ctx.betterSidebar service; clicking Install copies the install command — paste it into a terminal where your DSH profile lives and run it.",
			addPluginsViewerDesc: "File previewers can be extended by plugins. Plugins register through the ctx.betterSidebar service; clicking Install copies the install command — paste it into a terminal where your DSH profile lives and run it.",
			addPluginsBrowseMore: "Browse more plugins on GitHub (topic: dsh-better-sidebar)",
			addPluginsRecommended: "Recommended plugins",
			addPluginsEmpty: "No plugins curated yet — publish yours under the GitHub topic",
			openPlugin: "Open",
			copyInstall: "Copy install command",
			pluginOfficeDesc: "Office-suite preview (.docx / .xlsx / .pptx) for the better-sidebar editor, keeping the heavy Office render libraries out of the core bundle",
			pluginSentinelDesc: "Condition-driven agent wakeup: file/process/port/http/command/webhook sensors wake dormant sessions when conditions fire; registers a \"Sentinel\" tab with the server-wide watch table",
			pluginSidebarQaDesc: "Select-and-ask: Select conversation text → ask in the right-side panel → a dedicated follow-up session (❓追问) in the same workspace; a fast no-thinking model compresses the main context and injects it with the quote, without interrupting the main conversation. Follow-ups nest, continue, and archive"
		};
		/**
		* The dictionary namespace this plugin owns in the DSH locale registry
		* (`'sidebar'` is taken by DSH's own ui-sidebar, hence this distinct name).
		*/
		const LOCALE_NS = "betterSidebar";
		/** The DSH locale service attached by the client apply (absent → browser detection). */
		let localeService;
		/**
		* Attach (or detach, with undefined) the DSH locale service. The sidebar
		* mounts its own React root outside the slot system's locale seat, so the
		* service rides this module-level holder: components keep calling the plain
		* `t()` function, and the Sidebar root's locale subscription re-renders the
		* whole tree on switches.
		*/
		function attachLocale(service) {
			localeService = service;
		}
		/**
		* The active locale id ('zh' | 'en'): the DSH locale service's snapshot when
		* attached, else the browser language.
		*/
		function activeLocale() {
			return localeService?.getSnapshot().active ?? (typeof navigator !== "undefined" ? navigator.language : "") ?? "en";
		}
		/** Translate a copy key; `{name}` placeholders interpolate from `params`. */
		function t(key, params) {
			let text = (activeLocale().toLowerCase().startsWith("zh") ? zh : en)[key];
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
			return text;
		}
		/** Format an ISO 8601 author date relative to now (刚刚 / N 分钟前 / N 小时前 / 昨天 / date). */
		function relativeTime(iso) {
			const then = Date.parse(iso);
			if (Number.isNaN(then)) return iso;
			const seconds = Math.floor((Date.now() - then) / 1e3);
			if (seconds < 60) return t("timeJustNow");
			if (seconds < 3600) return t("timeMinutesAgo", { n: Math.floor(seconds / 60) });
			if (seconds < 86400) return t("timeHoursAgo", { n: Math.floor(seconds / 3600) });
			if (seconds < 172800) return t("timeYesterday");
			const date = new Date(then);
			const pad = (value) => String(value).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
		}
		//#endregion
		//#region src/client/produced-files.ts
		/**
		* Pure derivation of one turn's produced files from finalized conversation
		* nodes — a structural replica of ui-deliverables' `producedForClosing`
		* (the mutation tools' follow-along `locations`, by render intent: a diff
		* card or a generic edit card; reads/deletes/failures produce nothing).
		* Kept dependency-free so the takeover logic is unit-testable and the
		* replica is easy to diff against upstream when it drifts.
		*/
		/** Paths a tool-result view reports as produced, by render intent. */
		function producedPaths(view) {
			if (view === null || typeof view !== "object") return [];
			const record = view;
			if (!(record.card === "diff" || record.card === "generic" && record.kind === "edit")) return [];
			if (!Array.isArray(record.locations)) return [];
			const paths = [];
			for (const location of record.locations) if (location !== null && typeof location === "object" && typeof location.path === "string") paths.push(location.path);
			return paths;
		}
		/**
		* Files produced by the turn the assistant at `seq` closes. Accumulation
		* resets on turn boundaries (a user message, or a node reporting a different
		* turn number); paths keep first-seen order and appear once.
		* @param nodes - snapshot nodes in surface order (structural, unknown-safe).
		* @param seq - the closing assistant's seq (the render site's anchor).
		* @returns produced paths; empty when the turn wrote nothing.
		*/
		function producedForClosing(nodes, seq) {
			let pending = [];
			let seen = /* @__PURE__ */ new Set();
			let turn;
			for (const node of nodes) {
				if (node === null || typeof node !== "object") continue;
				const record = node;
				if (record.kind === "tool-result") {
					if (record.isError === true) continue;
					for (const path of producedPaths(record.callView)) {
						if (seen.has(path)) continue;
						seen.add(path);
						pending.push(path);
					}
					continue;
				}
				if (record.kind === "user") {
					turn = void 0;
					pending = [];
					seen = /* @__PURE__ */ new Set();
				} else if (typeof record.turn === "number") {
					if (turn !== void 0 && record.turn !== turn) {
						pending = [];
						seen = /* @__PURE__ */ new Set();
					}
					turn = record.turn;
				}
				if (record.kind === "assistant" && record.seq === seq) return pending;
			}
			return [];
		}
		/**
		* Claim the turn-tail chain only when the closing turn produced files.
		* @param owner - the turn-tail owner currency ({nodes, seq}).
		* @returns produced paths as the matched value, or null to decline.
		*/
		function selectProducedFiles(owner) {
			const record = owner;
			if (record === null || typeof record !== "object") return null;
			if (!Array.isArray(record.nodes) || typeof record.seq !== "number") return null;
			const paths = producedForClosing(record.nodes, record.seq);
			return paths.length === 0 ? null : paths;
		}
		/** Resolve a (possibly relative) path against the session cwd for the sidebar. */
		function resolveSidebarPath(cwd, path) {
			if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
			const base = cwd ?? "";
			if (base === "") return path;
			const separator = base.includes("\\") ? "\\" : "/";
			return `${base.replace(/[\\/]+$/, "")}${separator}${path}`;
		}
		//#endregion
		//#region src/client/openpath-intercept.ts
		/**
		* Wrap `workspaces.openPath`: intercepted calls open the file in the sidebar
		* editor instead of the Host OS and resolve as success (the original's
		* callers ignore the result); anything that declines falls through to the
		* original method untouched.
		* @param workspaces - the client workspaces service to wrap.
		* @param deps - per-call takeover decisions.
		* @returns the disposer restoring the original method (HMR-safe).
		*/
		function wrapOpenPath(workspaces, deps) {
			const original = workspaces.openPath;
			workspaces.openPath = (path) => {
				if (deps.takeoverEnabled()) {
					const sessionId = deps.currentSessionId();
					if (sessionId !== void 0) {
						deps.openInSidebar(path, sessionId);
						return Promise.resolve();
					}
				}
				return original.call(workspaces, path);
			};
			return () => {
				workspaces.openPath = original;
			};
		}
		//#endregion
		//#region \0dsh-css:C:\Users\delinger\Desktop\dsh\_upstream2\DSH-better-sidebar\src\client\sidebar.module.css.mjs
		const css$3 = ".dxPSYW_toggleCluster{z-index:55;flex-direction:row;gap:4px;display:flex;position:fixed;top:3px;right:10px}.dxPSYW_panel:not(.dxPSYW_panelHidden) .dxPSYW_tabBar{padding-right:72px}.dxPSYW_toggleButton{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background var(--ds-transition-duration-slow) var(--ds-ease-in-out), color var(--ds-transition-duration-slow) var(--ds-ease-in-out);background:0 0;border:none;border-radius:50%;justify-content:center;align-items:center;display:flex}.dxPSYW_toggleButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_toggleButton:disabled{opacity:.4;cursor:default}.dxPSYW_panel{z-index:50;background:var(--dsw-specific-sidebar-fill);border-left:1px solid var(--dsw-alias-border-l2);transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out), width var(--ds-transition-duration-slow) var(--ds-ease-in-out);flex-direction:column;display:flex;position:fixed;top:0;bottom:0;right:0}.dxPSYW_panelHidden{pointer-events:none;visibility:hidden;transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out), width var(--ds-transition-duration-slow) var(--ds-ease-in-out), visibility 0s linear var(--ds-transition-duration-slow);transform:translate(102%)}.dxPSYW_panel[data-dragging]{transition:none}.dxPSYW_panelResize{cursor:col-resize;z-index:2;touch-action:none;width:8px;position:absolute;top:0;bottom:0;left:-4px}.dxPSYW_panelResizeActive{background:var(--dsw-alias-interactive-bg-hover-accent)}.dxPSYW_panelBody{flex:1;min-width:0;min-height:0;display:flex}.dxPSYW_bottomPanel{z-index:50;background:var(--dsw-specific-sidebar-fill);border-top:1px solid var(--dsw-alias-border-l2);transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out), height var(--ds-transition-duration-slow) var(--ds-ease-in-out);flex-direction:column;display:flex;position:fixed;bottom:0}.dxPSYW_bottomPanelHidden{pointer-events:none;visibility:hidden;transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out), height var(--ds-transition-duration-slow) var(--ds-ease-in-out), visibility 0s linear var(--ds-transition-duration-slow);transform:translateY(102%)}.dxPSYW_bottomPanel[data-dragging]{transition:none}.dxPSYW_bottomResize{cursor:row-resize;z-index:2;touch-action:none;height:8px;position:absolute;top:-4px;left:0;right:0}.dxPSYW_bottomResizeActive{background:var(--dsw-alias-interactive-bg-hover-accent)}.dxPSYW_bottomClose{z-index:4;width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;top:3px;right:6px}.dxPSYW_bottomClose:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_bottomPanel .dxPSYW_tabBar{padding-right:40px}body[data-dsh-title-bar-compat] .dxPSYW_toggleCluster{top:calc(var(--dsh-title-bar-strip,40px) + 3px)}body[data-dsh-title-bar-compat] .dxPSYW_panel{padding-top:var(--dsh-title-bar-strip,40px)}.dxPSYW_cornerHandle{z-index:52;cursor:nwse-resize;touch-action:none;width:12px;height:12px;position:fixed}.dxPSYW_cornerHandle:hover,.dxPSYW_cornerHandle[data-dragging]{background:var(--dsw-alias-interactive-bg-hover-accent)}.dxPSYW_iconButton{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dxPSYW_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_iconButton:disabled{opacity:.4;cursor:default}.dxPSYW_workbench,.dxPSYW_split{flex:1;min-width:0;min-height:0;display:flex}.dxPSYW_splitRow{flex-direction:row}.dxPSYW_splitCol{flex-direction:column}.dxPSYW_splitChild{display:flex;position:relative;overflow:hidden}.dxPSYW_divider{z-index:3;touch-action:none;flex:none;position:relative}.dxPSYW_dividerRow:after,.dxPSYW_dividerCol:after{content:\"\";background:var(--dsw-alias-border-l2);transition:background var(--ds-transition-duration-slow) var(--ds-ease-in-out);position:absolute}.dxPSYW_dividerRow{cursor:col-resize;width:7px;margin:0 -2px}.dxPSYW_dividerRow:after{width:1px;top:0;bottom:0;left:50%;transform:translate(-50%)}.dxPSYW_dividerCol{cursor:row-resize;height:7px;margin:-2px 0}.dxPSYW_dividerCol:after{height:1px;top:50%;left:0;right:0;transform:translateY(-50%)}.dxPSYW_divider:hover:after,.dxPSYW_dividerActive:after{background:var(--dsw-alias-interactive-bg-hover-accent)}.dxPSYW_pane{background:var(--dsw-alias-bg-base);flex-direction:column;flex:1;min-width:0;min-height:0;display:flex;position:relative}.dxPSYW_paneDrop{outline:1px solid var(--dsw-alias-interactive-bg-hover-accent);outline-offset:-1px}.dxPSYW_dropOverlay{z-index:6;pointer-events:none;background:var(--dsw-alias-interactive-bg-hover-accent);opacity:.5;position:absolute}.dxPSYW_dropLeft{width:25%;top:0;bottom:0;left:0}.dxPSYW_dropRight{width:25%;top:0;bottom:0;right:0}.dxPSYW_dropUp{height:25%;top:0;left:0;right:0}.dxPSYW_dropDown{height:25%;bottom:0;left:0;right:0}.dxPSYW_dropCenter{outline:2px dashed var(--dsw-alias-interactive-bg-hover-accent);outline-offset:-2px;background:0 0;inset:25%}.dxPSYW_paneContent{flex-direction:column;flex:1;min-height:0;display:flex;overflow:hidden}.dxPSYW_paneTab{flex-direction:column;flex:1;min-height:0;display:flex}.dxPSYW_paneTabHidden{display:none}.dxPSYW_paneEmptyCards{flex:1;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));align-content:start;gap:8px;min-height:0;padding:12px;display:grid;overflow:hidden}.dxPSYW_paneCard{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-width:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-strong-12);cursor:pointer;text-align:center;border-radius:8px;flex-direction:column;justify-content:center;align-items:center;gap:6px;padding:12px 8px;display:flex}.dxPSYW_paneCard:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}.dxPSYW_paneCard:disabled{opacity:.45;cursor:default}.dxPSYW_tabBar{border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none;align-items:stretch;height:34px;display:flex}.dxPSYW_tabBarDrop{outline:1px dashed var(--dsw-alias-interactive-bg-hover-accent);outline-offset:-1px}.dxPSYW_tabList{scrollbar-width:none;flex:1;min-width:0;display:flex;overflow-x:auto}.dxPSYW_tabList::-webkit-scrollbar{display:none}.dxPSYW_tab{min-width:64px;max-width:160px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);border-right:1px solid var(--dsw-alias-border-l1);cursor:pointer;user-select:none;background:0 0;flex:none;align-items:center;gap:4px;padding:0 4px 0 10px;display:flex}.dxPSYW_tab:hover{background:var(--dsw-alias-interactive-bg-hover)}.dxPSYW_tabActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active)}.dxPSYW_tabTitle{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}.dxPSYW_tabBadge{min-width:16px;height:15px;font:var(--dsw-font-xxxs-strong-11);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary);border-radius:8px;flex:none;justify-content:center;align-items:center;padding:0 4px;display:inline-flex}.dxPSYW_tabClose{width:18px;height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dxPSYW_tabClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_tabBarPlus{background:var(--dsw-alias-bg-layer-1);width:22px;height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer;border:none;border-radius:5px;flex:none;justify-content:center;align-self:center;align-items:center;margin:0 6px;padding:0;display:inline-flex;position:sticky;right:0}.dxPSYW_tabBarPlus:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_explorer{flex-direction:column;flex:1;min-height:0;display:flex}.dxPSYW_explorerHeader{flex:none;justify-content:space-between;align-items:center;gap:8px;height:36px;padding:0 8px 0 12px;display:flex}.dxPSYW_explorerRoot{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dxPSYW_explorerBody{flex:1;min-height:0;padding:2px 6px 8px;overflow-y:auto}.dxPSYW_explorerRow{width:100%;height:34px;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;white-space:nowrap;animation:dxPSYW_dsh-row-in .15s var(--ds-ease-in-out);background:0 0;border:none;border-radius:8px;align-items:center;gap:6px;padding:0 8px;display:flex}.dxPSYW_explorerRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.dxPSYW_explorerDir{font:var(--dsw-font-s-strong-14)}.dxPSYW_explorerHidden{opacity:.45}.dxPSYW_explorerName{text-overflow:ellipsis;overflow:hidden}.dxPSYW_explorerRef{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);height:20px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-strong-11);cursor:pointer;border-radius:999px;flex:none;align-items:center;padding:0 8px;display:none}.dxPSYW_explorerRef:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_explorerRow:hover .dxPSYW_explorerRef,.dxPSYW_explorerRow:focus-within .dxPSYW_explorerRef{display:inline-flex}.dxPSYW_explorerCopied{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);flex:none}.dxPSYW_explorerError{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);cursor:default}@keyframes dxPSYW_dsh-row-in{0%{opacity:0}}.dxPSYW_explorerEmpty{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);text-align:center;padding:16px}.dxPSYW_editor{flex-direction:column;flex:1;min-height:0;display:flex}.dxPSYW_editorHeader{border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;align-items:center;gap:6px;padding:4px 8px;display:flex}.dxPSYW_editorBack{width:22px;height:22px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;justify-content:center;align-items:center;display:inline-flex;padding:0}.dxPSYW_editorBack:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_editorTitle{min-width:0;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}.dxPSYW_editorStatus{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}.dxPSYW_editorStatusError{color:var(--dsw-alias-state-error-primary)}.dxPSYW_dirtyDot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;flex:none;width:7px;height:7px}.dxPSYW_editorPlaceholder{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);text-align:center;flex:1;justify-content:center;align-items:center;padding:16px;display:flex}.dxPSYW_orphanedType{opacity:.7;overflow-wrap:anywhere;margin-top:8px;font-size:12px;display:block}.dxPSYW_editorBinary{text-align:center;flex-direction:column;flex:1;justify-content:center;align-items:center;gap:12px;padding:24px 16px;display:flex}.dxPSYW_editorBinaryNotice{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}.dxPSYW_editorDownloadLink{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer;transition:background var(--ds-transition-duration-slow) var(--ds-ease-in-out), border-color var(--ds-transition-duration-slow) var(--ds-ease-in-out);border-radius:6px;align-items:center;gap:6px;padding:6px 14px;text-decoration:none;display:inline-flex}.dxPSYW_editorDownloadLink:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}.dxPSYW_editorError{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);padding:12px 16px}.dxPSYW_editorBanner{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);flex:none;padding:4px 12px}.dxPSYW_sandboxStatus{font:var(--dsw-font-xxxs-11);flex:none;align-items:center;gap:8px;padding:4px 10px;display:flex}.dxPSYW_sandboxStatusOn{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}.dxPSYW_sandboxStatusOff{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)}.dxPSYW_sandboxDot{background:var(--dsw-alias-state-success-primary);border-radius:50%;flex:none;width:6px;height:6px}.dxPSYW_sandboxStatusOff .dxPSYW_sandboxDot{background:var(--dsw-alias-state-error-primary)}.dxPSYW_sandboxStatusText{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}.dxPSYW_sandboxAction{border:1px solid var(--dsw-alias-border-l2);font:inherit;color:inherit;cursor:pointer;background:0 0;border-radius:6px;flex:none;padding:2px 8px}.dxPSYW_sandboxAction:hover{background:var(--dsw-alias-interactive-bg-hover)}.dxPSYW_editorHtml{background:var(--dsw-alias-bg-base);border:none;flex:1;width:100%;min-height:0}.dxPSYW_browser{flex-direction:column;flex:1;min-height:0;display:flex}.dxPSYW_browserBar{border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;align-items:center;gap:4px;padding:6px 8px;display:flex}.dxPSYW_browserInput{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-width:0;height:28px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);border-radius:6px;flex:1;padding:0 10px}.dxPSYW_browserInput:focus{border-color:var(--dsw-alias-border-l2);outline:none}.dxPSYW_browserMessage{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);flex:none;padding:4px 12px}.dxPSYW_browserFrame{background:var(--dsw-alias-bg-base);border:none;flex:1;width:100%;min-height:0}.dxPSYW_browserStart{text-align:center;min-height:0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);flex:1;justify-content:center;align-items:center;padding:20px;display:flex}.dxPSYW_browserBlocked{text-align:center;min-height:0;color:var(--dsw-alias-state-warn-primary);flex-direction:column;flex:1;justify-content:center;align-items:center;gap:6px;padding:24px;display:flex}.dxPSYW_browserBlockedTitle{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary)}.dxPSYW_browserBlockedDesc{max-width:280px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary)}.dxPSYW_browserBlockedActions{gap:8px;margin-top:6px;display:flex}.dxPSYW_browserBlockedButton{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxxs-11);cursor:pointer;border-radius:6px;padding:4px 12px}.dxPSYW_browserBlockedButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.dxPSYW_editorCm{background:0 0;flex:1;min-height:0;overflow:hidden}.dxPSYW_editorCmHidden{display:none}.dxPSYW_editorCm .cm-editor{height:100%}.dxPSYW_editorCm .cm-editor.cm-focused{outline:none}.dxPSYW_editorModeToggle{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:6px;flex:none;align-items:center;gap:2px;padding:2px;display:inline-flex}.dxPSYW_editorModeButton{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);cursor:pointer;background:0 0;border:none;border-radius:4px;padding:2px 8px}.dxPSYW_editorModeButton:hover{color:var(--dsw-alias-label-primary)}.dxPSYW_editorModeActive{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.dxPSYW_editorImageWrap{flex:1;justify-content:center;align-items:center;min-height:0;padding:12px;display:flex;overflow:auto}.dxPSYW_editorImage{object-fit:contain;max-width:100%;max-height:100%}.dxPSYW_editorMd{min-height:0;font:var(--dsw-font-xs-13);flex:1;padding:10px 14px;overflow-y:auto}.dxPSYW_selectionPopup{z-index:60;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);height:28px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxxs-strong-11);white-space:nowrap;cursor:pointer;border-radius:6px;align-items:center;padding:0 10px;display:inline-flex;position:fixed;transform:translate(-50%,calc(-100% - 8px))}.dxPSYW_selectionPopup:hover{background:var(--dsw-alias-interactive-bg-hover)}.dxPSYW_editorPdf{background:var(--dsw-alias-bg-base);flex-direction:column;flex:1;min-height:0;display:flex}.dxPSYW_editorPdfToolbar{border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;justify-content:flex-end;padding:6px 8px;display:flex}.dxPSYW_editorPdfStage{flex:1;min-height:0;display:flex;position:relative}.dxPSYW_editorPdfFrame{background:var(--dsw-alias-bg-base);border:none;flex:1;width:100%;min-height:0}.dxPSYW_editorPdfFrameBlocked{pointer-events:none}.dxPSYW_editorPdfDragShield{z-index:4;pointer-events:none;background:0 0;position:absolute;inset:0}.dxPSYW_editorPdfDragShieldActive{pointer-events:auto}body[data-dsh-tab-dragging] .dxPSYW_editorPdfFrame{pointer-events:none!important}body[data-dsh-tab-dragging] .dxPSYW_editorPdfDragShield{pointer-events:auto!important}.dxPSYW_terminalWrap{background:var(--dsw-alias-bg-base);flex-direction:column;flex:1;min-height:0;display:flex;position:relative}.dxPSYW_terminal{flex:1;min-height:0;padding:6px 4px 6px 8px}.dxPSYW_terminal .xterm{height:100%}.dxPSYW_terminalBanner{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);flex-wrap:wrap;flex:none;align-items:center;gap:8px;padding:3px 10px;display:flex}.dxPSYW_terminalBannerUrl{word-break:break-all;opacity:.85;flex-basis:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.dxPSYW_boundaryError{z-index:50;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);flex-direction:column;align-items:flex-start;gap:8px;padding:16px;display:flex;position:fixed;top:0;bottom:0;right:0;overflow:auto}.dxPSYW_terminalRetry{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-strong-11);cursor:pointer;border-radius:999px;flex:none;padding:1px 8px}.dxPSYW_terminalRetry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_tabBoundaryError{min-height:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);flex-direction:column;flex:1;align-items:flex-start;gap:8px;padding:12px 16px;display:flex;overflow:auto}.dxPSYW_git{flex-direction:column;flex:1;min-width:0;min-height:0;display:flex;overflow:hidden auto}.dxPSYW_gitHeader{flex:none;align-items:center;gap:8px;height:36px;padding:0 8px 0 12px;display:flex}.dxPSYW_gitBranchSelect{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);min-width:0;height:26px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);border-radius:6px;flex:1;padding:0 6px}.dxPSYW_gitSection{border-top:1px solid var(--dsw-alias-border-l1)}.dxPSYW_gitSectionHeader{font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-tertiary);text-transform:uppercase;justify-content:space-between;align-items:center;padding:6px 12px 4px;display:flex}.dxPSYW_gitLink{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-brand-primary);cursor:pointer;background:0 0;border:none;padding:0}.dxPSYW_gitLink:hover:not(:disabled){text-decoration:underline}.dxPSYW_gitLink:disabled{opacity:.4;cursor:default}.dxPSYW_gitRow{min-height:34px;animation:dxPSYW_dsh-row-in .15s var(--ds-ease-in-out);border-radius:8px;align-items:center;gap:6px;margin:0 6px;padding:0 8px;display:flex}.dxPSYW_gitRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.dxPSYW_gitRowSelected{background:var(--dsw-alias-interactive-bg-active)}.dxPSYW_gitRowMain{cursor:pointer;text-align:left;background:0 0;border:none;flex:1;align-items:center;gap:8px;min-width:0;padding:3px 0;display:flex}.dxPSYW_gitBadge{width:20px;height:16px;font:var(--dsw-font-xxxs-strong-11);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;justify-content:center;align-items:center;display:inline-flex}.dxPSYW_gitName{text-overflow:ellipsis;white-space:nowrap;min-width:0;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);flex:1;overflow:hidden}.dxPSYW_gitEmpty{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);padding:4px 12px 8px}.dxPSYW_gitPlaceholder{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);text-align:center;padding:16px}.dxPSYW_gitError{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;padding:8px 12px}.dxPSYW_gitDiff{border-top:1px solid var(--dsw-alias-border-l1);padding:8px}.dxPSYW_gitDiffTab{flex-direction:column;flex:1;min-width:0;min-height:0;display:flex;overflow:hidden auto}.dxPSYW_gitDiffTabHeader{border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;align-items:center;gap:8px;height:36px;padding:0 8px 0 12px;display:flex}.dxPSYW_gitDiffTabTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary);flex:1;overflow:hidden}.dxPSYW_gitDiffFile{align-items:baseline;gap:6px;padding:8px 2px 2px;display:flex}.dxPSYW_gitDiffFilePath{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dxPSYW_gitDiffFileOld{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:none;max-width:40%;overflow:hidden}.dxPSYW_gitDiffFileTag{border:1px solid var(--dsw-alias-border-l2);font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:0 6px}.dxPSYW_gitDiffHunk{font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-tertiary);gap:8px;padding:3px 2px;display:flex}.dxPSYW_gitDiffHunkHeader{color:var(--dsw-alias-label-secondary);flex:none}.dxPSYW_gitDiffHunkSection{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dxPSYW_gitDiffLine{font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;overflow-wrap:anywhere;align-items:stretch;min-width:0;line-height:20px;display:flex}.dxPSYW_gitDiffNum{text-align:right;width:36px;color:var(--dsw-alias-label-tertiary);user-select:none;flex:none;padding-right:8px}.dxPSYW_gitDiffCode{flex:1;min-width:0;overflow:visible}.dxPSYW_gitDiffCtx{color:var(--dsw-alias-label-primary)}.dxPSYW_gitDiffDel{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}.dxPSYW_gitDiffAdd{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}.dxPSYW_gitDiffMeta{padding-left:2px}.dxPSYW_gitDiffMetaText{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-style:italic}.dxPSYW_gitDiffExpand{width:100%;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-brand-primary);cursor:pointer;text-align:center;background:0 0;border:none;margin:4px 0;display:block}.dxPSYW_gitDiffExpand:hover{background:var(--dsw-alias-interactive-bg-hover)}.dxPSYW_gitConfirmDesc{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);white-space:pre-wrap;margin:0}.dxPSYW_gitCommit{border-top:1px solid var(--dsw-alias-border-l1);align-items:center;gap:6px;padding:8px 12px;display:flex}.dxPSYW_gitCommitInput{flex:1;min-width:0}.dxPSYW_gitCommitButton{background:var(--dsw-alias-button-primary-fill);height:26px;color:var(--dsw-alias-label-primary-inverted);font:var(--dsw-font-xxs-strong-12);cursor:pointer;border:none;border-radius:6px;flex:none;padding:0 12px}.dxPSYW_gitCommitButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.dxPSYW_gitCommitButton:disabled{opacity:.45;cursor:default}.dxPSYW_gitLogRow{cursor:pointer;border-radius:8px;flex-direction:column;gap:2px;padding:5px 12px;display:flex}.dxPSYW_gitLogRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.dxPSYW_gitLogLine1{align-items:baseline;gap:8px;min-width:0;display:flex}.dxPSYW_gitLogHash{font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-tertiary);flex:none}.dxPSYW_gitLogLine2{flex-wrap:wrap;align-items:center;gap:6px;min-width:0;display:flex}.dxPSYW_gitLogRef{border:1px solid var(--dsw-alias-border-l2);font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-brand-primary);white-space:nowrap;border-radius:999px;flex:none;padding:0 5px}.dxPSYW_gitLogSubject{text-overflow:ellipsis;white-space:nowrap;min-width:0;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);flex:1;overflow:hidden}.dxPSYW_gitLogMeta{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}.dxPSYW_gitLogMore{border:1px solid var(--dsw-alias-border-l2);width:calc(100% - 24px);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border-radius:6px;margin:4px 12px 8px;padding:6px 0;display:block}.dxPSYW_gitLogMore:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_gitLogMore:disabled{opacity:.5;cursor:default}.dxPSYW_producedRow{flex-wrap:wrap;align-items:center;gap:8px;padding:4px 0;display:flex}.dxPSYW_producedLabel{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}.dxPSYW_producedChip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);max-width:200px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;border-radius:999px;align-items:center;gap:4px;padding:2px 8px;display:inline-flex;overflow:hidden}.dxPSYW_producedChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dxPSYW_producedChip span{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dxPSYW_producedMore{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}.dxPSYW_toggleButton:focus-visible,.dxPSYW_bottomClose:focus-visible,.dxPSYW_iconButton:focus-visible,.dxPSYW_tab:focus-visible,.dxPSYW_tabClose:focus-visible,.dxPSYW_tabBarPlus:focus-visible,.dxPSYW_paneCard:focus-visible,.dxPSYW_explorerRow:focus-visible,.dxPSYW_explorerRef:focus-visible,.dxPSYW_gitRowMain:focus-visible,.dxPSYW_gitLink:focus-visible,.dxPSYW_gitCommitButton:focus-visible,.dxPSYW_gitLogRow:focus-visible,.dxPSYW_gitLogMore:focus-visible,.dxPSYW_gitDiffExpand:focus-visible,.dxPSYW_terminalRetry:focus-visible,.dxPSYW_editorModeButton:focus-visible,.dxPSYW_editorDownloadLink:focus-visible,.dxPSYW_editorPptxButton:focus-visible,.dxPSYW_editorDocxZoomRange:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-hover-accent);outline-offset:-1px}@media (prefers-reduced-motion:reduce){.dxPSYW_panel,.dxPSYW_panelHidden,.dxPSYW_bottomPanel,.dxPSYW_bottomPanelHidden,.dxPSYW_toggleCluster,.dxPSYW_toggleButton,.dxPSYW_tab,.dxPSYW_tabBarPlus,.dxPSYW_paneCard,.dxPSYW_explorerRow,.dxPSYW_gitRow,.dxPSYW_divider,.dxPSYW_dividerRow:after,.dxPSYW_dividerCol:after{transition:none;animation:none}}@media (width<=767px){.dxPSYW_panel:not(.dxPSYW_panelHidden) .dxPSYW_tabBar{padding-right:40px}.dxPSYW_tab{min-width:48px;max-width:128px}}";
		const tagId$3 = "dsh-better-sidebar/sidebar.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-better-sidebar";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var sidebar_module_css_default = {
			"dividerActive": "dxPSYW_dividerActive",
			"panelResize": "dxPSYW_panelResize",
			"panelResizeActive": "dxPSYW_panelResizeActive",
			"editorDownloadLink": "dxPSYW_editorDownloadLink",
			"browserBar": "dxPSYW_browserBar",
			"sandboxStatusOff": "dxPSYW_sandboxStatusOff",
			"dividerCol": "dxPSYW_dividerCol",
			"gitHeader": "dxPSYW_gitHeader",
			"dirtyDot": "dxPSYW_dirtyDot",
			"sandboxStatusOn": "dxPSYW_sandboxStatusOn",
			"browserInput": "dxPSYW_browserInput",
			"gitLogHash": "dxPSYW_gitLogHash",
			"editorImage": "dxPSYW_editorImage",
			"gitDiffMetaText": "dxPSYW_gitDiffMetaText",
			"sandboxDot": "dxPSYW_sandboxDot",
			"splitChild": "dxPSYW_splitChild",
			"bottomResize": "dxPSYW_bottomResize",
			"pane": "dxPSYW_pane",
			"tabBadge": "dxPSYW_tabBadge",
			"editorPdfToolbar": "dxPSYW_editorPdfToolbar",
			"gitDiffFilePath": "dxPSYW_gitDiffFilePath",
			"iconButton": "dxPSYW_iconButton",
			"bottomResizeActive": "dxPSYW_bottomResizeActive",
			"bottomClose": "dxPSYW_bottomClose",
			"splitRow": "dxPSYW_splitRow",
			"dropDown": "dxPSYW_dropDown",
			"dropRight": "dxPSYW_dropRight",
			"explorerDir": "dxPSYW_explorerDir",
			"explorerName": "dxPSYW_explorerName",
			"editorPdf": "dxPSYW_editorPdf",
			"gitName": "dxPSYW_gitName",
			"gitLogLine2": "dxPSYW_gitLogLine2",
			"gitDiffHunk": "dxPSYW_gitDiffHunk",
			"gitLogSubject": "dxPSYW_gitLogSubject",
			"browserBlockedActions": "dxPSYW_browserBlockedActions",
			"explorerHeader": "dxPSYW_explorerHeader",
			"gitCommitInput": "dxPSYW_gitCommitInput",
			"tab": "dxPSYW_tab",
			"paneCard": "dxPSYW_paneCard",
			"gitDiffCtx": "dxPSYW_gitDiffCtx",
			"producedChip": "dxPSYW_producedChip",
			"gitEmpty": "dxPSYW_gitEmpty",
			"terminal": "dxPSYW_terminal",
			"tabBarDrop": "dxPSYW_tabBarDrop",
			"editorPdfDragShieldActive": "dxPSYW_editorPdfDragShieldActive",
			"terminalBanner": "dxPSYW_terminalBanner",
			"browser": "dxPSYW_browser",
			"editorTitle": "dxPSYW_editorTitle",
			"gitDiffAdd": "dxPSYW_gitDiffAdd",
			"gitDiffHunkSection": "dxPSYW_gitDiffHunkSection",
			"dropLeft": "dxPSYW_dropLeft",
			"browserMessage": "dxPSYW_browserMessage",
			"orphanedType": "dxPSYW_orphanedType",
			"gitDiffNum": "dxPSYW_gitDiffNum",
			"explorerBody": "dxPSYW_explorerBody",
			"gitPlaceholder": "dxPSYW_gitPlaceholder",
			"paneTabHidden": "dxPSYW_paneTabHidden",
			"editorHeader": "dxPSYW_editorHeader",
			"editorBack": "dxPSYW_editorBack",
			"gitDiffCode": "dxPSYW_gitDiffCode",
			"editorPdfFrame": "dxPSYW_editorPdfFrame",
			"gitCommit": "dxPSYW_gitCommit",
			"dropCenter": "dxPSYW_dropCenter",
			"editorStatusError": "dxPSYW_editorStatusError",
			"tabBarPlus": "dxPSYW_tabBarPlus",
			"browserBlockedDesc": "dxPSYW_browserBlockedDesc",
			"sandboxStatus": "dxPSYW_sandboxStatus",
			"sandboxStatusText": "dxPSYW_sandboxStatusText",
			"terminalRetry": "dxPSYW_terminalRetry",
			"explorerRoot": "dxPSYW_explorerRoot",
			"toggleCluster": "dxPSYW_toggleCluster",
			"gitDiffHunkHeader": "dxPSYW_gitDiffHunkHeader",
			"editorPptxButton": "dxPSYW_editorPptxButton",
			"selectionPopup": "dxPSYW_selectionPopup",
			"panelHidden": "dxPSYW_panelHidden",
			"gitDiffTabHeader": "dxPSYW_gitDiffTabHeader",
			"editorCmHidden": "dxPSYW_editorCmHidden",
			"bottomPanelHidden": "dxPSYW_bottomPanelHidden",
			"panel": "dxPSYW_panel",
			"gitBranchSelect": "dxPSYW_gitBranchSelect",
			"editorPdfStage": "dxPSYW_editorPdfStage",
			"gitRowSelected": "dxPSYW_gitRowSelected",
			"dropUp": "dxPSYW_dropUp",
			"editorBinaryNotice": "dxPSYW_editorBinaryNotice",
			"editorPdfFrameBlocked": "dxPSYW_editorPdfFrameBlocked",
			"paneTab": "dxPSYW_paneTab",
			"explorerRow": "dxPSYW_explorerRow",
			"dropOverlay": "dxPSYW_dropOverlay",
			"editorModeActive": "dxPSYW_editorModeActive",
			"tabBar": "dxPSYW_tabBar",
			"explorerCopied": "dxPSYW_explorerCopied",
			"tabList": "dxPSYW_tabList",
			"workbench": "dxPSYW_workbench",
			"paneEmptyCards": "dxPSYW_paneEmptyCards",
			"gitDiffDel": "dxPSYW_gitDiffDel",
			"panelBody": "dxPSYW_panelBody",
			"gitSection": "dxPSYW_gitSection",
			"gitLogMeta": "dxPSYW_gitLogMeta",
			"gitDiffFile": "dxPSYW_gitDiffFile",
			"editorBanner": "dxPSYW_editorBanner",
			"bottomPanel": "dxPSYW_bottomPanel",
			"gitDiffFileTag": "dxPSYW_gitDiffFileTag",
			"divider": "dxPSYW_divider",
			"explorerEmpty": "dxPSYW_explorerEmpty",
			"editorMd": "dxPSYW_editorMd",
			"gitDiffTabTitle": "dxPSYW_gitDiffTabTitle",
			"gitLogMore": "dxPSYW_gitLogMore",
			"editorBinary": "dxPSYW_editorBinary",
			"editorModeButton": "dxPSYW_editorModeButton",
			"tabTitle": "dxPSYW_tabTitle",
			"tabClose": "dxPSYW_tabClose",
			"gitBadge": "dxPSYW_gitBadge",
			"gitDiff": "dxPSYW_gitDiff",
			"gitDiffLine": "dxPSYW_gitDiffLine",
			"sandboxAction": "dxPSYW_sandboxAction",
			"gitLogLine1": "dxPSYW_gitLogLine1",
			"dsh-row-in": "dxPSYW_dsh-row-in",
			"editor": "dxPSYW_editor",
			"editorModeToggle": "dxPSYW_editorModeToggle",
			"editorError": "dxPSYW_editorError",
			"split": "dxPSYW_split",
			"gitLink": "dxPSYW_gitLink",
			"gitLogRow": "dxPSYW_gitLogRow",
			"editorImageWrap": "dxPSYW_editorImageWrap",
			"explorerRef": "dxPSYW_explorerRef",
			"editorPdfDragShield": "dxPSYW_editorPdfDragShield",
			"browserBlockedTitle": "dxPSYW_browserBlockedTitle",
			"editorDocxZoomRange": "dxPSYW_editorDocxZoomRange",
			"cornerHandle": "dxPSYW_cornerHandle",
			"editorCm": "dxPSYW_editorCm",
			"gitRowMain": "dxPSYW_gitRowMain",
			"browserFrame": "dxPSYW_browserFrame",
			"tabBoundaryError": "dxPSYW_tabBoundaryError",
			"editorStatus": "dxPSYW_editorStatus",
			"explorer": "dxPSYW_explorer",
			"paneContent": "dxPSYW_paneContent",
			"gitDiffFileOld": "dxPSYW_gitDiffFileOld",
			"gitLogRef": "dxPSYW_gitLogRef",
			"dividerRow": "dxPSYW_dividerRow",
			"browserStart": "dxPSYW_browserStart",
			"explorerHidden": "dxPSYW_explorerHidden",
			"browserBlockedButton": "dxPSYW_browserBlockedButton",
			"terminalWrap": "dxPSYW_terminalWrap",
			"git": "dxPSYW_git",
			"gitSectionHeader": "dxPSYW_gitSectionHeader",
			"terminalBannerUrl": "dxPSYW_terminalBannerUrl",
			"paneDrop": "dxPSYW_paneDrop",
			"gitRow": "dxPSYW_gitRow",
			"editorHtml": "dxPSYW_editorHtml",
			"gitError": "dxPSYW_gitError",
			"editorPlaceholder": "dxPSYW_editorPlaceholder",
			"gitDiffMeta": "dxPSYW_gitDiffMeta",
			"producedMore": "dxPSYW_producedMore",
			"boundaryError": "dxPSYW_boundaryError",
			"gitDiffTab": "dxPSYW_gitDiffTab",
			"producedRow": "dxPSYW_producedRow",
			"toggleButton": "dxPSYW_toggleButton",
			"splitCol": "dxPSYW_splitCol",
			"producedLabel": "dxPSYW_producedLabel",
			"gitConfirmDesc": "dxPSYW_gitConfirmDesc",
			"gitCommitButton": "dxPSYW_gitCommitButton",
			"tabActive": "dxPSYW_tabActive",
			"explorerError": "dxPSYW_explorerError",
			"gitDiffExpand": "dxPSYW_gitDiffExpand",
			"browserBlocked": "dxPSYW_browserBlocked"
		};
		//#endregion
		//#region src/client/intercept.tsx
		/**
		* Interception of the chat's produced-files row: the turn-tail chain entry
		* that replaces ui-deliverables' row when the closing turn produced files.
		* The takeover looks identical (same chip row); the chips open the file in
		* the sidebar instead of the host OS. Priority -1 runs before the default-0
		* deliverables entry; when nothing was produced the selector returns null
		* and the original row renders unchanged.
		*/
		/** Open a file in the sidebar's editor (used by the intercepted row and the explorer). */
		function openSidebarFile(ctx, store, sessionId, path) {
			const summary = ctx.sessions.list.getSnapshot().byId[sessionId];
			const absolute = resolveSidebarPath(summary?.cwd, path);
			const at = Math.max(absolute.lastIndexOf("/"), absolute.lastIndexOf("\\"));
			const title = at === -1 ? absolute : absolute.slice(at + 1);
			ctx.betterSidebar?.openTab({
				type: "editor",
				title,
				path: absolute,
				id: `editor:${absolute}`
			});
		}
		/** The intercepted produced-files row (visual twin of the deliverables chips). */
		function SidebarProducedFiles(props) {
			const { matched, openInSidebar } = props;
			const shown = matched.slice(0, 6);
			const hidden = matched.length - shown.length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.producedRow,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: sidebar_module_css_default.producedLabel,
						children: t("produced")
					}),
					shown.map((path) => {
						const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
						const name = at === -1 ? path : path.slice(at + 1);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: sidebar_module_css_default.producedChip,
							title: path,
							onClick: () => {
								openInSidebar(path);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size: 12 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name })]
						}, path);
					}),
					hidden > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: sidebar_module_css_default.producedMore,
						children: ["+", hidden]
					})
				]
			});
		}
		/**
		* Register the turn-tail interception (returns the disposer).
		*
		* The slot is a CHILD slot the host's ui-conversation declares in its
		* `conversation.chat.node` children table (kind: chain, scope: session).
		* Registering it directly races the declaration — the ui-slots core's
		* load-time validation throws "not declared (a parent entry's children
		* table must declare it)" when the parent entry is not on the ledger yet.
		* slots.inject waits for the declaration: the callback runs synchronously
		* when the slot is already declared, otherwise it runs inside the declaring
		* register() call once the declaration commits; declaration collapse
		* disposes the entry and a later declaration re-registers it. This mirrors
		* @deepseek-ai/dsh-client-ui-deliverables' registration of the same slot.
		*/
		function registerTurnTailInterception(ctx, store) {
			return ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				select: (owner) => {
					if (store.getPrefs().tabsEnabled["editor"] === false) return null;
					return selectProducedFiles(owner);
				},
				priority: -1,
				registrant: "dsh-better-sidebar",
				inject: (sessionId) => ({ openInSidebar: (path) => {
					openSidebarFile(ctx, store, sessionId, path);
				} })
			}, SidebarProducedFiles));
		}
		/**
		* Register the chat file-open interception: wraps `ctx.workspaces.openPath`
		* — the single funnel every chat-side file open goes through (tool-row path
		* links, the produced-files row, prose mentions) — so opens land in the
		* sidebar editor instead of the Host OS. Gated by BOTH the `interceptOpenPath`
		* pref and the editor tab's enable switch; declined opens fall through to
		* the original method. Returns the disposer restoring the original (HMR-safe).
		*/
		function registerOpenPathInterception(ctx, store) {
			return wrapOpenPath(ctx.workspaces, {
				takeoverEnabled: () => store.getPrefs().interceptOpenPath !== false && store.getPrefs().tabsEnabled["editor"] !== false,
				currentSessionId: () => ctx.sessions.list.getSnapshot().current,
				openInSidebar: (path, sessionId) => {
					openSidebarFile(ctx, store, sessionId, path);
				}
			});
		}
		//#endregion
		//#region node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region src/client/api.ts
		/** One wire failure. */
		var SidebarApiError = class extends Error {
			code;
			constructor(code, message) {
				super(message);
				this.code = code;
			}
		};
		async function call(method, payload, signal) {
			let response;
			try {
				response = await fetch(`/sidebar/api/${method}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					signal
				});
			} catch (error) {
				throw new SidebarApiError("network", error instanceof Error ? error.message : String(error));
			}
			const parsed = await response.json().catch(() => null);
			if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === void 0) throw new SidebarApiError(parsed?.error?.code ?? "http", parsed?.error?.message ?? `HTTP ${response.status}`);
			return parsed.value;
		}
		/** Fold a scope into a JSON payload ({cwd} only when present). */
		function scopePayload(scope, extra) {
			return {
				sessionId: scope.sessionId,
				...scope.cwd !== void 0 && scope.cwd !== "" ? { cwd: scope.cwd } : {},
				...extra
			};
		}
		/** The sidebar API surface (session scope threaded through every call). */
		const api = {
			sessionCwd: (scope, signal) => call("session.cwd", scopePayload(scope, {}), signal),
			fsTree: (scope, path, signal) => call("fs.tree", scopePayload(scope, { path }), signal),
			fsRead: (scope, path, signal) => call("fs.read", scopePayload(scope, { path }), signal),
			fsWrite: (scope, path, content) => call("fs.write", scopePayload(scope, {
				path,
				content
			})),
			gitStatus: (scope, signal) => call("git.status", scopePayload(scope, {}), signal),
			gitDiff: (scope, path, staged, signal) => call("git.diff", scopePayload(scope, {
				...path !== void 0 ? { path } : {},
				staged
			}), signal),
			gitStage: (scope, path) => call("git.stage", scopePayload(scope, { ...path !== void 0 ? { path } : {} })),
			gitUnstage: (scope, path) => call("git.unstage", scopePayload(scope, { ...path !== void 0 ? { path } : {} })),
			gitCommit: (scope, message) => call("git.commit", scopePayload(scope, { message })),
			gitBranch: (scope, signal) => call("git.branch", scopePayload(scope, {}), signal),
			gitCheckout: (scope, branch) => call("git.checkout", scopePayload(scope, { branch })),
			/** Recent commit history, lazily pageable (skip/count; defaults 0/30). */
			gitLog: (scope, count, skip, signal) => call("git.log", scopePayload(scope, {
				...count !== void 0 ? { count } : {},
				...skip !== void 0 ? { skip } : {}
			}), signal),
			/** Full patch text of one commit (diff display for the history rows). */
			gitCommitDiff: (scope, hash, signal) => call("git.commit-diff", scopePayload(scope, { hash }), signal),
			/** Discard the worktree changes of one file (the index is untouched). */
			gitDiscard: (scope, path) => call("git.discard", scopePayload(scope, { path })),
			/** Revert one commit onto the current branch. */
			gitRevert: (scope, hash) => call("git.revert", scopePayload(scope, { hash })),
			/** Cherry-pick one commit onto the current branch. */
			gitCherryPick: (scope, hash) => call("git.cherry-pick", scopePayload(scope, { hash })),
			/** Release a terminal's process immediately (tab closed; the WS close frame
			*  may be unreachable while the socket is down, so the host also accepts
			*  this explicit route). */
			ptyClose: (scope, tab) => call("pty.close", scopePayload(scope, { tab })),
			/** Release an agent terminal by uuid (tab closed while WS was down). */
			agentPtyClose: (uuid) => call("agent-pty.close", { uuid }),
			/**
			* The output the model has read so far for one background job (replayed
			* from the owner session's event log — never the model's job_output
			* cursor). The scope MUST be the job's OWNER session.
			*/
			jobOutput: (scope, id, signal) => call("jobs.output", scopePayload(scope, { id }), signal),
			/** Request cancellation of one background job (live jobs flip to stopping). */
			jobKill: (scope, id, reason) => call("jobs.kill", scopePayload(scope, {
				id,
				...reason !== void 0 ? { reason } : {}
			})),
			/** Read the side card preferences (plugin-global, no session scope). */
			settingsGet: () => call("settings.get", {}),
			/** Merge a patch into the side card preferences (revision-guarded). */
			settingsUpdate: (patch, expectedRevision) => call("settings.update", {
				patch,
				...expectedRevision !== void 0 ? { expectedRevision } : {}
			}),
			/** Probe a URL's response headers (the sidebar browser's embeddability
			*  check; see the host's browser.probe route). */
			browserProbe: (url, signal) => call("browser.probe", { url }, signal)
		};
		/** Absolute URL of the media route for one path (images only). */
		function mediaUrl(scope, path) {
			return fileUrl(scope, path, false);
		}
		/** Absolute URL of the download route: serves raw bytes (binary-safe) with
		*  `Content-Disposition: attachment`, so the browser saves the file. */
		function downloadUrl(scope, path) {
			return fileUrl(scope, path, true);
		}
		/** Shared URL builder for the /sidebar/file route (media vs download). */
		function fileUrl(scope, path, download) {
			const params = new URLSearchParams({
				sessionId: scope.sessionId,
				path
			});
			if (scope.cwd !== void 0 && scope.cwd !== "") params.set("cwd", scope.cwd);
			if (download) params.set("download", "1");
			return `/sidebar/file?${params.toString()}`;
		}
		//#endregion
		//#region src/client/paths.ts
		/**
		* Path projection helpers shared by the explorer rows: a path relative to
		* the session cwd (for the @-reference button and "copy relative path").
		* The fs-tree joins with '/' even on Windows, so both separators normalize
		* to '/' before comparison.
		*/
		/**
		* The path relative to the session's working directory.
		* @param cwd - the explorer root (absolute).
		* @param path - an absolute entry path from the fs-tree.
		* @returns the relative path with '/' separators ('.' for the cwd itself),
		* or `path` unchanged when it lies outside the cwd.
		*
		* The prefix test is case-insensitive: Windows paths (and macOS's
		* case-insensitive volumes) may arrive with different casing than the cwd
		* row, and the containment decision must not depend on it. The returned
		* relative text keeps the caller's own casing.
		*/
		function relativeTo(cwd, path) {
			const base = cwd.replace(/[\\/]+$/, "");
			const norm = (value) => value.replace(/\\/g, "/");
			const nBase = norm(base);
			const nPath = norm(path);
			if (nPath === nBase) return ".";
			if (nPath.toLowerCase().startsWith(`${nBase.toLowerCase()}/`)) return nPath.slice(nBase.length + 1);
			return path;
		}
		//#endregion
		//#region src/client/ExplorerView.tsx
		/**
		* The file explorer: a lazy VSCode-style tree rooted at the session's
		* working directory. Levels load on expansion (one API call per directory),
		* directories sort first, hidden entries render dimmed, and the expansion
		* set lives in the per-session state. Clicking a file opens an editor tab.
		*
		* Row actions: hovering a row reveals an @-reference button on the far
		* right (appends `@<relative path>` to the composer draft), and right-click
		* opens a context menu to copy the relative or absolute path (with a brief
		* "copied" label replacing the button after a successful write); file rows
		* also offer a download action (the host serves raw bytes, binary-safe).
		*/
		/** Root label: the last path segment (mirror of the host rootLabel). */
		function baseName$1(path) {
			const trimmed = path.replace(/[\\/]+$/, "");
			const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return at === -1 ? trimmed : trimmed.slice(at + 1);
		}
		/** How long the row's "copied" label stays after a successful write. */
		const COPIED_MS = 1200;
		function ExplorerView(props) {
			const { sessionId, cwd, expanded, onToggle, onOpenFile, onReferenceFile } = props;
			const [data, setData] = (0, react.useState)({});
			const dataRef = (0, react.useRef)(data);
			const [refreshTick, setRefreshTick] = (0, react.useState)(0);
			/** The row whose path was just copied ("copied" label replaces its button). */
			const [copiedPath, setCopiedPath] = (0, react.useState)(null);
			/** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
			const [rowMenu, setRowMenu] = (0, react.useState)(null);
			const storeLevel = (0, react.useCallback)((path, level) => {
				dataRef.current = {
					...dataRef.current,
					[path]: level
				};
				setData(dataRef.current);
			}, []);
			const loadDir = (0, react.useCallback)((dir) => {
				if (dataRef.current[dir] !== void 0) return;
				storeLevel(dir, {});
				api.fsTree({
					sessionId,
					cwd
				}, dir).then((listing) => {
					storeLevel(dir, { entries: listing.entries });
				}).catch((error) => {
					storeLevel(dir, { error: error instanceof Error ? error.message : String(error) });
				});
			}, [
				sessionId,
				cwd,
				storeLevel
			]);
			(0, react.useEffect)(() => {
				const root = cwd;
				if (root === void 0) return;
				loadDir(root);
				for (const dir of expanded) loadDir(dir);
			}, [
				cwd,
				expanded,
				refreshTick,
				loadDir
			]);
			/** Copy `text`; on success flip the row's copied label for a moment. */
			const copyPath = (0, react.useCallback)((text, path) => {
				(0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(text).then((ok) => {
					if (!ok) return;
					setCopiedPath(path);
					window.setTimeout(() => {
						setCopiedPath((current) => current === path ? null : current);
					}, COPIED_MS);
				});
			}, []);
			/** The row's trailing actions: the @-reference button, or the copied label. */
			const rowActions = (entry) => {
				if (copiedPath === entry.path) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: sidebar_module_css_default.explorerCopied,
					children: t("copied")
				});
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: sidebar_module_css_default.explorerRef,
					"aria-label": t("referenceFile"),
					title: t("referenceFile"),
					onClick: (event) => {
						event.stopPropagation();
						onReferenceFile(entry.path);
					},
					children: t("referenceFile")
				});
			};
			const openRowMenu = (event, path, isDir) => {
				event.preventDefault();
				event.stopPropagation();
				setRowMenu({
					path,
					isDir,
					x: event.clientX,
					y: event.clientY
				});
			};
			/** Download a file through the host route (raw bytes, binary-safe). */
			const downloadFile = (path) => {
				const url = downloadUrl({
					sessionId,
					cwd
				}, path);
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.style.display = "none";
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
			};
			const root = cwd;
			const renderLevel = (dir, depth) => {
				const level = data[dir];
				if (level === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: sidebar_module_css_default.explorerRow,
					style: { paddingLeft: depth * 22 + 6 },
					children: t("loading")
				});
				if (level.error !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: clsx(sidebar_module_css_default.explorerRow, sidebar_module_css_default.explorerError),
					style: { paddingLeft: depth * 22 + 6 },
					children: level.error
				});
				return (level.entries ?? []).map((entry) => {
					if (entry.isDir) {
						const isOpen = expanded.includes(entry.path);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							role: "button",
							tabIndex: 0,
							className: clsx(sidebar_module_css_default.explorerRow, sidebar_module_css_default.explorerDir, entry.hidden && sidebar_module_css_default.explorerHidden),
							style: { paddingLeft: depth * 22 + 6 },
							onClick: () => {
								onToggle(entry.path);
							},
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onToggle(entry.path);
								}
							},
							onContextMenu: (event) => {
								openRowMenu(event, entry.path, true);
							},
							children: [
								isOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderClose16, { size: 14 }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: sidebar_module_css_default.explorerName,
									children: entry.name
								}),
								rowActions(entry)
							]
						}), isOpen && renderLevel(entry.path, depth + 1)] }, entry.path);
					}
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "button",
						tabIndex: 0,
						className: clsx(sidebar_module_css_default.explorerRow, entry.hidden && sidebar_module_css_default.explorerHidden),
						style: { paddingLeft: depth * 22 + 6 },
						title: entry.path,
						onClick: () => {
							onOpenFile(entry.path);
						},
						onKeyDown: (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onOpenFile(entry.path);
							}
						},
						onContextMenu: (event) => {
							openRowMenu(event, entry.path, false);
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size: 14 }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: sidebar_module_css_default.explorerName,
								children: entry.name
							}),
							rowActions(entry)
						]
					}, entry.path);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.explorer,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: sidebar_module_css_default.explorerHeader,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.explorerRoot,
							title: root,
							children: root === void 0 ? t("noSession") : baseName$1(root)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.iconButton,
							"aria-label": t("refresh"),
							title: t("refresh"),
							onClick: () => {
								dataRef.current = {};
								setData({});
								setRefreshTick((tick) => tick + 1);
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.explorerBody,
						children: root === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: sidebar_module_css_default.explorerEmpty,
							children: t("noSession")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: sidebar_module_css_default.explorerRow,
							style: { paddingLeft: 6 },
							onContextMenu: (event) => {
								openRowMenu(event, root, true);
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, { size: 14 }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: sidebar_module_css_default.explorerName,
									children: baseName$1(root)
								}),
								copiedPath === root ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: sidebar_module_css_default.explorerCopied,
									children: t("copied")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: sidebar_module_css_default.explorerRef,
									"aria-label": t("referenceFile"),
									title: t("referenceFile"),
									onClick: (event) => {
										event.stopPropagation();
										onReferenceFile(root);
									},
									children: t("referenceFile")
								})
							]
						}), data[root] !== void 0 && renderLevel(root, 1)] })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
						open: rowMenu !== null,
						onClose: () => {
							setRowMenu(null);
						},
						items: [
							...rowMenu?.isDir === false ? [{
								id: "download",
								label: t("download"),
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size: 14 })
							}] : [],
							{
								id: "relative",
								label: t("copyRelative"),
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, { size: 14 })
							},
							{
								id: "absolute",
								label: t("copyAbsolute"),
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, { size: 14 })
							}
						],
						onSelect: (id) => {
							const target = rowMenu;
							if (target === null) return;
							setRowMenu(null);
							if (id === "download") {
								downloadFile(target.path);
								return;
							}
							copyPath(id === "relative" ? relativeTo(cwd ?? "", target.path) : target.path, target.path);
						},
						portal: true,
						align: "start",
						getAnchorRect: () => rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0),
						anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {})
					})
				]
			});
		}
		//#endregion
		//#region src/client/binary-download.tsx
		function BinaryDownload(props) {
			const { scope, path } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.editorBinary,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: sidebar_module_css_default.editorBinaryNotice,
					children: t("binaryNoPreview")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
					className: sidebar_module_css_default.editorDownloadLink,
					href: downloadUrl(scope, path),
					download: true,
					children: t("downloadToView")
				})]
			});
		}
		//#endregion
		//#region src/client/editor-load.ts
		/** Decode the host's base64 head bytes into the sniffing buffer. */
		function decodeHead(headBase64) {
			const binary = atob(headBase64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
			return bytes;
		}
		/**
		* Dispatch one matched viewer's fetchStrategy. A missing viewer or a
		* `binary-download` strategy both mean "no client-side renderer" → the
		* download UI. `mediaUrlOf` builds the media URL for `mediaUrl`/`none`
		* strategies (pure, but scope-bound — injected by the host).
		*/
		function planFirstMatch(viewer, mediaUrlOf) {
			if (viewer === void 0 || viewer.fetchStrategy === "binary-download") return { kind: "binary" };
			switch (viewer.fetchStrategy) {
				case "mediaUrl":
				case "none": return {
					kind: "render",
					viewer,
					mediaUrl: mediaUrlOf()
				};
				case "custom": return {
					kind: "customLoad",
					viewer
				};
				case "fsRead": return {
					kind: "fetchFsRead",
					viewer
				};
			}
		}
		/**
		* Decide what an fsRead result means for the editor.
		* - Text: the first match stands (content is valid for any fsRead viewer).
		* - Binary: the host head bytes enable a re-match — a `detect` viewer (e.g.
		*   a plugin sniffing a binary format) may claim the file. `custom` viewers
		*   load their own bytes; `mediaUrl`/`none` viewers render the media route;
		*   an fsRead viewer or nothing cannot render binary → download UI.
		*/
		function planFsReadOutcome(viewer, result, rematch, mediaUrlOf) {
			if (!result.binary) return {
				kind: "render",
				viewer,
				content: result.content,
				truncated: result.truncated
			};
			const claimed = result.head === void 0 ? void 0 : rematch(decodeHead(result.head));
			if (claimed !== void 0 && claimed.fetchStrategy === "custom") return {
				kind: "customLoad",
				viewer: claimed
			};
			if (claimed !== void 0 && (claimed.fetchStrategy === "mediaUrl" || claimed.fetchStrategy === "none")) return {
				kind: "render",
				viewer: claimed,
				mediaUrl: mediaUrlOf()
			};
			return { kind: "binary" };
		}
		//#endregion
		//#region src/client/EditorHost.tsx
		/**
		* The editor tab host: resolves a file's previewer through the sidebar
		* registry (`matchFileViewer`), fetches bytes per the matched viewer's
		* fetch strategy, and renders its component — or the shared download pane
		* when nothing can render the file. The header shows the file title; the
		* editable code/markdown viewers render their own toolbar below it.
		*
		* The strategy dispatch is pure (planFirstMatch / planFsReadOutcome in
		* editor-load.ts); this component only wires it to the host APIs.
		*/
		function EditorHost(props) {
			const { ctx, store, scope, path, title, tabId } = props;
			/** 返回上级：切回资源管理器（若打开）并关闭当前文件预览标签。 */
			const goBack = () => {
				const service = ctx.betterSidebar;
				if (service === void 0 || tabId === void 0) return;
				service.activateTab("explorer", scope);
				service.closeTab(tabId, scope);
			};
			const [load, setLoad] = (0, react.useState)({ status: "loading" });
			(0, react.useEffect)(() => {
				let cancelled = false;
				const controller = new AbortController();
				setLoad({ status: "loading" });
				const mediaUrlOf = () => mediaUrl(scope, path);
				const apply = (action) => {
					if (cancelled) return;
					switch (action.kind) {
						case "binary":
							setLoad({ status: "binary" });
							return;
						case "render":
							setLoad({
								status: "ready",
								viewer: action.viewer,
								content: action.content,
								truncated: action.truncated,
								mediaUrl: action.mediaUrl,
								customData: action.customData
							});
							return;
						case "customLoad":
							action.viewer.load?.(path, scope, controller.signal).then((data) => {
								if (cancelled) return;
								setLoad({
									status: "ready",
									viewer: action.viewer,
									customData: data
								});
							}).catch((error) => {
								if (cancelled) return;
								setLoad({
									status: "error",
									message: error instanceof Error ? error.message : String(error)
								});
							});
							return;
						case "fetchFsRead":
							api.fsRead(scope, path).then((result) => {
								if (cancelled) return;
								const outcome = planFsReadOutcome(action.viewer, {
									binary: result.kind === "binary",
									content: result.kind === "text" ? result.content : "",
									truncated: result.truncated,
									head: result.kind === "binary" ? result.head : void 0
								}, (head) => ctx.betterSidebar?.matchFileViewer(path, head), mediaUrlOf);
								apply(outcome);
							}).catch((error) => {
								if (cancelled) return;
								setLoad({
									status: "error",
									message: error instanceof Error ? error.message : String(error)
								});
							});
							return;
					}
				};
				apply(planFirstMatch(ctx.betterSidebar?.matchFileViewer(path), mediaUrlOf));
				return () => {
					cancelled = true;
					controller.abort();
				};
			}, [
				scope.sessionId,
				scope.cwd,
				path,
				ctx
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.editor,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: sidebar_module_css_default.editorHeader,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.editorBack,
							title: t("editorBack"),
							"aria-label": t("editorBack"),
							onClick: goBack,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutline14, {})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.editorTitle,
							title: path,
							children: title
						})]
					}),
					load.status === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.editorPlaceholder,
						children: t("loading")
					}),
					load.status === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.editorError,
						children: load.message
					}),
					load.status === "binary" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BinaryDownload, {
						scope,
						path
					}),
					load.status === "ready" && (0, react.createElement)(load.viewer.component, {
						ctx,
						store,
						scope,
						path,
						title,
						viewerId: load.viewer.id,
						content: load.content,
						truncated: load.truncated,
						mediaUrl: load.mediaUrl,
						customData: load.customData
					})
				]
			});
		}
		//#endregion
		//#region src/client/lazy-chunk.tsx
		/**
		* Lazy chunk view wrapper: mounts a component that lives in a lazy chunk,
		* showing a loading placeholder while the chunk script loads and an error +
		* retry affordance on failure. Used by the built-in tab/viewer descriptors.
		*
		* Contract note: {@link lazyChunkComponent} returns a plain render-prop
		* function — the descriptor contract is `component: (props) => ReactNode`,
		* and the repo renders descriptors BOTH ways: Sidebar calls
		* `descriptor.component(props)` directly, EditorHost renders it via
		* `createElement`. The wrapper function body therefore contains no hooks;
		* all state lives in the inner {@link LazyChunkView} component.
		*/
		function LazyChunkView({ chunk, pick, props }) {
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [state, setState] = (0, react.useState)({ status: "loading" });
			(0, react.useEffect)(() => {
				let cancelled = false;
				setState({ status: "loading" });
				loadChunk(chunk).then((mod) => {
					if (cancelled) return;
					const Comp = pick(mod);
					if (Comp === void 0) {
						setState({
							status: "error",
							message: `[dsh-better-sidebar] chunk "${chunk}" is missing its component`
						});
						return;
					}
					setState({
						status: "ready",
						Comp
					});
				}).catch((error) => {
					if (cancelled) return;
					setState({
						status: "error",
						message: error instanceof Error ? error.message : String(error)
					});
				});
				return () => {
					cancelled = true;
				};
			}, [
				chunk,
				pick,
				attempt
			]);
			if (state.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: sidebar_module_css_default.editorPlaceholder,
				children: t("loading")
			});
			if (state.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.editorError,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: state.message }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: sidebar_module_css_default.terminalRetry,
					onClick: () => {
						setAttempt((current) => current + 1);
					},
					children: t("terminalRetry")
				})]
			});
			return (0, react.createElement)(state.Comp, props);
		}
		/**
		* Build a descriptor-compatible lazy wrapper for a chunk-resident component.
		* The returned function is the descriptor `component` itself: it returns an
		* element and never calls hooks, so both invocation styles (plain function
		* call and createElement/JSX render) work. `pick` must be a module-level
		* function (stable identity) — an inline lambda would re-trigger the load
		* effect on every render.
		* @param chunk - the chunk name (see chunk-loader.ts).
		* @param pick - select the component from the chunk's exports.
		*/
		function lazyChunkComponent(chunk, pick) {
			return (props) => (0, react.createElement)(LazyChunkView, {
				chunk,
				pick,
				props
			});
		}
		//#endregion
		//#region src/client/GitView.tsx
		/**
		* The source-control panel: status list (staged vs unstaged), stage/unstage,
		* commit with a message box, branch switch, and a VSCode-like history — rows
		* carry branch decorations, author and relative time. Clicking a changed
		* file or a history row opens a dedicated diff TAB (see {@link DiffTab}),
		* placed below the git pane on first use. File rows and history rows open a
		* right-click context menu with advanced operations (open in editor, discard,
		* revert, cherry-pick, copy paths/hashes). Refresh is manual + on mount/
		* focus (no file watcher — KISS).
		*/
		/** The XY status letters a row badge shows (X = index, Y = worktree). */
		function badgeOf(entry) {
			const index = entry.xy[0];
			const worktree = entry.xy[1];
			if (index !== void 0 && index !== " " && index !== "?") return index;
			if (worktree !== void 0 && worktree !== " " && worktree !== "?") return worktree;
			return "?";
		}
		/** Whether the entry carries STAGED (index) changes — the X letter is set. */
		function isStagedEntry(entry) {
			const index = entry.xy[0];
			return index !== void 0 && index !== " " && index !== "?";
		}
		/** Whether the entry carries UNSTAGED (worktree) changes — the Y letter is set
		*  (untracked `??` counts as unstaged: it is a worktree-only change). A file
		*  with both letters set ('MM') lands in BOTH sections. */
		function isUnstagedEntry(entry) {
			if (entry.xy === "??") return true;
			const worktree = entry.xy[1];
			return worktree !== void 0 && worktree !== " " && worktree !== "?";
		}
		/** Whether the entry is untracked (`??`): git diff never includes it. */
		function isUntracked(entry) {
			return badgeOf(entry) === "?";
		}
		/** The last path segment (tab title for a file's diff). */
		function baseName(path) {
			const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
			return at === -1 ? path : path.slice(at + 1);
		}
		/** The ref names of one log row's decorations (`HEAD -> main` → `main`), deduped. */
		function refNames(refs) {
			return [...new Set(refs.split(",").map((ref) => ref.trim()).filter((ref) => ref !== "").map((ref) => ref.includes(" -> ") ? ref.slice(ref.indexOf(" -> ") + 4) : ref).map((ref) => ref.startsWith("tag: ") ? ref.slice(5) : ref))];
		}
		/** History batch size: the log loads lazily in pages so a long history never
		*  floods the panel at once (the end of the log is reached by paging). */
		const LOG_BATCH = 20;
		function GitView(props) {
			const { scope, onOpenFile, onOpenDiff } = props;
			const [status, setStatus] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(null);
			const [branchNames, setBranchNames] = (0, react.useState)([]);
			const [logEntries, setLogEntries] = (0, react.useState)([]);
			const [commitMsg, setCommitMsg] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [commitError, setCommitError] = (0, react.useState)(null);
			/** Whether the history was fully paged (a batch shorter than LOG_BATCH). */
			const [logEnded, setLogEnded] = (0, react.useState)(false);
			const [logLoadingMore, setLogLoadingMore] = (0, react.useState)(false);
			/** The open file-row context menu (cursor position for the portaled Menu). */
			const [fileMenu, setFileMenu] = (0, react.useState)(null);
			/** The open history-row context menu. */
			const [historyMenu, setHistoryMenu] = (0, react.useState)(null);
			/** The pending destructive action awaiting confirmation. */
			const [confirm, setConfirm] = (0, react.useState)(null);
			const refresh = (0, react.useCallback)(async () => {
				setLoading(true);
				setError(null);
				try {
					const [statusResult, branchResult, logResult] = await Promise.all([
						api.gitStatus(scope),
						api.gitBranch(scope).catch(() => ({
							current: "",
							names: []
						})),
						api.gitLog(scope, LOG_BATCH, 0).catch(() => [])
					]);
					setStatus(statusResult);
					setBranchNames(branchResult.names);
					setLogEntries(logResult);
					setLogEnded(logResult.length < LOG_BATCH);
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				} finally {
					setLoading(false);
				}
			}, [scope.sessionId, scope.cwd]);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			/** Append the next history page (lazy: only when the user asks for more). */
			const loadMoreLog = async () => {
				if (logLoadingMore || logEnded) return;
				setLogLoadingMore(true);
				try {
					const next = await api.gitLog(scope, LOG_BATCH, logEntries.length);
					setLogEntries((entries) => [...entries, ...next]);
					if (next.length < LOG_BATCH) setLogEnded(true);
				} catch (reason) {
					setCommitError(`${t("historyLoadError")}: ${reason instanceof Error ? reason.message : String(reason)}`);
				} finally {
					setLogLoadingMore(false);
				}
			};
			/** The diff tab for one changed file (one tab per path+side; same id = focused). */
			const openWorktreeDiff = (entry, staged) => {
				onOpenDiff({
					id: `diff:w:${staged ? "s" : "u"}:${entry.path}`,
					type: "diff",
					title: baseName(entry.path),
					diff: {
						kind: "worktree",
						path: entry.path,
						staged,
						untracked: isUntracked(entry)
					}
				});
			};
			/** The diff tab for one commit (one tab per commit). */
			const openCommitDiff = (entry) => {
				onOpenDiff({
					id: `diff:c:${entry.hashFull}`,
					type: "diff",
					title: `${entry.hash} ${entry.subject}`,
					diff: {
						kind: "commit",
						hash: entry.hash,
						hashFull: entry.hashFull,
						subject: entry.subject
					}
				});
			};
			const stageEntry = async (entry, staged) => {
				setBusy(true);
				try {
					if (staged) await api.gitUnstage(scope, entry.path);
					else await api.gitStage(scope, entry.path);
					await refresh();
				} finally {
					setBusy(false);
				}
			};
			const stageAll = async (staged) => {
				setBusy(true);
				try {
					if (staged) await api.gitUnstage(scope);
					else await api.gitStage(scope);
					await refresh();
				} finally {
					setBusy(false);
				}
			};
			const commit = async () => {
				const message = commitMsg.trim();
				if (message === "" || busy) return;
				setBusy(true);
				setCommitError(null);
				try {
					await api.gitCommit(scope, message);
					setCommitMsg("");
					await refresh();
				} catch (reason) {
					setCommitError(reason instanceof Error ? reason.message : String(reason));
				} finally {
					setBusy(false);
				}
			};
			const checkout = async (branch) => {
				if (branch === status?.branch || busy) return;
				setBusy(true);
				setCommitError(null);
				try {
					await api.gitCheckout(scope, branch);
					await refresh();
				} catch (reason) {
					setCommitError(`${t("checkoutError")}: ${reason instanceof Error ? reason.message : String(reason)}`);
				} finally {
					setBusy(false);
				}
			};
			/** Run one destructive operation after the confirm modal, then refresh. */
			const runConfirmed = (confirmState) => {
				setConfirm({
					...confirmState,
					onConfirm: async () => {
						setBusy(true);
						setCommitError(null);
						try {
							await confirmState.onConfirm();
							await refresh();
						} catch (reason) {
							setCommitError(reason instanceof Error ? reason.message : String(reason));
						} finally {
							setBusy(false);
						}
					}
				});
			};
			/** Copy `text` to the clipboard (best-effort; no visual feedback needed — the menu closes). */
			const copy = (text) => {
				(0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(text);
			};
			const openFileMenu = (event, entry, staged) => {
				event.preventDefault();
				event.stopPropagation();
				setFileMenu({
					entry,
					staged,
					x: event.clientX,
					y: event.clientY
				});
			};
			const openHistoryMenu = (event, entry) => {
				event.preventDefault();
				event.stopPropagation();
				setHistoryMenu({
					entry,
					x: event.clientX,
					y: event.clientY
				});
			};
			const stagedEntries = (status?.entries ?? []).filter(isStagedEntry);
			const unstagedEntries = (status?.entries ?? []).filter(isUnstagedEntry);
			const renderEntry = (entry, staged) => {
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: sidebar_module_css_default.gitRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: sidebar_module_css_default.gitRowMain,
						title: entry.path,
						onClick: () => {
							openWorktreeDiff(entry, staged);
						},
						onContextMenu: (event) => {
							openFileMenu(event, entry, staged);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.gitBadge,
							children: badgeOf(entry)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.gitName,
							children: entry.path
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: sidebar_module_css_default.iconButton,
						"aria-label": staged ? t("unstage") : t("stage"),
						title: staged ? t("unstage") : t("stage"),
						disabled: busy,
						onClick: () => {
							stageEntry(entry, staged);
						},
						children: staged ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {})
					})]
				}, `${staged ? "s" : "u"}:${entry.path}`);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.git,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: sidebar_module_css_default.gitHeader,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: sidebar_module_css_default.gitBranchSelect,
							value: status?.branch ?? "",
							onChange: (event) => {
								checkout(event.target.value);
							},
							disabled: busy || status !== null && !status.isRepo,
							children: [(status?.branch ?? "") !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: status.branch,
								children: status.branch
							}), branchNames.filter((name) => name !== status?.branch).map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: name,
								children: name
							}, name))]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.iconButton,
							"aria-label": t("refresh"),
							title: t("refresh"),
							onClick: () => {
								refresh();
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {})
						})]
					}),
					loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.gitPlaceholder,
						children: t("loading")
					}),
					!loading && error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.gitError,
						children: error
					}),
					!loading && status !== null && !status.isRepo && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.gitPlaceholder,
						children: t("notRepo")
					}),
					status !== null && status.isRepo && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: sidebar_module_css_default.gitSection,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: sidebar_module_css_default.gitSectionHeader,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										t("staged"),
										" (",
										stagedEntries.length,
										")"
									] }), stagedEntries.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: sidebar_module_css_default.gitLink,
										disabled: busy,
										onClick: () => {
											stageAll(true);
										},
										children: t("unstageAll")
									})]
								}),
								stagedEntries.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: sidebar_module_css_default.gitEmpty,
									children: t("noChanges")
								}),
								stagedEntries.map((entry) => renderEntry(entry, true))
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: sidebar_module_css_default.gitSection,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: sidebar_module_css_default.gitSectionHeader,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										t("unstaged"),
										" (",
										unstagedEntries.length,
										")"
									] }), unstagedEntries.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: sidebar_module_css_default.gitLink,
										disabled: busy,
										onClick: () => {
											stageAll(false);
										},
										children: t("stageAll")
									})]
								}),
								unstagedEntries.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: sidebar_module_css_default.gitEmpty,
									children: t("noChanges")
								}),
								unstagedEntries.map((entry) => renderEntry(entry, false))
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: sidebar_module_css_default.gitCommit,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								className: sidebar_module_css_default.gitCommitInput,
								placeholder: t("commitPlaceholder"),
								value: commitMsg,
								disabled: busy,
								onChange: (event) => {
									setCommitMsg(event.target.value);
									setCommitError(null);
								},
								onKeyDown: (event) => {
									if ((event.ctrlKey || event.metaKey) && event.key === "Enter") commit();
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: sidebar_module_css_default.gitCommitButton,
								disabled: busy || commitMsg.trim() === "" || stagedEntries.length === 0,
								onClick: () => {
									commit();
								},
								children: t("commit")
							})]
						}),
						commitError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: sidebar_module_css_default.gitError,
							children: commitError
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: sidebar_module_css_default.gitSection,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: sidebar_module_css_default.gitSectionHeader,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("history") })
								}),
								logEntries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									role: "button",
									tabIndex: 0,
									className: sidebar_module_css_default.gitLogRow,
									title: `${entry.author} · ${entry.date}\n${entry.hashFull}`,
									onClick: () => {
										openCommitDiff(entry);
									},
									onKeyDown: (event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											openCommitDiff(entry);
										}
									},
									onContextMenu: (event) => {
										openHistoryMenu(event, entry);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: sidebar_module_css_default.gitLogLine1,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: sidebar_module_css_default.gitLogHash,
											children: entry.hash
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: sidebar_module_css_default.gitLogSubject,
											children: entry.subject
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: sidebar_module_css_default.gitLogLine2,
										children: [refNames(entry.refs).map((ref) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: sidebar_module_css_default.gitLogRef,
											children: ref
										}, ref)), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: sidebar_module_css_default.gitLogMeta,
											children: [
												entry.author,
												" · ",
												relativeTime(entry.date)
											]
										})]
									})]
								}, entry.hashFull)),
								!logEnded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: sidebar_module_css_default.gitLogMore,
									disabled: logLoadingMore || busy,
									onClick: () => {
										loadMoreLog();
									},
									children: logLoadingMore ? t("loading") : t("loadMore")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
							open: fileMenu !== null,
							onClose: () => {
								setFileMenu(null);
							},
							items: [
								{
									id: "open",
									label: t("openEditor"),
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size: 14 })
								},
								fileMenu?.staged === true ? {
									id: "stage",
									label: t("unstage"),
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 14 })
								} : {
									id: "stage",
									label: t("stage"),
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, { size: 14 })
								},
								...fileMenu !== null && !isUntracked(fileMenu.entry) ? [{
									id: "discard",
									label: t("discard"),
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 14 }),
									danger: true
								}] : [],
								{
									type: "separator",
									id: "sep1"
								},
								{
									id: "relative",
									label: t("copyRelative"),
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, { size: 14 })
								},
								{
									id: "absolute",
									label: t("copyAbsolute"),
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, { size: 14 })
								}
							],
							onSelect: (id) => {
								const target = fileMenu;
								if (target === null) return;
								setFileMenu(null);
								if (id === "open") {
									onOpenFile(target.entry.path);
									return;
								}
								if (id === "stage") {
									stageEntry(target.entry, target.staged);
									return;
								}
								if (id === "discard") {
									runConfirmed({
										title: t("discardTitle"),
										description: t("discardDesc", { path: target.entry.path }),
										confirmLabel: t("discard"),
										onConfirm: () => api.gitDiscard(scope, target.entry.path)
									});
									return;
								}
								if (id === "relative") {
									copy(relativeTo(scope.cwd ?? "", target.entry.path));
									return;
								}
								if (id === "absolute") copy(target.entry.path);
							},
							portal: true,
							align: "start",
							getAnchorRect: () => fileMenu === null ? null : new DOMRect(fileMenu.x, fileMenu.y, 0, 0),
							anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
							open: historyMenu !== null,
							onClose: () => {
								setHistoryMenu(null);
							},
							items: [
								{
									id: "view",
									label: t("viewCommitDiff")
								},
								{
									id: "copyShort",
									label: t("copyShortHash"),
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, { size: 14 })
								},
								{
									id: "copyFull",
									label: t("copyFullHash"),
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, { size: 14 })
								},
								{
									id: "copySubject",
									label: t("copySubject"),
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, { size: 14 })
								},
								{
									type: "separator",
									id: "sep2"
								},
								{
									id: "revert",
									label: t("revertCommit"),
									danger: true
								},
								{
									id: "cherryPick",
									label: t("cherryPickCommit"),
									danger: true
								}
							],
							onSelect: (id) => {
								const target = historyMenu;
								if (target === null) return;
								setHistoryMenu(null);
								if (id === "view") {
									openCommitDiff(target.entry);
									return;
								}
								if (id === "copyShort") {
									copy(target.entry.hash);
									return;
								}
								if (id === "copyFull") {
									copy(target.entry.hashFull);
									return;
								}
								if (id === "copySubject") {
									copy(target.entry.subject);
									return;
								}
								if (id === "revert") {
									runConfirmed({
										title: t("revertTitle"),
										description: t("revertDesc", { subject: target.entry.subject }),
										confirmLabel: t("revertCommit"),
										onConfirm: () => api.gitRevert(scope, target.entry.hashFull)
									});
									return;
								}
								if (id === "cherryPick") runConfirmed({
									title: t("cherryPickTitle"),
									description: t("cherryPickDesc", { subject: target.entry.subject }),
									confirmLabel: t("cherryPickCommit"),
									onConfirm: () => api.gitCherryPick(scope, target.entry.hashFull)
								});
							},
							portal: true,
							align: "start",
							getAnchorRect: () => historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0),
							anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
							open: confirm !== null,
							onClose: () => {
								setConfirm(null);
							},
							title: confirm?.title ?? "",
							closeLabel: t("cancel"),
							footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								onClick: () => {
									setConfirm(null);
								},
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								disabled: busy,
								onClick: () => {
									const pending = confirm;
									if (pending === null) return;
									setConfirm(null);
									pending.onConfirm();
								},
								children: confirm?.confirmLabel ?? ""
							})] }),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: sidebar_module_css_default.gitConfirmDesc,
								children: confirm?.description
							})
						})
					] })
				]
			});
		}
		//#endregion
		//#region src/client/DiffView.tsx
		/**
		* The real diff surface for the git panel: parses the host's unified diff
		* text (`git diff` / `git show`) and renders it VSCode-style — per-file
		* sections with hunks (`@@ -a,b +c,d @@` headers), old/new line-number
		* gutters, and aligned context / deleted / added rows colored through the
		* DSH tokens. Untracked files produce no `git diff` output, so the caller
		* can pass the file content to render as a full-file addition instead.
		*
		* The parser is a pure function (`parseUnifiedDiff`) so the interesting
		* cases are unit-tested without a DOM.
		*/
		/** Parse the hunk header `@@ -a[,b] +c[,d] @@ section` (section may contain '@@'). */
		function parseHunkHeader(line) {
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
			if (match === null) return null;
			return {
				oldStart: Number(match[1]),
				newStart: Number(match[3]),
				header: match[5] ?? ""
			};
		}
		/**
		* Parse `git diff --no-color` output into file sections and hunks. Rows
		* outside a file section (leading noise) and metadata rows between the
		* `diff --git`/`---`/`+++` headers and the first hunk (index lines, mode
		* changes, rename/similarity lines) are skipped; a section that never
		* reaches a hunk (a mode/rename-only change) stays hunkless so the caller
		* can still draw its path.
		*/
		function parseUnifiedDiff(text) {
			const files = [];
			let current = null;
			let inHunk = false;
			let hunk = null;
			let oldNum = 0;
			let newNum = 0;
			const flushHunk = () => {
				if (current !== null && hunk !== null) current.hunks.push(hunk);
				hunk = null;
				inHunk = false;
			};
			for (const raw of text.split("\n")) {
				if (raw.startsWith("diff --git ")) {
					flushHunk();
					current = {
						oldPath: "",
						newPath: "",
						binary: false,
						hunks: []
					};
					files.push(current);
					continue;
				}
				if (current === null) continue;
				if (raw.startsWith("Binary files ") || raw === "GIT binary patch") {
					flushHunk();
					current.binary = true;
					continue;
				}
				if (raw.startsWith("--- ")) {
					flushHunk();
					current.oldPath = raw.slice(4);
					continue;
				}
				if (raw.startsWith("+++ ")) {
					current.newPath = raw.slice(4);
					continue;
				}
				const header = parseHunkHeader(raw);
				if (header !== null) {
					flushHunk();
					hunk = {
						oldStart: header.oldStart,
						newStart: header.newStart,
						header: header.header,
						lines: []
					};
					oldNum = header.oldStart;
					newNum = header.newStart;
					inHunk = true;
					continue;
				}
				if (!inHunk || hunk === null) continue;
				const marker = raw[0];
				if (marker === "\\") {
					hunk.lines.push({
						kind: "meta",
						text: raw.slice(1),
						oldNum: null,
						newNum: null
					});
					continue;
				}
				if (marker === " ") {
					hunk.lines.push({
						kind: "ctx",
						text: raw.slice(1),
						oldNum,
						newNum
					});
					oldNum += 1;
					newNum += 1;
				} else if (marker === "-") {
					hunk.lines.push({
						kind: "del",
						text: raw.slice(1),
						oldNum,
						newNum: null
					});
					oldNum += 1;
				} else if (marker === "+") {
					hunk.lines.push({
						kind: "add",
						text: raw.slice(1),
						oldNum: null,
						newNum
					});
					newNum += 1;
				} else flushHunk();
			}
			flushHunk();
			return { files };
		}
		/** Build the untracked-file shape: one file, one hunk of pure additions. */
		function untrackedFile(path, content) {
			const lines = [];
			const body = content.endsWith("\n") ? content.slice(0, -1) : content;
			if (body !== "") {
				let num = 1;
				for (const line of body.split("\n")) {
					lines.push({
						kind: "add",
						text: line,
						oldNum: null,
						newNum: num
					});
					num += 1;
				}
			}
			return {
				oldPath: "/dev/null",
				newPath: `b/${path}`,
				binary: false,
				hunks: [{
					oldStart: 0,
					newStart: 1,
					header: "",
					lines
				}]
			};
		}
		/** Strip the `a/` / `b/` prefix git puts on diff paths (not on /dev/null). */
		function displayPath(path) {
			if (path === "/dev/null") return path;
			if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
			return path;
		}
		/** The file header badge: added / deleted / renamed / binary ('' for a plain edit). */
		function fileTag(file) {
			if (file.binary) return t("diffBinary");
			if (file.oldPath === "/dev/null") return t("diffAdded");
			if (file.newPath === "/dev/null") return t("diffDeleted");
			if (displayPath(file.oldPath) !== displayPath(file.newPath)) return t("diffRenamed");
			return null;
		}
		/** Cap the flattened rows like DiffBlock: head + tail, expand button between. */
		const MAX_DIFF_ROWS = 500;
		function DiffView({ diff, untrackedPath, untrackedContent }) {
			const parsed = (0, react.useMemo)(() => {
				if (untrackedPath !== void 0) return { files: [untrackedFile(untrackedPath, untrackedContent ?? "")] };
				return parseUnifiedDiff(diff);
			}, [
				diff,
				untrackedPath,
				untrackedContent
			]);
			const [expanded, setExpanded] = (0, react.useState)(false);
			const rows = (0, react.useMemo)(() => {
				const out = [];
				parsed.files.forEach((file, fileIndex) => {
					out.push({
						key: `f${fileIndex}`,
						file,
						type: "path"
					});
					if (file.binary) return;
					file.hunks.forEach((hunk, hunkIndex) => {
						out.push({
							key: `f${fileIndex}h${hunkIndex}`,
							file,
							type: "hunk",
							hunk
						});
						hunk.lines.forEach((line, lineIndex) => {
							out.push({
								key: `f${fileIndex}h${hunkIndex}l${lineIndex}`,
								file,
								type: "line",
								hunk,
								line
							});
						});
					});
				});
				return out;
			}, [parsed]);
			const hidden = rows.length - MAX_DIFF_ROWS;
			const capped = hidden > 0 && !expanded;
			const headLines = Math.ceil(MAX_DIFF_ROWS / 2);
			const tailLines = 250;
			const head = capped ? rows.slice(0, headLines) : rows;
			const tail = capped ? rows.slice(rows.length - tailLines) : [];
			if (rows.length === 0) return null;
			const renderRow = (row) => {
				if (row.type === "path") {
					const tag = fileTag(row.file);
					const from = displayPath(row.file.oldPath);
					const to = displayPath(row.file.newPath);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: sidebar_module_css_default.gitDiffFile,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: sidebar_module_css_default.gitDiffFilePath,
								children: to
							}),
							from !== to && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: sidebar_module_css_default.gitDiffFileOld,
								children: ["← ", from]
							}),
							tag !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: sidebar_module_css_default.gitDiffFileTag,
								children: tag
							})
						]
					}, row.key);
				}
				if (row.type === "hunk") {
					const hunk = row.hunk;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: sidebar_module_css_default.gitDiffHunk,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: sidebar_module_css_default.gitDiffHunkHeader,
							children: [
								"@@ -",
								hunk.oldStart,
								",",
								hunk.lines.filter((l) => l.oldNum !== null).length,
								" +",
								hunk.newStart,
								",",
								hunk.lines.filter((l) => l.newNum !== null).length,
								" @@"
							]
						}), hunk.header !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.gitDiffHunkSection,
							children: hunk.header
						})]
					}, row.key);
				}
				const line = row.line;
				const lineClass = line.kind === "del" ? sidebar_module_css_default.gitDiffDel : line.kind === "add" ? sidebar_module_css_default.gitDiffAdd : line.kind === "meta" ? sidebar_module_css_default.gitDiffMeta : sidebar_module_css_default.gitDiffCtx;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: clsx(sidebar_module_css_default.gitDiffLine, lineClass),
					children: line.kind === "meta" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: sidebar_module_css_default.gitDiffMetaText,
						children: line.text
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.gitDiffNum,
							children: line.oldNum ?? ""
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.gitDiffNum,
							children: line.newNum ?? ""
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.gitDiffCode,
							children: line.text
						})
					] })
				}, row.key);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.gitDiff,
				children: [
					head.map(renderRow),
					hidden > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: sidebar_module_css_default.gitDiffExpand,
						"aria-expanded": expanded,
						onClick: () => {
							setExpanded((value) => !value);
						},
						children: expanded ? t("diffCollapse") : t("diffExpand", { count: hidden })
					}),
					tail.map(renderRow)
				]
			});
		}
		//#endregion
		//#region src/client/DiffTab.tsx
		/**
		* The diff tab: one change opened from the git panel, like VSCode's diff
		* editor. A worktree ref loads the file's unified diff (`git diff`, staged or
		* not; untracked files — which git diff never covers — render as a full-file
		* addition from their content), a commit ref loads the commit's full patch
		* (`git.show`-style). The header carries a refresh button because the tab
		* stays mounted while the git panel's staging/discard operations change the
		* very content it shows.
		*/
		function DiffTab(props) {
			const { sessionId, cwd, diff } = props;
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(null);
			const [data, setData] = (0, react.useState)(null);
			const [tick, setTick] = (0, react.useState)(0);
			const refresh = (0, react.useCallback)(() => {
				setTick((value) => value + 1);
			}, []);
			(0, react.useEffect)(() => {
				let cancelled = false;
				const scope = {
					sessionId,
					cwd
				};
				setLoading(true);
				setError(null);
				setData(null);
				const load = async () => {
					try {
						if (diff.kind === "commit") {
							const result = await api.gitCommitDiff(scope, diff.hashFull);
							if (!cancelled) setData({ diff: result.diff });
							return;
						}
						let result = await api.gitDiff(scope, diff.path, diff.staged);
						if (result.diff === "") {
							const other = await api.gitDiff(scope, diff.path, !diff.staged);
							if (other.diff !== "") result = other;
						}
						if (result.diff !== "") {
							if (!cancelled) setData({ diff: result.diff });
							return;
						}
						if (diff.untracked === true && !diff.staged) {
							const text = await api.fsRead(scope, diff.path);
							if (!cancelled) setData(text.kind === "text" ? {
								diff: "",
								untracked: text.content
							} : { diff: "" });
							return;
						}
						if (!cancelled) setData({ diff: "" });
					} catch (reason) {
						if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
					} finally {
						if (!cancelled) setLoading(false);
					}
				};
				load();
				return () => {
					cancelled = true;
				};
			}, [
				sessionId,
				cwd,
				diff,
				tick
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.gitDiffTab,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: sidebar_module_css_default.gitDiffTabHeader,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.gitDiffTabTitle,
							title: diff.kind === "worktree" ? diff.path : `${diff.hash} ${diff.subject}`,
							children: diff.kind === "worktree" ? diff.path : `${diff.hash} ${diff.subject}`
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.iconButton,
							"aria-label": t("refresh"),
							title: t("refresh"),
							onClick: refresh,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {})
						})]
					}),
					loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.gitPlaceholder,
						children: t("loading")
					}),
					!loading && error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: sidebar_module_css_default.gitError,
						children: [
							t("diffLoadError"),
							": ",
							error
						]
					}),
					!loading && error === null && data !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [data.untracked !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiffView, {
						diff: "",
						untrackedPath: diff.kind === "worktree" ? diff.path : "",
						untrackedContent: data.untracked
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiffView, { diff: data.diff }), data.diff === "" && data.untracked === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.gitEmpty,
						children: t("diffEmpty")
					})] })
				]
			});
		}
		//#endregion
		//#region src/client/subagent-detect.ts
		/** Count the direct subagent children of one session (durable `origin` rows). */
		function directSubagentCount(byId, sessionId) {
			let count = 0;
			for (const summary of Object.values(byId)) if (summary.origin === "subagent" && summary.parentId === sessionId) count += 1;
			return count;
		}
		/**
		* The main agent of the current session's tree: walk the durable parent
		* chain upward until the first non-subagent session. The Subagent page shows
		* THIS root's full topology regardless of how deep the current selection is
		* (a session whose row is still hydrating, or a broken chain, degrades to
		* the session itself).
		*/
		function rootAncestor(byId, sessionId) {
			if (sessionId === void 0) return void 0;
			const seen = /* @__PURE__ */ new Set();
			let current = byId[sessionId];
			while (current !== void 0 && current.origin === "subagent" && current.parentId !== void 0 && !seen.has(current.id)) {
				seen.add(current.id);
				current = byId[current.parentId];
			}
			return current?.id ?? sessionId;
		}
		/**
		* Collect every catalog branch (an entry with `hasChildren`) reachable from
		* the root — the set of catalogs the always-expanded topology consumes.
		* Cycles fail soft.
		*/
		function collectBranchIds(catalogs, rootId) {
			const out = [];
			const seen = /* @__PURE__ */ new Set();
			const visit = (parentId) => {
				if (seen.has(parentId)) return;
				seen.add(parentId);
				for (const entry of catalogs[parentId]?.entries ?? []) if (entry.kind === "child" && entry.hasChildren) {
					out.push(entry.id);
					visit(entry.id);
				}
			};
			if (rootId !== void 0) visit(rootId);
			return out;
		}
		/**
		* Whether a new direct subagent appeared under `sessionId` between two
		* consecutive list snapshots (the count crossed 0 → >0). Switching to a
		* session that already has subagents yields `false` (its baseline starts at
		* the current count), so the auto-open never fights an existing layout.
		*/
		function detectNewDirectSubagent(prev, next, sessionId) {
			return directSubagentCount(prev.byId, sessionId) === 0 && directSubagentCount(next.byId, sessionId) > 0;
		}
		/**
		* Index every subagent descendant under each ancestor it reaches through an
		* uninterrupted subagent-origin chain (same semantics as the official
		* `indexSubagentDescendants`; cycles fail soft).
		*/
		function countSubagentDescendants(byId, sessionId) {
			const totals = {
				count: 0,
				runningCount: 0
			};
			for (const descendant of Object.values(byId)) {
				if (descendant.origin !== "subagent") continue;
				const seen = /* @__PURE__ */ new Set();
				let current = descendant;
				while (current?.origin === "subagent" && current.parentId !== void 0 && !seen.has(current.id)) {
					seen.add(current.id);
					if (current.parentId === sessionId) {
						totals.count += 1;
						if (descendant.running === true) totals.runningCount += 1;
						break;
					}
					current = byId[current.parentId];
				}
			}
			return totals;
		}
		//#endregion
		//#region src/client/subagent-activity.ts
		/**
		* Extract the concatenated plain text of a content-block list (the durable
		* `ContentBlock[]` shape, structurally: blocks with `type: 'text'` carry
		* `text`; anything else — tool_use, image, … — contributes nothing).
		* @param content - the raw `content` field of a message event.
		* @returns the joined text, or undefined when the message carries no text.
		*/
		function contentText(content) {
			if (!Array.isArray(content)) return void 0;
			const parts = [];
			for (const block of content) {
				if (block === null || typeof block !== "object") continue;
				const candidate = block;
				if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
			}
			return parts.length > 0 ? parts.join("\n") : void 0;
		}
		/**
		* Fold a history tail into the last text output + last tool call (each is
		* the LAST occurrence in event order). Lifecycle events and raw
		* `assistant/chunk` rows are ignored — the card shows what the subagent is
		* doing right now, not its plumbing.
		* @param entries - the tail page from `subagent.history` (oldest → newest).
		* @returns the last text and/or tool call; an empty object when the tail has neither.
		*/
		function lastActivity(entries) {
			let text;
			let tool;
			for (const entry of entries) {
				const { type, data } = entry.event;
				if (type === "assistant/message") {
					const message = data.message;
					const extracted = contentText(message?.content);
					if (extracted !== void 0) text = extracted;
				} else if (type === "tool/call") tool = {
					name: typeof data.name === "string" ? data.name : "tool",
					args: typeof data.arguments === "string" ? data.arguments : ""
				};
			}
			if (text === void 0 && tool === void 0) return {};
			return {
				...text === void 0 ? {} : { text },
				...tool === void 0 ? {} : { tool }
			};
		}
		//#endregion
		//#region src/client/subagent-jobs.ts
		/** Whether the registry still holds the job open (its duration ticks). */
		function isJobLive(job) {
			return job.status === "running" || job.status === "stopping";
		}
		/**
		* Every session id of the topology tree rooted at `rootId` (the root plus
		* each session whose uninterrupted subagent-origin chain reaches it — same
		* lineage semantics as {@link countSubagentDescendants}; cycles fail soft).
		* Sessions outside the tree (orphans, other trees) are excluded, so the
		* jobs section never shows foreign work.
		*/
		function treeSessionIds(byId, rootId) {
			const ids = /* @__PURE__ */ new Set();
			if (rootId === void 0) return ids;
			for (const summary of Object.values(byId)) {
				const seen = /* @__PURE__ */ new Set();
				let current = summary;
				let reachesRoot = false;
				while (current !== void 0 && !seen.has(current.id)) {
					seen.add(current.id);
					if (current.id === rootId) {
						reachesRoot = true;
						break;
					}
					if (current.origin !== "subagent" || current.parentId === void 0) break;
					current = byId[current.parentId];
				}
				if (reachesRoot) ids.add(summary.id);
			}
			return ids;
		}
		/**
		* Whether a NEW background job appeared for one session between two
		* consecutive list snapshots (a job id the previous snapshot lacked).
		* Unlike the subagent auto-open (0 → N only), ANY new job id triggers: the
		* agent may start several jobs over a session, and each new one should
		* surface the Jobs page (a fresh page load never triggers — its baseline
		* starts at the current snapshot).
		*/
		function detectNewJob(prev, next, sessionId) {
			const prevIds = new Set((prev.jobsBySession?.[sessionId] ?? []).map((job) => job.id));
			return (next.jobsBySession?.[sessionId] ?? []).some((job) => !prevIds.has(job.id));
		}
		/**
		* Collect the background jobs of the whole current tree, owner-labeled.
		* Sessions without a mirror entry contribute nothing; an absent mirror
		* (runtime older than the jobs feed) yields an empty list.
		*/
		function collectTreeJobs(byId, jobsBySession, rootId) {
			const rows = [];
			if (jobsBySession === void 0) return rows;
			for (const sessionId of treeSessionIds(byId, rootId)) {
				const jobs = jobsBySession[sessionId];
				if (jobs === void 0 || jobs.length === 0) continue;
				const ownerTitle = byId[sessionId]?.displayTitle ?? sessionId;
				for (const job of jobs) rows.push({
					ownerSessionId: sessionId,
					ownerTitle,
					job
				});
			}
			return rows;
		}
		/**
		* Live rows first in start order, then settled rows newest-first (mirror of
		* the official ui-jobs ordering); a tie falls back to start order so the
		* sort never depends on the host's map iteration.
		*/
		function orderJobs(rows) {
			return [...rows].sort((left, right) => {
				const liveLeft = isJobLive(left.job);
				if (liveLeft !== isJobLive(right.job)) return liveLeft ? -1 : 1;
				if (liveLeft) return left.job.startedAt - right.job.startedAt;
				const finished = (right.job.finishedAt ?? right.job.startedAt) - (left.job.finishedAt ?? left.job.startedAt);
				return finished !== 0 ? finished : left.job.startedAt - right.job.startedAt;
			});
		}
		/**
		* Status marker semantics. `stopping` and `killed` share the attention
		* color: both mean the work ended (or is ending) on request rather than on
		* its own.
		*/
		function jobDotState(status) {
			switch (status) {
				case "running": return "ongoing";
				case "stopping": return "warning";
				case "completed": return "done";
				case "killed": return "warning";
				case "failed": return "error";
			}
		}
		/** Human status word of one wire status (localized through the passed translator). */
		function jobStatusLabel(status, t) {
			switch (status) {
				case "running": return t("jobStatusRunning");
				case "stopping": return t("jobStatusStopping");
				case "completed": return t("jobStatusCompleted");
				case "killed": return t("jobStatusKilled");
				case "failed": return t("jobStatusFailed");
			}
		}
		/**
		* Elapsed time in at most two adjacent units (mirror of the official
		* ui-jobs duration wording). A background job that outlives an hour is
		* already exceptional, so hours is the widest unit.
		*/
		function formatJobDuration(elapsedMs, t) {
			const total = Math.max(0, Math.floor(elapsedMs / 1e3));
			const seconds = total % 60;
			const minutes = Math.floor(total / 60) % 60;
			const hours = Math.floor(total / 3600);
			if (hours > 0) return t("jobDurationHours", {
				hours,
				minutes
			});
			if (minutes > 0) return t("jobDurationMinutes", {
				minutes,
				seconds
			});
			return t("jobDurationSeconds", { seconds });
		}
		//#endregion
		//#region src/client/icons.tsx
		/**
		* Right-panel toggle glyph (the "侧拉" button): a frame with a filled strip
		* along its RIGHT edge, in the app's outline style (1.5px stroke,
		* currentColor).
		*/
		const IconPanelRightOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "1.5",
				y: "2",
				width: "13",
				height: "12",
				rx: "2.5",
				stroke: "currentColor",
				strokeWidth: "1.5"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "10.5",
				y: "3.25",
				width: "2.75",
				height: "9.5",
				rx: "1",
				fill: "currentColor",
				stroke: "none"
			})]
		});
		/**
		* Bottom-panel toggle glyph (the "底栏" button): a frame with a filled strip
		* along its BOTTOM edge, in the app's outline style.
		*/
		const IconPanelBottomOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "1.5",
				y: "2",
				width: "13",
				height: "12",
				rx: "2.5",
				stroke: "currentColor",
				strokeWidth: "1.5"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "3.25",
				y: "10",
				width: "9.5",
				height: "2.75",
				rx: "1",
				fill: "currentColor",
				stroke: "none"
			})]
		});
		/**
		* Terminal glyph in the app's outline style (1.5px stroke, currentColor):
		* a rounded frame with a prompt chevron and underscore cursor.
		*/
		const IconTerminalOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "1.5",
					y: "2.5",
					width: "13",
					height: "11",
					rx: "2",
					stroke: "currentColor",
					strokeWidth: "1.5"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M4.5 6.25 6.75 8 4.5 9.75",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M8.5 10.4h3",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round"
				})
			]
		});
		/** Diff glyph in the app's outline style: a file frame with a plus and a minus row. */
		const IconDiffOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "1.5",
					y: "1.5",
					width: "13",
					height: "13",
					rx: "2.5",
					stroke: "currentColor",
					strokeWidth: "1.5"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M4 5h3M5.5 3.5v3",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M9.5 12.5h2.5",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round"
				})
			]
		});
		/**
		* Stop glyph for the background-job kill button: a filled square in the
		* app's outline scale (16), the universal "halt this work" mark.
		*/
		const IconStopOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "4",
				y: "4",
				width: "8",
				height: "8",
				rx: "1.5",
				fill: "currentColor",
				stroke: "none"
			})
		});
		/** Image viewer glyph: a picture frame with a sun and a mountain. */
		const IconImageOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "1.5",
					y: "2.5",
					width: "13",
					height: "11",
					rx: "2",
					stroke: "currentColor",
					strokeWidth: "1.5"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "5.5",
					cy: "6",
					r: "1.2",
					stroke: "currentColor",
					strokeWidth: "1.5"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "m3.5 12 3-3 2.25 2.25L11.5 8.5 13 10.5",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			]
		});
		/** PDF viewer glyph: a document frame with the "PDF" label. */
		const IconPdfOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M3.5 1.5h6.5L13.5 5v9.5h-10z",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinejoin: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M9.5 1.5V5h4",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinejoin: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M5 13.5v-3h1.4c.75 0 1.1.32 1.1.85 0 .54-.35.85-1.1.85H5.3",
					stroke: "currentColor",
					strokeWidth: "1.25",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M8.3 13.5v-3h1.05c.8 0 1.35.5 1.35 1.5s-.55 1.5-1.35 1.5z",
					stroke: "currentColor",
					strokeWidth: "1.25",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M11.6 13.5v-3h1.3",
					stroke: "currentColor",
					strokeWidth: "1.25",
					strokeLinecap: "round"
				})
			]
		});
		/** Markdown viewer glyph: the classic "M with a down arrow" badge. */
		const IconMarkdownOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "1.5",
				y: "2.5",
				width: "13",
				height: "11",
				rx: "2",
				stroke: "currentColor",
				strokeWidth: "1.5"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M4 10.5V5.5l2 2.5 2-2.5v5M9.5 10.5v-5l2 2.5 2-2.5v5",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				strokeLinejoin: "round"
			})]
		});
		/** HTML viewer glyph: a document frame with a "‹/›" tag pair. */
		const IconHtmlOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M3.5 1.5h6.5L13.5 5v9.5h-10z",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinejoin: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M9.5 1.5V5h4",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinejoin: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M5.6 13.2 4.2 10l1.4-3.2M7.4 6.8 8.8 10l-1.4 3.2",
					stroke: "currentColor",
					strokeWidth: "1.25",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			]
		});
		/** Browser tab glyph: a globe with meridians. */
		const IconGlobeOutline16 = ({ size = 16, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 16 16",
			fill: "none",
			xmlns: "http://www.w3.org/2000/svg",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "8",
					r: "6.5",
					stroke: "currentColor",
					strokeWidth: "1.5"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ellipse", {
					cx: "8",
					cy: "8",
					rx: "2.8",
					ry: "6.5",
					stroke: "currentColor",
					strokeWidth: "1.5"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M1.5 8h13M8 1.5c-2.4 1.8-2.4 11.2 0 13M8 1.5c2.4 1.8 2.4 11.2 0 13",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round"
				})
			]
		});
		//#endregion
		//#region \0dsh-css:C:\Users\delinger\Desktop\dsh\_upstream2\DSH-better-sidebar\src\client\SubagentView.module.css.mjs
		const css$2 = "._Yq-tG_subagent{flex-direction:column;flex:1;min-height:0;display:flex}._Yq-tG_subagentHeader{flex:none;align-items:center;gap:8px;height:36px;padding:0 8px 0 12px;display:flex}._Yq-tG_subagentTitle{min-width:0;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}._Yq-tG_subagentCount{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);flex:none}._Yq-tG_subagentRefresh{width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;justify-content:center;align-items:center;display:inline-flex}._Yq-tG_subagentRefresh:hover{background:var(--dsw-alias-interactive-bg-hover)}._Yq-tG_subagentBody{flex:1;min-height:0;padding:2px 6px 8px;overflow-y:auto}._Yq-tG_subagentRow{box-sizing:border-box;width:100%;min-height:50px;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;outline:none;align-items:flex-start;gap:8px;padding:7px 8px 7px 11px;display:flex;position:relative}._Yq-tG_subagentRow:hover,._Yq-tG_subagentRow:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}._Yq-tG_subagentRowActive,._Yq-tG_subagentRowActive:hover,._Yq-tG_subagentRowActive:focus-visible{background:var(--dsw-alias-interactive-bg-active)}._Yq-tG_subagentRowDisabled{color:var(--dsw-alias-label-dimmed);cursor:not-allowed}._Yq-tG_subagentRowDisabled:hover{background:0 0}._Yq-tG_subagentRowLoading{cursor:default}._Yq-tG_subagentDot{margin-top:4px}._Yq-tG_subagentContent{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}._Yq-tG_subagentLabel,._Yq-tG_subagentSecondary{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._Yq-tG_subagentLabel{color:inherit;font-weight:400}._Yq-tG_subagentSecondary{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}._Yq-tG_subagentLive{min-width:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:4px;display:flex;overflow:hidden}._Yq-tG_subagentLiveTool{font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-secondary);flex:none}._Yq-tG_subagentLiveArgs{min-width:0;font-family:var(--ds-font-family-code);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._Yq-tG_subagentLiveText{-webkit-line-clamp:2;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}._Yq-tG_subagentNode{min-width:0;position:relative}._Yq-tG_subagentChildren{margin-left:18px;padding-left:4px;position:relative}._Yq-tG_subagentChildren:before{content:\"\";border-left:1px solid var(--dsw-alias-border-l2);height:26px;position:absolute;top:-26px;left:0}._Yq-tG_subagentChildren[aria-busy=true]:before{content:none}._Yq-tG_subagentChildren>._Yq-tG_subagentNode:before{content:\"\";border-left:1px solid var(--dsw-alias-border-l2);position:absolute;top:0;bottom:0;left:-4px}._Yq-tG_subagentChildren>._Yq-tG_subagentNode:last-child:before{height:17px;bottom:auto}._Yq-tG_subagentChildren>._Yq-tG_subagentNode>._Yq-tG_subagentRow:before{content:\"\";border-top:1px solid var(--dsw-alias-border-l2);width:14px;position:absolute;top:16px;left:-4px}._Yq-tG_subagentEmpty{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);text-align:center;flex-direction:column;gap:2px;padding:16px;display:flex}._Yq-tG_subagentEmptyHint{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-dimmed)}._Yq-tG_subagentError{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;display:flex}._Yq-tG_subagentErrorRetry{height:24px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-strong-11);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;align-items:center;gap:4px;padding:0 8px;display:inline-flex}._Yq-tG_subagentErrorRetry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}._Yq-tG_jobs{border-top:1px solid var(--dsw-alias-border-l2);margin-top:10px;padding-top:8px}._Yq-tG_jobsHeader{align-items:center;gap:8px;height:26px;padding:0 2px;display:flex}._Yq-tG_jobsTitle{min-width:0;font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}._Yq-tG_jobsCount{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);flex:none}._Yq-tG_jobsList{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}._Yq-tG_jobsRow{border-radius:8px;align-items:center;gap:4px;display:flex}._Yq-tG_jobsRow:hover{background:var(--dsw-alias-interactive-bg-hover)}._Yq-tG_jobsRowSettled{opacity:.8}._Yq-tG_jobsRowSelected,._Yq-tG_jobsRowSelected:hover{background:var(--dsw-alias-interactive-bg-active)}._Yq-tG_jobsRowMain{min-width:0;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;outline:none;flex:1;align-items:flex-start;gap:8px;padding:6px 8px 6px 11px;display:flex}._Yq-tG_jobsRowMain:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}._Yq-tG_jobsDot{margin-top:5px}._Yq-tG_jobsContent{flex-direction:column;gap:1px;min-width:0;display:flex}._Yq-tG_jobsLabelLine{align-items:center;gap:6px;min-width:0;display:flex}._Yq-tG_jobsKind{text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);max-width:90px;font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-tertiary);border-radius:4px;flex:none;padding:0 5px;line-height:14px;overflow:hidden}._Yq-tG_jobsLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-family:var(--ds-font-family-code);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-primary);flex:1;overflow:hidden}._Yq-tG_jobsSecondary{text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);overflow:hidden}._Yq-tG_jobsKill{width:22px;height:22px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;justify-content:center;align-items:center;margin-right:4px;display:inline-flex}._Yq-tG_jobsKill:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}._Yq-tG_jobsKillArmed,._Yq-tG_jobsKillArmed:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);width:auto;height:20px;color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxxs-strong-11);white-space:nowrap;padding:0 8px}._Yq-tG_jobsKill:disabled{opacity:.5;cursor:default}._Yq-tG_jobsKillError{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-error-primary);flex:none;margin-right:4px}._Yq-tG_jobsPane{z-index:1;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:8px;margin-top:4px;position:sticky;bottom:0;overflow:hidden;box-shadow:0 -6px 12px -8px #00000059}._Yq-tG_jobsPaneHeader{border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;gap:6px;height:28px;padding:0 4px 0 10px;display:flex}._Yq-tG_jobsPaneDot{flex:none}._Yq-tG_jobsPaneLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-family:var(--ds-font-family-code);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-primary);flex:1;overflow:hidden}._Yq-tG_jobsPaneStatus{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);flex:none}._Yq-tG_jobsPaneClose{width:20px;height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:5px;flex:none;justify-content:center;align-items:center;display:inline-flex}._Yq-tG_jobsPaneClose:hover{background:var(--dsw-alias-interactive-bg-hover)}._Yq-tG_jobsPanePre{max-height:200px;font-family:var(--ds-font-family-code);font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;margin:0;padding:6px 10px;line-height:1.5;overflow:auto}._Yq-tG_jobsPaneHint{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);padding:8px 10px}._Yq-tG_jobsPaneError{color:var(--dsw-alias-state-error-primary)}";
		const tagId$2 = "dsh-better-sidebar/SubagentView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-better-sidebar";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var SubagentView_module_css_default = {
			"jobsLabelLine": "_Yq-tG_jobsLabelLine",
			"jobsCount": "_Yq-tG_jobsCount",
			"jobsHeader": "_Yq-tG_jobsHeader",
			"subagentContent": "_Yq-tG_subagentContent",
			"subagentRowActive": "_Yq-tG_subagentRowActive",
			"subagentRowDisabled": "_Yq-tG_subagentRowDisabled",
			"jobsRowSelected": "_Yq-tG_jobsRowSelected",
			"jobsPaneHeader": "_Yq-tG_jobsPaneHeader",
			"subagentDot": "_Yq-tG_subagentDot",
			"subagentLiveText": "_Yq-tG_subagentLiveText",
			"subagentEmpty": "_Yq-tG_subagentEmpty",
			"jobsLabel": "_Yq-tG_jobsLabel",
			"subagentLiveTool": "_Yq-tG_subagentLiveTool",
			"subagentLabel": "_Yq-tG_subagentLabel",
			"subagentHeader": "_Yq-tG_subagentHeader",
			"jobsKillError": "_Yq-tG_jobsKillError",
			"subagentRowLoading": "_Yq-tG_subagentRowLoading",
			"subagentLive": "_Yq-tG_subagentLive",
			"subagentEmptyHint": "_Yq-tG_subagentEmptyHint",
			"jobsList": "_Yq-tG_jobsList",
			"subagentError": "_Yq-tG_subagentError",
			"jobsPaneDot": "_Yq-tG_jobsPaneDot",
			"jobsContent": "_Yq-tG_jobsContent",
			"jobsPaneError": "_Yq-tG_jobsPaneError",
			"jobsSecondary": "_Yq-tG_jobsSecondary",
			"subagent": "_Yq-tG_subagent",
			"jobsPaneHint": "_Yq-tG_jobsPaneHint",
			"jobsPaneStatus": "_Yq-tG_jobsPaneStatus",
			"subagentNode": "_Yq-tG_subagentNode",
			"subagentBody": "_Yq-tG_subagentBody",
			"subagentCount": "_Yq-tG_subagentCount",
			"subagentErrorRetry": "_Yq-tG_subagentErrorRetry",
			"subagentSecondary": "_Yq-tG_subagentSecondary",
			"subagentChildren": "_Yq-tG_subagentChildren",
			"jobsTitle": "_Yq-tG_jobsTitle",
			"jobs": "_Yq-tG_jobs",
			"jobsRowSettled": "_Yq-tG_jobsRowSettled",
			"jobsRowMain": "_Yq-tG_jobsRowMain",
			"jobsKill": "_Yq-tG_jobsKill",
			"jobsKillArmed": "_Yq-tG_jobsKillArmed",
			"subagentLiveArgs": "_Yq-tG_subagentLiveArgs",
			"jobsPane": "_Yq-tG_jobsPane",
			"subagentRefresh": "_Yq-tG_subagentRefresh",
			"subagentTitle": "_Yq-tG_subagentTitle",
			"jobsPaneLabel": "_Yq-tG_jobsPaneLabel",
			"jobsPaneClose": "_Yq-tG_jobsPaneClose",
			"jobsDot": "_Yq-tG_jobsDot",
			"jobsPanePre": "_Yq-tG_jobsPanePre",
			"subagentRow": "_Yq-tG_subagentRow",
			"jobsRow": "_Yq-tG_jobsRow",
			"jobsKind": "_Yq-tG_jobsKind"
		};
		//#endregion
		//#region src/client/SubagentView.tsx
		/**
		* Subagent page: the FULL agent topology of the current tree's main session.
		*
		* The root is resolved by walking the durable parent chain upward from the
		* current session to the first non-subagent session — the MAIN session — and
		* every subagent under it shares this one topology view, no matter how deep
		* the current selection is (including a subagent transcript opened in the
		* main view). The main agent renders as the root node card (click it to jump
		* back to the main session), with its subagents hanging below it in clearly
		* LAYERED levels: tree connector lines (first level included) and per-level
		* indentation show the hierarchy, and the currently-open session is
		* highlighted in place. Every branch is expanded automatically (lazy
		* catalogs hydrate on demand and consume live membership while visible).
		*
		* Each node card carries live status (state dot, durable label, mode and
		* activity); while a child RUNS, its card additionally shows the LAST text
		* output and LAST tool call pulled from its history tail, auto-refreshing
		* every few seconds while the page is visible. Clicking a card jumps
		* straight into the child transcript (`openSubagent`); the page stays open
		* and the topology remains rooted at the main session.
		*/
		/** Refresh cadence of the live "last text + tool call" lines while a child runs. */
		const POLL_MS = 3e3;
		/** Preview cap of one tool-call argument line. */
		const ARGS_PREVIEW = 60;
		/** Refresh cadence of an expanded job-output panel while its job runs. */
		const JOB_POLL_MS = 2e3;
		/** How long the kill button stays armed before it needs re-confirming. */
		const JOB_KILL_ARM_MS = 3e3;
		/** The direct subagent children of one parent (durable `origin` rows). */
		function directChildren(byId, parentSessionId) {
			return Object.values(byId).filter((summary) => summary.origin === "subagent" && summary.parentId === parentSessionId);
		}
		/** Human label of one catalog child: durable label, then summary title, then id. */
		function childLabel(entry, summary) {
			return entry.label ?? summary?.displayTitle ?? entry.id;
		}
		function diagnosticReason(entry) {
			switch (entry.reason) {
				case "corrupt": return t("subagentDiagCorrupt");
				case "unsupported": return t("subagentDiagUnsupported");
				case "unavailable": return t("subagentDiagUnavailable");
			}
		}
		/** The secondary line of one card: title · mode · activity (skips empty parts). */
		function cardSecondary(summary, entry) {
			return [
				summary?.displayTitle,
				entry.mode === "one-shot" ? t("subagentModeOneShot") : t("subagentModeContinuable"),
				entry.activity === "running" ? t("subagentRunning") : t("subagentInactive")
			].filter(Boolean).join(" · ");
		}
		/** First `limit` characters with an ellipsis when truncated. */
		function preview(text, limit) {
			return text.length > limit ? `${text.slice(0, limit)}…` : text;
		}
		/** Collapse whitespace for the single-paragraph live-text preview. */
		function flatten(text) {
			return text.replace(/\s+/g, " ").trim();
		}
		/** Disabled "loading…" cards backed by the summary mirror while a catalog hydrates. */
		function CatalogLoadingRows(props) {
			const { parentSessionId, byId, level } = props;
			const children = directChildren(byId, parentSessionId);
			if (children.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: SubagentView_module_css_default.subagentEmpty,
				children: t("loading")
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: children.map((summary) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "treeitem",
				"aria-disabled": "true",
				"aria-level": level,
				"aria-label": t("loading"),
				className: `${SubagentView_module_css_default.subagentRow} ${SubagentView_module_css_default.subagentRowDisabled} ${SubagentView_module_css_default.subagentRowLoading}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
					state: summary.running === true ? "ongoing" : "done",
					className: SubagentView_module_css_default.subagentDot
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: SubagentView_module_css_default.subagentContent,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SubagentView_module_css_default.subagentLabel,
						children: t("loading")
					})
				})]
			}, summary.id)) });
		}
		/**
		* The live lines of one RUNNING subagent card: the last text output and the
		* last tool call of the child's history tail, refreshed every few seconds
		* while the page is visible. Idle cards render nothing (a quiet topology); a
		* running child with neither output yet reads "thinking…".
		*/
		function SubagentLiveLines(props) {
			const { ctx, parentSessionId, childSessionId, mode, running, active } = props;
			const [live, setLive] = (0, react.useState)({});
			const controllerRef = (0, react.useRef)(void 0);
			const address = (0, react.useMemo)(() => ({
				parentSessionId,
				childSessionId,
				mode
			}), [
				parentSessionId,
				childSessionId,
				mode
			]);
			const load = (0, react.useCallback)(async () => {
				controllerRef.current?.abort();
				const controller = new AbortController();
				controllerRef.current = controller;
				try {
					const response = await ctx.connection.api.subagents.history({
						...address,
						maxMessages: 12
					}, controller.signal);
					if (!response.result.ok) return;
					setLive(lastActivity(response.result.value.events));
				} catch {}
			}, [ctx, address]);
			(0, react.useEffect)(() => {
				if (!active) return;
				load();
				if (!running) return;
				const timer = window.setInterval(() => {
					load();
				}, POLL_MS);
				return () => {
					window.clearInterval(timer);
				};
			}, [
				load,
				running,
				active
			]);
			(0, react.useEffect)(() => () => {
				controllerRef.current?.abort();
			}, []);
			if (!running) return null;
			if (live.text === void 0 && live.tool === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: SubagentView_module_css_default.subagentLive,
				children: t("subagentThinking")
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [live.tool !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: SubagentView_module_css_default.subagentLive,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: SubagentView_module_css_default.subagentLiveTool,
					children: live.tool.name
				}), live.tool.args !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: SubagentView_module_css_default.subagentLiveArgs,
					children: preview(live.tool.args, ARGS_PREVIEW)
				})]
			}), live.text !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: SubagentView_module_css_default.subagentLiveText,
				children: flatten(live.text)
			})] });
		}
		/** Render one topology level; branches are always expanded (lazy catalogs). */
		function CatalogRows({ parentSessionId, catalog, catalogs, byId, level, currentSessionId, active, ctx, openChild, refresh }) {
			const emptyLoading = catalog?.state === "loading" && catalog.entries.length === 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				emptyLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CatalogLoadingRows, {
					parentSessionId,
					byId,
					level
				}),
				catalog?.state === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: SubagentView_module_css_default.subagentError,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: catalog.error?.message ?? t("error") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: SubagentView_module_css_default.subagentErrorRetry,
						onClick: () => {
							refresh(parentSessionId);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline14, {}), t("retry")]
					})]
				}),
				(catalog?.entries ?? []).map((entry) => {
					if (entry.kind === "diagnostic") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: SubagentView_module_css_default.subagentNode,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							role: "treeitem",
							"aria-disabled": "true",
							"aria-level": level,
							className: `${SubagentView_module_css_default.subagentRow} ${SubagentView_module_css_default.subagentRowDisabled}`,
							title: diagnosticReason(entry),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
								state: "error",
								className: SubagentView_module_css_default.subagentDot
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: SubagentView_module_css_default.subagentContent,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SubagentView_module_css_default.subagentLabel,
									children: entry.id
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SubagentView_module_css_default.subagentSecondary,
									children: diagnosticReason(entry)
								})]
							})]
						})
					}, entry.id);
					const childCatalog = catalogs[entry.id];
					const knownLeaf = !entry.hasChildren;
					const summary = byId[entry.id];
					const label = childLabel(entry, summary);
					const secondary = cardSecondary(summary, entry);
					const childLoading = childCatalog === void 0 || childCatalog.state === "loading" && childCatalog.entries.length === 0;
					const address = {
						parentSessionId,
						childSessionId: entry.id,
						mode: entry.mode
					};
					const current = entry.id === currentSessionId;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: SubagentView_module_css_default.subagentNode,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							role: "treeitem",
							tabIndex: 0,
							"aria-level": level,
							"aria-label": `${label} ${secondary}`,
							"aria-current": current ? "true" : void 0,
							...knownLeaf ? {} : { "aria-expanded": true },
							className: clsx(SubagentView_module_css_default.subagentRow, current && SubagentView_module_css_default.subagentRowActive),
							onClick: () => {
								openChild(address);
							},
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									event.stopPropagation();
									openChild(address);
								}
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
								state: entry.activity === "running" ? "ongoing" : "done",
								className: SubagentView_module_css_default.subagentDot
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: SubagentView_module_css_default.subagentContent,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SubagentView_module_css_default.subagentLabel,
										children: label
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SubagentView_module_css_default.subagentSecondary,
										children: secondary
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SubagentLiveLines, {
										ctx,
										parentSessionId,
										childSessionId: entry.id,
										mode: entry.mode,
										running: entry.activity === "running",
										active
									})
								]
							})]
						}), !knownLeaf && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							role: "group",
							className: SubagentView_module_css_default.subagentChildren,
							"aria-busy": childLoading || void 0,
							children: childCatalog === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CatalogLoadingRows, {
								parentSessionId: entry.id,
								byId,
								level: level + 1
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CatalogRows, {
								parentSessionId: entry.id,
								catalog: childCatalog,
								catalogs,
								byId,
								level: level + 1,
								currentSessionId,
								active,
								ctx,
								openChild,
								refresh
							})
						})]
					}, entry.id);
				})
			] });
		}
		/**
		* The shared output dock of the jobs section: ONE pane at the bottom of the
		* sidebar body (sticky, terminal-like) shows the SELECTED job's output as
		* the MODEL has read it so far (replayed from the owner session's event
		* log), refreshed every {@link JOB_POLL_MS} while the job runs and the
		* page is visible. The model's `job_output` cursor is never touched — the
		* pane can never steal the agent's bytes, and it stays empty until the
		* agent reads the job. A single dock — not a panel per row — keeps the
		* job list compact and stable when many jobs are running.
		*/
		function JobOutputPane(props) {
			const { ownerSessionId, job, active, onClose } = props;
			const [state, setState] = (0, react.useState)("loading");
			const controllerRef = (0, react.useRef)(void 0);
			const preRef = (0, react.useRef)(null);
			const load = (0, react.useCallback)(async () => {
				controllerRef.current?.abort();
				const controller = new AbortController();
				controllerRef.current = controller;
				try {
					const result = await api.jobOutput({ sessionId: ownerSessionId }, job.id, controller.signal);
					setState(result);
				} catch {
					setState((current) => current === "loading" ? "error" : current);
				}
			}, [ownerSessionId, job.id]);
			(0, react.useEffect)(() => {
				load();
				if (!active || !isJobLive(job)) return;
				const timer = window.setInterval(() => {
					load();
				}, JOB_POLL_MS);
				return () => {
					window.clearInterval(timer);
				};
			}, [
				load,
				active,
				job.status
			]);
			(0, react.useEffect)(() => () => {
				controllerRef.current?.abort();
			}, []);
			(0, react.useEffect)(() => {
				if (!isJobLive(job) || typeof state !== "object" || state.text.length === 0) return;
				const pre = preRef.current;
				if (pre !== null) pre.scrollTop = pre.scrollHeight;
			}, [state, job.status]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: SubagentView_module_css_default.jobsPane,
				role: "region",
				"aria-label": `${job.label} ${t("jobs")}`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: SubagentView_module_css_default.jobsPaneHeader,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
								state: jobDotState(job.status),
								className: SubagentView_module_css_default.jobsPaneDot
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SubagentView_module_css_default.jobsPaneLabel,
								title: job.label,
								children: job.label
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: SubagentView_module_css_default.jobsPaneStatus,
								children: [jobStatusLabel(job.status, t), job.detail !== void 0 && job.detail !== "" ? ` · ${job.detail}` : ""]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: SubagentView_module_css_default.jobsPaneClose,
								"aria-label": t("close"),
								title: t("close"),
								onClick: onClose,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconStopOutline16, { size: 10 })
							})
						]
					}),
					state === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: SubagentView_module_css_default.jobsPaneHint,
						children: t("loading")
					}),
					state === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: `${SubagentView_module_css_default.jobsPaneHint} ${SubagentView_module_css_default.jobsPaneError}`,
						children: t("jobOutputError")
					}),
					typeof state === "object" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [state.text.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						ref: preRef,
						className: SubagentView_module_css_default.jobsPanePre,
						children: state.text
					}) : state.read ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: SubagentView_module_css_default.jobsPaneHint,
						children: t("jobNoOutput")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: SubagentView_module_css_default.jobsPaneHint,
						children: t("jobNotReadYet")
					}), state.truncated && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: SubagentView_module_css_default.jobsPaneHint,
						children: t("jobOutputTruncated")
					})] })
				]
			});
		}
		/**
		* The background-job section of the Subagent page: every job of the whole
		* current tree (main agent + subagents, owner-labeled), fed by the harness
		* `session/jobs` push mirror. Clicking a row feeds its model-read output to
		* the shared bottom dock (event replay — never the model's cursor); live
		* rows carry a two-click-confirm kill button. Renders nothing while the
		* tree has no jobs.
		*/
		function JobsSection(props) {
			const { byId, jobsBySession, rootId, active } = props;
			const rows = (0, react.useMemo)(() => orderJobs(collectTreeJobs(byId, jobsBySession, rootId)), [
				byId,
				jobsBySession,
				rootId
			]);
			const [selectedId, setSelectedId] = (0, react.useState)(void 0);
			const [armedId, setArmedId] = (0, react.useState)(void 0);
			const [killingId, setKillingId] = (0, react.useState)(void 0);
			const [killErrorId, setKillErrorId] = (0, react.useState)(void 0);
			const [now, setNow] = (0, react.useState)(() => Date.now());
			const selectedRow = (0, react.useMemo)(() => selectedId === void 0 ? void 0 : rows.find((row) => row.job.id === selectedId), [rows, selectedId]);
			const liveCount = (0, react.useMemo)(() => rows.reduce((count, row) => count + (isJobLive(row.job) ? 1 : 0), 0), [rows]);
			const multiOwner = (0, react.useMemo)(() => new Set(rows.map((row) => row.ownerSessionId)).size > 1, [rows]);
			(0, react.useEffect)(() => {
				if (armedId === void 0) return;
				const timer = window.setTimeout(() => {
					setArmedId(void 0);
				}, JOB_KILL_ARM_MS);
				return () => {
					window.clearTimeout(timer);
				};
			}, [armedId]);
			(0, react.useEffect)(() => {
				if (liveCount === 0) return;
				setNow(Date.now());
				const timer = window.setInterval(() => {
					setNow(Date.now());
				}, 1e3);
				return () => {
					window.clearInterval(timer);
				};
			}, [liveCount]);
			(0, react.useEffect)(() => {
				if (selectedId !== void 0 && selectedRow === void 0) setSelectedId(void 0);
			}, [selectedId, selectedRow]);
			const kill = (0, react.useCallback)(async (row) => {
				setKillingId(row.job.id);
				setKillErrorId(void 0);
				try {
					await api.jobKill({ sessionId: row.ownerSessionId }, row.job.id);
				} catch {
					setKillErrorId(row.job.id);
				} finally {
					setKillingId(void 0);
					setArmedId(void 0);
				}
			}, []);
			if (rows.length === 0) return null;
			const countLabel = liveCount > 0 ? t("jobsCountRunning", {
				count: rows.length,
				running: liveCount
			}) : t("jobsCount", { count: rows.length });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: SubagentView_module_css_default.jobs,
				"aria-label": t("jobs"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: SubagentView_module_css_default.jobsHeader,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SubagentView_module_css_default.jobsTitle,
						children: t("jobs")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SubagentView_module_css_default.jobsCount,
						children: countLabel
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: SubagentView_module_css_default.jobsList,
					"aria-label": t("jobs"),
					children: rows.map((row) => {
						const { job } = row;
						const live = isJobLive(job);
						const selected = selectedId === job.id;
						const armed = armedId === job.id;
						const killing = killingId === job.id;
						const killFailed = killErrorId === job.id;
						const elapsed = live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt;
						const secondary = [
							...multiOwner ? [row.ownerTitle] : [],
							jobStatusLabel(job.status, t),
							...job.detail !== void 0 && job.detail !== "" ? [job.detail] : [],
							formatJobDuration(elapsed, t)
						].filter(Boolean).join(" · ");
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: clsx(SubagentView_module_css_default.jobsRow, !live && SubagentView_module_css_default.jobsRowSettled, selected && SubagentView_module_css_default.jobsRowSelected),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: SubagentView_module_css_default.jobsRowMain,
									"aria-pressed": selected,
									"aria-label": `${job.label} ${secondary}`,
									onClick: () => {
										setSelectedId(selected ? void 0 : job.id);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
										state: jobDotState(job.status),
										className: SubagentView_module_css_default.jobsDot
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: SubagentView_module_css_default.jobsContent,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: SubagentView_module_css_default.jobsLabelLine,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: SubagentView_module_css_default.jobsKind,
												children: job.kind
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: SubagentView_module_css_default.jobsLabel,
												title: job.label,
												children: job.label
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: SubagentView_module_css_default.jobsSecondary,
											children: secondary
										})]
									})]
								}),
								job.status === "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: armed ? `${SubagentView_module_css_default.jobsKill} ${SubagentView_module_css_default.jobsKillArmed}` : SubagentView_module_css_default.jobsKill,
									"aria-label": armed ? t("jobKillConfirm") : t("jobKill"),
									title: armed ? t("jobKillConfirm") : t("jobKill"),
									disabled: killing,
									onClick: (event) => {
										event.stopPropagation();
										if (armed) kill(row);
										else setArmedId(job.id);
									},
									children: armed ? t("jobKillConfirm") : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconStopOutline16, { size: 12 })
								}),
								killFailed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SubagentView_module_css_default.jobsKillError,
									children: t("jobKillError")
								})
							]
						}, job.id);
					})
				})]
			}), selectedRow !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobOutputPane, {
				ownerSessionId: selectedRow.ownerSessionId,
				job: selectedRow.job,
				active,
				onClose: () => {
					setSelectedId(void 0);
				}
			})] });
		}
		/**
		* The sidebar's Subagent topology page.
		* @param props - current session id, whether the page is actually visible
		*   (active tab + open panel), the client context, and an optional
		*   jump-notify hook fired right before `openSubagent` (lets the sidebar
		*   shell re-open the Subagent page after the conversation switch lands on
		*   the child session).
		* @returns the main agent's topology tree, or the empty/error/loading states.
		*/
		function SubagentView(props) {
			const { sessionId, active, ctx, onOpenChild } = props;
			const sessions = ctx.sessions;
			const list = (0, react.useSyncExternalStore)((0, react.useMemo)(() => (callback) => sessions.list.subscribe(callback), [sessions]), (0, react.useCallback)(() => sessions.list.getSnapshot(), [sessions]));
			const byId = list.byId;
			const catalogs = list.subagentsByParent ?? {};
			const rootId = (0, react.useMemo)(() => rootAncestor(byId, sessionId), [byId, sessionId]);
			const rootCatalog = rootId === void 0 ? void 0 : catalogs[rootId];
			const rootSummary = rootId === void 0 ? void 0 : byId[rootId];
			/** Catalog owners currently consuming live membership updates. */
			const observedRef = (0, react.useRef)(/* @__PURE__ */ new Set());
			const observe = (0, react.useCallback)((parentSessionId, open) => {
				sessions.setSubagentCatalogOpen?.(parentSessionId, open);
				if (open) observedRef.current.add(parentSessionId);
				else observedRef.current.delete(parentSessionId);
			}, [sessions]);
			(0, react.useEffect)(() => {
				if (rootId === void 0 || !active) return;
				observe(rootId, true);
				return () => {
					for (const parentSessionId of observedRef.current) sessions.setSubagentCatalogOpen?.(parentSessionId, false);
					observedRef.current.clear();
				};
			}, [
				rootId,
				active,
				observe,
				sessions
			]);
			const branches = (0, react.useMemo)(() => collectBranchIds(catalogs, rootId), [catalogs, rootId]);
			(0, react.useEffect)(() => {
				if (!active) return;
				for (const id of branches) if (!observedRef.current.has(id)) observe(id, true);
			}, [
				branches,
				active,
				observe
			]);
			(0, react.useEffect)(() => () => {
				for (const parentSessionId of observedRef.current) sessions.setSubagentCatalogOpen?.(parentSessionId, false);
				observedRef.current.clear();
			}, [sessions]);
			const openChild = (0, react.useCallback)((address) => {
				onOpenChild?.(address);
				try {
					sessions.openSubagent?.(address);
				} catch (error) {
					console.warn("[dsh-better-sidebar] openSubagent failed:", error);
				}
			}, [sessions, onOpenChild]);
			/** Jump back to the main agent (the topology root) from its node. */
			const openMain = (0, react.useCallback)(() => {
				if (rootId === void 0) return;
				try {
					sessions.open?.(rootId);
				} catch (error) {
					console.warn("[dsh-better-sidebar] open session failed:", error);
				}
			}, [sessions, rootId]);
			const refresh = (0, react.useCallback)((parentSessionId) => {
				sessions.refreshSubagents?.(parentSessionId);
			}, [sessions]);
			const totals = (0, react.useMemo)(() => rootId === void 0 ? {
				count: 0,
				runningCount: 0
			} : countSubagentDescendants(byId, rootId), [byId, rootId]);
			const summaryBackedLoading = rootId !== void 0 && (rootCatalog === void 0 || rootCatalog.state === "ready" && rootCatalog.entries.length === 0) && directChildren(byId, rootId).length > 0;
			const readyEmpty = rootCatalog?.state === "ready" && rootCatalog.entries.length === 0 && directChildren(byId, rootId ?? "").length === 0;
			const countLabel = totals.count === 0 ? void 0 : totals.runningCount > 0 ? t("subagentCountRunning", {
				count: totals.count,
				running: totals.runningCount
			}) : t("subagentCount", { count: totals.count });
			/** Arrow-key tree navigation over the visible rows (official catalog recipe). */
			const bodyRef = (0, react.useRef)(null);
			const focusAt = (0, react.useCallback)((index) => {
				const items = bodyRef.current?.querySelectorAll("[role=\"treeitem\"]:not([aria-disabled=\"true\"])") ?? [];
				if (items.length === 0) return;
				items[(index + items.length) % items.length]?.focus();
			}, []);
			const onTreeKeyDown = (0, react.useCallback)((event) => {
				const items = bodyRef.current?.querySelectorAll("[role=\"treeitem\"]:not([aria-disabled=\"true\"])") ?? [];
				const index = Array.prototype.indexOf.call(items, document.activeElement);
				if (event.key === "ArrowDown") {
					event.preventDefault();
					focusAt(index + 1);
				} else if (event.key === "ArrowUp") {
					event.preventDefault();
					focusAt(index < 0 ? items.length - 1 : index - 1);
				} else if (event.key === "Home") {
					event.preventDefault();
					focusAt(0);
				} else if (event.key === "End") {
					event.preventDefault();
					focusAt(items.length - 1);
				}
			}, [focusAt]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: SubagentView_module_css_default.subagent,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: SubagentView_module_css_default.subagentHeader,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: SubagentView_module_css_default.subagentTitle,
							children: [t("subagent"), rootSummary?.displayTitle !== void 0 && rootSummary.displayTitle !== "" ? ` · ${rootSummary.displayTitle}` : ""]
						}),
						countLabel !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: SubagentView_module_css_default.subagentCount,
							children: countLabel
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SubagentView_module_css_default.subagentRefresh,
							"aria-label": t("refresh"),
							title: t("refresh"),
							disabled: rootId === void 0,
							onClick: () => {
								if (rootId !== void 0) refresh(rootId);
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline14, {})
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: bodyRef,
					className: SubagentView_module_css_default.subagentBody,
					onKeyDown: onTreeKeyDown,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "tree",
						"aria-label": t("subagent"),
						"aria-busy": summaryBackedLoading || void 0,
						children: [
							rootId !== void 0 && rootSummary !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								role: "treeitem",
								tabIndex: 0,
								"aria-level": 0,
								"aria-label": `${rootSummary.displayTitle !== "" ? rootSummary.displayTitle : t("subagentMainAgent")} ${t("subagentMainAgent")}`,
								"aria-current": rootId === sessionId ? "true" : void 0,
								className: clsx(SubagentView_module_css_default.subagentRow, rootId === sessionId && SubagentView_module_css_default.subagentRowActive),
								onClick: openMain,
								onKeyDown: (event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										event.stopPropagation();
										openMain();
									}
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
									state: rootSummary.running === true ? "ongoing" : "done",
									className: SubagentView_module_css_default.subagentDot
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SubagentView_module_css_default.subagentContent,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SubagentView_module_css_default.subagentLabel,
										children: rootSummary.displayTitle !== "" ? rootSummary.displayTitle : t("subagentMainAgent")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SubagentView_module_css_default.subagentSecondary,
										children: `${t("subagentMainAgent")} · ${rootSummary.running === true ? t("subagentRunning") : t("subagentInactive")}`
									})]
								})]
							}),
							rootId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SubagentView_module_css_default.subagentChildren,
								role: "group",
								"aria-busy": summaryBackedLoading || void 0,
								children: [summaryBackedLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CatalogLoadingRows, {
									parentSessionId: rootId,
									byId,
									level: 1
								}), !summaryBackedLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CatalogRows, {
									parentSessionId: rootId,
									catalog: rootCatalog,
									catalogs,
									byId,
									level: 1,
									currentSessionId: sessionId,
									active,
									ctx,
									openChild,
									refresh
								})]
							}),
							readyEmpty && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SubagentView_module_css_default.subagentEmpty,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t("subagentEmpty") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: SubagentView_module_css_default.subagentEmptyHint,
									children: t("subagentEmptyDesc")
								})]
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobsSection, {
						byId,
						jobsBySession: list.jobsBySession,
						rootId,
						active
					})]
				})]
			});
		}
		//#endregion
		//#region src/client/browser.ts
		/**
		* Decide whether a site can render inside the sidebar iframe. The signals
		* are exactly the ones the BROWSER enforces when it refuses an iframe load:
		* X-Frame-Options DENY/SAMEORIGIN, or a frame-ancestors directive that does
		* not allow `*` ('self' here means the SITE's own origin — never ours, so
		* it also blocks the sidebar). A site we could not reach yields 'unknown'
		* and the plain iframe stays.
		*/
		function embeddabilityOf(probe) {
			if (probe.reachable !== true) return "unknown";
			const xfo = probe.xFrameOptions?.trim().toUpperCase();
			if (xfo === "DENY" || xfo === "SAMEORIGIN") return "blocked";
			if (probe.frameAncestors !== void 0 && !probe.frameAncestors.some((source) => source === "*")) return "blocked";
			return "embeddable";
		}
		/** A loopback hostname (localhost, IPv6 ::1, 127.0.0.0/8, 0.0.0.0). */
		function isLoopbackHostname(hostname) {
			const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
			if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
			const parts = host.split(".");
			return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
		}
		/**
		* Normalize one address-bar input against the navigation policy.
		* @param input - raw user text.
		* @param selfOrigin - the GUI's own origin (window.location.origin). The GUI
		* itself may be browsed in the sidebar (the sandbox keeps it opaque), so it
		* is let through BEFORE the loopback check — its host is normally loopback.
		*/
		/** Schemes that must never reach the iframe, even without `//` (javascript:,
		*  data:, file:, ...). Host:port lookalikes (example.com:8080) are NOT here —
		*  they parse as hosts below. */
		const FORBIDDEN_SCHEMES = /* @__PURE__ */ new Set([
			"javascript",
			"data",
			"file",
			"about",
			"vbscript",
			"blob",
			"mailto",
			"tel",
			"ftp",
			"ftps",
			"ws",
			"wss",
			"sftp",
			"ssh",
			"chrome",
			"chrome-extension",
			"moz-extension",
			"edge",
			"opera",
			"resource",
			"view-source"
		]);
		function normalizeBrowserUrl(input, selfOrigin) {
			const trimmed = input.trim();
			if (trimmed === "") return { kind: "invalid" };
			const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
			let withScheme;
			if (schemeMatch === null) withScheme = `https://${trimmed}`;
			else {
				const scheme = schemeMatch[1].toLowerCase();
				if (scheme === "http" || scheme === "https") withScheme = trimmed;
				else if (FORBIDDEN_SCHEMES.has(scheme)) return {
					kind: "blocked",
					reason: "scheme"
				};
				else withScheme = `https://${trimmed}`;
			}
			let url;
			try {
				url = new URL(withScheme);
			} catch {
				return { kind: "invalid" };
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") return {
				kind: "blocked",
				reason: "scheme"
			};
			try {
				if (url.origin === new URL(selfOrigin).origin) return {
					kind: "ok",
					url: url.href
				};
			} catch {}
			if (isLoopbackHostname(url.hostname)) return {
				kind: "blocked",
				reason: "loopback"
			};
			return {
				kind: "ok",
				url: url.href
			};
		}
		//#endregion
		//#region src/client/SandboxStatusBar.tsx
		/**
		* The live sandbox status row of the two built-in web surfaces (HTML
		* preview and the browser tab): a green "sandbox on" state with a one-tap
		* TEMPORARY unlock, or a RED "sandbox off" state (global setting or the
		* temporary unlock) with a restore action.
		*
		* The temporary unlock is component state only — it never writes the
		* global side card setting (`htmlViewerNoSandbox` / `browserNoSandbox`);
		* it lasts until the surface unmounts (tab switch / file switch) or the
		* user restores the sandbox from the row. When the global setting already
		* drops the sandbox, no unlock/restore action is offered (changing the
		* global setting is the settings page's job) — the red warning stands.
		*/
		function SandboxStatusBar(props) {
			const { sandboxed, local, dangerCopy, onUnlock, onRestore } = props;
			if (sandboxed) {
				const copy = t("sandboxStatusOn");
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: clsx(sidebar_module_css_default.sandboxStatus, sidebar_module_css_default.sandboxStatusOn),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: sidebar_module_css_default.sandboxDot }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: sidebar_module_css_default.sandboxStatusText,
							title: copy,
							children: copy
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.sandboxAction,
							onClick: onUnlock,
							children: t("sandboxUnlock")
						})
					]
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(sidebar_module_css_default.sandboxStatus, sidebar_module_css_default.sandboxStatusOff),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: sidebar_module_css_default.sandboxDot }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: sidebar_module_css_default.sandboxStatusText,
						title: dangerCopy,
						children: dangerCopy
					}),
					local && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: sidebar_module_css_default.sandboxAction,
						onClick: onRestore,
						children: t("sandboxRestore")
					})
				]
			});
		}
		//#endregion
		//#region src/client/BrowserView.tsx
		/**
		* The built-in browser tab: an address bar plus a sandboxed iframe.
		*
		* Security model (see browser.ts + the sandbox tokens below): the iframe is
		* ALWAYS sandboxed without `allow-same-origin` (opaque origin — the visited
		* page can never sit on the GUI's origin, read its storage, or reach
		* /sidebar/api) and without `allow-top-navigation` (a page must not hijack
		* the GUI). The address bar only accepts http(s) and refuses loopback /
		* the GUI's own origin. The side card setting "关闭浏览器沙箱" drops the
		* sandbox attribute entirely for fully trusted sites — the visited page then
		* runs with the GUI's own origin and full session access, so a persistent
		* warning bar renders while it is off.
		*
		* The URL is persisted onto the tab (path/title via the patchTab reducer)
		* so a reload restores the visited page; the back/forward stack only tracks
		* address-bar navigations (in-frame link clicks are cross-origin and
		* invisible — a documented limitation).
		*/
		/**
		* The browser iframe sandbox tokens. NO allow-same-origin (opaque origin —
		* no GUI storage/API access), NO allow-top-navigation (a browsed page must
		* not hijack the GUI). allow-forms/allow-popups/allow-downloads/allow-modals
		* keep login flows working; allow-popups-to-escape-sandbox lets OAuth
		* popups open as normal tabs (they are cross-origin to the GUI either way).
		*/
		const BROWSER_IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox";
		function BrowserView(props) {
			const { store, tab } = props;
			const [url, setUrl] = (0, react.useState)(tab.path);
			const [input, setInput] = (0, react.useState)(tab.path ?? "");
			/** Blocked/invalid hint shown under the address bar (null = none). */
			const [message, setMessage] = (0, react.useState)(null);
			/** Address-bar navigation history (in-frame clicks are not tracked). */
			const [history, setHistory] = (0, react.useState)(tab.path !== void 0 ? [tab.path] : []);
			const [cursor, setCursor] = (0, react.useState)(tab.path !== void 0 ? 0 : -1);
			/** Bumped on reload to remount the iframe (also remounts on sandbox flip). */
			const [reloadKey, setReloadKey] = (0, react.useState)(0);
			/** TEMPORARY sandbox unlock for THIS surface only (never writes the global
			*  side card setting; lasts until the tab unmounts or the user restores). */
			const [localUnlock, setLocalUnlock] = (0, react.useState)(false);
			const noSandbox = store.getPrefs().browserNoSandbox === true || localUnlock;
			/** A site that refuses to be embedded (X-Frame-Options / frame-ancestors):
			*  the probe verdict shown instead of the blank iframe. */
			const [embedBlocked, setEmbedBlocked] = (0, react.useState)(null);
			/** The user asked to load the refused site anyway (keeps the plain iframe). */
			const [forceEmbed, setForceEmbed] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (url === void 0) return;
				let cancelled = false;
				setEmbedBlocked(null);
				setForceEmbed(false);
				api.browserProbe(url).then((probe) => {
					if (!cancelled && embeddabilityOf(probe) === "blocked") setEmbedBlocked(url);
				}).catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [url]);
			const persist = (nextUrl) => {
				let host = nextUrl;
				try {
					host = new URL(nextUrl).hostname;
				} catch {}
				store.reduce((state) => patchTab(state, tab.id, {
					path: nextUrl,
					title: host
				}));
			};
			const navigateTo = (raw) => {
				const result = normalizeBrowserUrl(raw, window.location.origin);
				if (result.kind === "ok") {
					const next = result.url;
					setUrl(next);
					setInput(next);
					setMessage(null);
					setHistory((previous) => [...previous.slice(0, cursor + 1), next]);
					setCursor((previous) => previous + 1);
					setReloadKey((key) => key + 1);
					persist(next);
					return;
				}
				setMessage(result.kind === "invalid" ? t("browserInvalid") : result.reason === "scheme" ? t("browserBlockedScheme") : t("browserBlockedLoopback"));
			};
			const goBack = () => {
				if (cursor <= 0) return;
				const next = history[cursor - 1];
				setCursor(cursor - 1);
				setUrl(next);
				setInput(next);
				setReloadKey((key) => key + 1);
			};
			const goForward = () => {
				if (cursor >= history.length - 1) return;
				const next = history[cursor + 1];
				setCursor(cursor + 1);
				setUrl(next);
				setInput(next);
				setReloadKey((key) => key + 1);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.browser,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: sidebar_module_css_default.browserBar,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: sidebar_module_css_default.iconButton,
								"aria-label": t("browserBack"),
								title: t("browserBack"),
								disabled: cursor <= 0,
								onClick: goBack,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutline14, {})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: sidebar_module_css_default.iconButton,
								"aria-label": t("browserForward"),
								title: t("browserForward"),
								disabled: cursor >= history.length - 1,
								onClick: goForward,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: sidebar_module_css_default.iconButton,
								"aria-label": t("refresh"),
								title: t("refresh"),
								onClick: () => {
									setReloadKey((key) => key + 1);
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline14, {})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: sidebar_module_css_default.browserInput,
								value: input,
								placeholder: t("browserPlaceholder"),
								spellCheck: false,
								onChange: (event) => {
									setInput(event.target.value);
								},
								onKeyDown: (event) => {
									if (event.key === "Enter") navigateTo(input);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: sidebar_module_css_default.iconButton,
								"aria-label": t("browserGo"),
								title: t("browserGo"),
								onClick: () => {
									navigateTo(input);
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLinkOutline14, {})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: sidebar_module_css_default.iconButton,
								"aria-label": t("browserOpenExternal"),
								title: t("browserOpenExternal"),
								disabled: url === void 0,
								onClick: () => {
									if (url !== void 0) window.open(url, "_blank", "noopener");
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRightUpOutline16, { size: 15 })
							})
						]
					}),
					message !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.browserMessage,
						children: message
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SandboxStatusBar, {
						sandboxed: !noSandbox,
						local: localUnlock,
						dangerCopy: t("browserNoSandboxWarning"),
						onUnlock: () => {
							setLocalUnlock(true);
						},
						onRestore: () => {
							setLocalUnlock(false);
						}
					}),
					url === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.browserStart,
						children: t("browserStart")
					}) : embedBlocked !== null && !forceEmbed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BrowserEmbedBlocked, {
						url: embedBlocked,
						onOpenInBrowser: () => {
							window.open(embedBlocked, "_blank", "noopener");
						},
						onLoadAnyway: () => {
							setForceEmbed(true);
						}
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
						className: sidebar_module_css_default.browserFrame,
						src: url,
						sandbox: noSandbox ? void 0 : BROWSER_IFRAME_SANDBOX,
						referrerPolicy: "no-referrer",
						allow: "",
						title: url
					}, `${reloadKey}:${noSandbox ? "ns" : "sb"}`)
				]
			});
		}
		/**
		* The embed-refusal panel: shown when the probed site forbids being
		* displayed inside other pages (X-Frame-Options / frame-ancestors) — the
		* iframe would only show the browser's "refused to connect" blank. Explains
		* the reason and offers the real-browser open plus a load-anyway escape.
		* Exported so the copy and the actions are testable without a DOM.
		*/
		function BrowserEmbedBlocked(props) {
			const { url, onOpenInBrowser, onLoadAnyway } = props;
			let host = url;
			try {
				host = new URL(url).hostname;
			} catch {}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.browserBlocked,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, { size: 16 }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.browserBlockedTitle,
						children: t("browserEmbedBlocked", { host })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.browserBlockedDesc,
						children: t("browserEmbedBlockedDesc")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: sidebar_module_css_default.browserBlockedActions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.browserBlockedButton,
							onClick: onOpenInBrowser,
							children: t("browserOpenExternal")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.browserBlockedButton,
							onClick: onLoadAnyway,
							children: t("browserEmbedAnyway")
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/builtins/tabs.tsx
		/**
		* The 7 built-in tab descriptors: the plugin registers its own pages
		* (explorer / git / terminal / browser / subagent / editor / diff) through
		* the same {@link BetterSidebarService} external plugins use — eating its
		* own dogfood. The terminal descriptor owns its quota (`TERMINAL_LIMIT`)
		* and mints `terminal:<n>` ids through `createTab`; the browser mints
		* `browser:<n>` the same way (no quota).
		*/
		/**
		* Lazy wrapper over the terminal view: xterm (and its stylesheet) is fetched
		* only when a terminal tab is first opened (see chunk-loader.ts). The
		* wrapper keeps the descriptor contract `(props) => ReactNode` — Sidebar
		* calls it as a plain function.
		*
		* TerminalView's props are { scope, tabId, store } — `tabId` is NOT part of
		* TabComponentProps (it carries `tab: SidebarTab` instead), so the
		* descriptor maps it explicitly; a bare pass-through would leave tabId
		* undefined and TerminalView's isAgentTabId(tabId) would crash on
		* `undefined.startsWith` (regression-pinned in tests/lazy-chunk.spec.tsx).
		*/
		const LazyTerminal = lazyChunkComponent("terminal", (mod) => mod.TerminalView);
		/** Count UI-owned terminals (agent:` tabs excluded — they are the model's). */
		function uiTerminalCount(state) {
			return allLeaves(state.splits).flatMap((leaf) => leaf.tabs).filter((tab) => tab.type === "terminal" && !isAgentTabId(tab.id)).length;
		}
		/** The 7 built-in tab descriptors. */
		function builtinTabs(ctx) {
			return [
				{
					id: "editor",
					title: () => t("editor"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size }),
					order: -1,
					hidden: true,
					dedupeKey: (tab) => tab.path,
					component: ({ ctx, store, scope, tab }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EditorHost, {
						ctx,
						store,
						scope,
						path: tab.path ?? "",
						title: tab.title,
						tabId: tab.id
					})
				},
				{
					id: "explorer",
					title: () => t("explorer"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, { size }),
					order: 10,
					single: true,
					component: ({ ctx, store, scope, expanded, onToggleDir, onReferenceFile }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExplorerView, {
						sessionId: scope.sessionId,
						cwd: scope.cwd,
						expanded: expanded ?? [],
						onToggle: onToggleDir ?? (() => {}),
						onOpenFile: (path) => {
							openSidebarFile(ctx, store, scope.sessionId, path);
						},
						onReferenceFile: onReferenceFile ?? (() => {})
					})
				},
				{
					id: "git",
					title: () => t("git"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, { size }),
					order: 20,
					single: true,
					component: ({ ctx, store, scope, onOpenDiff }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GitView, {
						scope,
						onOpenFile: (path) => {
							openSidebarFile(ctx, store, scope.sessionId, path);
						},
						onOpenDiff: onOpenDiff ?? (() => {})
					})
				},
				{
					id: "subagent",
					title: () => t("subagent"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconThinkOutline16, { size }),
					order: 30,
					single: true,
					settings: { toggles: [{
						key: "autoOpenSubagent",
						title: () => t("settingsSubagentTitle"),
						desc: () => t("settingsSubagentDesc")
					}, {
						key: "autoOpenJobs",
						title: () => t("settingsJobsTitle"),
						desc: () => t("settingsJobsDesc")
					}] },
					component: ({ ctx, scope, visible, onSubagentJump }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SubagentView, {
						sessionId: scope.sessionId,
						ctx,
						active: visible,
						onOpenChild: (address) => {
							onSubagentJump?.(address.childSessionId);
						}
					})
				},
				{
					id: "terminal",
					title: () => t("terminal"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTerminalOutline16, { size }),
					order: 40,
					available: (_ctx, _scope, state) => uiTerminalCount(state) < 3,
					settings: { toggles: [
						{
							key: "agentTerminalTools",
							title: () => t("settingsToolsTitle"),
							desc: () => t("settingsToolsDesc")
						},
						{
							key: "bottomPanelAutoTerminal",
							title: () => t("settingsBottomTerminalTitle"),
							desc: () => t("settingsBottomTerminalDesc")
						},
						{
							key: "terminalFontFamily",
							type: "text",
							title: () => t("settingsFontFamilyTitle"),
							desc: () => t("settingsFontFamilyDesc"),
							placeholder: t("settingsFontFamilyPlaceholder")
						},
						{
							key: "terminalFontSize",
							type: "number",
							title: () => t("settingsFontSizeTitle"),
							desc: () => t("settingsFontSizeDesc"),
							min: 9,
							max: 32,
							unit: "px"
						}
					] },
					createTab: (state) => {
						if (uiTerminalCount(state) >= 3) return null;
						return {
							tab: {
								id: `terminal:${state.nextTerminal}`,
								type: "terminal",
								title: `${t("terminal")} ${state.nextTerminal}`
							},
							patch: { nextTerminal: state.nextTerminal + 1 }
						};
					},
					component: ({ tab, scope, store }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazyTerminal, {
						scope,
						store,
						tabId: tab.id
					})
				},
				{
					id: "browser",
					title: () => t("browser"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconGlobeOutline16, { size }),
					order: 50,
					settings: { toggles: [
						{
							key: "browserNoSandbox",
							title: () => t("settingsBrowserSandboxTitle"),
							desc: () => t("settingsBrowserSandboxDesc")
						},
						{
							key: "browserInterceptLinks",
							title: () => t("settingsBrowserLinksTitle"),
							desc: () => t("settingsBrowserLinksDesc")
						},
						{
							key: "browserInterceptHttp",
							title: () => t("settingsBrowserHttpTitle"),
							desc: () => t("settingsBrowserHttpDesc")
						},
						{
							key: "browserInterceptHttps",
							title: () => t("settingsBrowserHttpsTitle"),
							desc: () => t("settingsBrowserHttpsDesc")
						}
					] },
					createTab: (state) => ({
						tab: {
							id: `browser:${state.nextBrowser}`,
							type: "browser",
							title: t("browser")
						},
						patch: { nextBrowser: state.nextBrowser + 1 }
					}),
					component: (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BrowserView, { ...props })
				},
				{
					id: "diff",
					title: () => t("git"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDiffOutline16, { size }),
					order: -1,
					hidden: true,
					dedupeKey: (tab) => tab.id,
					component: ({ scope, tab }) => tab.diff === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiffTab, {
						sessionId: scope.sessionId,
						cwd: scope.cwd,
						diff: tab.diff
					})
				}
			];
		}
		//#endregion
		//#region src/client/PdfView.tsx
		/** Browser-native PDF preview with an always-available download fallback. */
		function PdfView(props) {
			const { scope, path, title } = props;
			const [load, setLoad] = (0, react.useState)({ status: "loading" });
			const [interactionBlocked, setInteractionBlocked] = (0, react.useState)(false);
			const frameRef = (0, react.useRef)(null);
			const shieldRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				let objectUrl;
				setLoad({ status: "loading" });
				(async () => {
					try {
						const response = await fetch(mediaUrl(scope, path), { signal: controller.signal });
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const bytes = await response.arrayBuffer();
						if (controller.signal.aborted) return;
						objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
						setLoad({
							status: "ready",
							url: objectUrl
						});
					} catch (error) {
						if (controller.signal.aborted) return;
						setLoad({
							status: "error",
							message: error instanceof Error ? error.message : String(error)
						});
					}
				})();
				return () => {
					controller.abort();
					if (objectUrl !== void 0) URL.revokeObjectURL(objectUrl);
				};
			}, [
				scope.sessionId,
				scope.cwd,
				path
			]);
			(0, react.useEffect)(() => {
				const block = () => {
					setInteractionBlocked(true);
					if (frameRef.current !== null) frameRef.current.style.pointerEvents = "none";
					if (shieldRef.current !== null) shieldRef.current.style.pointerEvents = "auto";
				};
				const unblock = () => {
					setInteractionBlocked(false);
					if (frameRef.current !== null) frameRef.current.style.pointerEvents = "";
					if (shieldRef.current !== null) shieldRef.current.style.pointerEvents = "none";
				};
				const blockForResize = (event) => {
					const target = event.target;
					if (target instanceof Element && target.closest(`.${sidebar_module_css_default.panelResize}, .${sidebar_module_css_default.divider}`) !== null) block();
				};
				document.addEventListener("dragstart", block, true);
				document.addEventListener("dragend", unblock, true);
				document.addEventListener("drop", unblock, true);
				window.addEventListener("pointerdown", blockForResize, true);
				window.addEventListener("pointerup", unblock, true);
				window.addEventListener("pointercancel", unblock, true);
				window.addEventListener("blur", unblock);
				return () => {
					document.removeEventListener("dragstart", block, true);
					document.removeEventListener("dragend", unblock, true);
					document.removeEventListener("drop", unblock, true);
					window.removeEventListener("pointerdown", blockForResize, true);
					window.removeEventListener("pointerup", unblock, true);
					window.removeEventListener("pointercancel", unblock, true);
					window.removeEventListener("blur", unblock);
				};
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.editorPdf,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: sidebar_module_css_default.editorPdfToolbar,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
						className: sidebar_module_css_default.editorDownloadLink,
						href: downloadUrl(scope, path),
						download: true,
						children: t("downloadToView")
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: sidebar_module_css_default.editorPdfStage,
					children: [
						load.status === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: sidebar_module_css_default.editorPlaceholder,
							children: t("loading")
						}),
						load.status === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: sidebar_module_css_default.editorError,
							children: load.message
						}),
						load.status === "ready" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
							ref: frameRef,
							className: clsx(sidebar_module_css_default.editorPdfFrame, interactionBlocked && sidebar_module_css_default.editorPdfFrameBlocked),
							src: load.url,
							title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							ref: shieldRef,
							className: clsx(sidebar_module_css_default.editorPdfDragShield, interactionBlocked && sidebar_module_css_default.editorPdfDragShieldActive),
							"aria-hidden": "true"
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/builtins/viewers.tsx
		/**
		* The 6 built-in file viewer descriptors: every preview surface is a
		* registered viewer (image / pdf / markdown / html / code /
		* binary-download), exactly like external plugins register theirs. Office
		* previews (.docx / .xlsx / .pptx) are NOT built in anymore — they moved to
		* the recommended office plugin (see plugins-viewers.ts), which registers
		* the same ids through this service.
		*
		* The `binary-download` viewer sniffs NUL bytes via `detect` for unknown
		* binaries and serves legacy doc/xls/ppt by extension; `code` is the
		* catch-all (`exts: []`, lowest priority) that claims any file no other
		* viewer did.
		*
		* The heavy viewers (the CodeMirror-backed markdown/html/code) render
		* through {@link lazyChunkComponent} wrappers — their libraries are fetched
		* only when such a file is first opened (see chunk-loader.ts). The
		* descriptor metadata (id/exts/priority/detect) is identical either way,
		* so matching semantics and external-plugin overrides are unaffected; the
		* `component` wrapper keeps the descriptor contract `(props) => ReactNode`.
		*
		* Every viewer carries the declarative settings-surface fields — `title`
		* and `icon` — so the Side card settings page can render the enable/disable
		* inventory without hardcoding (eating our own dogfood).
		*/
		/**
		* Lazy wrapper over the chunk-resident viewer component. The `pick`
		* function is module-level (stable identity — the wrapper effect depends
		* on it); the cast bridges the chunk exports record to the descriptor prop
		* shape (the view reads only its own subset of FileViewerProps).
		*/
		const LazyTextEditor = lazyChunkComponent("editor", (mod) => mod.TextEditor);
		/** The 6 built-in file viewer descriptors. */
		function builtinViewers() {
			return [
				{
					id: "image",
					title: () => t("viewerImage"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconImageOutline16, { size }),
					exts: [
						"png",
						"jpg",
						"jpeg",
						"gif",
						"webp",
						"svg",
						"bmp",
						"ico",
						"avif"
					],
					fetchStrategy: "mediaUrl",
					component: ({ mediaUrl: url, title }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.editorImageWrap,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							className: sidebar_module_css_default.editorImage,
							src: url,
							alt: title
						})
					})
				},
				{
					id: "pdf",
					title: () => t("viewerPdf"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPdfOutline16, { size }),
					exts: ["pdf"],
					fetchStrategy: "mediaUrl",
					component: ({ scope, path, title }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PdfView, {
						scope,
						path,
						title
					})
				},
				{
					id: "markdown",
					title: () => t("viewerMarkdown"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconMarkdownOutline16, { size }),
					exts: ["md", "markdown"],
					fetchStrategy: "fsRead",
					component: (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazyTextEditor, { ...props })
				},
				{
					id: "html",
					title: () => t("viewerHtml"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconHtmlOutline16, { size }),
					exts: ["html", "htm"],
					fetchStrategy: "fsRead",
					settings: { toggles: [{
						key: "htmlViewerNoSandbox",
						title: () => t("settingsHtmlSandboxTitle"),
						desc: () => t("settingsHtmlSandboxDesc")
					}, {
						key: "htmlViewerDefaultUnsafe",
						title: () => t("settingsHtmlDefaultUnsafeTitle"),
						desc: () => t("settingsHtmlDefaultUnsafeDesc")
					}] },
					component: (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazyTextEditor, { ...props })
				},
				{
					id: "code",
					title: () => t("viewerCode"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size }),
					exts: [],
					priority: -100,
					fetchStrategy: "fsRead",
					component: (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazyTextEditor, { ...props })
				},
				{
					id: "binary-download",
					title: () => t("viewerBinary"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size }),
					exts: [
						"doc",
						"xls",
						"ppt"
					],
					priority: -50,
					fetchStrategy: "binary-download",
					detect: (_path, head) => head.includes(0),
					component: ({ scope, path }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BinaryDownload, {
						scope,
						path
					})
				}
			];
		}
		//#endregion
		//#region src/client/builtins/index.ts
		/**
		* Register all built-in tabs and viewers with the service. Returns a
		* disposer that unregisters everything (cordis auto-invokes it on fiber
		* disposal). The `ctx` is threaded into tab descriptors that need it
		* (EditorHost reads `ctx.betterSidebar` for file-viewer matching).
		*/
		function registerBuiltins(ctx, service) {
			const disposers = [];
			for (const tab of builtinTabs(ctx)) disposers.push(service.registerTab(tab));
			for (const viewer of builtinViewers()) disposers.push(service.registerFileViewer(viewer));
			return () => {
				for (const d of disposers) try {
					d();
				} catch {}
			};
		}
		//#endregion
		//#region src/client/conversation-draft.ts
		/**
		* Append `text` to the session's composer draft (space-separated, like the
		* @-mentions). Returns false — and logs — when the conversation service or
		* the session scope is unavailable.
		*/
		function appendToDraft(ctx, sessionId, text) {
			try {
				const actx = ctx.sessions.scope(sessionId);
				if (actx === void 0) return false;
				const conversation = ctx.get("conversation");
				if (conversation === void 0) return false;
				const input = conversation.input.for(actx);
				const draft = input.state.getSnapshot().draft;
				input.setDraft(draft.trim() === "" ? text : `${draft} ${text}`);
				return true;
			} catch (error) {
				console.warn("[dsh-better-sidebar] draft insert failed:", error);
				return false;
			}
		}
		//#endregion
		//#region src/client/TabBar.tsx
		/**
		* The tab strip of one pane: tabs capped at TAB_MAX_WIDTH (ellipsized),
		* overflow scrolls horizontally, a close button per tab, a four-way split
		* button cluster, and the + menu that opens new tabs (explorer / git /
		* terminal). Tabs are draggable; dropping onto another tab inserts before it,
		* dropping on the strip background appends to this pane.
		*/
		/** Drag payload for tab moves (HTML5 DnD dataTransfer). */
		const TAB_DRAG_TYPE = "application/x-dsh-tab";
		function serializeDrag(payload) {
			return JSON.stringify(payload);
		}
		function parseDrag(raw) {
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed.tabId === "string" && typeof parsed.paneId === "string") return parsed;
				return null;
			} catch {
				return null;
			}
		}
		/** Global tab-drag flag: PDF iframes become non-interactive synchronously. */
		function setTabDragging(active) {
			if (active) document.body.setAttribute("data-dsh-tab-dragging", "");
			else document.body.removeAttribute("data-dsh-tab-dragging");
		}
		function TabBar(props) {
			const { paneId, tabs, active, onActivate, onClose, onNewTab, newTabOptions, onDropTab, getTabIcon, getTabBadge } = props;
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			const [dragOver, setDragOver] = (0, react.useState)(false);
			const listRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const el = listRef.current;
				if (el === null) return;
				const onWheel = (event) => {
					if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
					if (el.scrollWidth <= el.clientWidth) return;
					event.preventDefault();
					const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1;
					el.scrollLeft += (event.deltaX + event.deltaY) * unit;
				};
				el.addEventListener("wheel", onWheel, { passive: false });
				return () => {
					el.removeEventListener("wheel", onWheel);
				};
			}, []);
			(0, react.useEffect)(() => {
				const clear = () => {
					setTabDragging(false);
					setDragOver(false);
				};
				window.addEventListener("dragend", clear, true);
				window.addEventListener("drop", clear, true);
				window.addEventListener("blur", clear);
				return () => {
					window.removeEventListener("dragend", clear, true);
					window.removeEventListener("drop", clear, true);
					window.removeEventListener("blur", clear);
				};
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: clsx(sidebar_module_css_default.tabBar, dragOver && sidebar_module_css_default.tabBarDrop),
				onDragOver: (event) => {
					event.preventDefault();
					event.stopPropagation();
					setDragOver(true);
				},
				onDragLeave: () => {
					setDragOver(false);
				},
				onDrop: (event) => {
					event.preventDefault();
					event.stopPropagation();
					setDragOver(false);
					setTabDragging(false);
					const payload = parseDrag(event.dataTransfer.getData(TAB_DRAG_TYPE));
					if (payload !== null) onDropTab(payload, null);
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: listRef,
					className: sidebar_module_css_default.tabList,
					children: [tabs.map((tab) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: clsx(sidebar_module_css_default.tab, active === tab.id && sidebar_module_css_default.tabActive),
						title: tab.title,
						draggable: true,
						onDragStart: (event) => {
							setTabDragging(true);
							event.dataTransfer.setData(TAB_DRAG_TYPE, serializeDrag({
								tabId: tab.id,
								paneId
							}));
							event.dataTransfer.effectAllowed = "move";
						},
						onDragEnd: () => {
							setTabDragging(false);
							setDragOver(false);
						},
						onDragOver: (event) => {
							event.preventDefault();
							event.stopPropagation();
						},
						onDrop: (event) => {
							event.preventDefault();
							event.stopPropagation();
							setTabDragging(false);
							const payload = parseDrag(event.dataTransfer.getData(TAB_DRAG_TYPE));
							if (payload !== null) onDropTab(payload, tab.id);
						},
						onClick: () => {
							onActivate(tab.id);
						},
						onAuxClick: (event) => {
							if (event.button === 1) {
								event.preventDefault();
								onClose(tab.id);
							}
						},
						children: [
							getTabIcon?.(tab) ?? null,
							getTabBadge?.(tab) ?? null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: sidebar_module_css_default.tabTitle,
								children: tab.title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: sidebar_module_css_default.tabClose,
								"aria-label": t("close"),
								onClick: (event) => {
									event.stopPropagation();
									onClose(tab.id);
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseFill14, {})
							})
						]
					}, tab.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
						open: menuOpen,
						onClose: () => {
							setMenuOpen(false);
						},
						items: newTabOptions.map((option) => ({
							id: option.id,
							label: option.label,
							...option.disabled === true ? { disabled: true } : {},
							...option.icon !== void 0 ? { icon: option.icon } : {}
						})),
						onSelect: (id) => {
							onNewTab(id);
							setMenuOpen(false);
						},
						portal: true,
						align: "end",
						anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.tabBarPlus,
							"aria-label": t("newTab"),
							title: t("newTab"),
							onClick: () => {
								setMenuOpen((v) => !v);
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, {})
						})
					})]
				})
			});
		}
		//#endregion
		//#region src/client/split-pane.tsx
		/**
		* The split-pane workbench: renders the recursive split tree. A split lays
		* children out row- or column-wise with draggable dividers (fractional
		* sizes); a leaf renders its tab strip plus the active tab's content.
		*
		* Splitting is VSCode-style DRAG-TO-EDGE, not buttons: while dragging a tab
		* over a pane, a drop overlay shows five zones — four edges (left/right/up/
		* down) that split the pane with the tab in a fresh leaf, and the center
		* that merges the tab into the pane. The tree and all operations live in
		* state.ts; this file is pure presentation over them.
		*/
		/** One divider: pointer-capture drag translating px deltas into fractions.
		* Deltas are incremental — each move reports the displacement since the
		* previous move — because the store adds every reported delta to the pane
		* sizes; a cumulative (since-pointer-down) delta would be re-added on each
		* move and the divider would run away from the cursor. */
		function Divider(props) {
			const { dir, onResize } = props;
			const last = (0, react.useRef)({
				x: 0,
				y: 0,
				size: 0
			});
			const [dragging, setDragging] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: clsx(sidebar_module_css_default.divider, dir === "row" ? sidebar_module_css_default.dividerRow : sidebar_module_css_default.dividerCol, dragging && sidebar_module_css_default.dividerActive),
				onPointerDown: (event) => {
					event.preventDefault();
					event.currentTarget.setPointerCapture(event.pointerId);
					const box = event.currentTarget.parentElement?.getBoundingClientRect();
					last.current = {
						x: event.clientX,
						y: event.clientY,
						size: box === void 0 ? 1 : dir === "row" ? box.width : box.height
					};
					setDragging(true);
				},
				onPointerMove: (event) => {
					if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
					const delta = dir === "row" ? event.clientX - last.current.x : event.clientY - last.current.y;
					onResize(delta / Math.max(1, last.current.size));
					last.current.x = event.clientX;
					last.current.y = event.clientY;
				},
				onPointerUp: (event) => {
					if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
					event.currentTarget.releasePointerCapture(event.pointerId);
					setDragging(false);
				}
			});
		}
		/** Map a pointer position inside a pane to the VSCode drop zone (25% edges). */
		function zoneAt(event, pane) {
			const rect = pane.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return "center";
			const x = (event.clientX - rect.left) / rect.width;
			const y = (event.clientY - rect.top) / rect.height;
			if (x < .25) return "left";
			if (x > .75) return "right";
			if (y < .25) return "up";
			if (y > .75) return "down";
			return "center";
		}
		/** The icon of one openable type card (mirror of the + menu options). */
		/**
		* An empty pane's welcome cards: the openable types as cards, clicked to
		* open (instead of a bare "this pane is empty" message).
		*/
		function PaneEmptyCards(props) {
			const { newTabOptions, onNewTab } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: sidebar_module_css_default.paneEmptyCards,
				children: newTabOptions.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: sidebar_module_css_default.paneCard,
					disabled: option.disabled === true,
					title: option.label,
					onClick: () => {
						onNewTab(option.id);
					},
					children: [option.icon ?? null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: option.label })]
				}, option.id))
			});
		}
		/** A leaf: tab strip + active content + VSCode-style drop target for tabs. */
		function LeafView(props) {
			const { leaf, newTabOptions, actions, onNewTab, renderTab, getTabIcon, getTabBadge } = props;
			const [dropZone, setDropZone] = (0, react.useState)(null);
			const activeTab = leaf.tabs.find((tab) => tab.id === leaf.active) ?? leaf.tabs[leaf.tabs.length - 1];
			(0, react.useEffect)(() => {
				const clear = () => {
					setDropZone(null);
				};
				window.addEventListener("dragend", clear, true);
				window.addEventListener("drop", clear, true);
				window.addEventListener("blur", clear);
				return () => {
					window.removeEventListener("dragend", clear, true);
					window.removeEventListener("drop", clear, true);
					window.removeEventListener("blur", clear);
				};
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(sidebar_module_css_default.pane, dropZone !== null && sidebar_module_css_default.paneDrop),
				onPointerDown: () => {
					actions.focusPane(leaf.id);
				},
				onDragOver: (event) => {
					event.preventDefault();
					const zone = zoneAt(event, event.currentTarget);
					setDropZone(zone);
				},
				onDragLeave: (event) => {
					if (!event.currentTarget.contains(event.relatedTarget)) setDropZone(null);
				},
				onDrop: (event) => {
					event.preventDefault();
					const zone = dropZone ?? zoneAt(event, event.currentTarget);
					setDropZone(null);
					const payload = parseDrag(event.dataTransfer.getData("application/x-dsh-tab"));
					if (payload !== null) actions.moveTabToEdge(payload, leaf.id, zone);
				},
				children: [
					dropZone !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: clsx(sidebar_module_css_default.dropOverlay, sidebar_module_css_default[`drop${dropZone[0].toUpperCase()}${dropZone.slice(1)}`]) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TabBar, {
						paneId: leaf.id,
						tabs: leaf.tabs,
						active: leaf.active,
						onActivate: (tabId) => {
							actions.activateTab(leaf.id, tabId);
						},
						onClose: (tabId) => {
							actions.closeTab(leaf.id, tabId);
						},
						onNewTab,
						newTabOptions,
						getTabIcon,
						getTabBadge,
						onDropTab: (payload, before) => {
							if (before === null) actions.moveTabToEdge(payload, leaf.id, "center");
							else actions.moveTabBefore(payload, leaf.id, before);
						}
					}),
					leaf.tabs.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.paneContent,
						children: leaf.tabs.map((tab) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: clsx(sidebar_module_css_default.paneTab, tab.id !== activeTab?.id && sidebar_module_css_default.paneTabHidden),
							children: renderTab(tab, tab.id === activeTab?.id, leaf.id)
						}, tab.id))
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PaneEmptyCards, {
						newTabOptions,
						onNewTab
					})
				]
			});
		}
		/** Recursive node renderer. */
		function NodeView(props) {
			const { node, state, newTabOptions, actions, onNewTab, renderTab, getTabIcon, getTabBadge } = props;
			if (node.kind === "leaf") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LeafView, {
				leaf: node,
				newTabOptions,
				actions,
				onNewTab,
				renderTab,
				getTabIcon,
				getTabBadge
			});
			const isRow = node.dir === "row";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: clsx(sidebar_module_css_default.split, isRow ? sidebar_module_css_default.splitRow : sidebar_module_css_default.splitCol),
				children: node.children.map((child, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [index > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Divider, {
					dir: node.dir,
					onResize: (deltaFrac) => {
						actions.resizeSplit(node.id, index - 1, deltaFrac);
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: sidebar_module_css_default.splitChild,
					style: {
						flexGrow: node.sizes[index],
						flexBasis: 0,
						minWidth: 0,
						minHeight: 0
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NodeView, {
						node: child,
						state,
						newTabOptions,
						actions,
						onNewTab,
						renderTab,
						getTabIcon,
						getTabBadge
					})
				})] }, child.id))
			});
		}
		/** The workbench: the split tree filling the sidebar body. `tree` selects
		*  which tree renders (the right panel's by default; the bottom panel passes
		*  `state.bottomSplits` — the actions route by pane id, so one action set
		*  serves both). */
		function Workbench(props) {
			const { state, tree, newTabOptions, actions, onNewTab, renderTab, getTabIcon, getTabBadge } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: sidebar_module_css_default.workbench,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NodeView, {
					node: tree ?? state.splits,
					state,
					newTabOptions,
					actions,
					onNewTab,
					renderTab,
					getTabIcon,
					getTabBadge
				})
			});
		}
		//#endregion
		//#region src/client/OrphanedTab.tsx
		function OrphanedTab(props) {
			const { tab } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.editor,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: sidebar_module_css_default.editorHeader,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: sidebar_module_css_default.editorTitle,
						title: tab.type,
						children: tab.title
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: sidebar_module_css_default.editorPlaceholder,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("pluginNotLoaded") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
						className: sidebar_module_css_default.orphanedType,
						children: tab.type
					})]
				})]
			});
		}
		//#endregion
		//#region src/client/RenderBoundary.tsx
		/**
		* The generic render error boundary for the sidebar tree: a render error in
		* the wrapped subtree shows a dismissible error strip (retry re-renders the
		* children) instead of blanking the shell. Used at two scopes:
		*
		* - ROOT (index.tsx, `css.boundaryError`): last-resort containment for
		*   errors in the sidebar shell itself (Workbench, drag layout, …) — a full
		*   swap keeps the page alive.
		* - PER-TAB (Sidebar.tsx TabContent, `css.tabBoundaryError`): a crashing
		*   viewer/editor shows a strip inside ITS OWN pane; the toggle cluster, the
		*   other tabs, and the panel itself stay alive (issue #31 — a tab crash
		*   must never take down the whole sidebar).
		*
		* The className prop selects the strip's geometry: the root's full-height
		* fixed rail vs. the tab's pane-filling block.
		*/
		var RenderBoundary = class extends react.Component {
			state = { error: null };
			static getDerivedStateFromError(error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
			componentDidCatch(error, info) {
				console.error("[dsh-better-sidebar] render error:", error, info.componentStack);
			}
			render() {
				if (this.state.error !== null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: this.props.className,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["dsh-better-sidebar: ", this.state.error] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: sidebar_module_css_default.terminalRetry,
						onClick: () => {
							this.setState({ error: null });
						},
						children: t("terminalRetry")
					})]
				});
				return this.props.children;
			}
		};
		//#endregion
		//#region src/client/Sidebar.tsx
		/**
		* The sidebar shell: fixed-position panels portalled onto document.body
		* (the core AppFrame owns the left sidebar / center / details columns and
		* has no right-side hole for plugins). The right panel hosts the original
		* workbench; the bottom panel hosts a second, independent workbench. The
		* bottom panel squeezes ONLY the center column (the agent output area): it
		* spans from the app shell's own left sidebar to the right panel's left
		* edge, so neither sidebar gives up any position (the right panel keeps its
		* full height). A persistent two-button cluster at the top-right corner
		* toggles each panel; the right panel's width drags from its left edge, the
		* bottom panel's height from its top edge, and the shared corner drags both
		* at once. The whole layout lives in the per-session store, so switching
		* conversations swaps the sidebar.
		*
		* The shell binds the workbench actions to the store and dispatches tab
		* content to the views. New tabs come from the + menu (explorer / git /
		* terminal; editors open from the explorer). Tabs live in one tree only —
		* they never cross panels; only the panel sizes drag against each other.
		*
		* Narrow (mobile, <768px) viewports show ONLY the right sidebar: entering
		* narrow migrates the bottom panel's tabs INTO the right tree
		* (migrateBottomTabs) — one workbench, the bottom tabs thrown into its
		* strips. The right panel becomes a full-width drawer, the bottom panel
		* and its toggle button disappear, and the layout push is disabled (the
		* drawer floats). Widening does not migrate back: the tabs keep living in
		* the right tree.
		*/
		/** How many consecutive reconnect failures stop the agent-terminals push loop
		* (mirror of the terminal view's own cap; the loop restarts on session switch). */
		const FAILURE_LIMIT = 3;
		/** Render the content of one tab (dispatched by type). */
		function TabContent(props) {
			const { tab, sessionId, cwd, expanded, onToggleDir, onReferenceFile, ctx, store, visible, onSubagentJump, onOpenDiff } = props;
			const scope = {
				sessionId,
				cwd
			};
			const descriptor = ctx.betterSidebar?.getTab(tab.type);
			if (descriptor === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OrphanedTab, {
				ctx,
				store,
				scope,
				tab,
				visible
			});
			return (0, react.createElement)(RenderBoundary, { className: sidebar_module_css_default.tabBoundaryError }, (0, react.createElement)(descriptor.component, {
				ctx,
				store,
				scope,
				tab,
				visible,
				expanded,
				onToggleDir,
				onReferenceFile,
				onOpenDiff,
				onSubagentJump
			}));
		}
		/** The + menu options for the current state, driven by the tab registry.
		* Hidden tabs (editor/diff) never show; `available` returning false shows
		* a disabled row (e.g. terminal at capacity) instead of hiding the option.
		* Tabs the user disabled in the side card settings are filtered out
		* entirely — re-enabling them is the settings page's job. */
		function buildNewTabOptions(state, ctx, scope) {
			const service = ctx.betterSidebar;
			if (service === void 0) return [];
			return service.getTabs().filter((d) => !d.hidden && service.isTabEnabled(d.id)).sort((a, b) => (a.order ?? 100) - (b.order ?? 100)).map((d) => ({
				id: d.id,
				label: typeof d.title === "function" ? d.title() : d.title,
				disabled: !(d.available?.(ctx, scope, state) ?? true),
				icon: typeof d.icon === "function" ? d.icon(16) : d.icon
			}));
		}
		function Sidebar(props) {
			const { ctx, store } = props;
			(0, react.useSyncExternalStore)((0, react.useMemo)(() => (callback) => ctx.locale.subscribe(callback), [ctx]), (0, react.useCallback)(() => ctx.locale.getSnapshot().active, [ctx]));
			const narrow = useNarrowViewport();
			const sessionList = (0, react.useSyncExternalStore)((0, react.useMemo)(() => (callback) => ctx.sessions.list.subscribe(callback), [ctx]), (0, react.useCallback)(() => ctx.sessions.list.getSnapshot(), [ctx]));
			const current = sessionList.current;
			const snapshot = (0, react.useSyncExternalStore)((0, react.useCallback)((callback) => store.subscribe(callback), [store]), (0, react.useCallback)(() => store.getSnapshot(), [store]));
			(0, react.useEffect)(() => {
				store.setSession(current);
			}, [current, store]);
			const state = snapshot.state;
			const sessionId = snapshot.sessionId;
			const summaryCwd = sessionId === void 0 ? void 0 : sessionList.byId[sessionId]?.cwd;
			const collapsed = state === void 0 || !state.panelOpen;
			(0, react.useEffect)(() => {
				if (collapsed) document.body.setAttribute("data-dsh-sidebar-collapsed", "");
				else document.body.removeAttribute("data-dsh-sidebar-collapsed");
				return () => {
					document.body.removeAttribute("data-dsh-sidebar-collapsed");
				};
			}, [collapsed]);
			const desktopTitleBarStrip = (0, react.useMemo)(() => {
				const raw = document.documentElement.getAttribute("data-dsh-title-bar-height");
				const value = raw === null ? Number.NaN : Number(raw);
				return Number.isFinite(value) && value > 0 ? value : void 0;
			}, []);
			const titleBarCompat = snapshot.prefs.titleBarCompat || desktopTitleBarStrip !== void 0;
			const titleBarStrip = snapshot.prefs.titleBarCompat ? snapshot.prefs.titleBarStripPx : desktopTitleBarStrip ?? snapshot.prefs.titleBarStripPx;
			(0, react.useEffect)(() => {
				const root = document.documentElement;
				if (titleBarCompat) {
					document.body.setAttribute("data-dsh-title-bar-compat", "");
					root.style.setProperty("--dsh-title-bar-strip", `${titleBarStrip}px`);
				} else {
					document.body.removeAttribute("data-dsh-title-bar-compat");
					root.style.removeProperty("--dsh-title-bar-strip");
				}
				return () => {
					document.body.removeAttribute("data-dsh-title-bar-compat");
					root.style.removeProperty("--dsh-title-bar-strip");
				};
			}, [titleBarCompat, titleBarStrip]);
			/**
			* Bottom-panel merge on narrow viewports: whenever a session is current
			* while narrow (mount, session switch, or a desktop→narrow transition),
			* throw the bottom tree's tabs into the right tree. Idempotent — after
			* the first migration the bottom tree is empty and the reducer returns
			* the same reference, so this effect settles immediately.
			*/
			(0, react.useEffect)(() => {
				if (!narrow || sessionId === void 0) return;
				store.reduce(migrateBottomTabs);
			}, [
				narrow,
				sessionId,
				store
			]);
			const [fetchedCwd, setFetchedCwd] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				setFetchedCwd(void 0);
				if (sessionId === void 0 || summaryCwd !== void 0) return;
				let cancelled = false;
				api.sessionCwd({ sessionId }).then((result) => {
					if (!cancelled) setFetchedCwd(result.cwd);
				}).catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [sessionId, summaryCwd]);
			const cwd = summaryCwd ?? fetchedCwd;
			/**
			* Agent terminals push: subscribe to the host's live list of agent-owned
			* terminals for this session (created by the model through the
			* `terminal_create` tool). The host pushes a JSON array on every
			* create / close / exit; the sidebar reconciles the list into tabs
			* (id `agent:<uuid>`, title from the agent). A disconnected socket
			* retries with a short backoff so a refresh or transient drop reattaches
			* the same shell without losing the agent's work — capped like the
			* terminal view's own reconnect loop, so a refused endpoint never spins
			* forever (the next session switch restarts the loop).
			* While the terminal tab type is disabled in settings, pushes are
			* ignored (no auto-added tabs); re-enabling makes the next push converge.
			*/
			(0, react.useEffect)(() => {
				if (sessionId === void 0) return;
				let socket = null;
				let retry;
				let closed = false;
				let failures = 0;
				const connect = () => {
					if (closed) return;
					const url = new URL("/sidebar/ws/agent-terminals", location.origin);
					url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
					url.search = new URLSearchParams({ sessionId }).toString();
					socket = new WebSocket(url.toString());
					socket.onmessage = (event) => {
						if (typeof event.data !== "string") return;
						try {
							const list = JSON.parse(event.data);
							if (!Array.isArray(list)) return;
							store.reduce((s) => ctx.betterSidebar?.isTabEnabled("terminal") === false ? s : reconcileAgentTerminals(s, list));
						} catch {}
					};
					socket.onclose = () => {
						if (closed) return;
						failures += 1;
						if (failures >= FAILURE_LIMIT) {
							console.error("[dsh-better-sidebar] agent-terminals connection failed; stopping reconnect loop", sessionId);
							return;
						}
						retry = window.setTimeout(connect, 2e3);
					};
					socket.onerror = () => {
						socket?.close();
					};
				};
				connect();
				return () => {
					closed = true;
					window.clearTimeout(retry);
					socket?.close();
				};
			}, [sessionId, store]);
			/**
			* Subagent auto-activation: the moment the current conversation spawns its
			* FIRST direct subagent (a 0 → N transition on the list feed), the "auto
			* open" pref is on, and the Subagent tab type is enabled in settings,
			* open the panel (if collapsed) and focus the Subagent page
			* (single-instance: an existing tab is focused, never duplicated).
			* Switching to a session that already has subagents never triggers — its
			* baseline starts at the current count — so a deliberate layout is never
			* fought.
			*/
			const listBaselineRef = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				const prev = listBaselineRef.current;
				listBaselineRef.current = sessionList;
				if (sessionId === void 0 || prev === void 0) return;
				if (!detectNewDirectSubagent(prev, sessionList, sessionId)) return;
				if (!store.getPrefs().autoOpenSubagent) return;
				if (ctx.betterSidebar?.isTabEnabled("subagent") === false) return;
				store.reduce((s) => s.panelOpen ? s : togglePanel(s));
				store.reduce((s) => ({
					...s,
					activePane: firstLeaf(s.splits).id
				}));
				ctx.betterSidebar?.openTab({
					type: "subagent",
					title: t("subagent")
				});
			}, [
				sessionList,
				sessionId,
				store,
				ctx
			]);
			/**
			* Job auto-activation: the moment a NEW background job appears for the
			* current conversation (a job id the previous snapshot lacked), the
			* auto-open pref is on, and the Jobs tab type is enabled, open the panel
			* (if collapsed) and focus the Jobs page. Unlike the subagent trigger
			* (0 → N only), ANY new job id triggers: the agent may start several
			* jobs in one session, and each should surface. A fresh page load never
			* triggers — its baseline starts at the current snapshot.
			*/
			const jobBaselineRef = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				const prev = jobBaselineRef.current;
				jobBaselineRef.current = sessionList;
				if (sessionId === void 0 || prev === void 0) return;
				if (!detectNewJob(prev, sessionList, sessionId)) return;
				if (!store.getPrefs().autoOpenJobs) return;
				if (ctx.betterSidebar?.isTabEnabled("subagent") === false) return;
				store.reduce((s) => s.panelOpen ? s : togglePanel(s));
				store.reduce((s) => ({
					...s,
					activePane: firstLeaf(s.splits).id
				}));
				ctx.betterSidebar?.openTab({
					type: "subagent",
					title: t("subagent")
				});
			}, [
				sessionList,
				sessionId,
				store,
				ctx
			]);
			/**
			* Topology jump-back: clicking a subagent node on the Subagent page calls
			* the official `openSubagent`, which switches the sidebar to that child
			* session's OWN layout (a fresh child session defaults to the explorer).
			* The README contract says the Subagent page must stay open with the jumped
			* node highlighted — so once the current session becomes the recorded jump
			* target, re-open the Subagent page on top of the child's layout (expanding
			* the panel first if it is collapsed). Only this explicit node click arms
			* the flag, so switching to a subagent session by any other means keeps
			* that session's own layout untouched.
			*/
			const subagentJumpRef = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				const pending = subagentJumpRef.current;
				if (pending === void 0 || sessionId !== pending) return;
				subagentJumpRef.current = void 0;
				store.reduce((s) => s.panelOpen ? s : togglePanel(s));
				store.reduce((s) => ({
					...s,
					activePane: firstLeaf(s.splits).id
				}));
				ctx.betterSidebar?.openTab({
					type: "subagent",
					title: t("subagent")
				});
			}, [
				sessionId,
				store,
				ctx
			]);
			const [centerRect, setCenterRect] = (0, react.useState)({
				left: 0,
				right: 0
			});
			const centerColRef = (0, react.useRef)(null);
			const draggingRef = (0, react.useRef)(false);
			const measureCenter = (0, react.useCallback)(() => {
				if (draggingRef.current) return;
				const col = centerColRef.current;
				if (col === null) return;
				const rect = col.getBoundingClientRect();
				setCenterRect((prev) => prev.left === rect.left && prev.right === rect.right ? prev : {
					left: rect.left,
					right: rect.right
				});
			}, []);
			(0, react.useEffect)(() => {
				let disposed = false;
				let observer;
				const locate = () => {
					if (disposed) return;
					const col = document.querySelector("#root [data-slot=\"conversation\"]")?.parentElement;
					if (col === void 0) {
						if (centerColRef.current !== null) {
							centerColRef.current = null;
							observer?.disconnect();
							observer = void 0;
						}
						return;
					}
					if (centerColRef.current !== col) {
						centerColRef.current = col;
						observer?.disconnect();
						observer = new ResizeObserver(measureCenter);
						observer.observe(col);
					}
					measureCenter();
				};
				locate();
				const watcher = new MutationObserver(locate);
				const root = document.getElementById("root");
				if (root !== null) watcher.observe(root, { childList: true });
				return () => {
					disposed = true;
					observer?.disconnect();
					watcher.disconnect();
					centerColRef.current = null;
				};
			}, [measureCenter]);
			/**
			* Bottom-panel first-expansion auto terminal: the FIRST time the user
			* expands the bottom panel in a session, try to open a fresh terminal tab
			* there. "Try" is literal — the terminal's own quota and enable switch
			* gate the attempt (a full quota or a disabled terminal type makes it a
			* no-op). Gated on the bottomPanelAutoTerminal pref (the terminal tab's
			* nested settings toggle, default on). Only a false→true TRANSITION fires
			* (a panel persisted open never counts as an expansion), and the session's
			* bottomOpenedOnce flag is set atomically with the first fire so later
			* expansions never repeat it.
			*/
			const bottomWasOpenRef = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				if (narrow) return;
				if (state === void 0) return;
				const wasOpen = bottomWasOpenRef.current;
				bottomWasOpenRef.current = state.bottomOpen;
				if (wasOpen === void 0 || wasOpen || !state.bottomOpen) return;
				if (state.bottomOpenedOnce) return;
				if (store.getPrefs().bottomPanelAutoTerminal === false) return;
				if (ctx.betterSidebar?.isTabEnabled("terminal") === false) return;
				store.reduce((s) => ({
					...s,
					activePane: firstLeaf(s.bottomSplits).id,
					bottomOpenedOnce: true
				}));
				ctx.betterSidebar?.openTab({ type: "terminal" });
			}, [
				state,
				store,
				ctx,
				narrow
			]);
			const panelRef = (0, react.useRef)(null);
			const bottomRef = (0, react.useRef)(null);
			const cornerRef = (0, react.useRef)(null);
			const widthDrag = (0, react.useRef)({
				startX: 0,
				startWidth: 0
			});
			const [draggingWidth, setDraggingWidth] = (0, react.useState)(false);
			const bottomDrag = (0, react.useRef)({
				startY: 0,
				startHeight: 0
			});
			const [draggingBottom, setDraggingBottom] = (0, react.useState)(false);
			const cornerDrag = (0, react.useRef)({
				startX: 0,
				startY: 0,
				startWidth: 0,
				startHeight: 0
			});
			const [draggingCorner, setDraggingCorner] = (0, react.useState)(false);
			const anyDragging = draggingWidth || draggingBottom || draggingCorner;
			(0, react.useEffect)(() => {
				draggingRef.current = anyDragging;
				if (!anyDragging) measureCenter();
			}, [anyDragging, measureCenter]);
			const clampWidth = (width) => Math.min(Math.max(280, Math.round(width)), Math.max(280, window.innerWidth));
			const clampHeight = (height) => Math.min(Math.max(120, Math.round(height)), Math.max(120, window.innerHeight - 280));
			/** Apply a drag size to the DOM without touching React state or the store.
			*  The bottom panel's right edge tracks the right panel's left edge HERE
			*  too — React state only updates on release, so the inline right must be
			*  written directly or the bottom panel would lag the sidebar mid-drag. */
			const applyDrag = (width, height) => {
				panelRef.current?.style.setProperty("width", `${width}px`);
				bottomRef.current?.style.setProperty("height", `${height}px`);
				bottomRef.current?.style.setProperty("right", `${window.innerWidth - centerRect.right + (width - (state?.width ?? 0))}px`);
				document.documentElement.style.setProperty("--dsh-sidebar-width", `${width}px`);
				document.documentElement.style.setProperty("--dsh-sidebar-height", `${height}px`);
				if (cornerRef.current !== null) {
					cornerRef.current.style.left = `${window.innerWidth - width - 6}px`;
					cornerRef.current.style.top = `${window.innerHeight - height - 6}px`;
				}
			};
			const dragFrame = (0, react.useRef)(null);
			const pendingDrag = (0, react.useRef)(null);
			const scheduleDrag = (width, height) => {
				pendingDrag.current = {
					width,
					height
				};
				if (dragFrame.current !== null) return;
				dragFrame.current = requestAnimationFrame(() => {
					dragFrame.current = null;
					const pending = pendingDrag.current;
					if (pending !== null) {
						pendingDrag.current = null;
						applyDrag(pending.width, pending.height);
					}
				});
			};
			/** Flush any pending drag write and stop scheduling (the store commit on
			*  pointer up applies the final clamped values). */
			const stopDragScheduling = () => {
				if (dragFrame.current !== null) {
					cancelAnimationFrame(dragFrame.current);
					dragFrame.current = null;
				}
				pendingDrag.current = null;
			};
			(0, react.useEffect)(() => {
				const width = !narrow && snapshot.state?.panelOpen === true ? Math.min(snapshot.state.width, window.innerWidth) : 0;
				const height = !narrow && snapshot.state?.bottomOpen === true ? Math.min(snapshot.state.bottomHeight, window.innerHeight) : 0;
				document.documentElement.style.setProperty("--dsh-sidebar-width", `${width}px`);
				document.documentElement.style.setProperty("--dsh-sidebar-height", `${height}px`);
				return () => {
					document.documentElement.style.removeProperty("--dsh-sidebar-width");
					document.documentElement.style.removeProperty("--dsh-sidebar-height");
				};
			}, [
				narrow,
				snapshot.state?.panelOpen,
				snapshot.state?.width,
				snapshot.state?.bottomOpen,
				snapshot.state?.bottomHeight
			]);
			(0, react.useEffect)(() => {
				if (anyDragging) document.body.setAttribute("data-dsh-sidebar-dragging", "");
				else document.body.removeAttribute("data-dsh-sidebar-dragging");
			}, [anyDragging]);
			const actions = (0, react.useMemo)(() => ({
				closeTab: (paneId, tabId) => {
					const current = store.getSnapshot().state;
					const tab = (current === void 0 ? void 0 : leafWithTab(current.splits, tabId) ?? leafWithTab(current.bottomSplits, tabId))?.tabs.find((candidate) => candidate.id === tabId);
					ctx.betterSidebar?.closeTab(tabId, sessionId === void 0 ? void 0 : {
						sessionId,
						cwd
					});
					if (tab?.type === "terminal") {
						if (isAgentTabId(tabId)) {
							const uuid = agentUuidOf(tabId);
							api.agentPtyClose(uuid).catch(() => {});
						} else if (sessionId !== void 0) api.ptyClose({
							sessionId,
							cwd
						}, tabId).catch(() => {});
					}
				},
				activateTab: (paneId, tabId) => {
					ctx.betterSidebar?.activateTab(tabId, sessionId === void 0 ? void 0 : {
						sessionId,
						cwd
					});
				},
				focusPane: (paneId) => {
					store.reduce((s) => ({
						...s,
						activePane: paneId
					}));
				},
				moveTabToEdge: (payload, toPane, zone) => {
					store.reduce((s) => moveTabToEdge(s, payload.paneId, payload.tabId, toPane, zone));
				},
				moveTabBefore: (payload, toPane, beforeTabId) => {
					store.reduce((s) => {
						let index = -1;
						const source = leafWithTab(s.splits, beforeTabId);
						if (source !== void 0 && source.id === toPane) index = source.tabs.findIndex((tab) => tab.id === beforeTabId);
						return moveTab(s, payload.paneId, payload.tabId, toPane, index);
					});
				},
				resizeSplit: (splitId, index, deltaFrac) => {
					store.reduce((s) => resizeSplitIn(s, splitId, index, deltaFrac));
				}
			}), [
				store,
				sessionId,
				cwd
			]);
			/**
			* The explorer's @-reference button: append `@<relative path>` to the
			* session's composer draft (space-separated). The conversation service is
			* resolved lazily through `ctx.get` (the inject-free read — the app's own
			* plugins read 'conversation' the same way); a missing service or scope
			* degrades to a logged no-op, never a crash. Defined above the no-session
			* early return — a hook must never sit behind a conditional return
			* (React counts hooks per render).
			*/
			const referenceInChat = (0, react.useCallback)((path) => {
				if (sessionId === void 0) return;
				appendToDraft(ctx, sessionId, `@${relativeTo(cwd ?? "", path)}`);
			}, [
				ctx,
				sessionId,
				cwd
			]);
			if (state === void 0 || sessionId === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: sidebar_module_css_default.toggleCluster,
				children: [!narrow && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: t("noSession"),
					side: "bottom",
					delayMs: 500,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: sidebar_module_css_default.toggleButton,
						disabled: true,
						"aria-label": t("noSession"),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPanelBottomOutline16, {})
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: t("noSession"),
					side: "bottom",
					delayMs: 500,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: sidebar_module_css_default.toggleButton,
						disabled: true,
						"aria-label": t("noSession"),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPanelRightOutline16, {})
					})
				})]
			});
			const onNewTab = (optionId) => {
				const service = ctx.betterSidebar;
				const descriptor = service?.getTab(optionId);
				if (descriptor === void 0) return;
				const title = typeof descriptor.title === "function" ? descriptor.title() : descriptor.title;
				service.openTab({
					type: optionId,
					title
				}, {
					sessionId,
					cwd
				});
			};
			/**
			* The explorer's @-reference button: append `@<relative path>` to the
			* session's composer draft (space-separated). Resolves the session-scope
			* ctx and the conversation input service at click time; a missing service
			* or scope degrades to a logged no-op, never a crash.
			*/
			/** The tab icon from the tab-type registry (shared by every workbench). */
			const tabIconOf = (tab) => {
				const descriptor = ctx.betterSidebar?.getTab(tab.type);
				if (descriptor === void 0) return null;
				return typeof descriptor.icon === "function" ? descriptor.icon(14) : descriptor.icon;
			};
			/**
			* The tab badge from the tab-type registry: a count (99+ capped) or a
			* short text pill. A throwing badge is swallowed (no pill) — the tab
			* strip must never break because a plugin's badge computation failed.
			*/
			const tabBadgeOf = (tab) => {
				const descriptor = ctx.betterSidebar?.getTab(tab.type);
				if (descriptor?.badge === void 0) return null;
				let value;
				try {
					value = descriptor.badge(ctx, {
						sessionId,
						cwd
					}, state);
				} catch (error) {
					console.error("[dsh-better-sidebar] tab badge error:", error);
					return null;
				}
				if (value === null || value === void 0 || value === "") return null;
				const text = typeof value === "number" ? value > 99 ? "99+" : String(value) : String(value);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: sidebar_module_css_default.tabBadge,
					children: text
				});
			};
			/**
			* Render one tab's content. `active` (from the workbench) tells whether
			* this tab is the active one in its pane; combined with the panel's
			* open/closed state it gates live views (the Subagent topology pauses its
			* polling while the page is not actually visible). The pane id travels
			* with the tab so diff tabs can split below their source pane.
			*/
			const renderTab = (tab, active, paneId, bottom = false) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TabContent, {
				tab,
				sessionId,
				cwd,
				expanded: state.expanded,
				onToggleDir: (path) => {
					store.reduce((s) => toggleExpanded(s, path));
				},
				onReferenceFile: referenceInChat,
				ctx,
				store,
				visible: bottom ? state.bottomOpen && active : state.panelOpen && active,
				onSubagentJump: (childSessionId) => {
					subagentJumpRef.current = childSessionId;
				},
				onOpenDiff: (diffTab) => {
					store.reduce((s) => openDiffTab(s, paneId, diffTab));
				}
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: sidebar_module_css_default.toggleCluster,
					children: [!narrow && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: state.bottomOpen ? t("collapseBottomPanel") : t("expandBottomPanel"),
						side: "bottom",
						delayMs: 500,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.toggleButton,
							"aria-label": state.bottomOpen ? t("collapseBottomPanel") : t("expandBottomPanel"),
							onClick: () => {
								store.reduce(toggleBottomPanel);
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPanelBottomOutline16, {})
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: state.panelOpen ? t("collapse") : t("expand"),
						side: "bottom",
						delayMs: 500,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: sidebar_module_css_default.toggleButton,
							"aria-label": state.panelOpen ? t("collapse") : t("expand"),
							onClick: () => {
								store.reduce(togglePanel);
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPanelRightOutline16, {})
						})
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: panelRef,
					className: clsx(sidebar_module_css_default.panel, !state.panelOpen && sidebar_module_css_default.panelHidden),
					style: { width: narrow ? "100vw" : Math.min(state.width, window.innerWidth) },
					"data-dragging": anyDragging || void 0,
					children: [!narrow && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: clsx(sidebar_module_css_default.panelResize, draggingWidth && sidebar_module_css_default.panelResizeActive),
						onPointerDown: (event) => {
							event.preventDefault();
							event.currentTarget.setPointerCapture(event.pointerId);
							widthDrag.current = {
								startX: event.clientX,
								startWidth: state.width
							};
							setDraggingWidth(true);
						},
						onPointerMove: (event) => {
							if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
							const { startX, startWidth } = widthDrag.current;
							const width = clampWidth(startWidth + (startX - event.clientX));
							const height = state.bottomOpen ? Math.min(state.bottomHeight, window.innerHeight) : 0;
							scheduleDrag(width, height);
						},
						onPointerUp: (event) => {
							if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
							event.currentTarget.releasePointerCapture(event.pointerId);
							const { startX, startWidth } = widthDrag.current;
							stopDragScheduling();
							store.reduce((s) => setWidth(s, startWidth + (startX - event.clientX)));
							setDraggingWidth(false);
						}
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.panelBody,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Workbench, {
							state,
							newTabOptions: buildNewTabOptions(state, ctx, {
								sessionId,
								cwd
							}),
							actions,
							onNewTab,
							renderTab,
							getTabIcon: tabIconOf,
							getTabBadge: tabBadgeOf
						})
					})]
				}),
				!narrow && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: bottomRef,
					className: clsx(sidebar_module_css_default.bottomPanel, !state.bottomOpen && sidebar_module_css_default.bottomPanelHidden),
					style: {
						height: Math.min(state.bottomHeight, window.innerHeight),
						left: centerRect.left,
						right: window.innerWidth - centerRect.right,
						borderRight: state.panelOpen ? "1px solid var(--dsw-alias-border-l2)" : void 0
					},
					"data-dragging": draggingBottom || draggingCorner || void 0,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: clsx(sidebar_module_css_default.bottomResize, draggingBottom && sidebar_module_css_default.bottomResizeActive),
							onPointerDown: (event) => {
								event.preventDefault();
								event.currentTarget.setPointerCapture(event.pointerId);
								bottomDrag.current = {
									startY: event.clientY,
									startHeight: state.bottomHeight
								};
								setDraggingBottom(true);
							},
							onPointerMove: (event) => {
								if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
								const { startY, startHeight } = bottomDrag.current;
								const height = clampHeight(startHeight + (startY - event.clientY));
								scheduleDrag(Math.min(state.width, window.innerWidth), height);
							},
							onPointerUp: (event) => {
								if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
								event.currentTarget.releasePointerCapture(event.pointerId);
								const { startY, startHeight } = bottomDrag.current;
								stopDragScheduling();
								store.reduce((s) => setBottomHeight(s, startHeight + (startY - event.clientY)));
								setDraggingBottom(false);
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
							label: t("collapseBottomPanel"),
							side: "bottom",
							delayMs: 500,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: sidebar_module_css_default.bottomClose,
								"aria-label": t("collapseBottomPanel"),
								onClick: () => {
									store.reduce(toggleBottomPanel);
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseFill14, {})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: sidebar_module_css_default.panelBody,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Workbench, {
								state,
								tree: state.bottomSplits,
								newTabOptions: buildNewTabOptions(state, ctx, {
									sessionId,
									cwd
								}),
								actions,
								onNewTab,
								renderTab: (tab, active, paneId) => renderTab(tab, active, paneId, true),
								getTabIcon: tabIconOf,
								getTabBadge: tabBadgeOf
							})
						})
					]
				}),
				!narrow && state.panelOpen && state.bottomOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					ref: cornerRef,
					className: sidebar_module_css_default.cornerHandle,
					style: {
						left: window.innerWidth - state.width - 6,
						top: window.innerHeight - state.bottomHeight - 6
					},
					"data-dragging": draggingCorner || void 0,
					onPointerDown: (event) => {
						event.preventDefault();
						event.currentTarget.setPointerCapture(event.pointerId);
						cornerDrag.current = {
							startX: event.clientX,
							startY: event.clientY,
							startWidth: state.width,
							startHeight: state.bottomHeight
						};
						setDraggingCorner(true);
					},
					onPointerMove: (event) => {
						if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
						const { startX, startY, startWidth, startHeight } = cornerDrag.current;
						const width = clampWidth(startWidth + (startX - event.clientX));
						const height = clampHeight(startHeight + (startY - event.clientY));
						scheduleDrag(width, height);
					},
					onPointerUp: (event) => {
						if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
						event.currentTarget.releasePointerCapture(event.pointerId);
						const { startX, startY, startWidth, startHeight } = cornerDrag.current;
						stopDragScheduling();
						store.reduce((s) => setBottomHeight(setWidth(s, startWidth + (startX - event.clientX)), startHeight + (startY - event.clientY)));
						setDraggingCorner(false);
					}
				})
			] });
		}
		//#endregion
		//#region src/client/link-intercept.ts
		/**
		* Chat/GUI external-link interception: clicking an http(s) link that points
		* OUTSIDE the GUI (chat messages, tool rows, prose mentions) opens the
		* sidebar instead of a new browser tab. Gated by the caller through
		* `takeoverEnabled(url)` — the `browserInterceptLinks` master, the URL's
		* protocol flag (`browserInterceptHttp` / `browserInterceptHttps`) and the
		* target tab's enable switch — and a Ctrl/Cmd/Shift/Alt-modified click
		* always bypasses the takeover so the user can still force a real browser
		* tab.
		*
		* Only the GUI's OWN document is watched — links inside the browser tab's
		* sandboxed iframe live in another document and never bubble here (and
		* their clicks must keep working inside the sidebar).
		*/
		/** The pure decision: the URL to open in the sidebar, or null to let the
		*  click fall through. Extracted so the policy is unit-testable without a
		*  DOM. `anchorHref` must be the ABSOLUTE href (`<a>.href` already is).
		*  The protocol/same-origin policy lives HERE; the prefs gates (master +
		*  protocol flags + target enablement) live in the caller's
		*  `takeoverEnabled(url)` callback. */
		function shouldInterceptLink(anchorHref, selfOrigin) {
			let url;
			try {
				url = new URL(anchorHref);
			} catch {
				return null;
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") return null;
			try {
				if (url.origin === new URL(selfOrigin).origin) return null;
			} catch {}
			return url.href;
		}
		/** Whether a left-click may be taken over (unmodified left click only). */
		function isPlainLeftClick(event) {
			return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
		}
		/**
		* Register the document-level click capture that funnels external links
		* into the sidebar. Returns the disposer (HMR-safe).
		*/
		function registerLinkInterception(opts) {
			const onClick = (event) => {
				if (!isPlainLeftClick(event)) return;
				if (event.defaultPrevented) return;
				const target = event.target;
				if (target === null || typeof target.closest !== "function") return;
				const anchor = target.closest("a[href]");
				if (anchor === null) return;
				const url = shouldInterceptLink(anchor.href, opts.selfOrigin);
				if (url === null) return;
				if (!opts.takeoverEnabled(new URL(url))) return;
				event.preventDefault();
				opts.openInSidebar(url);
			};
			document.addEventListener("click", onClick, true);
			return () => {
				document.removeEventListener("click", onClick, true);
			};
		}
		//#endregion
		//#region src/client/ime-guard.ts
		/**
		* IME-composition key guard.
		*
		* While a Chinese/Japanese/Korean input method is composing (the user is
		* picking a candidate from the IME window), every pressed key BELONGS to the
		* input method: arrows move the candidate highlight, Enter/Space confirm the
		* composition, Escape cancels it. Page code must not process those keys —
		* a component that does (a number stepper calling preventDefault() on
		* ArrowUp/ArrowDown, a submit handler reacting to Enter, ...) silently
		* breaks the IME: candidates stop responding, the composition gets torn
		* apart, and only bare letters come out.
		*
		* This guard enforces that rule at the document boundary: a capture-phase
		* keydown/keyup listener that stops the event from propagating further
		* whenever a composition is in progress. Because it runs in the capture
		* phase on `document` — the outermost node — it fires BEFORE React's
		* delegated handlers (attached at the root container) and before any native
		* target/bubble listener, so an inlined third-party component (e.g. the
		* Univer office UI bundled into this plugin) can never intercept
		* composition keys. The browser's native IME processing is untouched:
		* stopPropagation only silences page JS, not the default action.
		*
		* The composition signal follows the DSH core convention (InputBar's IME
		* guard, issue #535): `isComposing` for modern engines, keyCode 229 as the
		* legacy signal engines emit without isComposing.
		*/
		/** The pure decision: is this keyboard event part of an IME composition? */
		function isImeComposition(event) {
			return event.isComposing || event.keyCode === 229;
		}
		/**
		* Register the document-level capture guard. Returns the disposer
		* (HMR-safe; call through `ctx.effect`).
		*/
		function registerImeGuard() {
			const onKey = (event) => {
				if (isImeComposition(event)) event.stopPropagation();
			};
			document.addEventListener("keydown", onKey, true);
			document.addEventListener("keyup", onKey, true);
			return () => {
				document.removeEventListener("keydown", onKey, true);
				document.removeEventListener("keyup", onKey, true);
			};
		}
		//#endregion
		//#region src/client/prefs.ts
		/** Validate one raw resolved value into {@link SidebarPrefs}. Used for the
		* settings.get payload AND the settings.update response (both carry the
		* layered resolved value); any malformed field falls back to its default.
		* @param value - the raw resolved section from the settings wire.
		* @returns validated prefs (always well-formed).
		*/
		function parsePrefs(value) {
			if (value === null || typeof value !== "object") return { ...SIDEBAR_PREFS_DEFAULTS };
			const record = value;
			return {
				openByDefault: typeof record.openByDefault === "boolean" ? record.openByDefault : SIDEBAR_PREFS_DEFAULTS.openByDefault,
				defaultWidthPercent: typeof record.defaultWidthPercent === "number" && Number.isFinite(record.defaultWidthPercent) ? clampWidthPercent(record.defaultWidthPercent) : SIDEBAR_PREFS_DEFAULTS.defaultWidthPercent,
				autoOpenSubagent: typeof record.autoOpenSubagent === "boolean" ? record.autoOpenSubagent : SIDEBAR_PREFS_DEFAULTS.autoOpenSubagent,
				autoOpenJobs: typeof record.autoOpenJobs === "boolean" ? record.autoOpenJobs : SIDEBAR_PREFS_DEFAULTS.autoOpenJobs,
				agentTerminalTools: typeof record.agentTerminalTools === "boolean" ? record.agentTerminalTools : SIDEBAR_PREFS_DEFAULTS.agentTerminalTools,
				bottomPanelAutoTerminal: typeof record.bottomPanelAutoTerminal === "boolean" ? record.bottomPanelAutoTerminal : SIDEBAR_PREFS_DEFAULTS.bottomPanelAutoTerminal,
				terminalFontFamily: typeof record.terminalFontFamily === "string" ? record.terminalFontFamily : SIDEBAR_PREFS_DEFAULTS.terminalFontFamily,
				terminalFontSize: typeof record.terminalFontSize === "number" && Number.isFinite(record.terminalFontSize) ? clampTerminalFontSize(record.terminalFontSize) : SIDEBAR_PREFS_DEFAULTS.terminalFontSize,
				interceptOpenPath: typeof record.interceptOpenPath === "boolean" ? record.interceptOpenPath : SIDEBAR_PREFS_DEFAULTS.interceptOpenPath,
				titleBarCompat: typeof record.titleBarCompat === "boolean" ? record.titleBarCompat : SIDEBAR_PREFS_DEFAULTS.titleBarCompat,
				titleBarStripPx: typeof record.titleBarStripPx === "number" && Number.isFinite(record.titleBarStripPx) ? clampTitleBarStrip(record.titleBarStripPx) : SIDEBAR_PREFS_DEFAULTS.titleBarStripPx,
				htmlViewerNoSandbox: typeof record.htmlViewerNoSandbox === "boolean" ? record.htmlViewerNoSandbox : SIDEBAR_PREFS_DEFAULTS.htmlViewerNoSandbox,
				htmlViewerDefaultUnsafe: typeof record.htmlViewerDefaultUnsafe === "boolean" ? record.htmlViewerDefaultUnsafe : SIDEBAR_PREFS_DEFAULTS.htmlViewerDefaultUnsafe,
				browserNoSandbox: typeof record.browserNoSandbox === "boolean" ? record.browserNoSandbox : SIDEBAR_PREFS_DEFAULTS.browserNoSandbox,
				browserInterceptLinks: typeof record.browserInterceptLinks === "boolean" ? record.browserInterceptLinks : SIDEBAR_PREFS_DEFAULTS.browserInterceptLinks,
				browserInterceptHttp: typeof record.browserInterceptHttp === "boolean" ? record.browserInterceptHttp : SIDEBAR_PREFS_DEFAULTS.browserInterceptHttp,
				browserInterceptHttps: typeof record.browserInterceptHttps === "boolean" ? record.browserInterceptHttps : SIDEBAR_PREFS_DEFAULTS.browserInterceptHttps,
				tabsEnabled: booleanMapOf(record.tabsEnabled),
				viewersEnabled: booleanMapOf(record.viewersEnabled),
				pluginSettings: pluginSettingsMapOf(record.pluginSettings)
			};
		}
		/**
		* Validate the plugin-owned settings map (v0.12.0+): `{ descriptorId: { key:
		* value } }`, nested open maps. Any non-object value (or a malformed whole)
		* falls back to the empty map — the schema defaults already guard the wire
		* shape, this is the client's second line.
		*/
		function pluginSettingsMapOf(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
			const out = {};
			for (const [id, blob] of Object.entries(value)) if (blob !== null && typeof blob === "object" && !Array.isArray(blob)) out[id] = blob;
			return out;
		}
		/**
		* Validate one enable-switch map (per-tab / per-viewer). Only boolean values
		* survive; a non-object or a non-boolean entry falls back to the empty map /
		* drops the entry — an absent key means the feature stays enabled.
		*/
		function booleanMapOf(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
			const out = {};
			for (const [key, item] of Object.entries(value)) if (typeof item === "boolean") out[key] = item;
			return out;
		}
		/**
		* Read the resolved side card preferences through the plugin's settings route.
		* @param settings - the settings wire face (the plugin api by default).
		* @returns validated prefs, or the schema defaults when the route rejects,
		* the namespace is absent, or a stored value violates the contract.
		*/
		async function loadPrefs(settings) {
			try {
				return parsePrefs((await settings.settingsGet()).value);
			} catch {
				return { ...SIDEBAR_PREFS_DEFAULTS };
			}
		}
		//#endregion
		//#region src/client/plugins-shared.ts
		/**
		* Shared vocabulary of the recommended plugin catalogs: the entry shape and
		* the GitHub topic URL. The two catalogs live in sibling modules —
		* `plugins-tabs.ts` (tab registrations) and `plugins-viewers.ts` (file
		* previewer registrations) — and are shown in the two "add plugin" modals
		* (Side card settings → the dashed cards at the end of the 侧边栏内容 /
		* 文件预览 grids).
		*/
		/** The GitHub topic page listing every repo tagged `dsh-better-sidebar`. */
		const PLUGIN_TOPIC_URL = "https://github.com/topics/dsh-better-sidebar";
		//#endregion
		//#region src/client/plugins-tabs.ts
		/**
		* The built-in catalog of TAB-registration plugins (sidebar pages),
		* shown in the "add tab plugin" modal (Side card settings → 侧边栏内容 grid
		* → the dashed card). Adding an entry: append one object here (unique
		* `id` = npm package name, `url` = GitHub repo, `description` =
		* i18n-friendly (add a `pluginXxxDesc` key in locales.ts), `install` = the
		* full one-line install script — it starts with `cd ~/.dsh` so the install
		* runs with the DSH home as the working directory). Data integrity is
		* guarded by `tests/plugin-list.spec.ts`.
		*/
		/** Tab-registration plugins (alphabetical order). */
		const builtinTabPlugins = [{
			id: "@dsh-external/dsh-sentinel",
			name: "dsh-sentinel 唤醒系统",
			url: "https://github.com/fuhefei/dsh-sentinel",
			description: () => t("pluginSentinelDesc"),
			install: "cd ~/.dsh && dsh plugin --profile web add \"github:fuhefei/dsh-sentinel#v0.7.0\""
		}, {
			id: "dsh-sidebar-qa",
			name: "dsh-sidebar-qa 划选追问",
			url: "https://github.com/ChenRuoT/dsh-sidebar-qa",
			description: () => t("pluginSidebarQaDesc"),
			install: "cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add git+https://github.com/ChenRuoT/dsh-sidebar-qa.git"
		}];
		//#endregion
		//#region src/client/plugins-viewers.ts
		/**
		* The built-in catalog of FILE-PREVIEWER plugins (file-type previewers),
		* shown in the "add preview plugin" modal (Side card settings → 文件预览
		* grid → the dashed card). Adding an entry: append one object here (unique
		* `id` = npm package name, `url` = GitHub repo, `description` =
		* i18n-friendly, `install` = the full shell command pre-filled into the
		* install terminal — it starts with `cd ~/.dsh` so the install runs with
		* the DSH home as the working directory). Data integrity is guarded by
		* `tests/plugin-list.spec.ts`.
		*/
		/** File-previewer plugins (alphabetical order). */
		const builtinViewerPlugins = [{
			id: "@huanlin/dsh-plugin-better-sidebar-plugin-office",
			name: "Office 预览插件",
			url: "https://github.com/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office",
			description: () => t("pluginOfficeDesc"),
			install: "cd ~/.dsh && dsh plugin --profile web add @huanlin/dsh-plugin-better-sidebar-plugin-office"
		}];
		//#endregion
		//#region \0dsh-css:C:\Users\delinger\Desktop\dsh\_upstream2\DSH-better-sidebar\src\client\SideCardSection.module.css.mjs
		const css$1 = ".RQvqka_section{flex-direction:column;gap:14px;width:100%;height:100%;min-height:0;display:flex;overflow-y:auto}.RQvqka_intro{color:var(--dsw-alias-label-tertiary);margin:0;padding:0 2px;font-size:13px;line-height:20px}.RQvqka_group{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:16px;flex-direction:column;flex:none;gap:8px;padding:18px 20px 20px;display:flex}.RQvqka_groupHeading{color:var(--dsw-alias-label-primary);align-items:baseline;gap:7px;padding:0 2px 6px;font-size:13px;font-weight:600;line-height:20px;display:flex}.RQvqka_count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;font-weight:400;line-height:18px}.RQvqka_grid{grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px;display:grid}.RQvqka_card{border:1px solid var(--dsw-alias-border-l2);font:inherit;color:inherit;cursor:pointer;background:0 0;border-radius:12px;flex-direction:column;transition:background .12s,border-color .12s;display:flex;position:relative}.RQvqka_card:not(.RQvqka_cardOn):hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-dimmed)}.RQvqka_cardOn{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-interactive-bg-active)}.RQvqka_cardMain{border-radius:inherit;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;flex-direction:column;gap:6px;padding:12px;display:flex}.RQvqka_cardMain:focus-visible,.RQvqka_cardGear:focus-visible,.RQvqka_rowGear:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:2px}.RQvqka_cardTop{align-items:center;gap:8px;min-width:0;display:flex}.RQvqka_cardIconChip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);width:28px;height:28px;color:var(--dsw-alias-label-tertiary);border-radius:8px;flex:none;justify-content:center;align-items:center;display:inline-flex}.RQvqka_cardOn .RQvqka_cardIconChip{border-color:color-mix(in srgb, var(--dsw-alias-button-primary-fill) 35%, transparent);background:color-mix(in srgb, var(--dsw-alias-button-primary-fill) 12%, transparent);color:var(--dsw-alias-button-primary-fill)}.RQvqka_cardTitle{min-width:0;color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;flex:1;font-size:13px;font-weight:600;line-height:20px;overflow:hidden}.RQvqka_cardOn .RQvqka_cardTitle{color:var(--dsw-alias-label-primary)}.RQvqka_cardCheck{background:var(--dsw-alias-button-primary-fill);width:16px;height:16px;color:var(--dsw-alias-bg-layer-3);border-radius:50%;flex:none;justify-content:center;align-items:center;display:inline-flex}.RQvqka_cardDesc{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:16px;overflow:hidden}.RQvqka_addCard{border-style:dashed;border-color:var(--dsw-alias-border-l2);text-align:left;align-items:flex-start;padding:12px}.RQvqka_addCard:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}.RQvqka_addCard:hover .RQvqka_cardTitle{color:var(--dsw-alias-label-primary)}.RQvqka_addCard:hover .RQvqka_cardIconChip{border-color:color-mix(in srgb, var(--dsw-alias-button-primary-fill) 35%, transparent);color:var(--dsw-alias-button-primary-fill)}.RQvqka_addCard:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:2px}.RQvqka_cardOn .RQvqka_cardDesc{color:var(--dsw-alias-label-secondary)}.RQvqka_cardWithGear .RQvqka_cardDesc{padding-right:30px}.RQvqka_cardGear{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;top:46px;right:12px}.RQvqka_cardGear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.RQvqka_rowGear{width:22px;height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.RQvqka_rowGear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.RQvqka_row{border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:16px;padding:12px 2px;display:flex}.RQvqka_row:last-child{border-bottom:none}.RQvqka_rowText{flex-direction:column;gap:4px;min-width:0;display:flex}.RQvqka_title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}.RQvqka_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.RQvqka_switch{cursor:pointer;flex:none;display:inline-flex;position:relative}.RQvqka_switchInput{opacity:0;width:1px;height:1px;margin:0;position:absolute}.RQvqka_switchTrack{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;align-items:center;width:36px;height:20px;padding:2px;transition:background .15s,border-color .15s;display:inline-flex}.RQvqka_switchThumb{background:var(--dsw-alias-label-secondary);border-radius:50%;width:14px;height:14px;transition:transform .15s,background .15s;display:block}.RQvqka_switch:hover .RQvqka_switchTrack{border-color:var(--dsw-alias-label-dimmed)}.RQvqka_switchInput:checked+.RQvqka_switchTrack{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill)}.RQvqka_switchInput:checked+.RQvqka_switchTrack .RQvqka_switchThumb{background:var(--dsw-alias-bg-layer-3);transform:translate(16px)}.RQvqka_switchInput:focus-visible+.RQvqka_switchTrack{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.RQvqka_control{flex:none;align-items:center;gap:6px;display:flex}.RQvqka_percentInput{width:76px}.RQvqka_typedInput{width:200px}.RQvqka_typedInputNumber{width:76px}.RQvqka_suffix{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}.RQvqka_popupDialog.RQvqka_popupDialog{width:min(460px,100%)}.RQvqka_popupRows{flex-direction:column;width:100%;display:flex}.RQvqka_popupRow{border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:16px;padding:14px 2px;display:flex}.RQvqka_popupRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.RQvqka_popupRows>:last-child{border-bottom:none}.RQvqka_done{appearance:none;font:inherit;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.RQvqka_done:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.RQvqka_error{color:var(--dsw-alias-state-error-primary);padding:10px 0 2px;font-size:12px;line-height:17px}.RQvqka_pluginModal.RQvqka_pluginModal{width:min(560px,100%)}.RQvqka_pluginList{flex-direction:column;gap:12px;width:100%;display:flex}.RQvqka_pluginTopicBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);width:100%;font:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);cursor:pointer;border-radius:8px;padding:6px 12px;font-size:12px;line-height:18px}.RQvqka_pluginTopicBtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}.RQvqka_pluginTopicBtn:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:1px}.RQvqka_pluginEmpty{color:var(--dsw-alias-label-tertiary);padding:20px 2px;font-size:12px;line-height:18px}.RQvqka_pluginEntries{flex-direction:column;gap:10px;display:flex}.RQvqka_pluginEntry{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;flex-direction:column;gap:4px;padding:12px;display:flex}.RQvqka_pluginEntryHead{justify-content:space-between;align-items:center;gap:12px;display:flex}.RQvqka_pluginEntryActions{flex:none;align-items:center;gap:6px;display:inline-flex}.RQvqka_pluginJumpBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);font:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border-radius:8px;flex:none;padding:3px 12px;font-size:12px;line-height:1.5}.RQvqka_pluginJumpBtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}.RQvqka_pluginJumpBtn:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:1px}.RQvqka_pluginName{appearance:none;min-width:0;font:inherit;color:var(--dsw-alias-label-primary);text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;background:0 0;border:0;padding:0;font-size:13px;font-weight:600;line-height:20px;text-decoration:none;overflow:hidden}.RQvqka_pluginName:hover{color:var(--dsw-alias-button-primary-fill);text-decoration:underline}.RQvqka_pluginDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.RQvqka_pluginInstall{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);white-space:nowrap;border-radius:8px;padding:6px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;display:block;overflow-x:auto}.RQvqka_pluginCopyBtn{appearance:none;font:inherit;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border:1px solid #0000;border-radius:8px;flex:none;padding:3px 12px;font-size:12px;line-height:1.5}.RQvqka_pluginCopyBtn:hover{background:var(--dsw-alias-button-primary-hover)}.RQvqka_pluginCopyBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}@media (prefers-reduced-motion:reduce){.RQvqka_card,.RQvqka_switchTrack,.RQvqka_switchThumb{transition:none}}";
		const tagId$1 = "dsh-better-sidebar/SideCardSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-better-sidebar";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var SideCardSection_module_css_default = {
			"switchTrack": "RQvqka_switchTrack",
			"cardCheck": "RQvqka_cardCheck",
			"cardTop": "RQvqka_cardTop",
			"pluginModal": "RQvqka_pluginModal",
			"intro": "RQvqka_intro",
			"cardGear": "RQvqka_cardGear",
			"switch": "RQvqka_switch",
			"title": "RQvqka_title",
			"popupRows": "RQvqka_popupRows",
			"pluginList": "RQvqka_pluginList",
			"cardDesc": "RQvqka_cardDesc",
			"rowGear": "RQvqka_rowGear",
			"typedInput": "RQvqka_typedInput",
			"pluginInstall": "RQvqka_pluginInstall",
			"pluginCopyBtn": "RQvqka_pluginCopyBtn",
			"rowText": "RQvqka_rowText",
			"typedInputNumber": "RQvqka_typedInputNumber",
			"pluginEntryHead": "RQvqka_pluginEntryHead",
			"section": "RQvqka_section",
			"suffix": "RQvqka_suffix",
			"pluginDesc": "RQvqka_pluginDesc",
			"popupDialog": "RQvqka_popupDialog",
			"error": "RQvqka_error",
			"pluginEntry": "RQvqka_pluginEntry",
			"grid": "RQvqka_grid",
			"cardIconChip": "RQvqka_cardIconChip",
			"card": "RQvqka_card",
			"cardMain": "RQvqka_cardMain",
			"cardWithGear": "RQvqka_cardWithGear",
			"switchInput": "RQvqka_switchInput",
			"control": "RQvqka_control",
			"cardOn": "RQvqka_cardOn",
			"desc": "RQvqka_desc",
			"pluginTopicBtn": "RQvqka_pluginTopicBtn",
			"pluginEntryActions": "RQvqka_pluginEntryActions",
			"cardTitle": "RQvqka_cardTitle",
			"popupRow": "RQvqka_popupRow",
			"addCard": "RQvqka_addCard",
			"done": "RQvqka_done",
			"pluginEntries": "RQvqka_pluginEntries",
			"pluginName": "RQvqka_pluginName",
			"groupHeading": "RQvqka_groupHeading",
			"pluginJumpBtn": "RQvqka_pluginJumpBtn",
			"switchThumb": "RQvqka_switchThumb",
			"pluginEmpty": "RQvqka_pluginEmpty",
			"count": "RQvqka_count",
			"row": "RQvqka_row",
			"percentInput": "RQvqka_percentInput",
			"group": "RQvqka_group"
		};
		//#endregion
		//#region src/client/add-plugin-modal.tsx
		/**
		* The "add plugin" modals (Side card settings → the dashed cards at the
		* end of the 侧边栏内容 / 文件预览 grids): declare that the sidebar's
		* extension points — tab pages and file previewers — are open to plugins
		* (registered through `ctx.betterSidebar`), point at the GitHub topic page
		* for discovery, and show the repo's recommended plugin catalog of the
		* matching kind (name / url / description / install script).
		*
		* Per entry there are two actions:
		* - 「跳转」opens the plugin's repo in a REAL new browser tab (window.open
		*   — a button, so the sidebar link takeover cannot reroute it);
		* - 「安装」only COPIES the install script to the clipboard (writeClipboard)
		*   with a transient "已复制" feedback on the button — the user pastes and
		*   runs it wherever they manage their DSH profile. No terminal is opened,
		*   nothing is closed, nothing can fail outward.
		*
		* The body is extracted as {@link PluginListBody} so tests render it
		* directly — the Modal primitive runs hooks unconditionally, so an open
		* Modal must never be renderToString'd (same rule as the settingsFor popup
		* in SideCardSection); the modal itself mounts only while open.
		*/
		/** The catalog of one kind (kept in two repo files: plugins-tabs.ts /
		*  plugins-viewers.ts). */
		function catalogOf(kind) {
			return kind === "tab" ? builtinTabPlugins : builtinViewerPlugins;
		}
		/** How long the "已复制" feedback stays on the copy button. */
		const COPIED_FEEDBACK_MS = 1500;
		/** The modal body: the GitHub topic button + the recommended plugin list
		*  with per-entry jump/copy buttons (extracted for direct testing). */
		function PluginListBody(props) {
			const { service, kind } = props;
			const [copiedId, setCopiedId] = (0, react.useState)(null);
			/** Copy the entry's install script to the clipboard and flash the button's
			*  "已复制" label for a moment. The feedback ONLY appears after a
			*  successful write — when the clipboard is unavailable or denied
			*  (writeClipboard resolves false) nothing is shown, so the user is never
			*  told to paste a command that was not placed on the clipboard. Never
			*  closes anything, never throws outward. */
			const copy = async (entry) => {
				if (!await (0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(entry.install)) return;
				setCopiedId(entry.id);
				window.setTimeout(() => {
					setCopiedId((current) => current === entry.id ? null : current);
				}, COPIED_FEEDBACK_MS);
			};
			/** Open the plugin's repo in a REAL new browser tab (window.open — a
			*  button, so the sidebar link takeover cannot reroute it). */
			const jump = (entry) => {
				window.open(entry.url, "_blank", "noopener");
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: SideCardSection_module_css_default.pluginList,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: SideCardSection_module_css_default.pluginTopicBtn,
						onClick: () => {
							window.open(PLUGIN_TOPIC_URL, "_blank", "noopener");
						},
						children: t("addPluginsBrowseMore")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: SideCardSection_module_css_default.groupHeading,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("addPluginsRecommended") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: SideCardSection_module_css_default.count,
							children: catalogOf(kind).length
						})]
					}),
					catalogOf(kind).length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: SideCardSection_module_css_default.pluginEmpty,
						children: t("addPluginsEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: SideCardSection_module_css_default.pluginEntries,
						children: catalogOf(kind).map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SideCardSection_module_css_default.pluginEntry,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: SideCardSection_module_css_default.pluginEntryHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: SideCardSection_module_css_default.pluginName,
										"aria-label": `${t("openPlugin")}: ${entry.name}`,
										onClick: () => {
											jump(entry);
										},
										children: entry.name
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: SideCardSection_module_css_default.pluginEntryActions,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: SideCardSection_module_css_default.pluginJumpBtn,
											"aria-label": `${t("openPlugin")}: ${entry.name}`,
											onClick: () => {
												jump(entry);
											},
											children: t("openPlugin")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: SideCardSection_module_css_default.pluginCopyBtn,
											"aria-label": `${t("copyInstall")}: ${entry.name}`,
											onClick: () => {
												copy(entry);
											},
											children: copiedId === entry.id ? t("copied") : t("copy")
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: SideCardSection_module_css_default.pluginDesc,
									children: typeof entry.description === "function" ? entry.description() : entry.description
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: SideCardSection_module_css_default.pluginInstall,
									children: entry.install
								})
							]
						}, entry.id))
					})
				]
			});
		}
		/** The modal itself (mounted only while open — see the module comment). */
		function AddPluginModal(props) {
			const { service, onClose, kind } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose,
				title: kind === "tab" ? t("addPluginsTabCard") : t("addPluginsViewerCard"),
				description: kind === "tab" ? t("addPluginsTabDesc") : t("addPluginsViewerDesc"),
				closeLabel: t("close"),
				className: SideCardSection_module_css_default.pluginModal,
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: SideCardSection_module_css_default.done,
					onClick: onClose,
					children: t("settingsDone")
				}),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PluginListBody, {
					service,
					kind
				})
			});
		}
		//#endregion
		//#region src/client/SideCardSection.tsx
		/**
		* "Side card" settings section: the user-facing preferences for the sidebar
		* panel, rendered natively in the DSH Settings shell (nav label "Side card").
		*
		* The section is DECLARATIVE — it renders the enable/disable inventory from
		* the sidebar service's registries instead of hardcoding rows:
		*  - 常规: new conversations open the panel by default (a toggle row), the
		*    default panel width as a percent of the window (number input row), and
		*    the open-path interception toggle — the DSH settings-row recipe
		*    (title/desc left + control right, hairline separators).
		*  - 侧边栏内容: one SMALL CARD per REGISTERED tab type (built-ins and
		*    external plugins alike), laid out in a responsive grid that wraps
		*    several cards per row — icon chip + title + type id, clicked to toggle
		*    the switch persisted in `prefs.tabsEnabled[id]`.
		*  - 文件预览: one SMALL CARD per REGISTERED file viewer — icon chip + title
		*    + the extensions it covers, clicked to toggle `prefs.viewersEnabled[id]`.
		*
		* Every group lives in a container card (the DSH PluginCard recipe: l2
		* hairline, 16px radius, layer-3 fill) with a heading and an inventory count
		* badge (the settings catalogHeading recipe); the section opens with a
		* one-line intro (the DSH section heading+intro recipe).
		*
		* A card's on/off state is its VISUAL STATE: enabled = highlighted (brand
		* border + tinted fill + a circular check badge pinned to the card's far
		* right), disabled = neutral and dimmed. Features that declare
		* `settings.toggles` carry a gear corner button that opens a native Modal
		* (wider than the primitive default) with the related settings as
		* title/desc + custom-switch rows and a Done footer. The toggles
		* themselves are custom switches: a real checkbox (native semantics and
		* focus) driving a styled track/thumb.
		*
		* Writes ride the plugin's own fenced settings route (the host calls the
		* settings seam in-process — the DSH settings RPC domain does not serve
		* third-party namespaces to configuration clients); the shared SidebarStore
		* is refreshed on success so the very next brand-new session seeds from the
		* new values and the sidebar's consumption points (the + menu, derived
		* flows) re-render immediately. Any failure reverts the optimistic UI and
		* shows the wire error inline — a broken settings surface never crashes the
		* shell.
		*/
		/** Map one wire failure to the inline message (the conflict gets friendly copy). */
		function messageOf(error) {
			if (error instanceof Error && "code" in error && error.code === "settings-conflict") return `${t("settingsSaveFailed")} ${t("settingsConflict")}`;
			return `${t("settingsSaveFailed")} ${error instanceof Error ? error.message : String(error)}`;
		}
		/** Resolve an i18n-friendly string-or-function value. */
		function textOf(value) {
			if (value === void 0) return "";
			return typeof value === "function" ? value() : value;
		}
		/** Resolve a descriptor icon (ReactNode or size function). */
		function iconOf(icon, size) {
			if (icon === void 0) return null;
			return typeof icon === "function" ? icon(size) : icon;
		}
		/** Tab inventory order: hidden types (editor/diff) last, then + menu order. */
		function tabOrder(a, b) {
			if (a.hidden !== b.hidden) return a.hidden === true ? 1 : -1;
			return (a.order ?? 100) - (b.order ?? 100);
		}
		/** Viewer inventory order: priority desc (the catch-all `code` comes last). */
		function viewerOrder(a, b) {
			return (b.priority ?? 0) - (a.priority ?? 0);
		}
		/** Whether a feature declares any secondary settings (gear button shows). */
		function hasSettings(feature) {
			const settings = feature.settings;
			return settings !== void 0 && ((settings.toggles?.length ?? 0) > 0 || (settings.pluginToggles?.length ?? 0) > 0 || settings.render !== void 0);
		}
		/** A feature's display name (viewers fall back to their id). */
		function featureNameOf(feature) {
			return textOf("title" in feature ? feature.title : void 0) || feature.id;
		}
		/**
		* Merge one plugin-owned setting into a pluginSettings map (pure, v0.12.0+).
		* Sequential merges are additive: each call spreads the map it was GIVEN,
		* so building from the latest optimistic map keeps earlier keys intact
		* (two same-tick writes must not drop each other).
		*/
		function mergePluginSetting(pluginSettings, descriptorId, key, value) {
			return {
				...pluginSettings,
				[descriptorId]: {
					...pluginSettings[descriptorId] ?? {},
					[key]: value
				}
			};
		}
		/**
		* Render a custom settings panel (`settings.render`) with error containment:
		* a throwing panel shows an inline error line instead of breaking the whole
		* settings page.
		*/
		function SettingsRender(props) {
			let content;
			try {
				content = props.render(props.renderProps);
			} catch (error) {
				content = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: SideCardSection_module_css_default.error,
					role: "alert",
					children: [
						t("settingsSaveFailed"),
						" ",
						error instanceof Error ? error.message : String(error)
					]
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: content });
		}
		/**
		* The custom switch: a real checkbox (hidden, native semantics and focus)
		* driving a styled track/thumb. Used by the general toggle rows and the
		* secondary settings popup rows.
		*/
		function Switch(props) {
			const { checked, onChange, label } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: SideCardSection_module_css_default.switch,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "checkbox",
					className: SideCardSection_module_css_default.switchInput,
					checked,
					"aria-label": label,
					onChange: (event) => {
						onChange(event.currentTarget.checked);
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: SideCardSection_module_css_default.switchTrack,
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: SideCardSection_module_css_default.switchThumb })
				})]
			});
		}
		/**
		* The body of a feature's secondary settings popup: one row (title/desc +
		* control) per declared setting. Switches render the custom switch; text and
		* number rows render a free-form / numeric input committed on blur/Enter
		* (clamped to the declared min/max). Extracted so the rows are testable
		* without opening the Modal (the Modal portal renders only while open).
		*/
		function FeatureSettingsRows(props) {
			const { toggles, prefs, onToggle, onCommit, valueSource } = props;
			const read = valueSource ?? ((key) => prefs[key]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: SideCardSection_module_css_default.popupRows,
				children: toggles.map((toggle) => {
					const title = textOf(toggle.title);
					if ((toggle.type ?? "switch") === "switch") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: SideCardSection_module_css_default.popupRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: SideCardSection_module_css_default.rowText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SideCardSection_module_css_default.title,
								children: title
							}), textOf(toggle.desc) !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SideCardSection_module_css_default.desc,
								children: textOf(toggle.desc)
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
							label: title,
							checked: read(toggle.key) === true,
							onChange: (next) => {
								onToggle(toggle, next);
							}
						})]
					}, toggle.key);
					const value = String(read(toggle.key) ?? "");
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TypedRow, {
						toggle,
						title,
						value,
						onCommit
					}, `${toggle.key}:${value}`);
				})
			});
		}
		/**
		* One text/number row: a controlled input whose draft is local state,
		* committed on blur/Enter through the parent's onCommit. The parent's
		* canonical return is adopted (clamped numbers, stored value for invalid
		* input); a `unit` suffix renders after the input (e.g. 'px').
		*/
		function TypedRow(props) {
			const { toggle, title, value, onCommit } = props;
			const [draft, setDraft] = (0, react.useState)(value);
			const commit = () => {
				const canonical = onCommit?.(toggle, draft) ?? draft;
				setDraft(canonical);
			};
			const number = toggle.type === "number";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: SideCardSection_module_css_default.popupRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: SideCardSection_module_css_default.rowText,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SideCardSection_module_css_default.title,
						children: title
					}), textOf(toggle.desc) !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SideCardSection_module_css_default.desc,
						children: textOf(toggle.desc)
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: SideCardSection_module_css_default.control,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
						type: number ? "number" : "text",
						className: number ? SideCardSection_module_css_default.typedInputNumber : SideCardSection_module_css_default.typedInput,
						value: draft,
						min: toggle.min,
						max: toggle.max,
						step: 1,
						placeholder: toggle.placeholder,
						"aria-label": title,
						onChange: (event) => {
							setDraft(event.currentTarget.value);
						},
						onBlur: commit,
						onKeyDown: (event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}
					}), toggle.unit !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SideCardSection_module_css_default.suffix,
						children: toggle.unit
					})]
				})]
			});
		}
		/**
		* The secondary settings popup body of one feature (tab or viewer):
		* - `settings.render` (custom panel) when declared — rendered with the
		*   shared store/service, the live prefs, the descriptor's own plugin
		*   settings blob, a persistence helper, and a close callback;
		* - otherwise the host-prefs `toggles` rows, then the plugin-owned
		*   `pluginToggles` rows (their values live in `pluginSettings[feature.id]`,
		*   projected onto the prefs face so the shared row renderer reads them).
		*/
		function SettingsBody(props) {
			const { feature, prefs, store, service, onToggle, onCommit, onPluginToggle, onPluginCommit, onPluginWrite, onClose } = props;
			const render = feature.settings?.render;
			if (render !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsRender, {
				render,
				renderProps: {
					store,
					service,
					prefs,
					pluginSettings: prefs.pluginSettings[feature.id] ?? {},
					updatePluginSetting: onPluginWrite,
					close: onClose
				}
			});
			const toggles = feature.settings?.toggles ?? [];
			const pluginToggles = feature.settings?.pluginToggles ?? [];
			if (toggles.length === 0 && pluginToggles.length === 0) return null;
			const pluginBlob = prefs.pluginSettings[feature.id] ?? {};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: SideCardSection_module_css_default.popupRows,
				children: [toggles.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FeatureSettingsRows, {
					toggles,
					prefs,
					onToggle,
					onCommit
				}), pluginToggles.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FeatureSettingsRows, {
					toggles: pluginToggles,
					prefs,
					onToggle: onPluginToggle,
					onCommit: onPluginCommit,
					valueSource: (key) => pluginBlob[key]
				})]
			});
		}
		/**
		* Render the Side card preferences section.
		* @param props - composed slot props (runtime share + injected store/service).
		* @returns the section element tree.
		*/
		function SideCardSection({ store, service }) {
			const [prefs, setPrefs] = (0, react.useState)(() => store.getPrefs());
			const [widthDraft, setWidthDraft] = (0, react.useState)(String(store.getPrefs().defaultWidthPercent));
			const [error, setError] = (0, react.useState)(null);
			const [settingsFor, setSettingsFor] = (0, react.useState)(null);
			const [stripSettingsOpen, setStripSettingsOpen] = (0, react.useState)(false);
			const [addPluginsOpen, setAddPluginsOpen] = (0, react.useState)(null);
			const optimisticRef = (0, react.useRef)(prefs);
			(0, react.useEffect)(() => {
				optimisticRef.current = prefs;
			}, [prefs]);
			const [tabs, setTabs] = (0, react.useState)(() => [...service.getTabs()].sort(tabOrder));
			const [viewers, setViewers] = (0, react.useState)(() => [...service.getFileViewers()].sort(viewerOrder));
			(0, react.useEffect)(() => service.subscribe(() => {
				setTabs([...service.getTabs()].sort(tabOrder));
				setViewers([...service.getFileViewers()].sort(viewerOrder));
			}), [service]);
			const revisionRef = (0, react.useRef)(void 0);
			const dirtyRef = (0, react.useRef)(false);
			const inFlightRef = (0, react.useRef)(Promise.resolve());
			(0, react.useEffect)(() => {
				let cancelled = false;
				api.settingsGet().then((view) => {
					if (cancelled) return;
					revisionRef.current = view.revision;
					if (dirtyRef.current) return;
					const next = parsePrefs(view.value);
					setPrefs(next);
					setWidthDraft(String(next.defaultWidthPercent));
				}).catch(() => {});
				return () => {
					cancelled = true;
				};
			}, []);
			/** Persist one patch through the settings route (serialized, revision-guarded). */
			const commit = (patch) => {
				dirtyRef.current = true;
				const run = inFlightRef.current.then(async () => {
					const view = await api.settingsUpdate({ ...patch }, revisionRef.current);
					const next = parsePrefs(view.value);
					revisionRef.current = view.revision;
					store.setPrefs(next);
					return next;
				});
				inFlightRef.current = run.then(() => void 0, () => void 0);
				return run.then((next) => ({
					ok: true,
					prefs: next
				}), (caught) => {
					setError(messageOf(caught));
					return {
						ok: false,
						prefs
					};
				});
			};
			/** Settle one commit: success adopts the server values, failure reverts. */
			const applyOutcome = (previous, outcome) => {
				const settled = outcome.ok ? outcome.prefs : previous;
				setPrefs(settled);
				setWidthDraft(String(settled.defaultWidthPercent));
			};
			/** Optimistically apply one pref patch, then commit (revert on failure). */
			const applyPref = (patch) => {
				const previous = optimisticRef.current;
				const next = {
					...previous,
					...patch
				};
				optimisticRef.current = next;
				setPrefs(next);
				setError(null);
				commit(patch).then((outcome) => applyOutcome(previous, outcome));
			};
			const onToggle = (next) => {
				applyPref({ openByDefault: next });
			};
			/** Flip one per-tab enable switch (merge into the tabsEnabled map). */
			const onToggleTab = (id, next) => {
				applyPref({ tabsEnabled: {
					...optimisticRef.current.tabsEnabled,
					[id]: next
				} });
			};
			/** Flip one per-viewer enable switch (merge into the viewersEnabled map). */
			const onToggleViewer = (id, next) => {
				applyPref({ viewersEnabled: {
					...optimisticRef.current.viewersEnabled,
					[id]: next
				} });
			};
			/** Flip one declaratively-declared toggle (a SidebarPrefs boolean field). */
			const onToggleSetting = (toggle, next) => {
				applyPref({ [toggle.key]: next });
			};
			/**
			* Commit one declaratively-declared text/number row. Numbers are parsed
			* and clamped to the toggle's declared min/max (an unparsable input falls
			* back to the CURRENT stored value, mirroring the width row); text rows
			* persist as-is (empty is meaningful, e.g. the theme-default font).
			* Returns the canonical value the row should display.
			*/
			const onCommitSetting = (toggle, raw) => {
				if (toggle.type === "number") {
					const parsed = Number(raw);
					const fallback = String(prefs[toggle.key] ?? "");
					if (!Number.isFinite(parsed)) return fallback;
					let clamped = Math.round(parsed);
					if (toggle.min !== void 0) clamped = Math.max(toggle.min, clamped);
					if (toggle.max !== void 0) clamped = Math.min(toggle.max, clamped);
					applyPref({ [toggle.key]: clamped });
					return String(clamped);
				}
				applyPref({ [toggle.key]: raw });
				return raw;
			};
			/** Persist one plugin-owned setting of one descriptor (merged into the pluginSettings blob). */
			const applyPluginSetting = (descriptorId, key, value) => {
				applyPref({ pluginSettings: mergePluginSetting(optimisticRef.current.pluginSettings, descriptorId, key, value) });
			};
			/** Flip one plugin-owned switch row (same row shape, plugin-scoped key). */
			const onPluginToggle = (descriptorId, toggle, next) => {
				applyPluginSetting(descriptorId, toggle.key, next);
			};
			/** Commit one plugin-owned text/number row (clamped like the host rows). */
			const onPluginCommitSetting = (descriptorId, toggle, raw) => {
				if (toggle.type === "number") {
					const parsed = Number(raw);
					const blob = prefs.pluginSettings[descriptorId] ?? {};
					const fallback = String(blob[toggle.key] ?? "");
					if (!Number.isFinite(parsed)) return fallback;
					let clamped = Math.round(parsed);
					if (toggle.min !== void 0) clamped = Math.max(toggle.min, clamped);
					if (toggle.max !== void 0) clamped = Math.min(toggle.max, clamped);
					applyPluginSetting(descriptorId, toggle.key, clamped);
					return String(clamped);
				}
				applyPluginSetting(descriptorId, toggle.key, raw);
				return raw;
			};
			const commitWidth = () => {
				const parsed = Number(widthDraft);
				if (!Number.isFinite(parsed)) {
					setWidthDraft(String(prefs.defaultWidthPercent));
					return;
				}
				const clamped = clampWidthPercent(parsed);
				const previous = prefs;
				setPrefs({
					...previous,
					defaultWidthPercent: clamped
				});
				setWidthDraft(String(clamped));
				setError(null);
				commit({ defaultWidthPercent: clamped }).then((outcome) => applyOutcome(previous, outcome));
			};
			/**
			* One SMALL toggle card for the responsive inventory grid: the card's main
			* area is the switch (click to flips, visual state IS the state), the icon
			* sits in a rounded chip, the check badge pins to the far right, and a
			* feature that declares related settings carries a gear corner button
			* opening its settings popup.
			*/
			const renderCard = (props) => {
				const hasSettings = props.onOpenSettings !== void 0;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: clsx(SideCardSection_module_css_default.card, props.enabled && SideCardSection_module_css_default.cardOn, hasSettings && SideCardSection_module_css_default.cardWithGear),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: SideCardSection_module_css_default.cardMain,
						"aria-pressed": props.enabled,
						title: props.desc,
						onClick: () => {
							props.onToggle(!props.enabled);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: SideCardSection_module_css_default.cardTop,
							children: [
								props.icon !== null && props.icon !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SideCardSection_module_css_default.cardIconChip,
									children: props.icon
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SideCardSection_module_css_default.cardTitle,
									children: props.title
								}),
								props.enabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SideCardSection_module_css_default.cardCheck,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, { size: 12 })
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: SideCardSection_module_css_default.cardDesc,
							children: props.desc
						})]
					}), hasSettings && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: SideCardSection_module_css_default.cardGear,
						"aria-label": `${props.title} ${t("settingsPopup")}`,
						title: t("settingsPopup"),
						onClick: props.onOpenSettings,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, { size: 12 })
					})]
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: SideCardSection_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: SideCardSection_module_css_default.intro,
						children: t("settingsIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: SideCardSection_module_css_default.group,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: SideCardSection_module_css_default.groupHeading,
								children: t("settingsGeneralTitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SideCardSection_module_css_default.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SideCardSection_module_css_default.rowText,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.title,
										children: t("settingsOpenTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.desc,
										children: t("settingsOpenDesc")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
									label: t("settingsOpenTitle"),
									checked: prefs.openByDefault,
									onChange: onToggle
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SideCardSection_module_css_default.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SideCardSection_module_css_default.rowText,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.title,
										children: t("settingsWidthTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.desc,
										children: t("settingsWidthDesc")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SideCardSection_module_css_default.control,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
										type: "number",
										className: SideCardSection_module_css_default.percentInput,
										value: widthDraft,
										min: 20,
										max: 60,
										step: 1,
										"aria-label": t("settingsWidthTitle"),
										onChange: (event) => {
											setWidthDraft(event.currentTarget.value);
										},
										onBlur: commitWidth,
										onKeyDown: (event) => {
											if (event.key === "Enter") event.currentTarget.blur();
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.suffix,
										children: t("settingsWidthSuffix")
									})]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SideCardSection_module_css_default.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SideCardSection_module_css_default.rowText,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.title,
										children: t("settingsOpenPathTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.desc,
										children: t("settingsOpenPathDesc")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
									label: t("settingsOpenPathTitle"),
									checked: prefs.interceptOpenPath,
									onChange: (next) => {
										applyPref({ interceptOpenPath: next });
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SideCardSection_module_css_default.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SideCardSection_module_css_default.rowText,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.title,
										children: t("settingsTitleBarTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.desc,
										children: t("settingsTitleBarDesc")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SideCardSection_module_css_default.control,
									children: [prefs.titleBarCompat && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: SideCardSection_module_css_default.rowGear,
										"aria-label": `${t("settingsTitleBarTitle")} ${t("settingsPopup")}`,
										title: t("settingsPopup"),
										onClick: () => {
											setStripSettingsOpen(true);
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, { size: 14 })
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
										label: t("settingsTitleBarTitle"),
										checked: prefs.titleBarCompat,
										onChange: (next) => {
											applyPref({ titleBarCompat: next });
										}
									})]
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: SideCardSection_module_css_default.group,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SideCardSection_module_css_default.groupHeading,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("settingsTabsTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SideCardSection_module_css_default.count,
								children: tabs.length
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SideCardSection_module_css_default.grid,
							children: [tabs.map((tab) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react.Fragment, { children: renderCard({
								title: textOf(tab.title),
								desc: tab.id,
								icon: iconOf(tab.icon, 16),
								enabled: prefs.tabsEnabled[tab.id] !== false,
								onToggle: (next) => {
									onToggleTab(tab.id, next);
								},
								onOpenSettings: prefs.tabsEnabled[tab.id] !== false && hasSettings(tab) ? () => {
									setSettingsFor(tab);
								} : void 0
							}) }, tab.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: clsx(SideCardSection_module_css_default.card, SideCardSection_module_css_default.addCard),
								onClick: () => {
									setAddPluginsOpen("tab");
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SideCardSection_module_css_default.cardTop,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.cardIconChip,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 16 })
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.cardTitle,
										children: t("addPluginsTabCard")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SideCardSection_module_css_default.cardDesc,
									children: t("addPluginsTabCardDesc")
								})]
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: SideCardSection_module_css_default.group,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SideCardSection_module_css_default.groupHeading,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("settingsViewersTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SideCardSection_module_css_default.count,
								children: viewers.length
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SideCardSection_module_css_default.grid,
							children: [viewers.map((viewer) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react.Fragment, { children: renderCard({
								title: textOf(viewer.title) || viewer.id,
								desc: viewer.exts.length === 0 ? t("settingsViewerCatchAll") : viewer.exts.join(" · "),
								icon: iconOf(viewer.icon, 16),
								enabled: prefs.viewersEnabled[viewer.id] !== false,
								onToggle: (next) => {
									onToggleViewer(viewer.id, next);
								},
								onOpenSettings: prefs.viewersEnabled[viewer.id] !== false && hasSettings(viewer) ? () => {
									setSettingsFor(viewer);
								} : void 0
							}) }, viewer.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: clsx(SideCardSection_module_css_default.card, SideCardSection_module_css_default.addCard),
								onClick: () => {
									setAddPluginsOpen("viewer");
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SideCardSection_module_css_default.cardTop,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.cardIconChip,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 16 })
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SideCardSection_module_css_default.cardTitle,
										children: t("addPluginsViewerCard")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SideCardSection_module_css_default.cardDesc,
									children: t("addPluginsViewerCardDesc")
								})]
							})]
						})]
					}),
					settingsFor !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: true,
						onClose: () => {
							setSettingsFor(null);
						},
						title: featureNameOf(settingsFor),
						description: t("settingsPopupDesc", { feature: featureNameOf(settingsFor) }),
						closeLabel: t("close"),
						className: SideCardSection_module_css_default.popupDialog,
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SideCardSection_module_css_default.done,
							onClick: () => {
								setSettingsFor(null);
							},
							children: t("settingsDone")
						}),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsBody, {
							feature: settingsFor,
							prefs,
							onToggle: onToggleSetting,
							onCommit: onCommitSetting,
							onPluginToggle: (toggle, next) => {
								onPluginToggle(settingsFor.id, toggle, next);
							},
							onPluginCommit: (toggle, raw) => onPluginCommitSetting(settingsFor.id, toggle, raw),
							onPluginWrite: (key, value) => {
								applyPluginSetting(settingsFor.id, key, value);
							},
							onClose: () => {
								setSettingsFor(null);
							},
							store,
							service
						})
					}),
					stripSettingsOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: true,
						onClose: () => {
							setStripSettingsOpen(false);
						},
						title: t("settingsTitleBarTitle"),
						description: t("settingsPopupDesc", { feature: t("settingsTitleBarTitle") }),
						closeLabel: t("close"),
						className: SideCardSection_module_css_default.popupDialog,
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SideCardSection_module_css_default.done,
							onClick: () => {
								setStripSettingsOpen(false);
							},
							children: t("settingsDone")
						}),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FeatureSettingsRows, {
							toggles: [{
								key: "titleBarStripPx",
								type: "number",
								title: () => t("settingsTitleBarStripTitle"),
								desc: () => t("settingsTitleBarStripDesc"),
								min: 0,
								max: 120,
								unit: "px"
							}],
							prefs,
							onToggle: onToggleSetting,
							onCommit: onCommitSetting
						})
					}),
					addPluginsOpen !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AddPluginModal, {
						service,
						onClose: () => {
							setAddPluginsOpen(null);
						},
						kind: addPluginsOpen
					}),
					error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: SideCardSection_module_css_default.error,
						role: "alert",
						children: error
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:C:\Users\delinger\Desktop\dsh\_upstream2\DSH-better-sidebar\src\client\layout.css.mjs
		const css = "/**\r\n * Layout push: when a panel is open it OCCUPIES the layout instead of\r\n * floating over it — the app shell (#root, the AppFrame three-column grid)\r\n * gives up space. Only the center column is flexible (1fr), so the right\r\n * panel's width squeeze (margin-right on #root) lands exactly on the\r\n * conversation output and the input bar, like a VSCode sidebar.\r\n *\r\n * The bottom panel squeezes ONLY the center column — it must not cover the\r\n * app's own left sidebar or the right panel. DSH 0.1.x wraps slot hosts in\r\n * [data-slot] containers, so the AppFrame grid lives one level deeper:\r\n * #root > div[data-slot=\"root\"] > div (the frame). Its grid items are\r\n * (frame > div:nth-child(1..3)): sidebarCol, centerCol, detailsCol, so the\r\n * vertical push lands on the center column alone. The fixed panels cover\r\n * the vacated strips, which looks seamless because #root's background is\r\n * the theme base.\r\n *\r\n * The sizes ride CSS variables updated by the Sidebar shell (0 while\r\n * collapsed); expand/collapse animates both the margins and the panel\r\n * slides on the same theme duration. Drags disable the transition so the\r\n * layout tracks the pointer.\r\n */\r\n#root {\r\n  margin-right: var(--dsh-sidebar-width, 0px);\r\n  transition: margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out);\r\n}\r\n\r\n/* The AppFrame's grid items are sidebarCol, centerCol, detailsCol (children\r\n   1-3 of #root > div[data-slot=\"root\"] > div) — nth-child(2) is the center\r\n   column. A stretched grid item shrinks by its margins, so the conversation\r\n   content (output + input bar) lifts without touching the sidebars. */\r\n#root > div[data-slot=\"root\"] > div > div:nth-child(2) {\r\n  margin-bottom: var(--dsh-sidebar-height, 0px);\r\n  transition: margin-bottom var(--ds-transition-duration-slow) var(--ds-ease-in-out);\r\n}\r\n\r\n/* When the sidebar is collapsed, the toggle cluster reclaims the top-right\r\n   corner. Push the DSH session header's right padding out so its right-aligned\r\n   utilities (the \"Session log\" download capsule) yield the corner instead of\r\n   hiding under the cluster. The header default right-pads 28px; the 2-button\r\n   cluster spans right 10→70px, so 78px clears it with an 8px gap. Anchor on\r\n   the header's slot host wrapper ([data-slot=\"conversation.session.header\"])\r\n   rather than a positional path: DSH 0.1.x nests the header several levels\r\n   under the center column. The Sidebar shell toggles the body attribute with\r\n   the panel open state. */\r\nbody[data-dsh-sidebar-collapsed] [data-slot=\"conversation.session.header\"] > header {\r\n  padding-right: 78px;\r\n}\r\n\r\nbody[data-dsh-sidebar-dragging] #root,\r\nbody[data-dsh-sidebar-dragging] #root > div[data-slot=\"root\"] > div > div:nth-child(2) {\r\n  transition: none;\r\n}\r\n\r\n@media (prefers-reduced-motion: reduce) {\r\n  #root,\r\n  #root > div[data-slot=\"root\"] > div > div:nth-child(2) {\r\n    transition: none;\r\n  }\r\n}\r\n";
		const tagId = "dsh-better-sidebar/layout.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-better-sidebar";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* Client half of dsh-better-sidebar: resolves the user's "Side card"
		* preferences through the plugin's own fenced settings route, mounts the
		* right sidebar portal (inside an error boundary so a rendering failure
		* shows an error strip instead of a blank panel), registers the turn-tail
		* interception, and contributes the Side card settings section to the DSH
		* Settings shell. Requires the runtime's slots and sessions services; the
		* bundle itself is a module-table consumer only (react + ui-primitives +
		* xterm, all provided or inlined).
		*/
		/** Services required before mounting (provided by the client runtime; the
		*  locale service backs the sidebar's copy — see locales.ts). */
		const inject = [
			"slots",
			"sessions",
			"connection",
			"workspaces",
			"locale"
		];
		/**
		* Error boundary over the sidebar tree (root scope): a render error in the
		* sidebar SHELL itself must never blank the page silently — the shared
		* RenderBoundary shows a dismissible error strip and logs the stack. The
		* per-tab scope (Sidebar.tsx) catches viewer/editor crashes first; this root
		* boundary stays as the last resort for Workbench/shell errors.
		*/
		/**
		* Client plugin body.
		* @param ctx - the client cordis context (slots, sessions).
		*/
		function apply(ctx) {
			attachLocale(ctx.locale);
			ctx.effect(() => {
				const offZh = ctx.locale.register(LOCALE_NS, "zh", zh);
				const offEn = ctx.locale.register(LOCALE_NS, "en", en);
				return () => {
					offZh();
					offEn();
				};
			}, "dsh-better-sidebar: dictionaries");
			const sidebarStore = createSidebarStore();
			const service = createBetterSidebarService(sidebarStore);
			ctx.provide("betterSidebar", service);
			ctx.effect(() => registerBuiltins(ctx, service), "dsh-better-sidebar: register built-in tabs and viewers");
			const fail = (phase, error) => {
				console.error(`[dsh-better-sidebar] ${phase} error:`, error);
				try {
					const bar = document.createElement("div");
					bar.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap";
					bar.textContent = `[dsh-better-sidebar] ${phase} error: ${error instanceof Error ? error.message : String(error)}`;
					document.body.appendChild(bar);
				} catch {}
			};
			try {
				resetChunks();
				ctx.effect(() => {
					let disposed = false;
					let root;
					let host;
					(async () => {
						const prefs = await Promise.race([loadPrefs(api), new Promise((resolve) => {
							window.setTimeout(() => resolve(null), 2e3);
						})]);
						if (prefs !== null) sidebarStore.setPrefs(prefs);
						if (disposed) return;
						try {
							host = document.createElement("div");
							host.setAttribute("data-dsh-better-sidebar", "");
							document.body.appendChild(host);
							root = (0, react_dom_client.createRoot)(host);
							root.render((0, react.createElement)(RenderBoundary, { className: sidebar_module_css_default.boundaryError }, (0, react.createElement)(Sidebar, {
								ctx,
								store: sidebarStore
							})));
						} catch (error) {
							fail("mount", error);
						}
					})();
					return () => {
						disposed = true;
						root?.unmount();
						host?.remove();
					};
				}, "dsh-better-sidebar: sidebar mount");
				ctx.effect(() => {
					try {
						return registerTurnTailInterception(ctx, sidebarStore);
					} catch (error) {
						fail("interception", error);
						return;
					}
				}, "dsh-better-sidebar: turn-tail interception");
				ctx.effect(() => {
					try {
						return registerOpenPathInterception(ctx, sidebarStore);
					} catch (error) {
						fail("interception", error);
						return;
					}
				}, "dsh-better-sidebar: open-path interception");
				ctx.effect(() => {
					try {
						const urlTargetOf = (url) => {
							const prefs = sidebarStore.getPrefs();
							return matchUrlTarget(service.getTabs().filter((tab) => prefs.tabsEnabled[tab.id] !== false), url)?.id;
						};
						return registerLinkInterception({
							takeoverEnabled: (url) => {
								const prefs = sidebarStore.getPrefs();
								if (prefs.browserInterceptLinks === false) return false;
								if (!(url.protocol === "https:" ? prefs.browserInterceptHttps !== false : prefs.browserInterceptHttp !== false)) return false;
								return urlTargetOf(url) !== void 0 || prefs.tabsEnabled["browser"] !== false;
							},
							openInSidebar: (url) => {
								let title;
								try {
									title = new URL(url).hostname;
								} catch {}
								const type = urlTargetOf(new URL(url)) ?? "browser";
								ctx.betterSidebar?.openTab({
									type,
									url,
									title
								});
							},
							selfOrigin: window.location.origin
						});
					} catch (error) {
						fail("interception", error);
						return;
					}
				}, "dsh-better-sidebar: link interception");
				ctx.effect(() => {
					try {
						return registerImeGuard();
					} catch (error) {
						fail("ime guard", error);
						return;
					}
				}, "dsh-better-sidebar: IME composition guard");
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "better-sidebar",
					order: 100,
					label: () => t("settingsNav"),
					inject: () => ({
						store: sidebarStore,
						service
					})
				}, SideCardSection));
			} catch (error) {
				fail("load", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
