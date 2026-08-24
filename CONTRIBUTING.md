# 贡献规范

本仓库通过任务分支和 Pull Request 协作，`main` 不作为直接开发分支。

## 开始任务

1. 获取最新远程引用：`git fetch origin`。
2. 从 `origin/main` 创建语义化任务分支。
3. 检查并保留工作区已有修改。
4. 使用 `.agents/skills/deepseek-harness-eac-dev` 判断架构归属、影响范围和最低验证级别。

推荐分支前缀：

```text
feat/
fix/
refactor/
test/
docs/
chore/
release/
codex/
```

## 提交

采用 Conventional Commits：

```text
<type>(<scope>): <简短说明>
```

提交前检查：

```powershell
git status --short --branch
git diff --check
git diff
git diff --cached
```

未经明确授权，不提交、push、创建 PR、合并、打标签或发布。

## 验证

项目开发 Skill 位于：

```text
.agents/skills/deepseek-harness-eac-dev
```

运行 Skill 自检：

```powershell
pwsh -NoProfile -File .\.agents\skills\deepseek-harness-eac-dev\scripts\validate-skill.ps1 `
  -SkillPath .\.agents\skills\deepseek-harness-eac-dev `
  -RepoPath .
```

Windows PowerShell 5.1：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\.agents\skills\deepseek-harness-eac-dev\scripts\validate-skill.ps1 `
  -SkillPath .\.agents\skills\deepseek-harness-eac-dev `
  -RepoPath .
```

功能修改还必须运行 Skill 分类器给出的最低验证集。无法执行的验证必须说明环境阻断和残余风险。

## 依赖补丁

不得任意修改 `node_modules`。项目批准的依赖补丁必须同时维护：

- `dsh-desktop/scripts/patch-deps.js`
- 受控 vendored 文件
- `tauri-shell/stage-resources.mjs` 的 staging 重放或覆盖逻辑

发布只使用 `.github/workflows/release-tauri.yml`。`.github/workflows/release.yml` 保留为禁用的 Electron 历史记录。
