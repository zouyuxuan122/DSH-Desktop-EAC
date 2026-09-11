/**
 * dsh-think-zh-expand-eac — client half (browser).
 *
 * 功能 2：界面标签中文化（唯一保留的功能）。
 *
 * EAC 定制：已移除渲染器替换与思考块渲染，因此不再需要 react、
 * dsh-md-render(MarkdownView) 与 dsh-shared 共享图标。
 *
 * BUILD NOTE: 本文件是源码模板（骨架）。scripts/build.mjs 先 tsc 编译
 * src/client/index.ts → lib/.client-build/index.js（CommonJS 单文件），
 * 再把编译产物注入到下方 /*__CLIENT_BUNDLE__* / 占位符处并写出
 * lib/client.js（DSH 实际提供的产物，单一 __ModuleLoader__ bundle，无相对
 * 路径 require）。产物必须提交（CI 只跑 node --check + 测试，不跑构建）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-think-zh-expand-eac',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ── Client bundle（编译自 src/client/index.ts）──────────────────
    /*__CLIENT_BUNDLE__*/

    return module.exports
  },
})
