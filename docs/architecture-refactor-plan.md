# Deepseek Harness EAC：架构评估与可执行重构任务书

> 本文档供其他 coding agent 直接接手执行。
> 目标是改善可维护性、拓展性和运行可靠性，不是进行一次性全仓库重写。

## 1. 任务结论

采用以下技术路线：

> **TypeScript 模块化桌面核心 + JavaScript 编译产物插件体系**

不要把所有 JavaScript 一次性改写成 TypeScript，也不要改写 dsh 核心或重做插件生态。

执行顺序应为：

1. 先锁定当前行为和测试基线。
2. 在不改变运行时语言的前提下拆分 `main.js`，建立清晰的生命周期和服务状态机。
3. 修复设置写入、IPC、错误处理和进程管理等真实可靠性风险。
4. 先使用 JSDoc / `checkJs` 约束现有 JavaScript。
5. 再将高风险核心边界逐步迁移到 TypeScript。
6. 插件继续以编译后的 JavaScript + `.d.ts` 交付。

## 2. 仓库背景和代码证据

本次评估以 GitHub `main` 对应的提交 `155ecc0` 为基线。当前工作区有用户未提交修改，执行 agent 必须先检查并保留这些修改，不得使用破坏性 Git 命令覆盖它们。

### 2.1 为什么仓库中 JavaScript 多

按已跟踪源码统计，排除 `node_modules/`、`vendor/`、`dist/` 和声明文件后，桌面端及其内置插件约有：

- JavaScript / MJS / CJS：203 个文件
- TypeScript / TSX：3 个文件

但这不等于项目没有使用 TypeScript：

- `dsh-better-sidebar` 的开发流程包含 `tsc` 和 `tsdown`，运行入口是 `lib/index.js`。
- `zat-dsh-engine` 保留 `src/*.ts`，但运行时加载的是 `lib/*.js`。
- 桌面包只需要插件运行时产物，测试明确要求 `dsh-better-sidebar` 不携带 `src/`，以控制安装包体积。
- Electron 的 `package.json.main` 直接指向 `main.js`，当前桌面包没有 TypeScript 编译步骤。

因此应区分：

```text
TypeScript 源码
    ↓ 编译、类型检查
JavaScript + .d.ts
    ↓ 打包
Electron / dsh / Cordis 运行时
```

不要把已发布的 `lib/*.js` 当作需要再次迁移的源代码。

参考：

- [桌面 package.json](https://github.com/Luoye-hb/Deepseek-Harness-EAC/blob/155ecc0/dsh-desktop/package.json)
- [electron-builder.yml](https://github.com/Luoye-hb/Deepseek-Harness-EAC/blob/155ecc0/dsh-desktop/electron-builder.yml)
- [dsh-better-sidebar/package.json](https://github.com/Luoye-hb/Deepseek-Harness-EAC/blob/155ecc0/dsh-desktop/assets/plugins/dsh-better-sidebar/package.json)
- [zat-dsh-engine/package.json](https://github.com/Luoye-hb/Deepseek-Harness-EAC/blob/155ecc0/dsh-desktop/assets/plugins/zat-dsh-engine/package.json)
- [插件打包测试](https://github.com/Luoye-hb/Deepseek-Harness-EAC/blob/155ecc0/dsh-desktop/test/better-sidebar-bundle.test.mjs)

### 2.2 当前架构

```text
Electron main.js
  ├─ 窗口、托盘、生命周期
  ├─ IPC 注册
  ├─ 更新、日志、看门狗
  ├─ profile、插件安装/修复/回滚
  └─ 启动内置 Node
       └─ dsh web
            └─ profile + 动态插件
                 └─ 127.0.0.1 Web UI
                      └─ BrowserWindow / preload IPC
```

当前架构中有一些正确设计，应保留：

- Electron 与 dsh Web 服务分进程运行。
- 使用内置普通 Node，而不是 Electron 的 Node ABI。
- 启动时进行 HTTP 就绪探测。
- Windows/Linux 采用不同的进程树清理策略。
- 插件有快照、健康检查、修复和回滚机制。
- 更新使用 staging 目录和替换回滚。
- 渲染进程有 heartbeat 和恢复页面。
- 打包前后检查 bundle 完整性、原生模块和 Linux glibc 基线。

### 2.3 主要结构性风险

1. `dsh-desktop/main.js` 约 3,500 行，混合了窗口、IPC、服务、更新、插件、文件操作和平台逻辑，造成高耦合。
2. IPC 主要依赖字符串 action 和手写对象，没有共享的静态类型与运行时 schema。
3. `settings.js` 直接 `writeFileSync` 写 JSON；加载损坏文件时直接返回 `{}`，可能导致配置丢失或状态重复执行。
4. 关键路径存在大量裸 `catch {}`，部分错误只被吞掉，难以区分可恢复错误和必须中止的错误。
5. 测试覆盖了大量纯函数和源代码契约，但 Electron 真启动、打包后启动、跨平台进程清理和故障注入仍应加强。
6. 当前风险主要来自子进程、原生模块、插件动态加载、profile/pnpm、文件替换和跨平台生命周期；TypeScript 只能解决其中的参数和契约错误，不能单独解决这些运行时问题。

参考：

- [main.js：dsh 服务生命周期](https://github.com/Luoye-hb/Deepseek-Harness-EAC/blob/155ecc0/dsh-desktop/main.js#L596-L807)
- [main.js：IPC 注册](https://github.com/Luoye-hb/Deepseek-Harness-EAC/blob/155ecc0/dsh-desktop/main.js#L1456-L1813)
- [main.js：启动和退出](https://github.com/Luoye-hb/Deepseek-Harness-EAC/blob/155ecc0/dsh-desktop/main.js#L3432-L3592)
- [settings.js](https://github.com/Luoye-hb/Deepseek-Harness-EAC/blob/155ecc0/dsh-desktop/settings.js#L13-L23)

## 3. 目标架构

建议最终形成以下边界：

```text
main.js / main.ts 只负责组装
  ├─ app-context
  ├─ lifecycle / shutdown-coordinator
  ├─ service/web-service-supervisor
  ├─ platform/process-tree-win|linux
  ├─ ipc/register-ipc + ipc/contracts
  ├─ config/settings + settings-schema + migrations
  ├─ profile/profile-manager + plugin-operations
  ├─ updates/agent-updater + client-updater
  └─ observability/logger + incidents
```

目标不是把所有函数机械移动到新文件，而是让每个模块拥有清晰的输入、输出和生命周期责任。

### 3.1 生命周期状态机

服务和应用生命周期应显式建模，至少包含：

```text
booting → running → restarting → running
    │          │          │
    └──────────┴──────────┴──→ failed

running / failed → stopping → stopped
```

所有启动、重启、更新接管和退出路径必须通过统一 coordinator 执行，禁止每个功能再次实现一套 `quitting → kill → restart/exit` 逻辑。

### 3.2 平台适配

保留平台隔离：

- `platform/process-tree-win.*`：`taskkill`、Windows PID 探测、Windows 快捷方式。
- `platform/process-tree-linux.*`：进程组、信号、Linux 包管理器更新提示。
- 共享层只调用抽象接口，不直接假设当前平台。

不得把 Windows shell 命令带入 Linux 路径，也不得把 Linux 进程组语义直接套用到 Windows。

## 4. 分阶段执行计划

### Phase 0：基线和安全准备

目标：确认现状，避免覆盖用户工作区和引入不可追踪回归。

任务：

1. 执行 `git status --short`，记录所有已有修改。
2. 阅读仓库根目录 `AGENTS.md`，遵守 Windows/Linux、native payload、glibc 和打包约束。
3. 运行现有测试；如果系统没有 `node/npm`，使用仓库内置 Node，并修正测试中硬编码 `node` 的地方。
4. 执行 `git diff --check`。
5. 不构建、不删除、不重置用户已有修改。
6. 建立本次重构的失败基线：启动失败、服务重启、异常退出、设置损坏、插件安装中断和更新中断分别记录日志与现象。

建议先修测试运行时路径：

- 将 `execFileSync('node', ...)` 改为 `execFileSync(process.execPath, ...)`，或从测试配置显式传入 bundled Node。
- 不要依赖系统是否预装 Node 来验证 bundled runtime。

### Phase 1：不改语言，拆分 JavaScript 单体

目标：不改变功能，降低模块耦合。

建议拆分顺序：

1. `web-service-supervisor.js`
   - `startServer`
   - `watchServerProc`
   - `waitUntilUp`
   - 端口重试
   - 服务重启
2. `shutdown-coordinator.js`
   - `killTreeAndWait`
   - `before-quit`
   - 更新接管
   - 浮窗和市场子进程回收
3. `ipc/register-ipc.js`
   - 按窗口、恢复、插件、文件、更新等领域拆分注册函数。
4. `profile/profile-manager.js`
   - profile 初始化
   - junction 修复
   - companion plugin 同步
   - artifact keep/restore
5. `updates/`
   - agent update
   - client update
   - pending update
6. `platform/`
   - Windows/Linux 的进程和路径差异。

要求：

- `main.js` 最终只负责创建 context、注册模块、触发 boot。
- 新模块不得隐式读取大量全局变量；通过 context 或构造参数获得依赖。
- 每次抽取后保持现有 `electron-builder.yml` 文件清单完整。
- 不修改 dsh core、插件入口协议或 native 模块打包策略。

### Phase 2：可靠性优先改造

#### 2.1 设置文件

将 `settings.js` 改为具备以下能力：

- 临时文件写入后 flush，再 rename 替换目标文件。
- Windows/Linux 都使用同目录临时文件，保证 rename 在同一文件系统内完成。
- 写入失败不得静默当作成功。
- JSON 损坏时保留原文件副本或 incident 信息，不得直接覆盖用户证据。
- 增加 `schemaVersion`。
- 增加迁移函数，旧字段例如 `closeToTray` 与新字段 `exitAction` 保持兼容。
- 对字段类型和允许值做运行时校验。
- 对读写操作增加测试：损坏 JSON、并发写入、权限失败、中断恢复、旧版本迁移。

#### 2.2 IPC 契约

建立单一 IPC contract 表：

- channel 名称
- request 类型
- response 类型
- 可调用来源
- 是否幂等
- 错误码

优先覆盖：

- `chrome:window`
- `chrome:menu`
- `chrome:restart-service`
- `guard:action`
- `dsh:plugin-set-enabled`
- `dsh:file-revert`
- `dsh:file-open`
- `chrome:recovery-*`

同时保留现有 sender 校验、路径围栏和 URL allowlist。静态类型不能替代主进程的运行时校验。

#### 2.3 错误处理和日志

将错误分成三类：

1. `recoverable`：记录并使用降级路径。
2. `user-action-required`：记录、显示明确操作和日志位置。
3. `fatal`：停止当前阶段，避免继续运行在未知状态。

关键错误日志至少包含：

- 时间
- 平台
- 应用版本
- agent 版本及来源
- operation ID
- 当前生命周期状态
- 子进程 PID
- 错误堆栈
- 日志文件路径

禁止在关键路径使用没有日志的裸 `catch {}`。如果必须吞掉错误，必须说明它是有意忽略的可选能力，并记录 debug 信息。

### Phase 3：渐进式 TypeScript 化

先为现有 JavaScript 增加 `checkJs` / JSDoc，阻止新代码继续失去类型信息；随后只迁移高风险核心模块。

优先迁移：

1. `settings.ts`
2. `ipc/contracts.ts`
3. `service/web-service-supervisor.ts`
4. `platform/process-tree.ts`
5. `profile/profile-manager.ts`
6. `updates/update-state.ts`

建议类型包括：

- `AppState`
- `WebServiceState`
- `ChildProcessHandle`
- `ShutdownReason`
- `UpdateState`
- `Settings`
- `PluginManifest`
- `IpcRequest` / `IpcResponse`
- `BootFailure`

建议 TypeScript 配置方向：

- `strict: true`
- `useUnknownInCatchVariables: true`
- `noUncheckedIndexedAccess: true`（可按模块逐步开启）
- 先允许旧 JavaScript 共存，再逐步缩小 `allowJs` 范围。
- 编译产物进入独立目录，不能让 TypeScript 文件直接成为生产运行时依赖。
- electron-builder 必须打包编译后的入口、source map 和必要运行时文件。

不迁移以下内容：

- 已发布的 `assets/plugins/**/lib/*.js`。
- dsh/Cordis 运行时要求的 JavaScript 插件入口。
- 仅为“语言统一”而重写的稳定插件。

新插件可以采用：

```text
plugin/src/*.ts
    ↓ tsc / tsdown
plugin/lib/*.js + lib/**/*.d.ts
    ↓ npm/package bundle
桌面端或 dsh runtime
```

### Phase 4：测试和发布可靠性

建立四层测试：

1. **纯单元测试**：设置迁移、端口选择、状态转换、版本比较、路径校验。
2. **契约测试**：IPC request/response、插件 manifest、profile patch、settings schema。
3. **组件测试**：使用 fake child process 和 fake HTTP 服务测试 supervisor、重启、超时和退出清理。
4. **端到端/打包测试**：干净临时 `HOME`/用户目录启动真实打包应用。

必须覆盖的故障注入：

- dsh 进程提前退出。
- dsh 启动超时。
- 端口被占用或命中 Chromium restricted port。
- Windows/Linux 进程组无法立即退出。
- 渲染进程崩溃或 heartbeat 丢失。
- settings JSON 损坏。
- 插件安装中断、pnpm 重写 `node_modules`、junction 指向错误。
- agent update 下载中断、staging 损坏、替换失败。
- bundle 缺文件。
- native module 无法导入。
- Linux native payload 引用了高于 `GLIBC_2.34` 的符号。
- 磁盘空间不足或目录无写权限。

每个 Linux 包都必须继续通过：

- `bash scripts/audit-linux-package.sh <pkg>`
- bundled Node 导入 `node-pty`、Jieba、sqlite-vec。
- Electron、bundled Node 和 native modules 的 `ldd` 检查。

## 5. 验收标准

重构完成前，必须满足：

### 代码结构

- `main.js` 不再承载所有领域逻辑，只负责组装和生命周期入口。
- 服务启动/重启/退出只由一个 supervisor/coordinator 管理。
- Windows/Linux 平台差异集中在平台适配模块。
- IPC channel 和 payload 有共享契约及运行时校验。
- 插件运行时协议保持兼容。

### 数据可靠性

- settings 写入具备原子性。
- settings 有 schema version 和迁移机制。
- 损坏配置不会无提示地被覆盖。
- 更新和插件操作失败后可以恢复、重试或回滚。
- 所有关键失败都有用户可定位的日志路径和 incident 信息。

### 测试

- `npm test` 可在有系统 Node 的开发环境执行。
- 在只有 bundled Node 的验证环境中也能执行测试，不依赖硬编码的 `node` 命令。
- `git diff --check` 通过。
- 影响的目标完成对应构建。
- 清洁临时用户目录启动后 Web UI 返回 HTTP 200。
- 验证 bundled Node/npm 版本。
- 验证内置插件及 native modules 导入。
- 验证退出后无孤儿 dsh 进程。

### 打包和平台

- 保持 `asar: false`、`npmRebuild: false`、`buildDependenciesFromSource: false`。
- 不改变 bundled plain Node 的使用方式。
- Windows portable/NSIS 更新行为保持有效。
- Linux 包更新仍由 pacman/apt/dnf/AppImage 负责。
- 不引入只在单一操作系统上成立的 shell 命令。
- 不提交 `dist/`、`vendor/`、日志、缓存或临时审计目录。

## 6. Agent 执行规则

接手本任务的 agent 应遵守：

1. 先检查 `git status --short`，不得覆盖已有用户修改。
2. 先完成 Phase 0，再进入代码重构。
3. 每个阶段独立提交或至少保持可回滚的小步修改。
4. 修改与现有用户工作区发生冲突时，停止该冲突文件并报告，不得使用 `git reset --hard`、`git checkout --` 或广泛删除命令。
5. 不要以“全部迁移到 TypeScript”为目标；以降低故障率和明确边界为目标。
6. 不要把编译后的第三方插件代码机械迁移或格式化。
7. 不要删除 native payload、插件 `lib/`、生成的插件运行时产物或许可证文件，除非已证明打包应用仍能导入和运行。
8. 每完成一个阶段，报告：改动文件、行为变化、测试命令、测试结果、尚未覆盖的风险。

## 7. 推荐的第一批实现任务

如果需要立即开始编码，按以下顺序执行：

1. 修复测试对子进程 `node` 的硬编码依赖，确保 bundled Node 也能运行完整测试。
2. 抽取 `web-service-supervisor`，保持现有端口重试、HTTP 探测、超时和错误提示行为。
3. 抽取 `shutdown-coordinator`，统一退出、重启、更新接管和子进程清理。
4. 为 `settings.js` 增加原子写入、schema version、迁移和损坏文件测试。
5. 建立 IPC contract 和 runtime validator，先覆盖恢复、插件、文件和服务重启 IPC。
6. 给新模块增加 JSDoc 类型和 `checkJs`，再迁移 `settings` 与 supervisor 到 TypeScript。
7. 增加清洁用户目录的真实启动 smoke test，并在 Windows/Linux CI 中验证。

最终交付应优先证明“错误可定位、失败可恢复、平台行为可验证”，而不是单纯增加 TypeScript 文件数量。
