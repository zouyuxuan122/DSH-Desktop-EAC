# Deepseek Harness EAC VNext 插件隔离架构方案

## 1. 目标

为下一个大版本建立一个可长期演进的稳定基座，使外置插件发生崩溃、卡死、依赖冲突或配置错误时：

- 核心 Agent、会话和基础 Web UI 保持可用；
- 用户能够进入恢复中心关闭、卸载、回滚或隔离问题插件；
- 系统能够记录故障归因，并支持后续由 Agent 协助诊断；
- 新插件能够持续通过稳定 SDK 扩展能力，而不再直接侵入 Harness 内部运行时。

本方案优先解决“不稳定插件拖垮客户端”；对恶意插件的防护属于后续权限与操作系统沙箱能力，不由进程隔离单独保证。

## 2. 现状与问题

当前桌面端由 Electron 主进程拉起单个 `dsh web` Node 进程。核心 Harness 与 Host 插件共用该进程、Cordis 上下文、依赖解析和 profile 配置；Client 插件共用同一个 Web UI 渲染环境。

```text
Electron 主进程
  └─ dsh web 进程
       ├─ Harness 核心 / Agent
       ├─ 官方 bundle
       ├─ 内置插件
       └─ 外置 Host 插件

Chromium 渲染进程
  ├─ Web UI
  └─ Client 插件
```

这导致外置插件的模块加载错误、重复注册、未处理异常、原生模块问题、死循环或内存耗尽，都可能让整个 Agent 服务或主界面不可用。

现有插件保护中心可快照、体检、修复、回滚和归因，能有效处理“启动前后发现的配置损坏”，但无法在运行期将外置插件与共享 Harness 进程隔离开。

## 3. 架构决策

采用“受监管核心 + 隔离扩展宿主 + 独立恢复中心”架构。

```text
Electron Supervisor
├─ Core Harness
│   ├─ 官方 dsh / Agent / 会话
│   ├─ 官方 bundle
│   └─ 受信任的 EAC Core Bridge
├─ Extension Host: plugin-a
├─ Extension Host: plugin-b
└─ Recovery Center
```

### 3.1 Electron Supervisor

Electron 主进程成为全局监管者，且永远不加载第三方插件代码。它负责：

- 启动、停止和监督 Core Harness 与 Extension Host；
- 插件注册表、启停、升级、回滚、权限和隔离状态；
- 崩溃次数、健康状态、日志与诊断包；
- 核心 profile 与扩展数据目录的隔离；
- 无论 Harness 是否成功启动都可用的 Recovery Center。

### 3.2 Core Harness

Core Harness 是唯一承载 Agent、会话、官方 bundle 和基础 Web UI 的服务。它仅加载：

- 上游官方所需 bundle；
- 少量经过版本锁定和回归验证的 EAC 核心组件；
- EAC Core Bridge，用于与 Extension Host 做受控通信。

第三方包不得写入 Core Harness 的 `package.json`、`node_modules`、`cordis.patch.yml` 或运行时模块解析路径。

### 3.3 Extension Host

每个启用的外置插件默认运行于独立的 Node 进程中，并按需启动。Extension Host 崩溃只会影响对应插件，Supervisor 负责停止、重试和最终隔离。

初期不建议为了节省内存而把不受信任插件混装进共享宿主。对经过审核且明确可信的插件，可在未来提供共享宿主选项，但它不应作为默认策略。

### 3.4 Recovery Center

Recovery Center 是 Electron 静态页面或独立窗口，不依赖 `dsh web`。它必须支持：

- 展示已安装插件、版本、来源、权限、启用状态和崩溃原因；
- 停用、卸载、回滚、重新尝试、强制隔离；
- 查看插件日志、核心日志和最近一次事故报告；
- 以安全模式启动；
- 导出诊断包。

Agent 自检可作为 Recovery Center 中的辅助能力，但绝不能是唯一恢复入口，因为核心服务无法启动时 Agent 同样不可用。

## 4. 插件分层与兼容策略

| 层级 | 运行位置 | 适用对象 | 稳定性承诺 |
| --- | --- | --- | --- |
| Core | Core Harness | 官方组件、必要的 EAC 基础能力 | 与 Agent 同进程，经过完整回归验证 |
| Isolated Extension | 每插件独立 Extension Host | VNext SDK 插件 | 插件故障不影响核心 Agent |
| Legacy | 现有 Cordis 直注入插件 | 尚未迁移的旧生态插件 | 兼容模式，不承诺运行期隔离 |

必须明确：无法同时满足“旧 Cordis 插件零改造”和“完整进程隔离”。旧插件依赖共享 Cordis 上下文、同步 waterfall、注册表和 Node 模块解析；将其原样搬离核心进程后，不可能透明保持所有行为。

因此，Legacy 插件应保留但默认不自动启用，并在市场与管理界面中清晰标识风险等级。新插件必须走 VNext Extension SDK。

## 5. Extension SDK V1

SDK 不暴露 Cordis 实例、核心 profile 写权限或任意 Node 模块访问。插件通过受控 RPC 声明并调用能力。

第一版覆盖以下能力即可支撑主要生态：

- 注册 Agent 工具；
- 订阅只读会话、任务和状态事件；
- 请求向 Agent 注入经过 schema 验证的上下文；
- 声明设置 schema 和独立配置命名空间；
- 提供独立扩展页面；
- 在授权范围内执行网络、文件或子进程操作；
- 记录结构化日志和健康心跳。

同步扩展调用必须设置严格超时。例如插件请求为 `agent/pre-step` 补充上下文时，Core Bridge 在限定时间内收不到结果就丢弃该结果并继续 Agent，不能允许扩展阻塞整个对话。

```text
Agent 回合
  └─ Core Bridge 请求扩展上下文
       ├─ 成功且 schema 合法：合并受限数据
       ├─ 超时：记录并跳过
       └─ 扩展异常：记录、熔断该插件、继续核心回合
```

## 6. UI 扩展策略

第三方 Client 插件不能继续任意注入主 Web UI 的全局 DOM、模块加载器或 React 运行时。否则即使 Host 侧隔离，渲染进程仍会因 UI 插件崩溃而失去主界面。

分两步推进：

1. VNext 初期，外置插件 UI 使用独立扩展页面或独立窗口，拥有单独 WebContents 和渲染进程。
2. 后续引入声明式 UI 协议：插件提交受校验的表单、列表、状态卡片和命令定义，主界面由核心组件渲染。

这样核心 UI 不再执行第三方任意脚本，同时仍保留可扩展的插件交互能力。

## 7. Profile、数据与更新

### 7.1 目录边界

```text
<DSH_HOME>/
├─ core-profile/                 # Core Harness 专用，第三方只读不可写
├─ extensions/
│  ├─ registry.json              # 插件状态、来源、版本、权限、隔离信息
│  ├─ plugin-a/
│  │  ├─ package/
│  │  ├─ data/
│  │  └─ logs/
│  └─ plugin-b/
├─ rollbacks/
├─ guard/
└─ incidents/
```

外置插件安装采用临时目录下载、校验、原子切换。插件更新失败时不得改动当前可运行版本。

### 7.2 插件注册表

每个插件至少维护：

- `id`、版本、来源、包哈希和安装时间；
- 类型：`isolated` 或 `legacy`；
- 启用状态、隔离状态、最后成功启动时间；
- 连续崩溃次数、最近错误摘要、日志位置；
- 权限声明和用户授权状态；
- 可回滚版本列表。

## 8. 故障状态机

```text
installed -> disabled -> starting -> running
                         |            |
                         v            v
                      failed <- retrying
                         |
                         v
                    quarantined -> disabled / uninstalled
```

建议策略：

- 启动失败：记录错误，允许有限次数退避重试；
- 运行期退出：核心继续运行，重启该 Extension Host；
- 连续失败超过阈值：自动标记 `quarantined`，不再随客户端启动；
- 所有动作保留事故报告与日志；
- 用户可在 Recovery Center 中解除隔离并手动重试。

## 9. 实施阶段

### Phase 0：收紧当前稳定面

- 保留现有 `plugin-guard`、快照、冲突扫描和启动归因；
- 补全安全模式入口，确保它不依赖损坏的 Web UI；
- 为外置插件增加显式来源、风险等级和启动失败记录；
- 停止让市场插件直接覆盖内置或核心组件。

交付标准：任意 plugin tree 启动失败时，用户必定能打开 Recovery Center 并关闭问题插件。

### Phase 1：核心与外置配置分离

- 建立 Core Profile 与 Extension Registry；
- 外置插件不再写入 Core Profile 的依赖、patch 或模块目录；
- Supervisor 统一负责启停和原子安装；
- Legacy 插件明确进入兼容模式。

交付标准：插件安装、卸载、回滚不会再修改 Core Harness 的包依赖图。

### Phase 2：Extension Host 与 SDK V1

- 实现每插件独立 Host、RPC 握手、心跳和超时；
- 实现工具、事件、设置和日志等基础 API；
- 迁移一到三个可控插件作为样板；
- 将插件故障接入状态机和 Recovery Center。

交付标准：已迁移插件崩溃、卡死或主动退出时，核心 Agent 对话不中断。

### Phase 3：UI 隔离与生态迁移

- 外置 UI 迁移为独立页面或窗口；
- 引入声明式 UI 协议；
- 市场优先分发 SDK 插件；
- Legacy 插件默认关闭并展示兼容风险。

交付标准：外置 Client 插件异常不再导致主 Web UI 失效。

### Phase 4：权限与资源治理

- 权限声明和用户授权；
- 网络、文件、Shell、原生模块等能力的细粒度控制；
- CPU、内存、请求超时、重启速率限制；
- 签名、审核与可信发布者策略；
- 结合 Windows Job Object、低权限账户或操作系统沙箱加强恶意插件防护。

## 10. 验收标准

稳定版至少应满足：

1. 已迁移的外置 Host 插件进程崩溃后，正在进行和新发起的核心 Agent 对话仍可完成。
2. 外置插件启动失败时，客户端仍能进入 Recovery Center 完成关闭或卸载。
3. 插件连续失败后自动隔离，后续正常启动不再反复加载该插件。
4. 外置插件的安装、更新与回滚不修改 Core Profile 的依赖图和 patch 层。
5. 每个插件故障都能关联版本、日志、发生时间和恢复动作。
6. Core Harness 无第三方插件时，可以在离线或扩展全部禁用的情况下正常启动并完成基础 Agent 工作。

## 11. 非目标

- 不在 VNext 第一阶段彻底重写或迁移全部既有 Cordis 插件；
- 不把“进程隔离”表述为对恶意代码的完整安全沙箱；
- 不允许为了兼容旧插件而重新开放对 Core Profile、Cordis 上下文或主页面 DOM 的任意写入权限。

## 12. 结论

VNext 的核心不是继续扩大共享插件树的修复规则，而是把“核心可用性”从第三方插件可靠性中剥离出来。以 Supervisor 为监管边界、Core Harness 为稳定平面、Extension Host 为隔离平面、Recovery Center 为永远可达的恢复平面，能够同时支撑稳定版交付、后续生态扩展、权限治理和持续性能优化。
