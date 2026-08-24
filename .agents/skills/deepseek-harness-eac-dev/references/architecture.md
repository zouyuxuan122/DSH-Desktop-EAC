# 架构与代码归属

## 三层边界

| 层级 | 位置 | 职责 |
| --- | --- | --- |
| L1 桌面集成层 | `tauri-shell/src/main.rs` | 窗口、托盘、单实例、原生菜单、壳页面、原生文件和进程能力 |
| L2 业务服务层 | `tauri-shell/sidecar/`、`dsh-desktop/lib/desktop/` | 进程编排、profile、插件治理、更新、救援、余额和会话服务 |
| L3 DSH 内核 | `@deepseek-ai/dsh`、Cordis 插件树、Web UI | Agent、会话、模型、插件运行时和 Web 产品能力 |

## 放置规则

1. 能作为 DSH host/client 插件实现的新功能，优先使用插件。
2. 需要复用桌面业务但不需要原生窗口 API 的能力放入 L2。
3. 只有窗口、托盘、系统对话框、剪贴板、快捷方式和单实例等原生能力进入 L1。
4. Rust 壳通过有限 RPC 调用 L2，不复制插件、profile 或更新业务。
5. 原则上不修改 L3 上游包来适配桌面壳；仅允许按 `dependency-patches.md` 维护已经批准的补丁、vendored 覆盖和 staging 重放链路。

## 修改前检查

- 找出入口和所有消费者。
- 检查 Electron 冻结实现是否仍是契约参考。
- 检查 sidecar、bridge、测试和打包资源是否存在镜像实现。
- 区分源码事实源、编译产物和 vendored 第三方代码。
- 跨层新增接口时先定义请求、响应、错误和通知结构。

## 禁止的架构漂移

- 在 Rust 中重新实现 `syncCompanionPlugins`、profile 园艺或更新策略。
- 在插件中直接控制桌面窗口或进程树。
- 让 Web 客户端获得任意 shell、文件或进程权限。
- 在 `dependency-patches.md` 规定的受控例外之外，通过修改上游 DSH 包绕过 EAC 的适配问题。

## 当前主要入口

- L1：`tauri-shell/src/main.rs::main`
- L1 RPC 分流：`handle_shell_method`
- L1 sidecar 通知：`handle_sidecar_notify`
- L2 装配：`tauri-shell/sidecar/server.ts`
- L2 启动：`dsh-desktop/lib/desktop/boot-server.ts::startAndWait`
- 插件同步：`companion-sync.ts::syncCompanionPlugins`
- Profile 初始化：`profile.ts::ensureDesktopProfileInit`
- 客户端更新：`client-update.ts::runClientUpdateFlow`
- L3 启动命令：内置 Node 执行 `dsh web`

完整联动关系见 `change-impact-matrix.md`。
