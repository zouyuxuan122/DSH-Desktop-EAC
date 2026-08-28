# ADR 0003：插件进程隔离架构（VNext，L2 Supervisor 落位）

日期：2026-08-24
状态：已接受

## 背景

重构版分支（refactor/vnext-ts-isolation）实现了「受监管核心 + 隔离扩展宿主 +
独立恢复中心」架构：Electron main 进程充当 Supervisor，每个 SDK 插件跑在独立
Node 子进程（Extension Host），经 Win32 Job Object 围栏隔离；受信 Core Bridge
把隔离插件的工具/上下文桥接进 dsh Agent。本地 5.1.0（Tauri 主线）此前插件全部
跑在 L3 dsh web 进程内（同进程共享，插件崩溃 = 整个 agent 停摆）。

vnext-absorb 把该体系吸收进本地 Tauri 三层架构。重构版以 Electron main 为
Supervisor；本 ADR 记录 Tauri 下的等价落位与取舍（回答两分支合并的架构冲突）。

## 决策

### 1. Supervisor = L2 sidecar（非 Electron main，非 Rust 壳）

三层边界（ADR 0002 不变）：

```
┌─ L1 Rust 壳（Tauri）：窗口/托盘/WS 桥/恢复中心窗口/relaunch —— 新增
│    open_recovery_center_window + 托盘「恢复中心…」+ relaunch-safe-mode
├─ L2 Node sidecar：Supervisor（本 ADR 主角）
│    lib/supervisor（注册表/状态机/原子安装/权限/事故）
│    + lib/extension-host（Manager/RPC/SDK/Job 围栏/Core Bridge 端点）
│    + lib/recovery-center（动作分发，窗口在 L1）
├─ L3 dsh web：受监管核心 + Legacy cordis 插件（39 个，保持同进程零破坏）
│    + 受信 Core Bridge 插件（dsh-eac-core-bridge）
```

重构版的「Supervisor=main 进程」映射为「Supervisor=sidecar 进程」：sidecar 本就
是壳无关业务层（ADR 0002），spawn 子进程、管文件、写注册表的能力齐备；Rust 壳
不承载业务逻辑，只做窗口/托盘/重启等 L1 能力。**不冲突**：sidecar 编排 dsh web
与 Extension Host，两者同为它的子进程。

### 2. 隔离边界（纯增量，现有生态零破坏）

- 现有 39 个 cordis 插件（assets/plugins）继续走 L3 同进程 + plugin-guard 治理
  （快照/回滚/体检/守护启动），风险等级 legacy-cordis，注册表建档但**不拉起
  Host**；
- 隔离只对 SDK 插件生效（extensions/ 目录、kind=isolated）：内置示例
  sample-sdk-plugin + 未来市场安装的 SDK 插件；
- Core Bridge（dsh-eac-core-bridge）作为受信组件随包分发、默认启用，运行时
  经 sidecar 注入的 DSH_EAC_BRIDGE_URL/TOKEN 回环调用 Supervisor。

### 3. 恢复中心 = L1 窗口 + L2 分发

- 窗口：Rust WebviewWindow（980x720，独立 data_directory），加载壳层
  http_serve 的 /recovery-center 页（注入专用 preload → window.rc）；
- 分发：sidecar `rc.action` 方法 → lib/recovery-center handleRcAction（复用
  plugin-ops / guard-box / registry / logger.buildDiagnosticsZip）；
- 三入口：托盘菜单「恢复中心…」、启动失败链（boot.failed 通知）、
  DSH_DESKTOP_RECOVERY=1（Rust 直开 + sidecar boot 短路）。

### 4. 安全模式（本地语义，非重构版 env-relaunch）

重构版用 DSH_DESKTOP_SAFE_MODE=1 环境变量；本地既有机制是
`<DSH_HOME>/guard/safe-mode.json` + companion-sync 守卫。恢复中心 safe-mode
动作：guard 快照 → safeModePatch 只留核心行 → 写 safe-mode.json → 请求 Rust
relaunch（sidecar 通知 shell.relaunch-safe-mode）。

### 5. 明确不做（沿用重构版非目标声明）

- 进程隔离 ≠ 恶意沙箱（诚实边界：插件仍可裸 require node 内建，硬边界是
  进程围栏 + Core Profile 零写入）；
- 内核零改动：不碰 @deepseek-ai/*；L3 cordis 插件契约逐字节不变；
- 市场 SDK 插件签名（Phase 4 后续项）。

## 后果

- 正面：插件崩溃不再拖垮核心回合（调用级超时丢弃）；恢复中心三入口永远可达；
  Job Object 围栏（KILL_ON_JOB_CLOSE）保证 Supervisor 崩溃零孤儿；
- 代价：sidecar 多一类子进程编排；native/supervisor（Rust）成为发布链硬依赖
  （predist 强制 copy .node，缺失即打包失败）；
- 兼容：main.js（冻结 Electron 回退链）不加载 vnext 模块，回退路径零影响。
