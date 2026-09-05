# Deepseek Harness EAC v4Lite

把 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）封装成开箱即用的 Windows 桌面客户端 —— **v4Lite 精简版**：砍掉浮窗、客户端自更新、桌宠、记忆、人设卡等外围功能，只保留高频核心工作流；余额小部件与峰谷价格卫士等实用插件保留。

- ✅ **免安装 Node**：内置独立的 Node 运行时与 npm CLI，目标机器无需安装 Node.js
- ✅ **内置 dsh CLI**：完整打包 `@deepseek-ai/dsh` 及其全部核心插件，离线可用
- ✅ **一键启动**：双击即启动 `dsh web`，自动挑空闲端口，就绪后加载到原生窗口（stdout 就绪行与 HTTP 探测并行判定，首启装依赖自动放宽时限）
- ✅ **风格化无边框窗口**：无原生标题栏/菜单栏，自绘 36px 玻璃栏（圆角图标 + 拖拽 + ⋯ 菜单 + 窗口控制），Win11 原生圆角；快捷键 Ctrl+R / F12 / F11 保留
- ✅ **系统托盘常驻**：点关闭默认隐藏到托盘（可关闭），托盘菜单提供显示/重启 Web 服务/退出
- ✅ **退出即清理**：退出应用有界等待 dsh 进程树真正退出（优雅 → 强杀），不留孤儿进程
- ✅ **数据目录隔离**：默认使用 `DSH_HOME = ~\.dsh-v4lite`（与原版 `~\.dsh` 完全隔离，两端可并行安装运行），已有会话/API Key 可复制 `~\.dsh\settings.yaml` 迁移
- ✅ **界面皮肤**：设置页「皮肤」标签页内置 9 款 Web UI 皮肤，互斥切换、默认不启用、重启生效；随包标注出处与许可
- ✅ **内置插件套件**（11 个，详见「内置插件」章节）：插件市场 ×3 / 插件保护中心 / 启停管理 / 余额小部件（含峰谷倒计时）/ 峰谷价格卫士 / 崩溃急救撤销 / 右侧栏工作台 / 自动压缩 / 皮肤切换，全部随包分发、开箱即用
- ✅ **崩溃急救与撤销（dsh-undo-savepoint）**：配置与插件代码树快照、undo/redo、一键安全模式、密钥脱敏 vault —— 配置改坏、dsh 起不来也能救
- ✅ **错误日志一键复制**：启动失败 / DSH 服务停止的报错弹窗带「复制日志」按钮，一键复制完整诊断信息供反馈
- ✅ **快捷方式自动维护**：按「目标 exe」识别既有快捷方式（用户改名/换图标不再重复新建），自定义图标绝不覆盖

> **v4Lite 是 EAC 4.4.0 的功能子集**：依赖同一 `main.js` 架构与安全引擎，删去了浮窗/临时会话、文件更改追踪/终端、会话通知、客户端自更新、ClawBot 桥、一键迁移、桌宠、长期记忆、soul.md 人设卡、移动端修复等外围件（完整差异见「与 EAC 4.4.0 的差异」）。插件与配置格式完全兼容，升级/降级不破坏数据。

## 快速开始（成品用户）

1. 打开 [Releases](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/latest) 页面，下载 `Deepseek-Harness-EAC-Setup-x64.exe`（安装版，创建桌面/开始菜单快捷方式；链接永久有效，始终指向最新版）。
2. 首次运行会显示启动动画，随后进入 DeepSeek Harness Web UI。
3. 如尚未配置 API Key，在界面内完成配置即可开始使用（与命令行 dsh 完全一致）。

> ⚠️ **务必安装到纯英文路径**（如默认的 `C:\Users\<你>\AppData\Local\Programs\`）：中文路径（如 `D:\迅雷下载\`）会触发 Chromium 渲染进程原生崩溃，窗口弹出数秒后自动退出。
>
> 应用数据目录在 `%APPDATA%\Deepseek Harness EAC v4Lite\`（独立于原版 `%APPDATA%\Deepseek Harness EAC\`）。
> dsh 配置主目录默认 `~\.dsh-v4lite`（独立于原版 `~\.dsh`）；如需覆盖，启动前设置环境变量 `DSH_HOME` 即可（与 dsh CLI 行为一致）。

## 更新与版本策略（v4Lite）

- **v4Lite 不内置任何更新接口**：不检查官方 @deepseek-ai/dsh 的新版本，不提供「检查更新」菜单/托盘入口，也不做客户端自更新。新版本请从 Releases 页手动下载安装包替换；插件与配置格式与 4.4.0 完全兼容，升级/降级不破坏 `DSH_HOME` 数据。
- **内置插件上游更新检查仍保留**（设置 → 插件 → 更新）：仅针对随包分发的 4 个社区插件（`dsh-better-sidebar`、`@sanqi-normal/dsh-webui-market-plugin`、`dshmarket`、`dsh-undo-savepoint`），默认只提示不下载（24h 节流），可手动更新。

## 界面皮肤

- 设置页新增「皮肤」标签页：内置 9 款 Web UI 皮肤，卡片式网格展示（名称/简介/主色/作者/出处与许可角标），当前皮肤高亮。
- **默认皮肤即"不启用任何皮肤"**（原生外观）：9 款皮肤默认全部以 `disabled: true` 注册，无需改动即可保持默认外观；选中某款后其余自动禁用（互斥切换），「恢复默认皮肤」一键还原。
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

- 皮肤来源与版权：dsh-web-ui 九款皮肤包随包分发 `LICENSE`（BSD-3-Clause，出处/作者字段见皮肤卡片与包内元数据）。各皮肤包的 `LICENSE`/`README` 随同步一并分发到 web profile 的 `node_modules` 中。

## 内置插件（v4Lite）

以下 11 个插件随安装包分发（`assets/plugins/`），每次启动自动同步进 web profile 并幂等注册；启动时的 heal 流程会自动清理模块双实例遮蔽包。

| 插件 | 功能 | 设置入口 |
| --- | --- | --- |
| `dsh-webui-market` | 社区插件市场：浏览 awesome-dsh-plugin.com 收录的全部插件，一键安装/卸载（含安装前试启动探测）；目录中已被客户端内置的插件显示「已内置」徽标并拒绝重复安装 | 设置 → 插件 → 插件市场 |
| `dsh-plugin-marketplace` | 第二插件市场（npm 检索）：搜索 npm 上的 dsh 插件并一键安装（跑在桌面专属 profile，与原版完全隔离） | 设置 → 插件 → 插件市场 |
| `dsh-market` | 第三插件市场（github.com/dsh-market/dsh-market，MIT）：1250+ 社区插件目录、主题一键切换即时生效、备份/ WebDAV / Gist 同步恢复、插件级更新与自更新渠道管理 | 设置 → 插件市场 |
| `dsh-plugin-manager` | 插件启停管理：列出配套/用户/核心插件与启用状态，不重启切换启停；核心组（启停管理/保护中心）拒绝移除 | 设置 → 插件 → 管理 |
| `dsh-plugin-shield` | 插件保护中心 UI：快照列表/一键回滚/健康检查/事故报告，经桌面壳 IPC（`guard:action`）驱动 plugin-guard.js 引擎 | 设置 → 插件 → 保护中心 |
| `dsh-skin-switch` | 皮肤切换（见「界面皮肤」）：列出/切换/恢复 9 款内置皮肤 | 设置 → 皮肤 |
| `dsh-offpeak` | 峰谷价格卫士（christophersmith2737-commits，MIT）：DeepSeek 峰谷定价（2026-08-17 起）高峰时段（北京时间 9-12 / 14-18 点）发送前拦截提醒，可一键继续或定时到闲时价自动执行；浏览器端显示当前时段高峰/闲时价目 | 发送栏（自动出现）+ 设置 → 插件 → 管理 |
| `dsh-balance` | 余额小部件（官方私有包，随包分发）：对话底部统计条下方的余额/会话费用估算 + 峰谷定价时段条（高峰中/空闲中 · 还剩 X 时 X 分 倒计时）+ 设置页「价格设置」（自定义各模型 ¥/百万 token 价档） | 对话输入区下方（自动出现）+ 设置 → 价格设置 |
| `dsh-undo-savepoint` | 崩溃急救与撤销：配置文件 + 插件代码树快照、undo/redo、一键安全模式、密钥脱敏 vault | 对话顶部 undo/redo 按钮 + 快照面板 |
| `dsh-better-sidebar` | VSCode 风格右侧边栏：文件树 / 编辑器 / 终端 / Git，按会话隔离（lib/ 预编译自包含，codemirror、xterm 已内嵌） | 右侧边栏 |
| `dsh-auto-compact` | 自动压缩：监听 contextPressure 投影，接近上下文上限（默认 80%）时自动向当前会话发送 `/compact`（dsh 原生命令，压缩事务由内核执行） | 随包自动启用 |

> **Windows 文件锁排队**：运行中的 Web 服务加载着原生模块（sqlite-vec 等 DLL）时，插件安装/卸载会遇到 `EPERM` 文件锁 —— 任务会自动排队（`.dsh-market-pending.json`），下次服务重启前（无锁窗口）自动完成，市场界面提供「立即重启并完成」按钮。
>
> **内置插件上游更新源**（仅登记仍在 npm / GitHub 发布的插件，EAC 独占私有包绝不登记；运行时 npm 404 优雅降级为「无上游」）：`dsh-better-sidebar`（npm）、`@sanqi-normal/dsh-webui-market-plugin`（npm）、`dshmarket`（npm）、`dsh-undo-savepoint`（GitHub lire1131）。

## 退出行为三档

标题栏「⋯」菜单 →「关闭窗口时」：**每次询问 / 后台运行（最小化到托盘）/ 直接退出**。选「每次询问」时点关闭弹窗（「最小化到后台 / 退出程序」+「记住我的选择」勾选），旧版 `closeToTray` 布尔设置自动迁移。配置存于 `<userData>/settings.json` 的 `exitAction`。

## 与 EAC 4.4.0 的差异（v4Lite 移除清单）

| 移除项 | 说明 |
| --- | --- |
| 多窗口/会话浮窗 + 侧边临时会话（Ctrl+Shift+S） | `float-window` / `side-session` 相关 IPC、`guardFloatWebContents`、chrome 菜单项全部摘除 |
| 余额小部件（dsh-balance） | 保留：余额查询、价格档、时段倒计时、统计栏内联展示与 4.4.0 一致 |
| 文件更改追踪 + 一键还原 + AI 变更审核（dsh-file-changes / dsh-change-review） | 「文件」标签页与相关 host 插件移除 |
| 会话内终端（dsh-terminal） | 「终端」标签页与 mini-REPL 宿主路由移除 |
| 会话完成系统通知（session-watcher.js） | 通知监听、`notifyOnTurnEnd` 开关、菜单项移除 |
| 客户端自更新（client-updater.js） | 检查/下载/替换/崩溃自回退全部摘除，`repoUrls()` 固定上游 |
| 官方 dsh agent 更新（updater.js 链路） | 「检查 dsh 更新」菜单/托盘入口、启动定时检查、更新进度窗全部摘除（updater.js 仅保留 settings/overlay 工具职责） |
| 会话删除与归档管理（dsh-session-manager） | 运行时补丁 `applySessionManageFix` / `patchApiproxyBridgeNamespace` 移除 |
| 微信 ClawBot / OpenClaw 桥（dsh-openclaw-bridge） | 设置页 ClawBot 栏移除 |
| 一键迁移（dsh-easy-setup） | 设置项与配套插件移除 |
| 桌宠（dsh-pet / dsh-dafeiyu） | 两套桌宠及素材移除 |
| 长期记忆（dsh-tdai-memory） | 设置 → 长期记忆移除 |
| soul.md 人设卡（dsh-soul-md） | 人设卡编辑器移除，heal 链路不再修补 soul 行 |
| 外置视觉模型（dsh-tool-vision） | `inspect_image` 视觉端点配置移除 |
| 对话回退/微调/提示词/思考控件（dsh-message-rewind 等） | 相关社区插件不随包分发（仍可经插件市场自行安装） |
| 移动端适配修复（dsh-web-mobile-fix） | 移除 |
| 内置 Skills 分发（eac-desktop-tips） | `assets/skills/` 清空 |
| 浮窗皮肤 maid-atelier（CC BY-NC-SA 4.0） | 皮肤数 10 → 9 |
| 便携版目标 | 仅 NSIS 安装版；`patch-portable-template.js` / 便携缓存目录 / `warnTempRun` 移除 |
| 内置插件选择向导（onboarding） | 首次启动向导窗口、设置页「选择向导」二次入口、`dsh-plugin-wizard` 插件、`scripts/onboarding.js` 全部移除；内置插件默认全量启用，核心组（启停管理/保护中心）仍拒绝移除 |

插件与配置格式与 4.4.0 完全兼容：插件、配置、会话均可复用，升级/降级不破坏数据。

## 与原版 4.4.0 的隔离（可并行安装、同时运行）

- **数据主目录独立**：v4Lite 默认使用 `~\.dsh-v4lite`（`DSH_HOME`），绝不触碰原版 / dsh CLI 的 `~\.dsh` —— 两端同时运行时各自维护独立的 web profile（`cordis.patch.yml` / `node_modules`），互不踩踏。显式设置环境变量 `DSH_HOME` 可覆盖此默认。
- **应用数据独立**：v4Lite 安装版数据目录 `%APPDATA%\Deepseek Harness EAC v4Lite`（与原版 `%APPDATA%\Deepseek Harness EAC` 不同）；单实例锁随 userData 隔离，两端可并行运行。
- **快捷方式与标识独立**：开始菜单/桌面快捷方式名为 `Deepseek Harness EAC v4Lite`，AppUserModelId 为 `com.deepseek.dsh.desktop.lite`，不覆盖原版快捷方式。
- 注意：两端各自拥有独立 `DSH_HOME`，**API Key / 会话不会自动共享**；如需沿用原版配置，请把 `~\.dsh\settings.yaml`（或其中的 API Key 配置）复制到 `~\.dsh-v4lite\settings.yaml`。

## 从源码构建

要求：Windows + Node.js（仅构建机需要）+ npm。

```powershell
npm install                    # 安装 dsh / electron / electron-builder
npm run fetch-runtime          # 内置 node.exe + npm CLI（构建与开发都需要）
npm start                      # 开发模式启动（窗口内跑 Web UI）
npm run dist                   # 构建 NSIS 安装包，输出到 dist/
npm test                       # 运行回归测试套件（259 项）
```


## Deepseek Harness EAC IDE（内置插件版独立 IDE）

> **🎉 已正式发布**：独立 IDE 仓库 [zouyuxuan122/Deepseek-Harness-EAC-IDE](https://github.com/zouyuxuan122/Deepseek-Harness-EAC-IDE)
> —— 产品介绍、截图与 [下载（ide-v1.0.0：安装器 / 绿色版 zip）](https://github.com/zouyuxuan122/Deepseek-Harness-EAC-IDE/releases)。

在 vscode-plugin 分支上，可以把 `vscode/` 扩展与 dsh 运行时组装成一个**内置插件的独立 IDE**
（类似 Trae）：基于 VS Code 1.134 底座，插件作为内置扩展（`resources/app/extensions/dsh-eac-vscode`）、
运行时资产捆绑在扩展目录内（`runtime/`，含 desktop-core / dsh 内核 / 内置 Node），启动即用、无需安装扩展。

### 组装（三条命令）

```powershell
npm run ide              # scripts/make-ide.cjs —— 组装 dist-ide/Deepseek-Harness-EAC-IDE + zip
npm run ide:installer    # scripts/build-ide-installer.cjs —— 产出 NSIS 安装器
npm run verify:ide       # vscode/scripts/verify-ide.mjs —— 对产出的 IDE 跑端到端验证
```

底座来源（make-ide.cjs 自动探测，可用 IDE_BASE_ZIP 指定）：
- `vscode-fork/` 的 gulp 构建产物（`VSCode-win32-x64-1.134.0.zip`，完整源码级 fork：exe 名为
  applicationName、编译鲸鱼图标、product.json 全品牌）；或
- 官方 VS Code 1.134 二进制（无 MSVC 机器上的等效路径：product.json 运行时补丁改名，exe/图标保持官方）。

> 本机（C 盘满、无 MSVC）暂走官方二进制底座，功能与内置插件完全一致，仅 exe 名为 Code.exe。
> vscode-fork 已打完全部品牌补丁（product.json + 图标 + 内置扩展注入逻辑），具备 MSVC 的机器上
> `cd vscode-fork && npm ci && npm run gulp vscode-win32-x64` 即可产出全品牌 fork 底座。

### 安装器说明（长路径处理）

运行时闭包内含超过 260 字符的深路径（如 chromium-bidi 的 `out/Default/gen/...`，插件运行必需），
NSIS 无法直接打包 → 安装器采用「NSIS + runtime.7z」混合方案：7za 将 runtime 打成 runtime.7z，
NSIS 安装时解压回原位（7-Zip 原生支持长路径），卸载用 PowerShell 递归删除。

### 验证矩阵

| 验证 | 结果 |
|---|---|
| 仓库根回归 `npm test` | 286/286 通过 |
| 扩展单测 `vscode/ npm test` | 60/60 通过 |
| 扩展集成测试 `vscode/ npm run integration`（真实 VS Code，独立扩展形态） | 通过 |
| IDE 端到端 `npm run verify:ide`（内置扩展 + 捆绑运行时 + 真实 dsh 服务） | 通过 |
| GUI 冒烟（启动 IDE：标题栏/活动栏/DSH 面板/模型选择器） | 通过 |

> 网络受限时：Electron 二进制镜像 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`（可 `npm run electron:fetch` 手动补拉）；打包工具链镜像 `$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`。

## 架构

```
┌──────────────────────────────────────────────────────────┐
│  Electron 壳 (main.js)                                   │
│  · 单实例锁 / 窗口 / 菜单 / 生命周期                       │
│  · 内置插件同步 + 保护中心 (plugin-guard.js)               │
│  · spawn vendor|resources 里的 node.exe                   │
└──────────────┬───────────────────────────────────────────┘
               │  dsh web --host 127.0.0.1 --port 0
               ▼
       内置 node.exe + @deepseek-ai/dsh
       数据主目录：~/.dsh-v4lite（DSH_HOME，与原版隔离）
       输出 "dsh web: http://127.0.0.1:<port>"
               │  解析 URL，轮询 HTTP 200
               ▼
       原生窗口加载 Web UI（仅本机回环访问）
```

关键决策：

| 决策 | 原因 |
| --- | --- |
| `asar: false` | dsh 依赖 sharp / node-pty / koffi 等原生模块，必须以真实文件落盘 |
| 内置独立 node.exe + npm | 预编译原生模块 ABI 与安装时的 Node 版本绑定；Electron 内嵌 Node ABI 不同。内置同版本 node.exe 零配置保证一致，npm 供插件市场安装/更新使用。注意：electron-builder 复制 extraResources 时会剥掉嵌套 node_modules，npm 自己的依赖由 `afterPack` 钩子原样补拷（scripts/after-pack.js） |
| `npmRebuild: false` | 绝不为 Electron 重编译原生模块，否则内置 node.exe 反而加载不了 |
| `--port 0` + 解析 stdout | 由 OS 分配空闲端口，避免端口冲突；本机回环绑定不对外暴露 |
| 退出时 `taskkill /T /F` | dsh 会派生 pwsh 等子进程，按进程树整体回收 |
| 独立 `DSH_HOME`（`~/.dsh-v4lite`） | 与原版 4.4.0 / dsh CLI 完全隔离，两端可并行安装运行；dev 与打包版行为一致（postinstall 向内置 dsh 包声明 schemastery，BFS 为配套插件维护 fallback closure） |

## 日志与排障

- `desktop.log`：壳层日志（启动参数、端口、退出）
- `dsh-web.log`：dsh web 的完整 stdout/stderr

位置：`%APPDATA%\Deepseek Harness EAC v4Lite\logs\`。
菜单「⋯ → 打开日志目录」可直接打开。

常见问题：

- **Windows 提示"已保护你的电脑"（SmartScreen）**：成品未做代码签名。点「更多信息 → 仍要运行」，或在 PowerShell 里 `Unblock-File`。
- **首次启动慢**：dsh 首次引导独立 profile（`~\.dsh-v4lite`）需要数秒到数十秒，属正常现象。
- **端口被占**：应用自动使用空闲端口，无需手动处理。
- **v4Lite 无更新接口**：新版本从 Releases 页手动下载安装包替换即可；已装的旧版数据（`~\.dsh-v4lite`、`%APPDATA%\Deepseek Harness EAC v4Lite`）不受影响。

## 目录结构

```
dsh-desktop-lite/
├── main.js               # Electron 主进程（无边框窗口/托盘/自绘 chrome IPC + 内置插件同步/保护中心）
├── updater.js            # settings / overlay 路径工具库（更新引擎已摘除）
├── plugin-guard.js       # 插件保护中心引擎（快照 / 一键回滚 / 健康检查 / 事故报告）
├── plugin-manager-state.js # 插件启停状态读写（cordis.patch.yml）
├── plugin-updater.js     # 内置插件上游更新源消费
├── preset-sync.js        # 内置皮肤 / 插件 / 预设同步进 web profile
├── profile-module-heal.js# 插件目录双实例遮蔽清理
├── preload.js            # 沙箱预加载（自绘玻璃标题栏 + 窗口控制/菜单 IPC）
├── assets/               # 加载页、图标、托盘图标、配套 dsh 插件
│   ├── skins/            # 9 款 Web UI 皮肤包
│   └── plugins/          # 10 个内置插件（见「内置插件」），全部自动同步进 web profile
├── scripts/
│   ├── fetch-node.js     # 内置 node.exe 复制脚本
│   ├── fetch-npm.js      # 内置 npm CLI 复制脚本
│   ├── build-icon.ps1    # 生成应用图标（透明圆角蒙版）+ 托盘图标
│   ├── plugin-manager-patch.js # cordis.patch.yml 行级手术
│   └── patch-row-heal.js # 补丁行去重 / 配置行规整
├── build/icon.png        # electron-builder 图标源
├── vendor/               # 内置 node.exe / npm CLI（fetch-runtime 生成，不入库）
├── electron-builder.yml  # 打包配置（仅 Win x64；appId com.deepseek.dsh.desktop.lite）
└── dist/                 # 构建产物
```

## License

MIT。基于 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。

---

# Deepseek Harness EAC v4Lite (English)

A Windows desktop wrapper around [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness) — the **v4Lite edition**: float windows, client self-update, desktop pets, memory, persona card and other peripheral features removed; only the high-frequency core workflows are kept (the balance widget and off-peak price guard stay).

- ✅ No Node install needed: bundles an independent Node runtime and npm CLI
- ✅ Bundles the full `@deepseek-ai/dsh` CLI and its core plugins, offline-capable
- ✅ One-click launch: starts `dsh web` on a free port, loads into a native window when ready
- ✅ Frameless glass title bar (36px, rounded icon, drag, ⋯ menu, window controls), Ctrl+R / F12 / F11 shortcuts
- ✅ System tray residency with show / restart web service / quit
- ✅ Clean shutdown: bounded wait for the dsh process tree (graceful → force kill), no orphans
- ✅ Isolated data home (`DSH_HOME` = `~\.dsh-v4lite` by default): never touches the original EAC / dsh CLI `~\.dsh`, so both editions can be installed and run side by side
- ✅ No update interface at all: no official dsh update checks, no client self-update — new versions are manual installer swaps from Releases
- ✅ 9 Web UI skins (exclusive switch, off by default, restart to apply; attribution & licenses shipped)
- ✅ 10 bundled plugins (see table): webui market ×2, plugin shield, enable/disable manager, balance widget with peak/off-peak countdown, off-peak price guard, undo-savepoint crash rescue, VSCode-style sidebar, auto-compact, skin switch
- ✅ Crash rescue & undo (`dsh-undo-savepoint`): config/plugin snapshots, undo/redo, safe mode, key-redacted vault
- ✅ One-click error log copy on startup failure
- ✅ Shortcut auto-maintenance (per-target-exe, custom icon never overwritten)

**Differences from EAC 4.4.0** (all removed): multi-window / float sessions (Ctrl+Shift+S), file-change tracking / AI review / in-session terminal, session-completion notifications (`session-watcher.js`), client self-update (`client-updater.js`), official dsh agent update flow (`updater.js` chain: menu/tray entries, boot timers, progress window), portable target (NSIS only), built-in plugin selection wizard (first-run window + settings rerun entry + `dsh-plugin-wizard`), session delete/archive manager, ClawBot/OpenClaw bridge, one-click migration, pets (`dsh-pet` / `dsh-dafeiyu`), long-term memory (`dsh-tdai-memory`), soul.md persona card, external vision model (`dsh-tool-vision`), mobile-fix, bundled skills (`eac-desktop-tips`), and the maid-atelier skin (10 → 9).

**Isolation from the original 4.4.0** (install and run both side by side): separate data home (`~\.dsh-v4lite`), separate app data (`%APPDATA%\Deepseek Harness EAC v4Lite`), separate shortcuts / AUMID (`com.deepseek.dsh.desktop.lite`). API keys and sessions are NOT shared — copy `~\.dsh\settings.yaml` to `~\.dsh-v4lite\settings.yaml` if you want to reuse them.

**Quick start**: grab `Deepseek-Harness-EAC-Setup-x64.exe` from the [Releases](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/latest) page. Install to a pure-English path. Configure your API key in the UI.

**Build from source** (Windows + Node.js + npm required):

```powershell
npm install
npm run fetch-runtime
npm start        # dev mode
npm run dist     # NSIS installer → dist/
npm test         # 259 regression tests
```

**License**: MIT. Based on [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (MIT).