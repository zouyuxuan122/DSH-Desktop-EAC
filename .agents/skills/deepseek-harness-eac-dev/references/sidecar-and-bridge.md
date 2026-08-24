# Sidecar 与 Bridge 规范

## Sidecar

- `tauri-shell/sidecar/server.ts` 是 L2 服务装配和 RPC 入口。
- L2 模块通过明确的初始化上下文注入依赖。
- RPC 响应使用稳定的成功与错误结构。
- 长任务通过通知报告进度，不阻塞壳层消息循环。
- 服务启动、重启和关闭必须保持进程状态一致。

## Bridge

- `window.dshDesktop` 是 Web UI 与桌面壳的兼容契约。
- bridge 的公开键集必须与冻结 preload 契约保持一致。
- 内省键只能用于壳页面和调试，不泄漏任意原生能力。
- 通知订阅需要可卸载，避免窗口重建后重复监听。
- 浮窗必须保持会话和数据目录隔离。

## 新增 RPC

1. 明确方法归属 L1 或 L2。
2. 定义参数、返回值、错误码和超时。
3. 在调用端和实现端同步类型。
4. 检查是否需要通知事件。
5. 增加契约测试和最小运行时验证。

## Electron parity

虽然 Electron 壳已冻结，`bridge-preload-parity.test.mjs` 仍锁定 Tauri bridge 与 Electron preload 的公开方法树。

新增 `window.dshDesktop` API 时必须二选一并明确记录：

1. **保持 parity**：同步更新 `bridge.ts`、`preload.js`，必要时在 `main.js` 增加最小对等实现。
2. **正式解除 parity**：先形成架构决策并调整契约测试，不能只让测试变宽或静默忽略新方法。

默认选择保持 parity。Electron 同步修改仅用于契约兼容，不承载新的业务实现。

## 禁止

- 暴露任意命令执行、任意路径写入或任意进程终止接口。
- 只改 bridge 不改实现，或只改实现不维护 parity。
- 使用界面文案作为 RPC 协议字段。

## 当前装配模块

`server.ts` 的 `MOUNTED` 当前包含：

```text
proc
runtime-paths
profile
guard-box
runtime-patches
companion-sync
plugin-ops
market
shortcuts
junction-patrol
client-update
static-preview
file-roots
boot-server
```

新增 L2 模块时需要：

1. 加入源码和 TypeScript 构建。
2. 在 sidecar 中 mount 并调用 `init`。
3. 注入最小上下文。
4. 检查 staged resources 和编译产物。
5. 增加启动或契约测试。

## 核心检查命令

```powershell
cd dsh-desktop
node --test test/bridge-preload-parity.test.mjs

cd ..\tauri-shell
cargo run -- --bridge-test
```
