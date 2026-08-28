# 更新、安装与打包规范

## 三类更新

1. EAC 客户端更新。
2. DSH Agent overlay 更新。
3. 内置或市场插件更新。

三者不得共用模糊状态或相互覆盖目录。

## 客户端

- 安装版通过 NSIS Setup 完成替换。
- 便携版按完整目录树 staging、交换和重启。
- 下载支持校验、断点恢复和镜像回退。
- 安装失败保留旧程序、更新文件和诊断日志。
- 旧 Electron 版本接管不得删除用户数据。

### 便携整树事务

修改便携版目录树交换时必须考虑：

- helper 接管成功后主程序才退出。
- 壳 PID 超时仍存活时中止，不触碰安装树。
- staging 内容、目标版本、磁盘空间和固定顶层项先校验。
- 使用唯一事务目录和持久 journal 记录每一步。
- 交换顺序固定，失败按 journal 逆序恢复。
- helper 被杀、断电或系统重启后，下一次启动能识别并恢复未完成事务。
- last-good 只在新 sidecar、`boot.start` 和 Web 探针确认健康后清理。
- 回滚失败时保留新旧树、journal 和日志。
- `%APPDATA%`、`DSH_HOME`、profile、会话和下载缓存不参与程序树交换。
- 未知顶层文件、reparse point 和符号链接采用明确的保留、拒绝或隔离策略。

## Agent

- 更新安装到 overlay/staging。
- 新版本未确认健康前保留 previousAgent。
- 启动失败支持回退。
- npm registry 和镜像切换必须有超时和明确错误。

## 插件

- 更新前执行兼容门槛、冲突检查和 guard 快照。
- staging 验证通过后再替换内置覆盖层。
- 更新失败清理 staging，但保留当前可用版本。

## 打包

- `stage-resources.mjs` 是 Tauri 资源装配入口。
- 新增运行文件必须进入资源清单和完整性测试。
- 同步版本号到产品配置和发布产物命名。
- NSIS 与便携包都要验证真实目录结构。
- 不能只验证 `target/release`，必须验证安装后或解压后的运行树。

## 关键文件

- EAC 客户端更新核心：`dsh-desktop/client-updater.js`
- Tauri 客户端更新适配：`lib/desktop/client-update.ts`
- Agent 更新：`dsh-desktop/updater.js`
- 内置插件更新：`dsh-desktop/plugin-updater.js`
- Tauri 资源装配：`tauri-shell/stage-resources.mjs`
- 便携包：`tauri-shell/make-portable.mjs`
- NSIS 钩子：`tauri-shell/installer-hooks.nsh`
- Tauri 配置：`tauri-shell/tauri.conf.json`
- 发布工作流：`.github/workflows/release-tauri.yml`

## 测试组

- `client-updater-*.test.ts`
- `client-update-platform.test.ts`
- `updater-*.test.ts`
- `update-mirror-chain.test.ts`
- `plugin-updater.test.ts`
- `bundle-integrity.test.ts`
- `bundled-files.test.ts`
- `installer-*.test.ts`
- `verify-dist-fresh.test.ts`

便携更新不能只测成功路径。还要覆盖逐步骤失败、文件锁、进程残留、helper 中断、健康检查失败、重复恢复和用户数据哈希不变。
