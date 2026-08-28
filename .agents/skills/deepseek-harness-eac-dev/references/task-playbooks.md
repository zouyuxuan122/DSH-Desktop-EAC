# 典型任务工作流

## 新增内置 DSH 插件

1. 判断功能属于 host、client 或复合插件。
2. 创建包入口、exports、许可证和可选 `cordis.patch.yml`。
3. 注册到 `COMPANION_PLUGINS`，明确默认启用、核心、推荐和更新源。
4. 检查复制清单是否包含所有运行文件和自包含依赖。
5. 增加插件自身测试、注册表测试和 profile 同步测试。
6. 运行 V2；涉及原生资源或窗口时提升到 V4/V5。

设置面板插件还应检查：

- `settings.section` 的注入与注销方式。
- API 是否只需 DSH host 信息，避免为了桌面状态无必要地新增壳 IPC。
- 首次向导是核心、推荐还是普通插件。
- route、timer、observer 和请求取消能随插件卸载清理。

## 修改现有插件

1. 判断是项目自研还是 vendored 第三方。
2. 搜索 package exports、patch entry id、设置命名空间和 preset 引用。
3. 保留用户配置兼容和旧版本迁移。
4. 修改文件布局时同步 copy/stamp/打包完整性。
5. 运行插件专项测试和 V2。

## 增加桌面 RPC

1. 判断由 Rust L1 本地处理还是 Node L2 实现。
2. 定义方法名、参数、返回值、错误和通知。
3. 在 `main.rs`、`server.ts`、`bridge.ts` 的必要位置实现。
4. 检查 preload parity；默认同步 Electron 最小对等 API，除非已有正式决策解除 parity。
5. 增加契约测试。
6. 运行 V3；用户可见行为运行 GUI smoke。

## 修改窗口或托盘

1. 检查主窗、浮窗和退出页的差异。
2. 保持单实例、退出策略和 sidecar 清理。
3. 避免窗口事件重复触发通知或退出。
4. 运行 Rust 检查、bridge 测试和 GUI smoke。
5. 退出修改必须确认零孤儿进程。

## 修改 Profile 或 Preset

1. 明确用户文件所有权。
2. 只匹配已知结构，保留 BOM、CRLF、`!!js` 和自定义字段。
3. 首次迁移创建备份，重复运行幂等。
4. 增加合法、畸形、已有用户修改和重复运行测试。
5. 运行 V2 和临时 `DSH_HOME` 真实启动。

## 修改客户端更新

1. 分开安装版和便携版流程。
2. 保持 SHA-256、断点恢复、镜像回退和无空间错误处理。
3. 更新失败保留旧程序并重启旧版本。
4. 检查 sidecar 进度通知和 Rust 更新页。
5. 运行全部 `client-updater-*`、V2 和 `update-smoke.js`。
6. 修改 apply/installer 时执行 V5。

便携目录树交换还必须：

- 为每个 move/rename checkpoint 提供故障注入测试。
- 模拟 helper 被杀、文件锁、残留 PID 和重复恢复。
- 使用真实 `make-portable.mjs` 产物做 A→B 升级。
- 让故障版 B 启动失败后恢复 A，并验证用户数据哈希不变。
- 在中文/空格路径、非系统盘、低磁盘和普通用户权限下验收。

以上事务和环境项目属于 V5 人工或专项夹具验收，不由通用 `verify-change.ps1 -Level package -Execute` 自动完成。未完成时必须逐项报告。

## 修改 Agent 或插件更新

1. Agent 使用 overlay、previousAgent 和健康确认。
2. 插件使用 guard 快照、兼容门槛和 staging。
3. 网络、npm 和文件锁操作必须有超时。
4. 不让单个插件失败拖垮全量检查。
5. 运行 updater/plugin-updater 专项测试和 V2。

## 修改受控依赖补丁

1. 先读取 `dependency-patches.md`，确认目标属于已批准的 `@deepseek-ai/*` 例外链路。
2. 以 `dsh-desktop/scripts/patch-deps.js` 为补丁事实源，不把安装树中的临时修改当作最终实现。
3. 同步检查 `tauri-shell/scripts/stage-resources.mjs` 是否在干净依赖安装后重放补丁。
4. 修改受控 vendored 文件时核对来源版本、项目差异、许可证和 staging 回填逻辑。
5. 验证补丁可重复执行、目标标记存在、staging 内容正确，并运行 V2；影响安装树和发布资产时提升到 V5。
6. 发布链只使用 `release-tauri.yml`，不得启用历史 `release.yml`。

## 修改救援与自动修复

1. 检查 guard、rescue、renderer recovery 和 watchdog 是否重复处理。
2. 自动动作保持白名单，高风险操作不自动执行。
3. 诊断数据先脱敏。
4. 每次恢复和重试有上限。
5. 运行 reliability 全组测试，启动/退出行为用 V4。

## 修改打包或发布

1. 检查源码事实源、编译产物和 staged resources。
2. 同步版本号、产物名称、hash 和 updater 选择规则。
3. 运行 V2 后装配资源。
4. 构建 NSIS 和便携 zip。
5. 在干净目录验证安装树、解压树、冷启动和升级。
6. 未经授权不创建 tag 或 release。
