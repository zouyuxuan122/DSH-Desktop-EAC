# DSH Composer Dynamic Island

[English](README.md) | **简体中文**

将选定的 DeepSeek Harness Web 输入区控件收纳到一个紧凑、向上展开的灵动岛中，不移动控件的 DOM 节点，也不修改宿主 React 树。

[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) · 一个 DeepSeek Harness 生态插件。

## 兼容性边界

本包有意将以下两层实现分开：

- `src/index.ts`（发布为 `lib/types/index.js`）与 `dsh-plugin.json` 构成一个无界面的 Community v0.15 `host` facet。它不需要契约、权限、凭据、浏览器或 GUI。
- `lib/client.js` 是可选的 DSH Web 兼容适配器。Community v0.15 尚未定义 `client` facet，因此该适配器不会被声明为 `client` facet，也不宣称具备跨宿主 UI 一致性。

确切边界见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)。

## Web 端行为

适配器会检测当前 DSH 输入区或 Composer 表面中的控件，并允许用户选择将哪些控件收纳进向上展开的灵动岛。它能够发现：

- `conversation.input.left`、`conversation.input.right` 和 `conversation.input.model` 中的原生控件与贡献项；
- 后续新增的 `conversation.input.*` 或 `composer.*` 槽位中的按钮型贡献；
- 通过 `data-plugin`、`data-plugin-id`、`data-extension`、`data-extension-id` 或 `data-contribution` 标记的嵌套按钮贡献；
- 已确认 Composer 工具栏中的无标记按钮，作为可手动选择的集成项。

发现范围始终限制在已确认的输入区或 Composer 表面内。文本/搜索输入框、`textarea`、`contenteditable` 区域和 ARIA 文本框永远不会被收纳，即使它们带有插件标记。Composer 之外的搜索、设置和普通表单控件不会被扫描。

默认收起左侧插件控件和 WebUI 团队模式选择器。原生工具、权限控件、模型控件以及发送/停止按钮保持原位。现有控件仍由原来的 React 父节点管理；适配器只修改展示属性与样式，不会把节点移动到其他父节点。

打开 DSH 设置并选择“输入灵动岛”，即可调整检测到的控件。选择会立即生效并保存在浏览器本地存储中。鼠标悬停或键盘聚焦三点按钮时打开灵动岛；在触摸设备上可点击固定；移开后关闭；按 Escape 可关闭并恢复焦点。

在很小的视口中，无法安全放入面板的已选控件会保留在原工具栏位置。由于适配器保持 React 原有节点归属，键盘与读屏顺序仍遵循原始 DOM 顺序，而不是灵动岛中的视觉排列。

本插件有意**不提供**拖放、坐标存储或其他面向用户的按钮位置编辑功能。面板定位仅用于在固定的输入区触发按钮旁渲染灵动岛。

## 安装

当前版本通过 GitHub 分发：

```sh
dsh plugin add github:says693/dsh-composer-dynamic-island
```

也可以把 `dsh-composer-dynamic-island` 添加到目标 Profile 并启用其 Bundle。`cordis.patch.yml` 包含可移植的 Cordis 配置行。如果 DSH Web 插槽服务或输入区界面不可用，则浏览器适配器不属于受支持目标，而 `host` facet 将保持无操作状态。

## 数据与权限

- 声明的 Community v0.15 权限：无。
- 网络请求：无。
- 文件系统访问：无。
- 浏览器存储：仅保存是否已配置，以及被选入灵动岛的控件标识。
- 不读取或存储对话内容、模型提供方设置、API 密钥或凭据。

适配器下次加载时，会清除旧版本存储的布局坐标和控件标签缓存。

## 卸载

从 Profile 的 Bundle 和依赖中移除 `dsh-composer-dynamic-island`，然后重启 DSH。浏览器设置默认保留；如需一并清除，请删除站点本地存储键：

```text
dsh-composer-dynamic-island-config-v1
```

## 开发

需要 Node.js `^22.19 || >=24` 和 pnpm 10。

包根遵循 dsh-TUI `plugin-template` 契约：无默认导出，并完整导出 `name`、带类型的 `Config` 与 `apply`。可选 DSH Web 适配器仍保持为独立、明确非标准化的客户端层。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm verify
```

## 作者

本插件由 [says693](https://github.com/says693) 独立撰写并维护，无其他撰写者。

## 状态与许可证

Community v0.15 元数据只是社区草案兼容性声明，不代表 DSH 官方认证。可选 Web 适配器必须在每个受支持的 DSH Web 宿主版本上分别测试。

本项目采用 [MIT License](LICENSE) 发布。
