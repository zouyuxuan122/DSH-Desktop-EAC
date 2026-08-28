# DSH 插件开发规范

## 契约

- Host 插件遵守 `{ name, inject, apply }`。
- Client 插件遵守 `dsh.client` 注入和 `window.__ModuleLoader__.load`。
- 包入口、exports、Cordis patch 和实际文件必须一致。
- 设置命名空间保持稳定，配置需要校验和默认值。
- 路由仅绑定回环地址，并校验路径和会话归属。

## 内置插件分发

新增或调整内置插件时检查：

- `assets/plugins/<dir>/package.json`
- `cordis.patch.yml`
- `COMPANION_PLUGINS`
- 核心或推荐插件集合
- 插件复制文件清单
- profile 完整性 stamp
- 更新源和版本门槛
- 退役插件清理
- 打包资源完整性测试

首次启用策略还需要检查：

- `scripts/onboarding.js` 的核心与推荐集合。
- 核心插件不得被移除；推荐插件默认勾选但允许停用。
- 普通插件不得因内置分发被误标为核心。
- 只有存在真实 npm/GitHub 发布源时才登记插件更新源。

## 用户数据

- 已有 patch 行和用户启停选择优先。
- 不覆盖用户从市场安装的 bundle。
- 不删除本地 `link:`、`file:` 或 fork 安装。
- Windows 文件锁操作使用排队、staging 或重启窗口完成。

## 第三方代码

- vendored 第三方插件和皮肤保持原始运行语义。
- 除明确修复和许可证要求外，不进行风格重写。
- 许可证、NOTICE、README 和运行依赖必须随包分发。

## 当前规模与入口

插件数量和分发集合会随源码变化。工作时以 `assets/plugins` 当前目录、`COMPANION_PLUGINS`、仓库清单和注册表测试为准。

关键宿主代码：

- 注册表：`lib/desktop/companion-sync.ts::COMPANION_PLUGINS`
- 更新源：`pluginUpdateSources`
- 复制清单：`pluginCopyEntries`
- 完整复制：`copyPluginPackage`
- 同步入口：`syncCompanionPlugins`
- 插件管理：`lib/desktop/plugin-ops.ts`
- 市场排队：`lib/desktop/market.ts`

基础回归：

- `companion-plugins-registry.test.ts`
- `companion-copy-integrity.test.ts`
- `plugin-slot-registration.test.ts`
- `plugin-manager-state.test.ts`
- `plugin-manager-toggle.test.ts`
- `plugin-conflict-scan.test.ts`
- `plugin-updater.test.ts`

## Host 状态接口

新增只读状态接口时：

- 仅允许 loopback。
- 限制 HTTP 方法，未知方法返回明确状态。
- 存在 Origin 时校验来源。
- 返回 `Cache-Control: no-store`。
- 不返回 `DSH_HOME` 绝对路径、环境变量、命令行、凭据或用户标识。
- 路由 disposer 纳入插件生命周期。

## Client 设置面板

- 使用项目现有 `settings.section` slot 组合方式。
- 模块 id、section id、CSS id、API 路径使用插件私有前缀。
- timer、observer、AbortController 和事件监听在卸载时清理。
- loading、error、empty 和正常状态均可渲染。

## OpenClaw bridge

`openclaw-dsh-bridge/` 是独立 DSH 插件包，包含：

- `lib/index.js`：host 入口。
- `lib/client.js`：设置界面。
- `lib/openai-compat.js`：OpenAI 兼容端点。
- `lib/wechat.js`：微信登录、轮询和消息循环。
- `test/bridge.test.mjs`：独立契约测试。

修改时同时检查 `dsh-desktop/assets/plugins/dsh-openclaw-bridge` 的 vendored 版本是否需要同步。网络、登录态、白名单和 per-user session 隔离属于高风险契约。
