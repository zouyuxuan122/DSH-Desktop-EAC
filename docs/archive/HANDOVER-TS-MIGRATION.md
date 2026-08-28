# DeepSeek Harness EAC（dsh-desktop）项目交接文档
## —— 全景进展与 TypeScript 化战略

> 生成日期：2026-08-22
> 性质：项目全景交接。承接并扩展 [HANDOVER.md](HANDOVER.md)（后者专注壳层重构 T0–T6 的模型间交接，本文不重复其施工细节，只引用结论）。
> 数据背书：文中所有数字均来自本机源码实测、`git log` 与测试基线，未经验证的推测一律标注「待验证」。

---

## 0. 一页速览（TL;DR）

| 项 | 现状 |
| --- | --- |
| 项目定位 | DeepSeek Harness Desktop（dsh-desktop）：官方 `@deepseek-ai/dsh` 内核的 Windows / Linux 桌面客户端，EAC = Embracing All Creation（揽尽万象） |
| 仓库 | `https://github.com/zouyuxuan122/Deepseek-Harness-EAC` |
| 本机代码根 | `D:\DeepSeek Harness\dsh max\dsh_desktop\dsh-desktop`（下称 `<root>`） |
| 当前版本 | v4.6.0 已发布；`next`（统一插件市场三源合一）已合入 main |
| 测试基线 | 73 个测试文件 / 608 用例全绿（`npm test`，约 60s） |
| 代码规模 | 自有 JS：294 个文件 / 约 123,900 行；**TS：仅 2 个 `.d.ts`**（dsh-pet 类型定义） |
| 壳层重构 | T0 ✅ / T1-a·b·c ✅（main.js 5268 → 3101 行，-41%）/ T2 Tauri PoC ✅ / T3–T6 ⏳ |
| **战略方向** | **以 TypeScript 替换壳层与服务层的绝大部分 JavaScript，同时「万物皆插件」体系零改动、零妥协（详见 §3）** |

---

## 1. 项目是什么

把官方 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`，官方内核 TS 占比 97.1%，"一切皆插件"的 agent harness）封装为**开箱即用的桌面客户端**：

- **免装 Node**：内置独立 Node 运行时 + npm CLI，双击即启动 `dsh web`，加载进原生窗口
- **桌面体验**：无边框玻璃栏窗口、系统托盘常驻、任务完成系统通知、便携版
- **拥抱万象**：10 款内置 Web UI 皮肤、38 个内置配套插件、插件市场、插件保护中心、崩溃救援、AI 主动修复
- **内核零改动**：完整保留官方「一切皆插件」架构，与原生 CLI 共享 `DSH_HOME`（会话 / API Key 直接互通）

### 三层架构（ADR 0002，重构的总纲）

```
┌─ L1 桌面集成层（可替换：Electron ↔ Tauri/Rust）
│    窗口 / 托盘 / 通知 / 对话框 / .lnk / 单实例锁 / IPC 通道
├─ L2 业务服务层（壳无关）→ 未来 = Tauri 架构下的 Node sidecar
│    进程编排 / profile 园艺 / 插件治理 / 更新器 / 救援 / 余额 / 会话监听
└─ L3 内核（绝对不动区）
     @deepseek-ai/dsh + Cordis 插件树 + Web UI
```

---

## 2. 项目进展全景（截至 2026-08-22）

### 2.1 版本演进史

```
0.1.0 基础壳
 → 0.2.0 伴侣插件体系 + 自更新 + 会话工具链
 → 1.0.0 品牌升级 EAC + 10 款皮肤 + 快速配置 + 插件市场 + 稳定性自愈
 → 2.0.0 社区插件市场 + 视觉/记忆/人设全家桶 + 重启窗口期排队任务 + 插件原样分发
 → 3.0.0 升级链路根治 + 崩溃自恢复/看门狗 + 右侧边栏 + 上游预设全家桶
 → 3.1.0 插件保护中心 + 原生 CLI 共存根治 + 字体自定义 + 自动压缩 + 人设卡库
 → 4.0.0 四大用户反馈根治 + SHA-256 更新校验 + 微信 ClawBot 桥 + 多窗口
         + AI 变更审核 + 崩溃急救 undo + 大肥鱼桌宠 + 插件启停管理
 → 4.2.0–4.4.1 更新链路加固（安装版更新挂死 / pnpm 拦截 / 代理缓存 / 4 目录备份回滚
         + 结构化日志 PII 脱敏 + patch 行保护）
 → 4.5.0 崩溃救援模式（日志/快照/安全模式/AI 诊断修复）+ 内置识图更换为 picturereader
 → 4.6.0 AI 主动修复一键全自动（诊断→AI 分析→自动修复→自动重启）+ 日志流时序根治
 → next  统一插件市场 dsh-unified-market（webui/zat/npm 三源合一，已合入 main）
```

完整变更记录见 [CHANGELOG.md](../dsh-desktop/CHANGELOG.md)。

### 2.2 已交付能力清单

- **开箱即用**：内置 Node 运行时与 dsh CLI、一键启动、桌面专属 `web-desktop` profile（与原生 CLI 完全共存）、便携版
- **桌面体验**：风格化无边框窗口 + 托盘、退出零孤儿进程、快捷方式自动维护、会话完成系统通知
- **插件生态治理**：插件保护中心（快照/体检/修复/回滚/事故报告）、统一插件市场（试装验证 + 冲突预检 + 安装前快照 + 更新面板 + 自动更新三档）、内置插件更新接管
- **稳定性**：崩溃救援 + AI 主动修复、profile 模块遮蔽自愈、会话编码自愈、renderer-recovery、看门狗
- **效率工具**：余额小部件、文件更改追踪 + 一键还原、会话内终端、自动压缩、人设卡库、soul.md 热重载、临时会话、对话导航条、picturereader 识图、微信 ClawBot 桥
- **外观**：10 款内置皮肤（互斥切换）、字体/字号/颜色自定义

### 2.3 进行中：壳层重构（T0–T6）

目标与完整施工图见 [HANDOVER.md](HANDOVER.md) 与 [ADR 0002](adr/0002-shell-boundary-and-layering.md)。当前状态：

| 阶段 | 内容 | 状态 | 提交 |
| --- | --- | --- | --- |
| T0 | 壳层边界 ADR + 三层架构声明 | ✅ | `d3bf62d` |
| T1-a | L2 基础设施（proc / runtime-paths / profile / file-roots） | ✅ | `d3bf62d` |
| T1-b | L2 园艺层（guard-box / runtime-patches / companion-sync / plugin-ops / market） | ✅ | `d3bf62d` |
| T1-c | L2 维护层（shortcuts / junction-patrol / client-update / static-preview） | ✅ | `670e99b` |
| T2 | Tauri ShellHost PoC（Rust + Tauri 2.11.5 + stdio JSON-RPC 桥 + sidecar） | ✅ | `6c7329b` |
| T3 | 前端桥迁移（chrome.ts + bridge.ts，`window.dshDesktop` 逐字节保真） | ⏳ 下一步 | — |
| T4 | 打包发布链（tauri.conf NSIS + 便携版，node/dsh 挂 resources） | ⏳ | — |
| T5 | 回归矩阵（皮肤/浮窗/终端/救援/更新器/中文路径…） | ⏳ | — |
| T6 | Linux 决策门（WebKitGTK；不过则 Windows=Tauri、Linux=Electron 双轨） | ⏳ | — |

**关键量化进展**：

- `main.js`：**5268 → 3101 行（-41%）**（670e99b 时点 3076 行；工作区含少量未提交修改）
- `lib/desktop/`：**13 个模块，共约 2268 行**，全部「自 main.js 原样迁出、行为零变更」：
  `companion-sync`(637) / `shortcuts`(329) / `market`(328) / `plugin-ops`(241) / `client-update`(207) / `proc`(111) / `static-preview`(111) / `profile`(82) / `junction-patrol`(80) / `file-roots`(45) / `runtime-paths`(41) / `runtime-patches`(36) / `guard-box`(20)
- `tauri-shell/`：Rust 工程可编译、窗口+托盘+sidecar 冒烟通过、桥 3/3（ping / shell.info / dsh.probe）、无孤儿进程

### 2.4 质量基线

- `npm test`：**608 用例全绿**（重构前后均保持，这是「纯移动」的硬证据）
- 契约测试：约 11 个测试对源码做文本断言（模块路径、patch 行、打包清单比对），改代码必须同步
- 真实验证：CDP 驱动（`--remote-debugging-port=9337`）——真实启动、36+ 插件与 10 皮肤全量同步、真实对话全链路、UI 退出路径 `cleanExit:true` 零孤儿进程（详见 HANDOVER.md §6）

### 2.5 工作区状态（git）

- HEAD：`6c7329b feat: T2 Tauri ShellHost PoC`
- **未提交修改**（接手者注意先甄别再处置）：`main.js` + `lib/desktop/` 下 6 个文件（client-update / companion-sync / junction-patrol / runtime-paths / shortcuts / static-preview）
- 处置建议：`npm test` 确认全绿后按 conventional commit 收口，再开新工作

---

## 3. 战略决心：TypeScript 全面替换 JavaScript

### 3.1 决心声明

> **本项目下一阶段的核心工程方向，是把壳层与服务层（L1 + L2）中绝大部分 JavaScript 替换为 TypeScript。**
> 这是既定战略，不是可选项。同时有一条不可逾越的红线：
> **「万物皆插件」理念与全部插件契约不受任何影响** —— 插件生态的运行语义、注册方式、配置格式保持逐字节兼容。
> 类型化的是**我们自己的代码**，不动的是**整个插件世界**。

### 3.2 现状量化（为什么要做）

| 指标 | 数值 |
| --- | --- |
| 自有 JS/MJS/CJS 文件 | 294 个 / 约 123,900 行（不含 node_modules / vendor / dist / target） |
| 其中 `<root>` 根目录服务模块 | 28 个（updater / client-updater / plugin-guard / rescue-agent / watchdog / session-watcher / logger …） |
| `lib/desktop/` L2 模块 | 13 个 / 约 2,268 行 |
| TypeScript 文件 | **仅 2 个 `.d.ts`**（dsh-pet 的类型声明） |
| 官方内核 | TS 97.1%（npm 包为编译产物） |

**现状 = 类型安全的洼地**：内核已是 TS，而壳层 12 万行 JS 与之交互全靠约定俗成。

### 3.3 动机（全部来自本项目真实事故）

1. **依赖注入漏配**（HANDOVER.md §7.2）：`ctx.getXxx` 被调用但 init 未注入 → 运行时 TypeError，测试测不出、只有真实启动暴露。TS 的接口类型可在**编译期**消灭整类事故。
2. **契约漂移**：约 11 个契约测试靠正则断言源码文本维持约定。TS 化后，模块导出、桥协议（`window.dshDesktop`）、插件注入契约可用**类型定义 + 编译检查**双重锁定。
3. **重构可验证**：T1 系列靠 608 测试兜底做「纯移动」；TS 化让后续每次重构多一层静态证明，降低对文本断言的依赖。
4. **与内核同构**：上游内核 TS 97.1%，壳层跟进后全链路（内核 ↔ sidecar ↔ 壳 ↔ 前端桥）类型贯通，`@deepseek-ai/*` 的官方 `.d.ts` 可直接消费。
5. **AI 协作友好**：类型即文档，接手模型无需通读 12 万行即可安全修改。

### 3.4 红线：「万物皆插件」守护协议（零妥协清单）

以下契约在 TS 化全过程中**语义逐字节不变**，只允许「加类型」，不允许「改行为」：

| # | 守护对象 | 说明 |
| --- | --- | --- |
| 1 | `@deepseek-ai/*` 包内容 | 官方内核与官方插件，绝对不动区 |
| 2 | `cordis.yml` / `cordis.patch.yml` 语义 | 插件注册与 patch 行格式、读写顺序、幂等行为 |
| 3 | host 端插件契约 | `{name, inject, apply}` 三段式 |
| 4 | client 端插件契约 | `dsh.client{inject, platform}` + `window.__ModuleLoader__.load({id, factory})` |
| 5 | 皮肤注册 | `ui-skin-*` patch 行、互斥切换行为 |
| 6 | skills 目录式注册 | 目录即技能，无清单文件要求 |
| 7 | `DSH_HOME` 目录布局 | 与原生 CLI 共享的既定布局 |
| 8 | `/plugins` 路由与市场协议 | unified-market 的 host 路由、目录快照格式 |
| 9 | 38 个内置插件与第三方插件包本体 | **只提供 `.d.ts` 类型支持，不重写其实现**；其 `package.json`、`cordis.patch.yml`、lib 结构保持原样 |

**判定标准**：TS 化完成后，任一现有社区插件（含 dsh.plugin.json 声明式插件）不做任何修改，装进新版桌面端行为与旧版完全一致。

### 3.5 明确不在 TS 化范围

- 官方内核 `@deepseek-ai/*`（上游已是 TS，npm 包为产物）
- 第三方社区插件包本体（assets/plugins 中非自研部分）——只补类型，不改实现
- 纯静态资源（皮肤 CSS/HTML、桌宠素材、加载页）
- **`main.js`（冻结的 Electron 回退链，2026-08-24 vnext-absorb 决策登记豁免）**：R8 红线已冻结、
  不再进入 Tauri 发布产物（stage-resources ROOT_FILES 已剔除），转换是纯风险无发布收益；
  `electron .` 开发回退继续跑手写 main.js。豁免条件：任何触碰 main.js 的改动需另行评审。

---

## 4. TS 迁移路线图（四波推进，每波独立可验收）

> **2026-08-22 第三轮执行进度（更新②）**：Wave 0 ✅ / **Wave 1 ✅ 6 模块** / **Wave 2 完成 12/13**
> （`6a8577f` junction-patrol·static-preview·client-update·shortcuts·plugin-ops·market；`f5aa181``4cc8072`
> 产物索引/gitignore 清理）。仅剩 **companion-sync.js（660 行）** 未转——万物皆插件数据载体，
> 三个契约测试逐字断言其文本：companion-plugins-registry / dsh-compact-integration(L11) /
> better-sidebar-bundle(L78) / patch-row-heal(L144)。转换硬约束：
> ① `const COMPANION_PLUGINS = [` 与 `const PLUGIN_UPDATE_SOURCES = {` 两锚点及行内
> `{ id: 'compact', name: 'dsh-compact', dir: 'dsh-compact' }` 单行格式逐字节保留；
> ② RETIRED_BUILTIN_PLUGINS 含 `id: 'plugin-marketplace'`；
> ③ 四测试读取路径同步改 .ts。
> sidecar 实体化 ✅（`7a54496`）；CDP 真实启动 9/9。updater 加固 `8385aef`。
> 内核决议：**保留 0.1.0-rc.7**。
> 下一步顺序：companion-sync 收官 Wave 2 → P2 Rust 回环 WS 桥（main.rs 改指 server.js 弃 ping.js、
> tauri-plugin-single-instance/notification/dialog、浮窗 per-webview data_directory PoC）。

> **2026-08-24 vnext-absorb 执行进度（更新③，见 HANDOVER-R9）**：Wave 2 ✅ 收官（companion-sync
> 已 .ts，且 plugin-copy 收编至 lib/plugin-copy.ts）；**Wave 3 ✅**（根模块 logger/updater/
> client-updater/plugin-guard/plugin-updater/rescue-agent/renderer-recovery 等全部 .ts）；
> **Wave 4 ✅ 活层**（sidecar server.ts 本就 .ts、ping.js 已转、发布链 6 脚本 .ts、preload.ts）；
> **测试套件 ✅**（77×.mjs → .ts，Node 24 type-stripping 直跑，test-runner 默认 test/*.test.ts）。
> tsconfig 追加 noUncheckedIndexedAccess/exactOptionalPropertyTypes/noImplicitOverride（保留
> commonjs + import-equals 直译，刻意不启 erasableSyntaxOnly——测试 import 编译产物无需
> type-stripping）。main.js 冻结不转（登记豁免，见 §3.5）。在此基础上落地插件隔离体系
> （ADR 0003：L2 sidecar 为 Supervisor）+ Rust 原生双模块 + 恢复中心（Tauri 窗口），
> 653/653 测试全绿。总验收剩余：随机社区插件回归抽样 + 打包体积/冷启动无劣化（Phase 5）。

> 原则：**渐进式、每波全绿、行为零变更**。复用 T1「纯移动」的验证体系（608 测试 + CDP 真实启动），在其上叠加 `tsc --noEmit` 类型门禁。

### Wave 0 · 工具链铺垫（先行，一次性）✅ 已落地（2026-08-22）

- [x] `<root>/tsconfig.json`：`strict` 全开、`module: commonjs`、`noEmitOnError`；`allowJs` 保持关闭——未转换的 .js 是手写事实源，绝不允许被编译器触碰
- [x] **构建策略 = tsc 直出·产物就地**：源码 `.ts` 是唯一事实源，tsc 把同名 `.js` 就地产出并 gitignore。收益：require 路径 / `electron-builder.yml` 精确清单 / `bundled-files.test.mjs` / 测试 import **全部零改动**；代价：运行时与测试前需先 `npm run build`（已挂 `pretest`）
- [x] 打包清单联动：**无需改动**（产物文件名与原手写一致）——规避 v3.0.0 事故面
- [x] 测试链路：`pretest → build → node --test`，CI 无需新步骤
- [x] 契约测试读取路径：跟随转换切到 `.ts` 源码（语义不变）
- [x] **工具链版本备忘**：TypeScript **7.0.2**（原生编译器）。注意：`moduleResolution: "node10"` 已被移除——CJS 项目直接省略该选项即可解析；`@types/node` 锁 24.x 与运行时对齐

**Wave 0 确立的代码风格约定**：

| 主题 | 约定 |
| --- | --- |
| 导入 stdlib | `import path = require('node:path')`（CJS 直译，emit 与手写 require 逐行一致，无 importStar 样板） |
| 消费未类型化 JS 模块 | `const { x } = require('../../mod') as { x: (…) => … }`（窄签名断言 + 注释标注收编波次），其源模块转正后换具名 import |
| 注入 ctx 类型 | 每个模块导出自己的 `XxxCtx` 接口；`let ctx!: XxxCtx` + `init(d)` 惰性注入（保持原错误时机语义） |
| 产物纪律 | 生成 .js 一律 gitignore（逐文件追加条目，禁止通配符——防误伤未转换的手写 JS） |

### Wave 1 · L2 基础设施（小模块热身，~254 行）

`proc` / `runtime-paths` / `file-roots` / `profile` / `guard-box` → `.ts`
产出：`DesktopCtx` 注入接口类型（消灭 §3.3-1 事故类）、`APP_ROOT` 等路径语义类型化。
验收：608 全绿 + 真实启动 + `tsc --noEmit` 零错误。

### Wave 2 · L2 业务服务（主战场，~2,014 行）

`companion-sync` / `market` / `plugin-ops` / `shortcuts` / `junction-patrol` / `client-update` / `static-preview` / `runtime-patches` → `.ts`
重点：**插件注册表、patch 行手术、市场排队任务的数据结构全部类型化**（`PluginRow` / `MarketOp` / `PatchLine` 等）——这是「万物皆插件」的数据载体，类型即契约文档。
验收：同 Wave 1，另需契约测试（companion-plugins-registry / retired-market-migration / patch-row-heal 等）全绿。

### Wave 3 · 根目录服务模块（28 个，按风险升序）

低风险先行：`logger` / `error-detail` / `stable-port` / `bundle-integrity` → 中风险：`session-watcher` / `balance` / `watchdog` / `preset-sync` / `patch-row-heal` → 高风险压轴：`updater` / `client-updater` / `plugin-guard` / `rescue-agent`（这三个是事故高发区，收益最大）。
每迁移一个：608+ 全绿 + 对应契约测试同步 + 真实启动。

### Wave 4 · main.js 残余胶水 + sidecar + 前端桥

- main.js 剩余 L1 胶水（窗口/托盘/IPC/boot 编排）→ `main.ts`
- `tauri-shell/sidecar/*.js` → `.ts`（T3 的 `bridge.ts` 本就是 TS 起点，类型在此会师）
- 可选收尾：自研内置插件（dsh-compact / dsh-balance / dsh-easy-setup 等自有 lib）TS 化——**仍不改其对外契约**

### 总验收（北极星指标）

1. 自有代码 TS 占比 ≥ 90%（文件数与行数双口径），仅剩个别胶水豁免并登记原因
2. `tsc --noEmit` 纳入 CI 必过门禁
3. 608+ 用例全绿贯穿每一波
4. **插件兼容性回归**：随机抽取 ≥10 个社区市场插件 + 全部 38 个内置插件，安装/启停/卸载/更新行为与 JS 时代一致
5. 打包体积与冷启动耗时无劣化（±5% 内）

---

## 5. 必读约定与踩坑教训（继承自上一份交接，仍然有效）

以下为 HANDOVER.md §4/§7 的浓缩，**TS 化过程中同样适用**：

1. **APP_ROOT 语义**：凡「应用根/assets/...」必须用 `runtime-paths` 的 `APP_ROOT`，`__dirname` 在不同目录指向不同位置（测试测不出，只有真实启动会崩）
2. **打包清单联动**：新增/改名模块必须同步 `electron-builder.yml` 精确文件名 + `bundled-files.test.mjs`
3. **契约测试是文本断言**：动代码前先 Grep 找出所有读该文件的测试（约 11 个）
4. **同一文件编辑必须串行**，改完跑 `node scripts/check-syntax.js` + 一次真实启动
5. **行号漂移**：用 Grep 锚点定位，别信手记行号
6. **依赖注入漏配只有启动能暴露**：每完成一个模块立即真实启动一次

**TS 化新增注意**：

7. CJS/ESM 边界：`lib/desktop/*` 与根模块是 CJS（`require`），测试是 `.mjs`——TS 输出必须维持该边界，避免把 CJS 模块误编译为 ESM
8. Electron API 在模块内直接 require（纯移动阶段允许）——TS 化时顺势改为 `DesktopCtx` 注入接口，为 T3/Tauri 替换铺路，但**每波只改一类事**（先类型化，后注入化，不混波）

---

## 6. 给接手者的启动指令（可直接粘贴）

```
背景：DeepSeek Harness EAC（dsh-desktop）双主线并行：
  A. 壳层重构 T3（前端桥迁移，见 docs/HANDOVER.md §3.1 起点提示）
  B. TypeScript 化战略（见 docs/HANDOVER-TS-MIGRATION.md §4 路线图）
必读：docs/adr/0002-shell-boundary-and-layering.md、docs/HANDOVER.md、docs/HANDOVER-TS-MIGRATION.md
当前：main.js 3101 行，lib/desktop/ 13 模块 2268 行，Tauri PoC 已提交（6c7329b），
      工作区有未提交修改（main.js + 6 个 lib 文件）——先 npm test 验证并收口提交。
任务（按序）：
  1) 收口工作区未提交修改（conventional commit）
  2) Wave 0 工具链铺垫：tsconfig + 构建产物策略 + electron-builder/契约测试/CI 联动
  3) Wave 1：lib/desktop 五个基础模块 → .ts，产出 DesktopCtx 接口
  4) 每波验收：npm test 全绿 + node scripts/check-syntax.js + 真实启动 CDP 验证 + tsc --noEmit
红线：不碰 @deepseek-ai/* 包、不改 cordis.patch.yml 语义、不改插件契约
     （{name,inject,apply} / dsh.client / __ModuleLoader__.load / ui-skin-* / skills 目录注册）、
     不动 assets/ 第三方插件包实现、万物皆插件体系零改动。
```

---

## 7. 附录

### 7.1 环境速查

| 项 | 值 |
| --- | --- |
| Node / npm | v24.11.1 / 11.6.2 |
| Rust | 1.98.0（Tauri 2 可用） |
| 测试 | `npm test`（608 用例，约 60s） |
| 语法检查 | `node scripts/check-syntax.js` |
| 开发启动 | `npx electron .`（`DSH_DESKTOP_DEBUG=1` 看日志） |
| 真实验证 | `--remote-debugging-port=9337` + CDP |
| 打包 | `npm run fetch-runtime && npm run dist` |

### 7.2 文档索引

| 文档 | 内容 |
| --- | --- |
| [HANDOVER.md](HANDOVER.md) | 壳层重构 T0–T6 施工图、模块模板、踩坑教训、验证体系 |
| [ADR 0001](adr/0001-logger-library.md) | 日志库选型（pino） |
| [ADR 0002](adr/0002-shell-boundary-and-layering.md) | 壳层边界与三层架构 |
| [CHANGELOG.md](../dsh-desktop/CHANGELOG.md) | 完整版本变更史 |
| [README.md](../dsh-desktop/README.md) | 用户视角功能总览与构建指南 |

### 7.3 关键数字备忘

- main.js：5268 → **3101 行**（-41%，目标 <2000）
- lib/desktop：**13 模块 / 2268 行**
- 自有 JS：**294 文件 / ~123,900 行** → TS 目标占比 ≥90%
- 测试：**73 文件 / 608 用例**（全绿基线）
- 生态：**38 内置插件 + 10 皮肤**，统一市场三源合一
