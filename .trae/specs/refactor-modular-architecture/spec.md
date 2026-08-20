# VNext 插件隔离架构 · TypeScript 全面重构（refactor/vnext-ts-isolation）Spec

> 依据仓库根《vnext-plugin-isolation-architecture.md》（下称"架构文档"）制定**加强版**方案：
> 在不修改 dsh 源代码的前提下，把 dsh 核心装进"受监管容器"，外置插件随插随拔且**几乎绝对安全**；
> 同时将项目全部 JavaScript 迁移为 **TypeScript（strict）**，并以 **Rust（napi-rs 原生模块）**
> 实现 OS 级进程围栏（Win32 Job Object 等），获得比原方案**更安全、更高性能**的实现。

## Why

`main.js`（4424 行）单文件承担全部职责；外置插件与 Harness 共享进程/Cordis 上下文/profile 依赖图，插件故障即拖垮核心；全项目无类型约束，重构与扩展风险高。需要：①以 strict TypeScript 重建全部自有代码（类型即安全）；②落地"Supervisor + Core Harness + Extension Host + Recovery Center"隔离架构；③用 OS 级手段（Job Object）与 deny-by-default 权限门把隔离做到比架构文档基线更强的程度。

## What Changes

### A. 全局纪律

- **分支** `refactor/vnext-ts-isolation`（基于当前 `feat/builtin-terminal` HEAD）；每个里程碑 = `npm test` 全绿 + `tsc --noEmit` 零错误 + check-syntax 通过 → 独立 git 提交。
- **既有界面与功能不变**：窗口/托盘/IPC 协议/preload API/更新流程/Legacy 插件行为外部可观察一致；恢复中心、SDK 插件等为纯增量。
- **不修改 dsh 源代码**：`vendor/`、`node_modules/@deepseek-ai/*` 不动；核心集成沿用 cordis.patch.yml 机制（EAC 受信任组件身份）。
- **测试安全网**：457 个既有测试语义全程保持（随模块迁移为 `.test.ts`，断言等价）；新增功能各配测试。运行环境 Node ≥ 26（原生 type-stripping，`.ts` 直跑）。
- **删冗余**：删除零引用的 `extract-css.mjs`；其他候选验证零引用后再删。
- **注释与日志**：新模块文件头职责注释 + 非自明函数中文 JSDoc（TS 类型注释优先）；关键路径接入 `structuredLogger`（pino，异步落盘），双 trace-id 贯穿。

### B. TypeScript 全面迁移（JS → TS，strict）

1. **工具链**：新增 `typescript` devDependency + `tsconfig.json`（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`；CommonJS，与 Electron 主进程一致）。
2. **布局**：自有源码原地 `.js → .ts`（`main.ts`、`updater.ts`、`lib/**/*.ts`、`preload/index.ts`、`scripts/**/*.ts`、`test/**/*.test.ts`）；`outDir: dist`，`rootDir: .`，编译产物 1:1 映射（`dist/main.js`…）。
3. **运行时**：`package.json` `main → dist/main.js`；`npm start / pack / dist` 前置 `npm run build`（tsc）；运行时（Electron/内置 node.exe）只执行编译后 JS，vendor node 无需 TS 支持。
4. **类型边界**：`src` 内共享协议类型（RPC 消息、注册表结构、SDK API 面、IPC channel 签名）单点定义，主进程/Host/桥/preload 复用同一份 `.d.ts` 源；杜绝 `any` 逃逸（lint 规则 `@typescript-eslint/no-explicit-any` 报错级）。
5. **测试迁移**：57 个 `.test.mjs` → `.test.ts`（import 指向 `.ts` 源，node --test type-stripping 直跑）；读取源码文本的断言改指 `.ts` 源文件，语义等价。
6. **构建守护**：`check-syntax` 适配为"扫描 `.ts` 源（保留 v0.3.8 事故的 detached-keyword 防呆）+ 校验 dist 产物存在且 require 可解析"；`bundled-files` 测试改为解析 `main.ts` 顶层 import 并映射 `dist` 路径核对 electron-builder files 清单。
7. **绞杀式迁移**：`allowJs` 过渡期允许 JS/TS 共存，每里程碑完成一族模块 JS→TS + 类型化 + 对应测试迁移 + 全量回归；结束态 `allowJs: false`。

### C. Phase 0：恢复中心与稳定面（架构文档 §9 Phase 0）

1. **恢复中心**：`assets/recovery-center.html` 静态页 + 独立 BrowserWindow，**不依赖 dsh web**。能力：插件清单（来源/版本/风险等级/状态/最近错误/权限）、停用/启用、卸载、回滚（复用 plugin-guard 快照）、强制隔离与解除、插件/核心日志查看、事故报告、导出诊断包（复用 `buildDiagnosticsZip`）、安全模式启动（禁用全部外置插件拉起核心）。
2. **三入口永远可达**：托盘常驻菜单、`handleBootFailure` 启动失败路径、`DSH_DESKTOP_RECOVERY=1` 环境变量直开。
3. **插件档案**：每插件记录来源（builtin/market/manual）、风险等级（trusted-core/legacy-cordis/isolated-sdk）、最近启动失败记录，写入扩展注册表。
4. **市场覆盖围栏**：固化 `builtin-collision` 拦截测试：市场包不得覆盖内置/核心组件，违规自动迁移 + 事故记录。

### D. Phase 1：配置分离 + 扩展注册表（架构文档 §9 Phase 1）

1. **目录边界**（架构文档 §7.1）：

```text
<DSH_HOME>/
├─ profiles/web-desktop/        # Core Profile：仅官方 bundle + EAC 受信任组件 + Core Bridge 可写
├─ extensions/
│  ├─ registry.json             # 状态机 + 来源 + 版本 + 包哈希 + 权限 + 崩溃计数
│  └─ <plugin-id>/{package,data,logs}/
├─ rollbacks/ guard/ incidents/ # 沿用 plugin-guard 体系
```

2. **故障状态机**（架构文档 §8）：`installed → disabled → starting → running ⇄ retrying → failed → quarantined → disabled/uninstalled`；指数退避重试、连续失败阈值自动隔离、解除隔离手动重试；全部转移写事故记录（版本/日志位置/时间/恢复动作）。
3. **Supervisor 原子安装**：SDK 插件"临时目录 → SHA-256 校验 → 原子切换"进 `extensions/<id>/package`；**Core Profile 依赖图零写入**（测试断言）。Legacy 插件沿用现行机制（兼容模式、行为不变），注册表标注 `legacy` + 风险等级。

### E. Phase 2：Extension Host + SDK V1（架构文档 §5/§9）

1. **Extension Host**：每启用 SDK 插件一个独立 Node 子进程（内置 node.exe 拉起 `dist/host-bootstrap.js`），JSON-RPC over stdio（nanoid 请求 ID、长度前缀帧）；Supervisor 侧管理 spawn、心跳 ping/pong 超时、调用级严格超时、崩溃退避重启、超阈值隔离。
2. **SDK V1**（不暴露 Cordis 实例/核心 profile 写权限/任意 require）：Agent 工具注册（schemastery 校验）、只读事件订阅、受控上下文注入（schema 验证 + 超时丢弃）、设置 schema + 独立命名空间（`extensions/<id>/data/`）、结构化日志、健康心跳。
3. **Core Bridge**（受信任 cordis 组件，运行于 Core Harness）：工具/上下文桥接到 Agent；扩展超时或异常 → 记录 + 熔断该插件 + 继续核心回合。
4. **样板**：新建 1 个最小 SDK 示例插件（agent 工具 demo，随仓库分发）；迁移 1 个简单伴生插件（`dsh-auto-compact` 级别）为隔离样板；其余伴生插件保持 Legacy。

### F. 比架构文档基线更强的安全与性能（用户要求："更安全、有更高的性能"）

#### F1 安全增强

1. **OS 级进程围栏 —— Rust 原生模块 `native/supervisor`（napi-rs）**：以 Rust 直接调用 Win32 API 管理 **Job Object**（`CreateJobObjectW`/`SetInformationJobObject`/`AssignProcessToJobObject`/`CreateProcessW`）：
   - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：Supervisor 崩溃/被杀时 OS 自动回收全部 Host 进程，**杜绝插件孤儿进程**；
   - `JOB_OBJECT_LIMIT_PROCESS_MEMORY`：每插件内存硬上限，超限即终结该 Host（核心不受影响）；
   - **原子 spawn-into-job**：Rust 侧 `CreateProcessW` + 挂起标志 + `AssignProcessToJobObject` 后再 resume——进程创建与 Job 绑定一步完成，消除"先 spawn 后 assign"竞态窗口（子进程可在 assign 前派生孙进程逃逸）；同时按 `JOB_OBJECT_LIMIT_CPU_RATE`/`JOB_OBJECT_LIMIT_RATE_CONTROL` 预留每插件 CPU 配额能力；
   - 相比 JS/koffi 方案的优势：无 GC 停顿、内存安全的原生实现、单文件预编译 `.node`（Node-API ABI 稳定，Electron 与内置 node.exe 均可直接加载）、无 JS↔FFI 多层封送开销。
   - **构建集成**：`npm run build:native`（cargo build --release → napi 产物）；打包产物 predist 强制校验 `.node` 存在；开发机缺工具链时 Supervisor **优雅降级**（警告日志 + 既有 taskkill 进程树回收），不阻塞其余功能开发。
2. **deny-by-default 权限门（提前落地 Phase 4 核心切片）**：插件包声明 `dsh.extension.permissions`（`net` 域名白名单 / `fs` 目录白名单 / `shell` / `env`），host-bootstrap 在 SDK 边界强制执行——未授权能力直接不可见（非运行时报错），网络经受控 fetch 代理、文件经受控 fs 门、子进程默认禁止；授权状态入注册表并在恢复中心展示。
3. **完整性链**：安装哈希锁定（Rust 模块提供流式 SHA-256 供安装器复用，性能优于逐块 JS 摘要）+ 注册表记录 + 回滚版本列表；升级失败不动当前可运行版本（原子切换保证）。
4. **TS 类型即安全**：strict 全开 + 协议类型单点共享，RPC/IPC 边界全部强类型，编译期消灭一类低级错误；Rust 侧由 `cargo clippy`/`cargo test` 守护。

#### F2 性能增强

1. **启动扫描缓存**：`syncCompanionPlugins`/guard 的 profile 文件树扫描结果按 (路径, mtime, size) 哈希缓存，无变化跳过 IO（当前每次启动全量扫描）。
2. **并行拉起**：Extension Host 并行 spawn + 并行握手；启动流程中互不依赖的步骤（preset 同步、快捷方式维护、余额首拉）并行化。
3. **RPC 快路径**：长度前缀帧 + 单次 JSON 解析；心跳与业务帧合流，避免高频小包唤醒（相对裸 JSON-per-line 减少解析与 GC 压力）。
4. **Rust 原生热路径**：spawn-into-job、Job 配额管理、流式 SHA-256 全部在原生层完成——无 V8 GC 停顿、无 FFI 多层封送；大文件哈希（安装包校验）受益最明显。
5. **日志异步管线**：pino 异步 destination（既有 20MB×10 轮转不变），诊断 zip 导出走后台线程级流式压缩。
6. **懒加载**：更新器、余额、终端等非首屏模块首次使用时 require，缩短主进程冷启动。

> 度量：以 `scripts/` 新增 `bench-boot.mjs→.ts` 记录改造前后冷启动关键路径耗时与启动期 IO 次数，验收时对比不劣化、有可见改善。

### 非目标（架构文档 §11 + 本 spec 边界）

- Phase 3（外置 UI 独立窗口化/声明式 UI 协议）与 Phase 4 其余部分（签名审核、可信发布者、低权限账户沙箱）不在本次范围；权限门切片（F1.2）除外。
- 不彻底迁移全部 Legacy Cordis 插件；不重写 dsh 上游；不引入 C/C++ 工具链——系统能力统一由 Rust 原生模块（napi-rs）承担。
- 进程隔离 + 权限门 ≠ 恶意代码完整沙箱（诚实边界，同架构文档；低权限令牌/AppContainer 属 Phase 4）。

## 模块划分（TypeScript + Rust）

| 模块 | 职责 | 备注 |
|---|---|---|
| `main.ts` | 装配入口（Supervisor 组合根） | < 400 行 |
| `lib/state.ts` | 共享可变状态单例（强类型 `AppState`） | 迁自 main.js 顶层 |
| `lib/paths.ts` / `lib/proc.ts` | 路径围栏与 profile/扩展目录；子进程工具与运行时定位 | |
| `lib/run-state.ts` / `lib/watchdog-boot.ts` | 运行状态/备份回滚；看门狗启动 | |
| `lib/server.ts` | Core Harness（dsh web）生命周期 | |
| `lib/window.ts` / `lib/tray.ts` | 窗口族与托盘 | |
| `lib/ipc/{app,session,plugin,update,misc,recovery}.ts` | IPC 分域注册 | channel 名不变 |
| `lib/agent-update.ts` / `lib/client-update.ts` | 双更新流 | |
| `lib/plugins.ts` / `lib/onboarding.ts` | Legacy 插件同步与管理器；引导向导 | 兼容模式 |
| `lib/balance-ui.ts` / `lib/shortcuts.ts` / `lib/migration.ts` / `lib/session-heal.ts` / `lib/terminal.ts` / `lib/preview.ts` | 其余单一职责模块 | |
| `lib/boot.ts` | 启动编排与失败处理 | |
| `lib/supervisor/{registry,installer,incidents,permissions}.ts` | **新增**：注册表/状态机、原子安装、事故、权限模型 | |
| `lib/extension-host/{rpc,manager,job-fence}.ts` + `lib/extension-host/sdk/*` | **新增**：RPC 协议、Host 管理、Job 围栏加载器（含降级）、SDK 运行时 | job-fence 为 Rust 模块的 TS 包装 |
| `native/supervisor/`（**Rust crate，napi-rs**） | **新增**：Win32 Job Object 原生围栏——原子 spawn-into-job、KILL_ON_JOB_CLOSE、内存/CPU 配额、流式 SHA-256；`cargo clippy`+`cargo test` 守护 | 产出单文件 `.node`，Electron/内置 node.exe 双端可载 |
| `host-bootstrap.ts` | Host 进程入口（编译产物随包分发） | 含权限门执行 |
| `lib/recovery-center/register.ts` + `assets/recovery-center.html` | **新增**：恢复中心窗口与 IPC | 不依赖 dsh web |
| `shared/protocol.ts` | RPC 消息/注册表/SDK API/IPC 签名的**单点类型源** | 编译供三方复用 |
| `extensions/sample-sdk-plugin/` | **新增**：最小 SDK 示例插件 | 随仓库分发 |

规模约束：`main.ts` < 400 行；任何自有 TS 源码文件 ≤ 600 行（vendor/dist/assets 除外）；Rust crate 单文件 ≤ 600 行。

## Impact

- Affected code: `dsh-desktop/` 全部自有 `.js/.mjs`（迁移 TS）、`package.json`（build/typecheck/build:native scripts、typescript devDep）、`electron-builder.yml`（files/extraFiles 纳入 `.node` 与新产物）、`check-syntax`/`bundled-files` 守护适配；新增 lib 树、`native/supervisor`（Rust）、host-bootstrap、恢复中心、示例插件、`<DSH_HOME>/extensions/`。
- 兼容性: Legacy 插件与用户 profile 零迁移；SDK 路径纯增量；IPC/preload API 面不变；Rust 模块缺失时优雅降级不影响既有功能。
- 风险控制: allowJs 绞杀式迁移 + 每里程碑全量回归（457+ 测试、tsc --noEmit、check-syntax、cargo clippy/test）+ 顺序改 main；用户未提交的 package-lock.json 改动不回滚、不混入提交（TypeScript devDep 引起的 lock 变更单独提交说明）。

## ADDED Requirements

### Requirement: TypeScript strict 代码库
全部自有 JavaScript SHALL 迁移为 strict TypeScript（tsconfig strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes），`tsc --noEmit` 零错误，`any` 不逃逸（协议/边界类型单点定义于 `shared/protocol.ts`）；运行时仅执行编译产物。

#### Scenario: 类型门禁
- **WHEN** 任一里程碑提交前运行 `npm run typecheck`
- **THEN** 零错误方允许 commit；结束态 `allowJs: false` 且仓库无自有 `.js/.mjs` 源（编译产物 dist 除外）

### Requirement: 恢复中心永远可达
（同架构文档语义）不依赖 `dsh web`，托盘/启动失败/`DSH_DESKTOP_RECOVERY=1` 三入口；支持停用/卸载/回滚/隔离、日志与事故查看、诊断包导出、安全模式启动。

#### Scenario: 插件树损坏启动失败
- **WHEN** 任意 plugin tree 导致 Core Harness 启动失败
- **THEN** 用户仍能经恢复中心关闭/卸载问题插件并重试启动

### Requirement: 扩展注册表与故障状态机
`<DSH_HOME>/extensions/registry.json` SHALL 维护插件全档案（id/版本/来源/哈希/类型/启用/隔离/崩溃计数/最近错误/权限/可回滚版本），状态机按架构文档 §8 流转且全部转移写事故记录。

#### Scenario: 连续崩溃自动隔离
- **WHEN** 隔离插件连续失败超过阈值
- **THEN** 自动 quarantined、不再随启动加载，恢复中心可见原因并允许手动重试

### Requirement: Extension Host 进程隔离 + Rust OS 级围栏
每个启用 SDK 插件 SHALL 运行于独立 Node 子进程，并经 Rust 原生模块（`native/supervisor`，napi-rs）以**原子 spawn-into-job** 方式绑入 Win32 Job Object（KILL_ON_JOB_CLOSE + 每插件内存上限 + 预留 CPU 配额），JSON-RPC over stdio 具备心跳超时与调用级严格超时；Rust 模块不可用时 SHALL 优雅降级（警告日志 + taskkill 进程树回收）且打包产物 SHALL 包含预编译 `.node`。

#### Scenario: 插件进程被杀死
- **WHEN** SDK 插件 Host 进程被 kill -9
- **THEN** 核心 Agent 进行中与新发起对话均可完成，状态机 retrying 并按策略处置

#### Scenario: Supervisor 自身崩溃
- **WHEN** Supervisor（Electron 主进程）异常退出
- **THEN** OS 经 Rust 模块创建的 Job Object（KILL_ON_JOB_CLOSE）自动回收全部 Host 子进程，无孤儿插件进程残留（测试验证）

#### Scenario: 插件内存失控
- **WHEN** 插件内存超过其配额
- **THEN** 仅该 Host 被终结并按状态机处置，核心与其他插件不受影响

#### Scenario: 扩展调用超时
- **WHEN** Agent 回合中插件上下文补充请求超时未回包
- **THEN** Core Bridge 丢弃结果继续核心回合并记录事故

### Requirement: Extension SDK V1 与 deny-by-default 权限门
SDK SHALL 不暴露 Cordis 实例/核心 profile 写权限/任意模块访问；插件权限声明（net/fs/shell/env）在 host-bootstrap 强制执行，未授权能力在 SDK 面不可见；授权状态入注册表并在恢复中心展示。

#### Scenario: 未授权网络请求
- **WHEN** 未声明 `net` 权限的插件尝试发起网络请求
- **THEN** SDK 面无该 API 可调用（编译期/边界期即不可见），试探性调用被拒绝并记录

#### Scenario: 新插件零侵入扩展
- **WHEN** 按 SDK V1 编写新插件
- **THEN** 不写 Core Profile 任何文件即可注册工具并被 Agent 调用

### Requirement: 核心配置围栏
SDK 插件安装/更新/回滚 SHALL NOT 触碰 Core Profile 的 package.json/node_modules/cordis.patch.yml/模块解析路径；安装为"临时目录→哈希校验→原子切换"，失败自动回退。

#### Scenario: SDK 插件原子安装
- **WHEN** Supervisor 安装/更新 SDK 插件
- **THEN** Core Profile 依赖图零变化（测试断言），失败时原版本继续可运行

### Requirement: 性能不劣化且有改善
启动扫描缓存、Host 并行拉起、RPC 帧快路径、Rust 原生热路径（spawn-into-job/配额/流式 SHA-256）、日志异步管线、懒加载落地；`bench-boot` 脚本 SHALL 输出改造前后冷启动关键路径耗时与启动期 IO 对比，验收不劣化。

### Requirement: 模块化规模与注释
见"模块划分"约束；每个新模块文件头职责注释 + 非自明函数中文 JSDoc；关键路径结构化日志齐全无重复。

### Requirement: 分支与提交纪律
全程 `refactor/vnext-ts-isolation` 分支；每里程碑（测试全绿 + typecheck 零错 + check-syntax 通过）独立提交；不混入用户未提交改动。

## MODIFIED Requirements

### Requirement: 测试套件守护
457 个既有测试语义全程保持通过（随迁移改名 `.test.ts`、import 指向 `.ts`，断言等价）；新增功能各配单元/集成测试；`npm test` 在 Node ≥ 26 直跑 `.ts`。

### Requirement: 打包完整性
`electron-builder.yml` SHALL 覆盖全部编译产物、host-bootstrap、恢复中心页面、示例插件及 Rust 预编译 `.node`（predist 强制校验存在）；`bundled-files` 测试改为解析 `main.ts` 顶层 import 映射产物路径核对清单，全绿。

## REMOVED Requirements

### Requirement: 冗余调试脚本与 JS 源
**Reason**: `extract-css.mjs` 零引用；全部自有 `.js/.mjs` 源文件被 `.ts` 取代（绞杀式，最终 allowJs:false）。
**Migration**: 直接删除冗余脚本；源码迁移后 `.js` 仅存于 `dist/` 编译产物（构建生成、不入库）。
