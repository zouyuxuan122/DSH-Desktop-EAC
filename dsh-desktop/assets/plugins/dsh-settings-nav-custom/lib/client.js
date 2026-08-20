// dsh-settings-nav-custom — 设置页左侧边栏自定义（DSH Desktop 配套插件）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   · 枚举 slots 服务里 settings.section 条目（与官方设置页同一数据源，
//     官方实现见 dsh-client-ui-settings-general 506-511 行）；
//   · 在设置面板左侧导航（.nav）底部加「自定义边栏」按钮，打开浮层：
//     按需显示/隐藏 + 拖拽排序，localStorage 持久化
//     （eac:settings-nav:v1），首次只显示必要栏目，其余可在编辑器中恢复；
//   · 通过 MutationObserver 跟随设置面板挂载/重渲染自动重放配置。
//
// 纯逻辑挂在 window.__dshSettingsNavCore 上（生产无副作用），node 测试套件
// 直接评估本文件验证 — 官方模块加载器只支持 classic script，不能 import。
(function () {
  'use strict';

  // ───────────────────────── 纯逻辑（可测） ─────────────────────────
  var STORAGE_KEY = 'eac:settings-nav:v1';

  // 首次使用与「恢复默认」的导航优先级。未知/后来注册的分区保持其
  // 注册顺序并排在后面，避免新插件因为没有维护本表而消失或乱序。
  var DEFAULT_LABEL_ORDER = [
    '通用设置', '模型', 'Agent 预设', '人设卡', '对话管理', '价格设置',
    '记忆', '侧边临时会话', '侧边卡片', 'Skills 与 MCP', '插件',
    '选择向导', '插件保护', '外观 · 字体与颜色', '视觉模型', '自定义提示词',
    '第三方模型思考强度', '自动压缩', 'AI 变更审核', '快照', '归档对话管理',
    '一键迁移（夺舍）', 'ClawBot'
  ];
  var DEFAULT_VISIBLE_LABELS = [
    '通用设置', 'Agent 预设', '模型', '对话管理', '侧边卡片', '插件',
    '选择向导', 'Skills 与 MCP'
  ];

  function isDefaultVisible(section) {
    var label = (section.label || '').replace(/^\s*[^\w\u4e00-\u9fff]+\s*/, '');
    for (var i = 0; i < DEFAULT_VISIBLE_LABELS.length; i++) {
      if (label === DEFAULT_VISIBLE_LABELS[i] || label.indexOf(DEFAULT_VISIBLE_LABELS[i]) === 0) return true;
    }
    return false;
  }

  function defaultConfig(sections) {
    var hidden = new Set();
    for (var i = 0; i < sections.length; i++) {
      if (!isDefaultVisible(sections[i])) hidden.add(sections[i].id);
    }
    return { hidden: hidden, order: [] };
  }

  function defaultPriority(section) {
    var label = (section.label || '').replace(/^\s*[^\w\u4e00-\u9fff]+\s*/, '');
    for (var i = 0; i < DEFAULT_LABEL_ORDER.length; i++) {
      if (label === DEFAULT_LABEL_ORDER[i] || label.indexOf(DEFAULT_LABEL_ORDER[i]) === 0) return i;
    }
    return DEFAULT_LABEL_ORDER.length;
  }

  function parseConfig(raw) {
    var hidden = new Set();
    var order = [];
    if (raw) {
      try {
        var v = JSON.parse(raw);
        if (v && Array.isArray(v.hidden)) {
          for (var i = 0; i < v.hidden.length; i++) {
            if (typeof v.hidden[i] === 'string') hidden.add(v.hidden[i]);
          }
        }
        if (v && Array.isArray(v.order)) {
          for (var j = 0; j < v.order.length; j++) {
            if (typeof v.order[j] === 'string' && order.indexOf(v.order[j]) === -1) {
              order.push(v.order[j]);
            }
          }
        }
      } catch (e) { /* 容忍脏数据 */ }
    }
    return { hidden: hidden, order: order };
  }

  function serialize(cfg) {
    return JSON.stringify({ hidden: Array.from(cfg.hidden), order: cfg.order.slice() });
  }

  // sections: [{ id, label }]；返回过滤隐藏项并按自定义顺序排列的副本，
  // 未列入 order 的项保持原相对顺序跟在后面。
  function applyConfig(sections, cfg) {
    var visible = [];
    for (var i = 0; i < sections.length; i++) {
      if (!cfg.hidden.has(sections[i].id)) visible.push(sections[i]);
    }
    var byId = new Map();
    for (var j = 0; j < visible.length; j++) byId.set(visible[j].id, visible[j]);
    var ordered = [];
    for (var k = 0; k < cfg.order.length; k++) {
      var s = byId.get(cfg.order[k]);
      if (s) { ordered.push(s); byId.delete(cfg.order[k]); }
    }
    // 旧版/第三方测试或自定义 section 可能使用任意英文标签；只有识别到
    // 官方设置导航的锚点时才启用产品默认优先级，避免改变外部 section 的
    // 原始顺序。
    var useDefaultPriority = visible.some(function (section) {
      return section.label === '通用设置' || section.label === 'Agent 预设';
    });
    var remainder = [];
    for (var m = 0; m < visible.length; m++) {
      if (byId.has(visible[m].id)) remainder.push({ section: visible[m], index: m });
    }
    remainder.sort(function (a, b) {
      return (useDefaultPriority ? defaultPriority(a.section) : 0) -
        (useDefaultPriority ? defaultPriority(b.section) : 0) || a.index - b.index;
    });
    for (var n = 0; n < remainder.length; n++) ordered.push(remainder[n].section);
    return ordered;
  }

  // 保留核心层的兼容 API，旧版本测试/第三方调用仍可使用；界面不再渲染
  // 用户界面统一通过拖拽完成排序。
  function move(id, dir, cfg, knownIds) {
    var order = cfg.order.slice();
    if (knownIds.indexOf(id) === -1) return { hidden: cfg.hidden, order: order };
    var i = order.indexOf(id);
    if (i === -1) { if (dir < 0) order.unshift(id); return { hidden: cfg.hidden, order: order }; }
    var j = i + dir;
    if (j < 0 || j >= order.length) { order.splice(i, 1); return { hidden: cfg.hidden, order: order }; }
    order.splice(i, 1); order.splice(j, 0, id);
    return { hidden: cfg.hidden, order: order };
  }

  function toggle(id, cfg) {
    var hidden = new Set(cfg.hidden);
    if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
    return { hidden: hidden, order: cfg.order.slice() };
  }

  // 按当前可见顺序移动条目，供拖拽排序使用。隐藏项不参与拖拽，
  // 但其配置仍然保留，重新显示后回到自定义顺序中。
  function reorder(id, beforeId, sections, cfg) {
    var visible = applyConfig(sections, cfg).map(function (s) { return s.id; });
    var from = visible.indexOf(id);
    var to = visible.indexOf(beforeId);
    if (from < 0 || to < 0 || from === to) return { hidden: cfg.hidden, order: cfg.order.slice() };
    visible.splice(from, 1);
    visible.splice(visible.indexOf(beforeId), 0, id);
    return { hidden: cfg.hidden, order: visible };
  }

  window.__dshSettingsNavCore = {
    STORAGE_KEY: STORAGE_KEY,
    parseConfig: parseConfig,
    serialize: serialize,
    applyConfig: applyConfig,
    move: move,
    reorder: reorder,
    toggle: toggle,
    defaultConfig: defaultConfig,
  };

  // ───────────────────────── DOM 粘合 ─────────────────────────
  // 设置面板结构（官方 dsh-client-ui-settings-general，class 名带 hash，
  // 此处全部走结构定位，不依赖 hash class）：
  //   .panel (flex)
  //     .nav (188px 列)
  //       .navTitle
  //       .navList           ← 导航项（button.navCell）
  //     .content
  //       .header
  //       .options
  //         [data-slot="settings.section"]   ← 当前区段内容
  var FOOTER_TEXT = '自定义边栏';
  var EDITOR_TITLE = '自定义左侧边栏';

  function findPanel() {
    var host = document.querySelector('[data-slot="settings.section"]');
    if (!host) return null;
    var options = host.parentElement;
    var content = options && options.parentElement;
    var panel = content && content.parentElement;
    return panel || null;
  }

  function findNavList(panelEl) {
    var nav = panelEl && panelEl.firstElementChild;
    if (!nav) return null;
    var list = null;
    for (var i = 0; i < nav.children.length; i++) {
      var el = nav.children[i];
      if (el.tagName === 'DIV' && el.querySelector('button')) { list = el; break; }
    }
    return list;
  }

  function snapshotSections(slots) {
    var out = [];
    try {
      var entries = slots.entries('settings.section') || [];
      for (var i = 0; i < entries.length; i++) {
        var opts = entries[i].options || {};
        var id = opts.id;
        if (typeof id !== 'string' || !id) continue;
        var label = opts.label;
        if (typeof label === 'function') {
          try { label = label(); } catch (e) { label = ''; }
        }
        if (typeof label !== 'string') label = '';
        out.push({ id: id, label: label });
      }
    } catch (e) { /* slots 不可用则放弃，保持官方原样 */ }
    return out;
  }

  function findCell(navList, label, labelMap) {
    var cells = navList.querySelectorAll('button');
    var target = null;
    for (var i = 0; i < cells.length; i++) {
      var text = (cells[i].textContent || '').trim();
      var id = labelMap.get(text);
      if (id !== undefined) {
        if (id === label || text === label) { target = cells[i]; break; }
      } else if (text === label) {
        target = cells[i]; break;
      }
    }
    return target;
  }

  function applyToPanel(panelEl, sections, cfg, labelMap) {
    var navList = findNavList(panelEl);
    if (!navList) return;
    var ordered = window.__dshSettingsNavCore.applyConfig(sections, cfg);
    // 排序/隐藏只写 style（display / flex order），绝不移动 DOM 节点 ——
    // 移动节点会与 React reconciliation 拉锯（闪烁/抽搐、点击迟钝）。
    // navList 是 flex column 容器，order 即视觉顺序。
    var pos = {};
    for (var i = 0; i < ordered.length; i++) pos[ordered[i].id] = i;
    for (var j = 0; j < sections.length; j++) {
      var cell = findCell(navList, sections[j].label, labelMap);
      if (!cell) continue;
      if (cfg.hidden.has(sections[j].id)) {
        cell.style.display = 'none';
      } else {
        cell.style.display = '';
        var p = pos[sections[j].id];
        cell.style.order = String(p !== undefined ? p : sections.length + j);
      }
    }
    ensureFooter(panelEl, navList, sections, cfg);
  }

  function ensureFooter(panelEl, navList, sections, cfg) {
    var nav = navList.parentElement;
    var footer = nav && nav.querySelector('.eac-nav-footer');
    if (!footer) {
      footer = document.createElement('button');
      footer.type = 'button';
      footer.className = 'eac-nav-footer';
      footer.textContent = FOOTER_TEXT;
      footer.style.cssText =
        'box-sizing:border-box;cursor:pointer;width:100%;height:36px;margin-top:6px;' +
        'border:1px dashed var(--dsw-alias-border-secondary,#3a3f4b);' +
        'border-radius:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);' +
        'background:transparent;font-family:inherit;font-size:12px;line-height:34px;' +
        'flex:none;text-align:center;';
      footer.addEventListener('mouseenter', function () {
        footer.style.borderColor = 'var(--dsw-alias-border-interactive,#6aa8ff)';
        footer.style.color = 'var(--dsw-alias-label-interactive,#6aa8ff)';
      });
      footer.addEventListener('mouseleave', function () {
        footer.style.borderColor = 'var(--dsw-alias-border-secondary,#3a3f4b)';
        footer.style.color = 'var(--dsw-alias-label-secondary,#9aa3b2)';
      });
      footer.addEventListener('click', function () {
        openEditor(panelEl, sections, cfg);
      });
      nav.appendChild(footer);
    }
  }

  function removeEditor() {
    var el = document.querySelector('.eac-nav-editor');
    if (el && el.parentElement) el.parentElement.removeChild(el);
  }

  function editorRow(section, cfg, onChanged, onDrop) {
    var row = document.createElement('div');
    row.draggable = true;
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 4px;border-radius:8px;cursor:grab;';
    row.addEventListener('dragstart', function (ev) {
      row.style.opacity = '.45';
      try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', section.id); } catch (e) {}
    });
    row.addEventListener('dragend', function () { row.style.opacity = ''; row.style.outline = ''; });
    row.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      row.style.outline = '2px solid var(--dsw-alias-interactive-bg,#6aa8ff)';
    });
    row.addEventListener('dragleave', function () { row.style.outline = ''; });
    row.addEventListener('drop', function (ev) {
      ev.preventDefault();
      row.style.outline = '';
      var source = '';
      try { source = ev.dataTransfer.getData('text/plain'); } catch (e) {}
      if (source && source !== section.id && onDrop) onDrop(source, section.id);
    });
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !cfg.hidden.has(section.id);
    box.style.cssText = 'width:16px;height:16px;accent-color:var(--dsw-alias-interactive-bg,#6aa8ff);flex:none;';
    var label = document.createElement('span');
    label.textContent = section.label || section.id;
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'color:var(--dsw-alias-label-primary,#e6e9ef);font-size:13px;';
    box.addEventListener('change', function () {
      onChanged(window.__dshSettingsNavCore.toggle(section.id, cfg));
    });
    row.appendChild(box);
    row.appendChild(label);
    return row;
  }

  function openEditor(panelEl, sections, cfg) {
    removeEditor();
    var overlay = document.createElement('div');
    overlay.className = 'eac-nav-editor';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1200;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(0,0,0,.45);';
    var card = document.createElement('div');
    card.style.cssText = 'box-sizing:border-box;width:min(420px,calc(100vw - 48px));max-height:min(560px,calc(100vh - 96px));' +
      'background:var(--dsw-alias-bg-layer-2,#16181d);border:1px solid var(--dsw-alias-border-strong,#2a2e38);' +
      'border-radius:16px;box-shadow:var(--dsw-shadow-lv3,none);display:flex;flex-direction:column;' +
      'overflow:hidden;color:var(--dsw-alias-label-primary,#e6e9ef);font-family:inherit;';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;' +
      'padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-weak,#23262e);flex:none;';
    var title = document.createElement('span');
    title.textContent = EDITOR_TITLE;
    title.style.cssText = 'font-size:14px;font-weight:600;';
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '恢复默认';
    reset.style.cssText = 'cursor:pointer;border:none;background:transparent;' +
      'color:var(--dsw-alias-label-interactive,#6aa8ff);font-size:12px;font-family:inherit;';
    reset.addEventListener('click', function () {
      try { localStorage.removeItem(window.__dshSettingsNavCore.STORAGE_KEY); } catch (e) {}
      var fresh = window.__dshSettingsNavCore.defaultConfig(sections);
      renderRows(fresh);
      applyAndSave(fresh);
    });
    head.appendChild(title);
    head.appendChild(reset);
    var list = document.createElement('div');
    list.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:6px 16px;' +
      '--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,#2a2e38);';
    var foot = document.createElement('div');
    foot.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;' +
      'border-top:1px solid var(--dsw-alias-border-weak,#23262e);flex:none;';
    var done = document.createElement('button');
    done.type = 'button';
    done.textContent = '完成';
    done.style.cssText = 'cursor:pointer;border:none;border-radius:10px;padding:6px 18px;' +
      'background:var(--dsw-alias-interactive-bg,#6aa8ff);color:var(--dsw-alias-label-primary,#0b0d10);' +
      'font-size:13px;font-family:inherit;font-weight:500;';
    done.addEventListener('click', removeEditor);
    foot.appendChild(done);

    var state = { cfg: cfg };
    function renderRows(c) {
      state.cfg = c;
      list.textContent = '';
      var visible = window.__dshSettingsNavCore.applyConfig(sections, c);
      var hidden = sections.filter(function (section) { return c.hidden.has(section.id); });
      var rows = visible.concat(hidden);
      for (var i = 0; i < rows.length; i++) {
        list.appendChild(editorRow(rows[i], c, applyAndSave, function (from, to) {
          applyAndSave(window.__dshSettingsNavCore.reorder(from, to, sections, state.cfg));
        }));
      }
    }
    function applyAndSave(c) {
      state.cfg = c;
      try { localStorage.setItem(window.__dshSettingsNavCore.STORAGE_KEY, window.__dshSettingsNavCore.serialize(c)); } catch (e) {}
      var labelMap = new Map();
      for (var j = 0; j < sections.length; j++) labelMap.set(sections[j].label, sections[j].id);
      applyToPanel(panelEl, sections, c, labelMap);
      renderRows(c);
    }

    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) removeEditor();
    });
    card.appendChild(head);
    card.appendChild(list);
    card.appendChild(foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    renderRows(cfg);
  }

  // ───────────────────────── 生命周期 ─────────────────────────
  var state = { panel: null, pending: false };

  function schedule(delay) {
    if (state.pending) return;
    state.pending = true;
    setTimeout(function () {
      state.pending = false;
      scan();
    }, delay || 80);
  }

  function scan() {
    var panelEl = findPanel();
    if (!panelEl) {
      if (state.panel) {
        // 设置面板已关闭：回收浮层
        state.panel = null;
        state.fingerprint = '';
        removeEditor();
      }
      return;
    }
    state.panel = panelEl;
    try {
      var slots = state.slots;
      var sections = slots ? snapshotSections(slots) : [];
      var navList = findNavList(panelEl);
      var fp = navList ? navListFingerprint(navList) : '';
      // 导航项集合没变（React 未重建 cell）就绝不重放 —— 只写 style 的
      // order/display 不会产生 childList 变化，杜绝自触发与拉锯。
      if (fp && fp === state.fingerprint) return;
      state.fingerprint = fp;
      var stored = readStorage();
      var cfg = stored ? window.__dshSettingsNavCore.parseConfig(stored) :
        window.__dshSettingsNavCore.defaultConfig(sections);
      var labelMap = new Map();
      for (var i = 0; i < sections.length; i++) labelMap.set(sections[i].label, sections[i].id);
      applyToPanel(panelEl, sections, cfg, labelMap);
    } catch (e) { /* 绝不因本插件破坏设置页 */ }
  }

  // 导航项指纹：各 cell 的文本标签序列（标签在官方渲染里唯一且稳定）。
  function navListFingerprint(navList) {
    var cells = navList.querySelectorAll('button');
    var parts = [];
    for (var i = 0; i < cells.length; i++) {
      parts.push((cells[i].textContent || '').trim());
    }
    return parts.join('\u0001');
  }

  function readStorage() {
    try { return localStorage.getItem(window.__dshSettingsNavCore.STORAGE_KEY); } catch (e) { return null; }
  }

  function start() {
    if (typeof MutationObserver === 'undefined') return;
    var obs = new MutationObserver(function () { schedule(); });
    try {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { return; }
    schedule(200);
  }

  // ───────────────────────── 注册 ─────────────────────────
  window.__ModuleLoader__.load({
    id: 'dsh-settings-nav-custom',
    factory: function (require) {
      var inject = ['slots'];
      function apply(ctx) {
        try { state.slots = ctx.get('slots'); } catch (e) { state.slots = null; }
        start();
      }
      var module = { exports: {} };
      module.exports = { inject: inject, apply: apply };
      return module.exports;
    },
  });
})();
