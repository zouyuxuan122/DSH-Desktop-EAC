# 测试与验收规范

## 当前基线

- 测试文件数、用例数、插件数和模块数都可能随源码变化，不在规范中固定。
- `npm test` 当前会先执行 TypeScript build；以当前 `package.json` 脚本和实际命令输出为准。
- Rust 检查先通过预检确认目标和工具链；环境阻断必须单独报告，不能沿用历史机器结论。
- 每次验收以当前命令输出和 `repo-inventory.ps1` 结果为事实依据。

重新统计当前仓库：

```powershell
.\scripts\repo-inventory.ps1 -RepoPath <repo>
```

## 验证层级

### V1 定向

- `npm run build`
- 相关 `node --test test/<name>.test.mjs`
- 配置、语法、资源或类型专项检查

适用于局部、低风险模块。

### V2 全量

```powershell
cd dsh-desktop
npm test
```

适用于共享 L2、插件注册表、profile、更新器和跨模块改动。

### V3 壳契约

- `cargo check` 或 `cargo build`
- bridge/preload parity
- sidecar RPC 与启动关闭测试

### V4 运行时

- `boot-smoke.js`
- `gui-smoke.js`
- 中文路径、浮窗、托盘、退出零孤儿等专项

### V5 分发

自动化部分：

- `update-smoke.js`
- `upgrade-test-441.js`
- `stage-resources.mjs`
- Tauri NSIS 构建
- 便携 zip

环境与事务验收：

- 真实安装、升级或解压运行

涉及便携整树交换时，V5 还包括：

- 每个交换 checkpoint 的失败注入。
- helper 中断后的启动前恢复。
- 文件锁与残留进程。
- 新版本 sidecar、boot 或 HTTP 健康失败后的自动回退。
- 真实便携包 A→B 与故障 B→A。
- 用户数据目录哈希保持不变。
- 中文/空格路径、非系统盘、低磁盘和普通用户权限。

## 选择规则

- 只改纯函数并有定向测试：V1。
- 改共享模块、插件注册或配置：至少 V2。
- 改 Rust、sidecar 或 bridge：至少 V3，用户可见行为通常需要 V4。
- 改更新、资源、安装器或发布：必须 V5。

无法运行的验证必须说明原因，不能写成“已通过”。

完成自动化部分但没有完成环境与事务验收时，V5 状态必须为 `partial`，未完成项放入 `unverifiedChecks`。

## Skill 辅助脚本

只生成计划：

```powershell
.\scripts\verify-change.ps1 -RepoPath <repo> -Level auto
```

实际执行：

```powershell
.\scripts\verify-change.ps1 -RepoPath <repo> -Level full -Execute
```

`package -Execute` 会运行完整测试、Rust/bridge、boot/gui/update/upgrade、资源装配、Tauri 构建和便携包。它不自动完成真实安装、故障注入、文件锁、低磁盘、路径和权限环境验收；这些项目完成前结果为 `partial`。

修改开发者 Skill 本身时，还必须分别在 PowerShell 7 和 Windows PowerShell 5.1 下运行 `tests/run-tests.ps1`，并执行 `scripts/validate-skill.ps1`。任一运行时不可用或失败时必须明确报告。
