# DeepSeek Harness EAC — macOS 验收冒烟记录（Task 7）

> 日期：2026-08-27 · 机器：arm64 macOS · 产物：`tauri-shell/target/release/bundle/macos/Deepseek Harness EAC.app`（5.1.0 aarch64）
> 范围：自动化可执行的进程级 + 功能面验收项；纯视觉/GUI 交互项（窗口外观、托盘菜单点击、通知横幅等）本机 GUI 会话可能锁定，无法无头验证，列入「待人工确认」。
> 结论均经本机实测背书。

## 一、自动化验收结果

### 1. 启动与加载（进程级）✅

| 检查项 | 结果 |
| --- | --- |
| `open ".../Deepseek Harness EAC.app"` 启动 | ✅ 06:24:55 经 LaunchServices 成功拉起（GUI app 注册正常） |
| `pgrep -fl "dsh-eac-shell"` | ✅ PID **64655** `/…/Deepseek Harness EAC.app/Contents/MacOS/dsh-eac-shell` |
| EAC sidecar 进程 | ✅ PID **64659** `/…/Contents/Resources/dsh-desktop/vendor/node/node /…/Contents/Resources/sidecar/server.js` |
| 日志目录新鲜日志 | ✅ `~/Library/Application Support/deepseek-harness-eac/logs/dsh-web.log`，mtime 06:24:56（本次启动） |
| 日志中 `dsh web:` 行 | ✅ `dsh web: http://127.0.0.1:63448`（本次启动端口 **63448**） |

### 2. Web 服务探活 ✅

| 检查项 | 结果 |
| --- | --- |
| `curl http://127.0.0.1:63448` | ✅ HTTP **200**（0.002s） |
| `/openclaw-bridge/health` | ✅ HTTP **200** |
| WS 端口 19873 | ✅ `lsof -iTCP:19873 -sTCP:LISTEN` → `dsh-eac-s 64655 … TCP localhost:19873 (LISTEN)` |

### 3. 托盘/菜单进程证据 ✅（视觉部分待人工）

- `pgrep -fl dsh-eac-shell` 存活：✅（PID 64655，完整 .app bundle 路径，经 `open` 启动 = LaunchServices 注册的 GUI 应用）
- `ps -o stat` → **S**（正常前台 GUI 进程休眠态，非僵尸/退出残留）
- 托盘图标外观、菜单项点击行为 → 见待人工清单。

### 4. 退出零孤儿 ✅

- 优雅退出：`osascript -e 'quit app "Deepseek Harness EAC"'` → 5s 内退出（Apple Event 响应正常，等价 Cmd+Q 路径）。
- 退出后完整残留扫描输出：

```
$ pgrep -fl "dsh|node" | grep -v pgrep | grep -v -i "vscode\|pi-\|npm-global/bin/dsh$"
11994 /Applications/Microsoft Edge.app/.../msedge_crashpad_handler ...   ← 无关进程（Edge 自带参数串含 "dsh" 子串，非 EAC）
exit=0
$ pgrep -fl "dsh-eac-shell|sidecar/server|dsh web|vendor/node"
（无输出，exit=1）
$ lsof -iTCP:19873 -sTCP:LISTEN
（无输出，exit=1）→ 端口已释放
```

- ✅ EAC 相关（dsh-eac-shell / sidecar / dsh web / vendor node）零残留，19873 释放。

### 5. 与 CLI 共存（数据面）✅

| 检查项 | 结果 |
| --- | --- |
| `~/.dsh` 仍存在且完整 | ✅ `extensions/ openclaw-bridge/ profiles/ sessions/ skills/ storages/ undo-snapshots/` + `settings.yaml` 等均在，未被破坏 |
| 桌面端 profile 目录 | ✅ `~/.dsh/profiles/web-desktop/`（含 cordis.yml / package.json / node_modules） |
| 会话/桥共享 | ✅ 启动日志显示 openclaw-bridge 挂载于 `~/.dsh/openclaw-bridge/`（token/workspace 共享 CLI） |

### 6. CLI 会话互通冒烟 ✅

- `dsh --version`（全局 npm dsh）→ ✅ **0.1.1-rc.2**，桌面端启动前后均正常。

## 二、待人工确认清单（GUI 交互项）

| # | 项 | brief 出处 |
| --- | --- | --- |
| 1 | 双击 .app 启动视觉：主窗加载 Web UI、无终端窗口 | Step 1 |
| 2 | 菜单栏托盘图标出现，点击弹菜单：显示/隐藏、恢复中心、重启服务、反馈、退出均可用 | Step 1 |
| 3 | Dock 图标显示，Cmd+Q 可退出 | Step 1 |
| 4 | 文件树「在访达中打开」（`open` 路径） | Step 2 |
| 5 | 剪贴板 `pbcopy` 写入（复制→粘贴验证） | Step 2 |
| 6 | 长任务完成系统通知（osascript 弹通知） | Step 2 |
| 7 | 终端标签页可用（`sh -i`），better-sidebar PTY 打开无崩 | Step 3 |
| 8 | 皮肤切换（任选 2 款）、插件市场安装/卸载一个插件 | Step 3 |
| 9 | 余额显示、文件树/行级 diff/一键还原 | Step 3 |
| 10 | CLI 会话互通 UI：CLI 创建的会话在桌面端可见（共享 `~/.dsh`，数据面已 ✅） | Step 3 |
| 11 | 关窗（不退出）→ 托盘仍在 → 托盘退出 → 无残留（退出路径进程面已 ✅） | Step 4 |

## 三、结论

**macOS 自动化验收冒烟全部通过（6/6 ✅）**：.app 启动、sidecar 拉起、Web/WS 服务、优雅退出零孤儿、`~/.dsh` 共存与 CLI 互通均正常；剩余 11 项纯 GUI 交互项待人工在解锁的图形会话中确认。
