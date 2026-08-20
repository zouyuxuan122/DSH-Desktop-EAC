# 内置 Skills 分发目录

每个子目录是一个技能包：`<kebab-name>/SKILL.md`（frontmatter 必须含 `name`
与 `description`，`name` 必须 kebab-case）。可附 `.eac-skill.json` 标记：

```json
{ "managed": true, "version": 1, "source": "DSH Desktop EAC assets/skills" }
```

桌面端启动时把这里的技能同步到 `~/.dsh/skills/`（dsh 内核的默认扫描根，
rank 400，无需额外配置）：

- 带标记且版本号变化 → 覆盖更新；
- 目标已存在但**无标记**（用户自建同名技能）→ 永不覆盖；
- 不删除用户后来放进 `~/.dsh/skills/` 的任何内容。
