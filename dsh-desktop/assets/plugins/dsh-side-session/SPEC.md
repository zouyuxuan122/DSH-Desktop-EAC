# SPEC: dsh-side-session — DSH 侧边临时会话插件

> 状态：**草稿 / 待确认**。实现前需要先澄清「第 12 节开放问题」。
> 目标：在 DSH Desktop 复刻 Codex 的「侧边临时会话」能力。

---

## 1. 背景与目标

Codex 等工具提供一个「侧边临时会话」：在不打断主会话的前提下，基于**当前页面**（当前对话 + agent 触及的文件）向 AI 发起追问；AI 的回答只存在于这个临时会话里，不会污染主会话。

本插件在 DeepSeek Harness（dsh）Web UI 内复刻这一能力。

## 2. 术语

- **主会话**：用户正在进行的 dsh 对话（agent 循环所在）。
- **临时会话**：侧边面板内的轻量问答线程。上下文来自主会话的快照，自行维护、可随时清空。
- **上下文**：主会话的对话记录（transcript）+ 主会话中 agent 读/写/改的文件。

## 3. 功能需求

- **F1 捕获上下文**：打开/刷新侧边面板时，自动抓取当前主会话的对话记录 + agent 触及的文件清单（含内容摘要）。
- **F2 侧边面板**：对话界面右侧显示可折叠面板，内含「上下文摘要卡 + 问答线程 + 输入框」。
- **F3 临时提问**：用户在面板输入问题；插件把「上下文 + 问题 + 临时会话历史」发给回答引擎，流式返回答案。
- **F4 不污染主会话**：临时会话的所有交互只发生在面板内，不写入主会话 transcript、不触发主会话的 agent 工具。
- **F5 清空/重置**：一键清空临时会话历史与上下文缓存。

## 4. 非目标（明确不做）

- 不替代主会话的 agent 循环。
- 临时会话内不做任何文件编辑（只读上下文）。
- 临时会话默认不持久化到 dsh 会话日志（当次有效；可选 localStorage 暂存 UI 状态）。

## 5. 架构

```
lib/client.js  浏览器 bundle（window.__ModuleLoader__.load）
   ├─ 渲染右侧固定面板（React，require("react")）
   ├─ ctx.get("sessions").current 取当前 sessionId
   ├─ GET  /api/dsh-side-session/context?sessionId=   → 取上下文
   └─ POST /api/dsh-side-session/ask                  → 提交提问，流式接收

lib/index.js   服务端 cordis 插件（export name/inject/apply）
   ├─ inject: ["sessionProjections","webServer","settings"]
   ├─ sessionProjections.register(...)   折叠事件流 → 上下文
   ├─ webServer.register(...)            暴露 /context 与 /ask（仅回环）
   └─ settings.register(...)             可选：回答引擎配置节

cordis.patch.yml   - insert: [{ id, name: <包名>, config: {} }]
package.json       "dsh": { "client": { "inject": [...ui...], "platform":"web" } }
```

客户端注册沿用现有约定：`window.__ModuleLoader__.load({ id: <包名>, factory })`
内 `require("react")` / `require("react/jsx-runtime")`，通过 `ctx.slots.register`
或 `ctx.effect` 挂载；面板默认用**自绘 fixed 定位 + CSS**（参考
`dsh-conversation-tweaks` 的导航滑轨做法），不依赖 `dsh-better-sidebar` 是否安装。

## 6. 上下文捕获（服务端 projection）

监听 dsh 会话事件流，纯函数折叠（与 `dsh-file-changes` 同思路，对升级稳定）：

- `message/user`、`message/assistant` → transcript（最近 N 条 / 字符上限）。
- `tool/result` + `meta.diffs` → 文件写/改/删（`{path, op, oldText, newText}`），来自 `ctx.fs` 写前锁内全文，可靠。
- `tool/call`（读类工具，如 Read/Grep） → 尽力捕获被读取的文件路径（best-effort，取决于事件词汇表是否暴露路径）。

投影产出：
```ts
{
  sessionId: string,
  title?: string,
  transcript: { role: "user"|"assistant", text: string, t: number }[],
  files: { path: string, op: "create"|"edit"|"delete"|"read",
           oldText?: string, newText?: string }[],
  truncated: boolean
}
```

路由 `GET /api/dsh-side-session/context?sessionId=` 返回上述（仅回环）。
截断上限：transcript ~32K 字符；单文件文本 256KB；文件数 200。

## 7. 临时会话问答流

1. 用户提交 `question`。
2. client `POST /ask { sessionId, question, tempHistory: [{role,text}] }`。
3. server 组装 system prompt：
   - 角色：你是基于当前会话上下文回答的辅助助手，**只解释、不修改任何文件**。
   - 上下文：transcript 摘要 + 文件清单与内容（含 diff）。
   - 历史：临时会话已有的多轮问答。
   - 当前问题。
4. server 调用**回答引擎**（见第 12 节 Q1，待定），**流式**返回（SSE 或 chunked JSON）。
5. client 渲染流式回答，追加进临时线程；支持多轮追问。

## 8. UI（默认方案）

右侧固定可折叠面板：

- 折叠态：一条细竖条（点击展开）。
- 展开态（宽 ~360px）：
  - **上下文卡**：会话标题、消息数、文件 chips（点击展开看 diff / 内容）。
  - **问答区**：用户/助手气泡，流式打字效果。
  - **输入框**：Enter 发送，Shift+Enter 换行；「清空」按钮。
- 样式复用 dsh CSS 变量（`--dsw-alias-*`），与官方深色/浅色主题一致。

## 9. 配置（settings 节，按 Q1 决定字段）

- 回答引擎相关：API key / 端点 / 模型（若走自带 key）。
- 上下文上限：transcript 条数/字符、单文件字符上限。
- 面板默认宽度 / 默认是否展开。

## 10. 加载与安装

- **默认**：独立插件包（零构建纯 JS），用户通过插件市场
  `github:<owner>/<repo>#<branch>` 安装，或手动放入 `assets/plugins/` 并由
  `sync-companion-plugins.js` 同步进 web profile。
- **可选**：作为 companion 插件随客户端分发（放入 `dsh-desktop/assets/plugins/`）。

## 11. 安全

- 所有路由仅接受回环地址（`isLoopback`）。
- 文件内容读取限制在「会话已触及的文件」，不任意读全盘。
- API key 走 `secret` 角色 + 环境变量兜底，不落明文日志。

## 12. 开放问题（待确认，见对话提问）

- **Q1 回答引擎**：临时会话如何真正调到模型？
  - (a) 复用用户已配置的 DeepSeek API Key（服务端读 dsh 全局凭据）；
  - (b) 插件自带 settings 填 key（类似 dsh-vision，env 兜底）；
  - (c) 纯客户端走 dsh 已有 LLM 服务（若客户端可注入 llm 服务）。
- **Q2 上下文范围**：「当前页面上下文」具体包含？
  - 整段 transcript + 全部触及文件（推荐）/ 仅最近 N 条 / 仅当前打开文件。
- **Q3 文件捕获粒度**：只捕获写/改/删（可靠），还是也要捕获「读取」的文件（best-effort）？
- **Q4 UI 形态**：右侧自绘固定面板（推荐，零依赖）/ 复用 better-sidebar 右栏 / 独立浮窗。
- **Q5 交付形态**：独立零构建纯 JS 插件（推荐）/ companion 内置 / 需要 tsdown 构建。

## 13. 已确认决策（2026-08-16，依据 Desktop/Spec.txt 与仓库实测）

- **Q1 回答引擎（依据用户 Spec.txt）**：三模式互斥、持久化、即时切换、不重启。
  - mode1 `reuse_global_key`：服务端读 dsh 全局 Key。来源链 = `env DEEPSEEK_API_KEY` → `$DSH_HOME/.credentials.yaml` 的 `DEEPSEEK_API_KEY`；base = `env DEEPSEEK_API_BASE` 默认 `https://api.deepseek.com`；model = `$DSH_HOME/settings.yaml` 的 `model:` 行，缺省 `deepseek-chat`。（取自仓库 `dsh-desktop/balance.js` 的实测实现）
  - mode2 `plugin_self_key`：服务端读本插件 settings 的 `apiKey` / `model` / `endpoint`（secret 角色，持久化）。
  - mode3 `server_call_dsh_llm`：服务端走 `ctx.llm.stream({provider, model, system, messages})`（实测 dsh 主机**无** `/v1/chat/completions` 端点，改用宿主 LLM 服务）。不读任何 key。未就绪返回「宿主 LLM 服务(ctx.llm)当前不可用」。
  - 校验：key 为空弹窗提示去哪里填；网络/模型错误 UI 展示；模式切换即时生效。
- **Q2 上下文范围**：整段 transcript + 本会话全部触及文件。
- **Q3 文件捕获粒度**：写/改/删可靠捕获（`tool/result` 的 `meta.diffs`）；读类工具 best-effort（能拿路径就拿，拿不到不强求）。
- **Q4 UI 形态（2026-08-16 终版）**：独立零构建纯 JS 插件，上架插件市场，用户拉取放入 Cordis 插件目录即加载，非 companion 内置。
  - **唤起入口**：左侧主栏底部 `sidebar.footer.action` 槽注册独立图标（list 槽，scope=root，在 settings 图标旁），用户手动点击才展开右侧自绘面板，**不自动展开**；不侵入、不改动主界面与 dsh-better-sidebar，二者并排共存。
  - **载体**：右侧自绘固定面板 + 可撕出独立浮窗（页内 position:fixed 可拖拽缩放）；浮窗一键收回侧栏；**全局单例 Store** 共享会话数据，切载体不丢消息/Agent 状态；浮窗状态仅存内存，DSH 重启/插件重载强制回落侧栏，不记忆浮窗状态。
  - **唤起命令**：主会话输入框斜杠命令 `/side-session`（`ctx.commandUi.register`，popupSelect，选项=唤起浮窗/侧栏/清空）+ 全局快捷键 Ctrl+Shift+S（document keydown 自监听，DSH 无全局命令面板）。
  - **输入框**：行为级复刻主界面 InputBar（InputBar 是内部组件不导出、className 哈希无法引用）——自绘 textarea + aria-hidden mirror div 自动增高 + 完整 IME 处理（composingRef + onCompositionStart/End + isComposing + keyCode 229，组合中不提交）+ 快捷键（Enter 提交/Shift+Enter 换行/Ctrl·Cmd+Z 撤销/Y·Shift+Z 重做）+ onCopy/onCut/onPaste + `--dsw-alias-*` token 复刻视觉。侧栏与浮窗输入框 UI/交互/auto-grow 完全一致；修复 webview 键盘输入阻塞。
  - **三种 LLM 模式切换**：移到插件设置面板（`settings.section` list 槽自定义 React：模式 select + API Key password 输入框 + model + endpoint），配置持久化；选择插件密钥(mode2)时展示 API Key 输入框。密钥缺失给友好提示。侧栏/浮窗内不再放 ModeBar。
  - 实现说明：「浮窗」采用页内可拖拽自由浮层（position:fixed），不依赖宿主额外 OS 窗口 IPC，保证零依赖、对升级稳定。
- **Q5 交付形态**：独立零构建纯 JS 插件（无需构建，`require("react")` 直接写 `jsx()` 调用）。包名 `dsh-side-session`，通过插件市场 `github:<owner>/<repo>#<branch>` 或放入 `assets/plugins/` 加载。

### 13.1 上下文捕获实现路径（关键）

不猜测 dsh 会话事件类型。服务端直接解析会话日志文件
`<DSH_HOME>/sessions/**/session.jsonl.zstd`：
- 用 zstd 帧扫描 + `node:zlib.zstdDecompressSync` 解压（复用 `dsh-file-changes` 手法，对升级稳定）；
- 逐行 JSON：提取 `tool/result` 的 `meta.diffs` → 文件清单（含 oldText/newText，截断 64KB/文件、200 文件上限）；
- 提取消息事件（tolerant：匹配 `user`/`assistant` 类型与 `content`/`text` 字段）→ transcript（最近 ~120 条 / 40K 字符上限）；
- 路由 `GET /api/dsh-side-session/context?sessionId=` 返回 `{title, files, transcript, truncated}`（仅回环）。

### 13.2 问答流

- 客户端组装 `messages`：system（角色约束 + 上下文 + 历史）+ 多轮历史 + 当前问题。
- mode1/2 → `POST /api/dsh-side-session/ask`（服务端按 mode 解析 key，流式代理 DeepSeek SSE 回客户端）。
- mode3 → 客户端同源 `POST /v1/chat/completions`（宿主流式回）。
- 客户端统一用 OpenAI SSE 解析器渲染流式回答；三种模式 UI 一致。
