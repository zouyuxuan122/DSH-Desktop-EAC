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

function patchOptionalEscalationFields() {
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

function main() {
  patchPickerWorker();
  patchSettingsNavScroll();
  patchOptionalEscalationFields();
}

main();
