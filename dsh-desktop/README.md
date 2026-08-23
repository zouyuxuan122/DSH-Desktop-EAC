# Deepseek Harness EAC（揽尽万象 · Embracing All Creation）

把 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）封装成开箱即用的 Windows 桌面客户端。

- ✅ **免安装 Node**：内置独立的 Node 运行时与 npm CLI，目标机器无需安装 Node.js
- ✅ **内置 dsh CLI**：完整打包 `@deepseek-ai/dsh` 及其全部插件，离线可用
- ✅ **一键启动**：双击即启动 `dsh web`，自动挑空闲端口，就绪后加载到原生窗口（stdout 就绪行与 HTTP 探测并行判定，首启装依赖自动放宽时限）
- ✅ **风格化无边框窗口**：无原生标题栏/菜单栏，自绘 36px 玻璃栏（圆角图标 + 拖拽 + ⋯ 菜单 + 窗口控制），Win11 原生圆角；快捷键 Ctrl+R / F12 / F11 保留
- ✅ **多窗口（v4）**：会话头部「弹出到独立窗口」分屏多任务；侧边临时会话浮窗追问（Ctrl+Shift+S，不写主会话）
- ✅ **系统托盘常驻**：点关闭默认隐藏到托盘（可关闭），托盘菜单提供显示/检查更新/重启 Web 服务/退出
- ✅ **退出即清理**：退出应用有界等待 dsh 进程树真正退出（优雅 → 强杀），不留孤儿进程（v4 根治「退出残留一对进程」）
- ✅ **便携版**：`portable` 版数据（日志、配置）跟随 exe 所在目录，拷到 U 盘就能用
- ✅ **与 CLI 共享配置**：默认沿用 dsh 自身的 `DSH_HOME`（通常是 `~\.dsh`），已有会话/API Key 直接生效
- ✅ **跟随官方更新**：官方 @deepseek-ai/dsh 发新版时弹窗提醒，经用户同意后自动下载安装，重启生效，失败自动保留旧版
- ✅ **客户端自更新 + SHA-256 校验（v4）**：自动检查上游仓库（GitHub→Gitee 双源，Gitee 分片自动合并）发布的封装新版本，经用户同意后下载（完成内容 SHA-256 校验，不一致中止替换并删除文件）、替换、重启；便携版/安装版各自适配
- ✅ **快捷方式自动维护**：按「目标 exe」识别既有快捷方式（用户改名/换图标不再重复新建），自定义图标绝不覆盖；⋯ 菜单可关闭桌面快捷方式自动维护
- ✅ **DeepSeek 余额小部件**：对话底部统计栏内联显示「本轮 ¥X.XX · 余额 ¥Y.YY」（自动注入配套 dsh 客户端插件，点击跳转充值）
- ✅ **文件更改追踪 + 一键还原 + AI 变更审核（v4）**：详情面板「文件」标签页聚合本会话改动（行级 diff、逐文件或全部还原）；「AI 变更审核」可手动/自动让模型复查自己刚做的改动（正确性/安全性/目标一致性）
- ✅ **会话删除与归档管理（v4）**：会话行菜单「删除对话」+ 设置内归档恢复/删除面板（官方只有归档，运行时补丁幂等打通全链路）
- ✅ **微信 ClawBot / OpenClaw 桥（v4）**：设置页「ClawBot」栏扫码绑定微信官方 ClawBot 小程序，微信里直接驱动常驻 DSH 会话（每用户独立会话/工作区/白名单）；OpenAI 兼容端点供 OpenClaw 网关接入
- ✅ **会话完成系统通知**：agent 任务跑完时弹 Windows 系统通知，点击回到窗口
- ✅ **界面皮肤**：设置页「皮肤」标签页内置 10 款 Web UI 皮肤（9 款 dsh-web-ui 皮肤 + 1 款深海女仆工坊），互斥切换、默认不启用、重启生效；随包标注出处与许可（详见「界面皮肤」章节）
- ✅ **内置社区插件套件**（v2.0 起，详见「内置社区插件」章节）：插件市场 / 外置视觉模型 / 长期记忆 / soul.md 人设卡 / 移动端适配修复，全部随包分发、开箱即用
- ✅ **崩溃急救与撤销（v4，dsh-undo-savepoint）**：配置与插件代码树快照、undo/redo、一键安全模式、密钥脱敏 vault —— 配置改坏、dsh 起不来也能救
- ✅ **插件启停管理（v4）**：设置页「插件 → 管理」不重启切换任意插件启停（含默认禁用的大肥鱼桌宠）
- ✅ **一键迁移（一键夺舍）**：设置页选择任意已有 AI 工具目录（如 Codex / Claude 安装目录）→ 自动新建工作区与对话 → 发送迁移指令，AI 在对话中全程可视化提取 skills / MCP 配置 / 长期记忆
- ✅ **错误日志一键复制（v4.1）**：启动失败 / DSH 服务停止的报错弹窗带「复制日志」按钮，一键复制完整诊断信息（错误、堆栈、日志目录、最近日志尾部）供反馈
- ✅ **应用内反馈入口（v4.1）**：⋯ 菜单与托盘「反馈建议…」直达 GitHub Issues，关于弹窗附交流群号
- ✅ **拖文件/文件夹进对话（dsh-file-drop-eac，取代 dsh-file-drop）**：把本地文件/文件夹直接拖进对话输入框 —— 文本/代码自动注入（上限 256KB，带文件名头）；.sql / 二进制 / 超大文件只注入完整路径提示让 agent 按路径读取；文件夹识别 + 降级提示；图片不接管（交给内置图片入口/缩略图，避免重复注入）
- ✅ **设置页边栏自定义（v4.1，dsh-settings-nav-custom）**：设置面板左侧导航底部「自定义边栏」，按需显示/隐藏与排序导航项，localStorage 持久化，默认全显
- ✅ **更新保障（v4.1）**：更新前强制插件/配置快照（失败中止更新）；官方 dsh 更新后上一版本备份保留到下次启动确认健康，启动失败可一键「回退到上一版本」；便携版客户端更新后若新版崩溃自动回退上一版；更新完成弹窗明示插件/皮肤/会话全部保留

## 快速开始（成品用户）

1. 打开 [Releases](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/latest) 页面，选其一（链接永久有效，始终指向最新版）：
   - [Deepseek-Harness-EAC-Portable-v4.4.1-x64.exe](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/latest/download/Deepseek-Harness-EAC-Portable-v4.4.1-x64.exe) —— 免安装便携版，双击运行
   - [Deepseek-Harness-EAC-Setup-v4.4.1-x64.exe](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/latest/download/Deepseek-Harness-EAC-Setup-v4.4.1-x64.exe) —— 安装版，创建桌面/开始菜单快捷方式
2. 首次运行会显示启动动画，随后进入 DeepSeek Harness Web UI。
3. 如尚未配置 API Key，在界面内完成配置即可开始使用（与命令行 dsh 完全一致）。

> ⚠️ **务必安装到纯英文路径**（如默认的 `C:\Users\<你>\AppData\Local\Programs\`）：中文路径（如 `D:\迅雷下载\`）会触发 Chromium 渲染进程原生崩溃，窗口弹出数秒后自动退出。
>
> 便携版的数据目录是 exe 旁的 `data\`；安装版在 `%APPDATA%\Deepseek Harness EAC\`。
> 若想强制指定 DSH 配置目录，启动前设置环境变量 `DSH_HOME` 即可（与 dsh CLI 行为一致）。

## 跟随官方更新（用户同意后自动更新）

- 启动 15 秒后及此后每 6 小时，自动查询 npm 官方 registry 上 @deepseek-ai/dsh 的最新版本；菜单「帮助 → 检查更新…」可随时手动检查。
- 发现新版本时弹窗询问：**立即更新 / 跳过此版本 / 稍后**。
- 同意后，内置 node + npm 把官方新版本安装到用户数据目录的 `agent\`（overlay），全程写入 staging 目录，成功后才原子切换，失败自动保留当前版本。后续更新只下载差异（复用 npm 缓存）。更新前自动对插件/配置做保护快照（失败则中止更新）。
- 完成后提示**立即重启 / 稍后重启**，重启即用新版；启动时 dsh 路径解析优先使用 overlay、内置版本兜底。
- **上一版本备份保留**（v4.1）：切换成功后旧版保留为 `agent-previous`，直到下次启动确认新版健康才自动清理；若新版启动失败，启动失败对话框提供**「回退到上一版本并重试」**（优先）与「回退到内置版本并重试」一键回退。
- 尊重用户 npm 配置：自定义 registry 镜像/代理请设 `NPM_CONFIG_REGISTRY`（如 `https://registry.npmmirror.com`）。

## 客户端自更新（封装层）

- 启动 60 秒后及此后每 12 小时，自动查询上游仓库的最新 release（**GitHub Releases → Gitee Releases 双源回退**；可用环境变量 `DSH_DESKTOP_RELEASE_API` 指向自定义镜像 API），比较当前版本。
- 发现新版本时弹窗询问：**立即更新 / 跳过此版本 / 稍后**；同意后带进度条下载安装包（便携版选 `*-portable-x64.exe`，安装版选 `Setup-*-x64.exe`；Gitee 因单文件 100MB 限制拆分的 `.part1/.part2` 分片会自动按序下载并合并），下载到 `<数据目录>\updates\`。
- **SHA-256 内容校验（v4）**：下载完成后强制校验文件哈希 —— 优先用 GitHub Release 资产自带的 digest 字段，其次取 Release 附带的 `SHA256SUMS.txt`（`npm run dist` 自动生成，发布时随资产上传）；不一致 → 删除文件并中止更新，绝不运行被篡改或损坏的安装包。上游未提供哈希时记录告警并放行（老 Release 兼容）。
- 确认重启后：**便携版**用 detached 脚本等待旧 exe 解锁 → 备份 → 原地替换 → 自动启动新版本（只读目录自动退化为直接启动新 exe）；**安装版**等待进程退出后以向导方式启动新安装包。失败自动保留当前版本，下次启动继续提示待安装更新。
- **崩溃自回退（v4.1）**：便携版更新后，上一版 exe 备份与 marker 保留到新版首次健康启动；若新版启动失败（上次运行非干净退出），下次启动自动用上一版还原并保留崩溃副本、弹系统通知告知。
- 菜单入口：chrome 栏 ⋯ 菜单 →「检查客户端更新…」；托盘菜单同样可用。跳过版本记录在 `settings.json`（`skipClientVersion`）。
- **更新源可见可复制**：⋯ 菜单内「更新源」区块与「关于 Deepseek Harness EAC」对话框展示项目仓库地址（GitHub），一键复制到剪贴板。
- 链路自检：`node scripts/check-client-latest.js [--download]`（可设 `DSH_DESKTOP_RELEASE_API` / `PORTABLE_EXECUTABLE_DIR`）。

## DeepSeek 余额小部件

- 桌面端读取 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`（或环境变量），调用 `https://api.deepseek.com/user/balance`，每 15 分钟刷新，通过 preload 推送到 Web UI。
- 配套 dsh 客户端插件（`assets/plugins/dsh-balance`）在每次启动时自动同步进 web profile 并注册到 `conversation.composer.dock`，在对话底部统计栏内联显示：**本轮 ¥X.XX · 余额 ¥Y.YY**（本轮费用按 token 用量 × 价格档估算，缓存命中/未命中/输出分别计价）。
- 价格档默认：deepseek-chat 2/0.5/8、deepseek-reasoner 与 deepseek-v4-pro 4/1/16（¥/百万 token）；可在 `<数据目录>\settings.json` 的 `balancePrices.<model>` 覆盖。代理/镜像可用 `DEEPSEEK_API_BASE` 或 `DEEPSEEK_BALANCE_URL` 环境变量。
- 纯浏览器打开 Web UI 时无桌面壳推送，小部件只显示「本轮」费用。

## 快捷方式与托盘

- **托盘**：点窗口关闭按钮默认隐藏到托盘并提示一次；托盘菜单可显示窗口 / 检查更新 / 开关会话通知 / 退出。chrome 菜单「关闭时最小化到托盘」可关闭该行为。
- **快捷方式**：便携版首次运行自动创建桌面 + 开始菜单快捷方式（开始菜单快捷方式同时是 Windows Toast 通知的前置条件）；每次启动校验，exe 被移动后自动重建指向新位置；从系统临时目录运行时弹窗提醒移动到固定位置。

## 文件更改追踪与回退

- 详情面板新增「文件」标签页（与 对话/轨迹 并列）：聚合当前会话 agent 改过的所有文件，展示新建/修改/删除标记、行数变化与行级 diff。
- **数据来源**：只读复用官方会话日志已持久化的 `tool/result.data.meta.diffs`（`ctx.fs` 写前锁内全文），配套 host 插件 `@deepseek-ai/dsh-file-changes` 注册 `fileChanges` 会话投影，零写入、零格式变更，对 dsh 升级完全稳定。
- **还原**：逐文件或全部还原 —— 客户端把该文件的变更按逆序发给桌面壳，壳层做**内容精确匹配后替换**（新建→删除、删除→恢复、修改→回写写前全文）；文件已被后续改动时提示冲突，绝不覆盖未知内容。
- **对话回退**：沿用 dsh 内置的会话分叉（消息尾部「从此处分叉」），可与文件还原组合使用。
- 配套插件随桌面端分发（`assets/plugins/`），每次启动自动同步进 web profile 并幂等注册。

## 项目文件树与 HTML/端口预览

- 「文件」标签页内新增「全部文件」子视图：VSCode 风格的层级文件树（懒加载、目录优先排序、文件大小/修改时间、本会话改过的文件带绿点标记），点击文件用系统默认程序打开；配套 host 插件注册 `GET /api/dsh-files/list`（仅回环）。
- **站内侧边预览**（可拖宽，宽度持久化）：树中 HTML 文件的悬停「▶」按钮或「本会话修改」列表的「预览」按钮打开右侧预览面板；宿主插件以 `GET /dsh-files/static/<绝对路径>` 提供静态文件服务，HTML 的相对资源引用（`./css`、`../img`）随 URL 自然解析，与本地打开一致。
- **端口预览**：预览面板地址栏可直接输入 `3000` / `localhost:5173` 等，宿主插件探测本机回环监听端口（`GET /api/dsh-files/ports`）并以徽章列出，点击即预览；`GET /api/dsh-files/check` 提供在线状态检查（面板状态栏显示 HTTP 状态）。
- 预览面板带前进/后退/刷新/外部打开（系统浏览器）；全部路由仅接受回环地址请求。

## 会话内终端

- 新增「终端」标签页（与 对话/轨迹/文件 并列）：在当前会话的项目目录下启动持久 PowerShell shell，SSE 流式输出、命令历史（↑/↓）、清屏、重启、断线自动重连（切换标签页/刷新不丢，回放最近 512KB 输出）。
- **编码**：宿主插件用显式 UTF-8 的 mini-REPL（自建读行循环 + `Invoke-Expression`）绕开 PowerShell 5.1 原生 REPL 对重定向 stdin 的编码漂移，中文输入输出双向干净。
- **限制**：非 PTY（vim/htop 等全屏交互程序不支持）；PowerShell 语法（`&&` 用 `;` 或 `if ($?)` 替代）；多行脚本请用 `;` 分行。
- 宿主插件路由：`GET /dsh-files/term/events`（SSE）、`POST /dsh-files/term/input`、`POST /dsh-files/term/close`，全部仅接受回环地址请求；断开后 shell 保留 15 分钟。

## 会话完成通知

- 监听 dsh 会话日志（`<DSH_HOME>/sessions/**/session.jsonl.zstd`），解码与官方持久化实现一致的 zstd 多帧 + JSONL 格式。
- 会话格式带 turn 事件的（当前版本）在 `turn/end`（一轮任务真正跑完，含 goal 模式整体完成）时通知；旧格式会话以 `assistant/message` 兜底。子代理会话不通知，避免刷屏。
- 通知标题优先使用会话标题（`session/title`），正文含工作目录与短会话 ID；点击通知回到主窗口。
- 菜单「帮助 → 会话完成通知」可随时开关（持久化于数据目录 `settings.json`）。
- Windows Toast 需要开始菜单快捷方式：安装版由安装器创建；便携版首次运行自动创建（指向原始 exe）。

## 界面皮肤

- 设置页新增「皮肤」标签页：内置 10 款 Web UI 皮肤，卡片式网格展示（名称/简介/主色/作者/出处与许可角标），当前皮肤高亮。
- **默认皮肤即"不启用任何皮肤"**（原生外观）：10 款皮肤默认全部以 `disabled: true` 注册，无需改动即可保持默认外观；选中某款后其余自动禁用（互斥切换），「恢复默认皮肤」一键还原。
- 切换在设置页即时生效于配置，**重启 Web 服务后生效**（服务重启由桌面端自动完成）。
- 机制：皮肤是 browser-only 的 dsh client 插件（`window.__ModuleLoader__.load({id, factory})`），桌面端启动时把 `assets/skins/` 下皮肤包同步进 web profile 的 `node_modules`，并以 `ui-skin-*` 行注册到 `cordis.patch.yml`（幂等，已有行不重写，保留用户选择）；切换即重写这些行的 `disabled` 标记，配套插件 `@deepseek-ai/dsh-skin-switch`（host 半边 Typert Remote + 设置页 tab）负责列出/切换/恢复。
- **内置皮肤一览**：

| 皮肤 | 出处 | 许可 |
| --- | --- | --- |
| xp（Windows XP 风格） | [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) | BSD-3-Clause |
| qq98（QQ 经典 98 风格） | 同上 | BSD-3-Clause |
| ths（同花顺风格） | 同上 | BSD-3-Clause |
| blue-fantasy（蓝幻） | 同上 | BSD-3-Clause |
| dragon-heir（龙裔） | 同上 | BSD-3-Clause |
| minecraft（我的世界） | 同上 | BSD-3-Clause |
| trading（交易风格） | 同上 | BSD-3-Clause |
| whale-song（鲸歌） | 同上 | BSD-3-Clause |
| miku（初音未来） | 同上 | BSD-3-Clause |
| maid-atelier（深海女仆工坊） | [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) | **CC BY-NC-SA 4.0**（禁止商用） |

- 皮肤来源与版权：dsh-web-ui 九款皮肤包随包分发 `LICENSE`（BSD-3-Clause，出处/作者字段见皮肤卡片与包内元数据）；maid-atelier 为衍生创作（角色原作：上善；DeepSeek 元素二次设计：ZipZipPipe；本皮肤：Small-tailqwq），完整署名链见包内 `NOTICE`，整体仅限非商业使用。各皮肤包的 `LICENSE`/`NOTICE`/`README` 随同步一并分发到 web profile 的 `node_modules` 中。

## 内置社区插件（v2.0）

以下社区插件随安装包分发（`assets/plugins/`），每次启动自动同步进 web profile 并幂等注册；`pnpm` 安装第三方插件后导致模块双实例时，启动时的 heal 流程会自动清理遮蔽包并重建副本。

| 插件 | 功能 | 设置入口 |
| --- | --- | --- |
| `dsh-unified-market` | 统一插件市场：三源合一（awesome-dsh-plugin.com 精选目录 + GitHub `dsh-plugin` 生态 + npm 检索），安装走试装验证 + 冲突预检；已下载插件更新面板（一键全部/逐个更新）、自动更新三档、更新进度窗口、市场自更新 | 设置 → 插件 → 统一市场 |
| `dsh-plugin-manager`（v4） | 插件启停管理：列出配套/用户/核心插件与启用状态，不重启切换启停 | 设置 → 插件 → 管理 |
| `dsh-message-rewind` | 对话回退（Trae 风格）：悬停任意用户消息 →「编辑并回退」→ 从该消息之前分叉新会话并自动重发编辑后内容，原会话保留 | 对话界面（消息 hover 按钮） |
| `dsh-dock-settings` | Skills 与 MCP 管理：技能目录浏览（EAC 内置/用户来源徽标、打开目录）+ MCP 服务增删改（stdio / streamable-http），保存后一键重启生效 | 设置 → Skills 与 MCP |
| `dsh-pet` | 桌面宠物：28 个透明动画的悬浮宠物，空闲呼吸、随机动作、屏幕游走 | 随包自动启用 |
| `dsh-dafeiyu`（v4） | 大肥鱼桌宠：真实会话状态驱动的原生置顶窗口（六态动画 + 项目状态卡 + 摸头/戳一戳；角色素材按 ASSET_LICENSE 分发） | 默认禁用，「插件 → 管理」启用 |
| `picturereader` | 全能读图/读文档：视觉孪生 adapter（原生缩略图 + 粘贴即用自动分析，opencode 等 pi-ai provider 也可用，杜绝 UNSUPPORTED_CONTENT）；隐私/智能/严谨三模式；本地工具链（像素扫描/3 引擎 OCR/裁剪/取色/对比/批量）；pdf/word/excel/ppt 转图片；可选外部 VLM 桥（OpenAI 兼容端点） | 设置 → 图片阅读 |
| `computer-user` | 读屏 + 鼠标键盘自动化（Codex-style computer use）：截图读出屏幕、点击/输入/按键/滚动/拖拽/移动鼠标/读光标；配 picturereader 让纯文本模型驱动桌面；纯本地（PowerShell + Win32 SendInput，不调外部 API）；四模式（禁用/只读/手动批准/自动） | 设置 → 电脑操作 |
| `dsh-soul-md` | soul.md 人设卡：可视化编辑人设，热重载即时生效；未配置时注册空 section，**完全不影响官方系统提示词** | 设置 → 人设卡 |
| `dsh-web-mobile-fix` | Web UI 移动端适配修复 | 随包自动启用 |
| `dsh-settings-scroll-fix` | 设置面板滚轮与溢出滚动修复；使用语义识别和实际尺寸检测，不依赖易变化的 CSS 哈希类名 | 随包自动启用 |
| `dsh-easy-setup` | 一键迁移（一键夺舍）：选择目录 → 新建工作区与对话 → AI 全程可视化迁移 skills / MCP / 记忆 | 设置 → 一键迁移 |
| `dsh-change-review`（v4） | AI 变更审核：监控本会话文件改动，手动/自动让模型复查自己刚做的改动（正确性/安全性/目标一致性），配合「文件」页一键还原 | 设置 → AI 变更审核 |
| `dsh-undo-savepoint`（v4） | 崩溃急救与撤销：配置/插件代码快照、undo/redo、一键安全模式、密钥脱敏 vault、跨机迁移 ZIP | 对话顶部 undo/redo 按钮 + 快照面板 |
| `@deepseek-ai/dsh-openclaw-bridge`（v4） | 微信 ClawBot / OpenClaw 桥：微信扫码绑定后在小程序里驱动常驻 DSH 会话；OpenAI 兼容端点；第三方模型端点 | 设置 → ClawBot |
| `@deepseek-ai/dsh-float-window`（v4） | 会话浮窗：把会话弹出到独立窗口分屏多任务 | 会话头部「弹出到独立窗口」 |
| `@dsh-external/dsh-side-session`（v4） | 侧边临时会话：浮窗追问、不写主会话、多种回答引擎 | Ctrl+Shift+S |
| `dsh-session-manager`（v4） | 会话删除与归档管理：会话行「删除对话」+ 归档恢复/删除面板 | 会话菜单 + 设置面板 |
| `@vlln/dsh-navbar`（v4） | 对话节点导航条：右缘节点串快速跳转 user 消息（悬停预览/点击跳转/滚轮切换） | 随包自动启用 |
| `@deepseek-ai/dsh-conversation-tweaks`（v4） | 对话微调：隐藏大量工具调用/结果/思考输出，保留每轮最终总结 | 设置 → 通用 |
| `@deepseek-ai/dsh-prompt-custom`（v4） | 自定义注入提示词：整体替换/追加官方 persona | 设置 → 提示词 |
| `@deepseek-ai/dsh-third-party-thinking`（v4） | 第三方 OpenAI 兼容模型的 reasoning_effort 控件（字段名可自定义） | 模型参数区 |
| `dsh-offpeak`（v4） | 峰谷价格卫士：高峰时段（北京时间 9-12 / 14-18 点）发送前拦截提醒，一键继续或定时到闲时价自动执行（浏览器不在线也执行） | 发送时弹窗（「插件 → 管理」可关闭） |

> **Windows 文件锁排队**：运行中的 Web 服务加载着原生模块（sqlite-vec 等 DLL）时，插件安装/卸载会遇到 `EPERM` 文件锁 —— 任务会自动排队（`.dsh-market-pending.json`），下次服务重启前（无锁窗口）自动完成，市场界面提供「立即重启并完成」按钮。
>
> **NSIS 升级修复**：安装器在卸载旧版前自动结束新旧进程，修复了旧版 "Failed to uninstall old application files: 2"（应用运行中导致文件被锁）。

## 退出行为三档（v2.2）

标题栏「⋯」菜单 →「关闭窗口时」：**每次询问 / 后台运行（最小化到托盘）/ 直接退出**。选「每次询问」时点关闭弹窗（「最小化到后台 / 退出程序」+「记住我的选择」勾选），旧版 `closeToTray` 布尔设置自动迁移。配置存于 `<userData>/settings.json` 的 `exitAction`。

## 内置 Skills 分发（v2.2）

`assets/skills/<kebab-name>/SKILL.md` 随包分发，启动时同步进 `~/.dsh/skills/`（dsh 内核默认扫描根，零配置）：带 `.eac-skill.json` 标记的技能随版本覆盖更新；用户自建同名目录永不覆盖；不删除用户的任何内容。当前内置：`eac-desktop-tips`（客户端功能速查）。

## 从源码构建

要求：Windows + Node.js（仅构建机需要）+ npm。

```powershell
npm install                    # 安装 dsh / electron / electron-builder
npm run fetch-runtime          # 内置 node.exe + npm CLI（构建与开发都需要）
npm start                      # 开发模式启动（窗口内跑 Web UI）
npm run dist                   # 构建 portable + NSIS 安装包，输出到 dist/
```

> 网络受限时：Electron 二进制镜像 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`（可 `npm run electron:fetch` 手动补拉）；打包工具链镜像 `$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`。
>
> 开发辅助脚本：`node scripts/check-latest.js`（检查/试装更新）、`node scripts/test-watcher.js`（通知检测单测）、`node scripts/inspect-session.js <file>`（会话日志事件词表）。

## 架构

```
┌──────────────────────────────────────────────────────────┐
│  Electron 壳 (main.js)                                   │
│  · 单实例锁 / 窗口 / 菜单 / 生命周期                       │
│  · 会话完成监听 (session-watcher.js) → 系统通知            │
│  · 官方更新 (updater.js) → 用户同意后安装 overlay          │
│  · spawn vendor|resources 里的 node.exe                   │
└──────────────┬───────────────────────────────────────────┘
               │  dsh web --host 127.0.0.1 --port 0
               ▼
       内置 node.exe + @deepseek-ai/dsh
       路径解析：用户目录 overlay > 内置包
       输出 "dsh web: http://127.0.0.1:<port>"
               │  解析 URL，轮询 HTTP 200
               ▼
       原生窗口加载 Web UI（仅本机回环访问）
```

关键决策：

| 决策 | 原因 |
| --- | --- |
| `asar: false` | dsh 依赖 sharp / node-pty / koffi 等原生模块，必须以真实文件落盘 |
| 内置独立 node.exe + npm | 预编译原生模块 ABI 与安装时的 Node 版本绑定；Electron 内嵌 Node ABI 不同。内置同版本 node.exe 零配置保证一致，npm 用于官方更新。注意：electron-builder 复制 extraResources 时会剥掉嵌套 node_modules，npm 自己的依赖由 \`afterPack\` 钩子原样补拷（scripts/after-pack.js） |
| `npmRebuild: false` | 绝不为 Electron 重编译原生模块，否则内置 node.exe 反而加载不了 |
| `--port 0` + 解析 stdout | 由 OS 分配空闲端口，避免端口冲突；本机回环绑定不对外暴露 |
| 退出时 `taskkill /T /F` | dsh 会派生 pwsh 等子进程，按进程树整体回收 |
| 更新走 overlay + staging 原子切换 | 更新失败零风险；便携版（资源每次从 exe 解压）也能持久更新 |
| 通知读会话日志而非 UI 协议 | 持久化格式是官方稳定接口；UI 的私有 RPC/SSE 协议随版本变化，容易失效 |

## 日志与排障

- `desktop.log`：壳层日志（启动参数、端口、通知、更新、退出）
- `dsh-web.log`：dsh web 的完整 stdout/stderr
- `update.log`：官方更新的 npm 安装日志

位置：便携版 `data\logs\`；安装版 `%APPDATA%\Deepseek Harness EAC\logs\`。
菜单「视图 → 打开日志目录」可直接打开。

常见问题：

- **Windows 提示"已保护你的电脑"（SmartScreen）**：成品未做代码签名。点「更多信息 → 仍要运行」，或在 PowerShell 里 `Unblock-File`。
- **首次启动慢**：dsh 首次引导 profile 需要数秒到数十秒，属正常现象。
- **更新下载慢**：设置环境变量 `NPM_CONFIG_REGISTRY=https://registry.npmmirror.com` 后重启应用。
- **收不到通知**：确认菜单「会话完成通知」已勾选；便携版确认开始菜单里存在「Deepseek Harness EAC」快捷方式（首次运行自动创建，勿删除）；检查 Windows「通知与操作」设置里应用通知未被禁用。
- **端口被占**：应用自动使用空闲端口，无需手动处理。

## 目录结构

```
dsh-desktop/
├── main.js               # Electron 主进程（无边框窗口/托盘/自绘 chrome IPC + 余额推送 + 客户端自更新 + 快捷方式维护）
├── updater.js            # dsh agent 官方更新引擎（检查 / 同意后安装 / 回退）
├── client-updater.js     # 客户端（封装层）自更新引擎（GitHub/Gitee 双源 + 分片合并 + 原地替换）
├── balance.js            # DeepSeek 账户余额查询（主进程）
├── session-watcher.js    # 会话完成监听（zstd 多帧解码 + turn/end 检测）
├── preload.js            # 沙箱预加载（自绘玻璃标题栏 + 窗口控制/菜单 IPC + 余额事件桥）
├── assets/               # 加载页、更新进度页、图标、托盘图标、配套 dsh 插件
│   └── plugins/          # 桌面壳配套（dsh-balance、dsh-file-changes、dsh-terminal、
│                         # dsh-easy-setup、dsh-skin-switch）+ 内置社区插件
│                         # （dsh-unified-market、dsh-soul-md、dsh-web-mobile-fix，
│                         # 含 vendor 与自包含依赖）
│                         # 全部自动同步进 web profile
├── scripts/
│   ├── fetch-node.js     # 内置 node.exe 复制脚本
│   ├── fetch-npm.js      # 内置 npm CLI 复制脚本
│   ├── build-icon.ps1    # 生成应用图标（透明圆角蒙版）+ 托盘图标
│   ├── check-latest.js   # agent 更新链路测试工具
│   ├── check-client-latest.js # 客户端更新链路测试工具
│   ├── test-watcher.js   # 通知检测单测
│   └── inspect-session.js# 会话日志解析工具
├── build/icon.png        # electron-builder 图标源
├── vendor/               # 内置 node.exe / npm CLI（fetch-runtime 生成，不入库）
├── electron-builder.yml  # 打包配置
└── dist/                 # 构建产物
```

## License

MIT。基于 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。
