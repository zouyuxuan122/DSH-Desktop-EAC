# ADR 0002：壳层边界声明与分层架构（Tauri 演进前置）

日期：2026-08-22
状态：已接受

## 背景

社区建议把 EAC 壳层迁移到 Tauri + Rust + TS。分析结论（见会话记录）：壳层 243KB 的
main.js 中约 60% 是与 Electron 零耦合的 Node 业务逻辑（profile 园艺、进程编排、插件治理、
更新器），约 35% 是真·桌面集成（窗口/托盘/IPC/通知）。前者是项目技术含量所在，也是未来
Tauri 架构中 Node sidecar 的主体；后者才是需要被 Rust 重写的部分。

## 决策

### 1. 三层边界（永不混淆）

```
┌─ L1 桌面集成层（可替换：Electron ↔ Tauri）
│    窗口 / 托盘 / 通知 / 对话框 / 剪贴板 / .lnk / 单实例锁 / IPC 通道
├─ L2 业务服务层（壳无关，本 ADR 的主角）
│    进程编排 / profile 园艺 / 插件治理 / 更新器 / 救援 / 余额 / 会话监听
└─ L3 内核（绝对不动区）
     @deepseek-ai/dsh + Cordis 插件树 + Web UI
```

### 2. 永不触碰清单（万物皆插件守护协议）

- `@deepseek-ai/*` 全部官方包的任何文件；
- `cordis.yml` / `cordis.patch.yml` 的语义（壳层只做幂等文本手术，规则见
  `syncCompanionPlugins`：「已有行不重写，用户选择优先」）；
- 插件契约：host 端 `{name, inject, apply}`、client 端 `dsh.client{inject, platform}`
  + `window.__ModuleLoader__.load({id, factory})`、皮肤 `ui-skin-*` 行、
  skills 目录式注册；
- `DSH_HOME` 目录布局与 `settings.yaml` schema；
- `/plugins` client bundle 下发路由。

### 3. 分阶段路线

- **T0**（本 ADR）：边界声明 + 模块架构。
- **T1**：main.js 纯移动拆分 → `lib/desktop/*` 模块。行为零变更，
  Electron 保持为第一个驱动方。目标：main.js 只剩 L1 胶水。
- **T2+**：L2 模块收敛为 headless service（无 Electron import），
  可被 Electron 进程内驱动或 Node sidecar 进程驱动；Rust ShellHost
  通过 stdio JSON-RPC 驱动同一份 service。

### 4. 新功能放置规则

新能力优先做成 dsh host 插件（注入 webServer 注册路由，如 dsh-terminal），
其次 L2 服务模块；只有真正需要桌面原生能力时才进 L1。

## 后果

- 正面：屎山解体为可测模块；Tauri 成为 L1 的可插拔实现而非重写；
  测试基线（608 例）全程护航。
- 代价：拆分期间需严格「纯移动」纪律——不改逻辑、不改文案、不改时序。
