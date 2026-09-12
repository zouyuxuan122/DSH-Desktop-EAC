// dsh-stt — client 入口（UI 注入组装）。
// ModuleLoader 注册由构建脚本的 wrapper 提供（见 scripts/build.mjs），
// 本文件只负责 export apply/inject：注册词典与样式、注入三个 slot、
// 启动状态轮询与输入框 placeholder 同步。
import * as React from "react";
import { NS, zh, en } from "./lib/i18n.js";
import { ensureStyles } from "./lib/styles.js";
import { state, refreshStatus } from "./lib/state.js";
import { findComposerTextarea } from "./lib/composer.js";
import { MicButton } from "./components/MicButton.js";
import { ModelGuideBar } from "./components/ModelGuideBar.js";
import { SettingsCard } from "./components/SettingsCard.js";

const h = React.createElement;

export const inject = ["slots", "locale", "settingsScope"];

export function apply(ctx) {
  ensureStyles();
  const t = ctx.locale.bind(NS);
  ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-stt: dictionaries");
  const scope = ctx.settingsScope.bind({ namespace: NS });

  ctx.slots.inject("conversation.input.right", function () {
    return ctx.slots.register({ name: "conversation.input.right", id: "dsh-stt", order: 100 }, MicButton);
  });

  // 模型引导条：挂在输入框 dock 区（占整行，位于麦克风按钮附近）。
  // 模型就绪时组件自身返回 null，不占任何空间。
  ctx.slots.inject("conversation.composer.dock", function () {
    return ctx.slots.register({ name: "conversation.composer.dock", id: "dsh-stt-guide", order: 60 }, ModelGuideBar);
  });

  ctx.slots.inject("settings.section", function () {
    return ctx.slots.register({
      name: "settings.section", id: "dsh-stt", order: 40,
      label: function () { return t("nav"); }, locale: NS,
    }, function (props) {
      return h(SettingsCard, Object.assign({}, props, { scope: scope, t: t }));
    });
  });

  refreshStatus();
  const timer = setInterval(refreshStatus, 5000);
  ctx.effect(function () { return function () { clearInterval(timer); }; }, "dsh-stt: poll");

  // ── 输入框虚字提示（placeholder）────────────────────────
  // 语音识别开启时，把用法提示写进主输入框 placeholder；关闭时恢复原值。
  // 主输入框 textarea 由 dsh 内部渲染（className 哈希不可引用），用「可见
  // textarea」启发式定位；1s 轮询对抗 React 重渲染覆盖 placeholder。
  function composerPlaceholderText() {
    const w = (state.wakeWords || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean).join('、') || '你好';
    return t('placeholder').replace('{w}', w);
  }
  let sttPlaceholderOrig = null;
  function syncComposerPlaceholder() {
    const ta = findComposerTextarea();
    if (!ta) return;
    if (sttPlaceholderOrig === null) sttPlaceholderOrig = ta.getAttribute('placeholder') || '';
    const want = state.micOn ? composerPlaceholderText() : sttPlaceholderOrig;
    if (ta.getAttribute('placeholder') !== want) ta.setAttribute('placeholder', want);
  }
  const placeholderPoll = setInterval(syncComposerPlaceholder, 1000);
  ctx.effect(function () { return function () { clearInterval(placeholderPoll); }; }, "dsh-stt: placeholder");
}
