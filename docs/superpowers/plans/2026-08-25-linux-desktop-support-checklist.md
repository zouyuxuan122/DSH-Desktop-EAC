# Linux 桌面支持验收清单

`[x]` 表示已有本机自动化或成品证据；`[ ]` 表示仍需对应 OS/桌面环境/CI 证据。

## Windows 零回归

- [x] Windows 外链仍使用 `cmd /c start` 和 `CREATE_NO_WINDOW`（源码与单测）。
- [x] `node.exe`、PowerShell clipboard、`.lnk`、taskkill、Job Object 保留（源码与单测）。
- [x] NSIS 接管、注册表和便携更新流程未改为 Linux 语义（diff/单测）。
- [x] Electron bridge parity 通过。
- [ ] Windows CI、NSIS、便携 zip 和升级 smoke 通过。

## Linux 构建

- [ ] Node 24 与 npm lock 已固定；Rust 当前仍跟随 `stable`，尚未固定精确版本。
- [x] Linux `cargo check` 不引用 `std::os::windows`。
- [x] supervisor/snapshot 生成 Linux `.node`，clippy/test/build 通过。
- [ ] Ubuntu job 已声明 WebKitGTK、AppIndicator、librsvg 和 patchelf；尚未实际运行。
- [ ] deb 内容已验证，但本机 Rust 壳为 GLIBC 2.39；AppImage 未生成最终文件，均待 Ubuntu 22.04 CI。
- [x] GLIBC、架构、错误平台和 musl payload 审计通过。

## 运行时

- [x] XDG app data 与 `DSH_HOME` 分离（自动化）；真实安装写权限待 smoke。
- [x] sidecar JSON-RPC/capability 自动化通过；真实 `boot.start` GUI 会话仍未验。
- [ ] 单实例、主窗、浮窗、恢复中心和托盘可用。
- [ ] 外链、文件打开、剪贴板和通知返回真实结果。
- [ ] 正常退出、崩溃和重启后没有可归属的孤儿进程。
- [x] Linux 客户端更新不会下载或执行 Windows 安装器。

## 文件系统与安全

- [x] 路径授权拒绝 `..` 和 symlink 逃逸。
- [ ] 大小写不同的插件/文件名不会互相覆盖。
- [ ] UTF-8、中文/空格路径、LF/CRLF 和 BOM 可处理。
- [ ] 状态/lease/凭据权限符合 0600/0700 约束。
- [x] 随包 Node runtime 保留执行位；其他 helper 仍需成品 smoke。
- [ ] 日志、诊断包和 CI 输出不含凭据或完整用户目录。

## 插件

- [x] 普通 Web 插件、profile、市场、恢复和快照自动化通过。
- [x] terminal/better-sidebar staging 使用 Linux PTY payload；真实终端会话未验。
- [x] `computer-user` 标记 unavailable，不进入 Linux staging/推荐。
- [x] OCR capability 声明外部依赖，不冒充 Windows.Media.Ocr；真实后端未验。
- [x] dsh-dafeiyu 未通过 helper smoke，Linux staging 保持排除。
- [x] Linux 不同步含固定 Windows shell 路径的内置 preset。

## CI 与发布

- [x] Windows 和 Linux jobs 独立，任一失败均阻止合并。
- [x] 测试、native、staging 和 Tauri 构建命令与本地一致。
- [x] 发布资产按平台、架构和版本命名。
- [x] Linux staging 不含另一个平台/ABI 的二进制；最终包审计已配置为上传前门槛。
- [ ] 未验证项在发布说明中逐项列出。

## 2026-08-25 本机验收记录

- 通过：`npm run typecheck`；Node 全量测试 687 项（679 pass、8 skip、0 fail）；
  两套 native clippy/test/build；Tauri `cargo check --locked --offline`。
- 通过：Linux staging 32,414 文件、6 个 `.node`，x86_64 ELF、glibc <= 2.35；
  fresh production install 不含 dev-only `unzipper`。
- 部分通过：deb 可构建且不再内嵌仓库绝对路径；SHA-256
  `60ed8d916319b64be76a623cf0260cabe97382467fcf2144d5a49a762450395c`。最终审计拒绝
  本机 Rust 壳的 GLIBC 2.39，因此该文件不是 Ubuntu 22.04 发布候选。
- 未通过/环境阻断：AppImage 在 Arch/WSL 的 `linuxdeploy-plugin-gtk` 阶段因系统
  没有 GDK PixBuf loader 目录失败；目标 Ubuntu 22.04 CI 仍需给出最终证据。
- 未验证：Windows CI/NSIS/portable、真实 GNOME/KDE/X11/Wayland、通知、托盘、
  安装升级、GUI 生命周期零孤儿、OCR/文档转换外部 helper。
