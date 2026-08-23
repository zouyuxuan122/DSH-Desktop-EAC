'use strict';
// 依赖层小补丁（幂等）：目录选择器 worker 无消息退出时，把真实退出码/信号带进
// 错误文案。由 postinstall / pack / dist 在打包前应用；匹配失败只告警不中断。
const fs = require('node:fs');
const path = require('node:path');

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

function patchPickerWorker() {
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

function patchSettingsNavScroll() {
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

function patchAgentPresetMenu(file) {
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
  // composer 座位：官方保留主列表，第三方收进「第三方模式」submenu（label 复用原两行渲染体）
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
    '\t\t\t\t\t\tsubmenu: user.map((option) => {' + seatBody +
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

// Menu 二级菜单滚动补丁：primitives 的 submenu 容器没有高度上限，preset 较多时
// 子菜单超出视口且不可滚动（scrollable 类在菜单含 submenu 项时会被整体禁用）。
// 给 submenu 容器注入内联 max-height + overflow-y。锚点用行级定位（submenu 行
// 后第一个 role: "menu", 行），缩进从目标行提取，兼容上游编译产物缩进变化。
// 幂等 marker: dsh-desktop:menu-submenu-scroll。
const MENU_SUBMENU_MARKER = 'dsh-desktop:menu-submenu-scroll';
const MENU_SUBMENU_FILE = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js');
const MENU_SUBMENU_ANCHOR = 'Menu_module_css_default.submenu';

function patchMenuSubmenuScroll(file) {
  const target = file || MENU_SUBMENU_FILE;
  if (!fs.existsSync(target)) {
    console.log('[patch-deps] dsh-client-ui-primitives 不存在，跳过');
    return false;
  }
  let src = fs.readFileSync(target, 'utf8');
  if (src.includes(MENU_SUBMENU_MARKER)) {
    console.log('[patch-deps] Menu 二级菜单滚动补丁已应用，跳过');
    return true;
  }
  const submenuIdx = src.indexOf(MENU_SUBMENU_ANCHOR);
  const roleIdx = submenuIdx >= 0 ? src.indexOf('role: "menu",', submenuIdx) : -1;
  const lineStart = roleIdx >= 0 ? src.lastIndexOf('\n', roleIdx) + 1 : -1;
  const roleLineEnd = roleIdx >= 0 ? src.indexOf('\n', roleIdx) : -1;
  if (lineStart < 0 || roleLineEnd < 0) {
    console.log('[patch-deps] Menu submenu 未匹配到目标代码（版本可能已更新），跳过');
    return false;
  }
  const indent = src.slice(lineStart, roleIdx);
  src = src.slice(0, roleLineEnd) + '\n' + indent + 'style: { maxHeight: "min(50vh, 24rem)", overflowY: "auto" }, /*' + MENU_SUBMENU_MARKER + '*/' + src.slice(roleLineEnd);
  fs.writeFileSync(target, src);
  console.log('[patch-deps] 已补丁 primitives：二级菜单超高可滚动');
  return true;
}

function main() {
  patchPickerWorker();
  patchSettingsNavScroll();
  patchAgentPresetMenu();
  patchMenuSubmenuScroll();
}

// 单测 require 本模块时不应改写真实 node_modules；仅命令行直接执行时跑 main()。
if (require.main === module) {
  main();
}

module.exports = { patchAgentPresetMenu, patchMenuSubmenuScroll };
