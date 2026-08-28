// DSH Desktop 配套浮窗（宿主侧）：
// 浮窗功能核心在浏览器端（client.js）+ Electron 壳层（main.js/preload.js），
// 宿主侧只做最轻量的声明，确保插件被 cordis 注册即可。

const name = "dsh-float-window";
const inject = []; // 无宿主侧服务依赖

function apply(_ctx) {
  // 所有逻辑在 browser-side client.js 和 Electron 壳层完成。
  return () => {};
}

export { apply, inject, name };