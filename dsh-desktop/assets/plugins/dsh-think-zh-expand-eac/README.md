# dsh-think-zh-expand-eac

[![topic: dsh](https://img.shields.io/badge/插件生态-topic%20dsh-4d6bfe)](https://github.com/topics/dsh)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**DSH 思考增强插件（EAC 定制版）**：让 agent 的思考（reasoning）与回复强制使用中文，并把界面残留的硬编码英文（Thinking / Tool Call 等）中文化。

> **本仓库是派生版本（fork），已移除全部会接管对话渲染器的显示功能。**

## 引用与来源声明

本仓库派生自 **[baosfeng/my-dsh-plugins](https://github.com/baosfeng/my-dsh-plugins)** 中的
[`plugins/dsh-think-zh-expand`](https://github.com/baosfeng/my-dsh-plugins/tree/main/plugins/dsh-think-zh-expand)，
原作者：**[@baosfeng](https://github.com/baosfeng)**，许可证 MIT。

- **上游版本**：`dsh-think-zh-expand@0.4.8`
- **本派生版本**：`dsh-think-zh-expand-eac@1.0.0`
- **上游许可证**：[MIT](./LICENSE)（原样保留，版权归原作者）

本版仅按需裁剪上游的显示层功能，**未修改**上游的强制中文提示词与中文化词表逻辑。
若你需要上游的完整功能（思考块默认展开、自绘渲染器），请直接使用
[上游插件](https://github.com/baosfeng/my-dsh-plugins)。

## 为什么会有这个 EAC 版

上游 `dsh-think-zh-expand` 会用 `priority: -1` **接手** `conversation.chat.node` 的
`assistant-step` 渲染器，自行绘制思考块（默认展开、流式强制展开）。

这会与**任何折叠类插件**发生结构性冲突：

| 折叠插件 | 冲突原因 |
|---|---|
| `dsh-turn-fold` | 同样以 `priority: -1` 抢占 `assistant-step` 座位，两者只能有一个生效 |
| `dsh-auto-collapse` | 依赖 DOM 锚点 `data-chat-flow-key` / `data-turn-process` 定位折叠目标，而上游自绘的思考块**不产生这些锚点**，导致其折叠逻辑对该段失明 |

结果是：装了折叠插件却「思考收不起来」或折叠栏失效，且不报错——属于静默失效，很难排查。

**本版的做法**：把渲染器**完全交还宿主**，只保留不碰 DOM 结构的功能。思考块的折叠表现
由宿主与折叠插件决定，本版不再干预。

## 功能

### 1. 思考强制中文（Server 端）✅ 保留

通过 `systemPrompt.section` 注入一条固定系统提示（`order: -90`，persona 之前最先读到），
内容为**结构化语言规则**（最高优先级，不可被上下文覆盖）：

> 强制要求：思考过程（reasoning）必须用简体中文书写；最终回复默认简体中文（跟随用户语言）。
> 关键场景：英文错误消息/日志/堆栈不改变语言；大量英文上下文不"带偏"输出。
> 代码与术语：代码、命令、文件路径、标识符与技术术语保持原文，不翻译。

无论用户用什么语言提问，模型的思考过程与回答都使用中文。

### 2. 界面标签中文化（Client 端）✅ 保留

官方 UI 的 zh 字典本身未翻译完（如 `toolbar.duration: "Duration"`），且存在硬编码英文
（`Thinking`、`Tool Call`、`ASSISTANT` 等）；`locale.register` 对已注册的同名 ns+locale
字典重复注册会抛错，无法经 locale 服务补译。

因此本插件在 **DOM 层做精准文本替换**：只匹配「完全等于」词表的叶子文本节点
（排除 `pre`/`code`/输入区，避免误伤代码块与消息正文），`MutationObserver` 跟随 React
重渲染持续生效。同时覆盖工具名、工具描述、工具目录与卡片标题/摘要的中文化。

> 该功能**不改变 DOM 结构**，只改写文本节点内容，因此不与折叠插件冲突。

## 与上游的差异（已移除的功能）

以下功能**全部移除**，因为它们要么直接抢位、要么产出折叠插件无法识别的 DOM：

| 已移除 | 说明 |
|---|---|
| `assistant-step` 渲染器注册 | 上游以 `priority: -1` 抢占 `conversation.chat.node` 座位 |
| `ThinkBlock` | 上游自绘思考块（默认展开、流式强制展开） |
| `AssistantStepView` / `renderBlocks` / `imageGroupEnd` | 上游自绘的 assistant 节点与图片分组渲染 |
| `stripControlTags` | 仅供上述渲染器使用的控制标签剥离 |
| 官方 SVG 图标内联（`chevronDownIcon` / `thinkIcon`） | 仅供上述思考块使用 |
| `.dsh-think-zh-expand-*` 样式表 | 仅供上述思考块使用 |
| `dsh-md-render` 跨插件依赖 | 上游经 `dsh.client.external` require 其 `MarkdownView` |

### 行为差异

| 场景 | 上游 | 本版 |
|---|---|---|
| 思考块默认状态 | 展开 | **交还宿主**（通常为收起单行摘要） |
| 流式中思考块 | 强制展开 | 交还宿主 |
| 思考内容 Markdown 渲染 | 由本插件经 MarkdownView 渲染 | 由宿主内置渲染 |
| 工具调用行 | 上游自绘 | 交还宿主（丢失上游的部分自绘样式） |
| 与折叠插件共存 | ❌ 冲突 | ✅ 无冲突 |

### 兼用性说明（section 名已改名）

上游注册的 system-prompt section 名为 `dsh-think-zh`，本版改为 **`dsh-think-zh-eac`**。

原因：DSH 对**同一层重复 name 的 section 注册会抛错**。改名后，上游版与本版即使同时启用
也不会导致启动失败。但两者注入的是同一段中文指令，**功能完全重复，仍建议只启用其一**。

## 安装

### DSH Desktop (EAC)

在 DSH Terminal 中针对当前 profile 安装：

```powershell
dsh plugin --profile web-desktop add github:jing-hy/dsh-think-zh-expand-eac
dsh --profile web-desktop --dump-config
pnpm list dsh-think-zh-expand-eac --depth 0
```

配置输出应包含 `id: think-zh-expand-eac` 与 `name: dsh-think-zh-expand-eac`。
验证后重启 DSH Desktop。

### 普通 DSH CLI / Web

```sh
dsh plugin --profile web add github:jing-hy/dsh-think-zh-expand-eac
dsh --profile web --dump-config
```

### 从源码安装

```powershell
git clone https://github.com/jing-hy/dsh-think-zh-expand-eac.git
dsh plugin --profile web-desktop add link:<仓库路径>
```

## 与折叠插件一起使用

本版设计目标就是**与折叠插件共存**。推荐组合：

```powershell
dsh plugin --profile web-desktop add dsh-auto-collapse   # 或 dsh-turn-fold
dsh plugin --profile web-desktop add github:jing-hy/dsh-think-zh-expand-eac
```

**不要同时启用** `dsh-auto-collapse` 与 `dsh-turn-fold`——它们都通过 DOM/渲染器操作对话区，
机制互相致盲。二选一。

## 开发

```powershell
npm run typecheck   # tsc 类型检查（server + client 两份配置）
npm run build       # 重新生成 lib/index.js 与 lib/client.js
npm test            # host 端冒烟测试（Node 内置 test runner）
```

> `lib/client.js` 是构建产物，**必须提交**——DSH 直接提供该文件，不在安装时构建。
> 修改 `src/client/index.ts` 后务必重新构建并提交产物。

### 构建流程

1. `tsc -p tsconfig.json` → `lib/index.js`（server 端）
2. `tsc -p tsconfig.client.json` → `lib/.client-build/index.js`（client 端 CommonJS 单文件）
3. `node scripts/build.mjs` 把 client 编译产物注入 `lib/client.src.js` 模板的
   `/*__CLIENT_BUNDLE__*/` 占位符 → `lib/client.js`

> 上游构建还需从 `dsh-shared` 注入共享图标（`/*__PART_ICONS__*/`）。
> **本版已移除该步骤**，`scripts/build.mjs` 会在此占位符残留时直接报错，避免静默产出坏包。

## 目录结构

| 路径 | 职责 |
|---|---|
| `src/index.ts` | server 端：system-prompt section 注册 |
| `src/types.d.ts` | DSH 运行时类型最小契约 |
| `src/client/index.ts` | client 端：界面中文化（词表 + DOM 精准替换） |
| `lib/index.js` | server 端构建产物（提交） |
| `lib/client.js` | client 端构建产物（提交，DSH 实际提供） |
| `lib/client.src.js` | client bundle 模板（含 `__CLIENT_BUNDLE__` 占位符） |
| `scripts/build.mjs` | 构建脚本：编译 + 注入模板 |
| `cordis.patch.yml` | bundle patch：把插件行挂载进 profile |
| `test/host-smoke.mjs` | host 端冒烟测试 |

## 许可证

MIT。本仓库保留上游 [MIT 许可证](./LICENSE) 与版权声明。

上游项目：[baosfeng/my-dsh-plugins](https://github.com/baosfeng/my-dsh-plugins) · 原作者 [@baosfeng](https://github.com/baosfeng)
