// dsh-settings-nav-custom — 设置页左侧边栏唯一控制器（DSH Desktop 配套插件）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   · 枚举 slots 服务里 settings.section 条目（与官方设置页同一数据源）；
//   · 在设置面板左侧导航（.nav）底部加「自定义边栏」按钮，打开浮层：
//     按需显示/隐藏 + 拖拽排序，localStorage 持久化（eac:settings-nav:v1）；
//   · 「普通/高级」分组与「高级」折叠（原 dsh-settings-groups 的侧边栏
//     职责，V4.6.1 并入）：高级组默认收起（eac:sidebar:v2），组头跟随
//     用户自定义顺序。侧边栏行的 display/order 只有本插件一个写入者 ——
//     历史上两个插件各自为政互相"自愈"，是侧边栏抽搐的根因；
//   · 通过 MutationObserver 跟随设置面板挂载/重渲染自动重放配置。
//
// 纯逻辑挂在 window.__dshSettingsNavCore 上（生产无副作用），node 测试套件
// 直接评估本文件验证 — 官方模块加载器只支持 classic script，不能 import。
(function () {
  'use strict';

  // ───────────────────────── 纯逻辑（可测） ─────────────────────────
  var STORAGE_KEY = 'eac:settings-nav:v1';
  var FOLD_STORAGE_KEY = 'eac:sidebar:v2';
  var LEGACY_FOLD_KEY = 'eac:settings-groups-nav:v1';

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

  // 侧边栏「高级」分组关键词（自 dsh-settings-groups 迁入）：命中任意
  // 子串的分区归入高级组，默认收起；日常项自然落在普通组。
  var SIDEBAR_ADVANCED_KEYWORDS = [
    '模型', '插件', 'mcp', '视觉', '外观', '迁移', '夺舍', '压缩',
    '审核', '快照', 'clawbot', '提示词', '思考强度', '归档',
    'model', 'plugin', 'mcp', 'vision', 'appearance', 'migrate',
    'snapshot', 'archive', 'prompt', 'experimental', 'advanced'
  ];

  function stripLabelIcon(label) {
    return (label || '').replace(/^\s*[^\w\u4e00-\u9fff]+\s*/, '');
  }

  function isDefaultVisible(section) {
    var label = stripLabelIcon(section.label);
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
    var label = stripLabelIcon(section.label);
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

  // 折叠状态：默认收起。容忍脏数据。
  function parseFoldConfig(raw) {
    var cfg = { folded: true };
    if (raw) {
      try {
        var v = JSON.parse(raw);
        if (v && typeof v.folded === 'boolean') cfg.folded = v.folded;
      } catch (e) { /* 容忍脏数据 */ }
    }
    return cfg;
  }

  function serializeFoldConfig(cfg) {
    return JSON.stringify({ folded: cfg.folded === true });
  }

  // 旧键迁移（dsh-settings-groups 时代的 expanded 语义）：v2 已存在则原样
  // 使用；否则旧键存在时派生 folded=!expanded、写 v2 并删旧键；都没有给默认。
  function migrateFoldConfig(v2Raw, legacyRaw, writeNew, removeOld) {
    if (typeof v2Raw === 'string' && v2Raw) return parseFoldConfig(v2Raw);
    if (typeof legacyRaw === 'string' && legacyRaw) {
      var derived = { folded: true };
      try {
        var v = JSON.parse(legacyRaw);
        if (v && typeof v.expanded === 'boolean') derived.folded = !v.expanded;
      } catch (e) { /* 脏数据按默认 */ }
      try { writeNew(serializeFoldConfig(derived)); removeOld(); } catch (e) { /* 存储不可用不影响本次 */ }
      return derived;
    }
    return { folded: true };
  }

  // 标题是否命中高级关键词（子串匹配，不区分大小写）。
  function isSidebarAdvancedTitle(text) {
    var t = String(text || '').toLowerCase();
    if (!t) return false;
    for (var i = 0; i < SIDEBAR_ADVANCED_KEYWORDS.length; i++) {
      if (t.indexOf(SIDEBAR_ADVANCED_KEYWORDS[i]) !== -1) return true;
    }
    return false;
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

  // ── 单一写者的核心：一次算出每行最终样式与组头位置 ──
  // sections: [{ id, label }] 全量分区；customCfg: {hidden:Set, order};
  // foldCfg: {folded:boolean}
  // 返回 {
  //   rows:  [{ id, display:'none'|'', order:Number }]   每个分区的最终样式
  //   heads: [{ key:'basic'|'advanced', text, order, beforeId, folded, count }]
  // }
  // 视觉序列 = 用户自定义顺序下的可见行；组头插在各组首行之前（同序号
  // 时由 DOM 先序决定组头在前）。折叠只影响高级行的 display，不动 order，
  // 展开后原位恢复。
  function computeSidebarLayout(sections, customCfg, foldCfg) {
    var ordered = applyConfig(sections, customCfg);
    var seq = [];
    for (var i = 0; i < ordered.length; i++) {
      seq.push({ section: ordered[i], advanced: isSidebarAdvancedTitle(ordered[i].label) });
    }
    var indexOfId = {};
    for (var s = 0; s < seq.length; s++) indexOfId[seq[s].section.id] = s;

    var rows = [];
    for (var j = 0; j < sections.length; j++) {
      var sec = sections[j];
      var idx = indexOfId[sec.id];
      if (idx === undefined) {
        // 用户隐藏：不占视觉序列，排到尾部兜底
        rows.push({ id: sec.id, display: 'none', order: seq.length + j });
        continue;
      }
      var foldedAway = foldCfg.folded && seq[idx].advanced;
      rows.push({ id: sec.id, display: foldedAway ? 'none' : '', order: idx });
    }

    var firstBasic = null;
    var firstAdvanced = null;
    var advCount = 0;
    for (var t = 0; t < seq.length; t++) {
      if (seq[t].advanced) { advCount++; if (!firstAdvanced) firstAdvanced = seq[t].section; }
      else if (!firstBasic) firstBasic = seq[t].section;
    }
    var heads = [];
    if (firstBasic) {
      heads.push({ key: 'basic', text: '普通', order: indexOfId[firstBasic.id], beforeId: firstBasic.id });
    }
    if (firstAdvanced) {
      heads.push({
        key: 'advanced',
        text: '高级 ' + (foldCfg.folded ? '▸' : '▾') + ' (' + advCount + ')',
        order: indexOfId[firstAdvanced.id],
        beforeId: firstAdvanced.id,
        folded: !!foldCfg.folded,
        count: advCount,
      });
    }
    return { rows: rows, heads: heads };
  }

  // 保留核心层的兼容 API，旧版本测试/第三方调用仍可使用；界面统一通过
  // 拖拽完成排序。
  function move(id, dir, cfg, knownIds) {
    var order = cfg.order.slice();
    if (knownIds.indexOf(id) === -1) return { hidden: cfg.hidden, order: order };
    var i = order.indexOf(id);
    if (i === -1) { if (dir < 0) order.unshift(id); else order.push(id); return { hidden: cfg.hidden, order: order }; }
    var j = i + dir;
    if (j < 0) { order.splice(i, 1); order.unshift(id); return { hidden: cfg.hidden, order: order }; }
    if (j >= order.length) { order.splice(i, 1); order.push(id); return { hidden: cfg.hidden, order: order }; }
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
    FOLD_STORAGE_KEY: FOLD_STORAGE_KEY,
    LEGACY_FOLD_KEY: LEGACY_FOLD_KEY,
    SIDEBAR_ADVANCED_KEYWORDS: SIDEBAR_ADVANCED_KEYWORDS.slice(),
    parseConfig: parseConfig,
    serialize: serialize,
    parseFoldConfig: parseFoldConfig,
    serializeFoldConfig: serializeFoldConfig,
    migrateFoldConfig: migrateFoldConfig,
    isSidebarAdvancedTitle: isSidebarAdvancedTitle,
    applyConfig: applyConfig,
    computeSidebarLayout: computeSidebarLayout,
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
  //       .navList           ← 导航项（button.navCell）+ 本插件的组头 DIV
  //     .content
  //       .header
  //       .options
  //         [data-slot="settings.section"]   ← 当前区段内容
  var FOOTER_TEXT = '自定义边栏';
  var EDITOR_TITLE = '自定义左侧边栏';
  var BASIC_HEAD_CLASS = 'eac-sidebar-head-basic';
  var ADV_HEAD_CLASS = 'eac-sidebar-head-advanced';

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

  // 组头幂等放置：已存在则原地更新文本，位置正确就不动 DOM —— 重放完全
  // 幂等，杜绝组头插拔造成的闪烁。
  function placeHead(list, cls, spec, cellById) {
    var head = list.querySelector('.' + cls);
    if (!head) {
      head = document.createElement('div');
      head.className = cls;
      head.style.cssText =
        'box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;' +
        'width:100%;padding:12px 14px 6px;' +
        'color:var(--dsw-alias-label-tertiary, #8a8f98);' +
        'font-size:12px;line-height:16px;letter-spacing:0.04em;' +
        (spec.key === 'advanced' ? 'cursor:pointer;user-select:none;' : '');
      list.insertBefore(head, cellById[spec.beforeId] || null);
    }
    if (head.textContent !== spec.text) head.textContent = spec.text;
    var wantOrder = String(spec.order);
    if (head.style.order !== wantOrder) head.style.order = wantOrder;
    var target = cellById[spec.beforeId] || null;
    if (head.parentElement !== list || head.nextElementSibling !== target) {
      list.insertBefore(head, target);
    }
    if (spec.key === 'advanced') {
      head.setAttribute('aria-expanded', String(!spec.folded));
      if (!head.__eacFoldBound) {
        head.__eacFoldBound = true;
        head.addEventListener('click', function () {
          var cfg = readFoldConfig();
          cfg.folded = !cfg.folded;
          var raw = serializeFoldConfig(cfg);
          try { localStorage.setItem(FOLD_STORAGE_KEY, raw); } catch (e) {}
          var panelEl = findPanel();
          if (panelEl) {
            applySidebar(panelEl);
            // 点击路径同步扫描状态：指纹与折叠存储都记为刚写入的值，观察器
            // 随后调度的那次扫描直接命中跳过条件，不做冗余重放。
            var nl = findNavList(panelEl);
            if (nl) state.fingerprint = navListFingerprint(nl);
            state.lastFoldRaw = raw;
          }
        });
      }
    }
    return head;
  }

  // 侧边栏唯一写入点：布局算一次，行样式与组头全部幂等落盘。
  function applySidebar(panelEl) {
    var navList = findNavList(panelEl);
    if (!navList) return;
    var sections = snapshotSections(state.slots);
    if (!sections.length) return;
    var customCfg = parseConfig(readStorage());
    var foldCfg = readFoldConfig();
    var layout = computeSidebarLayout(sections, customCfg, foldCfg);

    var labelMap = new Map();
    var cellById = {};
    for (var i = 0; i < sections.length; i++) labelMap.set(sections[i].label, sections[i].id);
    for (var r = 0; r < layout.rows.length; r++) {
      var row = layout.rows[r];
      var cell = findCell(navList, sectionsById(sections, row.id).label, labelMap);
      if (!cell) continue;
      cellById[row.id] = cell;
      var d = row.display === 'none' ? 'none' : '';
      if (cell.style.display !== d) cell.style.display = d;
      var o = String(row.order);
      if (cell.style.order !== o) cell.style.order = o;
    }
    var wantBasic = null;
    var wantAdv = null;
    for (var h = 0; h < layout.heads.length; h++) {
      if (layout.heads[h].key === 'basic') wantBasic = layout.heads[h];
      else wantAdv = layout.heads[h];
    }
    if (wantBasic) placeHead(navList, BASIC_HEAD_CLASS, wantBasic, cellById);
    else cleanupHead(navList, BASIC_HEAD_CLASS);
    if (wantAdv) placeHead(navList, ADV_HEAD_CLASS, wantAdv, cellById);
    else cleanupHead(navList, ADV_HEAD_CLASS);
  }

  function sectionsById(sections, id) {
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].id === id) return sections[i];
    }
    return { label: '' };
  }

  function cleanupHead(list, cls) {
    var head = list.querySelector('.' + cls);
    if (head && head.parentElement) head.parentElement.removeChild(head);
  }

  function applyToPanel(panelEl, sections, cfg, labelMap) {
    // 兼容旧签名：编辑器保存路径直接走唯一写入点
    applySidebar(panelEl);
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
        openEditor(footer._latestPanel || panelEl, footer._latestSections || sections, footer._latestCfg || cfg);
      });
      nav.appendChild(footer);
    }
    footer._latestPanel = panelEl;
    footer._latestSections = sections;
    footer._latestCfg = cfg;
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
      applySidebar(panelEl);
      var freshNavList = findNavList(panelEl);
      if (freshNavList) ensureFooter(panelEl, freshNavList, sections, c);
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
  var state = { panel: null, pending: false, fingerprint: '', lastAppliedRaw: null, lastFoldRaw: null, slots: null };

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
        state.lastAppliedRaw = null;
        state.lastFoldRaw = null;
        removeEditor();
      }
      return;
    }
    state.panel = panelEl;
    try {
      var navList = findNavList(panelEl);
      var fp = navList ? navListFingerprint(navList) : '';
      var stored = readStorage();
      var foldRaw = readFoldRaw();
      // 导航集合、自定义存储、折叠存储都没变且样式仍是本插件写入的状态
      // 才跳过；任何一维变化（含 React 剥样式）都触发重放自愈。本插件
      // 写入幂等，应用后指纹收敛，不会自激振荡。
      if (fp && fp === state.fingerprint && stored === state.lastAppliedRaw && foldRaw === state.lastFoldRaw) return;
      applySidebar(panelEl);
      state.fingerprint = navList ? navListFingerprint(navList) : fp;
      state.lastAppliedRaw = stored;
      state.lastFoldRaw = foldRaw;
      var freshNavList = findNavList(panelEl);
      if (freshNavList) ensureFooter(panelEl, freshNavList, snapshotSections(state.slots), parseConfig(stored || ''));
    } catch (e) { /* 绝不因本插件破坏设置页 */ }
  }

  // 导航项指纹：各 cell 的文本标签 + 当前 display/order 样式。只看文本
  // 检测不到外部覆盖 —— React 重建会重置行样式而文本不变，指纹必须随之
  // 变化才能触发重放自愈。本插件自身只写 style（幂等），应用后指纹收敛。
  function navListFingerprint(navList) {
    var cells = navList.querySelectorAll('button');
    var parts = [];
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      parts.push((cell.textContent || '').trim() + '\u0002' + (cell.style.display || '') + '\u0002' + (cell.style.order || ''));
    }
    parts.push('|heads|' +
      (navList.querySelector('.' + BASIC_HEAD_CLASS) ? 'B' : '-') +
      (navList.querySelector('.' + ADV_HEAD_CLASS) ? 'A' : '-'));
    return parts.join('\u0001');
  }

  function readStorage() {
    try { return localStorage.getItem(window.__dshSettingsNavCore.STORAGE_KEY); } catch (e) { return null; }
  }

  function readFoldRaw() {
    try { return localStorage.getItem(FOLD_STORAGE_KEY); } catch (e) { return null; }
  }

  function readFoldConfig() {
    var v2 = readFoldRaw();
    var legacy = null;
    try { legacy = localStorage.getItem(LEGACY_FOLD_KEY); } catch (e) {}
    return migrateFoldConfig(v2, legacy, function (next) {
      try { localStorage.setItem(FOLD_STORAGE_KEY, next); } catch (e) {}
    }, function () {
      try { localStorage.removeItem(LEGACY_FOLD_KEY); } catch (e) {}
    });
  }

  function start() {
    if (typeof MutationObserver === 'undefined') return;
    var obs = new MutationObserver(function () { schedule(); });
    try {
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        // React 重渲染可能只剥行内样式而不动 DOM 结构；监听属性变更才能
        // 触发重放自愈。本插件写入幂等，不会因此自激。
        attributes: true,
        attributeFilter: ['style'],
      });
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
