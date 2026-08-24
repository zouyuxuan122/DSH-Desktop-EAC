# 可靠性与安全规范

## 可靠性链

- guard：快照、健康检查、修复、回滚和事故记录。
- rescue：崩溃循环计数、诊断、建议执行和安全模式。
- renderer recovery：页面崩溃、卡死、重载和重建窗口。
- watchdog：进程退出标记、重启上限和孤儿进程处理。

修改其中一层时检查与其他层的状态是否重复或冲突。

## 安全边界

- 文件操作限制在明确白名单和已解析绝对路径内。
- shell、PowerShell 和进程参数使用参数数组或环境变量传递，避免字符串拼接。
- 配置编辑只允许已声明动作和目标文件。
- Web 路由只接受 loopback 请求。
- 日志和诊断在落盘、导出和发送前执行深度脱敏。
- 自动修复不得执行白名单外命令，高风险建议默认不自动执行。

## 失败原则

- 不因修复失败破坏当前可运行版本。
- 不在服务运行且持有文件锁时强行覆盖插件树。
- 不无界重试网络、更新、启动或恢复动作。
- 用户取消和应用退出信号必须传播到长任务。
- 安全模式不得被同步逻辑重新启用非核心插件。

## 关键实现与测试

| 子系统 | 实现 | 测试 |
| --- | --- | --- |
| 日志与脱敏 | `logger.*` | `logger-redact`、`logger-rotate`、`diagnostics-zip` |
| 插件保护 | `plugin-guard.*`、`guard-box.ts` | `plugin-guard`、`boot-attribution` |
| AI 救援 | `rescue-agent.*` | `rescue-agent`、`rescue-auto-repair` |
| Tauri 救援桥 | `sidecar/rescue-integration.ts` | `rescue-integration`、`recovery-integration` |
| Renderer 恢复 | `renderer-recovery.*` | `renderer-recovery` |
| Watchdog | `watchdog.*` | `watchdog-behavior` |

涉及多个恢复层时，必须明确谁负责检测、谁负责重试、谁负责最终回退。
