// dsh-settings-groups — 设置页侧边栏「普通/高级」分组 + 常规页页内高级折叠
// （DSH Desktop 配套插件）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   · 侧边栏分组：找到设置面板的导航列表（官方 hashed .navList，行是
//     BUTTON.navCell），按行标题关键词把设置项分成「普通」与「高级」两组，
//     在两组交界处插入本插件自己的组头节点（非 React 管理）：
//       「普通」直接展示；「高级 ▸/▾ (N)」默认收起（行 display:none），
//       展开状态 localStorage 持久化（eac:settings-groups-nav:v1）。
//     组头/折叠全部只写 style 与插入自有节点，绝不搬动 React 行节点；
//     MutationObserver + 标题指纹跟随重渲染重放（指纹含组头存在位，
//     React 重渲染抹掉组头时也会恢复）。
//   · 常规页页内折叠（旧行为）：settings.section 里的 settings.general.item
//     低频行归入「高级选项」折叠组（eac:settings-groups:v1）。
//
// 纯逻辑挂在 window.__dshSettingsGroupsCore 上（生产无副作用），node 测试
// 套件直接评估本文件验证 — 官方模块加载器只支持 classic script，不能 import。
(function () {
  'use strict';

  // ───────────────────────── 纯逻辑（可测） ─────────────────────────
  var STORAGE_KEY = 'eac:settings-groups:v1';
  var NAV_STORAGE_KEY = 'eac:settings-groups-nav:v1';

  // 常规页页内「高级选项」关键词（匹配行标题，不区分大小写；中英双语）。
  var DEFAULT_ADVANCED_KEYWORDS = [
    '外观', '语言', '权限', '开发者', '实验', '高级',
    'appearance', 'language', 'permission', 'developer', 'experimental', 'advanced'
  ];

  // 侧边栏「高级」分组关键词：覆盖模型/插件/视觉/外观/迁移/审核/快照等
  // 偏技术向的设置项；日常项（通用设置/价格/人设卡/记忆/对话管理/侧边
  // 等）不含关键词，自然落在「普通」组。
  var NAV_KEYWORDS = [
    '模型', '插件', 'mcp', '视觉', '外观', '迁移', '夺舍', '压缩',
    '审核', '快照', 'clawbot', '提示词', '思考强度', '归档',
    'model', 'plugin', 'mcp', 'vision', 'appearance', 'migrate',
    'snapshot', 'archive', 'prompt', 'experimental', 'advanced'
  ];

  function parseConfig(raw) {
    var cfg = { expanded: false };
    if (raw) {
      try {
        var v = JSON.parse(raw);
        if (v && typeof v.expanded === 'boolean') cfg.expanded = v.expanded;
      } catch (e) { /* 容忍脏数据 */ }
    }
    return cfg;
  }

  function serialize(cfg) {
    return JSON.stringify({ expanded: cfg.expanded === true });
  }

  // 标题是否命中任意关键词（子串匹配，不区分大小写）。
  function isAdvancedTitle(text, keywords) {
    var t = String(text || '').toLowerCase();
    if (!t) return false;
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(String(keywords[i]).toLowerCase()) !== -1) return true;
    }
    return false;
  }

  // 纯规划：给定各标题与关键词，返回 { advanced: [下标], basic: [下标] }，
  // 各自保持原顺序；空标题行一律视为基础（不折叠无法识别的行，零误伤）。
  function partitionItems(titles, keywords) {
    var advanced = [];
    var basic = [];
    for (var i = 0; i < titles.length; i++) {
      if (isAdvancedTitle(titles[i], keywords)) advanced.push(i);
      else basic.push(i);
    }
    return { advanced: advanced, basic: basic };
  }

  window.__dshSettingsGroupsCore = {
    STORAGE_KEY: STORAGE_KEY,
    NAV_STORAGE_KEY: NAV_STORAGE_KEY,
    DEFAULT_ADVANCED_KEYWORDS: DEFAULT_ADVANCED_KEYWORDS.slice(),
    NAV_KEYWORDS: NAV_KEYWORDS.slice(),
    parseConfig: parseConfig,
    serialize: serialize,
    isAdvancedTitle: isAdvancedTitle,
    partitionItems: partitionItems,
  };

  // ───────────────────────── DOM 粘合 ─────────────────────────
  // 侧边栏结构（官方设置页，class 名带 hash，此处走结构定位）：
  //   .panel > .nav > .navList > BUTTON.navCell × N
  // 组头是本插件的自有节点，插在两组交界处。
  var NAV_HEAD_CLASS = 'eac-settings-groups-navhead';
  var HEAD_CLASS = 'eac-settings-groups-head';
  var HEAD_LABEL = '高级选项';

  function firstText(el) {
    if (!el) return '';
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 60 ? t.slice(0, 60) : t;
  }

  // 设置页导航列表：class 含 navList 且直接子级里有「通用设置」行（锚定
  // 设置面板，避免误中会话侧栏等其他 navList）。
  function findNavList() {
    var lists = document.querySelectorAll('[class*="navList"]');
    for (var i = 0; i < lists.length; i++) {
      var cells = lists[i].children;
      for (var j = 0; j < cells.length; j++) {
        if (firstText(cells[j]) === '通用设置') return lists[i];
      }
    }
    return null;
  }

  // 导航行：官方行是 BUTTON（hashed 类名带 navCell 前缀，classList 精确
  // 匹配不可靠），与 dsh-settings-nav-custom 同策略按标签取行；组头是
  // DIV，天然不会混入。
  function navCellsOf(list) {
    return Array.prototype.slice.call(list.querySelectorAll('button'));
  }

  function removeNavHeads(list) {
    var heads = list.querySelectorAll('.' + NAV_HEAD_CLASS);
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].parentElement) heads[i].parentElement.removeChild(heads[i]);
    }
  }

  function navHeadEl(list, text, isToggle) {
    var head = document.createElement('div');
    head.className = NAV_HEAD_CLASS;
    head.style.cssText =
      'box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;' +
      'width:100%;padding:12px 14px 6px;' +
      'color:var(--dsw-alias-label-tertiary, #8a8f98);' +
      'font-size:12px;line-height:16px;letter-spacing:0.04em;' +
      (isToggle ? 'cursor:pointer;user-select:none;' : '');
    head.textContent = text;
    return head;
  }

  // 应用侧边栏分组：只写 advanced 行 display 与插入组头，绝不移动 React
  // 节点。navList 是 flex column 时用 order 把展开态排成
  // 「普通头 → 普通行 → 高级头 → 高级行」；非 flex 时靠 DOM 插入位置，
  // 折叠态下两组交界仍正确。
  function applyNav(list, cfg, keywords) {
    var cells = navCellsOf(list);
    var titles = cells.map(firstText);
    var parts = window.__dshSettingsGroupsCore.partitionItems(titles, keywords);
    // 先复位所有行（上次写入的 display/order 清掉）
    for (var i = 0; i < cells.length; i++) {
      cells[i].style.display = '';
      cells[i].style.order = '';
    }
    removeNavHeads(list);
    if (parts.advanced.length === 0) return;
    var isFlex = false;
    try { isFlex = /^(flex|grid)$/.test(getComputedStyle(list).display); } catch (e) {}
    var advancedSet = {};
    for (var k = 0; k < parts.advanced.length; k++) advancedSet[parts.advanced[k]] = true;
    for (var j = 0; j < cells.length; j++) {
      if (advancedSet[j]) {
        if (isFlex) cells[j].style.order = '2';
        if (!cfg.expanded) cells[j].style.display = 'none';
      } else if (isFlex) {
        cells[j].style.order = '0';
      }
    }
    // 组头：普通（无交互）插到第一个基础行前；高级（可点击折叠）插到
    // 第一个高级行前。
    var basicFirst = parts.basic.length ? cells[parts.basic[0]] : null;
    var advFirst = cells[parts.advanced[0]];
    var basicHead = navHeadEl(list, '普通', false);
    list.insertBefore(basicHead, basicFirst || advFirst);
    var advHead = navHeadEl(list, '高级 ' + (cfg.expanded ? '▾' : '▸') + ' (' + parts.advanced.length + ')', true);
    advHead.setAttribute('aria-expanded', String(cfg.expanded));
    advHead.addEventListener('click', function () {
      cfg.expanded = !cfg.expanded;
      try { localStorage.setItem(window.__dshSettingsGroupsCore.NAV_STORAGE_KEY, window.__dshSettingsGroupsCore.serialize(cfg)); } catch (e) {}
      applyNav(list, cfg, keywords);
    });
    list.insertBefore(advHead, advFirst);
    // 组头参与 flex 排序：navList 是 flex column 时 order 0/1/2 保证
    // 「普通头 → 基础行 → 高级头 → 高级行」的视觉顺序（高级行已被移到
    // 尾部，组头必须紧跟其后，否则会停在 DOM 原位、夹在基础行中间）。
    basicHead.style.order = '0';
    advHead.style.order = '1';
  }

  // ───────────────────────── 常规页页内折叠（旧行为） ─────────────────────────
  // 常规设置页结构（官方 dsh-client-ui-settings-general）：
  //   [data-slot="settings.section"] 内 [data-slot="settings.general.item"]
  function findGeneralSection() {
    var sections = document.querySelectorAll('[data-slot="settings.section"]');
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].querySelector('[data-slot="settings.general.item"]')) return sections[i];
    }
    return null;
  }

  // 行标题提取：优先 class 含 title 的元素；退化到第一层子元素里最短文本。
  function itemTitleOf(itemEl) {
    if (!itemEl) return '';
    var byClass = itemEl.querySelector('[class*="title"], [class*="Title"]');
    if (byClass) return firstText(byClass);
    var children = itemEl.children;
    for (var i = 0; i < children.length; i++) {
      var sub = children[i].querySelector ? children[i].querySelector('[class*="title"], [class*="Title"]') : null;
      if (sub) return firstText(sub);
    }
    var best = '';
    for (var j = 0; j < children.length; j++) {
      var t = firstText(children[j]);
      if (!t) continue;
      if (!best || t.length < best.length) best = t;
    }
    return best;
  }

  function removeHead(sectionEl) {
    var head = sectionEl.querySelector('.' + HEAD_CLASS);
    if (head && head.parentElement) head.parentElement.removeChild(head);
  }

  function headEl(sectionEl, count, expanded, onToggle) {
    var existing = sectionEl.querySelector('.' + HEAD_CLASS);
    if (existing) return existing;
    var head = document.createElement('button');
    head.type = 'button';
    head.className = HEAD_CLASS;
    head.setAttribute('aria-expanded', String(expanded));
    head.style.cssText =
      'box-sizing:border-box;cursor:pointer;width:100%;display:flex;align-items:center;gap:8px;' +
      'padding:16px 0;border:none;border-bottom:1px solid var(--dsw-alias-border-l2);' +
      'background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;' +
      'font-size:13px;line-height:20px;text-align:left;';
    head.addEventListener('click', function () { onToggle(); });
    sectionEl.appendChild(head);
    return head;
  }

  function renderHead(head, count, expanded) {
    head.setAttribute('aria-expanded', String(expanded));
    head.textContent = HEAD_LABEL + ' ' + (expanded ? '▾' : '▸') + ' (' + count + ')';
  }

  function applySection(sectionEl, cfg, keywords) {
    var items = Array.prototype.slice.call(sectionEl.querySelectorAll('[data-slot="settings.general.item"]'));
    var titles = items.map(itemTitleOf);
    var parts = window.__dshSettingsGroupsCore.partitionItems(titles, keywords);
    for (var i = 0; i < items.length; i++) {
      items[i].style.display = '';
      items[i].style.order = '';
    }
    if (parts.advanced.length === 0) {
      removeHead(sectionEl);
      return;
    }
    var advancedSet = {};
    for (var k = 0; k < parts.advanced.length; k++) advancedSet[parts.advanced[k]] = true;
    for (var j = 0; j < items.length; j++) {
      if (advancedSet[j]) {
        if (items[j].parentElement === sectionEl) items[j].style.order = '2';
        if (!cfg.expanded) items[j].style.display = 'none';
      } else {
        if (items[j].parentElement === sectionEl) items[j].style.order = '0';
      }
    }
    var head = headEl(sectionEl, parts.advanced.length, cfg.expanded, function () {
      cfg.expanded = !cfg.expanded;
      try { localStorage.setItem(window.__dshSettingsGroupsCore.STORAGE_KEY, window.__dshSettingsGroupsCore.serialize(cfg)); } catch (e) {}
      applySection(sectionEl, cfg, keywords);
    });
    head.style.order = '1';
    renderHead(head, parts.advanced.length, cfg.expanded);
  }

  // ───────────────────────── 生命周期 ─────────────────────────
  var state = { section: null, nav: null, navFp: '', sectionFp: '', pending: false };

  function schedule(delay) {
    if (state.pending) return;
    state.pending = true;
    setTimeout(function () {
      state.pending = false;
      scan();
    }, delay || 80);
  }

  // 指纹：行标题序列 + 组头存在位（React 重渲染抹掉组头时标题不变，
  // 靠存在位翻转触发重放）。
  function navFingerprintOf(list) {
    var cells = navCellsOf(list);
    var parts = [];
    for (var i = 0; i < cells.length; i++) parts.push(firstText(cells[i]));
    parts.push('|heads|' + (list.querySelector('.' + NAV_HEAD_CLASS) ? '1' : '0'));
    return parts.join('\u0001');
  }

  function sectionFingerprintOf(sectionEl) {
    var items = sectionEl.querySelectorAll('[data-slot="settings.general.item"]');
    var parts = [];
    for (var i = 0; i < items.length; i++) parts.push(itemTitleOf(items[i]));
    return parts.join('\u0001');
  }

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function scan() {
    try {
      // 侧边栏分组
      var nav = findNavList();
      if (nav) {
        var nfp = navFingerprintOf(nav);
        if (nfp !== state.navFp || nav !== state.nav) {
          state.nav = nav;
          state.navFp = nfp;
          var navCfg = window.__dshSettingsGroupsCore.parseConfig(readStorage(window.__dshSettingsGroupsCore.NAV_STORAGE_KEY));
          applyNav(nav, navCfg, window.__dshSettingsGroupsCore.NAV_KEYWORDS);
        }
      } else {
        state.nav = null;
        state.navFp = '';
      }
      // 常规页页内折叠
      var sectionEl = findGeneralSection();
      if (!sectionEl) {
        if (state.section) {
          state.section = null;
          state.sectionFp = '';
        }
        return;
      }
      state.section = sectionEl;
      var fp = sectionFingerprintOf(sectionEl);
      if (fp && fp === state.sectionFp) return;
      state.sectionFp = fp;
      var cfg = window.__dshSettingsGroupsCore.parseConfig(readStorage(window.__dshSettingsGroupsCore.STORAGE_KEY));
      applySection(sectionEl, cfg, window.__dshSettingsGroupsCore.DEFAULT_ADVANCED_KEYWORDS);
    } catch (e) { /* 绝不因本插件破坏设置页 */ }
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
  // 运行时只为声明了 inject 的插件调用 apply（无 inject 的插件永不启动），
  // 与 dsh-settings-nav-custom / dsh-pet 同策略：inject ['slots'] 换取
  // apply 回调，DOM 工作全部自管。
  window.__ModuleLoader__.load({
    id: 'dsh-settings-groups',
    factory: function (require) {
      function apply(ctx) {
        try { if (ctx && ctx.get) ctx.get('slots'); } catch (e) { /* 不需要 slots，仅借 apply 启动 */ }
        start();
      }
      var module = { exports: {} };
      module.exports = { inject: ['slots'], apply: apply };
      return module.exports;
    },
  });
})();