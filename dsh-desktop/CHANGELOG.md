# Changelog — Deepseek Harness EAC（揽尽万象 · Embracing All Creation）

DeepSeek Harness（dsh）的 Windows 桌面客户端：内置独立 Node 运行时与 dsh CLI，
一键启动 Web UI。
版本路径：0.1.0（基础壳）→ 0.2.0（伴侣插件体系 + 自更新 + 会话工具链）→
1.0.0（品牌升级 EAC + 界面皮肤 + 快速配置 + 插件市场 + 稳定性自愈）→
2.0.0（社区插件市场 + 视觉/记忆/人设插件全家桶 + 重启窗口期排队任务 + 插件原样分发）→
3.0.0（本版：升级链路根治 + 崩溃自恢复/看门狗 + 右侧边栏 + 上游预设全家桶）。

## [3.0.2] — 2026-08-16

### Linux（v3.0.2-linux 重发布）
- node-pty 原生模块统一在 debian:12 容器编译，glibc 基线锁定 ≤ 2.34，
  修复 Arch 构建机（glibc 2.42）产物在 Debian 13 及更早系统上的启动崩溃
  （2026-08 Debian 事故复盘）。
- 打包后审计 node-pty / Jieba / sqlite-vec 原生负载；CI 从 pacman 归档解包，
  并用包内捆绑的 Node 实际加载 `pty.node`（3.0.1 Arch 事故复盘）。
- 明确支持窗口：2025-01-01 至 2026-08-15 之间发布的发行版（见 AGENTS.md）。

## [3.0.0] — 2026-08-16

### 修复（升级/启动可靠性，issues #7 #8 根因）
- **升级弹 `Failed to uninstall old application files ... : 2` / 空目录骨架**（#7 #8）：
  安装器**接管旧版清理**（`dshTakeoverWipe`）——`customInit` 直接清空旧安装树
  （含 robocopy 空目录镜像处理 MAX_PATH 超长残留）并清掉旧卸载注册表值，
  electron-builder 内置"卸载旧版本"步骤从此无事可做，**绝不运行带缺陷的旧卸载器**
  （旧卸载器先删文件后删目录，中途退出即留下阻断 Node 解析的空目录骨架）。
- **接管逻辑静默失效的回归**：目录名尾部长度截取（21/26 字符）必须与比较字面量
  严格一致，新增 `installer-nsh-lengths` 静态测试防呆；不匹配时接管不触发、
  旧卸载器再次运行（v3.0.0 首包实测回归的根因）。
- **托盘自更新 Setup 永不执行、174MB 更新包泄漏**（#8）：`apply-update.cmd`
  改为有界等待进程退出（90s）→ 超时 `taskkill /F /T` 强杀 → 全程日志落盘
  `%APPDATA%\Deepseek Harness EAC\logs\apply-update.log`。
- **启动闪退无诊断**：启动时按 `bundle-manifest.json` 校验捆绑依赖完整性，
  缺文件时弹出明确路径清单而非静默退出；heal 修复 junction 目标不健康时
  误删 profile 中真实副本的问题。
- **发布防呆三件套**：`verify-dist-fresh`（产物必须新于全部源码，杜绝 v2.0.3
  stale 产物事故重演）、`check-syntax`（async/await 关键字被注释拆断的打包前
  预检）、`bundled-files` 测试（electron-builder files 清单漏文件防呆）。

### 新增（上游 dsh_desktop 功能集成）
- **渲染进程崩溃/挂起自恢复**：`renderer-recovery` 状态机——崩溃自动重载、
  指数退避、连续失败重建窗口并展示错误页，不再白屏卡死。
- **主进程看门狗**：`watchdog` 子进程监控主进程，意外退出自动拉起并通知，
  托盘/进程不再无声消失。
- **稳定端口选择**：`stable-port`——web 端口持久化到设置，重启不变，
  localStorage 偏好不再丢失；自动避开 Chromium 受限端口。
- **koffi 预检降级**：启动前探测 koffi 可用性，失败时自动启用目录选择器
  降级方案，不再因原生库问题卡启动。
- **便携版解压缓存复用**：版本标记匹配时直接复用上次解压目录，
  二次启动不再重新解压 132MB（冷启动从分钟级降到秒级）。
- **dsh web 启动加 `--use-system-ca`**：企业内网 MITM 证书不再导致更新失败。
- **上游 agent presets 全量同步**：新增 `_preset` 共享目录同步
  （compaction-epoch / custom-bash / dev-tool-search / instruction-hint /
  skill-search），新增 minimal-win / v4-flash-godmode-opencode-go /
  warmupbetter / warmupbetter-replay / whoami-standard 预设。

### 内置插件
- **dsh-better-sidebar**（右侧边栏）：文件树、编辑器、Git 更改视图、内置终端
  （预编译 lib 集成；标题栏 toggle 按钮可收起）。

## [2.0.4] — 2026-08-15

### 修复（托盘自更新下载中断）
- **自更新下载 `net::ERR_CONNECTION_RESET` 后整体失败**：167MB 安装包在慢链路
  直连 GitHub 资产域时常被 RST，旧实现是"一锤子流"下载，中断即全量作废。
  现在 `downloadFile` 支持 **HTTP Range 断点续传 + 指数退避重试**（最多 10 次，
  3s→30s 退避；.part 残留文件保留，重启应用后再点更新也能从断点继续）。
  服务器忽略 Range 回 200 全量时自动覆盖写；.part 异常超长（416）自动作废重来。
- `getResponse`（纯 Node 回退路径）支持 `http://` 端点，自定义镜像
  （`DSH_DESKTOP_RELEASE_API`）不再强制 HTTPS。

## [2.0.3] — 2026-08-15

### 修复（issues #1 #3 #4 + README 404）
- **安装后 dsh web 启动即退（MODULE_NOT_FOUND）**（#4 问题 2 / #3）：productName
  去掉版本号后缀。此前带版本号的安装目录在升级时被注册表旧 INSTALLDIR 嵌套成
  `...\Deepseek Harness EAC v1.0\Deepseek Harness EAC v2.0\`，深层 node_modules
  路径超过 MAX_PATH(260)，NSIS 7z 解压器对超长路径**静默丢文件**（实测丢 42 个，
  含运行时必需的 `@opentelemetry/resources` machine-id / ServiceInstanceIdDetector），
  dsh web 一启动即崩。目录不再带版本号后，升级永远原地覆盖，不再嵌套。
- **GUI 安装器卡「无法关闭现有进程」死循环**（#4 问题 1）：`customInit` 统一
  kill 新旧全部进程名（含 v1.0 / v2.0 遗留 exe），`customCheckAppRunning` 改为
  无对话框等待（最多 10s）后继续，不再弹重试 MessageBox。
- **嵌套安装目录自愈**：`customInit` 检测到 `...\v1.0\...\v2.0` 式嵌套且父目录
  本身是安装根时自动剥离一层；并同步回写注册表（InstallLocation /
  UninstallString 指向治愈后的根目录；根目录无可用旧卸载器则清空该值跳过旧版
  卸载步骤）——否则内置"卸载旧版本"步骤与旧卸载器都会重读注册表、对着嵌套残缺
  目录操作，触发 `Failed to uninstall old application files ... : 2` 安装失败弹窗。
- **打包长路径审计 + 裁剪**（`after-pack.js`）：构建时扫描全部产物路径，≥240
  字符即告警；同时裁剪 x64 包里无用的 `node-pty` win32-arm64 prebuilds 与
  `@opentelemetry` browser 平台探测器（也是树里最深的目录）。
- **README 下载链接 404**：安装包产物名去掉版本号（`Deepseek-Harness-EAC-Setup-x64.exe`
  / `...-Portable-x64.exe`），README（中/英）改用 `releases/latest/download/` 永久
  链接，发新版不再失效。
- **安装版数据目录**随 productName 变为 `%APPDATA%\Deepseek Harness EAC\`
  （旧版为 `...\EAC v2.0\`；DSH 配置/会话在 `DSH_HOME`，不受影响）。
- 自更新资产选择兼容新旧命名（无版本号优先，回退带版本号 + Gitee 分片）。
- `desktop.log` 时间戳由 UTC 改为本地时间 + 显式时区偏移（#4 建议 4）。

## [2.0.2] — 2026-08-15

- 自动更新网络层改用 Electron `net`（系统代理 + 系统 CA），修复 MITM 证书失败
  与直连超时；修复资产名正则与下载校验。内置三套预设组合（Anchored Standard /
  Router Standard / Minimal Git Bash），预设实现为纯组合目录不进插件树。

## [2.0.1] — 2026-08-15

- 修复 v2.0.0 预装 `dsh-soul-md` 缺少必填 `config.path` 导致插件树加载失败、
  `dsh web 启动失败（退出码 1）`：默认补 `soul.md` 并在启动时自动补全缺失配置行。

## [2.0.0] — 2026-08-15

### 新增
- **社区插件市场**（`dsh-webui-market`，@sanqi-normal）：设置 → 插件 → 市场，
  浏览 awesome-dsh-plugin.com 收录的 dsh 插件并一键安装/卸载到 profile。
- **外置视觉模型**（`dsh-tool-vision`，Scorp1o117）：`inspect_image` 工具把本地图片
  或图片 URL 发给任意 OpenAI 兼容视觉端点（qwen-vl / GLM-4V / Ollama 等），
  看图回答直接带回对话。
- **长期记忆**（`dsh-tdai-memory`，Scorp1o117）：腾讯云 Agent Memory 移植 ——
  L0 对话捕获 → L1 结构化记忆 → L2 场景 / L3 画像，自动召回注入 +
  记忆/对话搜索工具；复用现有 `~/.memory-tencentdb/memory-tdai` 数据。
- **soul.md 人设热重载**（`dsh-soul-md`，Scorp1o117）：markdown 人设文件注入
  系统提示词（`soul:persona`），文件变更即时热重载，Agent 边干活边角色扮演。
- **移动端布局修复**（`dsh-web-mobile-fix`，AcidGr）：窄屏（≤400px）下设置面板、
  弹窗、侧栏、会话头布局修复，纯前端 CSS。
- **NSIS 安装器定制**（`build/installer.nsh`）：安装流程接入自定义脚本。

### 改进
- **重启窗口期排队任务**：服务重启时先 `killTree` 旧进程并 `waitForProcExit`
  等待其完全退出（释放文件锁），再处理插件市场排队中的安装/卸载任务、
  同步配套插件、自愈 profile 模块，最后启动新服务，避免文件占用与半套改状态。
- **插件原样分发**（`after-pack.js`）：打包后把 `assets/plugins/` 原样拷回应用目录，
  社区插件自带的 vendor 依赖（sqlite-vec / jieba / AI SDK / BM25 语料等）不再被
  electron-builder 清掉。
- 内置插件/皮肤拷贝逻辑支持根目录入口文件、vendor、node_modules、data 目录。

### 说明
- 安装版数据目录改为 `%APPDATA%\Deepseek Harness EAC v2.0\`；便携版仍跟随 exe。
- 产物命名 `Deepseek-Harness-EAC-v2.0-Portable/Setup-x64.exe`，自更新链路自动适配。

## [1.0.0] — 2026-08-15

### 品牌与新定位
- 项目更名 **Deepseek Harness EAC**（EAC = Embracing All Creation，揽尽万象）：
  Windows 桌面客户端正式释出，产物统一命名 `Deepseek-Harness-EAC-v1.0-Portable/Setup-x64.exe`。
- 自更新链路同步指向新仓库，产物命名与 electron-builder 配置对齐。

### 新增
- **界面皮肤体系**（`assets/skins/` + `dsh-skin-switch`）：内置 10 款 Web UI 皮肤
  （9 款 dsh-web-ui：xp/qq98/ths/blue-fantasy/dragon-heir/minecraft/trading/whale-song/miku，
  1 款 dsh-deep-whale maid-atelier），设置页卡片式互斥切换、默认不启用、重启生效；
  出处与许可随包标注（BSD-3-Clause / CC BY-NC-SA 4.0）。
- **快速配置插件**（`dsh-easy-setup`）：设置页视觉模型提供商/模型一键选择、
  `soul.md` 人设可视化编辑、从 Codex / Claude Code 目录一键迁移 skills + MCP + 记忆。
- **插件市场加固**（`dsh-plugin-marketplace`）：宿主 typert local store 显式注册
  远端端点，修复跨模块实例 SRC 标记不可见导致的 HTTP 404。
- **profile 模块遮蔽自愈**（`profile-module-heal.js`）：清理 web profile 中遮蔽
  fallback junction 的真实目录副本，修复 `prompt section already registered`、
  模型列表/模式切换失效等问题。
- **自动化测试**：`test/` 新增 easy-setup、skin-switch、profile-module-heal、
  persona-scope、skin-chrome-zindex 等单测（`npm test`）。

### 说明
- 便携版数据目录跟随 exe（`data\`）；安装版在 `%APPDATA%\Deepseek Harness EAC v1.0\`。
- 与 dsh CLI 共享 `DSH_HOME`（默认 `~/.dsh`），已有会话/凭据直接生效。

## [0.2.0] — 2026-08-14

### 新增
- **伴侣插件体系（一切插件化）**：新增 `assets/plugins/` 机制——宿主启动时把
  配套插件同步进 web profile（`~/.dsh/profiles/web`）并幂等打 `cordis.patch.yml`
  补丁启用。本版随客户端分发的插件：
  - `dsh-terminal`：会话内终端标签页（与 对话/轨迹/文件 并列）。在当前会话项目目录
    启动持久 PowerShell（SSE 流式，非 PTY），命令历史/清屏/重启/断线重连（保留
    512KB 回放）；显式 UTF-8 mini-REPL 规避 PS 5.1 重定向 stdin 的代码页问题；
  - `dsh-file-changes` + `dsh-client-file-changes`：会话文件修改追踪与一键还原。
    「文件」标签页聚合当前会话 agent 修改过的全部文件（新建/修改/删除 + 行级 diff），
    支持逐文件/全部还原（桌面壳做内容精确匹配后替换，冲突安全提示）。数据只读复用
    会话日志已持久化的 `tool/result.meta.diffs`（fs 写前锁内全文 diff），零写入、
    零格式变更；另提供项目文件树（`/api/dsh-files/list`）、站内 HTML/端口预览
    （`/dsh-files/static/*`、`ports`、`check`），全部仅回环；
  - `dsh-balance`：对话底部统计栏内联「本轮 ¥X.XX · 余额 ¥Y.YY」小部件
    （桌面壳读 `~/.dsh/.credentials.yaml` 调 `api.deepseek.com/user/balance`，
    15 分钟刷新，可配置价格档）；
  - `dsh-plugin-marketplace`：插件市场入口。
- **客户端自更新**（`client-updater.js`）：GitHub Releases → Gitee Releases 双源回退
  （`DSH_DESKTOP_RELEASE_API` 可自定义镜像），Gitee 100MB 分片自动下载合并；
  便携版原地替换 + 自动重启，安装版引导新安装包；失败自动保留当前版本。
- **跟随官方更新**（`updater.js`）：检测 `@deepseek-ai/dsh` 新版本，经用户同意后
  用内置 node+npm 安装到数据目录 overlay，staging 原子切换、失败回退、
  启动失败一键回退内置版本；尊重 `NPM_CONFIG_REGISTRY`。
- **会话完成系统通知**：agent 任务跑完弹 Windows 通知，点击回到窗口。
- **快捷键自动维护**：便携版自动创建/重建桌面+开始菜单快捷方式（exe 移动后自愈）。

### 说明
- 便携版数据目录跟随 exe（`data\`）；安装版在 `%APPDATA%\DSH Desktop\`。
- 与 dsh CLI 共享 `DSH_HOME`（默认 `~/.dsh`），已有会话/凭据直接生效。
