# 源码影响矩阵

本矩阵使用文件和符号名称，不依赖容易漂移的行号。修改前仍需搜索当前调用者和测试读取者。

## L1 Tauri 壳

| 修改点 | 关键符号 | 必查联动 | 最低验证 |
| --- | --- | --- | --- |
| `tauri-shell/src/main.rs` | `handle_shell_method`、`handle_sidecar_notify`、`apply_exit_policy`、`Sidecar::spawn` | `sidecar/server.ts`、`bridge.ts`、`tauri.conf.json` | V3；窗口行为用 V4 |
| 窗口公开 API | `win.*`、`float.*`、`menu.action` | `bridge.ts`、`preload.js`、`bridge-preload-parity.test.mjs` | V3 + GUI smoke |
| 壳页面 | `loading_page`、`exit_page`、`died_page`、`update_page`、`about_page`、`wizard_page` | sidecar 通知名称、导航回跳参数 | V4 |
| 资源定位 | `resource_root`、`resolve_node`、`sidecar_script` | `stage-resources.mjs`、`tauri.conf.json`、`make-portable.mjs` | V5 |
| 退出与重启 | `apply_exit_policy`、`ExitRequested`、`shell.quit-for-update` | sidecar `shutdown`、`boot.stop`、更新器 handoff | V4/V5 |

## L2 Sidecar 与共享服务

| 模块 | 关键符号 | 主要消费者 | 相关测试或验收 |
| --- | --- | --- | --- |
| `boot-server.ts` | `startAndWait`、`stopServer`、`killAndWaitForRestart`、`state` | sidecar `boot.*`、rescue | `stable-port`、boot/GUI smoke |
| `runtime-paths.ts` | `nodeExe`、`npmCli`、`dshBin`、`updCtx` | boot、更新器、插件同步 | `bundled-files`、真实打包 |
| `profile.ts` | `desktopProfile`、`desktopProfileDir`、`ensureDesktopProfileInit` | 所有 profile 操作 | `resolve-profile`、真实首启 |
| `proc.ts` | `killTree`、`childEnv`、`waitForProcExit` | boot、更新、退出 | stream/更新/退出验收 |
| `companion-sync.ts` | `COMPANION_PLUGINS`、`copyPluginPackage`、`syncCompanionPlugins` | boot、市场、插件管理 | registry、copy integrity、patch、全量测试 |
| `plugin-ops.ts` | `pluginManagerReadPatch`、`pluginManagerSetEnabled`、`pluginManagerSetRemoved` | sidecar RPC、向导 | plugin-manager、onboarding、image-paste |
| `market.ts` | `processPendingMarketOps`、`restoreKeptArtifacts`、`syncBundledSkills` | boot、市场 | allow-builds、artifact-keep、collision |
| `client-update.ts` | `runClientUpdateFlow`、`offerPendingClientUpdate` | sidecar 菜单和定时器 | client-updater 全组 + update smoke |
| `shortcuts.ts` | `maintainShortcuts`、`migrateFromSharedWebProfile` | boot、菜单 | `shortcut-maintenance`、profile 测试 |
| `static-preview.ts` | `startPreviewStaticServer`、`verifyBundledModules` | 文件预览、启动保护 | bundled-files、bundle integrity |
| `file-roots.ts` | `fileRoots`、`isUnderFileRoots` | 文件打开与预览 | 路径白名单专项 |
| `guard-box.ts` | `ensureGuard` | 更新、救援、插件管理 | plugin-guard、boot-attribution |
| `junction-patrol.ts` | `startJunctionWatchdog`、`detectExternalDsh` | boot | profile heal、真实启动 |
| `runtime-patches.ts` | `runtimePatchRoots`、`applySessionManageFix` | boot 同步 | session/profile 集成 |

## Sidecar RPC

`tauri-shell/sidecar/server.ts` 挂载多个 L2 模块。模块数量以当前导入、装配代码和仓库清单为准。修改以下区域时检查：

- `methods`：基础 `shell/profile/runtime/plugins/guard/boot/chrome` 方法。
- 批量 RPC：balance、clipboard、files、image-paste、plugins、guard、menu。
- `runAgentUpdateFlow`：Agent 更新。
- onboard/wizard 方法：插件选择向导。
- `scheduleAutoUpdateChecks`：自动检查时序。
- `handleLine`：JSON-RPC 解析、错误码与 shutdown。

新增 RPC 必须同步 bridge 或壳调用者，并增加参数、错误和返回契约测试。

## 插件与资源

| 修改 | 必查 |
| --- | --- |
| 新增内置插件目录 | `package.json`、exports、patch、`COMPANION_PLUGINS`、复制清单、注册表测试 |
| 修改插件文件布局 | `pluginCopyEntries`、`copyPluginPackage`、stamp 完整性、stage resources |
| 修改核心插件 | onboarding 核心集合、禁止卸载逻辑、preset 引用 |
| 退役插件 | `RETIRED_BUILTIN_PLUGINS`、patch/依赖/bundle 清理、迁移测试 |
| 修改皮肤 | `assets/skins`、互斥切换、profile、z-index、许可证 |
| 修改 preset | `preset.yml`、`agent.cordis.yml`、共享 `_preset`、同步和迁移测试 |
| 修改内置 Skill | `assets/skills`、`.eac-skill.json`、`syncBundledSkills`、CI paths |
| 修改开发者 Skill | `SKILL.md`、`agents/openai.yaml`、`references/`、`scripts/`、Skill 自检、CI paths |

## 更新与分发

| 修改点 | 契约测试 | 运行验收 |
| --- | --- | --- |
| `client-updater.js` | `client-updater-*`、`client-update-platform` | `update-smoke.js` |
| `updater.js` | `updater-*`、`update-mirror-chain` | Agent 更新 mock/回退 |
| `plugin-updater.js` | `plugin-updater.test.mjs` | 插件 staging 与 profile 同步 |
| `installer-hooks.nsh` | installer takeover 系列 | 真实静默升级 |
| `patch-deps.js` 或受控 `node_modules/@deepseek-ai/**` | 补丁幂等、规则分类、目标标记 | staging 重放、vendored 回填和安装树核对 |
| `stage-resources.mjs` | bundle integrity、bundled files | 安装树和便携树 |
| `make-portable.mjs` | hash/资源清单 | 全新目录解压冷启动 |
| release workflow | 本地同构命令 | 首次线上运行人工观察 |

## 可靠性

| 修改点 | 最少测试 |
| --- | --- |
| `logger.*` | `logger-redact`、`logger-rotate`、diagnostics |
| `plugin-guard.*` | `plugin-guard`、`boot-attribution` |
| `rescue-agent.*` | `rescue-agent`、`rescue-auto-repair`、`rescue-integration` |
| `renderer-recovery.*` | `renderer-recovery`、`recovery-integration` |
| `watchdog.*` | `watchdog-behavior`、退出运行验证 |

## 高风险判定

满足任一条件，最低提升到 V4 或 V5：

- 修改用户数据、配置迁移、目录交换或安装树。
- 修改进程启动、停止、退出、重启或单实例。
- 修改 bridge 公开 API 或 sidecar 通知。
- 修改更新器、NSIS、资源装配或便携版。
- 修改安全模式、自动修复、日志脱敏或路径白名单。
