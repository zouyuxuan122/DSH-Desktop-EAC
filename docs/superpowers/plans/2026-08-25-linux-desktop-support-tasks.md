# Linux 桌面支持任务

**目标：** 在 Windows 行为零回归约束下，交付 Ubuntu 22.04 x86_64 的 deb 和
AppImage，并建立持续的双平台验证。

**架构：** L1 只实现原生桌面 Adapter；L2 平台模块集中路径、桌面动作、进程和
更新策略；L3 保持不变。每项任务按一个失败测试、最小实现、回归验证推进。

## Task 1：平台模块和 runtime 路径

**Files:** `lib/desktop/platform.ts`、`runtime-paths.ts`、`sidecar/server.ts`、
`test/platform.test.ts`

- [x] 写 Windows 路径和命令行为 characterization tests。
- [x] 写 XDG、Linux runtime 名称和 capability 的失败测试。
- [x] 实现 Windows/Linux Adapter 并接入 sidecar。
- [x] 定向测试和 typecheck 通过。

**风险：** sidecar 数据目录变化可能分裂 Windows 配置。**回滚：** Adapter 保留
Windows characterization tests，可整体撤回 sidecar 注入而不迁移用户数据。

## Task 2：L1 Linux 编译与外链

**Files:** `tauri-shell/src/main.rs`、图标、Tauri Linux 配置

- [x] 用 Linux `cargo check` 固化无条件 Windows import 的失败证据。
- [x] 将 Windows 外链实现放入 `cfg(windows)`，增加 Linux `xdg-open`。
- [x] 保持 Windows `creation_flags` 和 `cmd /c start` 参数不变。
- [ ] Linux 和 Windows target 静态检查通过。

Linux `cargo check --locked --offline` 已通过；Windows target 只能由 Windows CI
完成，当前主机不认领该项。

**风险：** cfg 放置错误会只在 release 或 Windows target 暴露。**回滚：** Linux
函数和配置独立提交，Windows 函数保持原代码块。

## Task 3：进程与文件系统

**Files:** `proc.ts`、`profile.ts`、`file-roots.ts`、Extension Host fence

- [x] 为 POSIX 进程组终止和 fence capability 写失败测试。
- [x] 为 symlink 逃逸和平台链接类型写失败测试。
- [x] 普通 DSH 建立独立进程组；Extension Host 增加 owner-pipe EOF 回收，不修改 Windows Job Object。
- [x] 运行进程、profile、路径安全和 snapshot 测试。

**风险：** POSIX 组杀误伤复用 PGID，或 realpath 拒绝尚未创建的安全目标。
**回滚：** Linux fence 可退回显式 unavailable；路径策略按操作类型分别启用。

## Task 4：桌面动作和 Linux 更新策略

**Files:** `platform.ts`、`client-update.ts`、`sidecar/server.ts`、`main.rs`

- [x] 测试 L2 文件授权/L1 原生动作归属、剪贴板 capability 和 `.desktop` 内容。
- [x] 测试 Linux 更新只提示下载，不调用 apply helper。
- [x] L1 接入外链、文件打开、剪贴板和通知 Adapter，失败返回稳定状态。
- [x] 运行 bridge parity 和客户端更新测试组。

**风险：** Linux 更新分支误入 Windows apply，或桌面命令注入。**回滚：** 更新策略
默认 `external-handoff`，Windows 自更新只由 Windows Adapter 显式开启。

## Task 5：native 构建和资源装配

**Files:** `fetch-node.ts`、`test-runner.ts`、`build-native.ts`、
`stage-resources.mjs`、Linux payload 审计脚本

- [x] 测试/断言 runtime 文件名按平台变化。
- [x] Linux 直接调用 Cargo；Windows 继续使用 `lld-link.exe`。
- [x] staging 在目标平台重建 node_modules 和 `.node`。
- [x] staging 与解包成品审计拒绝 `.exe`/`.dll`、错误 native、musl、本机路径和 GLIBC 超基线。
- [x] `--skip-npm` 仅在 staging 目标平台戳一致时复用依赖。

**风险：** 过滤源插件时漏掉运行入口，或 Windows staging 被 Linux 规则影响。
**回滚：** 平台资源清单分别生成；Linux 打包 job 可独立禁用。

## Task 6：插件能力和 preset

**Files:** `companion-sync.ts`、agent preset、插件 manifest/启动逻辑

- [x] 返回每个受限插件的 capability 状态和原因。
- [x] Linux 不自动启用 `computer-user`。
- [x] PowerShell/Git Bash preset 在 Linux 选择上游原生默认值，不同步 Windows preset。
- [ ] terminal、OCR、dafeiyu 分别运行专项 smoke。

terminal 的 Linux PTY payload 已自动审计；OCR/dafeiyu 外部 helper 与真实桌面 smoke
仍未完成，Linux 包不分发 `dsh-dafeiyu`。

**风险：** 自动改写 preset 覆盖用户配置。**回滚：** 只改变内置分发选择和能力
声明，不迁移未知用户 preset；单个插件可独立保持 unavailable。

## Task 7：双平台 CI 和分发

**Files:** `.github/workflows/ci.yml`、`release-tauri.yml`、
`tauri.linux.conf.json`

- [x] Linux CI 安装 WebKitGTK/AppIndicator/patchelf 依赖。
- [x] Linux job 定义 Node 24、Rust、全量测试、native 构建和 Tauri check。
- [ ] GitHub-hosted Ubuntu job 实际通过并上传 deb/AppImage；Windows job 保持原步骤。
- [x] Release 中平台资产命名不冲突，SHA-256 清单已配置。

本机 deb 可构建，但最终安装树审计正确拒绝其 Rust 壳依赖的 GLIBC 2.39；AppImage
还受 Arch/WSL 缺少 GDK PixBuf loader 目录阻断。两者必须由 Ubuntu 22.04 job 验证。

**风险：** Linux job 拉长或阻塞既有 Windows 发布。**回滚：** jobs 和 release
assets 完全独立，移除 Linux job 即恢复原工作流。

## Task 8：最终审计

- [x] 对照规格逐项核查实现、测试、资源和 CI；审计发现均已修正或列为外部验收门槛。
- [x] 搜索业务代码中的新增平台分支，平台命令集中在 Adapter/L1 边界。
- [x] 运行 typecheck、Node 全量测试、native clippy/test/build、Tauri check 和 bundle 审计。
- [x] 记录未完成的真实桌面、安装升级、Wayland 权限、AppImage 和 Windows 构建验证。

**风险：** 把 Linux 本机静态检查误报为 Windows 已验收。**回滚：** 不改变代码，
将未验证项保持开放并阻止发布门槛勾选。
