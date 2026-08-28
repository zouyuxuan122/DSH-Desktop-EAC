# Tauri 与 Rust 壳规范

## L1 职责

- 创建和管理主窗、浮窗、托盘与壳页面。
- 处理单实例、窗口拖拽、最大化、关闭和退出策略。
- spawn Node sidecar，并在退出时有界关闭进程树。
- 本地拦截纯壳方法，其余 RPC 转发给 sidecar。
- 广播 sidecar 通知和窗口状态通知。

## 修改检查

- 主窗和浮窗是否需要不同的数据目录或权限。
- 方法属于 Rust 本地处理还是 sidecar 业务处理。
- 壳页面 `/loading`、`/exit`、`/died`、`/update`、`/about`、`/wizard` 是否受影响。
- 开发态和打包态 `resource_root` 是否都能定位资源。
- 退出路径是否等待 DSH 和 sidecar 结束，且不留下孤儿进程。

## 环境

- Windows 正式构建优先使用项目要求的 MSVC Rust 工具链。
- 检查当前 host target；GNU target 缺少 `dlltool.exe` 时不能把环境失败误判为源码失败。
- Release 需要的 Tauri feature、NSIS hooks 和 WebView2 安装方式必须与配置一致。

## 必测

- Rust 静态检查或构建。
- sidecar 启动和退出。
- bridge 方法基本回环。
- 受影响窗口行为的 GUI smoke。
- 打包资源改动需要验证真实安装树。

## 当前壳方法

`handle_shell_method` 本地处理：

- `win.minimize`
- `win.toggle-maximize`
- `win.close`
- `win.close-force`
- `win.hide`
- `win.is-maximized`
- `win.start-dragging`
- `float.open`
- `float.close`
- `float.ready`
- 部分 `menu.action`
- `shell.open-external`
- `log.*`
- `recovery.restart`

未命中的方法由 WebSocket 中继给 sidecar。新增方法前必须先决定归属，不能在两端重复实现。

## 当前 sidecar 通知

Rust 直接处理：

- `boot.web-ready`
- `boot.server-died`
- `client-update.show`
- `client-update.hide`
- `shell.about`
- `wizard.show`
- `wizard.close`
- `shell.relaunch`
- `shell.quit-for-update`

修改通知名称时同步 sidecar、Rust 和 bridge 订阅者。
