# 功能包规范（.dshpack · Feature Pack）v1

状态：草案 v1（formatVersion = 1）
事实源：本文件 + `docs/schemas/feature-pack-pack.json`（两者不一致时以 schema 为准并修文档）。
参考：HMCL 整合包体系（modpack manifest + overrides + 安装事务），仅借鉴概念，不含其代码（HMCL GPLv3 / 本项目 MIT）。

## 1. 是什么

`.dshpack` 是 Deepseek Harness EAC 的「功能包」归档：把一组**官方内核版本要求 + DSH 插件引用 + agent preset + skill** 打成单个 zip，供一键安装 / 卸载 / 更新 / 导出分享，并可声明**内核（@deepseek-ai/dsh）兼容范围**——官方内核升级后自动检出失配的功能包并支持迁移或回滚。

- 分发：GitHub 市场索引（`packs-index.json`）指向 `.dshpack` 下载地址 + SHA-256；
- 管理 UI：内置插件 `dsh-unified-market` 的设置页「功能包」分区；
- 执行体：dsheac 主体 L2 的功能包 CLI（`dsh-desktop/scripts/feature-pack-cli.js`），插件层只做交互编排（spawn CLI + 轮询），不重复实现核心逻辑。

## 2. 归档布局

```
<id>-<version>.dshpack          # zip 归档，UTF-8 文件名
├── pack.json                   # 清单（必填，见 §3）
├── icon.png                    # 可选图标（≤512KB，png）
└── payload/                    # 可选内嵌载荷
    ├── presets/<preset-id>/    # preset 目录（必须含 preset.yml）
    └── skills/<skill-id>/      # skill 目录（必须含 SKILL.md）
```

## 3. pack.json 清单

```jsonc
{
  "formatVersion": 1,
  "id": "com.example.coder-pack",          // ^[a-z0-9][a-z0-9._-]{2,63}$，全局唯一
  "name": "全能编码功能包",
  "version": "1.2.0",                       // semver
  "description": "一句话说明",
  "author": "someone",
  "license": "MIT",
  "icon": "icon.png",                       // 可选，包内相对路径
  "requires": {                             // 可选，缺省不限
    "dsh": ">=0.1.1-rc.2 <0.2.0 || ^0.2.1"  // 内核 semver 范围（§5）
  },
  "plugins": [                              // 可选；声明式引用，安装时解析
    { "ref": "builtin:dsh-terminal" },                      // EAC 内置插件（只核验存在）
    { "ref": "github:user/repo", "version": ">=1.0.0" },    // GitHub 源
    { "ref": "@deepseek-ai/dsh-fs" }                        // registry/npm 名
  ],
  "presets": [{ "id": "anchored-standard" }], // 内嵌于 payload/presets/ 或要求已存在
  "skills":  [{ "id": "my-skill" }],           // 内嵌于 payload/skills/ 或要求已存在
  "conflicts": ["dsh-xxx"],                    // 已知冲突插件（profile 已装则阻断；--force 可越过）
  "overrides": [],                             // v1 预留（未使用；出现非空值判为无效）
  "changelog": "本次更新…"                     // 可选，更新提示用
}
```

### 3.1 插件引用（plugins[].ref）

| 形式 | 语义 | 安装动作 |
| --- | --- | --- |
| `builtin:<assets 目录名>` | EAC 内置插件 | 仅校验存在并登记，不复制不写行 |
| `github:<owner>/<repo>` | GitHub dsh-plugin | `dsh plugin --profile <p> add github:o/r` |
| 裸 npm / registry 名 | npm 发布插件 | `dsh plugin --profile <p> add <name>` |

- `version` 对 github/npm 为期望范围；与已装版本不符时**升级式重装**（remove + add）。
- `enabled`（可选布尔，v1 预留）：目前不改变任何行为；插件启停始终走「插件管理」页，包不越权。

## 4. 安装 / 卸载语义

- **解析顺序**：下载/定位 zip → 解压临时目录 → `validateManifest` → `checkCompat`（requires vs 当前内核）→ conflicts 预检 → 保护中心快照 → 逐插件装配（CLI）→ payload 同步（skip-if-exists）→ 写注册表。
- **内置 preset/skill 同步规则**（沿用既有纪律）：
  - 目标不存在 → 复制安装；
  - 目标存在且带 EAC 托管标记（preset：整目录由包管理；skill：`.eac-skill.json` 且版本更新）→ 覆盖更新；
  - 用户自建同名（无托管标记）→ **永不覆盖**，登记为 `skipped`；
- **事务**：任一步失败 → 反向拆除已完成步骤（已装的非内置插件逐个 `dsh plugin remove`）、清理临时目录、注册表不留半成品；保护中心快照保留供人工兜底。
- **Windows 文件锁**：pnpm 撞锁（EPERM/EBUSY）时不硬重试——CLI 以专用退出码结束，宿主把任务原样排队（`feature-packs/.ops/pending.json`），下次服务启动前的无锁窗口自动续跑（与插件市场排队同窗口）。
- **卸载**：只拆本包登记物（registry 的 owned 列表）；被多个包共用的插件保留（引用计数）；用户自行安装的插件、session、API Key 一律不动。

## 5. 内核兼容（适配官方版本）

- `kernelDshVersion()`：优先读桌面 profile 闭包 `node_modules/@deepseek-ai/dsh/package.json` 的真实版本 → 回退随包内置版本。
- 启动时兼容扫描：遍历注册表 `state:"active"` 条目 × `matchRange(requires.dsh, kernel)`，失配者置 `incompatible`（幂等写回）；EAC 自更新后的首启自然触发。
- 失配处理：UI 提示 →「一键迁移」（拉新版包 update）或「一键回滚」（restore 安装时快照，快照来自保护中心）。
- 预发布宽容：`0.1.1-rc.2` 参与 rc 序比较；范围未声明 prerelease 时按「同 `[major,minor,patch]` 的 rc 视为满足」的宽容策略匹配（EAC 内核常驻 rc 命名，从严会把合法范围全部错杀）。

### 5.1 范围语法（matchSemverRange）

支持：`*`｜空｜`x.y.z` 精确｜`>=` `>` `<=` `<` `=` 前缀比较符｜`^`｜`~`｜`||` 或组｜空格 AND 组｜部分版本（`1.2` ≙ `>=1.2.0 <1.3.0`，`1` ≙ `>=1.0.0 <2.0.0`）。
不支持即判**不匹配**（保守），并以诊断指明语法位置。

## 6. 注册表

路径：`<DSH_HOME>/feature-packs/registry.json`（新增目录，不改动 DSH_HOME 其余布局；原子写：tmp + rename）。

```jsonc
{
  "version": 1,
  "packs": [{
    "id": "com.example.coder-pack",
    "version": "1.2.0",
    "installedAt": "2026-09-01T00:00:00.000Z",
    "profile": "web-desktop",
    "state": "active",                        // active | incompatible | rolled-back
    "requires": { "dsh": "..." },
    "source": "local-file | url | market",
    "plugins": [{ "ref": "...", "pkg": "@scope/name|null", "managed": true }],
    "presets": [{ "id": "...", "installed": true, "skipped": false }],
    "skills":  [{ "id": "...", "installed": true, "skipped": false }],
    "snapshotRef": "snap-123",                // 保护中心快照 id（回滚依据）
    "opRef": "fp-1700000000000-ab12"          // 最近一次 op（状态文件 key）
  }]
}
```

op 状态文件：`<DSH_HOME>/feature-packs/.ops/<opRef>.json`——`{ opRef, action, stage, pct, message, done, ok, error?, result? }`，宿主（市场插件）轮询消费；任务级排队标记为 `.ops/pending.json`。

## 7. CLI（执行体唯一入口）

```
node scripts/feature-pack-cli.js inspect  <zip|url>              # 只解析校验，输出 manifest JSON
node scripts/feature-pack-cli.js list                            # 注册表 + 实时兼容标注
node scripts/feature-pack-cli.js install  <zip|url> [--force] [--op <opRef>]
node scripts/feature-pack-cli.js update   <id> <zip|url> [--force] [--op <opRef>]
node scripts/feature-pack-cli.js uninstall <id> [--op <opRef>]
node scripts/feature-pack-cli.js export   <id> [-o <out.zip>] 
node scripts/feature-pack-cli.js scan                             # 启动兼容扫描（写回 state）
node scripts/feature-pack-cli.js resume                           # 消费 pending 排队（无锁窗口由 sidecar 调）
```

退出码：`0` 成功｜`1` 一般失败｜`2` 用法错误｜`3` 文件锁待排队（宿主据此挂起）｜`4` 兼容失配｜`5` 冲突阻断。
所有长操作若给了 `--op` 则把进度写 `.ops/<opRef>.json`。

## 8. 市场索引协议

`packs-index.json`：

```jsonc
{
  "updated": "2026-09-01",
  "source": "live",
  "packs": [{
    "id": "com.example.coder-pack",
    "name": "全能编码功能包",
    "version": "1.2.0",
    "author": "someone",
    "desc": "一句话简介",
    "url": "https://github.com/o/r/releases/download/v1.2.0/com.example.coder-pack-1.2.0.dshpack",
    "sha256": "<64 hex>",
    "requires": { "dsh": "..." },
    "iconUrl": null,
    "added": "2026-09-01"
  }]
}
```

获取链：远程 live → 5 分钟内存缓存 → 内置离线快照（`data/packs-snapshot.json`）。
完整性：下载后必须校验 SHA-256（索引缺失 sha256 时拒绝安装该条目）。

## 9. 边界与红线

- 不修改 `@deepseek-ai/*` 包本体；patch 行一律经 `dsh plugin` CLI 写/删，包不手写 `cordis.patch.yml`。
- 不改 `DSH_HOME` 既有目录布局，仅新增 `feature-packs/`。
- 用户数据不可侵犯：session、settings.yaml、用户自建 preset/skill/插件永不因装/卸/更新/回滚丢失（回滚 = 保护中心快照语义，仍以「恢复配置面」为限）。
- 插件进程（L3）不含核心逻辑：解析/校验/semver/注册表/编排全部在 L2 CLI；L3 仅 spawn 与轮询。
