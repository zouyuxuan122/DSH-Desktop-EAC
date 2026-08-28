# Skill 自身维护与回归

本规范用于修改 `deepseek-harness-eac-dev` 自身的 `SKILL.md`、`agents/openai.yaml`、`references/` 和 `scripts/`。

## 状态契约

所有决策脚本必须输出结构化 JSON，并使用以下状态：

- `ready`：必需条件满足，可以继续。
- `warning`：可以继续，但存在需要报告的非阻断风险。
- `blocked`：不得继续执行验证或生成正常成功结论，进程返回非零退出码。
- `partial`：自动检查已经通过，但仍有必需的人工验收未完成。

不得只依赖日志文字判断成功。调用方必须同时检查进程退出码和 JSON `status`。

## PowerShell 兼容基线

- 所有辅助脚本必须同时支持 Windows PowerShell 5.1 和 PowerShell 7。
- 不使用 `ConvertFrom-Json -NoEnumerate`、`System.Text.Json`、`Path.GetRelativePath` 等 5.1 不可用能力。
- 包含中文字符串的 `.ps1` 必须保存为 UTF-8 BOM；本 Skill 统一要求所有 `.ps1` 使用 UTF-8 BOM。
- 文档和 YAML 在脚本中必须通过 `Get-Content -Encoding UTF8` 读取。
- PowerShell 7 下运行 `validate-skill.ps1` 时，还必须启动 Windows PowerShell 5.1 子验证；5.1 不可用时明确输出警告。

退出码约定：

- `0`：`ready`、`warning`、`planned`、`planned-partial`、`no-changes` 或完整 `passed`。
- `2`：环境、输入、Git 读取、路径或计划被阻断。
- `3`：自动化检查执行失败。
- `4`：自动化检查通过，但必需人工验收未完成，最终状态为 `partial`。

## 修改后的最低自检

运行：

```powershell
.\scripts\validate-skill.ps1 -SkillPath <skill> -RepoPath <repo>
```

自检至少覆盖：

- `SKILL.md` frontmatter 和 `agents/openai.yaml` 必需字段。
- `SKILL.md` 路由到的参考文档存在，且没有未路由的参考文档。
- 所有 PowerShell 脚本语法有效。
- 核心脚本参数契约没有意外变化。
- `references/change-rules.psd1` 可加载、schema 受支持、规则 id 唯一且每条规则字段完整。
- 分类器能识别 Skill 自身文件并要求自检。
- 未匹配的源码、脚本或构建配置会阻断分类，不会降级为普通 warning。
- 分类器声明的测试路径和固定 smoke 脚本存在。
- `tests/run-tests.ps1` 在 PowerShell 7 和 Windows PowerShell 5.1 下通过独立 fixture 回归。
- 官方 `quick_validate.py` 可用时通过校验。
- Skill 安装进仓库后，对应路径被 CI workflow 的 `paths` 覆盖。

Skill 维护源在仓库外时，CI paths 无法保护该副本，自检必须输出警告。部署进仓库后，该警告才应转为实际 paths 覆盖检查。

维护源与仓库副本比较：

```powershell
.\scripts\compare-skill-copy.ps1 `
  -SourceSkillPath E:\deepseek-harness-eac-dev `
  -InstalledSkillPath <repo>\.agents\skills\deepseek-harness-eac-dev
```

比较必须覆盖文件集合和 SHA-256。仓库副本是团队和 CI 使用的版本；维护源修改后必须重新部署并通过比较，不允许两个副本长期分叉。

## 分类器输出

`classify-change.ps1` 必须说明：

- `source`：`git-worktree` 或 `explicit-files`。
- `gitReadSucceeded` 和 `gitError`。
- 每个文件命中的规则、领域、参考文档和最低验证级别。
- 未匹配文件。
- 建议测试是否存在。
- 是否需要执行 Skill 自检。

Git 收集失败时输出 `blocked`，不得退化成“没有变更”。
未匹配文件可以报告为 warning；但扩展名或位置表明其属于源码、脚本或构建配置时必须输出 `blocked`，要求先更新 `change-rules.psd1` 和独立测试。

跨 PowerShell 进程传递多个文件时使用 JSON 数组，避免 `-File` 对数组参数的绑定差异：

```powershell
.\scripts\verify-change.ps1 -RepoPath <repo> -FilesJson '["path/a.ts","path/b.rs"]'
```

`FilesJson` 根节点必须是数组，每一项必须是非空字符串；嵌套数组、对象、数字、布尔值和空字符串都必须返回 `blocked`。

脚本内部跨 PowerShell 进程传输时使用 UTF-8 Base64 编码的 `FilesJsonBase64`，避免 Windows PowerShell 5.1 原生命令行处理剥离 JSON 引号。对开发者公开的输入仍优先使用 `FilesJson`。

## 验证器职责

`verify-change.ps1` 消费分类器 JSON：

- 分类器负责文件、领域、测试和风险级别。
- 验证器负责把分类结果转换为可执行检查。
- 验证器不得复制领域匹配规则。
- `auto` 模式使用分类器给出的最低验证级别。
- 显式级别只能提高执行范围，不能降低分类器给出的最低级别，也不能绕过分类失败和预检阻断。

V5 必须分开报告：

- `automatedChecks`：构建、测试、smoke、资源装配和打包。
- `manualChecks`：真实安装、故障注入、文件锁、权限和路径环境。
- `unverifiedChecks`：当前仍未完成的必需验收。

只完成自动步骤时状态为 `partial`，不能写成完整 V5 已通过。

## 兼容性

- 保留现有脚本名称和主要参数。
- 新字段可以增加，已有字段若删除必须同步更新文档和调用方。
- 失败状态必须有稳定的非零退出码。
- 输出 JSON 字段用于自动化，面向用户的说明可以使用中文。
