// dsh-settings-groups — 常规页页内「高级选项」折叠（DSH Desktop 配套插件）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   · 常规页页内折叠：settings.section 里的 settings.general.item 低频行归入
//     「高级选项」折叠组（eac:settings-groups:v1）。组头/折叠只写 style 与插
//     入自有节点，绝不搬动 React 行节点；MutationObserver + 标题指纹跟随
//     重渲染重放，React 重渲染抹掉组头时也会恢复。
//   · 侧边栏「普通/高级」分组已在 V4.6.1 并入 dsh-settings-nav-custom
//     （单一写者），本插件不再触碰侧边栏 —— 避免两个插件对同一批行拉锯
//     导致抽搐。相关逻辑、键、指纹从本文件移除，旧侧边栏存储由
//     nav-custom 一次性迁移。
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

  // 侧边栏「高级」分组关键词（V4.6.1 起由 dsh-settings-nav-custom 吸收；
  // 此处保留导出仅为测试兼容与历史对照，实际侧边栏不再由本插件管理）。
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

  // ───────────────────────── DOM 粘合（仅页内折叠） ─────────────────────────
  // 常规设置页结构（官方 dsh-client-ui-settings-general）：
  //   [data-slot="settings.section"] 内 [data-slot="settings.general.item"]
  var HEAD_CLASS = 'eac-settings-groups-head';
  var HEAD_LABEL = '高级选项';

  function findGeneralSection() {
    var sections = document.querySelectorAll('[data-slot="settings.section"]');
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].querySelector('[data-slot="settings.general.item"]')) return sections[i];
    }
    return null;
  }

  function firstText(el) {
    if (!el) return '';
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 60 ? t.slice(0, 60) : t;
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
  var state = { section: null, sectionFp: '', pending: false };

  function schedule(delay) {
    if (state.pending) return;
    state.pending = true;
    setTimeout(function () {
      state.pending = false;
      scan();
    }, delay || 80);
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
  window.__ModuleLoader__.load({
    id: 'dsh-settings-groups',
    factory: function (require) {
      var module = { exports: {} };
      module.exports = { inject: [], apply: function () { start(); } };
      return module.exports;
    },
  });
})();
