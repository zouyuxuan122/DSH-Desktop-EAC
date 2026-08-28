# 正式安装版自更新黑窗与中断修复设计

## 背景

正式安装版下载新 Setup 后，会生成 `apply-update.cmd`，由当前 EAC 主进程以 detached 方式启动。脚本先通过 `ping` 延时，再执行：

```cmd
taskkill /F /T /IM "Deepseek Harness EAC.exe"
```

随后才会启动新 Setup。

现场日志停在 `force-killing leftover app processes`，没有进入 `running setup`。更新脚本是当前 EAC 启动的子进程，按镜像名配合 `/T` 结束进程树时，可能连同更新脚本自身一起终止。用户因此看到 `ping` 或旧版 `find /i` 黑窗，但安装器没有启动。

开发环境不能稳定复现，因为 `npm start`、便携构建和 NSIS 正式安装版的进程名、父子关系、安装目录、UAC 与安装器接管流程不同。

## 目标

- 正式安装版更新过程中不显示 `ping`、`find` 或其他命令行窗口。
- 更新辅助进程不得按镜像名结束整个进程树，也不得结束自身。
- 精确等待当前 EAC 主进程退出；超时后只结束该主进程 PID。
- 当前主进程退出后启动已下载并校验的 Setup。
- Setup 成功后删除安装包和辅助脚本；失败时保留诊断材料并重启旧版。
- 保留便携版现有备份、替换和回滚行为。

## 非目标

- 不修改安装器的安装范围选择界面。
- 不改变 NSIS 的升级、卸载和用户数据策略。
- 不修改客户端安装包下载、断点续传或 SHA-256 校验。
- 不在本次修复中重构 dsh agent 更新流程。

## 方案比较

### 方案 A：仅删除 `taskkill` 的 `/T`

优点是改动最小。缺点是仍然依赖可见风险较高的 CMD、`ping` 延时和按镜像名结束所有同名进程，无法解决黑窗和误杀其他实例。

### 方案 B：保留 CMD，改为按 PID 等待和结束

可以避免按镜像名误杀，但批处理需要借助 `tasklist/find` 或其他外部命令判断 PID，容易重新引入管道挂死和窗口闪现问题。

### 方案 C：隐藏 PowerShell 等待进程，再调用安装动作 CMD

安装版生成 `apply-update.ps1` 和 `apply-update.cmd`。PowerShell 只负责进程
生命周期，CMD 保留 v4.4 已有的四目录备份、manifest、静默安装和失败回滚：

- 按当前主进程 PID 有界等待；
- 超时只对该 PID 执行 `Stop-Process -Force`；
- 主进程退出后，在隐藏控制台中同步调用安装动作 CMD；
- 安装动作 CMD 不再包含 `ping`、`tasklist` 或 `taskkill`；
- 全程写入 `apply-update.log`；
- PowerShell 窗口通过 `-WindowStyle Hidden` 与 Node `windowsHide: true` 双重隐藏。

该方案不需要 `ping`、`find`、`tasklist` 或 `taskkill /T`，同时不回退 v4.4
新增的更新前备份与安装失败回滚能力，选择此方案。

## 更新流程

### 正式安装版

1. 下载 Setup 并完成大小及 SHA-256 校验。
2. 写入两个辅助脚本：
   - `apply-update.ps1`：等待并精确结束当前主进程；
   - `apply-update.cmd`：执行四目录备份、manifest、Setup 与失败回滚。
3. 将以下参数直接传给 PowerShell，不通过字符串拼接：
   - Setup 完整路径；
   - 当前安装版 exe 完整路径；
   - 当前 EAC 主进程 PID；
   - 日志完整路径。
4. 以 detached、隐藏窗口方式启动 PowerShell。
5. EAC 主进程按现有流程执行 `app.exit(0)`。
6. PowerShell 最多等待主进程退出 20 秒。
7. 若超时，仅执行 `Stop-Process -Id <当前主进程 PID> -Force`，再短暂等待。
8. PowerShell 同步调用隐藏的安装动作 CMD。
9. CMD 完成四目录备份后，以 `/S` 启动 Setup 并等待退出。
10. Setup 返回 0：
   - 写入成功日志；
   - 删除 Setup；
   - 删除 CMD 与 PowerShell 辅助脚本；
   - 写入 `.backup-ts` 供新版确认备份清理。
11. Setup 返回非 0 或启动失败：
    - 写入失败日志；
    - 保留 Setup 和日志；
    - 从备份回滚四个目录；
    - 如果旧版 exe 仍存在，重新启动旧版；
    - 两个辅助脚本退出或保留为非成功状态。

### 便携版

便携版继续使用现有 `apply-update.cmd` 备份、替换和回滚流程。本次只修复正式安装版，避免扩大风险面。

## 安全与错误处理

- 只允许结束调用方传入的数字 PID，不按镜像名批量结束进程。
- PID 参数必须在生成和测试层验证为正整数。
- Setup 和旧版 exe 路径通过 PowerShell 参数传递，不拼接进命令字符串。
- Setup 不存在时立即记录失败，不执行任何删除。
- 等待和强制结束均有明确上限，不允许无限循环。
- 失败路径不删除 Setup，便于用户手动安装和排查。
- 日志使用 UTF-8，避免当前 `cmd` 日志中的本地化日期乱码。

## 代码调整

- `client-updater.js`
  - 新增 `buildInstalledApplyScript()`，生成 PowerShell 脚本。
  - 安装版 `applyUpdate()` 改为启动隐藏 PowerShell。
  - 便携版继续使用现有 CMD 生成与启动逻辑。
  - 安装动作 CMD 保留备份/回滚和 `call Setup /S`，删除其中的进程等待、
    `ping` 与 `taskkill /T`。
- `test/client-updater-apply.test.mjs`
  - 更新安装版静态约束。
  - 增加 PowerShell 脚本参数、安全和清理测试。
  - Windows 下执行端到端测试：等待指定 PID、四目录备份、启动伪 Setup、
    成功清理与失败回滚。

## 测试

至少覆盖：

1. 安装版脚本不包含 `ping`、`find`、`tasklist`、`taskkill`。
2. 只按传入 PID 等待和强制结束。
3. 等待时间有上限。
4. Setup 在旧主进程退出之后启动。
5. Setup 成功时删除 Setup 和两个辅助脚本。
6. Setup 失败时保留 Setup、写日志并重启旧版。
7. 路径包含空格和中文时参数保持完整。
8. PowerShell 辅助进程使用隐藏窗口参数。
9. 安装版四目录备份、manifest 和失败回滚继续通过。
10. 便携版原有备份、替换和回滚测试继续通过。
11. 完整 `npm test` 与构建语法检查通过。

## 验收标准

- 从已安装旧版点击“立即重启并更新”后，不出现 CMD、`ping` 或 `find` 黑窗。
- 旧版主进程退出后，Setup 安装界面正常出现。
- `apply-update.log` 包含等待主进程、启动 Setup、Setup 退出码和最终结果。
- 更新失败时安装包仍保留，可手动运行。
- 正式安装版端到端测试能够复现并防止原先的更新辅助进程自终止问题。
