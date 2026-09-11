# 插件来源台账（SOURCES.json）

> 数据源：`DSH_EAC_Plugin_Audit_2026-09-05.xlsx`（2026-09-05 全量外部审计，对照
> awesome-dsh-plugin 名录 pin `44ae0afa`，含 git blame / SHA-256 / 双版本差异证据）。
> 审计口径：**缺证据 ≠ 未修改**。台账继承该口径——不确定的来源明确标
> `unverified` / `unresolved`，绝不写成"已确认"。

## 是什么

`assets/SOURCES.json` 记录 main 与 aio-v1 两条版本线上**每一个组件**的来源、
上游钉址与审计结论。它是治理手册"插件溯源"要求的机器可读实现：

- 任何插件都能一句话回答：上游是谁、对应哪个版本、我们改了什么、证据在哪。
- 上游发版时按台账重放补丁（配合 `-eac.N` 版本后缀递增），而不是考古。
- CI 门禁：改动插件必须同步台账，新增目录必须带条目（`plugin-ledger.mjs`）。

## 校验

```sh
npm run ledger:check          # 本地 / CI
node scripts/plugin-ledger.mjs --report   # 只看汇总，跳过版本比对
```

校验内容：结构合法（枚举、必填、`(id,line)` 唯一）；main 线每个
package.json 的 `name`/`version` 与台账一致（**改版必须同步台账，否则 CI 红**）；
`assets/{plugins,skins,agent-presets,sdk-plugins}` 下无孤儿目录；
`origin=upstream` 必须有 `upstream.repository`，`unresolved` 必须有 `candidates`。

## 字段说明

| 字段 | 说明 |
| --- | --- |
| `line` | `main` 或 `aio-v1`（AIO 为本仓库 aio-v1 分支，seed 代码不在 Git 内） |
| `type` | `plugin` / `skin` / `preset` / `sdk-sample` / `source-copy` / `seed` / `host-fused` |
| `origin` | 见下方四分类 |
| `upstream.repository` | 上游仓库；`refType: version` 表示目前只钉到版本号，后续升级为 commit hash |
| `audit.*` | 审计结论：`verdict`（名录匹配情况）、`compare`（与上游基线比对）、`note`（改动摘要）、`basis`（溯源依据）、`conflict`（来源冲突） |
| `candidates` | 同名待确认的候选上游（仅 `unresolved`） |
| `credits` | 宿主融合改写的能力出处致谢（非复制来源） |
| `postAuditChanges` | 审计基线（e01d2e2a）之后的 EAC 变更标注 |
| `dualVersion` | main / aio-v1 两线版本关系与文件数差异 |

## origin 四分类

| 值 | 含义 | 数量（2026-09-06 裁决后） |
| --- | --- | --- |
| `upstream` | 来源确认：名录命中、明确署名、dsh_desktop 伴侣套件或作者自有仓库 | 75 |
| `eac-original` | EAC 自研（含宿主融合改写、预设模块、SDK 样例、7 个 host 集成型配套插件） | 36 |
| `unresolved` | 同名候选存在但无法证明同源，**待维护者裁决** | 2 |
| `unverified` | 无上游线索，**待维护者裁决** | 0 |

### 2026-09-06 来源裁决（31 项开放问题 → 29 项定案）

排查方法：上游 dsh_desktop 全历史按路径查提交（`commits?path=`）、npm registry
逐一核验、zhu1090093659/dsh-web 仓库树比对、时间线交叉验证。结论已写入各条目的
`resolution` 字段（含证据），要点：

- **@deepseek-ai/* "DSH Desktop 配套"套件 = 上游 myYangyunfan/dsh_desktop 的
  伴侣插件体系**（上游 v0.2.0 2026-08-13 起，早于 EAC v1.0 2026-08-15）。
  19 个组件（含 aio 线）定案 upstream，pin 上游 main `ee052c6b`；上游部分插件
  版本超前（balance 0.1.1 / plugin-manager 0.1.2），且 float-window / terminal /
  plugin-marketplace 在上游已退役——同步上游前先逐个核对。此前名录给出的同名
  候选（GeekRicardo/dsh-balance 等）经查为红鲱鱼，不是实际来源。
- **8 个 host 集成型插件为 EAC 独有**（compact / dock-settings / easy-setup /
  font-custom / pet-settings / plugin-shield / plugin-wizard / skin-switch，
  含 aio 线副本共 10 组件）：上游全历史 0 提交、npm 404、dsh-web 无、名录无，
  EAC v4.x 提交首次引入 → eac-original。
- 遗留 unresolved 仅 anchored-standard 预设（C061/C092）：NOTICE 只声明官方
  preset 祖先，两个社区同名候选无法唯一归因；预设模块维护风险低，维持现状。

## 维护规则

1. **新增插件/皮肤/预设**：目录进 `assets/` 的同时必须加台账条目（含 origin 与
   证据），否则 CI 拒绝。
2. **升级插件版本**：更新 `version`，若是 fork 记得 `-eac.N` 递增，并在
   `audit.note` 追加一行变更摘要。
3. **阶段 2 计划**：`upstream.refType` 从 `version` 升级为 `commit`（首选
   GitHub hash，无则 npm release）；为组件补 dsh-plugin.json（v0.15 manifest，
   模板见 `assets/plugins/dsh-composer-dynamic-island`）。
4. 台账是唯一事实源：不要在 README/注册表里另写一份来源信息。

## 阶段 2 进展：dsh-plugin.json（std v0.15 manifest）

- 2026-09-06 首批：32 份 manifest 已随包（scripts/gen-plugin-manifests.mjs
  一次性生成，覆盖全部 main 线 `origin=upstream` 插件；composer 的手工
  manifest 优先保留，生成器永不覆盖已存在的 manifest）。
- manifest 当前是**描述性身份清单**（x-eac.role=identity-metadata）：
  EAC 仍经 companion-sync 注册表加载，facets 留空 = 尚未参与 std 协商，
  不编造能力声明；`@dsh-std/adapter-dsh` 与内核 0.1.3 的兼容性验证通过前
  不切换加载路径。
- CI 门禁：`plugin-ledger.mjs` 对每份 manifest 校验必填字段、version 一致、
  `facets.host.entry` 文件存在（32/32）。

### 2026-09-06 增补：外部匹配审计复核（PLUGIN-MATCH-REPORT.md）

- **dsh-compact 改判**：eac-original → upstream `zixin947/dsh-compact`。候选仓库
  package.json（name/version 1.0.0）与本地逐字一致、结构一致，zixin947 为本仓库
  贡献者（#145 新增 compact、#294 合并）。此前的排除法（dsh_desktop 全历史 0 提交
  等）只排除了 monorepo 一条线，未覆盖作者自有仓库——教训已记入 resolution。
- **dsh-change-review 维持** monorepo 判定：cirelir/dsh-change-review 为同名
  不同物（0.3.0 做 diff 对比展示），已记入 resolution.rejectedCandidates。
- **balance / easy-setup 维持**：官方 deepseek-ai/deepseek-harness master 树
  （10554 路径，未截断）经查不含 balance/easy-setup，报告 0.76 条目按其口径
  仅为"功能相近"。其余 1.00 条目与台账一致；dsh-undo-plugin 为
  dsh-undo-savepoint 改名前旧址（301 重定向）。

### adapter-dsh 兼容性验证（2026-09-06，结论：不兼容，维持现状）

`@dsh-std/adapter-dsh@0.1.1-rc.2` 的 peerDependencies 对全部内核包钉死
`>=0.1.2-alpha.2 <0.1.3`（dsh-commands/llm/session/tools/api-gateway/
session-controller/client-modules 等 10 个），**硬性排除我们当前的
0.1.3-alpha.1**——上游自己的声明即验证结论，无需试装。

产品决策：发布版维持 companion-sync 注册表加载路径不动；随包 manifest 仅作
身份元数据（x-eac.role=identity-metadata）。切换适配层的前置条件：dsh-std
上游（Yan-Zero/dsh-std）发布 peer 范围含 0.1.3 的 adapter 版本，并按
[手册流程]向其发 issue/PR 推进；届时先在隔离 profile 试装协商，再评估迁移。
