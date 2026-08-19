# ADR 0001: 日志库选型为 pino 主进程统一落盘 + 子进程管道回写

Status: Accepted
Date: 2026-08-19

## Context
项目现有日志有 3 套散落实现（main.js 本地 `log(tag, msg)`、watchdog/wsl-backend 独立 `console.log`、多个模块把 `log = () => {}` 当参数注入），无日志库、无分级、无结构化、无轮转、无跨进程 trace、无 PII 脱敏；构建脚本和批脚本直接裸 `console.log`。V1 目标是本地结构化 JSON、分级、轮转、跨进程 trace ID、PII 脱敏、诊断一键导出；不做远程上报。

候选：
- **electron-log**：Electron 原生，主/渲染进程开箱即用、自动写 userData 目录；但 JSON 结构不可定制（自定义 formatters 受限）、性能是 pino 1/5 以下、Windows 多进程同时写单文件偶尔会出现 4KB 扇区非原子写导致的 JSON 行被打断、崩溃捕获与现有 Node `uncaughtException` 钩子易重复触发
- **pino 8.x**：纯 Node stream 管道，`pino.destination()` 主进程单 fd 写入、子进程 stdout/stderr 主进程统一管道捕获包装；性能和 JSON 结构完全可控；`formatters.logMethod` + 自定义 transform 流方便接入深遍历 PII 脱敏；轮转逻辑自研按大小+上限（避免引入 `pino-rotation-file` 额外依赖）；Electron 内置 Node 版本满足 ≥16
- **winston**：插件生态成熟，但 `@datalust/winston-seq` 等依赖重、吞吐性能比 pino 慢 3x，对桌面端长驻进程 CPU/memory footprint 不友好

## Decision
选 **pino 8.x 作为统一日志库**。pino 实例只在 Electron 主进程持有一个写 fd；所有独立子进程（watchdog.js / wsl-backend.js / node.exe spawned server / dsh CLI）不直接开 pino fd，一律通过 stdout/stderr 主进程管道捕获后包装为同一 JSON 格式落盘；渲染进程的日志（非 DevTools Console）只通过 IPC `ipcRenderer.invoke('logger:log')` 回主进程写。

## Consequences
- 正面：Windows 上避免多进程写同一文件的原子性问题；性能 > electron-log/winston；深遍历 PII 脱敏 transform 可直接接入 pino stream pipeline；JSON 结构可自由扩展（BOOT_TRACE_ID、action_trace_id、pid、source、tag）
- 负面：渲染进程不能直接 require('pino')，需要走现有 IPC 基础设施新增 `logger:*` 通道；dsh CLI 输出无法直接感知结构（只能当字符串包装后写）；自研轮转比 `pino-rotation-file` 多 ~80 行代码，但减少一个生产依赖
- 后续约束：新增独立子进程必须继承 `stdio: ['ignore', 'pipe', 'pipe']` 回主进程统一写；不要在子进程中直接 `fs.createWriteStream(userData/logs/...)` 绕开主进程单 fd；PII 列表变更时必须同时更新 `settings.logging.piiRedact` 的键黑+值正则+前缀层三层，不要漏一层
