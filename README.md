<div align="center">

<p><a href="README.md">中文</a> | <a href="README.en.md">English</a></p>

<h1>Deepseek Harness EAC — 揽尽万象</h1>

<p><strong>EAC = Embracing All Creation（揽尽万象）</strong></p>

<p>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC"><img src="https://img.shields.io/github/stars/zouyuxuan122/Deepseek-Harness-EAC?style=flat&label=%E2%AD%90&color=08C" alt="GitHub stars"></a>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases"><img src="https://img.shields.io/badge/Windows-10%2F11-4493F8?style=flat" alt="Windows"></a>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/tag/v4.4.0-linux"><img src="https://img.shields.io/badge/Linux-pacman%2Fdeb%2Frpm%2FAppImage-178600?style=flat" alt="Linux"></a>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC"><img src="https://img.shields.io/badge/Desktop-App-47848F?style=flat" alt="Desktop App"></a>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
</p>

<p>把官方 <a href="https://github.com/deepseek-ai/deepseek-harness">deepseek-ai/deepseek-harness</a>（<code>@deepseek-ai/dsh</code>，一切皆插件的 agent harness）
封装为<strong>开箱即用的 Windows / Linux 桌面客户端</strong>，并在其上拥抱社区万象：皮肤、插件、工具、记忆——你所能想到的，一键皆可装。</p>

<p><a href="docs/screenshot-preview.jpg"><img src="docs/screenshot-preview.jpg" alt="Deepseek Harness EAC 界面预览"></a></p>

</div>

---

## 相比原版 DeepSeek Harness 的优势

| 能力 | 原版 dsh（官方 deepseek-harness） | Deepseek Harness EAC |
| --- | --- | --- |
| 运行方式 | 需先安装 Node.js，`npx @deepseek-ai/dsh web` + 浏览器访问 | **免装 Node**：内置独立 Node 运行时与 npm CLI，双击即用 |
| 与 CLI 共存 | —（本体） | **桌面专属 profile（web-desktop）**：插件树/pnpm/patch 层与原生 CLI 完全隔离，会话与 API Key 依旧共享；共享 junction 归属自动守卫修复，互不打扰 |
| 插件安全 | 手动 npm，装坏自负 | **内置插件保护中心**：安装/启动前自动快照、启动失败自动体检修复、必要时回滚到最后良好快照，事故报告全程留痕（融合三大社区保护插件并内置升华） |
| 界面皮肤 | 仅官方默认外观 | **内置 10 款 Web UI 皮肤**（XP / QQ98 / 初音未来 / 我的世界 / 同花顺 / 鲸歌…），设置页一键互斥切换，默认不启用保持原生 |
| 字体外观 | 无 | 设置页「外观 · 字体与颜色」：**字体家族/字号/文字与代码颜色**实时自定义，与皮肤同体系 |
| 窗口体验 | 浏览器标签页 | **原生无边框窗口**（自绘玻璃栏）+ **系统托盘常驻**，关闭不打断任务 |
| 便携性 | 无 | **便携版**数据跟随 exe，拷到 U 盘即用 |
| 余额查看 | 手动上官网查 | 对话底部内联「**本轮 ¥X · 余额 ¥Y**」实时小部件，点击跳转充值 |
| 文件管理 | 手动翻目录 | **会话文件更改追踪**（行级 diff）+ **一键还原**，全部/逐文件 |
| 会话内终端 | 无 | **终端标签页**：会话项目目录内持久 PowerShell，SSE 流式，断线重连 |
| 长对话 | 手动 /compact | **默认自动压缩**：接近上下文上限（默认 80%，可调）自动执行官方 /compact |
| 人设 | 手编 soul.md | 设置页「人设卡」：**6 张内置预设一键应用 + 我的卡片库** + 实时编辑热重载 |
| 配置上手 | 手编 YAML | **设置页可视化**：视觉模型一键选择、MCP 增删改 + **从 Claude Code / Codex 一键导入**、**从 Codex / Claude Code 一键迁移 skills + MCP + 记忆** |
| 插件安装 | 手动 npm | 设置页内置**插件市场**，搜索/一键安装/卸载 dsh 插件 |
| 更新 | 手动 `npm update` | **双重自动更新**：官方 agent 更新（npm overlay，失败可回退）+ 客户端本体自更新，均经用户同意 |
| 任务通知 | 无 | agent 任务完成弹 **Windows 系统通知**，点击回到窗口 |
| 系统要求 | Windows/macOS/Linux + Node.js 环境 | Windows 10/11、Linux x86_64（x64），**无需任何运行时** |

> 内核零改动：EAC 直接运行官方 `dsh web`，完整保留「一切皆插件」架构与全部官方能力，
> 与 CLI 共享 `DSH_HOME` 配置，已有会话/API Key 直接生效。

---

## 下载安装（部署方式）

### GitHub Releases（推荐）

> GitHub 无单文件大小限制，可直接下载完整安装包。

| 文件 | 说明 | 大小 |
| --- | --- | --- |
| [便携版 exe](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/latest/download/Deepseek-Harness-EAC-Portable-x64.exe) | 免安装，双击即用，可放 U 盘 | ~226 MB |
| [安装版 exe](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/latest/download/Deepseek-Harness-EAC-Setup-x64.exe) | 安装到系统，创建桌面/开始菜单快捷方式 | ~241 MB |

更多版本见 [Releases 页面](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases)。

### Linux（x64）

Linux 打包由社区开发者 [@Luoye-hb](https://github.com/Luoye-hb) 贡献（[PR #12](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/pull/12)），随 [v4.4.0-linux](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/tag/v4.4.0-linux) 发布，支持 **Arch / Ubuntu / Debian / Fedora** 与通用 AppImage：

| 发行版 | 包 | 安装 |
| --- | --- | --- |
| Arch Linux | [.pacman](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0-x64.pacman) | `sudo pacman -U ./Deepseek-Harness-EAC-4.4.0-x64.pacman` |
| Ubuntu / Debian | [.deb](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0-amd64.deb) | `sudo apt install ./Deepseek-Harness-EAC-4.4.0-amd64.deb` |
| Fedora | [.rpm](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0.x86_64.rpm) | `sudo dnf install ./Deepseek-Harness-EAC-4.4.0.x86_64.rpm` |
| 通用 | [.AppImage](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0-x86_64.AppImage) | `chmod +x` 后直接运行 |

> - 卸载：`pacman -Rns dsh-desktop` / `apt remove dsh-desktop` / `dnf remove dsh-desktop`
> - 与 Windows 版一致：内置 Node.js 与 npm CLI，目标机器无需预装 Node.js；数据目录沿用 `~/.dsh`（`DSH_HOME`）
> - Linux 版由系统包管理器管理升级，不走应用内自更新；安装到仓库根 `linux` 分支源码可自行构建

> ⚠️ **务必安装/放置到纯英文路径**（默认 `C:\Users\<你>\AppData\Local\Programs\` 即可）：中文路径（如 `D:\迅雷下载\`）会触发 Chromium 渲染进程原生崩溃，窗口弹出数十秒后自动退出。

**首次使用**：

1. 双击运行，显示启动动画，随后自动加载 DeepSeek Harness Web UI（原生窗口，仅本机回环访问）。
2. 如尚未配置 API Key，在界面「设置」内完成配置即可开始使用（与命令行 dsh 完全一致）。
3. 常用入口：设置 → 皮肤（10 款内置皮肤切换）/ 插件市场 / 模型一键选择；对话区 → 终端 / 文件标签页。

> 便携版数据目录在 exe 旁的 `data\`；安装版在 `%APPDATA%\Deepseek Harness EAC\`。
> 想强制指定 DSH 配置目录？启动前设置环境变量 `DSH_HOME` 即可（与 dsh CLI 行为一致）。

### 升级部署

- **客户端本体**：启动后自动检查上游新版本（GitHub Releases 双源回退），经你同意后下载安装；便携版原地替换自动重启，安装版引导新安装包。失败自动保留当前版本。
- **官方 agent（dsh）**：自动检测 `@deepseek-ai/dsh` 新版本，同意后安装到数据目录 overlay，原子切换，新版启动失败可一键回退内置版本。
- 也可直接下载上方最新安装包覆盖安装，数据不会丢失；v2.0 起安装器在卸载旧版前自动结束运行中的新旧进程，覆盖安装不再报 "Failed to uninstall old application files"。

---

## 功能一览

### 界面皮肤自定义（EAC 特色）

- 设置页「皮肤」标签页内置 **10 款 Web UI 皮肤**，卡片式网格展示（名称/简介/主色/作者/出处与许可角标）。
- 9 款来自社区 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)（BSD-3-Clause）+ 1 款 [dsh-deep-whale 深海女仆工坊](https://github.com/Small-tailqwq/dsh-deep-whale)（CC BY-NC-SA 4.0，禁止商用）。
- **默认不启用任何皮肤**（原生外观）；选中某款后其余自动禁用（互斥切换），「恢复默认皮肤」一键还原；切换后自动重启 Web 服务生效。
- 皮肤是 browser-only 的 dsh client 插件，由桌面端同步进 web profile 并幂等注册到 `cordis.patch.yml`，完整版权署名随包分发。

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

### 开箱即用

- **免装 Node**：内置独立 Node 运行时与 npm CLI，目标机器无需安装 Node.js
- **内置 dsh CLI**：完整打包 `@deepseek-ai/dsh` 及全部官方插件，离线可用
- **一键启动**：双击即启动 `dsh web`，自动挑空闲端口，就绪后加载到原生窗口
- **与 CLI 共享配置**：默认沿用 `DSH_HOME`（通常 `~\.dsh`），已有会话/API Key 直接生效
- **便携版**：数据跟随 exe 所在目录，拷到 U 盘就能用

### 桌面体验

- **风格化无边框窗口 + 系统托盘**：无原生标题栏/菜单栏，自绘玻璃栏（圆角图标、⋯ 菜单、窗口控制），Win11 圆角；关闭默认隐藏到托盘
- **退出即清理**：退出应用自动结束 dsh 进程树，不留孤儿进程
- **快捷方式自动维护**：便携版自动创建/修复桌面与开始菜单快捷方式（exe 移动后自愈）
- **会话完成通知**：agent 任务跑完时弹 Windows 系统通知，点击回到窗口

### 效率工具（配套插件体系）

- **插件保护中心（v3.1 新增，内置 plugin-guard 引擎）**：融合社区三大保护插件
  （[lxzy-7/dsh-plugin-guard](https://github.com/lxzy-7/dsh-plugin-guard) 快照回滚、
  [LX2000WASD/dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager) 安装守卫、
  [chenw2759-wq/dsh-plugin-healthcheck](https://github.com/chenw2759-wq/dsh-plugin-healthcheck) 静态体检）
  并内置到桌面壳：每次安装与启动前自动快照 profile 配置（保留 10 份）；启动失败自动
  体检（模块遮蔽 / patch 行 / junction 归属 / 高危静态扫描）→ 修复 → 重试 → 回滚到
  最后良好快照 → 事故报告；设置页「插件保护」可手动快照 / 回滚 / 体检 / 修复。
- **与原生 CLI 完全共存（v3.1 根治）**：桌面端运行在专属 `web-desktop` profile
  （会话/API Key 仍共享 DSH_HOME），插件树互不干扰；共享模块 junction 的归属自动
  巡检修复，原生 `npx dsh` 与桌面端交替使用不再互相破坏。
- **外观自定义（v3.1 新增，dsh-font-custom）**：设置页「外观 · 字体与颜色」——
  界面/代码字体、字号、文字与代码颜色实时自定义，localStorage 持久化。
- **自动压缩（v3.1 新增，dsh-auto-compact，默认开启）**：对话接近上下文上限
  （默认 80%，可调）时自动执行官方 `/compact`，空闲触发、失败静默重试。
- **人设卡完整管理（v3.1 升级）**：设置页「人设卡」——6 张内置预设一键应用、
  我的卡片库（保存/应用/删除）、当前卡片实时编辑热重载。
- **MCP 一键导入（v3.1 升级，dsh-dock-settings）**：MCP 管理页新增「从 Claude /
  Codex 导入」，勾选合并 `~/.claude.json` 与 `~/.codex/config.toml` 的 MCP 服务器。
- **DeepSeek 余额小部件**：对话底部统计栏显示「本轮 ¥X · 余额 ¥Y」，点击跳转充值，15 分钟自动刷新
- **文件更改追踪 + 一键还原**：「文件」标签页查看本会话全部文件改动（新建/修改/删除 + 行级 diff）并逐文件/全部还原；数据只读复用会话日志，稳定不受升级影响
- **会话内终端**：「终端」标签页在当前会话项目目录启动持久 PowerShell（SSE 流式、命令历史、断线重连），中文编码干净
- **项目文件树 + HTML/端口预览**：VSCode 风格文件树，站内预览 HTML/本地端口服务（仅回环）
- **社区插件市场（v2 新增，dsh-webui-market）**：设置 → 插件 → 市场，浏览 awesome-dsh-plugin.com 收录的 dsh 插件并一键安装/卸载到 profile；安装/卸载任务在服务重启窗口期排队执行，不打断当前会话
- **外置视觉模型（v2 新增，dsh-tool-vision）**：`inspect_image` 工具把本地图片或图片 URL 发给任意 OpenAI 兼容视觉端点（qwen-vl / GLM-4V / Ollama 等），看图回答直接带回对话
- **长期记忆（v2 新增，dsh-tdai-memory）**：腾讯云 Agent Memory 移植 —— L0 对话捕获 → L1 结构化记忆 → L2 场景 / L3 画像，自动召回注入 + 记忆/对话搜索工具，复用现有 `~/.memory-tencentdb/memory-tdai` 数据
- **soul.md 人设热重载（v2 新增，dsh-soul-md）**：markdown 人设文件注入系统提示词（`soul:persona`），文件变更即时热重载，Agent 边干活边角色扮演
- **移动端布局修复（v2 新增，dsh-web-mobile-fix）**：窄屏（≤400px）下设置面板、弹窗、侧栏、会话头布局修复，纯前端 CSS，不影响桌面布局
- **快速配置（dsh-easy-setup）**：视觉模型提供商/模型一键选择、`soul.md` 人设可视化编辑、从 Codex / Claude Code 目录一键迁移 skills + MCP + 记忆
- **双重自动更新**：官方 dsh agent 更新（npm overlay）+ 客户端封装自更新，均经用户同意，失败自动回退
- **稳定性自愈**：`profile-module-heal` 自动修复 profile 模块遮蔽问题（真实目录与 pnpm 链接双形态，如 `prompt section already registered`、「设置命名空间不可用」、模型列表/模式切换失效）；`plugin-guard` 守护启动失败链路（体检 → 修复 → 回滚 → 事故报告）；重启服务时等待旧进程完全退出（释放文件锁）再启动新服务，插件包（含自带 vendor 依赖）随安装包原样分发
- **临时对话（v4 新增，dsh-side-session）**：DSH 临时会话：独立悬浮窗，自动导入当前主对话上下文，发起不污染主会话的临时追问
- **自定义第三方模型思考强度（v4 新增，dsh-third-party-thinking）**：让接入的第三方模型也能在使用时调整思考强度
- **对话节点导航条（v4 新增，dsh-navbar）**：user 消息快速跳转
- **微信ClawBot**(v4.1新增)：一键将Deepseek-Harness-EAC接入ClawBot

---

## 系统要求

- Windows 10/11（x64）
- Linux x86_64（Arch / Ubuntu / Debian / Fedora，或任意支持 AppImage 的发行版）
- 无需预装 Node.js 或任何其他运行时

## 从源码构建

```powershell
cd dsh-desktop
npm install
npm run fetch-runtime    # 内置 node.exe + npm CLI
npm run dist             # 构建 portable + NSIS 安装包 → dist/
```

> 网络受限时：Electron 镜像 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`；打包工具链镜像 `$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`。

运行测试：

```powershell
npm test                 # node --test test/*.test.mjs
```

## 架构

```
┌──────────────────────────────────────────────────────────┐
│  Electron 壳 (main.js)                                   │
│  · 单实例锁 / 窗口 / 菜单 / 生命周期                       │
│  · 会话完成监听 (session-watcher.js) → 系统通知            │
│  · 官方更新 (updater.js) → 用户同意后安装 overlay          │
│  · 客户端自更新 (client-updater.js) → 下载/替换/重启       │
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

## 目录结构

```
dsh-desktop/                  # Electron 桌面端
├── main.js                   # Electron 主进程
├── updater.js                # 官方 dsh agent 更新引擎
├── client-updater.js         # 客户端本体自更新引擎
├── balance.js                # DeepSeek 余额查询
├── session-watcher.js        # 会话完成监听
├── plugin-guard.js           # 插件保护中心引擎（快照/回滚/体检/修复/守护启动/事故报告）
├── profile-module-heal.js    # profile 模块遮蔽自愈（真实目录 + pnpm 链接）
├── preload.js                # 沙箱预加载
├── assets/                   # 加载页、更新进度页、图标、皮肤、配套插件
│   ├── skins/                # 10 款内置 Web UI 皮肤
│   └── plugins/              # 桌面壳配套：dsh-balance / dsh-file-changes / dsh-terminal
│                             # / dsh-easy-setup / dsh-skin-switch
│                             # 内置社区插件：dsh-webui-market / dsh-tool-vision
│                             # / dsh-tdai-memory / dsh-soul-md / dsh-web-mobile-fix
│                             # （含 vendor 与自包含运行时依赖，随仓库分发）
├── scripts/                  # 构建与开发辅助脚本
├── build/icon.png            # electron-builder 图标
├── vendor/                   # 内置 node.exe / npm CLI（不入库）
├── electron-builder.yml      # 打包配置
└── dist/                     # 构建产物（不入库，发布到 Releases）
openclaw-dsh-bridge/          # 微信桥接插件（可选，研究性质）
research/                     # 第三方微信/桥接协议调研资料
```

## Contributors

- [@zouyuxuan122](https://github.com/zouyuxuan122) — 项目发起者与维护者
- [@Luoye-hb](https://github.com/Luoye-hb) — Linux 多发行版打包支持（[PR #12](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/pull/12)）

## License

MIT。基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）。内置皮肤版权归原作者所有（见上方皮肤许可表）。
