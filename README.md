<div align="center">

[中文](README.md) | [English](README.en.md)

<h1>DSH-Desktop-EAC — 揽尽万象</h1>

***EAC = Embracing All Creation（揽尽万象）***

![Stars](https://img.shields.io/github/stars/zouyuxuan122/Deepseek-Harness-EAC?style=for-the-badge&label=%E2%AD%90Star&color=08C&link=https://github.com/zouyuxuan122/Deepseek-Harness-EAC) ![MIT License](https://img.shields.io/badge/license-MIT-2EA44F?style=for-the-badge&link=https://github.com/zouyuxuan122/Deepseek-Harness-EAC/blob/main/LICENSE)

![QQ](https://img.shields.io/badge/QQ-1083832019-blue?style=plastic&logo=qq&logoSize=auto&link=https://qm.qq.com/q/vqXxQQ3rmo) ![Discord](https://img.shields.io/badge/DISCORD-DSH--EAC-blue?style=plastic&logo=discord&logoSize=auto&link=https://discord.com/invite/kY48Ah8h)

> [!IMPORTANT]
> 本项目正在进行重大重构，在重构期间不接受外部Issues和PR。详情请关注[任务看板](https://github.com/orgs/DSH-EAC/projects/1/views/1)
> v5剩余的Bug将不再进行修复，我们会尽快推出v6全面替代v5的功能。
> 敬请期待。

> [!NOTE]
> 以下为v5版本的README

**🚀 全新产品：[Deepseek Harness EAC IDE](https://github.com/zouyuxuan122/Deepseek-Harness-EAC-IDE) —— 内置 EAC 的独立 IDE · 开箱即用 · [前往下载 →](https://github.com/zouyuxuan122/Deepseek-Harness-EAC-IDE/releases)**

封装了官方[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，**开箱即用的桌面客户端**。
在其之上拥抱社区万象：皮肤、插件、工具、记忆——**你所能想到的，一切皆可装**。

![DSH-Desktop-EAC 界面预览](docs/screenshot-preview.jpg)

</div>

> ### 📦 v5.4 起：唯一的桌面发行版，安装时选「完整版 / 精简版」
>
> 同一个安装包、同一套 5.x 内核：**完整版**带全部内置插件；**精简版**只默认停用外围插件（桌宠 / 手机桥 / 多智能体等），设置里可随时一键启用，无需重装。
> 原 **Lite（Electron 精简版）退役**、**AIO 整合版收编为精简版形态**、**EAC-IDE 进入维护模式**——数据统一 `~/.dsh`。迁移说明见 [docs/SINGLE-EDITION-MIGRATION.md](dsh-desktop/docs/SINGLE-EDITION-MIGRATION.md)。

---

> ### 🚀 官方配套启动器：DSH EAC Launcher
>
> **多实例隔离 · 本地实例导入 · 版本一键升级/回退 · 插件安全体系**（崩溃守卫 crash-guard · 插件快照回滚 · 隔离区 · 健康体检）
>
> 为本项目的多实例与插件玩法而生：每个实例独立程序目录与 `DSH_HOME`，从上游 Release 一键安装任意版本，装插件崩了也能一键回滚。
>
> 👉 **[zouyuxuan122/DSH-EAC-Launcher](https://github.com/zouyuxuan122/DSH-EAC-Launcher)** ｜ [⬇ 下载最新版 v1.1.0](https://github.com/zouyuxuan122/DSH-EAC-Launcher/releases/latest)

## 目录

- [为什么选择 EAC](#为什么选择-eac)
- [快速开始（安装）](#快速开始)
- [功能一览](#功能一览)
- [社区与支持](#社区与支持)
- [开发者文档](#开发者文档)
- [致谢](#致谢)
- [Star 趋势](#star-趋势)
- [许可证](#许可证)

---

## 为什么选择 EAC

| 维度         | 官方 DeepSeek Harness 默认体验      | DSH-Desktop-EAC 增强                                                          |
| ------------ | ----------------------------------- | ----------------------------------------------------------------------------- |
| 安装与启动   | 需自行准备 Node.js，并通过 CLI 启动 | 内置 Node.js、npm CLI 和 dsh，提供安装版与便携版，双击即用                    |
| 桌面体验     | 主要在终端或浏览器中使用            | 原生桌面窗口、系统托盘、快捷方式维护、进程清理和任务通知                      |
| CLI 共存     | CLI 与 Web 通常使用同一插件环境     | 桌面端使用独立 `web-desktop` profile，与 CLI 共享会话和 API Key，插件互不干扰 |
| 插件可靠性   | 主要通过包管理器安装并手动排查问题  | 安装和启动前自动快照，异常时支持体检、修复、重试、回滚和事故报告              |
| 界面定制     | 默认使用官方界面                    | 内置 10 款皮肤，支持字体、字号、颜色和移动端布局调整                          |
| 项目工具     | 依赖外部编辑器和终端                | 内置文件树、行级 diff、一键还原、持久终端及 HTML/本地端口预览                 |
| 上下文与人设 | 手动执行 `/compact`、编辑人设文件   | 自动压缩、人设卡管理和 `soul.md` 热重载                                       |
| 模型与 MCP   | 主要通过配置文件或 CLI 管理         | 可视化配置视觉模型和 MCP，并支持从 Claude Code、Codex 导入配置                |
| 插件生态     | 通过 CLI 或包管理器安装插件         | 内置插件市场，可搜索并一键安装、卸载和管理插件                                |
| 会话效率     | 以常规会话流程为主                  | 支持临时对话、对话节点导航和第三方模型思考强度调整                            |
| 消息接入     | 默认不包含 EAC 消息桥接             | 支持一键接入微信 ClawBot / OpenClaw                                           |
| 更新维护     | 通过包管理器或手动方式更新          | dsh agent 与桌面客户端分别自动检查更新，失败时保留或回退原版本                |

> EAC 不修改官方 dsh 内核，完整保留插件架构和官方能力；默认共享
> `DSH_HOME` 中的会话与 API Key，同时隔离桌面端插件环境。

---

## 快速开始

### 系统要求

- Windows 10/11（x64）
- macOS 13+（Apple Silicon / arm64，桌面版）
- 无需预装 Node.js 或任何其他运行时

### Windows

> 当前发布线为 5.x（Tauri/Rust 壳）。5.2 起桌面版统一为 Tauri 壳；更早的 v4.4.1 Electron 版已退役（仅 Release 存档）。安装包直接从 Release 下载。

| 文件                                                                                                                                        | 说明                                                                                                                                                    | 大小    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [安装版 Setup（v5.3.6）](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/download/v5.3.6/Deepseek-Harness-EAC-5.3.6-Setup-x64.exe) | Tauri 壳安装版（NSIS），安装到系统并创建快捷方式；SHA256 校验文件随 [Release](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/tag/v5.3.6) 提供 | ~191 MB |
| [便携版（v5.3.6）](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/download/v5.3.6/Deepseek-Harness-EAC-5.3.6-portable.zip)        | 免安装压缩包，解压到任意目录即可运行；数据跟随程序目录，可直接迁移                                                                                      | ~228 MB |

更多版本见 [Releases 页面](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases)。

### AIO 版（Windows x64 · All-in-One）

> **DSHEAC AIO** 是独立于 5.x 主线的 **All-in-One 精致个人终端**：一个安装包备齐 dsh 内核、插件市场与完整桌面体验，开箱即用；与正式版相互隔离（独立 app data 与 `dsh-home`，默认不读取 5.x / v4Lite / 旧 EAC 或 CLI 数据），可并存安装。当前版本 **AIO v1.2.0**（源码分支 `aio-v1`，随 [aio-v1.2.0 Release](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/tag/aio-v1.2.0) 一同发布）。

| 文件                                                                                                                                         | 说明                                                                                   | 大小    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------- |
| [AIO 安装版（v1.2.0）](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/download/aio-v1.2.0/DSHEAC-AIO-v1.2.0-Setup-x64.exe)         | NSIS 安装版，安装到系统并创建快捷方式；EXE 为 `DSHEAC AIO.exe`，与正式版更新器互相隔离 | ~313 MB |
| [AIO 便携版（v1.2.0）](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/download/aio-v1.2.0/DSHEAC-AIO-v1.2.0-Portable-x64.zip)      | 免安装解压即用，数据写入 EXE 同级 `.dsh-aio-data`，可直接迁移                          | ~147 MB |
| [校验清单 SHA256SUMS-AIO-v1.2.0.txt](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/download/aio-v1.2.0/SHA256SUMS-AIO-v1.2.0.txt) | AIO 资产 SHA-256 校验                                                                  | —       |

- 安装包尚未 Authenticode 签名，SmartScreen 可能提示未知发布者；运行前请先核对 SHA-256。
- 客户端自更新不在 AIO 中提供，插件自动更新默认关闭；安装路径建议不超过 120 个字符。
- **v1.2.0 要点**：内核对齐官方桌面端 `0.1.3-alpha.2`，插件接口随内核迁移修复，应用图标更换为 WhaleGirl，并移除已确认停用的插件与皮肤。
- **AIO 升级说明**：从旧版 AIO 覆盖安装时，仅继承旧版的会话与供应商配置，不继承旧版插件（内置插件随安装包更新）。

> 💡 **升级说明（老用户必读）**：
>
> - 直接下载上方最新安装包覆盖安装即可；
> - 插件、皮肤、会话与配置全部保留——数据在 `%APPDATA%\DSH-Desktop-EAC\`
>   与 `~/.dsh`，升级过程不触碰。

### macOS（Apple Silicon / arm64）

> macOS 桌面版与 Windows/Linux 同源同版本，随 [v5.1.0 Release](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/tag/v5.1.0) 一同发布。

| 文件                                                                                                                                            | 说明                        | 大小    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------- |
| [安装镜像 .dmg](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v5.1.0/Deepseek.Harness.EAC_5.1.0_macos-arm64.dmg)       | 双击挂载后拖入 Applications | ~136 MB |
| [应用包 .app.zip](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v5.1.0/Deepseek.Harness.EAC_5.1.0_macos-arm64.app.zip) | 解压后直接运行              | ~157 MB |
| [校验和 SHA256SUMS-macos.txt](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v5.1.0/SHA256SUMS-macos.txt)               | macOS 资产 SHA256           | —       |

- 桌面配置目录：`~/Library/Application Support/deepseek-harness-eac/`；dsh 数据仍在 `~/.dsh`（与 CLI 共享，会话互通）。
- 未签名、未公证（个人自用定位）：首次打开若被 Gatekeeper 拦截，右键 →「打开」。
- 客户端自更新在 macOS v1 暂不提供（上游 Release 暂无 macOS 资产）；dsh agent（内核）更新完整保留。

### Linux（x64）

> Linux 桌面端由 CI（Ubuntu 22.04）持续构建与验证；自 v5.3.6 起 AppImage 与 .deb 已并入统一版本线（当前 v5.3.6），.rpm/.pacman 仍由独立版本线提供（最近维护版 v4.4.0）。

| 文件                                                                                                                                                 | 说明                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| [.deb（Debian/Ubuntu，v5.3.6）](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/download/v5.3.6/Deepseek.Harness.EAC_5.3.6_amd64.deb)       | 安装后可从应用菜单启动        |
| [AppImage（v5.3.6）](https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/download/v5.3.6/Deepseek.Harness.EAC_5.3.6_amd64.AppImage)             | 免安装：`chmod +x` 后直接运行 |
| [.rpm（Fedora/openSUSE）](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0.x86_64.rpm) | —                             |
| [.pacman（Arch）](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0-x64.pacman)         | —                             |

- 依赖：Tauri 2 + webkit2gtk-4.1（debian 系安装 `libwebkit2gtk-4.1-dev` 等构建依赖见仓库 CI）；AppImage 自带运行时，构建基线 Ubuntu 22.04。
- 桌面配置目录：`~/.config/deepseek-harness-eac`（XDG）；dsh 数据仍在 `~/.dsh`（与 CLI 共享）。
- 剪贴板等系统集成依赖桌面环境的 `wl-copy`/`xclip`/`xsel`，通知依赖 `notify-send`；缺失时对应能力自动降级为「外部依赖」，不伪装成功。

### 首次使用

1. 双击运行，显示启动动画，随后自动加载 DeepSeek Harness Web UI（原生窗口，仅本机回环访问）。
2. 如尚未配置 API Key，在界面「设置」内完成配置即可开始使用（与命令行 dsh 完全一致）。
3. 常用入口：设置 → 皮肤（10 款内置皮肤切换）/ 插件市场 / 模型一键选择；对话区 → 终端 / 文件标签页。

### 数据目录

> 桌面端配置在 `%APPDATA%\DSH-Desktop-EAC\`（设置/更新缓存），dsh 数据
> 在 `~/.dsh`（`DSH_HOME`，会话与 API Key 与 CLI 共享）。安装版与便携版一致。
> 想强制指定 DSH 配置目录？启动前设置环境变量 `DSH_HOME` 即可（与 dsh CLI 行为一致）。

### 升级方式

- **客户端本体**：启动后自动检查上游新版本（GitHub Releases 双源回退），经你同意后下载安装；
  便携版下载整包后自动「目录树交换」并重启，安装版引导新 Setup 静默覆盖。
  失败自动保留当前版本。
- **官方 agent（dsh）**：自动检测 `@deepseek-ai/dsh` 新版本，同意后安装到数据目录 overlay，原子切换，新版启动失败可一键回退内置版本。
- 也可直接下载上方最新安装包覆盖安装，数据不会丢失。

---

## 功能一览

### 开箱即用与桌面体验

- **内置运行环境**：完整打包 Node.js、npm CLI、`@deepseek-ai/dsh` 及官方插件，无需额外安装运行时。
- **安装版与便携版**：双击启动并自动选择可用端口；便携版数据跟随程序目录，可直接迁移。
- **桌面集成**：提供原生窗口、系统托盘、快捷方式维护、进程清理和任务完成通知。
- **CLI 共存**：共享 `DSH_HOME` 中的会话与 API Key，桌面端使用独立 `web-desktop` profile，插件互不干扰。
- **自动更新**：分别更新 dsh agent 与桌面客户端，安装失败时保留或回退原版本。

### 开发工作流

- **文件树与预览**：浏览项目文件，并在应用内预览 HTML 和本地端口服务。
- **改动追踪与还原**：查看会话产生的文件变更和行级 diff，支持逐个或全部还原。
- **会话内终端**：在项目目录中使用持久 PowerShell，支持流式输出、命令历史和断线重连。
- **对话导航**：快速跳转到各条用户消息。
- **临时对话**：在独立悬浮窗中基于当前上下文追问，不污染主会话。

### 对话与模型

- **自动压缩**：上下文接近上限时自动执行 `/compact`，阈值可调，失败静默重试。
- **人设管理**：内置 6 张人设卡，支持保存、应用、删除、实时编辑和 `soul.md` 热重载。
- **图片理解**：通过 `picturereader` 分析本地或在线图片，并将结果直接带回对话。
- **MCP 与快速配置**：可视化管理 MCP，并可从 Claude Code、Codex 迁移 skills、MCP 和记忆。
- **第三方模型控制**：支持调整第三方模型的思考强度。
- **DeepSeek 余额**：显示本轮费用和账户余额，支持跳转充值及自动刷新。

### 插件与可靠性

- **统一插件市场**：通过 `dsh-unified-market` 聚合多个插件源，支持搜索、一键安装和卸载。
- **插件保护中心**：由 `dsh-plugin-shield` 配合内置 `plugin-guard` 引擎提供快照、体检、修复、重试、回滚和事故报告。
- **稳定性自愈**：自动处理 profile 模块遮蔽、插件启动异常和服务重启文件锁问题。
- **完整依赖分发**：内置插件及其自包含依赖随安装包分发，减少环境差异造成的故障。

### 界面与集成

- **界面定制**：内置 10 款社区皮肤，支持互斥切换、恢复原生外观以及字体、字号和颜色设置。
- **移动端适配**：优化窄屏下的设置面板、弹窗、侧栏和会话布局。
- **微信 ClawBot**：通过内置桥接插件一键接入微信 ClawBot / OpenClaw。

---

## 社区与支持

### 交流群

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/qq-group-qrcode.jpg" alt="dsh EAC QQ 交流群 3 二维码" width="320" />
    </td>
    <td align="center" width="50%">
      <img src="docs/wechat-group-qrcode.jpg" alt="dsh EAC 微信交流群二维码" width="320" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>QQ 交流群 3</strong><br />群号：1083832019</td>
    <td align="center"><strong>微信交流群</strong></td>
  </tr>
</table>

### Bug 与功能反馈

遇到 Bug，或有希望我们增加的功能，请前往 [https://eac.dtyg123.dpdns.org/](https://eac.dtyg123.dpdns.org/)。

---

## 开发者文档

### 从源码构建（Tauri 壳，v5.0 默认）

```powershell
cd dsh-desktop
npm install -g pnpm@11.7.0       # 内核构建依赖（版本由上游 packageManager 钉定）
node scripts/fetch-kernel.js     # 首次必须：自上游源码构建内核 tarball（vendor/ 不入库；网络受限环境需自行配置代理）
npm install                      # 内核 tarball 就位后依赖才能安装
npm run fetch-runtime            # 内置 node.exe + npm CLI
node ../tauri-shell/stage-resources.mjs   # 装配打包资源（sidecar + dsh-desktop 运行树）
cd ../tauri-shell
npx -y @tauri-apps/cli@2 build   # release 构建 + NSIS 安装包
node make-portable.mjs           # 便携 zip（可选）→ target/release/portable/

# 开发态（热迭代）：cargo run（Rust 工具链需 RUSTUP_HOME/CARGO_HOME）
```

> Rust 工具链：rustup + MSVC；NSIS 打包由 Tauri 自动下载（`%LOCALAPPDATA%\tauri\NSIS`）。
> 偶发 `makensis` mmap error（杀软放大触发）——重跑即可。

<details>
<summary>打包链（Tauri 三段链，从源码出安装包/便携包）</summary>

```powershell
cd dsh-desktop
npm install -g pnpm@11.7.0
node scripts/fetch-kernel.js     # 网络受限环境需自行配置代理
npm install
npm run fetch-runtime
# 打包（Tauri 三段链，产出入 tauri-shell/target/release/）
node ../tauri-shell/stage-resources.mjs     # 装配 staged-resources
cd ../tauri-shell
npx -y @tauri-apps/cli@2 build              # → bundle/nsis/*-setup.exe（含 sidecar 运行树）
node make-portable.mjs                      # → portable/*-portable.zip + SHA256SUMS.txt
```

</details>

运行测试：

```powershell
cd dsh-desktop
npm test                 # node --test test/*.test.ts（pretest 含 tsc 全量类型检查）
node ../gui-smoke.js     # Tauri 壳 GUI 冒烟（18 项，需先 cargo build）
node ../update-smoke.js  # 自更新链路冒烟（mock 发布源 + 目录树交换）
```

### 架构（v5.0：三层壳边界，ADR 0002）

```
┌──────────────────────────────────────────────────────────┐
│  L1 Rust 壳 (tauri-shell/src/main.rs)                    │
│  · 单实例锁 / 主窗+浮窗 / 托盘 / 退出策略                  │
│  · 壳层 WS 方法本地拦截（win.* / menu 壳动作 / 日志）       │
│  · 壳页 HTTP 路由（/loading /exit /died /update /about /wizard）│
│  · spawn sidecar（stdio JSON-RPC）+ WS 中继 127.0.0.1:19873│
└──────────────┬───────────────────────────────────────────┘
               │  stdio JSON-RPC（L1 ↔ L2）
               ▼
┌──────────────────────────────────────────────────────────┐
│  L2 Node sidecar (tauri-shell/sidecar/server.ts)          │
│  · 挂载 lib/desktop/* 全部模块 + boot-server 服务编排      │
│  · 桥方法面（chrome.init / balance / plugins / rescue /    │
│    client-update / onboard.* / menu.action …）             │
└──────────────┬───────────────────────────────────────────┘
               │  spawn vendor/node + dsh web --port 0
               ▼
       L3 dsh 内核（@deepseek-ai/dsh，零改动）
       输出 "dsh web: http://127.0.0.1:<port>"
               │  webUrl 经通知回传 L1
               ▼
       主窗导航真实 Web UI（仅本机回环访问）
```

### 目录结构

```
dsh-desktop/                  # Node/TS 后端 + 数据面（Tauri 壳的后端运行时）
├── updater.js                # 官方 dsh agent 更新引擎
├── client-updater.js         # 客户端本体自更新引擎
├── balance.js                # DeepSeek 余额查询
├── session-watcher.js        # 会话完成监听
├── plugin-guard.js           # 插件保护中心引擎（快照/回滚/体检/修复/守护启动/事故报告）
├── profile-module-heal.js    # profile 模块遮蔽自愈（真实目录 + pnpm 链接）
├── assets/                   # 恢复中心页、手机桥、单源 WS 客户端、图标、皮肤、配套插件
│   ├── skins/                # 10 款内置 Web UI 皮肤
│   ├── plugins/              # 48 个内置插件目录：桌面壳配套（dsh-balance / dsh-terminal /
│   │                         # dsh-phone / dsh-eac-core-bridge / dsh-viewport-lock …）
│   │                         # 与内置社区插件（dsh-agent-teams / dsh-meow-smooth /
│   │                         # dsh-whale-widget / dsh-webui-market / dsh-soul-md …）
│   │                         # （含 vendor 与自包含运行时依赖，随仓库分发）
│   └── ws-jsonrpc-client.js  # 桌面窗 ↔ sidecar 的 WS JSON-RPC 客户端（单源）
├── scripts/                  # 构建与开发辅助脚本
├── vendor/                   # 内置 node.exe / npm CLI（不入库）
└── lib/                      # L2 业务服务层 / 恢复中心 / 扩展宿主（.ts 源，tsc 就地编译）
tauri-shell/                  # Tauri v2 壳：Rust（main.rs）+ sidecar（server/bridge/phone-bridge）
│                             # + stage-resources / make-portable 打包链
openclaw-dsh-bridge/          # 微信桥接插件（可选，研究性质）
research/                     # 第三方微信/桥接协议调研资料
```

---

## 致谢

### 插件致谢

| 插件名                                                       | 插件说明                                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Archify（提供者：tt-a1i，EAC 推荐目录）                      | 由代码仓库或系统描述生成经校验的可交互架构图、工作流图、时序图与数据流图，可导出独立 HTML/SVG/PNG                                  |
| computer-user（提供者：jing-hy）                             | 读屏 + 鼠标键盘自动化（Codex-style computer use；配 picturereader，纯文本模型可用）                                                |
| @nanmicoder/dsh-agent-teams（提供者：nanmicoder）            | 多智能体团队协作：自然语言驱动的队长/成员/依赖任务与消息互通，Web GUI 树状监控                                                     |
| dsh-auto-compact                                             | 自动压缩：接近上下文上限时自动发送 /compact                                                                                        |
| @deepseek-ai/dsh-balance（提供者：deepseek-ai）              | 账户余额、费用估算与价格设置                                                                                                       |
| dsh-better-sidebar（提供者：omdsh-dev）                      | VSCode 风格右侧栏，支持资源管理器/编辑器/终端/Git/浏览器                                                                           |
| dsh-change-review                                            | AI 变更审核：自动复查文件改动                                                                                                      |
| @deepseek-ai/dsh-client-file-changes（提供者：deepseek-ai）  | 文件视图：会话文件更改追踪与一键还原                                                                                               |
| dsh-compact（提供者：zixin947）                              | 请求路径上下文压缩与溢出恢复                                                                                                       |
| dsh-composer-dynamic-island（提供者：says693）               | 将输入区按钮收纳为可配置、向上展开的紧凑灵动岛                                                                                     |
| @deepseek-ai/dsh-conversation-tweaks（提供者：deepseek-ai）  | 隐藏长篇输出 + 会话右侧导航滑轨                                                                                                    |
| dsh-dafeiyu（提供者：QCYTSN）                                | 大肥鱼桌面伴侣                                                                                                                     |
| dsh-deep-whale（提供者：Small-tailqwq）                      | 深海女仆工坊 maid-atelier 皮肤来源                                                                                                 |
| dsh-dock-settings                                            | Skills 与 MCP 设置管理                                                                                                             |
| dsh-eac-core-bridge（EAC 配套）                              | 核心桥：把隔离 SDK 插件的工具/上下文贡献安全桥接进 dsh Agent（受信组件，扩展故障不阻塞核心回合）                                   |
| dsh-eac-locale-compat（EAC 配套）                            | 为未提供本地化词典的内置插件提供英文兼容层                                                                                         |
| @deepseek-ai/dsh-easy-setup（提供者：deepseek-ai）           | 快速配置：视觉模型、soul.md、迁移                                                                                                  |
| dsh-feature-toggles（EAC 配套）                              | 设置页「增强功能」分区：集中提供默认关闭插件（余额小鲸鱼、AgentTeams 等）的一键启停                                                |
| @deepseek-ai/dsh-file-changes（提供者：deepseek-ai）         | 会话文件更改投影                                                                                                                   |
| dsh-file-drop-eac（提供者：jing-hy）                         | 拖放文件/文件夹到对话                                                                                                              |
| @deepseek-ai/dsh-float-window（提供者：deepseek-ai）         | 会话弹出独立窗口                                                                                                                   |
| dsh-font-custom                                              | 字体与文字/代码颜色自定义                                                                                                          |
| dsh-image-paste                                              | 剪贴板图片粘贴发送                                                                                                                 |
| dsh-meow-smooth（提供者：Phant0Meow）                        | 喵丝滑：输入框失焦折叠高度 + 窄屏选中会话自动收起侧边栏                                                                            |
| dsh-message-rewind                                           | 消息改写并从此处重新生成                                                                                                           |
| @vlln/dsh-navbar（提供者：vlln）                             | 对话节点导航条：user 消息快速跳转                                                                                                  |
| dsh-offpeak（提供者：christophersmith2737-commits）          | DeepSeek 峰谷价格拦截提醒                                                                                                          |
| @deepseek-ai/dsh-openclaw-bridge（提供者：deepseek-ai）      | 微信 ClawBot / OpenClaw 桥接                                                                                                       |
| dsh-pet（提供者：PC2005-cloud）                              | 页面悬浮桌宠                                                                                                                       |
| dsh-pet-settings                                             | 桌宠设置分区                                                                                                                       |
| dsh-phone（EAC 配套）                                        | 手机连接：LAN 扫码配对 + 完整 Web UI 反向代理                                                                                      |
| dsh-plugin-guard（提供者：lxzy-7）                           | 插件安装前快照、回滚与启动守护                                                                                                     |
| dsh-plugin-healthcheck（提供者：chenw2759-wq）               | 插件静态体检与风险检查                                                                                                             |
| @deepseek-ai/dsh-plugin-manager（提供者：deepseek-ai）       | 插件管理：列出/启停内置插件                                                                                                        |
| dsh-plugin-shield                                            | 插件保护：快照/回滚/体检                                                                                                           |
| dsh-plugin-wizard                                            | 插件选择向导                                                                                                                       |
| @deepseek-ai/dsh-prompt-custom（提供者：deepseek-ai）        | 自定义内核提示词                                                                                                                   |
| dsh-raw-html（EAC 托管）                                     | VCP 视觉通感：通过官方 conversation slot 隔离渲染 HTML，提供字体、美学与设计规范能力                                               |
| dsh-session-manager（提供者：hkkz9522）                      | 会话删除与归档管理                                                                                                                 |
| dsh-settings-groups                                          | 设置页高级选项折叠                                                                                                                 |
| dsh-settings-nav-custom                                      | 设置页左侧边栏自定义                                                                                                               |
| dsh-settings-scroll-fix（提供者：says693）                   | 设置面板鼠标滚轮与溢出滚动修复                                                                                                     |
| @dsh-external/dsh-side-session（提供者：dsh-external）       | 临时会话：不污染主会话的独立追问                                                                                                   |
| @deepseek-ai/dsh-skin-switch（提供者：deepseek-ai）          | 内置皮肤切换                                                                                                                       |
| dsh-soul-md（提供者：Scorp1o117）                            | soul.md 人设卡注入                                                                                                                 |
| dsh-stt（提供者：BAIKAI23333）                               | 本地离线语音识别：sherpa-onnx SenseVoice 麦克风说话回填输入框，唤醒词 + 「发送」语音指令（默认禁用，三平台，引擎构建时按平台安装） |
| @deepseek-ai/dsh-terminal（提供者：deepseek-ai）             | 会话内交互式命令行                                                                                                                 |
| @deepseek-ai/dsh-third-party-thinking（提供者：deepseek-ai） | 第三方模型思考强度控件                                                                                                             |
| dsh-tool-vision（提供者：Scorp1o117）                        | OpenAI 兼容视觉模型图片分析                                                                                                        |
| dsh-undo-savepoint（提供者：lire1131）                       | 配置快照与撤销/回滚                                                                                                                |
| dsh-unified-market（提供者：jing-hy）                        | 统一插件市场：聚合三源                                                                                                             |
| dsh-viewport-lock（EAC 配套）                                | 视口约束：滚动钳制、稳定居中与输入区透明动态裁切（桌面壳/浏览器/手机端通用）                                                       |
| dsh-web-mobile-fix（提供者：AcidGr）                         | 移动端布局修复                                                                                                                     |
| dsh-web-plugin-manager（提供者：LX2000WASD）                 | 插件安装守卫与健康检查入口                                                                                                         |
| dsh-web-ui（提供者：zhu1090093659）                          | 9 款内置 Web UI 皮肤来源                                                                                                           |
| dsh-webui-market（提供者：Sanqi-normal）                     | 社区插件目录与一键安装/卸载                                                                                                        |
| dsh-webui-prompt-optimizer（提取自 statem-li/dsh-webui）     | 流式提示词优化                                                                                                                     |
| dsh-whale-widget（提供者：MeteorNOX）                        | 余额小鲸鱼挂件：今日已用、峰谷定价、随机台词与每轮消耗统计                                                                         |
| picturereader（提供者：jing-hy）                             | 统一图片理解插件                                                                                                                   |

感谢所有插件提供者对本项目与开源社区的奉献；由于插件数量众多，我们很抱歉，未能逐一统计到所有插件与其来源；如有插件的拥有者看到了自己所做的插件，欢迎您告知我们并添加到致谢名单中，也欢迎添加我们的交流群，以便一同交流、共同进步。

### 皮肤来源与许可

设置页内置 10 款 Web UI 皮肤，默认保持原生外观。启用任一皮肤时会自动禁用其他皮肤，也可一键恢复默认；皮肤的来源、作者和许可信息随安装包完整分发。

其中 9 款来自社区 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)（BSD-3-Clause），maid-atelier 来自 [dsh-deep-whale 深海女仆工坊](https://github.com/Small-tailqwq/dsh-deep-whale)（CC BY-NC-SA 4.0，禁止商用）。

| 皮肤                         | 出处                                                              | 许可                            |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------- |
| xp（Windows XP 风格）        | [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)         | BSD-3-Clause                    |
| qq98（QQ 经典 98 风格）      | 同上                                                              | BSD-3-Clause                    |
| ths（同花顺风格）            | 同上                                                              | BSD-3-Clause                    |
| blue-fantasy（蓝幻）         | 同上                                                              | BSD-3-Clause                    |
| dragon-heir（龙裔）          | 同上                                                              | BSD-3-Clause                    |
| minecraft（我的世界）        | 同上                                                              | BSD-3-Clause                    |
| trading（交易风格）          | 同上                                                              | BSD-3-Clause                    |
| whale-song（鲸歌）           | 同上                                                              | BSD-3-Clause                    |
| miku（初音未来）             | 同上                                                              | BSD-3-Clause                    |
| maid-atelier（深海女仆工坊） | [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) | **CC BY-NC-SA 4.0**（禁止商用） |

### 贡献者

感谢每一位贡献者：

特别致谢 [@CharlesAQ](https://github.com/CharlesAQ) —— macOS 桌面移植（[PR #234](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/pull/234)）：Tauri 壳 darwin 分支、平台适配层、darwin 资源装配与裁剪、`.app`/`.dmg` 打包配置，让 EAC 首次跑上 Apple Silicon。

<p align="center">
  <a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=zouyuxuan122/Deepseek-Harness-EAC" />
  </a>
</p>

---

## Star 趋势

<a href="https://www.star-history.com/?repos=zouyuxuan122%2FDeepseek-Harness-EAC&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=zouyuxuan122/Deepseek-Harness-EAC&type=date&theme=dark&legend=bottom-right&sealed_token=5SkHr7TORH0WuK6eeH5IP-Q2hISGL0m3EDvMKDG6hAUNQssgWBUixIuZWP_ygvty93H_loEZ8JUEgXKy8xGAuH4-mq_DTlClZbM_mOYiomJbfc3zANNWFg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=zouyuxuan122/Deepseek-Harness-EAC&type=date&legend=bottom-right&sealed_token=5SkHr7TORH0WuK6eeH5IP-Q2hISGL0m3EDvMKDG6hAUNQssgWBUixIuZWP_ygvty93H_loEZ8JUEgXKy8xGAuH4-mq_DTlClZbM_mOYiomJbfc3zANNWFg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=zouyuxuan122/Deepseek-Harness-EAC&type=date&legend=bottom-right&sealed_token=5SkHr7TORH0WuK6eeH5IP-Q2hISGL0m3EDvMKDG6hAUNQssgWBUixIuZWP_ygvty93H_loEZ8JUEgXKy8xGAuH4-mq_DTlClZbM_mOYiomJbfc3zANNWFg" />
 </picture>
</a>

---

## 许可证

MIT。基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）。内置皮肤版权归原作者所有（见上方皮肤许可表）。

<!-- 咕咕嘎嘎 -->
