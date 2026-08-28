# macOS 桌面支持设计（arm64 本地版）

## 目标

在保留现有 Windows Tauri 壳与 Linux 桌面版行为的前提下，为 Deepseek Harness
EAC 增加 **macOS (Apple Silicon / arm64) 本地桌面版**。移植沿用 L1 Tauri、
L2 Node sidecar、L3 DSH 内核三层架构，照搬 Linux 移植已建立的平台 Adapter
模式，不重写架构、不改 L3。

首发形态：本地构建、无签名公证的 `.app`（自用，不对外分发）。Gatekeeper
只隔离「从网络下载的」应用，本机构建的 App 不受影响，无需绕过。

## 背景与先例

- 上游仓库已完成一次 **Linux 移植**（`docs/superpowers/specs/2026-08-25-linux-desktop-support-spec.md`
  及其任务清单、CI），证明三层架构的平台接缝干净：非 Windows 的降级路径
  （进程组回收、external-handoff 更新、能力声明）均已存在并经过测试。
- 本设计是 Linux 移植规格的 darwin 镜像，差异点单独标注。

## 支持基线

- macOS 13.0+，Apple Silicon（arm64），x86_64/universal 明确不在首发。
- 架构参数化保留：`process.arch` / `--target=darwin` 不写死 arm64，未来可加 x64。
- 随包 Node：`node`（darwin-arm64），由 `fetch-node.ts` 复制系统 Node（已跨平台）。
- 分发：`.app`（主要）与 `.dmg`（可选产物），Tauri `bundle.targets`。
- 无签名、无公证、无 CI（本机构建即可）。

## 能力矩阵

状态含义：supported = 可用；degraded = 可用但非内核级保证；external-dependency
= 依赖外部程序；v1.5 = 计划于下一迭代实现；unavailable = 不提供。

| 能力 | v1 状态 | 实现方式 |
| --- | --- | --- |
| 窗口 / 浮窗 / 托盘 / 单实例 | supported | Tauri 原生（WKWebView，无需额外运行时） |
| 打开文件 / URL | supported | `open` 命令（替代 `cmd /c start`） |
| 文本剪贴板 | supported | `pbcopy` / `pbpaste` |
| 系统通知 | supported | `osascript`（L1 darwin 分支） |
| 会话内终端 | supported | `dsh-terminal` 非 Windows 自动用 `sh -i`；better-sidebar PTY 用 node-pty darwin-arm64 prebuild |
| 文件树 / diff / 预览 | supported | 纯 Web + L2，零改动 |
| 皮肤(10款) / 市场 / 插件保护 / 恢复中心 | supported | 纯插件层，随包分发 |
| 余额 / 自动压缩 / 人设卡 / MCP 迁移 | supported | L2 / 插件层，零改动 |
| 进程围栏 | degraded | POSIX 进程组 + 管道租约（同 Linux；无 Job Object 内核级回收，`kill -9` 极端场景不保证） |
| 客户端自更新 | **disabled（v1）** | 非 win32 本就走 external-handoff；v1 直接关闭检查提示（上游 Release 无 macOS 资产，更新方式 = `git pull upstream` + 重建） |
| dsh agent 更新 | supported | npm overlay 安装 + 原子交换 + 回退，零平台绑定，完整保留 |
| OCR / 图片理解 | external-dependency | paddle/rapid 引擎需 Python；Windows.Media.Ocr 不提供 |
| computer-user | **v1.5** | 见「v1.5 预留」 |
| 微信桥接（openclaw-dsh-bridge） | **v1.5** | 见「v1.5 预留」 |
| 桌面快捷方式维护 | unavailable | macOS 无 `.lnk` 概念，Dock 固定即可，不模拟 |

## 组件改动清单

### A. L1 Rust 壳 `tauri-shell/src/main.rs`（新增约 60 行）

- `open_native_target`：darwin 分支用 `open`（当前 `cfg(not(win/linux))` 分支返回错误）。
- `show_system_notification`：darwin 分支用 `osascript -e 'display notification …'`。
- `write_clipboard_text`：darwin 分支用 `pbcopy`（复用现有 `run_clipboard_command` 骨架）。
- Windows 专属菜单动作：核实后 L1 壳方法（win.*/float.*/files.* 等）全部为通用 Tauri 操作，无需 darwin no-op；L2 快捷方式维护的非 win32 语义已由 Linux 移植定义。
- 托盘图标：macOS 需要单色模板 PNG（template 图标），由 `tauri icon` 生成。
- 其余（WS 中继 127.0.0.1:19873、主窗/浮窗/恢复中心、加载/死亡/更新/向导页）零改动。

### B. L2 平台 Adapter `dsh-desktop/lib/desktop/platform.ts`（新增约 30 行）

- darwin 数据目录：`~/Library/Application Support/deepseek-harness-eac`
  （当前非 win/linux fallback 是 XDG 路径，需改为 darwin 专用分支）。
- `runtimeExecutableName()` = `node`（已有）。
- capabilities 声明：clipboard=supported、clientSelfUpdate=external-handoff
  （v1 上层关闭提示）、computerUser=v1.5（占位 unavailable 语义）、
  processFence=degraded、plugins.ocr=external-dependency。

### C. 资源装配 `tauri-shell/stage-resources.mjs`（新增约 40 行）

- 支持 `--target=darwin`：通过 `platform !== 'darwin'` 拒绝逻辑的扩展。
- 裁剪：`.exe`/`.dll`、Windows 专属插件（computer-user、dsh-dafeiyu）、
  agent-presets（同 Linux 分支）。
- 保留 darwin-arm64 预编译（sharp / node-pty / koffi 已核实均有 arm64 包）。
- `healNodePtyPlugin` 对 darwin 生效。
- `fetch-node.ts` 零改动（复制系统 Node = arm64）。

### D. 原生模块 `dsh-desktop/native/{supervisor,snapshot}`（`build-native.ts` 新增约 30 行）

- darwin 分支：跳过 lld-link 逻辑，普通 `cargo build`，复制 `dylib` → `index.node`。
- supervisor：非 Windows 本就返回错误、TS 侧走 POSIX 进程组（同 Linux）。
- snapshot：纯 Rust SHA-256，零改动。

### E. 诊断打包 `tauri-shell/sidecar/rescue-integration.ts`（新增约 15 行）

- darwin 分支用 `ditto -c -k` 替代 PowerShell `Compress-Archive`。

### F. 打包配置

- 新增 `tauri-shell/tauri.macos.conf.json`：`targets: ["app","dmg"]`、
  `minimumSystemVersion: "13.0"`、icon `icon.icns`。
- `tauri icon` 从现有 `icon.png` 生成 `icon.icns`（含托盘模板图标）。

### G. 测试与验收

- `test/platform.test.ts` 加 darwin characterization 测试（照 Linux 写法）。
- 全量 `npm test`（node:test + tsc 类型检查）+ 两套 cargo test/clippy/build。
- `boot-smoke.js`：临时 DSH_HOME 完整走 boot.start → dsh web → HTTP 探活 → 优雅关停。
- 手动冒烟清单（见「验收」）。

## 进程与隔离

与 Linux 相同的 degraded 方案：普通子进程用独立 process group + SIGTERM
宽限 + SIGKILL；Extension Host 用 process group + owner pipe lease（Supervisor
管道 EOF 时 Host 自杀）。能力标记 `degraded`，不得称为 Job Object 等价实现。
正常退出、崩溃、Cmd+Q 场景均能回收全家进程；仅 `kill -9` 壳进程的极端场景
无内核兜底——对自用可接受。

## 更新策略

- **链路 1（dsh agent 更新，`updater.ts`）**：完整保留。npm overlay 安装 +
  原子目录交换 + 启动失败回退，与 Windows 版行为一致。
- **链路 2（客户端自更新，`client-update.ts`）**：v1 关闭检查提示。理由：
  非 win32 自动走 external-handoff，但上游 Release 只有 Windows 资产，打开的
  下载页无 macOS 包可下。自用更新方式 = `git pull upstream` + 重新构建。
  若未来发布 macOS Release 资产，改一行检查源即可恢复 external-handoff。

## 构建与分发

```bash
cd ~/dsh-eac-macos
npm install                       # dsh-desktop 依赖（darwin-arm64 原生包）
npm run fetch-runtime             # 复制系统 Node（arm64）
node scripts/build-native.js build              # supervisor darwin 版
node scripts/build-native.js build snapshot     # snapshot darwin 版
node scripts/build-native.js copy && node scripts/build-native.js copy snapshot   # 复制为 index.node
node tauri-shell/stage-resources.mjs --target=darwin
cd tauri-shell && npx -y @tauri-apps/cli@2 build   # → target/release/bundle/macos/*.app
```

产物 `Deepseek Harness EAC.app` 移入 `/Applications`、Dock 固定。与全局 CLI
共享 `~/.dsh`（session / API Key 通用），桌面端使用独立 `web-desktop` profile。

## 验收

- [ ] `npm test` 全绿（darwin 上跑通平台测试）。
- [ ] cargo test/clippy/build（supervisor、snapshot）通过。
- [ ] boot-smoke 通过（临时 DSH_HOME 启动 → 探活 → 零孤儿退出）。
- [ ] 双击 .app 启动 → 主窗加载 Web UI → 托盘图标出现。
- [ ] 系统通知、剪贴板、打开文件/链接三件套实测。
- [ ] 终端标签页可用（sh）、better-sidebar PTY 可用。
- [ ] 皮肤切换、插件市场安装/卸载、余额显示。
- [ ] 文件树 / 行级 diff / 一键还原。
- [ ] 与 CLI 共存：CLI 会话在桌面端可见，profile 互不干扰。
- [ ] Cmd+Q / 关窗退出后无孤儿 node/dsh 进程（`pgrep` 验证）。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 依赖缺 darwin-arm64 预编译 | npm ci 实测验证；缺失则换纯 JS 实现或本机编译 |
| Tauri v2 在 macOS 26 的行为差异 | boot-smoke + 手动冒烟覆盖，问题走上游 issue |
| Windows 残留代码路径在 darwin 触发 | capability 降级模型兜底，不伪装成功 |
| 上游更新冲突 | 保留 upstream 远端，改动全部走 Adapter/cfg 分支，最小 diff |
| v1.5 的 TCC 授权（未签名二进制） | helper ad-hoc 签名（`codesign -s -`）固定身份；重编译后一次性重新授权 |

## 明确不做（v1）

签名公证与对外分发、Intel x64 / universal、computer-user、微信桥接、
macOS 原生 Vision OCR、应用内客户端自更新、CI 流水线、`.lnk` 式快捷方式维护。

## v1.5 预留

### computer-user（CGEvent 方案）

Windows 版 = PowerShell + Win32 SendInput；插件接缝干净（`ps.js` → 平台后端
脚本），移植只需换后端：

- 新增 Swift helper（约 300–500 行，`swiftc` 编译，本机已有 Swift 6.3.2 + CLT）：
  截图（`screencapture` / ScreenCaptureKit）+ 键鼠注入（CGEvent：move/click/
  type/scroll/drag/keypress）+ 可选 Vision 中文 OCR 子命令。
- `ps.js` 加 darwin runner（spawn helper，JSON 契约与 PowerShell 版一致）。
- TCC 一次性授权：辅助功能 + 屏幕录制；helper ad-hoc 签名固定身份。
- picturereader 可顺带接入 Vision 后端，OCR 从 external-dependency 升为 supported。
- 冒烟：截图→OCR→点击/输入全链路真机验证。

### 微信桥接（openclaw-dsh-bridge）

- 桥接本体为 Node 实现（跨平台）；`scripts/*.ps1` 安装脚本需提供 bash 等价版。
- 与 picturereader / computer-user 无关，独立评估安装路径与测试。
