window.__ModuleLoader__.load({
  id: "dsh-composer-dynamic-island",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    const PLUGIN_ID = "dsh-composer-dynamic-island";
    const STYLE_ID = "dsh-composer-dynamic-island-style";
    const SURFACE_ATTR = "data-dsh-island-surface";
    const TRIGGER_ATTR = "data-dsh-island-trigger";
    const PANEL_ATTR = "data-dsh-island-panel";
    const ITEM_ATTR = "data-dsh-island-item";
    const LEFT_SLOT = "conversation.input.left";
    const RIGHT_SLOT = "conversation.input.right";
    const MODEL_SLOT = "conversation.input.model";
    const STORE_KEY = "dsh-composer-dynamic-island-config-v1";
    const MAX_PANEL_WIDTH = 520;
    const BUTTON_CONTROL_SELECTOR = 'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]';
    const INTERACTIVE_SELECTOR = `${BUTTON_CONTROL_SELECTOR},select,input:not([type="hidden"])`;
    const TEXT_ENTRY_SELECTOR = 'textarea,[contenteditable=true],[role=textbox],input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="password"],input[type="url"],input[type="tel"],input[type="number"]';
    const PLUGIN_MARKER_SELECTOR = "[data-plugin],[data-plugin-id],[data-extension],[data-extension-id],[data-contribution]";
    const INPUT_SLOT_PATTERN = /^(?:conversation\.)?(?:input|composer)(?:\.|$)/i;
    let panelSequence = 0;
    let requestRefresh = () => {};

    const ZONE_LABELS = {
      native: "原生输入控件",
      left: "左侧插件",
      team: "团队模式",
      extension: "输入区插件",
      right: "右侧插件",
      model: "模型控件",
      action: "发送操作",
    };
    const ZONE_ORDER = ["native", "left", "team", "extension", "right", "model", "action"];

    const CSS = [
      "[data-dsh-island-row]{position:relative!important;flex-wrap:nowrap!important;gap:8px!important;min-height:36px!important;isolation:isolate}",
      "[data-dsh-island-surface]{display:inline-flex;align-items:center;flex:0 0 38px;width:38px;min-width:38px;height:30px;overflow:visible}",
      "[data-composer-card]:not([data-dsh-island-ready]) [data-dsh-island-surface]{display:none!important}",
      "[data-dsh-island-panel]{position:fixed!important;z-index:40!important;box-sizing:border-box!important;left:var(--dshi-panel-left)!important;top:var(--dshi-panel-top)!important;width:var(--dshi-panel-width)!important;height:var(--dshi-panel-height)!important;display:block!important;overflow:visible!important;border:1px solid var(--dsw-alias-border-l2-darkmode-thin)!important;border-radius:16px!important;background:color-mix(in srgb,var(--dsw-specific-input-major) 92%,transparent)!important;box-shadow:0 12px 30px rgba(0,0,0,.18)!important;backdrop-filter:blur(18px) saturate(1.15)!important;-webkit-backdrop-filter:blur(18px) saturate(1.15)!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important;transform:translateY(14px) scale(.96)!important;transform-origin:left bottom!important;transition:opacity .18s ease,transform .22s cubic-bezier(.2,.8,.2,1),visibility 0s linear .22s!important}",
      "[data-dsh-island-row][data-dsh-island-open=true] [data-dsh-island-panel]{opacity:1!important;visibility:visible!important;pointer-events:auto!important;transform:translateY(0) scale(1)!important;transition-delay:0s!important}",
      "[data-dsh-island-panel]::after{content:'';position:absolute;right:0;bottom:-8px;left:0;height:8px}",
      "[data-dsh-island-panel][data-dshi-direction=down]{transform-origin:left top!important}",
      "[data-dsh-island-item]{position:fixed!important;z-index:41!important;box-sizing:border-box!important;left:var(--dshi-item-left)!important;top:var(--dshi-item-top)!important;margin:0!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important;transform:translateY(12px) scale(.96)!important;transform-origin:left bottom!important;transition:opacity .16s ease,transform .2s cubic-bezier(.2,.8,.2,1),visibility 0s linear .2s!important}",
      "[data-dsh-island-row][data-dsh-island-open=true] [data-dsh-island-item]{opacity:1!important;visibility:visible!important;pointer-events:auto!important;transform:translateY(0) scale(1)!important;transition-delay:0s!important}",
      "[data-dsh-island-item] select{max-width:min(260px,70vw)!important}",
      "[data-dsh-island-item].team-seat{position:fixed!important}",
      "[data-dsh-island-item].team-seat .team-pop{right:0!important;left:auto!important;bottom:calc(100% + 18px)!important;z-index:60!important;max-height:min(420px,calc(100vh - 120px))!important}",
      "[data-dsh-island-item].team-seat[data-dshi-menu-align=left] .team-pop{right:auto!important;left:0!important}",
      "[data-dsh-island-item].team-seat[data-dshi-menu-direction=down] .team-pop{top:calc(100% + 18px)!important;bottom:auto!important;transform-origin:100% 0!important}",
      "[data-dsh-island-item].team-seat .team-pop::before{bottom:-18px!important;height:18px!important}",
      "[data-dsh-island-item].team-seat[data-dshi-menu-direction=down] .team-pop::before{top:-18px!important;bottom:auto!important}",
      "[data-dsh-island-trigger]{position:relative!important;z-index:2!important;box-sizing:border-box!important;width:38px!important;height:30px!important;flex:0 0 38px!important;display:grid!important;place-items:center!important;padding:0!important;border:1px solid var(--dsw-alias-border-l2-darkmode-thin)!important;border-radius:999px!important;color:var(--dsw-alias-label-secondary)!important;background:color-mix(in srgb,var(--dsw-specific-selector) 88%,transparent)!important;cursor:pointer!important;box-shadow:inset 0 1px rgba(255,255,255,.12)!important;transition:background-color .18s ease,border-color .18s ease,color .18s ease,transform .18s ease!important}",
      "[data-dsh-island-trigger]:hover,[data-dsh-island-trigger]:focus-visible,[data-dsh-island-row][data-dsh-island-open=true] [data-dsh-island-trigger]{color:var(--dsw-alias-state-business-primary)!important;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 46%,transparent)!important;background:var(--dsw-alias-interactive-bg-hover-solid)!important;outline:none!important}",
      "[data-dsh-island-trigger]:active{transform:scale(.94)!important}",
      "[data-dsh-island-dots]{display:flex;align-items:center;gap:3px;pointer-events:none}",
      "[data-dsh-island-dots]>i{display:block;width:4px;height:4px;border-radius:50%;background:currentColor;transform:translateY(0);transition:transform .18s ease}",
      "[data-dsh-island-row][data-dsh-island-open=true] [data-dsh-island-dots]>i:first-child,[data-dsh-island-row][data-dsh-island-open=true] [data-dsh-island-dots]>i:last-child{transform:translateY(-2px)}",
      "[data-dsh-island-tools]{flex:0 1 auto!important;min-width:0!important;gap:12px!important;white-space:nowrap!important}",
      "[data-dsh-island-trailing]{flex:0 1 auto!important;min-width:0!important;margin-left:auto!important;gap:8px!important;white-space:nowrap!important}",
      ".dshi-settings{max-width:720px;display:flex;flex-direction:column;gap:16px}",
      ".dshi-settings-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:34px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".dshi-settings-count{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
      ".dshi-settings-reset{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}",
      ".dshi-settings-reset:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
      ".dshi-settings-group{display:flex;flex-direction:column}",
      ".dshi-settings-group-title{margin:0;padding:0 0 6px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:600;line-height:18px}",
      ".dshi-settings-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:42px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer}",
      ".dshi-settings-row input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary)}",
      ".dshi-settings-name{min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}",
      ".dshi-settings-state{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".dshi-settings-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
      "@media(max-width:700px){[data-dsh-island-tools],[data-dsh-island-trailing]{gap:6px!important}.dshi-settings-summary{align-items:flex-start;flex-direction:column}}",
      "@media(prefers-reduced-motion:reduce){[data-dsh-island-panel],[data-dsh-island-trigger],[data-dsh-island-item],[data-dsh-island-dots]>i{transition:none!important}}",
    ].join("\n");

    function hashText(value) {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }

    function normalizeLabel(value) {
      return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[，,]\s*(?:当前|current)[:：]?.*$/iu, "")
        .replace(/[:：]\s*(?:开|关|开启|关闭|允许|禁止|on|off|enabled|disabled)(?:\b|$).*$/iu, "")
        .trim();
    }

    function interactiveOf(node) {
      if (!(node instanceof HTMLElement)) return null;
      if (node.matches(INTERACTIVE_SELECTOR)) return node;
      return node.querySelector(INTERACTIVE_SELECTOR);
    }

    function buttonControlOf(node) {
      if (!(node instanceof HTMLElement)) return null;
      if (node.matches(BUTTON_CONTROL_SELECTOR)) return node;
      return node.querySelector(BUTTON_CONTROL_SELECTOR);
    }

    function hasInteractive(node) {
      return interactiveOf(node) !== null;
    }

    function labelOf(node, fallback) {
      const control = interactiveOf(node) ?? node;
      const selectedText = control instanceof HTMLSelectElement ? control.selectedOptions[0]?.textContent : "";
      const raw = control.getAttribute("aria-label")
        || control.getAttribute("title")
        || node.getAttribute("aria-label")
        || node.getAttribute("title")
        || selectedText
        || control.textContent
        || node.textContent
        || fallback;
      return normalizeLabel(raw) || fallback;
    }

    function stableClassOf(node) {
      const control = interactiveOf(node);
      const tokens = [...node.classList, ...(control === null ? [] : [...control.classList])]
        .filter((token, index, all) => all.indexOf(token) === index)
        .filter((token) => !/(?:^|[-_])(active|open|closed|enabled|disabled|on|off)$/i.test(token))
        .sort();
      return tokens.slice(0, 3).join(".");
    }

    function identityOf(node, zone, label) {
      const control = interactiveOf(node);
      const stable = node.id
        || node.getAttribute("data-plugin")
        || node.getAttribute("data-plugin-id")
        || node.getAttribute("data-extension")
        || node.getAttribute("data-extension-id")
        || node.getAttribute("data-contribution")
        || node.getAttribute("data-slot")
        || stableClassOf(node)
        || control?.id
        || control?.getAttribute("name")
        || normalizeLabel(control?.getAttribute("aria-label"))
        || normalizeLabel(label);
      return `${zone}|${node.tagName}|${stable}`;
    }

    function candidateBaseId(node, zone, label) {
      return `${zone}-${hashText(identityOf(node, zone, label))}`;
    }

    function describeCandidate(node, zone, occurrence) {
      const fallback = `未命名控件 ${occurrence + 1}`;
      const label = labelOf(node, fallback);
      const baseId = candidateBaseId(node, zone, label);
      let id = candidateIdByNode.get(node);
      if (id === undefined) {
        id = occurrence === 0 ? baseId : `${baseId}-${hashText(label)}-${occurrence + 1}`;
        candidateIdByNode.set(node, id);
      }
      return {
        id,
        label,
        zone,
        zoneLabel: ZONE_LABELS[zone],
        defaultCollapsed: zone === "left" || zone === "team" || zone === "extension",
        node,
      };
    }

    function loadStoredConfig() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(STORE_KEY) || "null");
        if (parsed !== null && typeof parsed === "object") {
          const sanitized = {
            configured: parsed.configured === true,
            selected: Array.isArray(parsed.selected) ? parsed.selected.filter((id) => typeof id === "string") : [],
          };
          window.localStorage.setItem(STORE_KEY, JSON.stringify(sanitized));
          return sanitized;
        }
      } catch {}
      return {};
    }

    const storedConfig = loadStoredConfig();
    let configured = storedConfig.configured === true;
    const selectedIds = new Set(Array.isArray(storedConfig.selected) ? storedConfig.selected.filter((id) => typeof id === "string") : []);
    const catalog = new Map();
    const availableIds = new Set();
    const candidateIdByNode = new WeakMap();
    const storeListeners = new Set();
    let storeSnapshot = null;

    function rebuildStoreSnapshot() {
      const items = [...availableIds]
        .map((id) => catalog.get(id))
        .filter((item) => item !== undefined)
        .sort((left, right) => {
          const zoneDifference = ZONE_ORDER.indexOf(left.zone) - ZONE_ORDER.indexOf(right.zone);
          return zoneDifference !== 0 ? zoneDifference : left.label.localeCompare(right.label, "zh-CN");
        });
      storeSnapshot = {
        configured,
        selected: [...selectedIds],
        items,
      };
    }

    function persistStore() {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({
          configured,
          selected: [...selectedIds],
        }));
      } catch {}
    }

    function emitStore() {
      rebuildStoreSnapshot();
      for (const listener of storeListeners) listener();
    }

    function registerCurrentCandidates(candidates) {
      if (candidates.length === 0) return;
      let changed = false;
      const currentIds = new Set();
      for (const candidate of candidates) {
        currentIds.add(candidate.id);
        const previous = catalog.get(candidate.id);
        const next = {
          id: candidate.id,
          label: candidate.label,
          zone: candidate.zone,
          zoneLabel: candidate.zoneLabel,
          defaultCollapsed: candidate.defaultCollapsed,
        };
        if (previous === undefined || previous.label !== next.label || previous.zone !== next.zone || previous.defaultCollapsed !== next.defaultCollapsed) {
          catalog.set(candidate.id, next);
          changed = true;
        }
      }
      if ([...availableIds].some((id) => !currentIds.has(id)) || [...currentIds].some((id) => !availableIds.has(id))) changed = true;
      availableIds.clear();
      for (const id of currentIds) availableIds.add(id);
      if (!configured) {
        for (const id of [...selectedIds]) {
          if (!currentIds.has(id)) selectedIds.delete(id);
        }
        for (const candidate of candidates) {
          if (candidate.defaultCollapsed) selectedIds.add(candidate.id);
          else selectedIds.delete(candidate.id);
        }
      }
      if (!changed && configured) return;
      persistStore();
      emitStore();
    }

    function candidateSelected(candidate) {
      return selectedIds.has(candidate.id);
    }

    function setCandidateSelected(id, selected) {
      configured = true;
      if (selected) selectedIds.add(id);
      else selectedIds.delete(id);
      persistStore();
      emitStore();
      requestRefresh();
    }

    function resetCandidateSelection() {
      configured = false;
      selectedIds.clear();
      for (const id of availableIds) {
        const item = catalog.get(id);
        if (item?.defaultCollapsed) selectedIds.add(id);
      }
      persistStore();
      emitStore();
      requestRefresh();
    }

    rebuildStoreSnapshot();
    const candidateStore = {
      subscribe(listener) {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
      getSnapshot() {
        return storeSnapshot;
      },
      setSelected: setCandidateSelected,
      reset: resetCandidateSelection,
    };

    function directElementChildren(node) {
      return Array.from(node.children).filter((child) => child instanceof HTMLElement);
    }

    function directChildContaining(container, node) {
      let current = node;
      while (current instanceof HTMLElement && current.parentElement !== container) current = current.parentElement;
      return current instanceof HTMLElement && current.parentElement === container ? current : null;
    }

    function inputSlotZone(slotName) {
      if (slotName === LEFT_SLOT) return "left";
      if (slotName === RIGHT_SLOT) return "right";
      if (slotName === MODEL_SLOT) return "model";
      return "extension";
    }

    function findComposerParts(card) {
      if (card.querySelector(":scope > [data-input-scroll],[data-input-scroll],textarea,[contenteditable=true],[role=textbox]") === null) return null;
      const rows = directElementChildren(card).filter((candidate) => {
        const children = directElementChildren(candidate);
        return children.length >= 2 && children.some((child) => child.querySelector(INTERACTIVE_SELECTOR) !== null || child.matches(INTERACTIVE_SELECTOR));
      });
      const row = rows.at(-1) ?? null;
      if (row === null) return null;
      const groups = directElementChildren(row);
      if (groups.length < 2) return null;
      const tools = groups[0];
      const trailing = groups.at(-1);
      const inputSlots = [...row.querySelectorAll("[data-slot]")]
        .filter((slot) => slot instanceof HTMLElement && INPUT_SLOT_PATTERN.test(slot.getAttribute("data-slot") ?? ""));
      const leftSlot = inputSlots.find((slot) => slot.getAttribute("data-slot") === LEFT_SLOT) ?? null;
      const rightSlot = inputSlots.find((slot) => slot.getAttribute("data-slot") === RIGHT_SLOT) ?? null;
      const modelSlot = inputSlots.find((slot) => slot.getAttribute("data-slot") === MODEL_SLOT) ?? null;
      const modes = directElementChildren(tools).find((child) => child !== leftSlot
        && child.getAttribute("data-slot") === null
        && !child.matches(PLUGIN_MARKER_SELECTOR)
        && child.querySelector(PLUGIN_MARKER_SELECTOR) === null
        && buttonControlOf(child) === null
        && /(?:^|[-_])(mode|modes)(?:[-_]|$)/i.test(child.className)) ?? null;
      return { card, row, tools, trailing, modes, leftSlot, rightSlot, modelSlot, inputSlots };
    }

    function fixedPositionIsReliable(node) {
      for (let parent = node.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        if (style.transform !== "none" || style.filter !== "none" || style.perspective !== "none") return false;
        if (/\b(?:paint|strict|content)\b/.test(style.contain)) return false;
      }
      return true;
    }

    function discoverCandidates(parts) {
      const candidates = [];
      const occurrences = new Map();
      const seenNodes = new Set();
      const add = (node, zone, buttonOnly = false) => {
        if (!(node instanceof HTMLElement)
          || seenNodes.has(node)
          || node.matches(TEXT_ENTRY_SELECTOR)
          || node.querySelector(TEXT_ENTRY_SELECTOR) !== null
          || (buttonOnly ? buttonControlOf(node) === null : !hasInteractive(node))
          || node.hasAttribute(TRIGGER_ATTR)
          || node.hasAttribute(SURFACE_ATTR)
          || node.querySelector(`[${SURFACE_ATTR}]`) !== null) return;
        seenNodes.add(node);
        const label = labelOf(node, "未命名控件");
        const baseId = candidateBaseId(node, zone, label);
        const count = occurrences.get(baseId) ?? 0;
        occurrences.set(baseId, count + 1);
        candidates.push(describeCandidate(node, zone, count));
      };

      // Prefer host semantic input/composer slots. New conversation.input.* or
      // composer.* slots become available without another hard-coded branch.
      for (const slot of parts.inputSlots) {
        const slotName = slot.getAttribute("data-slot") ?? "";
        const zone = inputSlotZone(slotName);
        for (const child of directElementChildren(slot)) {
          const resolvedZone = child.classList.contains("team-seat") ? "team" : zone;
          add(child, resolvedZone, zone === "extension");
        }
      }

      // Preserve native composer controls and actions as opt-in choices. They
      // are discoverable in Settings but never collapse by default.
      for (const child of directElementChildren(parts.tools)) {
        if (parts.inputSlots.some((slot) => child === slot || child.contains(slot))
          || child === parts.modes
          || child.matches(PLUGIN_MARKER_SELECTOR)
          || child.querySelector(PLUGIN_MARKER_SELECTOR) !== null) continue;
        add(child, "native");
      }
      if (parts.modes !== null) {
        for (const child of directElementChildren(parts.modes)) add(child, "native");
      }
      for (const child of directElementChildren(parts.trailing)) {
        if (parts.inputSlots.some((slot) => child === slot || child.contains(slot))
          || child.matches(PLUGIN_MARKER_SELECTOR)
          || child.querySelector(PLUGIN_MARKER_SELECTOR) !== null) continue;
        add(child, "action");
      }

      // Fallback for button plugins that identify themselves but do not use a
      // semantic slot. The scan remains bounded to the confirmed composer row.
      for (const marker of parts.row.querySelectorAll(PLUGIN_MARKER_SELECTOR)) {
        if (!(marker instanceof HTMLElement)
          || marker.closest("[data-slot]") !== null
          || marker.parentElement?.closest(PLUGIN_MARKER_SELECTOR) !== null) continue;
        add(marker, "extension", true);
      }

      // Last-resort support for nested button contributions inside the two
      // composer toolbar groups. Group roots are kept when possible so a
      // multi-button plugin remains one contribution and no React node moves.
      for (const control of parts.row.querySelectorAll(BUTTON_CONTROL_SELECTOR)) {
        if (!(control instanceof HTMLElement)
          || control.closest("[data-slot]") !== null
          || control.closest(PLUGIN_MARKER_SELECTOR) !== null
          || control.closest(`[${SURFACE_ATTR}]`) !== null) continue;
        const group = parts.tools.contains(control) ? parts.tools : parts.trailing.contains(control) ? parts.trailing : null;
        if (group === null) continue;
        const root = directChildContaining(group, control) ?? control;
        add(root, group === parts.tools ? "native" : "action", true);
      }
      return candidates;
    }

    function IslandSurface() {
      const panelId = react.useMemo(() => `dsh-composer-island-${++panelSequence}`, []);
      return h("span", { [SURFACE_ATTR]: "" },
        h("button", {
          type: "button",
          [TRIGGER_ATTR]: "",
          "aria-label": "更多输入功能",
          "aria-expanded": "false",
          title: "更多输入功能",
        }, h("span", { "data-dsh-island-dots": "", "aria-hidden": "true" }, h("i"), h("i"), h("i"))),
        h("section", {
          id: panelId,
          [PANEL_ATTR]: "",
          "aria-hidden": "true",
        })
      );
    }

    function measureCandidate(candidate) {
      const rect = candidate.node.getBoundingClientRect();
      return {
        candidate,
        node: candidate.node,
        width: Math.max(24, Math.ceil(rect.width || candidate.node.offsetWidth || 28)),
        height: Math.max(24, Math.ceil(rect.height || candidate.node.offsetHeight || 28)),
      };
    }

    function packItems(items, rowRect, triggerRect) {
      const padding = 10;
      const gapX = 12;
      const gapY = 8;
      const maxWidth = Math.max(120, Math.min(MAX_PANEL_WIDTH, rowRect.width - 16, window.innerWidth - 16));
      const spaceAbove = Math.max(48, triggerRect.top - 16);
      const spaceBelow = Math.max(48, window.innerHeight - triggerRect.bottom - 16);
      const opensUp = spaceAbove >= Math.min(160, spaceBelow);
      const maxHeight = Math.max(48, opensUp ? spaceAbove : spaceBelow);
      let x = padding;
      let y = padding;
      let rowHeight = 0;
      let contentRight = 0;
      const placed = [];
      for (const item of items) {
        const width = Math.min(item.width, maxWidth - padding * 2);
        if (x > padding && x + width > maxWidth - padding) {
          x = padding;
          y += rowHeight + gapY;
          rowHeight = 0;
        }
        if (y + item.height + padding > maxHeight) continue;
        placed.push({ item, x, y, width });
        contentRight = Math.max(contentRight, x + width);
        rowHeight = Math.max(rowHeight, item.height);
        x += width + gapX;
      }
      const panelWidth = Math.max(58, Math.min(maxWidth, contentRight + padding));
      const panelHeight = Math.max(48, Math.min(maxHeight, y + rowHeight + padding));
      const anchorCenter = triggerRect.left + triggerRect.width / 2;
      const left = Math.max(8, Math.min(anchorCenter - panelWidth / 2, window.innerWidth - panelWidth - 8));
      const top = opensUp
        ? Math.max(8, triggerRect.top - panelHeight - 8)
        : Math.min(window.innerHeight - panelHeight - 8, triggerRect.bottom + 8);
      return { placed, left, top, panelWidth, panelHeight, direction: opensUp ? "up" : "down" };
    }

    function stateIsCurrent(state, candidates) {
      const { card, row, tools, trailing, surface, panel, trigger, items } = state;
      if (!card.isConnected || !row.isConnected || !card.contains(row)) return false;
      if (!surface.isConnected || !card.contains(surface) || !surface.contains(trigger) || !surface.contains(panel)) return false;
      if (!tools.isConnected || !trailing.isConnected || !row.contains(tools) || !row.contains(trailing)) return false;
      if (candidates.length !== items.length) return false;
      const selectedNow = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      for (const item of items) {
        if (!item.node.isConnected || selectedNow.get(item.candidate.id)?.node !== item.node) return false;
      }
      return true;
    }

    function decorateCard(record, states) {
      const { card, parts, candidates } = record;
      if (states.has(card) || candidates.length === 0) return;
      const surface = card.querySelector(`[${SURFACE_ATTR}]`);
      if (!(surface instanceof HTMLElement)) return;
      const trigger = surface.querySelector(`[${TRIGGER_ATTR}]`);
      const panel = surface.querySelector(`[${PANEL_ATTR}]`);
      if (!(trigger instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) return;
      const items = candidates.map(measureCandidate);
      const { row, tools, trailing } = parts;
      card.dataset.dshIslandReady = "true";
      row.setAttribute("data-dsh-island-row", "");
      row.dataset.dshIslandOpen = "false";
      tools.setAttribute("data-dsh-island-tools", "");
      trailing.setAttribute("data-dsh-island-trailing", "");

      let pinned = false;
      let closeTimer = 0;
      let disposed = false;
      let layoutFrame = 0;
      const pointerInside = () => panel.matches(":hover")
        || trigger.matches(":hover")
        || items.some((item) => item.node.hasAttribute(ITEM_ATTR) && item.node.matches(":hover"));
      const setOpen = (open) => {
        window.clearTimeout(closeTimer);
        row.dataset.dshIslandOpen = open ? "true" : "false";
        trigger.setAttribute("aria-expanded", open ? "true" : "false");
      };
      const open = () => setOpen(true);
      const schedulePointerClose = () => {
        window.clearTimeout(closeTimer);
        closeTimer = window.setTimeout(() => {
          if (row.matches(":focus-within") || pointerInside()) return;
          pinned = false;
          setOpen(false);
        }, 120);
      };
      const scheduleFocusClose = () => {
        window.clearTimeout(closeTimer);
        closeTimer = window.setTimeout(() => {
          if (!row.matches(":focus-within") && !pointerInside()) setOpen(false);
        }, 0);
      };
      const toggle = (event) => {
        event.preventDefault();
        event.stopPropagation();
        pinned = row.dataset.dshIslandOpen !== "true";
        setOpen(pinned);
      };
      const onKeyDown = (event) => {
        if (event.defaultPrevented || event.key !== "Escape" || row.dataset.dshIslandOpen !== "true") return;
        pinned = false;
        setOpen(false);
        trigger.focus();
      };
      const onDocumentPointerDown = (event) => {
        if (!pinned || row.contains(event.target)) return;
        pinned = false;
        setOpen(false);
      };
      const layout = () => {
        if (disposed || !row.isConnected) return;
        for (const item of items) {
          item.node.removeAttribute(ITEM_ATTR);
          item.node.removeAttribute("data-dshi-menu-align");
          item.node.removeAttribute("data-dshi-menu-direction");
          item.node.style.removeProperty("--dshi-item-left");
          item.node.style.removeProperty("--dshi-item-top");
        }

        const selectedItems = items.filter((item) => candidateSelected(item.candidate));
        if (!fixedPositionIsReliable(panel) || selectedItems.some((item) => !fixedPositionIsReliable(item.node))) {
          delete card.dataset.dshIslandReady;
          for (const item of selectedItems) item.node.removeAttribute(ITEM_ATTR);
          return;
        }
        card.dataset.dshIslandReady = "true";
        const measuredItems = selectedItems.map((item) => measureCandidate(item.candidate));
        const packed = packItems(measuredItems, row.getBoundingClientRect(), trigger.getBoundingClientRect());
        const placedNodes = new Set(packed.placed.map((placement) => placement.item.node));
        for (const item of selectedItems) {
          if (placedNodes.has(item.node)) item.node.setAttribute(ITEM_ATTR, item.candidate.id);
          else item.node.removeAttribute(ITEM_ATTR);
        }
        panel.style.setProperty("--dshi-panel-left", `${packed.left}px`);
        panel.style.setProperty("--dshi-panel-top", `${packed.top}px`);
        panel.style.setProperty("--dshi-panel-width", `${packed.panelWidth}px`);
        panel.style.setProperty("--dshi-panel-height", `${packed.panelHeight}px`);
        panel.dataset.dshiDirection = packed.direction;
        for (const placement of packed.placed) {
          const { item, x, y } = placement;
          const itemLeft = packed.left + x;
          const itemTop = packed.top + y;
          item.node.style.setProperty("--dshi-item-left", `${itemLeft}px`);
          item.node.style.setProperty("--dshi-item-top", `${itemTop}px`);
          if (item.node.classList.contains("team-seat")) {
            const menu = item.node.querySelector(".team-pop");
            const menuWidth = menu instanceof HTMLElement ? Math.max(1, menu.offsetWidth) : 330;
            const menuHeight = menu instanceof HTMLElement ? Math.max(1, menu.offsetHeight) : 140;
            item.node.dataset.dshiMenuAlign = itemLeft + menuWidth <= window.innerWidth - 8 ? "left" : "right";
            item.node.dataset.dshiMenuDirection = itemTop - menuHeight - 18 >= 8 ? "up" : "down";
          }
        }
      };
      const scheduleItemLayout = () => {
        if (disposed || layoutFrame !== 0) return;
        layoutFrame = window.requestAnimationFrame(() => {
          layoutFrame = 0;
          layout();
        });
      };

      trigger.addEventListener("pointerenter", open);
      trigger.addEventListener("pointerleave", schedulePointerClose);
      trigger.addEventListener("focus", open);
      trigger.addEventListener("click", toggle);
      panel.addEventListener("pointerenter", open);
      panel.addEventListener("pointerleave", schedulePointerClose);
      for (const item of items) {
        const onItemEnter = () => {
          if (item.node.hasAttribute(ITEM_ATTR)) open();
        };
        const onItemLeave = () => {
          if (item.node.hasAttribute(ITEM_ATTR)) schedulePointerClose();
        };
        item.onEnter = onItemEnter;
        item.onLeave = onItemLeave;
        item.node.addEventListener("pointerenter", onItemEnter);
        item.node.addEventListener("pointerleave", onItemLeave);
        item.node.addEventListener("focusin", onItemEnter);
        item.node.addEventListener("click", scheduleItemLayout);
      }
      row.addEventListener("focusout", scheduleFocusClose);
      row.addEventListener("keydown", onKeyDown);
      document.addEventListener("pointerdown", onDocumentPointerDown, true);
      window.addEventListener("resize", layout);
      const resizeObserver = new ResizeObserver(layout);
      resizeObserver.observe(card);
      for (const item of items) resizeObserver.observe(item.node);
      scheduleItemLayout();

      const state = {
        card,
        row,
        tools,
        trailing,
        surface,
        panel,
        trigger,
        items,
        layout,
        cleanup() {
          disposed = true;
          window.clearTimeout(closeTimer);
          if (layoutFrame !== 0) window.cancelAnimationFrame(layoutFrame);
          layoutFrame = 0;
          resizeObserver.disconnect();
          window.removeEventListener("resize", layout);
          trigger.removeEventListener("pointerenter", open);
          trigger.removeEventListener("pointerleave", schedulePointerClose);
          trigger.removeEventListener("focus", open);
          trigger.removeEventListener("click", toggle);
          panel.removeEventListener("pointerenter", open);
          panel.removeEventListener("pointerleave", schedulePointerClose);
          for (const item of items) {
            item.node.removeEventListener("pointerenter", item.onEnter);
            item.node.removeEventListener("pointerleave", item.onLeave);
            item.node.removeEventListener("focusin", item.onEnter);
            item.node.removeEventListener("click", scheduleItemLayout);
            item.node.removeAttribute(ITEM_ATTR);
            item.node.removeAttribute("data-dshi-menu-align");
            item.node.removeAttribute("data-dshi-menu-direction");
            item.node.style.removeProperty("--dshi-item-left");
            item.node.style.removeProperty("--dshi-item-top");
          }
          panel.removeAttribute("data-dshi-direction");
          panel.style.removeProperty("--dshi-panel-left");
          panel.style.removeProperty("--dshi-panel-top");
          panel.style.removeProperty("--dshi-panel-width");
          panel.style.removeProperty("--dshi-panel-height");
          row.removeEventListener("focusout", scheduleFocusClose);
          row.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("pointerdown", onDocumentPointerDown, true);
          delete card.dataset.dshIslandReady;
          row.removeAttribute("data-dsh-island-row");
          row.removeAttribute("data-dsh-island-open");
          tools.removeAttribute("data-dsh-island-tools");
          trailing.removeAttribute("data-dsh-island-trailing");
        },
      };
      states.set(card, state);
    }

    function discoverComposerRecords() {
      const cards = new Set([...document.querySelectorAll("[data-composer-card]")].filter((node) => node instanceof HTMLElement));
      for (const surface of document.querySelectorAll(`[${SURFACE_ATTR}]`)) {
        let container = surface.parentElement;
        while (container instanceof HTMLElement && container !== document.body) {
          if (findComposerParts(container) !== null) {
            cards.add(container);
            break;
          }
          container = container.parentElement;
        }
      }
      return [...cards]
        .map((card) => {
          const parts = findComposerParts(card);
          return parts === null ? null : { card, parts, candidates: discoverCandidates(parts) };
        })
        .filter((record) => record !== null);
    }

    function mutationTouchesComposer(mutation) {
      const selector = `[data-composer-card],[data-input-scroll],[data-slot],${PLUGIN_MARKER_SELECTOR},${BUTTON_CONTROL_SELECTOR},.team-seat`;
      const target = mutation.target;
      if (target instanceof Element && (target.matches(selector) || target.closest("[data-composer-card]") !== null)) return true;
      for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (!(node instanceof Element)) continue;
        if (node.matches(selector) || node.querySelector(selector) !== null) return true;
      }
      return false;
    }

    function IslandSettingsSection() {
      const snapshot = react.useSyncExternalStore(candidateStore.subscribe, candidateStore.getSnapshot, candidateStore.getSnapshot);
      const selected = new Set(snapshot.selected);
      const selectedCurrent = snapshot.items.filter((item) => selected.has(item.id)).length;
      const groups = ZONE_ORDER.map((zone) => ({ zone, items: snapshot.items.filter((item) => item.zone === zone) })).filter((group) => group.items.length > 0);
      return h("div", { className: "dshi-settings" },
        h("div", { className: "dshi-settings-summary" },
          h("span", { className: "dshi-settings-count" }, `已检测 ${snapshot.items.length} 个控件，已选择 ${selectedCurrent} 个`),
          h("button", { type: "button", className: "dshi-settings-reset", onClick: candidateStore.reset }, "恢复默认")
        ),
        groups.length === 0
          ? h("p", { className: "dshi-settings-empty" }, "当前输入框尚未检测到可配置控件")
          : groups.map((group) => h("section", { className: "dshi-settings-group", key: group.zone },
            h("h3", { className: "dshi-settings-group-title" }, ZONE_LABELS[group.zone]),
            group.items.map((item) => h("label", {
              className: "dshi-settings-row",
              key: item.id,
              "data-dsh-island-setting-id": item.id,
            },
              h("input", {
                type: "checkbox",
                checked: selected.has(item.id),
                "data-dsh-island-setting-control": item.id,
                onChange: (event) => candidateStore.setSelected(item.id, event.target.checked),
              }),
              h("span", { className: "dshi-settings-name", title: item.label }, item.label),
              h("span", { className: "dshi-settings-state" }, selected.has(item.id) ? "已选择" : "原位")
            ))
          ))
      );
    }

    function apply(ctx) {
      document.getElementById(STYLE_ID)?.remove();
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.dataset.plugin = PLUGIN_ID;
      style.textContent = CSS;
      document.head.appendChild(style);

      const states = new Map();
      let scanFrame = 0;
      const scan = () => {
        scanFrame = 0;
        const records = discoverComposerRecords();
        registerCurrentCandidates(records.flatMap((record) => record.candidates));
        const recordByCard = new Map(records.map((record) => [record.card, record]));
        for (const [card, state] of states) {
          const record = recordByCard.get(card);
          if (record === undefined || !stateIsCurrent(state, record.candidates)) {
            state.cleanup();
            states.delete(card);
          }
        }
        for (const record of records) decorateCard(record, states);
        for (const state of states.values()) state.layout();
      };
      const scheduleScan = () => {
        if (scanFrame !== 0) return;
        scanFrame = window.requestAnimationFrame(scan);
      };
      requestRefresh = () => {
        for (const state of states.values()) state.cleanup();
        states.clear();
        scheduleScan();
      };
      const observer = new MutationObserver((mutations) => {
        if (mutations.some(mutationTouchesComposer)) scheduleScan();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      scan();

      ctx.slots.inject(RIGHT_SLOT, () => ctx.slots.register({
        name: RIGHT_SLOT,
        id: "composer-dynamic-island-trigger",
        order: 85,
      }, IslandSurface));

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "composer-dynamic-island",
        order: 29,
        label: "输入灵动岛",
      }, IslandSettingsSection));

      ctx.effect(() => () => {
        observer.disconnect();
        if (scanFrame !== 0) window.cancelAnimationFrame(scanFrame);
        requestRefresh = () => {};
        for (const state of states.values()) state.cleanup();
        states.clear();
        style.remove();
      }, "composer dynamic island");
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.__testing = { discoverCandidates, findComposerParts, inputSlotZone };
    return module.exports;
  },
});
