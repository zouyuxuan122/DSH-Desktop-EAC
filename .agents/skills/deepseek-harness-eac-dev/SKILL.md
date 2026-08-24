---
name: deepseek-harness-eac-dev
description: 面向 Deepseek Harness EAC 源码仓库的全栈开发与维护技能。处理 Tauri/Rust 桌面壳、Node sidecar、Web bridge、DSH 插件与 preset、profile 治理、更新打包、可靠性修复、测试验收和发布准备时使用；不用于客户端功能使用说明，也不负责专项 JS 到 TS 迁移。
---

# Deepseek Harness EAC 开发规范

## 目标

在不破坏 DSH 内核和社区插件兼容性的前提下，完成 EAC 项目的开发、修复、重构、测试、打包与维护工作。

本技能是项目路由入口。只读取当前任务相关的参考文档，不要一次加载全部内容。

本技能与 `eac-desktop-tips` 不同：

- 源码开发、修复、测试、打包和发布准备使用本技能。
- “某个客户端功能怎么用、设置在哪里”等用户问题使用 `eac-desktop-tips`。

## 开始前

1. 确认当前目录属于 Deepseek Harness EAC 仓库，至少存在：
   - `dsh-desktop/package.json`
   - `tauri-shell/Cargo.toml`
   - `docs/adr/0002-shell-boundary-and-layering.md`
2. 检查 `git status --short --branch`，保留用户已有修改。
3. 优先读取当前源码、测试和最新提交，不把历史交接文档中的版本号或测试数量当作当前事实。
4. 先判断任务属于哪个架构层和领域，再读取对应参考文档。
5. 普通开发任务不得顺带执行 JS 到 TS 迁移；迁移由独立技能处理。

可以先运行：

```powershell
.\scripts\repo-preflight.ps1 -RepoPath <repo> -RequiredLevel targeted
.\scripts\classify-change.ps1 -RepoPath <repo>
```

脚本返回 `blocked` 或非零退出码时停止后续验证，不把空计划或部分执行解释为成功。
分类器遇到未被规则覆盖的源码、脚本或构建配置时必须阻断，先补充机器可读规则和对应回归测试，再生成验证计划。

## 架构路由

| 任务 | 必读参考 |
| --- | --- |
| 判断代码归属、跨层修改、架构调整 | `references/architecture.md` |
| TypeScript、Node、Rust、日志、错误和路径风格 | `references/coding-conventions.md` |
| 窗口、托盘、单实例、壳页面、Rust sidecar 生命周期 | `references/tauri-shell.md` |
| JSON-RPC、通知、`window.dshDesktop`、bridge parity | `references/sidecar-and-bridge.md` |
| 余额、会话通知、文件预览、端口、WSL 等产品服务 | `references/product-services.md` |
| 新增或修改 DSH 插件、插件注册与分发 | `references/dsh-plugins.md` |
| preset、profile、Cordis patch、配置迁移 | `references/presets-and-profile.md` |
| Agent/插件/客户端更新、NSIS、便携包、资源完整性 | `references/updates-and-packaging.md` |
| `patch-deps.js`、受控 node_modules 补丁和 vendored 覆盖 | `references/dependency-patches.md` |
| guard、rescue、安全模式、日志脱敏、路径和进程安全 | `references/reliability-and-security.md` |
| 选择测试范围、运行 smoke、验收结果 | `references/testing-and-acceptance.md` |
| 版本、CI、提交、PR、发布和外部操作 | `references/release-and-git.md` |
| 团队分支、提交、同步、PR、冲突、回滚和多人协作 | `references/team-git-workflow.md` |
| 修改本 Skill 的入口、参考文档、元数据或辅助脚本 | `references/skill-maintenance.md` |
| 根据修改文件判断联动代码、测试和验证级别 | `references/change-impact-matrix.md` |
| 新插件、新 RPC、配置迁移、更新器等典型开发任务 | `references/task-playbooks.md` |

跨领域任务读取所有直接相关参考，但不要加载无关文档。

## 核心红线

- 原则上不直接修改 `@deepseek-ai/*` 已安装包源码；仅允许按 `references/dependency-patches.md` 维护已经批准的补丁事实源、受控 vendored 覆盖和 staging 重放链路。
- 不改变 `cordis.yml` 和 `cordis.patch.yml` 的既有语义。
- 不破坏 host `{ name, inject, apply }` 和 client `dsh.client` 插件契约。
- 不改变 `DSH_HOME`、profile、sessions、skills 和 preset 的既有目录布局。
- 不覆盖用户自建插件、Skill、preset 或配置。
- 不把桌面原生能力塞进 L3；新业务优先放 DSH 插件或 L2。
- 不让 Rust 壳复制 Node 业务逻辑；L1 只处理桌面集成能力。
- 修改 bridge API 时同步维护 bridge/preload 契约和对应测试。
- 配置和升级迁移必须幂等、有边界、失败时保留旧数据。
- 未经用户明确授权，不 commit、push、创建 PR、打标签或发布。
- 团队开发默认通过任务分支和 PR 进入 `main`，不直接推送共享主分支。
- 不重写共享历史，不强推 `main`，不移动或删除已发布标签。

## TypeScript 方向

- 项目自有的新业务模块默认使用 TypeScript。
- 保持当前 CommonJS/ESM 和编译产物契约，不因类型化改变运行时导出。
- 现有 JavaScript 的专项迁移不属于本技能；普通功能任务不得顺带迁移。
- 第三方 vendored 插件、皮肤和预构建前端产物不因代码风格要求被重写。
- Electron 冻结链路只做任务明确要求的必要修复。
- bridge 公开契约仍要求 Electron parity 时，允许为维持契约进行最小同步修改；不得借机扩展 Electron 新业务。

## 工作流程

1. **定位**：找到入口、调用链、消费者、契约测试和打包清单。
2. **分类**：确定 L1/L2/L3、插件、配置、更新或发布领域。
3. **影响分析**：读取 `change-impact-matrix.md`，确认联动文件和测试。
4. **约束**：列出不能改变的行为、用户数据和兼容接口。
5. **实现**：沿用现有模块边界和代码风格，保持改动聚焦。
6. **验证**：运行最低充分验证集；高风险链路逐级增加验证。
7. **复查**：检查生成文件、资源清单、配置迁移和工作区差异。
8. **汇报**：说明改动、验证结果、未验证项和残余风险。

## 验证级别

- **V1 定向**：类型检查、语法检查、相关测试文件。
- **V2 全量**：`dsh-desktop` 下运行 `npm test`。
- **V3 壳契约**：Rust 检查、sidecar/bridge 契约测试。
- **V4 运行时**：`boot-smoke.js`、`gui-smoke.js` 或专项运行验证。
- **V5 分发**：`update-smoke.js`、升级测试、NSIS、便携包和真实安装树。

根据影响面选择最低充分级别。不要用 V1 冒充跨层、更新或安装链路的完整验收。

`package -Execute` 只完成可自动化部分；真实安装、故障注入、文件锁、权限和路径环境未完成时，结果只能是 `partial`。

## 辅助脚本

- `scripts/repo-preflight.ps1`：检查仓库结构、Node/npm、Rust target 和关键资源。
- `scripts/repo-inventory.ps1`：生成当前代码、插件、preset、测试和工作流统计。
- `scripts/git-audit.ps1`：检查分支、工作区、领先落后、暂存内容和危险文件。
- `scripts/compare-skill-copy.ps1`：比较维护源与仓库安装副本的文件集合和 SHA-256。
- `scripts/classify-change.ps1`：根据改动文件输出领域、参考、测试和最低验证级别。
- `scripts/verify-change.ps1`：消费分类器结果，按 `auto/targeted/full/runtime/package` 生成验证计划；传入 `-Execute` 才实际执行。
- `scripts/validate-skill.ps1`：检查 Skill 元数据、引用、脚本语法、参数契约、测试路径和 CI paths。
- `tests/run-tests.ps1`：在 PowerShell 7 和 Windows PowerShell 5.1 下回归脚本状态与分类契约。

脚本结果是决策输入，不替代源码阅读和工程判断。
