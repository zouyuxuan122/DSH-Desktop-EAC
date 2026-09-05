'use strict';
// 依赖层小补丁（幂等）：目录选择器 worker 无消息退出时，把真实退出码/信号带进
// 错误文案。由 postinstall / pack / dist 在打包前应用；匹配失败只告警不中断。
import fs = require('node:fs');
import path = require('node:path');
// 内核补丁文件一旦截断 = 用户机启动期 MODULE_NOT_FOUND/语法损坏且无自愈：
// 全部落盘走原子写（tmp + 两步换入，见 lib/atomic-json）。
import { writeFileAtomic } from '../lib/atomic-json';

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
  writeFileAtomic(target, src);
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
  writeFileAtomic(file, src);
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
  writeFileAtomic(file, src);
  console.log('[patch-deps] 已补丁 settings-general：弹窗宽度跟随主窗（≤1280px）+ 可拖拽拉伸');
}

// 设置写入失败传播补丁：上游 SettingsScopeController.mutate() 会把 Remote
// 拒绝和传输异常恢复后直接 return，导致调用方 Promise resolve 并误报“已保存”。
// 普通表单写入遇到 settings-conflict 时刷新镜像并重试一次；显式 revision fence
// 不自动越过。最终失败必须 reject，让设置界面进入自己的错误提示分支。
const SETTINGS_WRITE_MARKER = 'dsh-desktop-settings-write-retry';
const SETTINGS_WRITE_TARGET = path.join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings',
  'lib',
  'client.js',
);
const SETTINGS_WRITE_OLD = [
  '\t\t\tmutate(ops, expectedRevision) {',
  '\t\t\t\tconst ownedOps = structuredClone(ops);',
  '\t\t\t\tconst generation = ++this.writeGeneration;',
  '\t\t\t\treturn this.enqueue(async () => {',
  '\t\t\t\t\tconst revision = expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision;',
  '\t\t\t\t\tlet response;',
  '\t\t\t\t\ttry {',
  '\t\t\t\t\t\tresponse = await this.api.settings.mutate(this.spec.namespace, ownedOps, revision);',
  '\t\t\t\t\t} catch (_settingsWriteFailure) {',
  '\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\treturn;',
  '\t\t\t\t\t}',
  '\t\t\t\t\tif (!response.ok) {',
  '\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\treturn;',
  '\t\t\t\t\t}',
  '\t\t\t\t\tif (this.disposed) return;',
  '\t\t\t\t\tif (generation === this.writeGeneration) {',
  '\t\t\t\t\t\tthis.pendingRevision = void 0;',
  '\t\t\t\t\t\tthis.mirror.acceptView(response.value);',
  '\t\t\t\t\t} else this.pendingRevision = response.value.revision;',
  '\t\t\t\t});',
  '\t\t\t}',
].join('\n');
const SETTINGS_WRITE_NEW = [
  '\t\t\tmutate(ops, expectedRevision) {',
  '\t\t\t\tconst ownedOps = structuredClone(ops);',
  '\t\t\t\tconst generation = ++this.writeGeneration;',
  '\t\t\t\treturn this.enqueue(async () => {',
  `\t\t\t\t\t// ${SETTINGS_WRITE_MARKER}`,
  '\t\t\t\t\tconst toFailure = (error) => {',
  '\t\t\t\t\t\tconst failure = new Error(error?.message ?? "settings write failed");',
  '\t\t\t\t\t\tif (error?.code !== void 0) failure.code = error.code;',
  '\t\t\t\t\t\tif (error?.details !== void 0) failure.details = error.details;',
  '\t\t\t\t\t\treturn failure;',
  '\t\t\t\t\t};',
  '\t\t\t\t\tconst settle = (response) => {',
  '\t\t\t\t\t\tif (this.disposed) return;',
  '\t\t\t\t\t\tif (generation === this.writeGeneration) {',
  '\t\t\t\t\t\t\tthis.pendingRevision = void 0;',
  '\t\t\t\t\t\t\tthis.mirror.acceptView(response.value);',
  '\t\t\t\t\t\t} else this.pendingRevision = response.value.revision;',
  '\t\t\t\t\t};',
  '\t\t\t\t\tconst call = (revision) => this.api.settings.mutate(this.spec.namespace, ownedOps, revision);',
  '\t\t\t\t\tlet response;',
  '\t\t\t\t\ttry {',
  '\t\t\t\t\t\tresponse = await call(expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision);',
  '\t\t\t\t\t} catch (error) {',
  '\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\tthrow error;',
  '\t\t\t\t\t}',
  '\t\t\t\t\tif (!response.ok && response.error.code === "settings-conflict" && expectedRevision === void 0) {',
  '\t\t\t\t\t\tthis.pendingRevision = void 0;',
  '\t\t\t\t\t\tawait this.mirror.load();',
  '\t\t\t\t\t\tif (this.disposed) return;',
  '\t\t\t\t\t\ttry {',
  '\t\t\t\t\t\t\tresponse = await call(this.getSnapshot().revision);',
  '\t\t\t\t\t\t} catch (error) {',
  '\t\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\t\tthrow error;',
  '\t\t\t\t\t\t}',
  '\t\t\t\t\t}',
  '\t\t\t\t\tif (!response.ok) {',
  '\t\t\t\t\t\tconst failure = toFailure(response.error);',
  '\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\tthrow failure;',
  '\t\t\t\t\t}',
  '\t\t\t\t\tsettle(response);',
  '\t\t\t\t});',
  '\t\t\t}',
].join('\n');

function patchSettingsWriteFailureSource(source: string): string | undefined {
  if (source.includes(SETTINGS_WRITE_MARKER)) return source;
  if (!source.includes(SETTINGS_WRITE_OLD)) return undefined;
  return source.replace(SETTINGS_WRITE_OLD, SETTINGS_WRITE_NEW);
}

function patchSettingsWriteFailure(targetFile = SETTINGS_WRITE_TARGET): boolean {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-deps] dsh-client-ui-settings 不存在，跳过');
    return false;
  }
  const source = fs.readFileSync(targetFile, 'utf8');
  const patched = patchSettingsWriteFailureSource(source);
  if (patched === source) {
    console.log('[patch-deps] 设置写入失败传播补丁已应用，跳过');
    return true;
  }
  if (patched === undefined) {
    console.log('[patch-deps] 设置写入目标代码未匹配（上游版本可能已修复/更新），跳过');
    return false;
  }
  writeFileAtomic(targetFile, patched);
  console.log('[patch-deps] 已补丁 client-ui-settings：冲突刷新重试，最终失败不再误报成功');
  return true;
}

// 模型目录图片输入开关：llm-pi-ai 已支持模型级 `input: [text, image]`，
// 但 settings-models 只渲染 id/name/capacity，用户只能手改 YAML。给直接
// DeepSeek 与通用 pi-ai 两套模型表格都增加行内 switch。关闭时传 undefined，
// 复用现有 update/patch 删除字段，保留 catalog/defaultInput 的继承语义。
const MODEL_IMAGE_INPUT_MARKER_V1 = 'dsh-desktop-model-image-input';
const MODEL_IMAGE_INPUT_MARKER = 'dsh-desktop-model-image-input-v2';
const MODEL_SETTINGS_FILE = path.join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-models',
  'lib',
  'client.js',
);
const MODEL_IMAGE_HELPER_ANCHOR = [
  '\t\tfunction modelDrafts(value) {',
  '\t\t\tif (!Array.isArray(value)) return [];',
  '\t\t\treturn value.map((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) ? entry : {});',
  '\t\t}',
].join('\n');
const MODEL_IMAGE_HELPER_V1 = [
  MODEL_IMAGE_HELPER_ANCHOR,
  '\t\t/** Whether one model explicitly declares native image input. */',
  '\t\tfunction modelAcceptsImage(model) {',
  '\t\t\treturn Array.isArray(model["input"]) && model["input"].includes("image");',
  '\t\t}',
  '\t\t/** Render the model-level native image-input declaration switch. */',
  '\t\tfunction ModelImageInputSwitch(props) {',
  '\t\t\tconst enabled = modelAcceptsImage(props.model);',
  '\t\t\tconst label = props.t("modelImageInput");',
  '\t\t\treturn (0, react_jsx_runtime.jsxs)("button", {',
  '\t\t\t\ttype: "button",',
  '\t\t\t\trole: "switch",',
  '\t\t\t\t"aria-checked": enabled,',
  '\t\t\t\t"aria-label": `${label} ${String(props.index + 1)}`,',
  '\t\t\t\ttitle: props.t("modelImageInputHint"),',
  '\t\t\t\tclassName: `${ModelsSection_module_css_default["modelImageSwitch"]}${enabled ? ` ${ModelsSection_module_css_default["modelImageSwitchOn"]}` : ""}`,',
  '\t\t\t\tdisabled: props.disabled,',
  '\t\t\t\tonClick: () => {',
  '\t\t\t\t\tprops.onChange(enabled ? void 0 : ["text", "image"]);',
  '\t\t\t\t},',
  '\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {',
  '\t\t\t\t\tclassName: ModelsSection_module_css_default["modelImageLabel"],',
  '\t\t\t\t\tchildren: label',
  '\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {',
  '\t\t\t\t\tclassName: ModelsSection_module_css_default["modelImageTrack"],',
  '\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelImageThumb"] })',
  '\t\t\t\t})]',
  '\t\t\t});',
  '\t\t}',
].join('\n');
const MODEL_IMAGE_HELPER = [
  MODEL_IMAGE_HELPER_ANCHOR,
  '\t\t/** Whether one model explicitly declares native image input. */',
  '\t\tfunction modelAcceptsImage(model) {',
  '\t\t\treturn Array.isArray(model["input"]) && model["input"].includes("image");',
  '\t\t}',
  '\t\t/** Render the model-level native image-input declaration switch. */',
  '\t\tfunction ModelImageInputSwitch(props) {',
  '\t\t\tconst enabled = modelAcceptsImage(props.model);',
  '\t\t\tconst label = props.t("modelImageInput");',
  '\t\t\treturn (0, react_jsx_runtime.jsx)("button", {',
  '\t\t\t\ttype: "button",',
  '\t\t\t\trole: "switch",',
  '\t\t\t\t"aria-checked": enabled,',
  '\t\t\t\t"aria-label": `${label} ${String(props.index + 1)}`,',
  '\t\t\t\ttitle: props.t("modelImageInputHint"),',
  '\t\t\t\tclassName: `${ModelsSection_module_css_default["modelImageSwitch"]}${enabled ? ` ${ModelsSection_module_css_default["modelImageSwitchOn"]}` : ""}`,',
  '\t\t\t\tdisabled: props.disabled,',
  '\t\t\t\tonClick: () => {',
  '\t\t\t\t\tprops.onChange(enabled ? void 0 : ["text", "image"]);',
  '\t\t\t\t},',
  '\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("span", {',
  '\t\t\t\t\tclassName: ModelsSection_module_css_default["modelImageTrack"],',
  '\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelImageThumb"] })',
  '\t\t\t\t})',
  '\t\t\t});',
  '\t\t}',
].join('\n');
const MODEL_IMAGE_ROW_CSS_RE =
  /\.([A-Za-z0-9_-]+)_modelRow\{grid-template-columns:minmax\(0,1\.4fr\) minmax\(0,1fr\) auto auto;align-items:center;gap:6px;display:grid\}/;
const MODEL_IMAGE_DEEPSEEK_ANCHOR = [
  '\t\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("button", {',
  '\t\t\t\t\t\t\t\t\t\ttype: "button",',
  '\t\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["iconButton"],',
  '\t\t\t\t\t\t\t\t\t\t"aria-label": `${props.t("modelAdvanced")} ${String(index + 1)}`,',
].join('\n');
const MODEL_IMAGE_DEEPSEEK_INSERT = [
  '\t\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(ModelImageInputSwitch, {',
  '\t\t\t\t\t\t\t\t\t\tmodel,',
  '\t\t\t\t\t\t\t\t\t\tindex,',
  '\t\t\t\t\t\t\t\t\t\tt: props.t,',
  '\t\t\t\t\t\t\t\t\t\tdisabled: props.disabled,',
  '\t\t\t\t\t\t\t\t\t\tonChange: (input) => {',
  '\t\t\t\t\t\t\t\t\t\t\tupdate(index, "input", input);',
  '\t\t\t\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\t\t\t}),',
  MODEL_IMAGE_DEEPSEEK_ANCHOR,
].join('\n');
const MODEL_IMAGE_GENERIC_ANCHOR = [
  '\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("button", {',
  '\t\t\t\t\t\t\t\t\ttype: "button",',
  '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["iconButton"],',
  '\t\t\t\t\t\t\t\t\t"aria-label": `${t("modelAdvanced")} ${index + 1}`,',
].join('\n');
const MODEL_IMAGE_GENERIC_INSERT = [
  '\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(ModelImageInputSwitch, {',
  '\t\t\t\t\t\t\t\t\tmodel,',
  '\t\t\t\t\t\t\t\t\tindex,',
  '\t\t\t\t\t\t\t\t\tt,',
  '\t\t\t\t\t\t\t\t\tdisabled,',
  '\t\t\t\t\t\t\t\t\tonChange: (input) => {',
  '\t\t\t\t\t\t\t\t\t\tpatch(index, { input });',
  '\t\t\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\t\t}),',
  MODEL_IMAGE_GENERIC_ANCHOR,
].join('\n');

function modelImageSwitchCssV1(prefix: string): string {
  return [
    `.${prefix}_modelImageSwitch{height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:5px;padding:0 4px;font-size:11px;line-height:18px;display:inline-flex;white-space:nowrap;/*${MODEL_IMAGE_INPUT_MARKER_V1}*/}`,
    `.${prefix}_modelImageSwitch:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
    `.${prefix}_modelImageSwitch:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}`,
    `.${prefix}_modelImageSwitch:disabled{cursor:default;opacity:.4}`,
    `.${prefix}_modelImageSwitchOn{color:var(--dsw-alias-label-primary)}`,
    `.${prefix}_modelImageLabel{display:inline}`,
    `.${prefix}_modelImageTrack{background:var(--dsw-alias-border-l3);border-radius:8px;flex:none;width:28px;height:16px;padding:2px;display:block}`,
    `.${prefix}_modelImageThumb{background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:12px;height:12px;transition:transform .12s;display:block}`,
    `.${prefix}_modelImageSwitchOn .${prefix}_modelImageTrack{background:var(--dsw-alias-brand-primary)}`,
    `.${prefix}_modelImageSwitchOn .${prefix}_modelImageThumb{transform:translate(12px)}`,
    `@media (max-width:760px){.${prefix}_modelImageLabel{display:none}.${prefix}_modelImageSwitch{padding:0 2px}}`,
  ].join('');
}

function modelImageSwitchCss(prefix: string): string {
  const active = 'var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary))';
  return [
    `.${prefix}_modelImageSwitch{box-sizing:border-box;width:34px;height:28px;cursor:pointer;background:transparent;border:0;border-radius:6px;justify-content:center;align-items:center;padding:0 2px;display:inline-flex;/*${MODEL_IMAGE_INPUT_MARKER}*/}`,
    `.${prefix}_modelImageSwitch:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
    `.${prefix}_modelImageSwitch:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}`,
    `.${prefix}_modelImageSwitch:disabled{cursor:default;opacity:.4}`,
    `.${prefix}_modelImageTrack{box-sizing:border-box;background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;flex:none;width:30px;height:16px;transition:background-color .12s,border-color .12s;display:block;position:relative}`,
    `.${prefix}_modelImageThumb{background:var(--dsw-alias-label-tertiary);border-radius:50%;width:10px;height:10px;transition:background-color .12s,transform .12s;display:block;position:absolute;top:2px;left:2px}`,
    `.${prefix}_modelImageSwitchOn .${prefix}_modelImageTrack{background:${active};border-color:${active}}`,
    `.${prefix}_modelImageSwitchOn .${prefix}_modelImageThumb{background:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-layer-1));transform:translate(14px)}`,
    `@media (prefers-reduced-motion:reduce){.${prefix}_modelImageTrack,.${prefix}_modelImageThumb{transition:none}}`,
  ].join('');
}

function upgradeModelImageInputSource(source: string): string | undefined {
  const prefixMatch = new RegExp(
    `\\.([A-Za-z0-9_-]+)_modelImageSwitch\\{[^}]*\\/\\*${MODEL_IMAGE_INPUT_MARKER_V1}\\*\\/\\}`,
  ).exec(source);
  const prefix = prefixMatch?.[1];
  if (!prefix) return undefined;
  const oldCss = modelImageSwitchCssV1(prefix);
  const oldLabelMapping = `\n\t\t\t"modelImageLabel": "${prefix}_modelImageLabel",`;
  if (!source.includes(oldCss) || !source.includes(MODEL_IMAGE_HELPER_V1)) return undefined;
  return source
    .replace(oldCss, modelImageSwitchCss(prefix))
    .replace(oldLabelMapping, '')
    .replace(MODEL_IMAGE_HELPER_V1, MODEL_IMAGE_HELPER);
}

function patchModelImageInputSource(source: string): string | undefined {
  if (source.includes(MODEL_IMAGE_INPUT_MARKER)) return source;
  if (source.includes(`/*${MODEL_IMAGE_INPUT_MARKER_V1}*/`)) {
    return upgradeModelImageInputSource(source);
  }
  const cssMatch = MODEL_IMAGE_ROW_CSS_RE.exec(source);
  if (!cssMatch) return undefined;
  const prefix = cssMatch[1];
  if (!prefix) return undefined;
  const mappingAnchor = `\t\t\t"modelRow": "${prefix}_modelRow",`;
  const enAnchor = '\t\t\tmodelName: "Display name",';
  const zhAnchor = '\t\t\tmodelName: "显示名称",';
  const anchors = [
    MODEL_IMAGE_HELPER_ANCHOR,
    mappingAnchor,
    MODEL_IMAGE_DEEPSEEK_ANCHOR,
    MODEL_IMAGE_GENERIC_ANCHOR,
    enAnchor,
    zhAnchor,
  ];
  if (anchors.some((anchor) => !source.includes(anchor))) return undefined;

  const rowCss = cssMatch[0].replace(
    'auto auto;align-items',
    'auto auto auto;align-items',
  );
  const mappings = [
    mappingAnchor,
    `\t\t\t"modelImageSwitch": "${prefix}_modelImageSwitch",`,
    `\t\t\t"modelImageSwitchOn": "${prefix}_modelImageSwitchOn",`,
    `\t\t\t"modelImageThumb": "${prefix}_modelImageThumb",`,
    `\t\t\t"modelImageTrack": "${prefix}_modelImageTrack",`,
  ].join('\n');

  return source
    .replace(cssMatch[0], rowCss + modelImageSwitchCss(prefix))
    .replace(mappingAnchor, mappings)
    .replace(MODEL_IMAGE_HELPER_ANCHOR, MODEL_IMAGE_HELPER)
    .replace(MODEL_IMAGE_DEEPSEEK_ANCHOR, MODEL_IMAGE_DEEPSEEK_INSERT)
    .replace(MODEL_IMAGE_GENERIC_ANCHOR, MODEL_IMAGE_GENERIC_INSERT)
    .replace(
      enAnchor,
      `${enAnchor}\n\t\t\tmodelImageInput: "Image input",\n\t\t\tmodelImageInputHint: "Enable only when both the model and gateway support image input.",`,
    )
    .replace(
      zhAnchor,
      `${zhAnchor}\n\t\t\tmodelImageInput: "图片输入",\n\t\t\tmodelImageInputHint: "仅在模型及接口均支持图片输入时开启。",`,
    );
}

function patchModelImageInputToggle(targetFile = MODEL_SETTINGS_FILE): boolean {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-deps] dsh-client-ui-settings-models 不存在，跳过');
    return false;
  }
  const source = fs.readFileSync(targetFile, 'utf8');
  const patched = patchModelImageInputSource(source);
  if (patched === source) {
    console.log('[patch-deps] 模型图片输入开关补丁已应用，跳过');
    return true;
  }
  if (patched === undefined) {
    console.log('[patch-deps] 模型图片输入开关锚点未命中（上游版本可能已更新），跳过');
    return false;
  }
  writeFileAtomic(targetFile, patched);
  console.log('[patch-deps] 已补丁 settings-models：每个模型可独立声明原生图片输入');
  return true;
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
    writeFileAtomic(file, src);
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
  writeFileAtomic(target, src);
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
// 0.1.2-alpha.1 产物形态（压缩变量名变为 d/Pe/fe； submenu 项才有 fe.label）。
const SUBMENU_BTN_ANCHOR_012 = 'd.jsxs("button",{type:"button",role:"menuitem",className:Pe.item,disabled:fe.disabled';
const SUBMENU_BTN_NEW_012 = 'd.jsxs("button",{type:"button",role:"menuitem",className:Pe.item,style:{alignItems:"flex-start",flexShrink:0},disabled:fe.disabled';
const SUBMENU_LABEL_ANCHOR_012 = 'd.jsx("span",{className:Pe.itemLabel,children:fe.label})';
const SUBMENU_LABEL_NEW_012 = 'd.jsx("span",{className:Pe.itemLabel,style:{whiteSpace:"normal",overflow:"visible","' + SUBMENU_ITEM_MARKER + '":"1"},children:fe.label})';

// Menu 二级菜单容器补丁（变量名捕获版）：上游两代压缩产物里 renderEntry 的
// 入口行变量与 submenu-id setter 变量名不同 —— rc.2 用 B/z，0.1.2-alpha.1 用
// $/J。旧补丁把 B/z 写死拼进重建的容器，0.1.2 里 B 是列表 ref（B.submenu 为
// undefined）：鼠标一悬停挂载二级菜单就 undefined.map 抛错，错误边界卸载整个
// conversation.hero.agentPreset slot —— 菜单连同「标准模式」字样一起消失
//（issue #295 / #297）。入口与 setter 一律从 itemWrap 锚点正则捕获；已打过
// 旧补丁的包走修复分支（rc.2 包捕获即 B/z，修复为无操作，天然幂等）。
// itemWrap 头必须 enter/leave 成对出现且 setter 一致（反向引用锁死）：
// 0.1.2 为 J(re?$.id:null) / J(null)；rc.2 为 z(se?B.id:null) / z(null)。
// 配对写法让已注入 div 自带的 z(B.id)/z(null) 永远匹配不上，不会污染捕获。
const MENU_PAIR_RE = /onMouseEnter:\(\)=>\{(?:clearTimeout\(window\.__dshMenuTimer\);)?([A-Za-z_$][\w$]*)\((?:re|se)\?([A-Za-z_$][\w$]*)\.id:null\)\},onMouseLeave:\(\)=>\{(?:clearTimeout\(window\.__dshMenuTimer\);)?(?:window\.__dshMenuTimer=setTimeout\(\(\)=>)?\1\(null\)/g;

// 在 anchorIdx 之前的临近 scope 里抓最近一对（entry, setter）。
function captureMenuVars(src: string, anchorIdx: number): { entry: string; setter: string } | undefined {
  const scope = src.slice(Math.max(0, anchorIdx - 3000), anchorIdx);
  MENU_PAIR_RE.lastIndex = 0;
  let m: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((m = MENU_PAIR_RE.exec(scope)) !== null) last = m;
  if (!last) return undefined;
  return { entry: last[2], setter: last[1] };
}

function patchMenuSubmenuContainerSource(source: string): string | undefined {
  const markerIdx = source.indexOf(MENU_SUBMENU_HOVER_MARKER);
  if (markerIdx >= 0) {
    // 修复分支：容器已被旧补丁重建，把写死的变量改回捕获值。
    const vars = captureMenuVars(source, markerIdx);
    if (!vars) return undefined;
    const divStart = source.lastIndexOf('role:"menu",', markerIdx);
    const mapIdx = source.indexOf(MENU_SUBMENU_ANCHOR, markerIdx);
    if (divStart < 0 || mapIdx < 0 || markerIdx - divStart > 800 || mapIdx - divStart > 2000) return undefined;
    const head = source.slice(0, divStart);
    let div = source.slice(divStart, mapIdx);
    const tail = source.slice(mapIdx);
    div = div.replace(
      /onMouseEnter:\(\)=>\{clearTimeout\(window\.__dshMenuTimer\);[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.id\)\}/,
      'onMouseEnter:()=>{clearTimeout(window.__dshMenuTimer);' + vars.setter + '(' + vars.entry + '.id)}');
    div = div.replace(
      /window\.__dshMenuTimer=setTimeout\(\(\)=>[A-Za-z_$][\w$]*\(null\),400\)/,
      'window.__dshMenuTimer=setTimeout(()=>'+vars.setter+'(null),400)');
    div = div.replace(/children:[A-Za-z_$][\w$]*\./, 'children:' + vars.entry + '.');
    return head + div + tail;
  }
  // 新打分支：上游原始形态。
  if (source.includes('minWidth:' + MENU_SUBMENU_MINW)) return source;
  const submenuIdx = source.indexOf(MENU_SUBMENU_ANCHOR);
  const roleIdx = submenuIdx >= 0 ? source.lastIndexOf('role:"menu",', submenuIdx) : -1;
  // role:"menu", 必须紧邻 submenu.map（submenu 容器的 role），距离过大说明命中了别处
  if (submenuIdx < 0 || roleIdx < 0 || submenuIdx - roleIdx > 400) return undefined;
  const vars = captureMenuVars(source, submenuIdx);
  if (!vars) return undefined;
  // 校验 children: 后的入口变量与捕获一致，防止 role 锚点命中别处。
  const childM = MENU_CHILDREN_RE.exec(source.slice(roleIdx, submenuIdx + 40));
  if (!childM || childM[1] !== vars.entry) return undefined;
  const newBlock = 'role:"menu",onMouseEnter:()=>{clearTimeout(window.__dshMenuTimer);' + vars.setter + '(' + vars.entry + '.id)},'
    + 'onMouseLeave:()=>{clearTimeout(window.__dshMenuTimer);window.__dshMenuTimer=setTimeout(()=>'+vars.setter+'(null),400)},'
    + 'style:{maxHeight:"' + MENU_SUBMENU_MAXH + '",overflowY:"auto",minWidth:' + MENU_SUBMENU_MINW + '},/*' + MENU_SUBMENU_HOVER_MARKER + '*/children:' + vars.entry + '.';
  return source.slice(0, roleIdx) + newBlock + source.slice(submenuIdx);
}

const MENU_CHILDREN_RE = /children:([A-Za-z_$][\w$]*)\.submenu\.map\(/;

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

  // 1) submenu 容器：悬停保持 + 高度/宽度自适应（变量名捕获版，见上）。
  const container = patchMenuSubmenuContainerSource(src);
  if (container === undefined) {
    console.log('[patch-deps] Menu submenu 未匹配到目标代码（版本可能已更新），跳过');
    return false;
  }
  if (container !== src) {
    src = container;
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
    // 双候选：rc.2（Re/he/f）与 0.1.2（Pe/fe/d）两代产物形态。
    const use012 = src.includes(SUBMENU_BTN_ANCHOR_012) && src.includes(SUBMENU_LABEL_ANCHOR_012);
    const btnAnchor = use012 ? SUBMENU_BTN_ANCHOR_012 : SUBMENU_BTN_ANCHOR;
    const btnNew = use012 ? SUBMENU_BTN_NEW_012 : SUBMENU_BTN_NEW;
    const labelAnchor = use012 ? SUBMENU_LABEL_ANCHOR_012 : SUBMENU_LABEL_ANCHOR;
    const labelNew = use012 ? SUBMENU_LABEL_NEW_012 : SUBMENU_LABEL_NEW;
    const btnIdx = src.indexOf(btnAnchor);
    const labelIdx = btnIdx >= 0 ? src.indexOf(labelAnchor, btnIdx) : -1;
    if (btnIdx < 0 || labelIdx < 0) {
      console.log('[patch-deps] Menu submenu item 未匹配到目标代码（版本可能已更新），跳过');
    } else {
      src = src.slice(0, btnIdx) + btnNew + src.slice(btnIdx + btnAnchor.length);
      const l2 = src.indexOf(labelAnchor, btnIdx);
      src = src.slice(0, l2) + labelNew + src.slice(l2 + labelAnchor.length);
      changed = true;
      console.log('[patch-deps] 已补丁主 bundle：submenu 项两行布局不再被裁剪');
    }
  }
  if (changed) writeFileAtomic(target, src);
  return true;
}

// client-modules 解析签名恢复：上游 0.1.2 已正确区分 Node 24 v2
// (parentURL, { specifier, attributes }) 与 Node 22 v1 的位置参数。旧版
// patch-deps 误把两者统一成位置参数，导致 Node 24 把包名当 URL 后静默清空
// boot graph。这里只修复已经被旧补丁改坏的安装树；上游原始实现保持不动。
const CLIENT_MODULES_RESOLVE_TARGET = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js');
const CLIENT_MODULES_RESOLVE_EXPECTED = 'internal.version === "v2" ? internal.resolveSync(baseUrl, {\n\t\t\t\tspecifier: loaderName,\n\t\t\t\tattributes: {}\n\t\t\t}).url : internal.resolveSync(loaderName, baseUrl, {}).url';
const CLIENT_MODULES_RESOLVE_REVERSED = 'internal.resolveSync(loaderName, baseUrl, {}).url';
const CLIENT_MODULES_RESOLVE_PARENT_FIRST = 'internal.resolveSync(baseUrl, loaderName, {}).url';

function patchClientModulesResolve(targetFile = CLIENT_MODULES_RESOLVE_TARGET): boolean {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-deps] dsh-client-modules 不存在，跳过');
    return false;
  }
  let src = fs.readFileSync(targetFile, 'utf8');
  if (src.includes(CLIENT_MODULES_RESOLVE_EXPECTED)) {
    console.log('[patch-deps] client-modules Node 22/24 解析签名正确，跳过');
    return false;
  }
  if (src.includes(CLIENT_MODULES_RESOLVE_REVERSED)) {
    src = src.replace(CLIENT_MODULES_RESOLVE_REVERSED, CLIENT_MODULES_RESOLVE_EXPECTED);
  } else if (src.includes(CLIENT_MODULES_RESOLVE_PARENT_FIRST)) {
    src = src.replace(CLIENT_MODULES_RESOLVE_PARENT_FIRST, CLIENT_MODULES_RESOLVE_EXPECTED);
  } else {
    console.log('[patch-deps] client-modules 解析签名锚点未命中（上游可能已更新），跳过');
    return false;
  }
  writeFileAtomic(targetFile, src);
  console.log('[patch-deps] 已恢复 client-modules Node 22/24 分支解析签名（boot graph 清零修复）');
  return true;
}

function main(): void {
  patchPickerWorker();
  patchSettingsNavScroll();
  patchSettingsPanelResize();
  patchSettingsWriteFailure();
  patchModelImageInputToggle();
  patchOptionalEscalationFields();
  patchAgentPresetMenu();
  patchMenuSubmenuScroll();
  patchClientModulesResolve();
}

// 单测 require 本模块时不应改写真实 node_modules；仅命令行直接执行时跑 main()。
if (require.main === module) {
  main();
}

module.exports = {
  patchAgentPresetMenu,
  patchMenuSubmenuScroll,
  patchMenuSubmenuContainerSource,
  patchClientModulesResolve,
  patchModelImageInputSource,
  patchModelImageInputToggle,
  patchSettingsWriteFailureSource,
  patchSettingsWriteFailure,
};
