# Git、CI 与发布规范

团队分支、提交、同步、PR、冲突和回滚的完整规则见 `team-git-workflow.md`。本文件重点描述发布和 CI。

## 工作区

- 开始前和结束前都检查 `git status --short --branch`。
- 不撤销用户已有修改。
- 不使用 `git reset --hard`、`git checkout --` 等破坏性命令。
- 提交前检查冒烟临时目录、构建产物和日志未被加入。

## 授权边界

- 修改代码不等于授权 commit。
- commit 不等于授权 push。
- push 不等于授权创建 PR、合并、打标签或发布。
- 每项外部变更都需要用户明确授权。

## CI

- 修改测试、构建资源或 Skill 时检查 workflow 的 paths 过滤。
- Node、Rust、资源装配和版本写入步骤需要与本地命令一致。
- 首次启用或大改 Tauri release workflow 后需要人工观察真实运行。

## 发布

- 版本号必须在相关 package/config 中一致。
- 发布资产名称、SHA256SUMS 和 updater 资产选择规则保持一致。
- 发布前完成对应 V5 验收。
- 不以“本地能启动”代替安装版和便携版验证。
- 不发布含调试资源、临时凭据、用户 profile 或本机绝对路径的产物。

## 版本同步点

- `dsh-desktop/package.json`
- `dsh-desktop/package-lock.json`
- `tauri-shell/tauri.conf.json`
- 安装包和便携包文件名
- updater 的 release 资产选择规则
- CHANGELOG 和升级说明

## 当前工作流

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`：已禁用的 Electron 历史工作流，不得重新启用或用于发布。
- `.github/workflows/release-tauri.yml`：唯一允许发布当前桌面产品的工作流。
- `.github/workflows/clear-cache.yml`

项目内置 `dsh-desktop/assets/skills/` 的修改应通过 CI paths 进入构建。开发者 Skill 部署到 `.agents/skills/deepseek-harness-eac-dev/` 后由 `.github/workflows/ci.yml` 的 paths 和双 PowerShell 校验保护；位于仓库外的维护源仍不受仓库 CI 保护，必须通过副本 SHA-256 比较确认同步。
