/**
 * dsh-viewport-lock — browser half: 视口钳制（文档级滚动根治）。
 *
 * 背景（老毛病：hero 输入卡底部被裁 + 窗口出现横/纵双滚动条）：
 *   - 内核视口链 html,body,#root{height:100%} 本身干净，但 html/body 无任何
 *     overflow 钳制；hero 态 scrollBody 用 justify-content:center 居中内容，
 *     内容高于视口时溢出会沿包含链一路漏到文档层，出现文档级滚动条，
 *     且 flex 居中溢出的上/下两端都可能滚不到（经典 flexbox centering 陷阱）。
 *   - 旧修复（壳 sidecar bridge 注入的 CSS）锚定 CSS Modules 哈希类
 *     （.wSkVaW_* 等），内核前端更新换哈希即静默失效；且只在桌面壳 WebView
 *     注入 —— 浏览器打开、手机端、垫片未生效的桌面会话全部裸奔。
 *
 * 根治思路：把修复放进内核页面本身（本插件随任意客户端加载），且只锚定
 * 稳定契约（data-* 属性与元素 id，非构建哈希）：
 *   1. 文档级滚动钳制 —— html/body overflow:hidden。内核全部滚动面
 *      （会话流 scrollBody、侧边栏、设置页、弹层内部）都是内部滚动容器，
 *      文档滚动条从来不是任何功能的载体；钳死文档层不影响任何交互，
 *      仅消灭「文档被撑出滚动条」这一整类症状。打印场景除外（print 媒体
 *      下还原，避免打印被裁）。
 *   2. hero 居中兜底 —— 与壳垫片同语义、改锚稳定契约
 *      [data-phase="hero"] [data-conversation-scroll]（滚动容器自带属性，
 *      非哈希）：放得下时 margin-block:auto 依旧视觉居中，放不下时从顶
 *      排布、scrollBody 自身可滚，输入卡永远可达。
 *
 * 契约：client bundle 的 factory 返回 { inject, apply }，浏览器端 cordis
 * runner 会调用 apply(ctx)（同 dsh-file-drop-eac 的最小形状）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-viewport-lock',
  factory: function (require) {
    var inject = [];

    var CSS = [
      // 1) 文档级滚动钳制：app 外壳永不出滚动条（内核所有滚动面均为内部容器）。
      'html, body{overflow:hidden!important;height:100%!important}',
      // 2) hero 居中兜底（稳定契约；与壳垫片同语义）：内容高于视口时从顶排布
      //    且 scrollBody 自身可滚，flex 居中溢出导致的「上/下都滚不到」消失。
      'html [data-phase="hero"] [data-conversation-scroll]{justify-content:flex-start!important}',
      'html [data-phase="hero"] [data-conversation-scroll] > *{margin-block:auto!important}',
      // 3) 打印还原：overflow 钳制只服务屏幕 app 外壳，打印需要文档流。
      '@media print{html, body{overflow:visible!important;height:auto!important}}',
    ].join('');

    var STYLE_ID = 'dsh-viewport-lock';

    function injectStyle() {
      if (typeof document === 'undefined') return;
      var existing = document.getElementById(STYLE_ID);
      if (existing) {
        // 被皮肤/热重载移除后补挂（同 font-custom 的兜底策略）。
        if (!document.head.contains(existing)) document.head.appendChild(existing);
        return;
      }
      var tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function apply() {
      injectStyle();
      // 首挂时机竞态兜底：apply 可能在 body 就绪前执行，readyState 变化后补一次；幂等。
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectStyle, { once: true });
      }
    }

    var module = { exports: {} };
    module.exports = { inject: inject, apply: apply };
    return module.exports;
  },
});
