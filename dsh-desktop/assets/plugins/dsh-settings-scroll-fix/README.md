# dsh-settings-scroll-fix

独立的 DSH 设置页滚动修复插件。此源码版本不会自动安装到本机 profile。

## 设计

- 不依赖 CSS Modules 生成的版本哈希类名。
- 仅在识别到设置界面后检查真实溢出的导航和内容区域。
- 用属性标记施加 `overflow-y: auto` 和 `min-height: 0`。
- 在原生滚动链失效时，通过捕获阶段的非被动 wheel 监听把滚轮增量交给目标区域。
- 使用 MutationObserver 适配设置页切换和动态插件内容。
- 卸载时移除样式、DOM 标记、观察器、事件监听和全局状态。

## 构建与测试

```powershell
npm run build
npm test
```

插件没有第三方运行时依赖。

## 安装

构建后可通过 DSH 插件命令安装本目录，或把项目复制到 profile 的
`node_modules/dsh-settings-scroll-fix` 并应用 `cordis.patch.yml`。

本项目当前只保存源码，没有安装到 DSHEAC。
