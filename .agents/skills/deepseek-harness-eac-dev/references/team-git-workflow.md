# 团队 Git 工作流

本规范用于多人和多代理共同维护 Deepseek Harness EAC。Git 操作必须同时满足团队流程和用户对外部操作的明确授权。

## 仓库现状

截至 2026-08-24：

- 主分支为 `main`。
- 合并历史以 GitHub PR merge commit 为主。
- 普通提交多数使用 Conventional Commits。
- 常见分支前缀有 `feat/`、`fix/`、`refactor/` 和 `codex/`。
- 仓库使用 `.gitattributes` 明确源码、配置、文档、PowerShell 和 NSIS 的行尾及二进制文件规则。
- 仓库提供 `.github/CODEOWNERS`、`.github/PULL_REQUEST_TEMPLATE.md` 和 `CONTRIBUTING.md` 作为团队协作入口。

这些是当前事实，不代表可以省略本规范中的保护措施。

## 分支策略

### 受保护分支

- `main` 只接受经过验证的 PR。
- 不直接在 `main` 开发、提交或 push。
- 不对 `main` 执行 rebase、force push、reset 或历史改写。
- release tag 必须指向已验收的 `main` 提交。

### 任务分支

一个独立任务使用一个分支：

```text
feat/<short-name>
fix/<short-name>
refactor/<short-name>
test/<short-name>
docs/<short-name>
chore/<short-name>
release/<version>
codex/<short-name>
```

规则：

- 人类开发者按任务类型使用语义前缀。
- Codex 默认使用 `codex/` 前缀，除非用户指定其他名称。
- 分支名使用小写 kebab-case，不包含空格、中文、Issue 标题全文或个人密钥。
- 不把多个无关需求塞进同一分支。
- 不在多人共用分支上擅自 rebase 或 force push。

## 开始任务

1. `git status --short --branch`，确认现有修改归属。
2. `git fetch origin` 获取远程引用；fetch 不修改工作树。
3. 从当前 `origin/main` 创建任务分支。
4. 工作区有未提交修改时，不切分支、不 pull、不 rebase、不 stash，除非先确认这些修改的所有者和处理方式。
5. 多个代理并行开发时，每个代理使用独立 worktree 和独立分支。

Skill 不得仅因“需要开始工作”自动创建分支。创建、切换或删除分支属于 Git 状态变更，应遵守用户授权。

只读审计：

```powershell
.\scripts\git-audit.ps1 -RepoPath <repo>
```

## 提交规范

格式：

```text
<type>(<scope>): <简短说明>
```

允许类型：

- `feat`
- `fix`
- `refactor`
- `perf`
- `test`
- `docs`
- `build`
- `ci`
- `chore`
- `revert`

推荐 scope：

- `tauri`
- `shell`
- `sidecar`
- `bridge`
- `boot`
- `plugin`
- `profile`
- `preset`
- `update`
- `installer`
- `release`
- `rescue`
- `security`
- `test`
- `docs`

示例：

```text
fix(sidecar): 为剪贴板写入增加有界重试
feat(plugin): 内置提示词优化插件
test(upgrade): 覆盖 4.4.1 到 5.1.0 升级路径
```

要求：

- subject 描述实际行为，不写“修改代码”“修复问题”“update”。
- 中文或英文均可，但同一提交保持一种语言。
- 详细背景、风险和验证放在 commit body，不把整篇 PR 描述塞进 subject。
- 一个提交只包含一个可解释的逻辑变化。
- 纯格式化、生成文件和功能修改不得混成一个提交。
- 不提交失败测试、临时调试输出、个人路径或注释掉的大段旧代码。

## 暂存规范

- 提交前运行 `git diff --check`。
- 使用 `git diff` 和 `git diff --cached` 分别审查未暂存与已暂存内容。
- 优先 `git add <明确路径>`，避免无审查的 `git add -A`。
- 暂存后再次运行 `git status --short`。
- 不提交：
  - `node_modules/`
  - `target/`
  - `dist/`
  - 日志、诊断 zip 和 smoke 临时目录
  - `DSH_HOME`、profile、sessions 和凭据
  - 真实 API key、cookie、token、手机号和邮箱
  - 被 `.gitignore` 管理的 TypeScript 编译产物
- 大型二进制、媒体和第三方资源必须确认许可证、来源和必要性。

## 行尾与编码

- `.gitattributes` 是仓库行尾和文本/二进制识别的事实源，本机 `core.autocrlf` 不得覆盖仓库约定。
- 不因普通功能修改批量转换 LF/CRLF。
- 不使用会重写整个文件编码的 PowerShell 管道写法。
- 保留已有 BOM、CRLF 和 UTF-8 约定，特别是 YAML、NSIS 和 PowerShell 文件。
- 修改 `.gitattributes` 时必须检查 `git diff --check` 和变更文件范围，避免无关的全仓库行尾变化。

## 与主分支同步

- 开发前和提交 PR 前执行 `git fetch origin`。
- 私有任务分支优先 rebase 到 `origin/main`，保持提交清晰。
- 已被多人使用或已经进入审查的分支，rebase 前先协调；必要时合并 `origin/main`。
- 冲突解决必须理解双方意图，不使用整文件 `ours/theirs` 覆盖。
- 解决冲突后重新运行受影响测试和 `git diff --check`。
- 修改 `package-lock.json` 时通过 npm 命令重新生成，不手工拼接冲突块。
- 修改生成清单或 hash 文件时由对应构建脚本重新生成。

## Push 与强推

- 未经用户明确授权，不 push。
- 首次 push 使用明确远程和分支：

```text
git push -u origin <branch>
```

- 不把个人 fork 分支误推到主仓库，push 前确认 `git remote -v`。
- 只有任务分支 rebase 后且已确认无人基于旧历史开发时，才允许：

```text
git push --force-with-lease
```

- 永远不使用普通 `--force`。
- 永远不强推 `main`、release tag 或他人分支。

## Pull Request

PR 标题采用与提交相同的 Conventional Commit 格式。

PR 描述至少包含：

- 目的与用户可见变化。
- 架构归属和主要文件。
- 风险与兼容边界。
- 自动测试命令和结果。
- 手工或运行时验收。
- 配置、数据或升级迁移。
- 失败回退方式。
- UI 改动截图或录屏。
- 未验证项。

合并门禁：

- 分支基于足够新的 `origin/main`。
- CI 全绿。
- Skill 推荐的最低验证级别已完成。
- 高风险更新、安装、配置迁移和安全改动至少一名非作者审核。
- PR 中无无关文件、调试产物、秘密和大范围行尾变化。
- 用户数据和回滚策略已说明。

仓库当前常用 merge commit 合并 PR。不要在本地伪造 GitHub 的 `Merge pull request` 提交。

## Review 处理

- 每条 review 意见明确回复或通过后续提交解决。
- 不覆盖其他开发者正在审查的提交。
- 修复 review 问题时保持提交小而清楚；合并前是否 squash 由仓库维护者决定。
- 新修改导致验证范围扩大时补跑对应测试。

## 回滚与事故处理

- 已进入共享历史的错误使用 `git revert`，不 reset 主分支。
- 回滚 merge commit 时明确 mainline parent。
- 发布事故从当前 `main` 建 `fix/` 或 `hotfix/` 分支，经最小充分测试和 PR 合并。
- 不删除失败发布标签；需要纠正时发布新版本并记录原因。
- 只在本地且未共享的提交可通过 rebase、amend 或 reset 整理。

## 多代理协作

- 每个代理有独立任务、分支和 worktree。
- 不让两个代理同时编辑同一文件，除非明确分工且由主代理合并。
- 代理不得擅自提交其他代理或用户的修改。
- 交接时报告分支、HEAD、修改文件、测试、未提交内容和阻塞项。
- 接收他人提交时先 review，再 cherry-pick 或合并；不盲目执行补丁。

## 操作授权矩阵

| 操作 | 默认权限 |
| --- | --- |
| `git status`、`diff`、`log`、`show`、`branch --list` | 可直接执行 |
| `git fetch` | 可执行，但应说明用途 |
| 创建/切换分支 | 需要任务需要或用户授权 |
| `git add`、commit | 需要用户明确授权 |
| push、创建 PR | 分别需要明确授权 |
| merge、tag、release | 需要单独明确授权 |
| rebase、cherry-pick、revert | 会改历史或工作树，执行前说明 |
| force push、删除分支/tag | 默认禁止；特殊情况需明确批准 |
| `reset --hard`、清理未知文件 | 禁止 |

## 提交前最低检查

```text
git-audit.ps1
git status --short --branch
git diff --check
git diff
git diff --cached
```

然后运行 Skill 根据改动计算出的最低测试级别。只有审查完成且用户明确授权后，才执行 commit。
