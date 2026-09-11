# Changelog

本文件记录 **dsh-think-zh-expand-eac** 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **上游来源**：本仓库派生自 [baosfeng/my-dsh-plugins](https://github.com/baosfeng/my-dsh-plugins) 的
> `plugins/dsh-think-zh-expand`（派生基线：`v0.4.8`）。原作者 [@baosfeng](https://github.com/baosfeng)，MIT 许可。
> 上游版本历史请见上游仓库。

## [1.0.0] - 2026-09-11

首个 EAC 定制版本。基于上游 `dsh-think-zh-expand@0.4.8` 裁剪。

### 变更动机

上游以 `priority: -1` 接手 `conversation.chat.node` 的 `assistant-step` 渲染器并自绘思考块
（默认展开、流式强制展开），与折叠类插件产生结构性冲突：

- `dsh-turn-fold` 同样以 `priority: -1` 抢占同一座位 —— 两者只能有一个生效；
- `dsh-auto-collapse` 依赖 DOM 锚点 `data-chat-flow-key` / `data-turn-process` 定位折叠目标，
  而上游自绘的思考块不产生这些锚点 —— 其折叠逻辑对该段静默失明。

表现为「装了折叠插件但思考收不起来」，且不报错，排查困难。

### 移除（BREAKING）

以下显示层功能全部删除，不再接管任何对话渲染器：

- **移除** `conversation.chat.node` 的 `assistant-step` 渲染器注册（原 `priority: -1` 抢位）
- **移除** `ThinkBlock`（默认展开、流式强制展开的思考块）
- **移除** `AssistantStepView`、`renderBlocks`、`renderBlock`、`imageGroupEnd`（自绘 assistant 节点与图片分组）
- **移除** `stripControlTags`（仅供自绘渲染器的控制标签剥离）
- **移除** 官方 SVG 图标内联（`chevronDownIcon`、`thinkIcon`）
- **移除** `.dsh-think-zh-expand-*` 样式表及其注入逻辑
- **移除** 对 `dsh-md-render` 的跨插件依赖（`dsh.client.external` 与 `peerDependencies`）
- **移除** `react` 依赖（client 端不再创建任何元素）

### 保留

- **保留** 思考与回复强制中文（server 端 `systemPrompt.section` 注入，`order: -90`）
- **保留** 界面标签中文化（DOM 精准文本替换 + `MutationObserver`，不改动 DOM 结构）
- **保留** 工具名 / 工具描述 / 工具目录 / 卡片标题摘要的中文化词表

### 变更

- **变更** system-prompt section 名：`dsh-think-zh` → **`dsh-think-zh-eac`**。
  理由：DSH 对同一层重复 name 的 section 注册会抛错；改名后本版可与上游版共存，
  但两者注入同一段指令，功能重复，仍建议只启用其一。
- **变更** 包名：`dsh-think-zh-expand` → **`dsh-think-zh-expand-eac`**
- **变更** client bundle 的 `__ModuleLoader__.load()` id → `dsh-think-zh-expand-eac`
- **变更** 构建流程：不再从 `dsh-shared` 注入共享图标；`scripts/build.mjs` 在
  模板残留 `/*__PART_ICONS__*/` 占位符时**直接报错**，避免静默产出坏包
- **变更** `tsconfig.client.json`：`lib` 增加 `dom.iterable`（中文化代码迭代 `NodeList`）
- **变更** 测试：改用 Node 内置 test runner（`node --test test/`），移除对 vitest 的依赖；
  删除仅适用于上游自绘渲染器的 `test/client-render.mjs` 与 cucumber 特性测试

### 移除的文件

- `vitest.config.mjs`、`stryker.config.mjs`（上游 monorepo 工具链配置）
- `test/client-render.mjs`、`test/features/`（针对已删除渲染器的测试）
- `assets/`（思考块截图，已无对应功能）

### 兼容性

- DSH kernel：`0.1.3-alpha.1`（实测）
- 与 `dsh-auto-collapse`、`dsh-turn-fold` 等折叠类插件**无冲突**（本版不触碰渲染器与 DOM 结构）

### 体积变化

- `lib/client.js`：43.7 KB（上游）→ **18.6 KB**（本版）
- `src/client/index.ts`：32.8 KB（上游）→ **18.2 KB**（本版）
