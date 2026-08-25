# Linux 桌面支持规格

## 目标

在保留现有 Windows Tauri 和冻结 Electron 行为的前提下，为 Deepseek Harness
EAC 增加原生 Linux 桌面发行版。迁移沿用 L1 Tauri、L2 Node sidecar、L3 DSH
内核三层架构，以平台 Adapter 隔离差异，不在 L2 业务模块散布平台命令。

## 支持基线

- Linux：Ubuntu 22.04 x86_64 或更高，glibc 2.35 基线。
- 显示系统：X11 和 Wayland；Wayland 受 portal 权限模型约束。
- 桌面环境：GNOME 和 KDE 为验收目标。
- 分发：deb 和 AppImage。
- Node：随包 Node 24，文件名在 Windows 为 `node.exe`，在 Linux 为 `node`。
- Windows：继续构建 x64 NSIS 和便携 zip，现有命令、路径和更新行为不变。

ARM64、rpm、Flatpak 和 Linux 应用内整树替换不属于首发范围。它们必须在独立
规格中增加构建、native payload 和更新所有权设计后才能启用。

## 项目盘点

- `dsh-desktop/`：TypeScript/JavaScript 业务层与 Node sidecar，保留 Electron
  入口和 `electron-builder`/NSIS/portable Windows 分发链。
- `tauri-shell/`：Tauri 2 Rust 桌面壳、sidecar bridge、资源 staging 和安装包配置。
- `dsh-desktop/native/{supervisor,snapshot}`：napi-rs/Cargo 原生模块；必须在目标
  平台重建，仓库跟踪的 Windows `.node` 不作为 Linux 输入。
- 构建入口：npm + `tsc`、Cargo、Tauri CLI；没有必要引入 CMake。
- 自动化：Node `node:test`、两套 Cargo test/clippy/build、Tauri `cargo check`、
  bundle 审计，以及独立 Windows/Linux GitHub Actions jobs。
- 关键 Linux 依赖：WebKitGTK 4.1、AppIndicator、librsvg、patchelf、glibc 2.35；
  随包 Node 24 与 Linux x86_64 N-API payload 由 staging 审计。

## 功能兼容矩阵

状态中的“自动化通过”只代表当前 Linux 主机的单元/集成或成品检查；需要真实桌面
会话或 Windows runner 的项目不会据此升级为已验收。

| 功能 | 分类 | Windows | Linux | 当前状态/差异 |
| --- | --- | --- | --- | --- |
| bridge、profile、市场、恢复、诊断 zip | 可直接跨平台 | 保留现有实现 | 复用公共实现 | Node 全量测试和 bridge parity 通过 |
| 应用数据目录、runtime 名称 | 需要平台适配层 | AppData、`node.exe` | XDG、`node` | Adapter 与测试已完成 |
| 外链/文件打开 | 需要平台适配层 | `cmd /c start`/Electron shell | `xdg-open` | 参数化调用已完成；真实桌面待验 |
| 文本剪贴板 | 需要替换第三方库 | PowerShell clipboard | `wl-copy`/`xclip`/`xsel` 探测 | 后端缺失返回 `external-dependency`；portal 待定 |
| 单实例、窗口、浮窗、托盘 | 可直接跨平台 | Tauri | Tauri/GTK | 可编译；GNOME/KDE/X11/Wayland 实机未验 |
| 系统通知 | Linux 上没有完全等价实现 | Electron Notification；Tauri PowerShell toast | Tauri L1 `notify-send` | Adapter 已完成；Linux 缺命令时明确失败，点击回调不等价 |
| 快捷方式 | Linux 上没有完全等价实现 | COM/PowerShell `.lnk` 维护保留 | 安装包生成 `.desktop` | 安装入口已验；运行时维护语义未实现 |
| Extension Host 进程围栏 | Linux 上没有完全等价实现 | Job Object，降级 taskkill | process group + owner pipe lease | Linux 标记 `degraded`，无硬限额/不可逃逸保证 |
| 普通子进程树终止 | 需要平台适配层 | taskkill | SIGTERM/SIGKILL 进程组 | POSIX 父子/孙进程测试通过 |
| 路径授权和共享模块链接 | 需要平台适配层 | junction、大小写不敏感 | symlink、大小写敏感 | realpath 防 symlink 逃逸测试通过 |
| 客户端更新 | Linux 上没有完全等价实现 | NSIS/portable 下载、替换、回滚 | 只检查并打开 Release | Linux 不下载/执行 Windows helper；测试通过 |
| supervisor/snapshot/PTY/FFI | 需要替换第三方库 | Windows N-API/系统 ABI | Linux glibc x86_64 payload | 两套 native test/clippy/build 与 payload 审计通过 |
| 普通 Web 插件 | 可直接跨平台 | supported | supported | companion registry/同步测试通过 |
| `computer-user` | Linux 上没有完全等价实现 | WinForms/SendInput | unavailable | Linux staging、推荐与自动启用均排除 |
| OCR/文档转换 | 需要替换第三方库 | Windows OCR/现有 helper | Paddle/Rapid/Tesseract、Python/LibreOffice | 只声明外部依赖，真实 helper smoke 未完成 |
| `dsh-dafeiyu` | 需要替换第三方库 | 保留 | 首发 staging 排除 | Linux helper 未验，不宣称可用 |
| 安装包 | 需要平台适配层 | NSIS + portable zip | deb + AppImage | staging 通过；本机 deb 因 GLIBC 2.39 被最终审计拒绝，等 Ubuntu CI |

## 不变量

1. Win32 Job Object、PowerShell/COM `.lnk`、NSIS 接管和便携更新实现继续保留。
2. 不改变 `DSH_HOME`、profile、sessions、skills、preset 和 Cordis patch 语义。
3. L3 `@deepseek-ai/*` 不因 Linux 支持而修改。
4. 公共 bridge 方法树保持 Electron parity。
5. 用户文件和配置迁移保持幂等，失败保留原文件。
6. Linux 缺失能力以 `supported`、`degraded`、`unavailable` 或
   `external-dependency` 返回，不伪装为成功。

## 平台模块

L2 新增一个深平台模块，其 Interface 只暴露调用者需要知道的稳定行为：

- 解析应用数据目录和内置 runtime 路径；
- 描述客户端更新策略；
- 返回平台 capability 快照。

模块内部提供 Windows 和 Linux 路径/capability Adapter。原生动作归属 L1：Windows
保留 `cmd /c start`、PowerShell clipboard/toast，Linux 使用 `xdg-open`、有界
clipboard helper 和 `notify-send`。L2 只负责文件授权、更新策略和结构化通知意图，
Rust 平台条件不进入业务分流。

## 路径和文件系统

- Linux app data：优先 `$XDG_CONFIG_HOME/deepseek-harness-eac`，否则
  `~/.config/deepseek-harness-eac`。
- `DSH_HOME` 默认仍为 `~/.dsh`。
- Linux 共享模块使用目录 symlink；Windows 继续使用 junction。
- 路径授权在比较前解析存在路径的真实路径，阻止 symlink 逃逸。
- 新建凭据、lease、状态文件采用最小权限；可执行 helper 保留执行位。
- 测试覆盖 UTF-8、LF/CRLF、大小写差异、空格和中文路径。

## 进程和隔离

- 普通 DSH/sidecar 子进程：Windows 使用现有 taskkill 流程，Linux 使用独立
  process group 的 SIGTERM、宽限期和 SIGKILL。
- Extension Host：Windows 保留 Job Object。Linux 首发使用 process group +
  owner pipe lease；Supervisor 管道 EOF 时 Host 主动终止自身进程组。能力标记为
  `degraded`，不得称为 Job Object 等价实现。
- cgroup v2/systemd scope 是后续可选 Adapter；未启用时不承诺崩溃即回收和硬
  CPU/内存限额。

## 桌面集成

- 单实例、窗口、浮窗、恢复中心和托盘继续使用 Tauri。
- 系统通知由 sidecar 发送结构化意图，Tauri L1 在 Windows 使用 PowerShell toast、
  Linux 使用 `notify-send`。Linux 后端缺失会记录明确失败；Electron 点击回调保留，
  Tauri/Linux 点击回调仍不是完全等价能力。
- Linux 快捷方式使用 `.desktop`/XDG applications，不模拟 `.lnk` 元数据。
- Linux 剪贴板优先 portal/桌面会话能力；命令后端缺失时返回
  `external-dependency`，不静默丢弃内容。
- 全局快捷键、串口、设备、驱动和系统服务不在当前产品能力中。

## 插件能力

| 能力 | Linux 首发策略 |
| --- | --- |
| 普通 DSH/Web 插件、市场、profile、恢复、快照 | supported |
| terminal、better-sidebar PTY | supported，校验 Linux node-pty payload |
| picturereader 文档转换 | external-dependency：Python/LibreOffice |
| OCR | external-dependency：Paddle/Rapid/Tesseract，不冒充 Windows.Media.Ocr |
| computer-user | unavailable；Wayland 不存在透明 SendInput 等价物 |
| dsh-dafeiyu | unavailable；仅在 Python helper 通过 Linux smoke 后重新评估 |

## 更新和分发

Windows 继续执行现有 NSIS/便携应用内更新。Linux 只检查新版本并打开 Release
页面，由包管理器或用户替换程序包；不得下载 Windows `.exe` 或调用 Windows
apply helper。

Tauri Linux 配置独立于 Windows 配置。资源装配必须在目标平台执行 npm 安装和
Rust N-API 构建。Linux 可达运行树不得包含 Windows `.node`、`.dll` 或 helper；
Windows-only 插件的源资产可以留在仓库，但必须从 Linux staging 排除。带
`--skip-npm` 的 staging 只有在目标平台戳一致时才可复用依赖。

## 验收

- Windows CI：原全量测试、native clippy/test/build、NSIS/便携构建继续通过。
- Linux CI：typecheck、全量测试、native clippy/test/build、Tauri check、deb 和
  AppImage 构建通过。
- bridge/sidecar 契约、主窗启动、单实例、托盘、退出零孤儿在两平台验证。
- staging 和解包后的最终 deb/AppImage 都必须审计；拒绝错误平台二进制、缺执行位、
  绝对本机路径和 GLIBC 超基线依赖。
- 无法自动化的 Wayland portal、真实安装升级和桌面环境行为记录为未验证，不能
  由编译成功替代。

## 假设与待确认

- 已按仓库现状假设首发目标为 Ubuntu 22.04 x86_64、glibc 2.35；用户给出的技术
  信息模板未填写最低 Windows 版本，Windows 最低版本仍需产品负责人确认。
- 假设 Linux 允许依赖桌面会话提供 `xdg-open`，剪贴板命令后端缺失时允许明确
  降级；是否必须首发 portal 原生剪贴板仍需确认。
- 假设 Linux 更新由包管理器/用户接管，不能把 Windows 的原地替换语义照搬过去。
- 需要确认 Linux 通知点击回调是否为首发阻断项，以及 `.desktop` 是否只需安装器
  生成，还是必须提供与 Windows `.lnk` 同级的运行时维护。
- 需要确认同一 profile 在 Windows/Linux 间复用时，已启用但 Linux unavailable
  的插件应保持配置并报错，还是生成平台覆盖层；当前实现只约束内置推荐和同步。
