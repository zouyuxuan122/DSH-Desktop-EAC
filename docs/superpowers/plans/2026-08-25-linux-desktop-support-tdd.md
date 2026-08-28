# Linux 桌面支持 TDD 方案

## 测试 seams

测试只通过以下公开 Interface 观察行为：

1. 平台模块：给定 platform、env 和 home，返回路径、runtime 和 capability；Tauri
   原生动作通过 L1 RPC/通知契约观察。
2. 进程模块：给定真实子进程 PID，调用公开终止方法后观察进程组是否退出。
3. 文件根模块：给定已登记会话根和候选路径，返回允许或拒绝；L1 只打开 L2 授权路径。
4. 客户端更新模块：给定 release 和平台策略，观察是否下载、应用或仅提示。
5. 构建契约：运行现有 npm/Cargo/Tauri 入口并检查目标平台产物。

Windows 和 Linux Adapter 是同一 Interface 的两个实现，证明该 seam 真实存在。
测试不读取私有函数、不断言内部命令调用次数，也不把源码正则当成功能测试；仅在
构建/资源本身就是公开契约时使用文本检查。

## 垂直切片

### Slice 1：XDG 数据目录

1. Red：Linux + `XDG_CONFIG_HOME=/tmp/xdg` 应返回
   `/tmp/xdg/deepseek-harness-eac`，当前硬编码 AppData 导致失败。
2. Green：平台 Adapter 返回 XDG 路径，sidecar 消费该结果。
3. 回归：Windows 仍返回 `%APPDATA%/Deepseek Harness EAC`。

### Slice 2：runtime 文件名

1. Red：Linux 打包态应解析 `vendor/node/node`，当前返回 `node.exe`。
2. Green：runtime path 使用平台文件名。
3. 回归：Windows 打包态和开发态字面路径不变。

### Slice 3：桌面动作

1. Red：Linux 打开文件不得调用 `start`；clipboard 后端缺失应返回明确错误。
2. Green：Rust L1 使用参数化 `xdg-open` 和有界 clipboard backend；L2 不执行原生命令。
3. 回归：Electron 与 Tauri Windows 的 PowerShell/stdin、toast 和 `start` 语义保持。

### Slice 4：Rust 外链

1. Red：Linux `cargo check` 证明无条件 `CommandExt` 编译失败。
2. Green：平台 cfg 后 Linux 编译通过。
3. 回归：交叉检查 Windows target 或在 Windows CI 编译。

### Slice 5：进程和路径安全

1. Red：创建父子进程组，终止后仍存活即失败；创建指向根外的 symlink，路径授权
   返回 true 即失败。
2. Green：复用 POSIX group kill，授权比较使用真实路径。
3. 回归：Windows taskkill 和普通根内文件仍通过。

### Slice 6：Linux 更新策略

1. Red：Linux 新版本不得进入 `downloadRelease`/`applyUpdate`。
2. Green：策略返回 external handoff，并显示 Release 下载提示。
3. 回归：Windows 更新事务测试保持通过。

### Slice 7：目标平台成品

1. Red：Linux 可达运行树出现 `.exe`、`.dll`、win32 native payload 或缺执行位即失败。
2. Green：目标平台重建 runtime、node_modules 和 Rust `.node`。
3. 回归：Windows 成品审计继续要求对应 `.exe`、`.dll` 和 NSIS 资产。

### Slice 8：Linux 快文件系统下的快照唯一性

1. Red：在本地 `/tmp` 连续创建/恢复/裁剪快照，毫秒时间戳目录发生覆盖，现有
   restore 与“最多 10 份”测试稳定失败。
2. Green：以原子 `mkdir` 领取快照 ID，碰撞时追加固定宽度序号。
3. 回归：原有无后缀快照 ID、last-good 查找、恢复前快照和 10 份裁剪保持兼容。

## 每轮命令

Red 只运行当前失败测试并保存失败原因。Green 只增加让该行为通过的最小实现，随后
运行同一测试。一个 slice 通过后运行受影响测试组；跨 L1/L2 的 slice 至少运行：

```text
npm run typecheck
node --test test/<target>.test.ts
node --test test/bridge-preload-parity.test.ts
cargo check --locked
```

完成所有 slice 后运行 `npm test`、两套 native test/clippy/build、Tauri Linux
check 和资源审计。Windows 构建只能由 Windows 环境/CI 认定通过；Linux 本机不能
把源码检查写成 Windows 已验收。

## 执行结果

- 每个新增平台行为均先以定向失败测试固定，再实现 Adapter/策略；bundle musl
  过滤和快照 ID 碰撞也按 Red-Green 完成。
- 2026-08-25 最终本机结果：typecheck 通过；Node 687 项为 679 pass、8 skip、
  0 fail；supervisor 4/4、snapshot 16/16；两套 clippy/build 与 Tauri check 通过。
- fresh Linux staging 审计通过；deb 可构建，但最终审计拒绝本机 GLIBC 2.39 壳。
  AppImage 仅完成到 GTK plugin；目标产物绿灯必须来自 Ubuntu 22.04 CI。
- Windows CI 与真实桌面 smoke 不可用本机结果替代，继续作为发布门槛。
