# DeepSeek Harness EAC 壳层重构 — 交接文档（模型切换）

> 生成日期：2026-08-22（同日更新：T1-c 与 T2 已完成，见文末「进度更新」）
> 上一执行模型交接给下一执行模型。目标：让接手者**无需重新调研**即可继续执行后续阶段。
> 一切结论均有源码/测试/运行记录背书，未经验证的猜测一律标注「待验证」。

---

## ⚡ 进度更新（2026-08-22 第二轮执行）

| 阶段 | 状态 | 提交 |
| --- | --- | --- |
| T0 ADR | ✅ | d3bf62d |
| T1-a 基础设施 | ✅ | d3bf62d |
| T1-b 园艺层 | ✅ | d3bf62d |
| **T1-c 维护层** | ✅ shortcuts/junction-patrol/client-update/static-preview 四模块迁出，main.js **3076 行**（累计 -42%），608 测试全绿 + 真实启动/UI 退出验证通过 | 670e99b |
| **T2 Tauri PoC** | ✅ `tauri-shell/` 工程（Rust + Tauri 2.11.5），cargo build 一次通过；stdio JSON-RPC 桥 3/3（ping / shell.info / dsh.probe——sidecar 用与 Electron 共用的 vendor node 定位到内核 CLI）；窗口+托盘冒烟通过、无孤儿进程 | 本轮提交 |
| T3 前端桥迁移 | ⏳ 下一步 | |
| T4 打包链 | ⏳ | |
| T5 回归矩阵 | ⏳ | |
| T6 Linux 决策门 | ⏳ | |

**T3 起点提示**：`tauri-shell/src/main.rs` 已实现 `--bridge-test`（无 GUI 桥验证）与 GUI 模式
（窗口 + 托盘 + sidecar 常驻 + RunEvent::Exit 回收）。`sidecar/ping.js` 是 L2 协议样例。
下一步是把 `lib/desktop/*` 挂进 sidecar（替代 ping.js）、实现 `window.dshDesktop` 的
`bridge.ts` 初始化脚本（经回环 WS 或 Tauri remote capability 转发 invoke）。

---

## 0. 一句话背景

社区建议把 EAC 壳层迁到 Tauri+Rust+TS。经调研结论：**Tauri 能做，但前提是把 main.js 里
约 60% 的「Node 业务逻辑」剥离成壳无关模块（未来作 Node sidecar 主体），Rust 只重写
桌面集成层**。内核（@deepseek-ai/dsh）与「万物皆插件」体系零改动。

- 官方内核仓库：`https://github.com/deepseek-ai/deepseek-harness`（TS 97.1%，npm 包仅为编译产物）
- 本项目仓库：`https://github.com/zouyuxuan122/Deepseek-Harness-EAC`
- 本机代码根：`D:\DeepSeek Harness\dsh max\dsh_desktop\dsh-desktop`（下称 `<root>`）

---

## 1. 原始计划（T0–T6 完整路线图）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **T0** | 壳层边界 ADR + 三层架构声明 | ✅ 完成 |
| **T1** | main.js 纯移动拆分 → `lib/desktop/*`（行为零变更） | 🔶 进行中（a/b 完成，c 未做） |
| T2 | Rust ShellHost PoC（Tauri 骨架 + 窗口/托盘/通知/对话框 + stdio 桥） | ⏳ 未开始 |
| T3 | 前端桥迁移：chrome.ts + bridge.ts（`window.dshDesktop` 逐字节保真） | ⏳ 未开始 |
| T4 | 打包发布链：tauri.conf（NSIS + 便携版）、node/dsh 挂 resources、release 双轨 | ⏳ 未开始 |
| T5 | 回归矩阵：皮肤/浮窗/终端/图片粘贴/救援/更新器/便携版/中文路径 | ⏳ 未开始 |
| T6 | Linux 决策门：WebKitGTK 兼容；不过则 Windows=Tauri、Linux=Electron 双轨 | ⏳ 未开始 |

**T1 的三个子阶段**（这是当前主线）：
- **T1-a 基础设施**（✅ 完成）：`proc.js` / `runtime-paths.js` / `profile.js` / `file-roots.js`
- **T1-b 园艺层**（✅ 完成）：`guard-box.js` / `runtime-patches.js` / `companion-sync.js` / `plugin-ops.js` / `market.js`
- **T1-c 维护层**（⏳ 剩余）：快捷方式维护 / profile 迁移 / junction 巡检 / 客户端自更新 / 静态服务 / boot 链收尾

**T1-c 完成后**，main.js 应只剩 L1 胶水（窗口/托盘/IPC/生命周期）+ boot 编排，预期 <2000 行。

---

## 2. 已完成工作（精确到文件）

### 2.1 三层架构（ADR）

[docs/adr/0002-shell-boundary-and-layering.md](file:///d:/DeepSeek%20Harness/dsh%20max/dsh_desktop/docs/adr/0002-shell-boundary-and-layering.md)

```
┌─ L1 桌面集成层（可替换：Electron ↔ Tauri）
│    窗口 / 托盘 / 通知 / 对话框 / 剪贴板 / .lnk / 单实例锁 / IPC 通道
├─ L2 业务服务层（壳无关，T1 迁移目标）→ 未来 = Node sidecar
│    进程编排 / profile 园艺 / 插件治理 / 更新器 / 救援 / 余额 / 会话监听
└─ L3 内核（绝对不动区）
     @deepseek-ai/dsh + Cordis 插件树 + Web UI
```

**万物皆插件守护协议（永不触碰）**：
`@deepseek-ai/*` 包内容、`cordis.yml`/`cordis.patch.yml` 语义、host 端 `{name,inject,apply}`、
client 端 `dsh.client{inject,platform}` + `window.__ModuleLoader__.load({id,factory})`、
皮肤 `ui-skin-*` 行、skills 目录式注册、`DSH_HOME` 布局、`/plugins` 路由。

### 2.2 模块清单（`<root>/lib/desktop/`，共 9 个模块 1537 行）

| 模块 | 行数 | 导出（节选） | 说明 |
| --- | --- | --- | --- |
| `companion-sync.js` | 638 | `COMPANION_PLUGINS`, `PLUGIN_UPDATE_SOURCES`, `SKINS_DIR`, `RETIRED_BUILTIN_PLUGINS`, `copyPluginPackage`, `syncCompanionPlugins`, `removedPluginIds`… | **最大模块，sidecar 心脏**：插件注册表 + 同步 + patch 手术 |
| `market.js` | 328 | `processPendingMarketOps`, `allowBuilds`, `restoreKeptArtifacts`, `syncBundledSkills`, `getMarketOpChild/setMarketOpChild`… | 市场排队任务 + artifact-keep + skills |
| `plugin-ops.js` | 241 | `pluginManagerCollect/SetEnabled/SetRemoved`, `imagePasteSave`… | 插件启停/移除/图片粘贴 |
| `proc.js` | 111 | `killTree`, `killTreeAndWait`, `childEnv`, `waitForProcExit` | 子进程回收（taskkill 两段式）+ 环境构造 |
| `profile.js` | 82 | `DESKTOP_PROFILE='web-desktop'`, `desktopProfile()`, `ensureDesktopProfileInit()` | 桌面专属 profile |
| `runtime-paths.js` | 36 | `APP_ROOT`, `nodeExe`, `npmCli`, `updCtx`, `dshBin`, `dshVersion` | 内置 Node/npm/dsh 定位 |
| `runtime-patches.js` | 36 | `runtimePatchRoots`, `applySessionManageFix` | 会话删除补丁重放 |
| `file-roots.js` | 45 | `fileRoots`, `isUnderFileRoots`, `DANGEROUS_EXT` | 路径围栏 |
| `guard-box.js` | 20 | `ensureGuard()` | plugin-guard 延迟单例入口 |

### 2.3 main.js 变化

- 5268 行 → **3693 行**（-30%）
- 顶层导入区新增 L2 require + **依赖注入 init 块**（见 §4.1）
- 删除了原 `ensureGuard`/`childEnv`/`waitForProcExit`/`COMPANION_PLUGINS` 等内联实现
- `before-quit` 中的 marketOpChild 改用 `marketMod.getMarketOpChild()`

### 2.4 测试改动（4 个契约测试指向新模块 + 打包清单）

- [electron-builder.yml](file:///d:/DeepSeek%20Harness/dsh%20max/dsh_desktop/dsh-desktop/electron-builder.yml) files 清单新增 9 个 `lib/desktop/*.js`（bundled-files 测试做精确比对）
- `test/companion-plugins-registry.test.mjs` / `better-sidebar-bundle.test.mjs` / `dsh-compact-integration.test.mjs` / `retired-market-migration.test.mjs` / `patch-row-heal.test.mjs` → 改读 `lib/desktop/companion-sync.js` 或 `plugin-ops.js`
- **测试总数保持 608，重构前后全绿**

---

## 3. 剩余工作施工图

### 3.1 T1-c（维护层，main.js 剩余可迁块，按行号）

> 行号基准 = 当前 main.js（3693 行）。迁移方法完全复用 T1-b 模式（见 §4）。

| 目标模块 | 源块（main.js 行号） | 关键自由变量与解法 |
| --- | --- | --- |
| **`lib/desktop/shortcuts.js`** | `SHORTCUT_ICON_VERSION`(2990) → `applyLegacySkinChoice`(3303) 之前 | `userDataDir→ctx.getUserDataDir()`；`updater→require('../../updater')`；`updCtx→runtime-paths`；`dialog/shell(showItemInFolder)→electron`（迁移到真正 Tauri 时再换 `LinkDriver`）。导出 `maintainShortcuts`, `migrateFromSharedWebProfile`, `applyLegacySkinChoice` |
| **`lib/desktop/junction-patrol.js`** | `startJunctionWatchdog`(3305) → `detectExternalDsh`(3374) | `IS_WIN`, `shell`(仅 Windows 用), `Notification`, `serverProc→ctx.getServerProc()`（注入 getter）。导出 `startJunctionWatchdog`, `detectExternalDsh` |
| **`lib/desktop/client-update.js`** | `runClientUpdateFlow`(3375) → `offerPendingClientUpdate`(3586) | `clientUpdater→require('../../client-updater')`；`app.relaunch/exit→ctx.relaunchApp()`（main.js 注入）；`dialog→electron`。导出 `runClientUpdateFlow`, `offerPendingClientUpdate` |
| **`lib/desktop/static-preview.js`** | `startPreviewStaticServer`(3587) → `verifyBundledModules`(3684) | 纯 `http`/`fs`，几乎零耦合。导出 `startPreviewStaticServer`, `verifyBundledModules` |
| **boot 链** | `computeOnboardingNeed`(3685) + `boot()`(3695~) | **建议保留在 main.js**（它是 L1 编排胶水，调用方大量是 L1 函数）。只把纯逻辑 `computeOnboardingNeed` 迁出即可 |

**T1-c 验收标准**：main.js <2000 行；`npm test` 608 全绿；真实启动一次 + UI 退出一次
（复用 §6 的 CDP 验证法）。

### 3.2 T2（Tauri Rust ShellHost PoC，本机 Rust 1.98 已就绪）

**目标**：在 `<root>/../tauri-shell/`（或 `src-tauri/` 同级新目录）建一个可编译的 Tauri 2 工程，
只实现 L1 接口，通过 **stdio JSON-RPC** 驱动现有 L2 模块（Node sidecar）。

**必须预研的 5 个硬点**（上一轮已确认，均有落地方案）：
1. **远程 origin IPC 桥**：webview 加载 `http://127.0.0.1:<动态端口>`。主方案 = Rust 起固定端口回环 WS 桥，`bridge.ts` 经它转发调用+推送；辅方案 = tauri capability 声明 `http://127.0.0.1:*` remote。
2. **浮窗 localStorage 隔离**：Electron `persist:dsh-float` partition → wry Windows 支持 per-webview `data_directory`。
3. **renderer-recovery**：WebView2 ProcessFailed 暴露粗 → 保留 5s 心跳协议，Rust 侧超时后销毁重建 webview + 导航到本地 `assets/recovery.html`。
4. **.lnk 读写**：`lnk` crate 读 + windows-rs IShellLink COM 写，封装成 `LinkDriver`；[shortcut-maintenance.js](file:///d:/DeepSeek%20Harness/dsh%20max/dsh_desktop/dsh-desktop/shortcut-maintenance.js) 决策逻辑留 sidecar。
5. **客户端自更新替换自身**：整段留在 sidecar（client-updater.js 53KB），最后「重启」改调 Rust relaunch。

**T2 验收**：`cargo build` 通过；窗口能起；Node sidecar 能 spawn dsh web；桥的 ping/pong 通；
进程树退出无残留。**不做** UI 皮肤/浮窗/更新器完整迁移（那是 T3–T5）。

---

## 4. 关键约定（接手者必读）

### 4.1 模块模式（T1-b 建立的标准模板）

```js
'use strict';
// 职责注释（标注「自 main.js 原样迁出，ADR 0002 L2 业务服务层」）
const path = require('node:path');
const { APP_ROOT } = require('./runtime-paths'); // 应用根目录语义一律用 APP_ROOT
let ctx = {};
function init(d) { ctx = d; }
function someFunc() {
  ctx.log('tag', 'msg');                 // log 一律 ctx.log
  const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
}
module.exports = { init, someFunc };
```

**依赖注入规则**：
- main.js 顶部统一 require + `xxxMod.init({...getter})` 注入（单一事实源仍在 main.js 的 `let dshHome` 等）。
- 跨模块引用走 require（如 `plugin-ops` require `companion-sync` 的 `copyPluginPackage`）；
  **循环依赖**通过「共享状态上移」打破（见 §4.2）。
- Electron API（`app/BrowserWindow/Notification/dialog/shell`）当前直接在模块内 require ——
  **纯移动阶段允许**，到 T2 换 Tauri 时再统一替换为注入接口。

### 4.2 已解决的循环依赖（重要先例）

`syncCompanionPlugins ↔ plugin-ops` 原本互相引用。解法：
- `removedPluginIds/saveRemovedPluginIds` 上移到 `companion-sync.js` 导出，`plugin-ops` 从那里 require。
- `ensureGuard` 独立成 `guard-box.js`（原 main.js 的内联单例 → 模块单例）。
- `runtimePatchRoots/applySessionManageFix` 独立成 `runtime-patches.js`。
- `market.js` 的可变共享状态 `marketOpChild` 用模块级 `let` + `get/setMarketOpChild()`，
  main.js 的 before-quit 改 `marketMod.getMarketOpChild()`。

### 4.3 运行时路径语义

- 应用根：`APP_ROOT = path.resolve(__dirname,'..','..')`（来自 runtime-paths.js）。
- `__dirname` 在 main.js 与 lib/desktop 里指向不同目录——**凡「应用根/assets/...」必须用 APP_ROOT**，
  否则 `syncCompanionPlugins` 找不到插件目录（真实启动时会崩，测试测不出）。

### 4.4 打包清单联动（v3.0.0 事故防呆）

`test/bundled-files.test.mjs` 会**静态比对** main.js 顶层 `require('./x')` 与
`electron-builder.yml` 的 files 清单。新增模块必须同时：
1. main.js 顶层 require；
2. electron-builder.yml 加**精确文件名**（不支持通配符）；
3. 跑该测试确认 `missing=[]`。

### 4.5 契约测试（文本断言，改代码必查）

以下测试对源码做正则断言，**代码搬家必须同步更新读取路径，语义不变**：
`better-sidebar-bundle`（ensureDesktopProfileInit + COMPANION_PLUGINS）、
`companion-plugins-registry`、`retired-market-migration`、`dsh-compact-integration`、
`patch-row-heal`（soul-md 行 config + heal）、`context-menu`/`rescue-integration`/`recovery-integration`
（尚在 main.js 查，T1-c 动到相关函数时注意）。

---

## 5. 验证体系

### 5.1 单元测试
```powershell
cd "<root>"
npm test          # node --test test/*.test.mjs → 基线 608 pass / 0 fail，约 60s
```

### 5.2 真实验证（CDP 驱动，脚本已删，重建方法在 §6）
流程：启动带 `--remote-debugging-port=9337` → 轮询 `http://127.0.0.1:9337/json/list` 找 dsh web 页面 →
`Runtime.evaluate` 断言桥/标题栏/UI → 可选注入对话 → 截图 → UI 退出路径验证。

---

## 6. 上一轮真实验证记录（已全部通过）

| 验证项 | 结果 |
| --- | --- |
| 单元/契约测试 | 重构前后均 608/608 |
| 真实启动 | 托盘就绪、退役插件清理、补丁重放、**36 插件 + 10 皮肤全部同步** |
| 图标/标题栏 | 玻璃栏 36px、4 按钮、应用图标加载成功、徽章 v4.6.0 |
| 插件体系 | `window.dshDesktop` 桥完整、unified-market host 路由 200、桌宠/侧边栏/余额小部件在线 |
| 真实对话 | 消息注入→发送→DeepSeek API→响应渲染全链路通（当时模型回 400 = 免费模型 provider 端不可用，非壳层问题） |
| 退出清理 | UI 退出路径：run-state.json `cleanExit:true`、零孤儿 node.exe、electron 全退 |

**验证脚本模式（重建参考）**：`ws` + `http` 到 `:9337/json/list`，`Page.captureScreenshot` 截图，
`Runtime.evaluate` 断言（注意 `returnByValue` 结果取 `.value`）。
退出触发：`window.dshDesktop.menu.action('quit')`。

---

## 7. 踩坑教训（别重复踩）

1. **并行编辑竞态**：对同一文件的两个 Edit/Write 可能后者覆盖前者（曾致 market.js 漏改，
   `ctx.getAppRoot` 残留、启动即崩）。→ 同一文件编辑必须**串行**；改完跑 `node scripts/check-syntax.js` + 一次真实启动。
2. **依赖注入漏配**：`ctx.getXxx` 调用了但 init 没注入 getter → 运行时 TypeError（测试测不出，只有启动暴露）。
   加完模块跑一次启动是最快校验。
3. **行号漂移**：每删一段，后续行号全变。用 Grep 锚点定位，别信手记行号。
4. **CRLF/LF**：main.js 是 CRLF，用 Node 脚本拼接（`split('\n')`）后写回会变 LF，git 会警告但不破坏。
   项目 git 已配置换行转换，`git add` 后按仓库规范处理即可。
5. **契约测试是文本断言**：先 `Grep` 找出所有读 main.js 的测试（约 11 个），再动对应的代码。
6. **删除导入前先确认用途**：曾误删仍在用的 `pluginUpdater/logger/balance/rescueAgent` 导入，立即恢复。

---

## 8. 工作区当前状态

```bash
# git status（工作区 = 上次完成态，未提交）
M  electron-builder.yml
M  main.js                                  # 5268 → 3693 行
M  test/better-sidebar-bundle.test.mjs
M  test/companion-plugins-registry.test.mjs
M  test/dsh-compact-integration.test.mjs
M  test/patch-row-heal.test.mjs
M  test/retired-market-migration.test.mjs
?? docs/adr/0002-shell-boundary-and-layering.md   # 在 <root>/../docs/ 即 dsh_desktop/docs/
?? lib/                                          # lib/desktop/ 9 模块，1537 行
```
- 最近上游提交：`5642cba fix: 补回 dsh-settings-groups 内置注册行…`
- **未提交**（上一模型未 commit，因用户未要求；本次用户要求「生成最终提交」——若需提交请按 §9 提交策略）

---

## 9. 给接手模型的启动指令（建议直接粘贴）

```
背景：继续 DSH EAC 壳层重构（T1-c + T2）。
必读：<root>/../docs/adr/0002-shell-boundary-and-layering.md 与 <root>/../docs/HANDOVER.md。
当前：main.js 3693 行，lib/desktop/ 9 模块已就位，测试 608 全绿。
任务：
1) T1-c：按交接 §3.1 迁移 shortcuts/junction/client-update/static-preview 四块到 lib/desktop/*；
   同步更新契约测试与 electron-builder.yml；main.js 目标 <2000 行；npm test 608 全绿。
2) T2：建 Tauri 2 工程（Rust 1.98 就绪），实现 §3.2 的 L1 ShellHost + stdio JSON-RPC 桥；
   cargo build 通过 + 窗口能起 + 能 spawn dsh web。
3) 每步后：npm test + 真实启动验证（见交接 §6 的 CDP 法，DSH_HOME 指向临时目录避免污染用户数据）。
4) 最后生成 commit（conventional：feat/refactor + scope，参考 git log 风格）。
红线：不碰 @deepseek-ai/* 包、不改 cordis.patch.yml 语义、不改插件契约、不动 assets/ 插件。
```

---

## 10. 环境与命令速查

| 项 | 值 |
| --- | --- |
| Node / npm | v24.11.1 / 11.6.2 |
| Rust | 1.98.0（Tauri 2 可用） |
| 测试 | `npm test`（608，~60s） |
| 语法检查 | `node scripts/check-syntax.js` |
| 开发启动 | `npx electron .`（DSH_DESKTOP_DEBUG=1 看日志） |
| 真实验证 | `--remote-debugging-port=9337` + CDP（§6） |
| 打包 | `npm run fetch-runtime && npm run dist`（耗时较长，T4 前不必跑） |
| 数据目录 | 开发用真实 `~/.dsh`（验证时建议 DSH_HOME 指向临时副本） |
