<h1 align="center">navbar</h1>

<p align="center">对话节点导航条：对话区右缘节点串快速跳转 user 消息，悬停预览、点击跳转</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/green" alt="license">
</p>

对话区右缘的等距节点串（每 user 消息一节点）——激活药丸跟随阅读位置、悬停预览卡（6 行截断）、点击平滑滚动 + 品牌蓝高亮环、超过 11 节点自动滑动窗口、平时隐形悬停浮现、少于 2 条 user 消息自动隐藏。实现 dsh-external/issues#144 规格。形态：官方 **bundle 插件**（`dsh.bundle` + dshClient 通道，**纯浏览器端**，Node half 为空），0 patch。

## 效果

![navbar 节点导航条（真实运行截图：右缘节点串 + active 高亮）](docs/preview/navbar.png)

## 能力

| 功能 | 说明 |
|---|---|
| 节点导航条 | 对话区右缘纵向节点串，每 user 消息一个圆点节点 |
| 跟随阅读位置 | 激活药丸（22px 品牌蓝胶囊）随当前阅读位置移动 |
| 悬停预览 | 悬停节点显示消息预览卡（6 行截断，对齐官方 HoverCard 视觉） |
| 连续悬停 | 整条导航条（含节点间隙）连续响应悬停：预览随最近节点切换 + 对应药丸加长（灰色）指示点击落点，无死区 |
| 滚轮切换 | 光标悬停导航条时滚动滚轮：向上滚=上一条、向下滚=下一条（阻止对话区滚动） |
| 点击跳转 | 整条导航条可点（含间隙，按最近节点跳转）+ 药丸命中区放大，无需精确瞄准小圆点 |
| 滑动窗口 | >11 节点时只显示窗口内节点（避免溢出） |
| 自动隐藏 | <2 条 user 消息或非对话页不显示 |
| 消息精选 pin | assistant 操作条（copy 与 Good response 之间）📌 按钮；精选轮次在导航条渲染为金色细长椭圆盘（恒可见、预览卡带 📌 徽标、点击直达被精选的回复），状态按会话持久化 |

零数据通道依赖：只靠官方锚点属性（`data-time-hover-root`，0806 起 user 行）驱动，无轮询、无路由、无工具。

## 安装

**推荐：git 源一行安装**（构建产物已入库，git 源不触发构建）：

```sh
dsh plugin --profile web add "github:vlln/dsh-navbar#main"
```

或本地目录（有源码时）：`git clone` 后 `cd dsh-navbar && dsh plugin --profile web add .`。

装完 **重启 web** 生效；设置页「插件」面板可停用/启用。

## 使用

安装即用，无命令、无工具。对话页（Chat 视图）右缘出现节点条；悬停看预览、点击跳转。`prefers-reduced-motion` 下禁用动画。

**精选 pin**：hover assistant 消息操作条，点 📌 把该回复选为精选——对应轮次的导航节点变为金色细长椭圆盘（点击直达该回复；预览卡显示 📌 徽标与回复文本）。精选状态按会话保存在浏览器 localStorage，刷新后保留；再点一次取消精选。

## 开发

```sh
pnpm install
pnpm run build      # tsdown：client bundle (lib/client.js)
```

- client：`src/client/index.ts`（自渲染 DOM + 官方锚点契约；pin 按钮走官方 `conversation.chat.assistant-actions` 插槽，React 由 client runtime 提供；访问的 ctx 服务须在插件对象 `inject` 中声明）
- Node half：`src/index.mjs`（空 apply，bundle 挂载载体）

## 许可

MIT License（DSH 生态示例插件）。
