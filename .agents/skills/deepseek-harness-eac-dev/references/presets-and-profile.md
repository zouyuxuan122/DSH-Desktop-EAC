# Preset、Profile 与配置规范

## 目录与所有权

- 桌面 profile 默认是 `web-desktop`。
- `DSH_HOME` 与原生 CLI 共享会话和凭据，但桌面插件环境隔离。
- 内置 preset 同步到用户 preset 目录时不得覆盖已有用户修改。
- 项目内置 Skill 同步时，用户自建同名目录不得被覆盖。

## Cordis patch

- 保持 YAML、BOM、CRLF 和 `!!js` 等既有格式兼容。
- 修改必须幂等。
- 精确匹配目标 id/name，避免前缀误匹配。
- 不能留下空 insert 块、重复 id 或重复 config。
- bundle 已自行挂载的 entry 不得再写 overlay 重复行。
- 用户 disabled 状态和自定义 config 优先于内置默认值。

## 配置迁移

- 只迁移明确识别的旧结构。
- 首次修改前保留可恢复备份。
- 无法安全解析时保持原文件不变并记录诊断。
- 重复运行结果一致。
- 不越过 profile 根目录。

## 验证

- YAML/JSON 解析。
- BOM、CRLF、空文件和畸形配置。
- 幂等运行。
- 用户自定义内容保留。
- 真实 profile 启动。

## 关键实现

- Profile 解析与初始化：`lib/desktop/profile.ts`
- 内置 preset 同步：`preset-sync.js`
- 压缩 preset 迁移：`compact-preset-migrate.js`
- Patch 行读写：`scripts/plugin-manager-patch.js`
- Patch config 修复：`patch-row-heal.js`
- 旧共享 web profile 迁移：`shortcuts.ts::migrateFromSharedWebProfile`
- 内置 Skill 同步：`market.ts::syncBundledSkills`

## 基础回归

- `preset-sync.test.mjs`
- `patch-row-heal.test.mjs`
- `resolve-profile.test.mjs`
- `retired-market-migration.test.mjs`
- `onboarding-selection.test.mjs`
- `profile-module-heal.test.mjs`
- `session-encoding-heal.test.mjs`

## 内置 Skill 分发

当前同步入口是 `market.ts::syncBundledSkills`：

- 源目录：`dsh-desktop/assets/skills/<name>/`
- 目标目录：`~/.dsh/skills/<name>/`
- 带 `.eac-skill.json` 的托管 Skill 按版本更新。
- 用户自建同名且无托管标记的 Skill 永不覆盖。

当前缺少独立同步测试。修改同步行为时必须补测试，至少覆盖托管更新、用户同名保护和不删除用户 Skill。
