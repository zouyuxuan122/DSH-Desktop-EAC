# dsh-compact 设计

## 目标

新增符合 DeepSeek Harness 插件规范的 `dsh-compact`，取代 EAC 现有的
`dsh-auto-compact`。新插件不再从浏览器输入框自动发送 `/compact`，而是在
Agent 请求链中成为唯一的压缩服务：

- 请求发送前按真实会话 Token 压力自动压缩；
- 收到 `CONTEXT_WINDOW_EXCEEDED` 后强制压缩，并且只重试原请求一次；
- 继续复用 DSH 的 `BasicCompactionEngine`，不另写历史替换和摘要事务；
- 保留标准 `/compact` 命令；
- 同时支持 EAC 内置分发和普通 DSH preset 手动接入。

## 架构

插件包：

```text
dsh-compact/
├─ package.json
├─ cordis.patch.yml
├─ LICENSE
└─ lib/
   ├─ index.js
   ├─ agent.js
   ├─ engine.js
   ├─ policy.js
   └─ client.js
```

- `lib/index.js`：唯一的产品级 Loader 条目，在 host-plane 注册设置、状态接口
  和客户端。
- `lib/agent.js`：Agent preset 的复合入口；一个 Loader 条目内部挂载压缩引擎、
  `/compact` 命令和工具结果裁剪器。
- `lib/engine.js`：导出 `DshCompactEngine`，继承
  `@deepseek-ai/dsh-compaction-basic` 的 `BasicCompactionEngine`。
- `lib/policy.js`：配置净化、模型专属策略和压缩状态辅助逻辑。
- `lib/client.js`：设置页和当前会话压缩状态，不模拟输入 `/compact`。
- `cordis.patch.yml`：注册产品级 host/client；Agent preset 只显式使用一个
  `dsh-compact/agent` 复合条目，以保证每个 Agent realm 只有一个
  `ctx.compaction`，同时不向插件列表暴露三个实现组件。

## 默认策略

```yaml
dsh-compact:
  enabled: true
  thresholdRatio: 0.75
  retainRatio: 0.20
  recoverOnOverflow: true
  maxOverflowRetries: 1
  modelPolicies: []
```

- 自动阈值默认 75%；
- 压缩后默认保留最近约 20%；
- 普通压力压缩最多再尝试一次；
- 上下文溢出最多恢复并重试一次；
- 模型没有可靠 `contextWindow` 时记录诊断，不猜容量；
- 配置按请求读取，正在执行的压缩固定使用启动时快照。

## 请求前压缩

`DshCompactEngine` 使用父类已验证的 Token 计量、工具结果裁剪、安全范围选择、
tool call/result 配对保护、摘要生成和持久化事务。它用动态策略覆盖父类的静态
配置，并继续在 `agent/pre-step` 执行：

1. 读取当前有效设置和当前 provider/model 的覆盖策略；
2. 使用 `tokenMeter.measure(session)` 计算真实表面压力；
3. 解析模型真实 `contextWindow`；
4. 达到阈值时先运行 `toolResultPruner`；
5. 再次测量后选择安全旧历史并生成摘要；
6. 落盘后重新测量，必要时再压缩一次；
7. 成功后继续原模型请求。

## 溢出恢复

收到 `CONTEXT_WINDOW_EXCEEDED` 时：

1. 当前请求若已恢复过一次，保留原错误并停止；
2. 忽略普通阈值，先裁剪工具结果；
3. 强制选择一段安全历史压缩；
4. 确认 session surface 的 replacement generation 前进；
5. 返回 Agent loop 的 `{ kind: "retry" }`，自动重试原请求；
6. 不重复添加用户消息，不无限重试。

摘要失败、无安全范围、取消或压缩后没有实际缩小时，保留原始请求错误。

## 状态与 UI

状态按 `sessionId` 隔离：

```text
idle → measuring → pruning → summarizing → committing → recovered
                                                  └→ failed
```

状态由宿主服务保存。Web Server 存在时提供：

- `GET /plugins/dsh-compact/status?sessionId=...`
- `POST /plugins/dsh-compact/compact-now`

手动压缩通过当前 Agent preset 的 `ctx.compaction.compactNow()` 执行，不写输入框。
Headless DSH 没有 Web UI 时仍可自动压缩并使用标准 `/compact`。

设置页提供：

- 自动压缩开关；
- 触发阈值和保留比例；
- 溢出恢复开关；
- provider/model 专属策略；
- 当前 preset 是否启用 `dsh-compact`；
- 当前会话真实状态；
- “立即压缩”按钮。

## EAC 迁移

- 从 `COMPANION_PLUGINS` 删除 `dsh-auto-compact`；
- 将其加入退役插件清理列表；
- 新增 `dsh-compact` 内置分发；
- 将 EAC 自带 Agent preset 中完全匹配的：

  ```yaml
  - id: compaction
    name: cordis:group
    group: true
    isolate:
      compaction: true
      toolResultPruner: true
    config:
      - id: compaction-basic
        name: '@deepseek-ai/dsh-compaction-basic'
      - id: command-compact
        name: '@deepseek-ai/dsh-command-compact'
      - id: tool-result-pruner
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  ```

  替换为：

  ```yaml
  - id: compact-agent
    name: 'dsh-compact/agent'
    isolate:
      compaction: true
      toolResultPruner: true
  ```

- 已安装的 EAC 内置 preset 使用支持 DSH `!!js` 标量的语法解析后迁移，
  首次改动前保留 `.bak`；
- 用户未知的自定义 preset 不自动修改；
- 迁移必须幂等，解析失败只记录诊断，不破坏原文件；
- 旧 localStorage 配置只由客户端做一次清理，不迁移为错误的宿主设置。
- 官方插件清单按 Loader 条目展示；客户端在该只读清单中隐藏
  `compaction-basic`、`command-compact`、`tool-result-pruner` 和
  `compact-agent` 等实现级条目，只保留产品级 `dsh-compact`。

普通 DSH 用户安装包后，在所用 Agent preset 中用上述单个
`dsh-compact/agent` 条目替换原压缩组。

## 配置校验

- `thresholdRatio`：0.50–0.95；
- `retainRatio`：0.05–0.50；
- `retainRatio < thresholdRatio`；
- `maxOverflowRetries` 固定为 0 或 1，默认 1；
- 模型策略必须同时提供非空 provider 和 model；
- 同一 provider/model 不允许重复；
- 非法热更新保留上一个有效配置，不能拖垮插件树。

## 测试和验收

测试覆盖：

- 配置净化和模型覆盖；
- 设置热更新；
- 请求前压缩；
- 工具结果裁剪后重新测量；
- 压缩后仍超阈值的第二次尝试；
- 上下文溢出强制压缩；
- 原请求最多重试一次；
- 无安全范围时保留原错误；
- 缺少 `contextWindow` 的诊断；
- AbortSignal 传播；
- 手动压缩忙碌状态；
- Session 状态隔离；
- preset 迁移、备份、幂等和不误改；
- 旧 `dsh-auto-compact` 不再注册；
- 每个 preset 只有一个 `ctx.compaction`；
- EAC 打包包含 `dsh-compact` 的 host、engine 和 client。

验收要求：

- 不再通过 `inputActions` 自动发送 `/compact`；
- 必要压缩在模型请求前完成；
- 溢出后自动压缩并重试原请求一次；
- 不重复用户消息、不无限重试；
- 标准 `/compact` 保持可用；
- UI 只在真实成功后显示完成；
- 原生 DSH 和 EAC 均可接入；
- 升级用户不会同时加载两个自动压缩插件。
