<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-agent-teams 把一个 DeepSeek Harness 会话变成可协作的多智能体团队">
</p>

<p align="center">
  <a href="https://dshfind.com/zh/plugins/NanmiCoder/dsh-agent-teams?ref=badge"><img src="https://img.shields.io/badge/%E7%94%B1%20dshfind-%E6%8E%A8%E8%8D%90-FFD700?style=flat-square" alt="由 dshfind 推荐"></a>
  <a href="https://dshfind.com/zh/plugins/NanmiCoder/dsh-agent-teams?ref=badge"><img src="https://dshfind.com/api/badge/NanmiCoder/dsh-agent-teams?lang=zh" alt="dshfind 评分"></a>
  <a href="https://dshfind.com/zh/plugins/NanmiCoder/dsh-agent-teams?ref=badge"><img src="https://dshfind.com/api/badge/NanmiCoder/dsh-agent-teams?metric=downloads&amp;lang=zh" alt="dshfind 下载量"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams"><img src="https://img.shields.io/npm/v/@nanmicoder/dsh-agent-teams?style=flat-square&amp;color=5B4CF0" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT 许可证"></a>
  <a href="./cordis.patch.yml"><img src="https://img.shields.io/badge/DSH-Web%20%2B%20Headless-5B4CF0?style=flat-square" alt="DSH Web 与 Headless"></a>
</p>

## 一句话，拉起一支真正协作的团队

`dsh-agent-teams` 让当前 DeepSeek Harness 会话成为队长：创建可续聊的子 Agent、把目标拆成有依赖的任务，并通过直达消息协调成员工作。

你只需用自然语言提出目标。插件会提供团队协议、11 个协作工具、持久化状态、自动共享任务调度和实时 Web UI，不需要额外的 Workflow 引擎。

<p align="center">
  <img src="./assets/ui.png" width="100%" alt="DeepSeek Harness 对话与 AgentTeams 实时活动面板，展示成员、任务依赖和回报">
</p>

## 版本更新

查看[最新版本说明](https://github.com/NanmiCoder/dsh-agent-teams/releases/latest)，或浏览[完整发布历史](https://github.com/NanmiCoder/dsh-agent-teams/releases)。同一份 Markdown 说明也会随 npm 包发布到 `release-notes/` 目录。

## 为什么需要 AgentTeams？

| 能力 | 带来的变化 |
| --- | --- |
| **队长式委派** | 当前会话负责建队、分配角色并汇总最终结果。 |
| **可续聊成员** | 成员是可持续唤醒的 DSH 子 Agent，可以继续执行聚焦的后续轮次。 |
| **带依赖的任务** | 任务有明确状态；依赖未完成时不能领取。 |
| **自动续领与安全接管** | 成员空闲后自动领取下一项就绪任务；转派会撤销旧 attempt，冷恢复会重试遗留任务，迟到结果无法覆盖。 |
| **成员直达消息** | 成员通过持久化邮箱直接联系队友或队长，不需要队长中转。 |
| **实时活动面板** | Web UI 用分段进度、可折叠成员树和可交互 DAG 展示实时工作；运行中的子任务会标出使用的模型，团队结束后仍保留完整成员与任务历史。 |
| **质量门禁** | 人只提供目标和约束。默认任务顺序是需求 → 实现 → 验证 → 审查 → 集成，失败后自动修复/复审，恢复团队必须显式 resume。第一版范围控制是完成时审计，不是 host 写入拦截。详见 [docs/quality-gates.md](./docs/quality-gates.md)。 |

对话卡片与活动面板接入 Harness 官方多语言服务，会随宿主在简体中文和英文之间实时切换；任务/成员状态、动态摘要、操作按钮、历史归档标识和无障碍文案都会同步更新，无需刷新页面，也不增加插件自己的语言设置。

## 安装

> [!NOTE]
> 使用前请确保已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

### npm

```sh
dsh plugin --profile web add @nanmicoder/dsh-agent-teams@latest
```

### 从源码构建

```sh
git clone https://github.com/NanmiCoder/dsh-agent-teams.git
cd dsh-agent-teams
pnpm install
pnpm build
dsh plugin --profile web add .
```

修改源码后请重新执行 `pnpm build`。本地安装会继续链接到当前源码目录。

检查组合配置、重启 DSH，然后刷新 Web UI：

```sh
dsh --profile web --dump-config
dsh web
```

接着直接用自然语言拉团队：

> 使用 AgentTeams 审查 v0.5.3 之后的提交，分别从性能、安全和产品角度分工，最后输出一份汇总报告。

## 工作方式

1. 当前会话创建团队并成为队长。
2. 队长按角色添加由可续聊子 Agent 驱动的成员。
3. 目标被拆成有负责人和显式依赖的任务。
4. 共享调度器依据真实 `running / idle / ready` 状态，为每个空闲成员原子领取一项就绪任务并唤醒它；驻留成员被中断时会停驻当前 attempt，可通过直接消息继续而不丢 capability；只有冷进程重启后的遗留任务才会生成新 attempt 恢复。
5. 成员携带当前 `attempt_id` 更新任务；转派或队长接管会先撤销旧 attempt、等待原成员安静，再启动新 attempt。
6. 队长汇总结果，随后归档完整团队记录。

团队状态保存在 `<workspace>/.agent-teams/`；Web 面板读取这份磁盘真相，并与实时子 Agent 活动合并展示。

成员创建默认零交互：成员沿用队长当前 LLM 路由时会快照该 provider、model 与思考强度；用户要求改用其他路由时，则快照目标模型的默认强度，成员后续续跑仍使用最终解析出的快照。只有当用户明确提出异构分工（例如“后端用 provider A/model X，前端用 provider B/model Y”）时，队长才会把对应的 `provider` + `model` 传给该成员；不会逐个弹出模型或思考强度选择。

## Slash 命令

无需再说“用 AgentTeams”。插件注册了封闭命名空间的 `/agent-teams` 宿主命令，Web GUI 的 slash 菜单会显示 `agent-teams` 占位项与输入提示：选中它（或直接输入命令）、描述目标、回车即可。

```
/agent-teams 调研三家竞品的定价页
```

这一行被命令管线认领后，会按用户提交的原文作为普通用户消息送入主会话，因此聊天记录中仍能看到完整的 `/agent-teams …`。手势边界会在 pre-step 注入确定性激活指令，队长协议仍会立即启动。调用也会持久化记录（`command/run` / `command/done`）。

没有命令裁决的表面（例如 headless CLI）也享有同等的确定性激活：任何以 `/agent-teams` 开头的真实用户消息，都会为其余文本激活该协议；句子中间出现的字样仍是普通文本。

## 配置

默认配置可以直接使用。受信任的 Profile 可以覆盖成员行为：

```yaml
- id: agent-teams
  config:
    stateDir: .agent-teams
    memberProvider: spawn
    memberModel: deepseek-v4
    memberMaxDepth: 1
    maxMembers: 8
```

这里的 `memberProvider` 指子 Agent 的运行后端（`spawn` / `fork`），不是 LLM provider。跨 LLM provider 由 `agent_teams_add_member` 的可选 `provider` + `model` 参数表达；`memberModel` 只是所有成员的模型默认覆盖。成员沿用队长当前 provider/model 时会继承队长的思考强度；provider 或 model 任一改变时会自动使用目标模型的默认档。需要指定特定强度时，可传入可选的 `reasoning_effort` 参数（目标模型支持的档位 id，或 `"default"` 表示强制使用模型自身默认档）。

`slashCommand: false` 可关闭确定性的 `/agent-teams` 激活面（slash 命令与手势边界），仅保留自然语言触发。

## 使用边界

- 一个队长同一时间只能带一个活动团队。
- 没有开放任务的空闲成员会自动续领就绪任务；仍持有开放 attempt 的空闲成员会停驻，队长可发消息让其沿用原 attempt 继续，或显式转派；冷重启遗留的开放任务才会生成新 attempt。暂时无法实时投递的消息会持久保存在邮箱中并在后续状态边界重投。
- 状态使用文件持久化，并在单个 DSH 进程内串行操作；多个进程同时修改同一团队不保证一致。
- 活动面板如实展示持久化状态；模型偶尔可能完成工作却没有按协议更新任务状态。

完整工具列表、状态模型、Web UI 行为、配置与已知限制见 [docs/usage.md](./docs/usage.md)。

## 插件开发 Skill

仓库同时提供开放 Agent Skills 包 [`dsh-plugin-development`](./skills/dsh-plugin-development/SKILL.md)：

```sh
npx skills add NanmiCoder/dsh-agent-teams --skill dsh-plugin-development
```

## 文档

| 指南 | 内容 |
| --- | --- |
| [使用指南](./docs/usage.md) | 架构、UI 行为、工具、配置、限制与验证 |
| [验证指南](./docs/verification-guide.md) | 离线、组合、真实 e2e 与 GUI 验证 |
| [插件开发](./docs/developing-dsh-plugins.md) | 基于本插件整理的人类可读开发指南 |
| [README 写作](./docs/readme-writing-guide.md) | 仓库文档约定 |

## 开发

```sh
pnpm install
pnpm build
pnpm verify
```

## 命名多角色团队配置

在 `cordis.patch.yml` 的 `profiles` 中配置完整团队模板。每个 profile 都提供成员阵容，可独立指定 provider、model、role、reasoning_effort。`taskPlanning: captain` 表示只提供阵容和约束，由 Captain 根据用户目标设计 DAG；省略该字段或设为 `seed` 时，展开模板中的固定任务图。使用 `/agent-teams --profile <名称> <目标>` 显式激活；不会把首个普通 token 隐式识别为 profile。

普通 `/agent-teams` 流程会调用 `agent_teams_create({ profile, approval: "required" })`：只落盘可编辑的成员占位和 DAG，不创建子会话、不领取任务。成员模型和推理等级直接读取 Harness 的模型目录。「返回对话修改」会终止仍在运行的规划轮次，让队长先追问修改方向，再用一次原子操作更新同一份草案；「放弃本次计划」经二次确认后会归档草案、中止轮次，并向模型注入不得自动重建团队的控制上下文。只有点击「确认并启动团队」才会按最终配置原子创建成员并启动就绪任务。运行中团队的停止入口位于该团队的面板标题，点击后需要二次确认，不再占用输入区域。直接工具调用方可显式传 `approval: "automatic"` 保留旧的立即执行路径。审查或测试失败不会解锁下游；自动 repair/review 不依赖 failed review。

## 许可证

[MIT](./LICENSE)
