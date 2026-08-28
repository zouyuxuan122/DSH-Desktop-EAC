'use strict';
// 依赖层小补丁（幂等）：目录选择器 worker 无消息退出时，把真实退出码/信号带进
// 错误文案。由 postinstall / pack / dist 在打包前应用；匹配失败只告警不中断。
import fs = require('node:fs');
import path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'index.js');

const PATCH_MARKER = 'worker.on("exit", (code, signal) => {';
const OLD_RE = /worker\.on\("exit", \(\) => \{\s*settle\(\(\) => \{\s*reject\(\/\* @__PURE__ \*\/ new Error\("win32 folder dialog worker exited before reporting a result"\)\);\s*\}\);\s*\}\);/;
const NEW_BLOCK = [
  'worker.on("exit", (code, signal) => {',
  '\t\tsettle(() => {',
  '\t\t\tconst suffix = signal ? ` (signal ${signal})` : typeof code === "number" ? ` (exit code ${code})` : "";',
  '\t\t\treject(/* @__PURE__ */ new Error(`win32 folder dialog worker exited before reporting a result${suffix}`));',
  '\t\t});',
  '\t});',
].join('\n');

function patchPickerWorker(): void {
  if (!fs.existsSync(target)) {
    console.log('[patch-deps] dsh-host-directory-picker-native 不存在，跳过');
    return;
  }
  let src = fs.readFileSync(target, 'utf8');
  if (src.includes(PATCH_MARKER)) {
    console.log('[patch-deps] picker worker 退出码补丁已应用，跳过');
    return;
  }
  if (!OLD_RE.test(src)) {
    console.log('[patch-deps] picker-native 未匹配到目标代码（版本可能已更新），跳过');
    return;
  }
  src = src.replace(OLD_RE, NEW_BLOCK);
  fs.writeFileSync(target, src);
  console.log('[patch-deps] 已补丁 picker-native：worker 退出上报 exit code / signal');
}

// 设置弹窗左栏导航滚动补丁：上游 dsh-client-ui-settings-general 的 .nav/.navList
// 没有滚动约束，面板 overflow:hidden 会把排到底部的插件设置条目（如 ClawBot，
// order 50）直接裁掉且无法滚动到。给 navList 加 min-height:0 + overflow-y:auto，
// 并给 nav 补底部内边距，条目多时左栏变为可滚动列表。CSS 类名前缀是内容哈希，
// 用捕获组匹配以兼容上游小版本差异；幂等标记为 CSS 注释 dsh-desktop-nav-scroll。
const NAV_SCROLL_MARKER = 'dsh-desktop-nav-scroll';
const NAV_RE = /\.([A-Za-z0-9_-]+)_nav\{box-sizing:border-box;flex-direction:column;flex:none;gap:18px;width:188px;padding:22px 12px 0;display:flex\}/;
const NAVLIST_RE = /\.([A-Za-z0-9_-]+)_navList\{flex-direction:column;gap:4px;display:flex\}/;

function patchSettingsNavScroll(): void {
  const file = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js');
  if (!fs.existsSync(file)) {
    console.log('[patch-deps] dsh-client-ui-settings-general 不存在，跳过');
    return;
  }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(NAV_SCROLL_MARKER)) {
    console.log('[patch-deps] 设置左栏滚动补丁已应用，跳过');
    return;
  }
  const navMatch = NAV_RE.exec(src);
  const navListMatch = NAVLIST_RE.exec(src);
  if (!navMatch || !navListMatch || navMatch[1] !== navListMatch[1]) {
    console.log('[patch-deps] 设置左栏未匹配到目标 CSS（上游版本可能已修复/更新），跳过');
    return;
  }
  const oldNav = navMatch[0];
  const oldNavList = navListMatch[0];
  const newNav = oldNav.replace('padding:22px 12px 0;', 'padding:22px 12px 12px;');
  const newNavList = oldNavList.replace(
    /\{flex-direction:column;gap:4px;display:flex\}$/,
    '{flex-direction:column;gap:4px;display:flex;min-height:0;overflow-y:auto;padding-bottom:10px;/*' + NAV_SCROLL_MARKER + '*/}'
  );
  src = src.replace(oldNav, newNav).replace(oldNavList, newNavList);
  fs.writeFileSync(file, src);
  console.log('[patch-deps] 已补丁 settings-general：设置弹窗左栏可滚动，底部条目不再被裁掉');
}

// 设置弹窗宽度自适应 + 可拖拽拉伸补丁：上游 panel 固定 width:800px，大屏
// 主窗里右侧内容拥挤且用户无法调整。两件事：
//   1) width 改 min(75vw,1280px) —— 100vw 即主窗视口宽，弹窗跟随主窗宽度
//      伸缩（cap 1280 防大屏占比过大）；max-width calc(100vw - 48px) 保留
//      （窄窗收敛语义不变）。
//   2) overflow:hidden 放开为 auto + resize:horizontal —— 允许拖右下角
//      手柄手动调宽；panel 是 flex 容器（左栏 flex:none 固定 188px、内容
//      区 flex:1 min-width:0 自适应），panel 变宽后内容自然跟随；子树已有
//      自身滚动约束，panel 的 overflow:auto 不会产生意外滚动条；min-width
//      防拖到不可用。幂等标记 dsh-desktop-panel-resize。
const PANEL_RESIZE_MARKER = 'dsh-desktop-panel-resize';
const PANEL_RE =
  /\.([A-Za-z0-9_-]+)_panel\{(z-index:1;background:var\(--dsw-alias-bg-layer-2\);)width:800px;(max-width:[^;]+;height:[^;]+;[^{}]*?display:flex;position:relative;)overflow:hidden\}/;

function patchSettingsPanelResize(): void {
  const file = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js');
  if (!fs.existsSync(file)) {
    console.log('[patch-deps] dsh-client-ui-settings-general 不存在，跳过');
    return;
  }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(PANEL_RESIZE_MARKER)) {
    console.log('[patch-deps] 设置弹窗宽度补丁已应用，跳过');
    return;
  }
  const m = PANEL_RE.exec(src);
  if (!m) {
    console.log('[patch-deps] 设置弹窗未匹配到 panel CSS（上游版本可能已修复/更新），跳过');
    return;
  }
  const next =
    '.' + m[1] + '_panel{' + m[2] + 'width:min(75vw,1280px);' + m[3] +
    'overflow:auto;resize:horizontal;min-width:640px;/*' + PANEL_RESIZE_MARKER + '*/}';
  src = src.replace(m[0], next);
  fs.writeFileSync(file, src);
  console.log('[patch-deps] 已补丁 settings-general：弹窗宽度跟随主窗（≤1280px）+ 可拖拽拉伸');
}

// 函数工具桥接兼容补丁：部分外部工具适配器忽略 JSON Schema 的 required 数组，
// 把所有 properties 错当成必填。全权限默认策略下不存在可升级的更宽模式，仍
// 暴露 sandbox_permissions/justification 会让适配器强制提交一条必然失败的同级
// 升级请求。仅在默认 danger-full-access 时不暴露这对可选字段；执行层的严格
// 升级校验不变。会话切换到较窄策略后需重载工具 schema 才会再次暴露升级字段。
// 覆盖三个工具：dsh-tool-pwsh / dsh-tool-fs / dsh-tool-bash（同为
// `defaultMode === void 0 ? [] : ESCALATION_TARGETS` 模式，缺一即漏）。
const OPTIONAL_ESCALATION_MARKER = 'dsh-desktop-optional-escalation';
const OPTIONAL_ESCALATION_TARGETS = [
  path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-pwsh', 'lib', 'index.js'),
  path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-fs', 'lib', 'index.js'),
  path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js'),
];
const OPTIONAL_ESCALATION_OLD = 'defaultMode === void 0 ? [] : ESCALATION_TARGETS';
const OPTIONAL_ESCALATION_NEW = 'defaultMode === void 0 || defaultMode === "danger-full-access" ? [] : ESCALATION_TARGETS /* dsh-desktop-optional-escalation */';

function patchOptionalEscalationFields(): void {
  for (const file of OPTIONAL_ESCALATION_TARGETS) {
    if (!fs.existsSync(file)) {
      console.log('[patch-deps] 可选升级字段目标不存在，跳过：' + file);
      continue;
    }
    let src = fs.readFileSync(file, 'utf8');
    if (src.includes(OPTIONAL_ESCALATION_MARKER)) {
      console.log('[patch-deps] 可选升级字段兼容补丁已应用，跳过：' + path.basename(path.dirname(path.dirname(file))));
      continue;
    }
    if (!src.includes(OPTIONAL_ESCALATION_OLD)) {
      console.log('[patch-deps] 未匹配可选升级字段目标（上游版本可能已修复/更新），跳过：' + file);
      continue;
    }
    src = src.replace(OPTIONAL_ESCALATION_OLD, OPTIONAL_ESCALATION_NEW);
    fs.writeFileSync(file, src);
    console.log('[patch-deps] 已补丁可选升级字段：' + path.basename(path.dirname(path.dirname(file))));
  }
}

// 模式选择菜单二级化补丁：agent preset 选择器把 user trust（自定义 / EAC 内置）
// 的 preset 收进「第三方模式」二级菜单（Menu 原生 submenu），官方内置（system
// trust）保留主列表。幂等 marker: dsh-desktop:third-party（preset id 规则不允许
// 冒号，不会与真实 preset id 冲突）。目标代码是编译产物，锚点失配告警跳过。
const AGENT_PRESET_MARKER = 'dsh-desktop:third-party';
const AGENT_PRESET_FILE = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-agent-preset', 'lib', 'client.js');
const AGENT_PRESET_SEAT_START = 'items: state.options.map((option) => {';
const AGENT_PRESET_SEAT_TAIL = '}),\n\t\t\t\tselectedId: state.current,';
const AGENT_PRESET_ROW_START = 'items: options.map((option) => {';
const AGENT_PRESET_ROW_TAIL = '}),\n\t\t\t\tselectedId,';
const AGENT_PRESET_ZH_ANCHOR = 'presetCordisName: "创造模式",';
const AGENT_PRESET_EN_ANCHOR = 'presetCordisName: "Creator mode",';

function patchAgentPresetMenu(file?: string): boolean {
  const target = file || AGENT_PRESET_FILE;
  if (!fs.existsSync(target)) {
    console.log('[patch-deps] dsh-client-ui-agent-preset 不存在，跳过');
    return false;
  }
  let src = fs.readFileSync(target, 'utf8');
  if (src.includes(AGENT_PRESET_MARKER)) {
    console.log('[patch-deps] agent-preset 模式菜单补丁已应用，跳过');
    return true;
  }
  const seatStart = src.indexOf(AGENT_PRESET_SEAT_START);
  const seatTail = seatStart >= 0 ? src.indexOf(AGENT_PRESET_SEAT_TAIL, seatStart) : -1;
  const rowStart = src.indexOf(AGENT_PRESET_ROW_START);
  const rowTail = rowStart >= 0 ? src.indexOf(AGENT_PRESET_ROW_TAIL, rowStart) : -1;
  if (seatStart < 0 || seatTail < 0 || rowStart < 0 || rowTail < 0 || !src.includes(AGENT_PRESET_ZH_ANCHOR) || !src.includes(AGENT_PRESET_EN_ANCHOR)) {
    console.log('[patch-deps] agent-preset 未匹配到目标代码（版本可能已更新），跳过');
    return false;
  }
  const seatBody = src.slice(seatStart + AGENT_PRESET_SEAT_START.length, seatTail);
  const rowBody = src.slice(rowStart + AGENT_PRESET_ROW_START.length, rowTail);
  // composer 座位：官方保留主列表，第三方收进「第三方模式」submenu。
  // submenu 子项复用两行渲染体，但 Menu 的 submenu item 是 flex-row center，
  // 会压扁两行结构导致字体重叠 —— 给子项 item span 加内联纵向布局覆盖。
  const seatSubItemBody = seatBody.replace(
    'className: AgentPresetSeat_module_css_default.item,',
    'className: AgentPresetSeat_module_css_default.item, style: { flexDirection: "column" },'
  );
  const seatNew =
    'items: [...state.options.filter((option) => option.trust !== "user").map((option) => {' + seatBody +
    '\n\t\t\t\t}), ...(function () {\n' +
    '\t\t\t\t\tconst user = state.options.filter((option) => option.trust === "user");\n' +
    '\t\t\t\t\tif (user.length === 0) return [];\n' +
    '\t\t\t\t\treturn [{\n' +
    '\t\t\t\t\t\tid: "' + AGENT_PRESET_MARKER + '",\n' +
    '\t\t\t\t\t\tlabel: (0, react_jsx_runtime.jsxs)("span", {\n' +
    '\t\t\t\t\t\t\tclassName: AgentPresetSeat_module_css_default.item,\n' +
    '\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {\n' +
    '\t\t\t\t\t\t\t\tclassName: AgentPresetSeat_module_css_default.itemName,\n' +
    '\t\t\t\t\t\t\t\tchildren: t("menu.thirdPartyMode")\n' +
    '\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {\n' +
    '\t\t\t\t\t\t\t\tclassName: AgentPresetSeat_module_css_default.itemDesc,\n' +
    '\t\t\t\t\t\t\t\tchildren: t("menu.thirdPartyModeHint")\n' +
    '\t\t\t\t\t\t\t})]\n' +
    '\t\t\t\t\t\t}),\n' +
    '\t\t\t\t\t\tsubmenu: user.map((option) => {' + seatSubItemBody +
    '\n\t\t\t\t\t\t})\n' +
    '\t\t\t\t\t}];\n' +
    '\t\t\t\t}())],\n\t\t\t\tselectedId: state.current,';
  // 设置行（PresetMenu，纯文本 label）：同样收进 submenu，组内不再带「· 自定义」后缀
  const rowNew =
    'items: [...options.filter((option) => option.trust !== "user").map((option) => {' + rowBody +
    '\n\t\t\t\t}), ...(function () {\n' +
    '\t\t\t\t\tconst user = options.filter((option) => option.trust === "user");\n' +
    '\t\t\t\t\tif (user.length === 0) return [];\n' +
    '\t\t\t\t\treturn [{\n' +
    '\t\t\t\t\t\tid: "' + AGENT_PRESET_MARKER + '",\n' +
    '\t\t\t\t\t\tlabel: t("menu.thirdPartyMode"),\n' +
    '\t\t\t\t\t\tsubmenu: user.map((option) => {\n' +
    '\t\t\t\t\t\t\tconst name = presetDisplayText(option, t).name;\n' +
    '\t\t\t\t\t\t\treturn { id: option.id, label: name };\n' +
    '\t\t\t\t\t\t})\n' +
    '\t\t\t\t\t}];\n' +
    '\t\t\t\t}())],\n\t\t\t\tselectedId,';
  const zhDictAdd = '\n\t\t\t"menu.thirdPartyMode": "第三方模式",\n\t\t\t"menu.thirdPartyModeHint": "自定义与 EAC 内置的 Agent 预设",';
  const enDictAdd = '\n\t\t\t"menu.thirdPartyMode": "Third-party modes",\n\t\t\t"menu.thirdPartyModeHint": "Custom and EAC-bundled agent presets",';
  // 先做 items 替换（用旧索引的 slice），再注入词典（词典锚点在 items 之前，不受 items 替换影响）
  src = src
    .replace(src.slice(seatStart, seatTail + AGENT_PRESET_SEAT_TAIL.length), seatNew)
    .replace(src.slice(rowStart, rowTail + AGENT_PRESET_ROW_TAIL.length), rowNew)
    .replace(AGENT_PRESET_ZH_ANCHOR, AGENT_PRESET_ZH_ANCHOR + zhDictAdd)
    .replace(AGENT_PRESET_EN_ANCHOR, AGENT_PRESET_EN_ANCHOR + enDictAdd);
  fs.writeFileSync(target, src);
  console.log('[patch-deps] 已补丁 agent-preset：第三方模式收进二级菜单');
  return true;
}

// Menu 二级菜单滚动补丁：dsh-web-frontend 主 bundle 里 primitives 的 submenu
// 容器没有高度上限，preset 较多时子菜单超出视口且不可滚动。给 submenu 容器
// 注入内联 max-height + overflow-y。rc.2 起 primitives 被打包进主 bundle
// （dsh-web-frontend/dist/assets/index-*.js，压缩变量 xxx.submenu），不再有
// 独立包 —— 目标改为扫描主 bundle。锚点：submenu.map( 前的 role:"menu",。
// 幂等 marker: dsh-desktop:menu-submenu-hover（容器整段重建）+
// --dsh-desktop-submenu-label（submenu 项两行布局）。
// ⚠️ 锚点前提：下方所有字符串锚点在目标 bundle 里必须唯一，否则替换会误伤
// 多处；新增/改动前需先 grep 确认唯一性。
const MENU_SUBMENU_HOVER_MARKER = 'dsh-desktop:menu-submenu-hover';
const MENU_SUBMENU_MAXH = 'calc(100dvh - 96px)';
// 二级菜单宽度与一级菜单对齐：submenu 容器 fit-content 会被 label 里最长的
// 不可断 token 撑到很窄（实测约 163px，一级菜单约 334px）。给 submenu 一个
// 与一级菜单接近的 min-width，描述行更舒展。
const MENU_SUBMENU_MINW = 320;
const MENU_SUBMENU_ANCHOR = 'submenu.map(';
// itemWrap 的 onMouseLeave 默认立即关闭，鼠标从一级菜单项移到二级菜单要
// 跨过二者间隙会先触发离开而缩回。改为延迟关闭（600ms，留足缓慢移动跨
// 间隙的时间），配合二级菜单自身的 onMouseEnter 取消定时器并保持，鼠标可
// 平滑滑入。定时器存 window 全局，幂等重放安全。enter 也先清定时器，防止
// 上一处 leave 排的关闭在移回时误触发。
const ITEMWRAP_LEAVE_ANCHOR = 'onMouseLeave:()=>{z(null)}';
const ITEMWRAP_LEAVE_NEW = 'onMouseLeave:()=>{clearTimeout(window.__dshMenuTimer);window.__dshMenuTimer=setTimeout(()=>z(null),600)}';
// 上一版已打 300ms 延迟的 bundle，升级锚点改为 600ms
const ITEMWRAP_LEAVE_UPGRADE_ANCHOR = 'setTimeout(()=>z(null),300)';
const ITEMWRAP_LEAVE_UPGRADE_NEW = 'setTimeout(()=>z(null),600)';
const ITEMWRAP_ENTER_ANCHOR = 'onMouseEnter:()=>{z(se?B.id:null)}';
const ITEMWRAP_ENTER_NEW = 'onMouseEnter:()=>{clearTimeout(window.__dshMenuTimer);z(se?B.id:null)}';
// submenu 自身 onMouseLeave 若立即 z(null)，从二级菜单移回一级菜单会先关掉
// 二级菜单再重开，时序不稳表现为「移回后不再展开」。改为延迟 400ms，
// 移回一级菜单时 itemWrap enter 清定时器并保持。
const SUBMENU_LEAVE_ANCHOR = 'onMouseLeave:()=>{clearTimeout(window.__dshMenuTimer);z(null)}';
const SUBMENU_LEAVE_NEW = 'onMouseLeave:()=>{clearTimeout(window.__dshMenuTimer);window.__dshMenuTimer=setTimeout(()=>z(null),400)}';
// root span 的 onPointerLeave 默认立即关闭整个菜单。二级菜单是 portal 到 body
// 的独立 DOM，鼠标从一级菜单跨过去必然离开 root span → 菜单（含二级）被立即
// 收起，表现为「二级菜单还没展开就消失」。改为走同一延迟定时器（300ms），
// 与 itemWrap / submenu 的 onMouseEnter 取消逻辑统一，鼠标可平滑滑入二级菜单。
const ROOT_POINTERLEAVE_ANCHOR = 'onPointerLeave:_?()=>{n&&A()}:void 0';
const ROOT_POINTERLEAVE_NEW = 'onPointerLeave:_?()=>{clearTimeout(window.__dshMenuTimer);window.__dshMenuTimer=setTimeout(()=>{n&&A()},300)}:void 0';
// submenu 项两行布局补丁：Menu 的 .itemLabel 默认 white-space:nowrap +
// overflow:hidden，会把 agent-preset 的两行 label（名称+描述）压扁裁成
// 字体重叠。给 submenu 项注入内联覆盖：允许换行、内容可见、item 顶部对齐。
// 幂等 marker 用 style 里的 CSS 自定义属性（React 支持 --xxx 键透传，
// 未被引用则无副作用），避免破坏 JS 语法。
const SUBMENU_ITEM_MARKER = '--dsh-desktop-submenu-label';
const SUBMENU_BTN_ANCHOR = 'f.jsxs("button",{type:"button",role:"menuitem",className:Re.item,disabled:he.disabled';
const SUBMENU_BTN_NEW = 'f.jsxs("button",{type:"button",role:"menuitem",className:Re.item,style:{alignItems:"flex-start",flexShrink:0},disabled:he.disabled';
const SUBMENU_LABEL_ANCHOR = 'f.jsx("span",{className:Re.itemLabel,children:he.label})';
const SUBMENU_LABEL_NEW = 'f.jsx("span",{className:Re.itemLabel,style:{whiteSpace:"normal",overflow:"visible","' + SUBMENU_ITEM_MARKER + '":"1"},children:he.label})';

function patchMenuSubmenuScroll(file?: string): boolean {
  let target: string | undefined = file;
  if (!target) {
    const dir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');
    if (!fs.existsSync(dir)) {
      console.log('[patch-deps] dsh-web-frontend 不存在，跳过');
      return false;
    }
    const candidates = fs.readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith('.js'));
    for (const f of candidates) {
      const full = path.join(dir, f);
      if (fs.readFileSync(full, 'utf8').includes(MENU_SUBMENU_ANCHOR)) { target = full; break; }
    }
  }
  if (!target) {
    console.log('[patch-deps] 主 bundle 未含 submenu 渲染（版本可能已更新），跳过');
    return false;
  }
  if (!fs.existsSync(target)) {
    console.log('[patch-deps] 目标 bundle 不存在，跳过');
    return false;
  }
  let src = fs.readFileSync(target, 'utf8');
  let changed = false;
  // 三个改动各自按锚点独立幂等，不再用单一 marker 门控整个 if 块——
  // 旧版 bundle 已有 hover marker 时，后续新增的 minWidth / root pointerleave
  // 改动仍要能补打上（锚点替换后原始文本消失，自然幂等）。

  // 1) submenu 容器：悬停保持 + 高度/宽度自适应（minWidth 缺失才重建整段）
  if (!src.includes('minWidth:' + MENU_SUBMENU_MINW)) {
    const submenuIdx = src.indexOf(MENU_SUBMENU_ANCHOR);
    const roleIdx = submenuIdx >= 0 ? src.lastIndexOf('role:"menu",', submenuIdx) : -1;
    // role:"menu", 必须紧邻 submenu.map（submenu 容器的 role），距离过大说明命中了别处
    if (submenuIdx < 0 || roleIdx < 0 || submenuIdx - roleIdx > 400) {
      console.log('[patch-deps] Menu submenu 未匹配到目标代码（版本可能已更新），跳过');
      return false;
    }
    // 替换 role:"menu", 到 submenu.map( 之间整段（旧版可能已注入 style + scroll marker）：
    // 二级菜单悬停保持（onMouseEnter 取消关闭定时器并重新激活，onMouseLeave 关闭），
    // 高度自适应视口（内容少自然高度，超高才滚动）、宽度对齐一级菜单，配合
    // itemWrap / root 延迟关闭让鼠标可跨过一级菜单与二级菜单之间的间隙。
    const newBlock = 'role:"menu",onMouseEnter:()=>{clearTimeout(window.__dshMenuTimer);z(B.id)},' + SUBMENU_LEAVE_NEW + ',style:{maxHeight:"' + MENU_SUBMENU_MAXH + '",overflowY:"auto",minWidth:' + MENU_SUBMENU_MINW + '},/*' + MENU_SUBMENU_HOVER_MARKER + '*/children:B.';
    src = src.slice(0, roleIdx) + newBlock + src.slice(submenuIdx);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：二级菜单悬停保持 + 高度/宽度自适应');
  }

  // 2) 一级菜单项：悬停离开延迟关闭（600ms，缓慢跨间隙不折叠）
  if (src.includes(ITEMWRAP_LEAVE_ANCHOR)) {
    src = src.replace(ITEMWRAP_LEAVE_ANCHOR, ITEMWRAP_LEAVE_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：菜单项悬停离开延迟关闭（鼠标可跨间隙滑入二级菜单）');
  } else if (src.includes(ITEMWRAP_LEAVE_UPGRADE_ANCHOR)) {
    src = src.replace(ITEMWRAP_LEAVE_UPGRADE_ANCHOR, ITEMWRAP_LEAVE_UPGRADE_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：菜单项悬停离开延迟加长到 600ms');
  }

  // 3) 菜单根：pointerleave 延迟关闭（二级菜单是 body portal，鼠标跨过去不再立即收起）
  if (src.includes(ROOT_POINTERLEAVE_ANCHOR)) {
    src = src.replace(ROOT_POINTERLEAVE_ANCHOR, ROOT_POINTERLEAVE_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：菜单根 pointerleave 延迟关闭（二级菜单不再被立即收起）');
  }

  // 4) 一级菜单项 onMouseEnter 也清定时器：从二级菜单移回时，上一处 leave 排的
  //    关闭定时器不会在移回后被误触发
  if (src.includes(ITEMWRAP_ENTER_ANCHOR)) {
    src = src.replace(ITEMWRAP_ENTER_ANCHOR, ITEMWRAP_ENTER_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：菜单项悬停进入清关闭定时器（移回二级菜单保持）');
  }

  // 5) submenu 自身 onMouseLeave 改为延迟关闭：从二级菜单移回一级菜单不再先关再开
  if (src.includes(SUBMENU_LEAVE_ANCHOR)) {
    src = src.replace(SUBMENU_LEAVE_ANCHOR, SUBMENU_LEAVE_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：二级菜单悬停离开延迟关闭（移回一级菜单保持）');
  }
  if (!src.includes(SUBMENU_ITEM_MARKER)) {
    const btnIdx = src.indexOf(SUBMENU_BTN_ANCHOR);
    const labelIdx = btnIdx >= 0 ? src.indexOf(SUBMENU_LABEL_ANCHOR, btnIdx) : -1;
    if (btnIdx < 0 || labelIdx < 0) {
      console.log('[patch-deps] Menu submenu item 未匹配到目标代码（版本可能已更新），跳过');
    } else {
      src = src.slice(0, btnIdx) + SUBMENU_BTN_NEW + src.slice(btnIdx + SUBMENU_BTN_ANCHOR.length);
      const l2 = src.indexOf(SUBMENU_LABEL_ANCHOR, btnIdx);
      src = src.slice(0, l2) + SUBMENU_LABEL_NEW + src.slice(l2 + SUBMENU_LABEL_ANCHOR.length);
      changed = true;
      console.log('[patch-deps] 已补丁主 bundle：submenu 项两行布局不再被裁剪');
    }
  }
  if (changed) fs.writeFileSync(target, src);
  return true;
}

function main(): void {
  patchPickerWorker();
  patchSettingsNavScroll();
  patchSettingsPanelResize();
  patchOptionalEscalationFields();
  patchAgentPresetMenu();
  patchMenuSubmenuScroll();
}

// 单测 require 本模块时不应改写真实 node_modules；仅命令行直接执行时跑 main()。
if (require.main === module) {
  main();
}

module.exports = { patchAgentPresetMenu, patchMenuSubmenuScroll };
