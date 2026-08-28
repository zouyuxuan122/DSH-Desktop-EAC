# Changelog — Deepseek Harness EAC（揽尽万象 · Embracing All Creation）

DeepSeek Harness（dsh）的 Windows 桌面客户端：内置独立 Node 运行时与 dsh CLI，
一键启动 Web UI。
版本路径：0.1.0（基础壳）→ 0.2.0（伴侣插件体系 + 自更新 + 会话工具链）→
1.0.0（品牌升级 EAC + 界面皮肤 + 快速配置 + 插件市场 + 稳定性自愈）→
2.0.0（社区插件市场 + 视觉/记忆/人设插件全家桶 + 重启窗口期排队任务 + 插件原样分发）→
3.0.0（升级链路根治 + 崩溃自恢复/看门狗 + 右侧边栏 + 上游预设全家桶）→
3.1.0（插件保护中心 + 原生 CLI 共存根治 + 字体自定义 + 自动压缩 + 人设卡库）→
4.0.0（四大用户反馈问题根治 + SHA-256 更新校验 + 微信 ClawBot 桥 + 多窗口
+ 会话删除 + AI 变更审核 + 崩溃急救 undo + 大肥鱼桌宠 + 插件启停管理）→
4.1.0（群友建议落地 + 更新保障加固 + 女仆皮肤遮挡修复）→
4.2.0（安装版更新挂死 + 插件市场/守护启动的 pnpm 拦截 + 插件互相
影响治理 + 内置接管同名市场包）→
4.3.0（本版：内置插件更新 + 插件市场「更新」标签 + 市场插件更新）→
4.4.0（本版：修复设置页「Skills 与 MCP → 打开目录」失效 + 安装版更新
4 目录备份/回滚 + 结构化日志 + 插件自写 patch 行保护）→
4.6.0（本版：AI 主动修复 —— 救援页一键自动诊断、自动执行修复、自动重启）→
next（统一插件市场：以 dsh-unified-market 取代 webui-market / zat-market /
旧 npm 市场三源合一 —— 精选目录 + GitHub dsh-plugin 生态 + npm 检索；
EAC 特化（web-desktop profile 归一化）；试装验证 + 冲突预检 + 安装前快照 +
allowBuilds 放行；已下载插件更新面板 + 一键全部/逐个更新 + 自动更新三档 +
更新进度窗口；Windows 文件锁排队与「服务启动早期」自动消费（含修复主进程
排队消费对 update 类任务遗漏）；本地链接（link:/file:）插件从上游接管更新
（junction EPERM 处理 + 失败回滚）；24h 发布保护期过滤；市场自身经官方
内置插件更新自更新）→
5.0.0（本版：桌面壳切换 Tauri —— Rust L1 壳 + Node sidecar L2 + dsh 内核
零改动 L3 三层架构（ADR 0002）；安装包体积 241MB → 155MB；全功能桥
（窗口/托盘/浮窗隔离/退出策略/救援链/快捷方式维护）；自更新接线（客户端
整树交换 + agent 更新 + 自动检查定时器）；安装器自动接管旧 Electron 版；
新增 /update /about /wizard 壳页；便携版改 zip 分发；Electron 链路冻结
保留为可回退救生索）→
5.1.0（压缩频发修复：截断不再强制 retain-0 全量压缩 + pressure 阈值 +
15s/代际冷却；better-sidebar 抽搐/hero 截断/模型菜单翻转修复）→
5.1.0 修复批次（内部代号 5.1.1，本版：窗口大小/位置记忆与副屏适配；临时会话「插件自带 Key」输入
修复；computer-use 批准问答卡 + /computer 幂等批准；400 瞬态自愈与压缩
误报护栏；移除内置「第三方模型思考强度」插件；手机连接桥（LAN 配对 +
白名单 RPC，手机端占位）；内置鲸鱼余额挂件与 AgentTeams（均默认关闭）。
版本号字段保持 5.1.0，不引 5.1.1 —— 与 R13 产物命名规则一致）→
next2（功能包体系：.dshpack 打包分发插件+预设+技能，声明官方内核兼容范围，
官方版本升级自动检出并一键迁移/回滚 —— 核心在 L2 功能包引擎 + CLI，
交互集成进 dsh-unified-market 插件；详见下方「功能包体系（Feature Pack）」批次）

## 文档：插件致谢补齐提供者并按首字母排序 · next

### README.md / README.en.md「插件致谢」

- 插件致谢表按插件名首字母重新排序（忽略 `@scope/` 前缀，与既有排列规则一致；
  `computer-user`、`picturereader` 归位，`web-mobile-fix` / `web-plugin-manager`
  顺序修正）。
- 补齐缺失的提供者标注（经 GitHub / npm 交叉核实）：
  - `@deepseek-ai/*` 12 款官方自带插件 → `deepseek-ai`；
  - `dsh-compact` → `zixin947`（PR #145 作者，GitHub 同名仓库描述一致）；
  - `dsh-session-manager` → `hkkz9522`（npm maintainer + GitHub 同名仓库）；
  - `dsh-undo-savepoint` → `lire1131`（npm maintainer，EAC 内置即其版本）；
  - `dsh-settings-scroll-fix` → `says693`（PR 提交者陆玖叁）；
  - `dsh-unified-market` / `picturereader` / `computer-user` / `dsh-file-drop-eac`
    → `jing-hy`（自研，GitHub 仓库归属一致）。
- 英文版致谢表补上此前缺失的 `computer-user` 条目，与中文版对齐。

## 功能包链路修复 + 任务栏图标 + 窗口尺寸 · next

### 打包装配：功能包 CLI 白名单补齐（tauri-shell/stage-resources.mjs）

- 修复功能包体系随包分发缺失：#237 新增的 `scripts/feature-pack-cli.js` 与
  `lib/desktop/feature-pack.js` 未加入 stage 脚本的 `LIB_DESKTOP`/`SCRIPTS`
  人工白名单，导致打包产出的客户端缺失功能包 CLI，统一市场「📦 功能包」
  全部操作报「功能包 CLI 不可用（缺少 DSH_DESKTOP_RESOURCE_ROOT）」。
- 两文件补入白名单，并新增成对装配自检：CLI 与核心模块必须同时入包，
  缺一即 stage 直接失败（后续新增随包 CLI 照此成对补充）。

### Tauri 壳：Windows 任务栏图标修复（tauri-shell/src/main.rs + Cargo.toml）

- 根因分两层：① tao 注册的窗口 class 不带图标（`WNDCLASSEXW.hIcon` 为 NULL）；
  ② tao 区分 Small（`set_window_icon`，标题栏）与 Big（`set_taskbar_icon`，
  任务栏）两套图标 —— tauri 的 `set_icon` 只映射 Small 且未暴露 Big API，
  动态创建的无框窗口两套均空，任务栏显示空白默认图（白色文件图标）。
- 修复：新增 `apply_taskbar_icon_big` —— 经 `hwnd()` 从 exe 内嵌资源加载
  tauri-build 以 ID 32512 嵌入的 bundle .ico（`LoadImageW`），`WM_SETICON`
  同时补 Big（任务栏）与 Small（标题栏）；Small 仍由 `default_window_icon`
  （tauri `set_icon`）负责。主窗 / 会话浮窗 / 恢复中心 / died 页四处窗口
  统一接入；失败仅打印告警，不阻塞窗口创建。
- 依赖：新增 `windows-sys 0.61`（仅 Windows 目标；版本对齐依赖树既有条目，
  复用不新增编译单元）。

### Tauri 壳：主窗默认尺寸自适应 + 坏状态防御（tauri-shell/src/main.rs）

- 首启默认（无 `window-state.json`）：改为 work area（去双边距）的 80%，
  收敛到 [1200×800, 1920×1080] 逻辑区间 —— 1080p 及以上屏幕首启即约八成
  宽高；`DSH_WINDOW_W/H` 显式覆盖保留。
- 坏状态防御（重装后窗口很小的根因）：恢复历史状态时尺寸 < 600×400（逻辑）
  判为旧版本异常残留，直接丢弃走首启默认并打印告警，不再每次启动都恢复成
  小窗；正常拖小（≥ 下限）的窗口记忆不受影响。

### 设置弹窗宽度自适应 + 可拖拽拉伸（scripts/patch-deps.ts）

- 上游设置弹窗 panel 固定 `width:800px`，大屏主窗里右侧内容拥挤且无法调整。
- 新增 `patchSettingsPanelResize`：panel 宽度改 `min(75vw,1280px)` 跟随主窗
  视口宽伸缩；`overflow:hidden` 放开为 `auto` 并加 `resize:horizontal` +
  `min-width:640px`，可拖右下角手柄手动调宽。panel 为 flex 容器（左栏固定
  188px、内容区 `flex:1` 自适应），宽度变化后内容自然跟随；子树自带滚动
  约束，panel 自身不产生滚动条。
- 幂等标记 `dsh-desktop-panel-resize`；类名哈希用捕获组匹配兼容上游小版本。

### 内置插件：dsh-unified-market 0.3.0 → 0.3.1

- 同步上游 0.3.1（npm `dsh-unified-market@0.3.1`）：功能包 CLI 定位失败区分
  「桌面壳未注入 `DSH_DESKTOP_RESOURCE_ROOT`」与「CLI 文件不存在（客户端安装
  不完整或版本过旧）」两种原因，给出可行动提示（升级 / 重装桌面客户端），
  修复 0.3.0 及之前统一误报"缺少 DSH_DESKTOP_RESOURCE_ROOT"导致用户在桌面端
  却被提示去桌面端的排障误导。
## 5.2.0（本版：手机控制整体替换为喵丝滑 + 文档级滚动根治）· 2026-08-28

### 手机控制整体替换：内置 dsh-meow-smooth（Phant0Meow，MIT），退役自研续聊客户端

- **内置「喵丝滑」插件 0.5.0**（assets/plugins/dsh-meow-smooth）：手机端 UI
  交互优化（输入框失焦折叠、手机回车=换行、侧边栏边缘手势、窄屏按钮收缩、
  禁意外缩放、表格触摸滚动、设置页手机适配）+ 通知系统（页面内提醒卡片 /
  Web Push / webhook 三级通道，审批/提问/长任务完成/回合失败提醒，多会话
  并行可感知）+ 审计投影只读路由（/plugins/meow-smooth/pending）。
- **web-push 运行时依赖随包供给**：加入应用闭包（package.json dependencies）
  与插件宿主依赖落位（ensurePluginHostDeps）；缺省时插件优雅降级为仅页面内
  提醒，绝不拖垮插件树。
- **mobile-app.html 自研续聊客户端退役**（sidecar 与 stage 清单同步移除）：
  手机端改为直接访问完整 DSH Web UI，喵丝滑负责移动端体验；设置页「连接手机」
  文案同步更新。

### 手机连接桥重写：完整 Web UI 反向代理（安全边界不变）

- **phone-bridge 5.2**：配对链路原样保留（一次性 token 5min TTL +
  timingSafeEqual、/api/pair-state 下发 HttpOnly+SameSite=Strict cookie、
  /desktop/decide|disconnect 仅回环）；批准后的一切路径透明代理到内核 Web
  服务——静态资源、/api/*、/plugins/*、WebSocket 升级全支持，手机获得与
  桌面一致的完整界面。
- **信任围栏零登记**：代理把 Host/Origin/Referer 改写为内核自身 origin，
  内核浏览器信任围栏看到的始终是同源流量，无需把动态 LAN 地址登记进
  trusted-host 白名单。
- **unary JSON gzip**：POST /api/* 的 JSON 响应按 Accept-Encoding 压缩
  （大会话历史 1-8MB 压缩 70-90%，蜂窝网络流畅）；SSE/WS/静态资源透传不缓冲。
- **停桥修复**：升级后的 WS socket 已脱离 http.Server 连接计数，
  close/closeAllConnections 均不覆盖——新增活跃 WS socket 对追踪，
  stop() 显式销毁（修复停桥后手机侧 WS 仍存活、close 回调永不触发）。
- **未配对门禁**：一切代理面 401 中文门页（指引回桌面端重新配对），
  不再暴露任何内容。

### 文档级滚动根治（老毛病：hero 输入卡裁切 + 横/纵双滚动条复发）

- **根因**：内核视口链 html,body,#root{height:100%} 干净，但 html/body 无
  overflow 钳制；hero 态 scrollBody 以 justify-content:center 居中内容，
  内容高于视口时溢出沿包含链漏到文档层 → 文档级滚动条 + flex 居中溢出
  上/下两端不可滚达。旧修复锚定 CSS Modules 哈希类（.wSkVaW_*）且只随
  桌面壳注入——内核前端更新换哈希即静默失效，浏览器/手机端完全裸奔。
- **根治 = 新内置插件 dsh-viewport-lock**（纯客户端 CSS，随内核页面加载，
  桌面/浏览器/手机三端同源生效）：① html/body overflow:hidden 文档级
  钳制（内核全部滚动面均为内部滚动容器，文档滚动条不是任何功能载体；
  print 媒体下还原）；② hero 居中兜底改锚稳定契约
  [data-phase="hero"] [data-conversation-scroll]（非哈希，永不失效），
  放得下居中、放不下从顶排布且滚动体自身可滚，输入卡永远可达。

### 验证

- `npm test` 全量 **724 用例：714 通过 / 0 失败 / 10 skip**（退役测试
  留档；新增/重写手机桥回路 7 用例：门禁 401、配对→cookie、Host/Origin
  改写、unary JSON gzip、WS 升级透传、503、回环 decide、lanAddress）。
- 真内核 + 真桥端到端 9 项全过（配对→cookie→完整页面→喵丝滑 /pending
  经代理→静态资源→gzip 解包出内核 server-response→WS 放行）。
- 客户端实机验证：390×720 手机视口下喵丝滑客户端生效（禁缩放 viewport、
  touch-action CSS 注入）、viewport-lock 生效（html overflow hidden、
  无文档溢出）、零控制台错误；桌面壳 13 场景扫描（隐藏侧边栏/长草稿/
  620-1006px 宽度扫描/模型菜单/active 会话/设置页）文档零溢出。

## 功能包体系（Feature Pack · 借鉴 HMCL 整合包架构）· next

### 功能包（.dshpack）：插件 + 预设 + 技能打包分发

- **新格式与规范**：`.dshpack`（zip）＝ `pack.json` 清单 + 可选 `payload/`
  （内嵌 preset/skills）+ `icon.png`；清单声明 `requires.dsh`（官方内核 semver
  兼容范围）、`plugins[]`（builtin:/github:/npm 声明式引用，安装时解析，不内嵌
  插件代码，来源可追溯）、`presets[]`、`skills[]`、`conflicts[]`。
  规范与 JSON Schema：`docs/feature-pack-spec.md`、`docs/schemas/feature-pack-pack.json`。
- **L2 核心引擎**（`lib/desktop/feature-pack.ts`，壳无关纯 Node）：
  清单解析/校验、`matchSemverRange`（支持 `^ ~ x 部分版本 || 空格 &&` 与
  预发布宽容——适配 `0.1.1-rc.x` 内核命名）、注册表
  （`DSH_HOME/feature-packs/registry.json`，原子写）、内核版本探测、
  安装/卸载/更新/导出/回滚编排（事务化：保护中心快照 → 装配 → 失败回滚；
  `dsh plugin` 前后复用 artifact-keep 保护第三方构建产物；preset/skills 沿用
  skip-if-exists，用户自建同名永不覆盖；卸载只拆本包登记物+引用计数）；
  启动兼容扫描：官方内核版本变化自动把失配包置 `incompatible`（幂等）。
- **功能包 CLI**（`scripts/feature-pack-cli.ts`）：
  `inspect/list/install/update/uninstall/export/rollback/scan/resume`；
  退出码 0/1/2/3/4/5（3=文件锁待排队、4=兼容失配、5=冲突阻断）；URL 安装 +
  `--sha256` 校验；撞文件锁自动写入 `feature-packs/.ops/pending.json`，
  sidecar 在无锁窗口（启动/重启前）经 `resume` 自动续跑。
- **市场插件集成**（`dsh-unified-market`，SELF_VERSION 0.2.1 → 0.3.0）：
  - host：`pack.list/inspect/install/uninstall/update/export/rollback/scan/market`
    方法（spawn CLI + 复用 op 串行/轮询/超时；`pack.market` 索引 live→缓存→
    内置 `data/packs-snapshot.json` 离线快照三级降级；上传文件 op 结束自动清理）；
  - client：设置页新增「📦 功能包」tab —— 已安装列表（版本/兼容徽标/更新/导出/
    卸载）、本地导入 `.dshpack`（文件选择→base64→安装）、功能包市场浏览一键安装、
    官方内核升级后不兼容包提示条 + 「迁移（选新版）」/「回滚（保护中心快照）」；
  - CLI 定位经 sidecar 注入的 `DSH_DESKTOP_RESOURCE_ROOT`（proc.ts childEnv）。
- **打包与验证**：`electron-builder` 清单补 `lib/desktop/feature-pack.js` 与
  `scripts/feature-pack-cli.js`；`unzipper` 移入 dependencies（CLI 运行时依赖）；
  新增 `test/feature-pack.test.ts`（14 项：semver 全分支/校验/注册表/装卸往返/
  用户保护/兼容扫描/导出/CLI）。

## 5.1.0 修复批次（内部代号 5.1.1）· 2026-08-27

### 窗口：最小尺寸下调 + 大小/位置记忆（副屏适配）

- 主窗最小尺寸 960×640 → **800×560**；首启尺寸按当前显示器工作区收敛
  （不再固定 1400×900，窄副屏不再显示不全）。
- 新增窗口状态持久化（`app_config_dir/window-state.json`）：关闭/移动/缩放
  自动保存（800ms 节流 + 退出兜底），重启恢复尺寸、位置与最大化状态；
  恢复时校验落在某显示器工作区内，越界自动 clamp（拼接屏拔插/分辨率变化
  不再把窗口甩出屏幕）。

### 临时会话：模式 2「插件自带 Key」输入修复

- 重写侧边临时会话设置卡的 API Key / 模型 / 基址输入：草稿本地化 + 编辑中
  快照回写不再覆盖正在输入的值；模式切换后字段按最新已存配置重新填充；
  Key 落盘（settings.yaml，role(secret) 不回显）后显示「已保存」占位，
  空串不再覆盖已存 Key；回车/失焦即存，卸载兜底写回。

### computer-use：批准问答卡 + 幂等批准

- 手动批准模式不再只抛错误：优先走官方「批准问答」（对话内弹出 允许/拒绝
  卡，host approval 服务 + 客户端 PendingApproval 卡），允许本次放行；
  拒绝/取消/服务不可用时给出一致提示并可回落 `/computer`。
- `/computer` 由「开关」改为**幂等批准**（重复发送不误撤销；`/computer 撤销`
  才撤销）——此前第二次输入会把第一次的批准悄悄撤掉，表现为「批准了但没
  生效」。

### 400 瞬态自愈 + 压缩误报护栏（dsh-compact）

- **溢出误报护栏**：供应商报 CONTEXT_WINDOW_EXCEEDED 但实测 tokens 远低于
  窗口一半时，判定为供应商侧误报——不压缩、不重试，原样保留 400 详情
  （此前免费服务商一次 400 就把整个会话历史无谓压掉）。
- **瞬态 400 自愈**：非溢出的 400（INVALID_REQUEST）且本会话此前已有成功
  回答时，自动原样重试一次（60s 内最多 2 次），自动复现「继续说一句才好」；
  设置页可关（`retryTransientBadRequest`，支持按模型覆盖）。
- 400 失败详情（供应商响应体摘要）写入 harness.log，不再「莫名其妙」。

### 移除内置「第三方模型思考强度」插件

- 按用户要求移除 `dsh-third-party-thinking`（reasoning_effort 控件）：
  目录删除 + COMPANION_PLUGINS 摘除 + onboarding 列表移除；存量 profile
  的 patch 行/包副本由 `RETIRED_BUILTIN_PLUGINS` 退役清理兜底。

### 手机连接桥（接口预留，手机端开发中）

- sidecar 新增 `phone-bridge`（Tauri 壳）：0.0.0.0 LAN HTTP，一次
  5min TTL 配对 token（timingSafeEqual）+ 桌面端批准（仅回环）+ 一年期
  `dsh_mobile` cookie（HttpOnly + SameSite=Strict）+ 白名单 RPC 转发
  （9 项会话/模型/工作区动作，`/api/rpc`）；手机访问显示「开发中」占位页
  （保留 PWA meta 与接入点）；断开即轮换 token 使手机端失效。
- 新增内置插件 `dsh-phone`：设置页「连接手机」——二维码（内置
  qrcode-generator）、配对状态、批准/拒绝/断开。
- 已分析上游 dsh-desktop「手机能力」本质：扫码配对 + 白名单 RPC 续聊桥，
  **非** scrcpy 类屏幕远控。

### 内置插件两枚（均默认关闭，用户自行开启）

- `dsh-whale-widget`（MeteorNOX/DeepSeek-Balance-Whale-Widget，MIT）：
  DeepSeek 余额小鲸鱼挂件（余额/今日已用/每轮消耗，右下角常驻）。
- `@nanmicoder/dsh-agent-teams`（MIT）：多智能体团队协作（队长/子代理/
  依赖任务 DAG/活动面板）。

### 验证

- `npm test` 全量 **724 用例 719 通过 0 失败**（新增压缩护栏、computer-use
  批准流、手机桥、注册表/契约测试 20+ 项）；Tauri 壳 `cargo check` 通过；
  stage-resources → tauri build → make-portable 打包链路复验。

## 5.1.0 修复批次 2（内部代号 5.1.2）· 2026-08-27

### 悬停浮层横向溢出（提示词优化面板 + 「/」命令菜单）根治

- **「自动优化提示词」面板由 absolute 改 fixed 定位**：旧版面板 `position:absolute`
  常驻挂载在 hero 输入区右侧，向上展开即把滚动容器撑出横向溢出——鼠标悬停/移出
  后整页出现横向滚动条、输入卡底部工具行被裁切，且面板常驻 DOM（仅隐身），移出
  后不恢复。新版改为 `position:fixed` + JS 按触发钮位置视口 clamp（全程随内容/
  窗口缩放重算），不参与任何祖先 overflow 计算，悬停与移出均不再产生滚动条。
- **桥内垫片补丁**（`bridge.ts` injectUiPatchCss）：hero 滚动体（`.wSkVaW_scrollBody`）
  与 `body` 的 x 轴溢出钉死为 `overflow-x:hidden`，覆盖内核「/」命令菜单等一切
  hero 态 absolute 浮层同类病灶（内核不可改，只能桥内兜底）。
- **同步修复已安装运行实例**：新插件文件（prompt-optimizer/client.js、dsh-phone、
  dsh-feature-toggles）+ sidecar 手机桥已复制进安装目录 assets 与 web-desktop
  profile 副本，重启应用即生效（桥内垫片需随新构建安装后生效）。

### 手机连接桥完整上线（原为「开发中」占位）

- **手机端续聊客户端**（`mobile-app.html`，随 sidecar 分发）：`/` 与 `/app` 由占位
  页切换为真实客户端——会话列表/历史消息/发送消息/切换模型/新建会话；扫码配对
  批准后自动进入。
- **forwardRpc 信封修复**：旧占位版把手机端 body 原样转内核（恒 400 隐藏 bug）；
  现改为主机 `client-request` 信封 → `server-response` 解包，白名单 RPC 全链路可用。
- **二维码白块根治**（dsh-phone 设置卡）：qrcode.js 加载失败不再静默留白——加载
  失败显示可见错误提示；渲染区在组件未就绪时显示「加载中」。配对链接改为展示
  **完整 URL（含 `?token=`）+ 「复制链接」按钮**（原实现剥掉 token 只显示 host，
  手敲出来必 403「配对链接无效」）。
- **LAN 地址选择优先 RFC1918 私网网段**（192.168/10./172.16-31）：不再无条件取
  第一个非回环网卡（此前常选中虚拟网卡 / APIPA 的 169.254.x，手机扫出来连不上）。

### 设置侧边栏新增「余额」「多智能体协作团队」独立分区

- `dsh-feature-toggles` 在「增强功能」之外再注册两个 `settings.section`：
  「余额」（余额小鲸鱼挂件开关 + 说明）、「多智能体协作团队」（AgentTeams 开关 +
  用法说明），复用同一开关卡与插件管理桥；两功能默认仍关闭，开启后重启生效。

### 验证

- `npm test` 全量 **736 用例 731 通过 0 失败**（新增手机桥 lanAddress 网段偏好
  用例等）；`ui-verify-smoke` 新增 D 组——hero 基线/hover 提示词优化/注入 320px
  绝对定位浮层/移出鼠标四时刻断言无横向溢出、输入卡完整可见；配对链路本机实测
  （`/pair?token=` 200 → 批准 → 手机页进入续聊客户端）；stage-resources → tauri
  build → make-portable 打包链路复验。

## 5.1.0 修复批次（内部代号 5.1.2，本版：主窗最小尺寸可配置化）· 2026-08-27

### 窗口：最小尺寸可配置化（默认降至 480×360）

- 主窗允许的最小逻辑尺寸由硬编码 800×560 改为 **480×360**（与浮窗下限一致），
  副屏/便携屏上可继续缩小到习惯尺寸（如 480×360）而不显示不全。
- 支持环境变量覆盖，无需改代码重新编译：
  - `DSH_WINDOW_MIN_W` / `DSH_WINDOW_MIN_H`：主窗最小逻辑尺寸；
  - `DSH_WINDOW_W` / `DSH_WINDOW_H`：无记忆首启时的默认逻辑尺寸（默认
    1400×900）。
  - 非法值（非数值 / ≤0 / 非有限）自动回退默认；所有数值按逻辑像素解释，
    100% 缩放下与像素一致。
- 配置/记忆得到的下限若超过目标显示器 work area（极窄屏），以 work area
  收敛为实际下限 —— 窗口始终能完整显示；恢复记忆时已保存的窄尺寸不再被
  OS 下限弹回放大（此前 800px 下限会让窄屏窗口强制回到 800 宽）。

## [5.0.0] · 2026-08-23

### 新增：设置面板滚轮修复插件

- 内置 `dsh-settings-scroll-fix`：按设置页语义与实际溢出尺寸识别滚动区，修复设置面板中鼠标滚轮失效；不依赖版本相关的 CSS Modules 哈希类名，并支持完整卸载清理。

### 桌面壳切换 Tauri（Rust），Electron 冻结保留

- **三层壳边界（ADR 0002）**：L1 Rust 壳（窗口/托盘/浮窗/退出策略/壳页路由）
  ↔ L2 Node sidecar（lib/desktop 全模块 + boot-server 服务编排 + 桥方法面）
  ↔ L3 dsh 内核零改动。安装包从 ~241MB 降至 ~155MB。
- **打包链路（P4）**：实测 Tauri v2 resources map 装出「exe 同级 sidecar/ +
  dsh-desktop/」布局并修正 `resource_root()` 解析；`stage-resources.mjs`
  装配运行树；`make-portable.mjs` 产出便携 zip（含 `.dsh-portable` 标记）。
- **自更新接线（硬门槛③）**：客户端更新 = zip 整树交换（便携）/ Setup /S
  （安装版），进度经壳层 `/update` 页实时展示；agent（dsh 内核）更新流移植
  sidecar；启动 60s 首检 + 12h 周期自动检查；`update-smoke.js` 端到端冒烟。
- **升级接管**：安装器自动检测旧 Electron 壳卸载键（productName 与
  identifier 双候选），静默卸载后接管安装；脏值防御（卸载器缺失只清键）。
- **壳页补全**：`/about`（关于）、`/wizard`（内置插件选择向导，serve 真实
  onboarding.html + 桥 shim）、`/update`（更新进度）；menu.action 收编
  check-client-update / check-agent-update / export-logs / about。
- **验证资产**：`gui-smoke.js` 18 项 GUI 冒烟（安装形态全绿）、
  `update-smoke.js` 10 项自更新冒烟、`npm test` 613 用例全绿。
- **Electron 冻结**：main.js / preload.js / electron-builder.yml 标注
  FROZEN，链路完整保留（`npx electron .` 可回退）；TS 迁移余量 7 个根模块
  随 Electron 链路一并冻结。

## [4.6.0] · 2026-08-20

### 修复：dsh web 重启时日志流重复写入（#137）
- 根因：子进程的 `exit` 事件可能早于 stdout/stderr 管道排空；旧实现收到
  `exit` 后立即 `end()` 日志文件，尾部 `data` 随后继续写入，触发
  `ERR_STREAM_WRITE_AFTER_END`，在受限端口换端口重启和应用退出时尤其容易复现。
- 修复：业务退出处理仍由 `exit` 驱动，但日志文件延后到 stdio 全部关闭后的
  `close` 事件再结束；新增统一 Writable 生命周期保护，同时覆盖
  `dsh-web.log` 与 `desktop.log`，迟到写入会被安全拒绝且保留关闭前尾部日志。
- 调试期间一并修复隔离 DSH_HOME 初始化时 `home` 未定义，以及 Windows
  CRLF/BOM 格式 `cordis.patch.yml` 无法清理退役插件的问题，保证重启后的新
  dsh web 实例可以完整启动。
- 验证：新增独立复现脚本 `scripts/debug-stream-write-after-end.js` 与流时序回归
  测试；强制受限端口重启后新实例正常就绪，完整测试 538 项全部通过。

### 新增：AI 主动修复（一键全自动）
- 救援页新增「AI 自动修复」按钮：一键串联 诊断 → AI 分析 → 自动执行修复 →
  自动重启 全链路，最多迭代两轮；高风险动作（回滚/卸载）自动跳过，多轮
  修复后仍无法启动则自动兜底（回滚最后良好快照 + 开启安全模式），过程
  逐轮展示在救援页。
- AI 可直接编辑白名单配置文件修复根因（`edit-file`）：仅限
  `settings.yaml` 与 profile 的 `package.json`、`pnpm-lock.yaml`、
  `pnpm-workspace.yaml`、`cordis.patch.yml`、`.dsh-builtin-plugins.json`，
  支持最小化行级编辑（replace-line / delete-line / insert-after）与整文件
  重建；写前快照备份、写后强制校验 YAML/JSON 可解析，非法内容绝不落盘。
- 新增 `resync` 动作：一键重装/修复 profile 模块树（内置插件树同步 +
  模块遮蔽清理）。
- 诊断上下文新增全局 `settings.yaml`（快照与规则体检都不覆盖的配置面，
  AI 主动修复的主要作战对象），纳入发送清单可选勾选。
- 验证：`test/rescue-auto-repair.test.mjs`（自动修复循环）、
  `test/rescue-agent.test.mjs`（编辑白名单/行级编辑/可解析校验）、
  `test/rescue-integration.test.mjs`（IPC/桥接/救援页接线）覆盖。

4.5.0（本版：崩溃救援模式 + 内置识图引擎更换为 picturereader）。

## [4.5.0] — 2026-08-20

### 新增：崩溃救援模式（日志/快照/安全模式/AI 诊断修复）
- 启动失败不再束手无策：自动收集诊断包（日志尾部 / 事故报告 / profile 快照 /
  插件清单），一键进入安全模式（禁用问题插件后再启动），并提供 AI 诊断修复
  建议；完整视图可逐项查看与修复，事故现场全程留痕。
- 验证：`test/rescue-agent.test.mjs`、`test/rescue-integration.test.mjs` 覆盖
  诊断收集、安全模式降级、修复链路与看门狗集成。

### 更换：内置识图引擎（dsh-tool-vision → picturereader）
- 原内置 `dsh-tool-vision` 由社区成熟插件 `picturereader` 接管（PR #105）：
  保留 `inspect_image` 工具语义，能力扩展为图片批量处理、文档转图、视觉问答，
  并提供独立的视觉模型设置入口。
- 配套测试：`tool-vision-stream-guard` 相应迁移至 picturereader 链路。

## [4.4.1] — 2026-08-20

### 修复：正式版客户端更新版本比较错误
- 修复 `4.4` 与 `4.4.0` 比较时因缺少版本段产生 `NaN`，导致已下载的同版本安装包重复提示安装。
- 版本比较现在会自动补齐缺少的版本段，并兼容带 `v` 前缀的版本号。

### 修复：客户端更新下载速度与桌面快捷方式
- GitHub Release 安装包优先通过 `gh.geekertao.top` 下载，代理失败后自动回退到 GitHub 原地址及其他备用源。
- 安装版与便携版统一维护桌面快捷方式，清理软件原样生成的重复项，同时保留用户自行改名、换图标或加参数的快捷方式。

### 修复：代理缓存导致客户端更新 SHA-256 校验失败
- 根因：`gh.geekertao.top` 加速代理会缓存旧的安装包文件（同名同大小、内容却是旧版），客户端下载后与当前 Release 的公布哈希不一致 → 强校验失败 → 删除安装包 → 更新报错。Release 本身正确，问题在代理缓存未及时刷新。
- 修复：客户端生成代理地址时附加**缓存破坏参数** `?v=<版本>&sha256=<期望哈希>`（版本号必带、哈希加强到内容级），代理缓存键随版本/哈希变化自动回源；期望哈希在下载前求一次，既喂给代理 URL 又复用做下载后强校验（不再重复请求 SHA256SUMS）。从此每次发版升级自动绕开旧缓存，无需再清代理缓存。

### 移除：内置插件 dsh-tdai-memory 退役（瘦身 + 消除崩溃隐患）
- 原因：它是唯一携带 node_modules 的内置插件（未压缩约 310MB，占安装包近半）；且 vendor 任一小缺失（如 `@tencentdb-agent-memory/tcvdb-text` 编译产物未入库）即 import 失败、拖垮整棵插件树，全新安装即「启动失败」。
- 处理：从内置清单/更新源/推荐清单移除，插件目录整树删除（安装包瘦身约 48MB）；新增退役清理逻辑，老用户 profile 残留的 patch 行/包副本/依赖项在启动时自动清除，杜绝「行在包被清」拖垮插件树。需要长期记忆的用户可自行从插件市场安装（非内置）。

### 修复：首次安装 dsh-pet 行重复 config 导致启动失败
- 根因：`healRowConfig` 自愈只判断 name 行后紧跟的一行，首次安装的向导/写入组合产生 `name → disabled → config` 形态时被误判「缺 config」补出第二份 config → YAML duplicated mapping key → dsh web 退出码 1。
- 修复：改为扫描整个条目块（块内任意位置已有 `config:` 即不再补），真缺才补一次；新增回归测试覆盖事故形态/正常形态/幂等。

## [4.4.0] — 2026-08-19

### 修复：会话目录同时存在 session.jsonl 与 session.jsonl.zstd 时启动失败（#77）
- 根因：会话持久化后端（`@deepseek-ai/dsh-session-persistence-jsonl`，
  `DEFAULT_COMPRESSION = "zstd"`）加载时 `listArtifacts()` → `checkRootEncoding()`
  发现某会话目录同时存在相反物理编码的文件（zstd 后端下的明文 `session.jsonl`）
  即抛 `encodingMismatch`，整棵插件树加载失败、`dsh web` 退出码 1，桌面端表现
  为「Web UI 未在预期时间内就绪」；这是数据层问题，plugin-guard 只看插件/配置
  层，陷入「体检 → 回滚 → 重试」的无效循环，救不回来。
- 修复：新增 `session-encoding-heal.js`，接入守护启动的 preRetry 钩子——启动
  确因该错误失败时，扫描 `<DSH_HOME>/sessions`，对两种编码并存的会话目录把
  相反格式（明文）文件改名归档为 `session.jsonl.bak-<时间戳>`（**数据无损、不
  删除**），保留后端在用的权威 zstd 日志后自动重试一次。只在命中该错误时触发，
  不做任何常态化会话目录写操作。
- 验证：`test/session-encoding-heal.test.mjs` 覆盖错误识别、并存归档、仅 zstd
  不动、目录缺失安全返回、多会话独立处理。

### 修复：设置页「Skills 与 MCP → 打开目录」在文件视图打不开
- 根因：`dsh:file-open` IPC 校验只放行会话工作区路径（`isUnderFileRoots`），
  而 Skills 根目录（`~/.dsh/skills`、`~/.agents/skills`）是全局目录、永远不在
  会话 cwd 里，点击「打开目录」必然报 "path outside session workspace"。
- 修复：校验中放行 Skills 根目录白名单 —— 严格限定为两个根本身及其子路径
  （白名单，非任意路径），危险扩展名检查（DANGEROUS_EXT）仍然生效；
  `DSH_AGENTS_HOME` 环境变量按原有约定支持。
- 验证：IPC 白名单回归（根目录/子路径放行、非白名单拒绝、危险扩展名拦截）
  + 设置页真实点击「打开目录」成功打开资源管理器。

### 新增：安装版更新前 4 目录备份 + 失败自动回滚（#79）
- 更新前把 userData / `~/.dsh` / web profile / 安装目录镜像备份到
  `<userData>\backups\<时间戳>\`，写 manifest.json（版本、路径、注册表
  InstallLocation 对比、回滚指引）；Setup 失败时自动反向恢复 4 目录并
  拉起旧版；成功后新版健康启动时询问是否清理备份（保留 24h）。
- 修复（集成实测）：manifest 生成用**应用自带 Node**（内联路径，不依赖
  PATH，用户机器普遍无系统 Node）；回滚状态判定移出批处理括号块
  （块内 %RBAD% 解析期展开恒为空，永远误报 partially failed）。

### 新增：结构化日志 + PII 三层脱敏 + 一键诊断包（#79）
- 主进程结构化日志（pino）：20MB 滚动；API key/邮箱/路径等敏感字段
  三层脱敏；设置页一键导出诊断 zip（日志 + 环境信息，已脱敏）。

### 修复：插件自写 patch 行不被误剥离 + 孤儿 insert 行清理
- 市场同名包残留迁移只在有「非应用自写」证据时执行（package.json 依赖/
  bundles/外来 patch 行），应用自己的启停行与 sync insert 行不再被
  「剥离-回写」空转，首次向导的取消勾选不再被静默重新启用。

### 修复：静默卸载不再误删用户数据
- customUnInstall 的「是否同时删除用户数据」确认框补 `/SD IDNO`：
  NSIS 静默模式（卸载 /S）下 MessageBox 自动应答第一按钮（IDYES），
  会径直删光 %APPDATA% 数据与 `~/.dsh` 对话记录；补齐后静默卸载与
  UI 默认一致 —— 保留数据。

## [4.3.0] — 2026-08-18

### 新增：内置插件可直接更新（「设置 → 插件 → 更新」）
- 背景：内置插件（assets/plugins）随应用分发、版本固定，不升级应用就拿不到
  上游修复；部分插件上游（npm / GitHub）持续发布新版本。
- 新增独立**「更新」标签页**（位于插件市场插件内）：聚合两类插件的上游
  更新 —— 内置插件（桌面主进程走 npm 镜像链 / GitHub API 检查上游最新版，
  区分 npm 源与 GitHub 源）与市场插件（npm registry 最新版），逐条显示
  `当前版本 → 最新版本` 并可单独更新或「全部更新」。
- 更新动作全在主进程完成：下载到 `node_modules` 外的**覆盖层**
  （`<用户目录>/builtin-plugin-updates/<插件名>`），以当前资产副本为底、
  npm 包覆盖其上（保留 EAC 附加文件），原子切换；应用升级后资产版本更新，
  覆盖层自动让位。
- 安全设计：更新源白名单（EAC 独占插件永不更新）；更新前保护中心快照
  （可一键回滚）；`engines.dsh` 门槛（新版本要求的内核高于当前 dsh 时拒绝，
  提示先更新内核）；npm 下载加 `--ignore-scripts`，绝不执行第三方安装脚本；
  单插件失败/未上架（404）优雅降级，绝不阻塞。
- 更新后重启 Web 服务生效（弹窗一键重启，无需重启应用）；服务运行中
  profile 写入失败时更新保留在覆盖层，下次启动自动同步。

### 新增：内置插件自动更新（默认关闭，仅提示）
- 默认行为：启动后静默检查（24 小时节流），发现更新只发**系统通知**
  （点击直达更新标签页），不自动下载 —— 尊重用户对插件变化的知情权。
- 在「更新」标签页可开启「内置插件自动更新」：之后发现更新自动下载到
  覆盖层，弹窗提示一键重启服务生效；可跳过某个版本（不再提示该版本）。
- 内置插件的手动更新不写 profile 依赖、不改变插件启停状态，干净回滚。

### 新增：市场插件支持更新（插件市场已安装列表）
- 插件市场（dsh-plugin-marketplace）已安装列表与搜索结果现在显示上游最新版
  与「可更新」标记，可一键更新到最新版（`npm install name@latest`，失败自动
  装回原版本回滚）；bundle/启用状态随包名保持不变，更新后重启服务生效。
- 已安装列表版本显示为 `v当前 → v最新`，更新按钮同时出现在「更新」标签页
  的市场插件分组里，可与内置插件一起「全部更新」。

## [4.2.0] — 2026-08-18

### 修复：安装插件报 `spawn ...\resources\node\node.exe ENOENT`
- 根因：插件市场目录条目不带目标 profile，客户端默认填 dsh CLI 生态的
  `web`；桌面壳实际跑在专属 profile（web-desktop），`profiles/web` 并不存在。
  安装时 spawn 以不存在的目录作 cwd，Windows 上 Node 把 ENOENT 记在可执行
  文件（node.exe）头上 —— 错误信息极具误导性，node.exe 本身完好。
- 修复：host 层统一把 `web` 映射到桌面 profile（`resolveProfile`，CLI 直连
  时映射恒等、行为不变），安装/卸载/扫描/已装状态/更新检查全部走真实
  profile；重启窗口期排队任务读取旧标记时同样归一化。此前有人用目录联接
  （`profiles\web` → `web-desktop`）绕过，修复后无需保留。

### 修复：安装版自更新时黑窗挂死
- 根因：installer.nsh 的进程存在性检查用 `tasklist | find` 管道 —— 每轮开
  3 个隐藏 cmd 经 `|` 串管道读输出，在无控制台的 NSIS 上下文里偶发永不
  返回，更新窗口永远等不到应用退出（黑窗卡住、关掉又弹新窗）。
- 修复：去掉 cmd 与管道 —— `nsExec::ExecToStack` 直接 CreateProcess 起
  `tasklist /FI "IMAGENAME eq ..." /FO CSV /NH`（不经 cmd.exe、无 `|`），
  按 CSV 输出首字符是否为 `"` 判断进程存在（与系统语言无关），检查
  「Deepseek Harness EAC / v2.0 / v1.0」三个 exe 名；等待循环有界
  （20 次 × 500ms），超时仍按「应用未退出」处理并放行提示，不再挂死。
  （曾尝试 electron-builder 自带 NSIS 的 nsProcess 插件，其自带 DLL 加载
  不了函数、编译即报 "Plugin function not found"，未采用。）

### 修复：插件安装与排队任务被 pnpm 的 allowBuilds 拦截失败
- 根因：新版 pnpm 默认封锁依赖的 postinstall 构建脚本（报
  `Ignored build scripts` / `ERR_PNPM_IGNORED_BUILDS`），插件安装、重启窗口期
  排队任务、守护启动重试因此批量失败。
- 修复：新增 allow-builds 处理器 —— 解析 pnpm 各类封锁报错格式，自动把缺失
  的包写入 profile 的 `pnpm-workspace.yaml`（allowBuilds/onlyBuiltDependencies
  块，行级编辑、幂等、防注入），安装/排队任务失败后自动重试一次；守护启动
  失败时同样先补 allowBuilds 再重试，成功记入恢复记录。

### 新增：插件安装前冲突预检
- 市场安装确认前自动扫描候选插件与当前 profile 的冲突：同名 patch 行、与
  内置插件同名、bundle 冲突（以上**阻止安装**）；依赖将被重装、设置命名空间
  重合、核心共享依赖（koffi/schemastery/js-yaml/zod/nanoid 等）被覆盖
  （以上**警告**）。扫描结果在确认弹窗逐条展示（✗ 红 / △ 黄），阻止项禁用
  安装按钮；勾选「跳过冲突预检」可强制安装。

### 新增：启动失败自动归因
- 启动失败弹窗现在会尝试把错误归因到具体插件（patch 行、bundle 或依赖）：
  命中时优先提供「停用插件 X 并重试」；有保护中心快照时提供「回滚到最后
  良好快照并重试」，回退到上一版本/内置版本等原路径保留。

### 新增：内置插件接管市场同名包（更新后插件树变化的通知）
- 内置插件树同步前自动清理 profile 里的市场版残留（package.json 依赖/bundles
  与 cordis.patch.yml 同名行），让内置版干净接管，杜绝 duplicate loader
  entry / 模块双实例；`link:`/`file:` 本地链接依赖保留不动（用户 fork/开发
  目录）。发生接管时保护中心先留快照，并弹系统通知告知本次启动的插件树整理。

## [4.1.0] — 2026-08-18

### 新增：错误日志一键复制（群友建议）
- 启动失败 / DSH 服务已停止的报错弹窗新增**「复制日志」**按钮：一键把
  `error-detail.js` 组装的诊断信息（错误消息、堆栈、日志目录、最近日志尾部）
  复制到剪贴板，反馈时直接粘贴即可。

### 新增：应用内反馈入口（群友建议）
- chrome 栏 ⋯ 菜单与托盘菜单新增「反馈建议…」，直达 GitHub Issues
  （`https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues`）；
  「关于」对话框附交流群号（1021296425）与反馈指引。

### 新增：拖文件进对话（群友建议，dsh-file-drop 配套插件）
- 对话区域拦截文件拖放（阻止浏览器打开文件）；文本/代码文件（常见文本扩展名
  与无扩展名）自动读取并注入输入框（上限 256KB，带文件名头注释）；图片注入
  路径提示配合 dsh-tool-vision 的 `inspect_image`；二进制/超大文件注入完整路径
  提示。纯客户端实现，设置页可随时关闭。

### 新增：设置页左侧边栏自定义（群友建议，dsh-settings-nav-custom 配套插件）
- 设置面板左侧导航底部「自定义边栏」按钮：浮层内按需显示/隐藏与上移/下移排序
  导航项（数据直接来自 slots 服务，第三方区段自动出现），localStorage 持久化
  （`eac:settings-nav:v1`），默认全显、零行为改变。

### 加固：更新保障四件套
- ① 更新前强制快照：官方 dsh 更新与客户端更新开始前调用 plugin-guard 快照，
  失败即中止更新（宁可不动，不可失去回滚点）。
- ② 官方 dsh 更新后旧版备份保留：切换成功后旧版保留为 `agent-previous`，直到
  下次启动确认新版健康（`confirmPreviousAgentHealthy`）才清理；新版启动失败时，
  失败对话框优先提供「回退到上一版本并重试」。
- ③ 客户端自更新崩溃自回退：便携版更新脚本成功替换后保留上一版 exe（`.bak`）
  与 marker；新版启动失败（上次运行非干净退出）时下次启动自动还原上一版、
  保留崩溃副本并弹系统通知；新版健康启动后自动清理备份。
- ④ 更新完成弹窗明示「插件、皮肤、会话与配置全部保留」。

### 修复：女仆皮肤设置按钮在窄侧边栏被帧图遮挡
- `assets/skins/maid-atelier`：narrow 档侧边栏未豁免 settings 触发器按钮，
  34px 边框帧 + 34px 内边距超出窄栏宽度，按钮内容被 `--maid-settings-frame-art`
  完全遮挡。补 narrow 豁免：去掉帧图边框，还原为完整可点的金框按钮
  （rail 档原有圆形按钮样式不受影响）。

## [4.0.0] — 2026-08-16

### 修复：退出后残留一对进程（用户实测三次三次成对残留）
- 根因：`before-quit` 里的 `killTree` 把强杀补刀挂在 1500ms 的 `setTimeout` 上，
  而 Electron 在 before-quit 后数百毫秒内就退出，定时器随主进程湮灭；无 `/F` 的
  taskkill 对控制台进程（node.exe 无顶层窗口，无处投递 WM_CLOSE）基本无效 ——
  dsh web 的 node.exe 连同它的 conhost.exe 每次退出都原样残留。
- 修复：新增 `killTreeAndWait`（优雅 taskkill → 有界等待 → `taskkill /T /F` → 再
  等待，全程有界）；`before-quit` 改为 `preventDefault` + 异步清理完成后
  `app.exit(0)`；客户端更新重启路径同样等待进程树死透；退出时强杀在跑的市场
  排队任务（pnpm 子进程）并回收全部会话浮窗。

### 修复：更换快捷方式图标后重启多出一个快捷方式
- 根因：存在性判断只认「桌面\Deepseek Harness EAC.lnk」精确文件名。用户换图标
  通常删旧 .lnk 自建新快捷方式（文件名几乎必然不同），下次启动判定「缺失」→
  再造一个标准名快捷方式 → 桌面出现两个；且图标版本分支会无条件 replace，把用户
  自定义图标静默还原成默认（「改一次→还原一次」循环）。
- 修复：按「.lnk 的 target 是否指向本应用 exe」识别既有快捷方式（任意文件名都
  算），桌面上已有指向本应用的 .lnk 就绝不重复新建；图标刷新只针对仍使用壳层
  自管 icon.ico 的快捷方式，用户自定义图标绝不覆盖；NSIS `createDesktopShortcut:
  always → true`（尊重安装向导勾选，升级不再无条件重建）；⋯ 菜单新增「桌面快捷
  方式自动维护」开关（`settings.shortcutPolicy: never` 时完全不碰桌面快捷方式）。

### 修复：更新/重装依赖清掉第三方插件的构建产物（meow-memory lib/ 蒸发）
- 根因：`dsh plugin` 是 pnpm 转发器，任何安装/卸载都按锁文件重新解包整棵 profile
  node_modules；meow-memory 这类 GitHub 插件 tarball 不含构建好的 lib/（pnpm v10
  还封锁未 allowBuilds 的构建脚本），人工补齐的 lib/ 每次重装必被清掉。
- 修复：新增 artifact-keep 机制（主进程与市场 host 共用一份实现）—— 桌面端触发
  pnpm 前快照第三方包到 `<DSH_HOME>/plugin-artifact-cache/<profile>/`，完成后把
  「磁盘上消失而快照里有」的文件补回（只补缺、绝不覆盖现存文件；包卸载清快照、
  版本升级放弃旧快照）；启动时兜底回填上次异常退出没回填的部分；配套插件与
  @deepseek-ai 官方闭包不进快照（壳层本就会重建）。

### 修复/优化：启动「60 秒超时」
- 就绪判定改为 stdout 就绪行与 HTTP 探测（期望端口）并行竞争 —— 就绪行被管道
  缓冲吞掉或格式变化时不再假超时；
- profile 首次引导（node_modules 缺失，dsh 要先跑 pnpm 装依赖）就绪上限放宽到
  180 秒，稳态维持 60 秒；
- koffi FFI 预检从 `spawnSync`（同步阻塞主进程事件循环最长 20 秒，托盘/菜单/IPC
  全无响应）改为异步 spawn；
- 配套插件拷贝增加内容戳记（版本+文件数+字节数一致即跳过），大资产插件
  （dsh-pet 15MB / dsh-dafeiyu 54MB）不再每次启动全量重拷。

### 新增：客户端更新 SHA-256 内容校验（用户建议⑥）
- 下载完成后强校验 SHA-256，不一致 → 删除文件并中止更新（绝不运行被篡改/损坏的
  安装包）。校验值来源按优先级：GitHub Release 资产自带 digest 字段 → Release
  附带的 SHA256SUMS.txt（`npm run dist` 自动生成，发布时随资产上传；Gitee 分片
  合并后同样适用）→ 都没有时记录告警并放行（老 release 兼容）。

### 新增：微信 ClawBot / OpenClaw 桥（自上游 dsh_desktop 移植，v0.7.0）
- 设置页新增「ClawBot」栏：扫码绑定微信官方 ClawBot 小程序（腾讯 iLink 协议、
  仅出站长轮询，无需公网 IP），每个微信用户映射独立 DSH 会话与工作区；
  `/help` `/list` `/attach` `/new` 指令；微信用户白名单。
- OpenAI 兼容端点 `/openclaw-bridge/v1/chat/completions`（stream/非 stream），
  OpenClaw 等网关可直接驱动常驻 DSH 会话；回环免 token、非回环强制 Bearer。
- 第三方模型：ClawBot 栏可填 baseURL/key/model 走别家 OpenAI 兼容模型。
- 壳层补丁：dsh-host-apiproxy 设置命名空间白名单加 `openclaw-bridge`（随启动
  幂等应用、覆盖 agent overlay，官方更新后自动重放）。

### 新增：多窗口（会话浮窗，自上游移植）
- 会话头部「弹出到独立窗口」：独立无边框窗口打开该会话（同会话去重、全局上限
  8 个）；浮窗与主窗 localStorage 隔离（独立 partition），标题跟随会话；配套
  dsh-side-session 插件提供侧边临时会话（浮窗追问、不写主会话、Ctrl+Shift+S）。

### 新增：会话删除与归档管理（自上游移植 + 补丁）
- 官方只有归档没有删除；运行时补丁（幂等、锚点不匹配自动跳过、覆盖 agent
  overlay）打通全链路：会话行菜单「删除对话」+ 设置内归档管理面板（恢复/删除）。

### 新增：AI 变更审核（用户建议⑤，dsh-change-review 配套插件）
- 监听官方 fileChanges 投影：手动（设置页按钮）或自动（变更停止 20 秒后，10 分钟
  冷却）向当前对话发送审核请求，模型从正确性/安全性/目标一致性复查自己刚做的
  改动，结论配合「文件」页一键还原落地。

### 新增：崩溃急救与撤销（dsh-undo-savepoint 内置，lire1131，MIT）
- 配置文件 + 用户插件代码树快照（自动/手动双库）、undo/redo/回退任意版本、
  密钥脱敏 + 本机 vault、一键安全模式（禁用除自身外所有插件保启动）、崩溃归因、
  跨机迁移 ZIP。与插件保护中心（配置面）、「文件」还原（会话内改动）互补。

### 新增：大肥鱼桌宠（dsh-dafeiyu 内置，QCYTSN；默认禁用）
- 真实会话状态驱动的原生置顶桌宠：空闲/思考/工作/等待/完成/错误六态 + 项目状态
  卡 + 摸头/戳一戳/拖拽（PySide6 helper，随包分发 49MB exe）。
- 默认禁用（含大体量二进制，按需开启）：「设置 → 插件 → 管理」里启用；角色素材
  按 ASSET_LICENSE.md 随包分发保留署名（代码 MIT）。

### 新增：插件启停管理（自上游移植 + EAC 修复）
- 设置页「插件 → 管理」标签：列出配套/用户/核心插件与启用状态，不重启切换启停
  （写 profile patch 的用户层 disabled 条目，纯文本手术）。
- EAC 修复了上游手术脚本的两个缺陷：① 禁用条目时贪婪正则会把后续兄弟条目整块
  误删（数据丢失，实测复现）；② 默认禁用的配套插件被用户启用后会被下次启动的
  sync 重新插回 disabled 行。改为行级扫描手术 + 启用保留裸条目。

### 新增：其它自上游移植的配套插件
- dsh-navbar（对话节点导航条）、dsh-conversation-tweaks（隐藏大量工具输出）、
  dsh-prompt-custom（自定义注入提示词）、dsh-third-party-thinking（第三方模型
  reasoning_effort 控件）。

### 菜单与托盘增强（用户建议③④）
- ⋯ 菜单与托盘菜单新增「重启 Web 服务」：不关闭应用原地重启 dsh web（皮肤/插件
  切换生效路径，等同市场安装后的自动重启）。

### 新增：浏览器风格右键菜单（用户反馈）
- 主窗与浮窗的右键菜单按场景自建（Electron 不展示 Chromium 内置菜单）：
  输入框/编辑器 → 撤销/重做/剪切/复制/粘贴/删除/全选（enabled 实时跟随
  可操作性灰显）；图片 → 复制图片/图片另存为；选中文本 → 复制/全选；
  页面空白区 → 后退/前进/重新加载。

### 新增：余额 / 高峰提醒样式定制（用户反馈）
- 设置 →「外观 · 字体与颜色」新增「余额 / 高峰提醒样式」分组：文字颜色、
  流光开关与流光颜色（循环扫光动画：余额徽章背景扫光、高峰提醒弹窗标题
  文字流光）；「预览效果」弹出预览窗，用真实样式类复刻余额徽章与高峰
  提醒弹窗，所见即所得。峰/谷徽章的橙绿语义色不受影响；不设置时零视觉
  变化；配置经 CSS 变量（--eac-widget-fg / --eac-widget-glow）下发并走
  颜色白名单校验（防 CSS 注入）。

### 修复：v3.1.0 全新安装即「启动失败」的根因（dsh-pet 行缺 config）
- 配套插件 dsh-pet 的宿主半边读取 config.fullRoot（无空值守卫），而壳层为它
  写入的 patch 行不带 config 块 —— loader 传入 undefined，dsh-pet apply 即
  崩，整棵插件树加载失败、dsh web 退出码 1。老用户因市场安装过的行自带
  config 才幸免；全新安装必现。
- 修复：配套条目按包内出厂值显式写 config（size/position），并新增
  healRowConfig 一次性修复 v3.1.0 存量坏行（幂等，用户改过的值不动）。
  同轮排查全部配套插件：其余 apply(config) 均有空值守卫，无同类问题。

### 修复：上游发布 Linux 产物后 Windows 更新失败（平台感知选版）
- 场景：本仓库双平台（Windows + Linux）发布后，若最新 release 只有 Linux
  资产，旧版客户端的 `/releases/latest` 查询会把 Windows 用户引向一次必然
  失败的更新（selectAsset 找不到 .exe）。
- 修复：检查更新改用 releases 列表（近 20 个），自新向旧扫描，选中「第一个
  含本平台（Windows）安装包资产的 release」—— Linux-only 版本被跳过并记
  日志，更早的 Windows 版本可正常回退选中，不漏更新也不报错；
  draft/prerelease 与 /latest 同语义过滤；selectAsset 显式拒绝文件名带
  linux/arm64/appimage/.deb 等标记的资产。自定义镜像 API 兼容单对象与
  列表两种形态。

### 新增：峰谷价格卫士（dsh-offpeak 内置，christophersmith2737-commits，MIT）
- DeepSeek 峰谷定价（2026-08-17 起）高峰时段（北京时间 9:00–12:00 /
  14:00–18:00）在发送前拦截提醒：消息保留在输入框，弹窗展示当前模型
  高峰/闲时价目；「继续执行」原样放行、「定时执行」排到闲时段自动执行
  （持久化到 profile，浏览器不在线也到点执行）、「今日不再提醒」当天静音。
- 与余额小部件互补（事前拦截省钱 vs 事后显示花费）；auto-compact / AI 变更
  审核 / 消息回退 / openclaw 桥的程序化提交不经 DOM 拦截层，互不影响；
  可在「设置 → 插件 → 管理」关闭。

### 其他
- E2E/自动化守卫：`DSH_DESKTOP_TEST_NO_SHORTCUTS=1` 跳过快捷方式维护与
  临时目录告警（测试环境不污染真实开始菜单/桌面快捷方式）。

## [3.1.0] — 2026-08-16

### 新增：内置插件保护中心（plugin-guard.js，融合三大社区保护插件并升华）
- 融合 [lxzy-7/dsh-plugin-guard]（安装前快照 / 一键与自动回滚 / 守护启动 / 事故报告）、
  [LX2000WASD/dsh-web-plugin-manager]（安装守卫 + 健康检查入口）、
  [chenw2759-wq/dsh-plugin-healthcheck]（静态体检）三者的能力，跑在 Electron 主进程：
- **快照与回滚**：每次启动 / 每个市场排队任务执行前自动快照 profile 的四个配置文件
  （package.json / pnpm-lock.yaml / pnpm-workspace.yaml / cordis.patch.yml，保留最近 10 份）；
  回滚前自动再留一份「回滚前」快照，反悔有路。
- **守护启动**：启动失败 → 自动体检 → 可修复项修复 → 重试 → 仍失败回滚到最后良好
  快照 → 再试 → 仍失败落事故报告并走原有失败对话框。每层只重试一次，绝不循环。
- **静态体检**（只读，绝不执行插件代码）：模块遮蔽（真实目录 + pnpm 链接）、patch 行
  重复 id / soul-md 缺 config、junction 归属、高危静态扫描（远程下载执行 / base64
  动态求值 / 持久化驻留 / 环境变量外传五类模式）。
- **设置页「插件保护」分区**（新配套插件 dsh-plugin-shield）：状态卡 / 立即快照 /
  快照列表与一键回滚 / 健康检查与一键修复 / 事故报告查看与标记解决。
- **市场安装增强**：市场排队任务执行前自动快照（`market:<插件>` 原因标记），
  安装坏插件后可在保护中心一键回到安装前状态。

### 修复：与原生 DeepSeek Harness（CLI / npx）冲突的根治
- **根因**：dsh-app-boot 每次启动都会把 `<DSH_HOME>/profiles/node_modules` 的共享
  junction 指向「当前运行的 dsh 实例」自己的闭包 —— 原生 CLI 一跑，桌面端的模块
  解析被换血（版本错位 / npx 缓存被清理后悬空 →「设置命名空间不可用」、启动失败）；
  同时桌面端历史版本把配套插件行/包写进共享 `web` profile，pnpm 安装互踩。
- **桌面专属 profile**：默认改用独立 `web-desktop` profile 启动（`dsh --profile
  web-desktop`，已实机验证），DSH_HOME 不变 —— 会话、API Key、settings.yaml 依旧
  与 CLI 共享；插件树 / pnpm / patch 层完全隔离。需要旧行为可设
  `settings.shareWebProfile: true`。
- **一次性迁移**：检测到旧共享 profile 里的桌面端痕迹时自动清理（配套行 + 拷贝包 +
  内置清单标记），用户选中的皮肤迁移到新 profile；用户用市场装的插件是原生端资产，
  一律不动。
- **junction 归属守卫**：启动时 + 每 5 分钟巡检共享 junction 指向；被外部 dsh 改指且
  外部进程已退出时自动修复回客户端闭包（外部进程运行中则等待，互不打扰），修复后
  系统通知告知。
- **配套插件宿主半边适配**：dsh-webui-market / dsh-dock-settings 的读写与安装默认
  落到 `DSH_DESKTOP_PROFILE`（桌面注入环境变量），独立安装使用时保持 `web`。

### 修复：「设置命名空间不可用」再根治
- `healProfileModuleShadowing` 扩展：除真实目录拷贝外，同时清理 pnpm 链接进 profile
  自身 `.pnpm` store 的核心包链接（模块双实例的另一形态）；支持按 profile 参数
  清理（桌面专属 profile 与共享 profile 都能治）。
- 修复时机补强：守护启动失败链路自动体检 + 修复（不再只依赖启动前的一次 heal）。

### 新增：外观自定义（dsh-font-custom 配套插件）
- 设置页「外观 · 字体与颜色」：界面/代码字体家族（预设 + 自定义栈）、界面/聊天正文/
  代码字号、主文字/次要文字/强调色取色器；实时预览、恢复默认、localStorage 持久化。
- 通过 dsw 主题变量覆盖（与皮肤同体系，自定义优先），MutationObserver 兜底防皮肤
  切换挤掉覆盖样式。

### 新增：自动压缩（dsh-auto-compact 配套插件，默认开启）
- 监听会话 `contextPressure` 投影（token-meter），占用率（projectedTokens ÷
  contextWindow，与官方环指示器同口径）达到阈值（默认 80%，可调 60–95%）且对话空闲
  时自动提交 `/compact`（官方压缩命令，事务由内核 dsh-compaction-basic 执行）。
- 触发提示 toast、3 分钟冷却、失败静默重试；设置页可开关 / 调阈值 / 手动立即压缩。

### 新增：人设卡完整管理（dsh-easy-setup 升级）
- 设置页「人设卡」：内置 6 张预设卡（默认助手 / Kira 搭档 / 代码审查官 / 产品思维
  工程师 / 双语技术写作 / 轻度猫娘）一键应用；「我的卡片库」保存 / 应用 / 删除
  自定义卡片（存于 `<DSH_HOME>/persona-cards/`）；当前卡片实时编辑与热重载不变。

### 新增：MCP 一键导入（dsh-dock-settings 升级，对齐 ovo669/dsh-MCP-）
- MCP 页新增「从 Claude / Codex 导入」：扫描 `~/.claude.json` 的 mcpServers 与
  `~/.codex/config.toml` 的 `[mcp_servers.*]`，勾选合并导入（同名覆盖），保存后
  重启生效。原生 MCP 管理（增删改/启停/stdio+http）此前已具备，此补齐迁移链路。

### 测试
- 新增 `plugin-guard.test.mjs`（13 项：快照/回滚/体检/修复/junction/守护启动/事故）、
  `desktop-extras.test.mjs`（7 项：字体净化与 CSS 生成 / 压缩占用率与阈值 / MCP
  导入解析器）；全量 163 项测试通过。

## [3.0.0] — 2026-08-16

### 修复（升级/启动可靠性，issues #7 #8 根因）
- **升级弹 `Failed to uninstall old application files ... : 2` / 空目录骨架**（#7 #8）：
  安装器**接管旧版清理**（`dshTakeoverWipe`）——`customInit` 直接清空旧安装树
  （含 robocopy 空目录镜像处理 MAX_PATH 超长残留）并清掉旧卸载注册表值，
  electron-builder 内置"卸载旧版本"步骤从此无事可做，**绝不运行带缺陷的旧卸载器**
  （旧卸载器先删文件后删目录，中途退出即留下阻断 Node 解析的空目录骨架）。
- **接管逻辑静默失效的回归**：目录名尾部长度截取（21/26 字符）必须与比较字面量
  严格一致，新增 `installer-nsh-lengths` 静态测试防呆；不匹配时接管不触发、
  旧卸载器再次运行（v3.0.0 首包实测回归的根因）。
- **托盘自更新 Setup 永不执行、174MB 更新包泄漏**（#8）：`apply-update.cmd`
  改为有界等待进程退出（90s）→ 超时 `taskkill /F /T` 强杀 → 全程日志落盘
  `%APPDATA%\Deepseek Harness EAC\logs\apply-update.log`。
- **启动闪退无诊断**：启动时按 `bundle-manifest.json` 校验捆绑依赖完整性，
  缺文件时弹出明确路径清单而非静默退出；heal 修复 junction 目标不健康时
  误删 profile 中真实副本的问题。
- **发布防呆三件套**：`verify-dist-fresh`（产物必须新于全部源码，杜绝 v2.0.3
  stale 产物事故重演）、`check-syntax`（async/await 关键字被注释拆断的打包前
  预检）、`bundled-files` 测试（electron-builder files 清单漏文件防呆）。

### 新增（上游 dsh_desktop 功能集成）
- **渲染进程崩溃/挂起自恢复**：`renderer-recovery` 状态机——崩溃自动重载、
  指数退避、连续失败重建窗口并展示错误页，不再白屏卡死。
- **主进程看门狗**：`watchdog` 子进程监控主进程，意外退出自动拉起并通知，
  托盘/进程不再无声消失。
- **稳定端口选择**：`stable-port`——web 端口持久化到设置，重启不变，
  localStorage 偏好不再丢失；自动避开 Chromium 受限端口。
- **koffi 预检降级**：启动前探测 koffi 可用性，失败时自动启用目录选择器
  降级方案，不再因原生库问题卡启动。
- **便携版解压缓存复用**：版本标记匹配时直接复用上次解压目录，
  二次启动不再重新解压 132MB（冷启动从分钟级降到秒级）。
- **dsh web 启动加 `--use-system-ca`**：企业内网 MITM 证书不再导致更新失败。
- **上游 agent presets 全量同步**：新增 `_preset` 共享目录同步
  （compaction-epoch / custom-bash / dev-tool-search / instruction-hint /
  skill-search），新增 minimal-win / v4-flash-godmode-opencode-go /
  warmupbetter / warmupbetter-replay / whoami-standard 预设。

### 内置插件
- **dsh-better-sidebar**（右侧边栏）：文件树、编辑器、Git 更改视图、内置终端
  （预编译 lib 集成；标题栏 toggle 按钮可收起）。

## [2.0.4] — 2026-08-15

### 修复（托盘自更新下载中断）
- **自更新下载 `net::ERR_CONNECTION_RESET` 后整体失败**：167MB 安装包在慢链路
  直连 GitHub 资产域时常被 RST，旧实现是"一锤子流"下载，中断即全量作废。
  现在 `downloadFile` 支持 **HTTP Range 断点续传 + 指数退避重试**（最多 10 次，
  3s→30s 退避；.part 残留文件保留，重启应用后再点更新也能从断点继续）。
  服务器忽略 Range 回 200 全量时自动覆盖写；.part 异常超长（416）自动作废重来。
- `getResponse`（纯 Node 回退路径）支持 `http://` 端点，自定义镜像
  （`DSH_DESKTOP_RELEASE_API`）不再强制 HTTPS。

## [2.0.3] — 2026-08-15

### 修复（issues #1 #3 #4 + README 404）
- **安装后 dsh web 启动即退（MODULE_NOT_FOUND）**（#4 问题 2 / #3）：productName
  去掉版本号后缀。此前带版本号的安装目录在升级时被注册表旧 INSTALLDIR 嵌套成
  `...\Deepseek Harness EAC v1.0\Deepseek Harness EAC v2.0\`，深层 node_modules
  路径超过 MAX_PATH(260)，NSIS 7z 解压器对超长路径**静默丢文件**（实测丢 42 个，
  含运行时必需的 `@opentelemetry/resources` machine-id / ServiceInstanceIdDetector），
  dsh web 一启动即崩。目录不再带版本号后，升级永远原地覆盖，不再嵌套。
- **GUI 安装器卡「无法关闭现有进程」死循环**（#4 问题 1）：`customInit` 统一
  kill 新旧全部进程名（含 v1.0 / v2.0 遗留 exe），`customCheckAppRunning` 改为
  无对话框等待（最多 10s）后继续，不再弹重试 MessageBox。
- **嵌套安装目录自愈**：`customInit` 检测到 `...\v1.0\...\v2.0` 式嵌套且父目录
  本身是安装根时自动剥离一层；并同步回写注册表（InstallLocation /
  UninstallString 指向治愈后的根目录；根目录无可用旧卸载器则清空该值跳过旧版
  卸载步骤）——否则内置"卸载旧版本"步骤与旧卸载器都会重读注册表、对着嵌套残缺
  目录操作，触发 `Failed to uninstall old application files ... : 2` 安装失败弹窗。
- **打包长路径审计 + 裁剪**（`after-pack.js`）：构建时扫描全部产物路径，≥240
  字符即告警；同时裁剪 x64 包里无用的 `node-pty` win32-arm64 prebuilds 与
  `@opentelemetry` browser 平台探测器（也是树里最深的目录）。
- **README 下载链接 404**：安装包产物名去掉版本号（`Deepseek-Harness-EAC-Setup-x64.exe`
  / `...-Portable-x64.exe`），README（中/英）改用 `releases/latest/download/` 永久
  链接，发新版不再失效。
- **安装版数据目录**随 productName 变为 `%APPDATA%\Deepseek Harness EAC\`
  （旧版为 `...\EAC v2.0\`；DSH 配置/会话在 `DSH_HOME`，不受影响）。
- 自更新资产选择兼容新旧命名（无版本号优先，回退带版本号 + Gitee 分片）。
- `desktop.log` 时间戳由 UTC 改为本地时间 + 显式时区偏移（#4 建议 4）。

## [2.0.2] — 2026-08-15

- 自动更新网络层改用 Electron `net`（系统代理 + 系统 CA），修复 MITM 证书失败
  与直连超时；修复资产名正则与下载校验。内置三套预设组合（Anchored Standard /
  Router Standard / Minimal Git Bash），预设实现为纯组合目录不进插件树。

## [2.0.1] — 2026-08-15

- 修复 v2.0.0 预装 `dsh-soul-md` 缺少必填 `config.path` 导致插件树加载失败、
  `dsh web 启动失败（退出码 1）`：默认补 `soul.md` 并在启动时自动补全缺失配置行。

## [2.0.0] — 2026-08-15

### 新增
- **社区插件市场**（`dsh-webui-market`，@sanqi-normal）：设置 → 插件 → 市场，
  浏览 awesome-dsh-plugin.com 收录的 dsh 插件并一键安装/卸载到 profile。
- **外置视觉模型**（`dsh-tool-vision`，Scorp1o117）：`inspect_image` 工具把本地图片
  或图片 URL 发给任意 OpenAI 兼容视觉端点（qwen-vl / GLM-4V / Ollama 等），
  看图回答直接带回对话。
- **长期记忆**（`dsh-tdai-memory`，Scorp1o117）：腾讯云 Agent Memory 移植 ——
  L0 对话捕获 → L1 结构化记忆 → L2 场景 / L3 画像，自动召回注入 +
  记忆/对话搜索工具；复用现有 `~/.memory-tencentdb/memory-tdai` 数据。
- **soul.md 人设热重载**（`dsh-soul-md`，Scorp1o117）：markdown 人设文件注入
  系统提示词（`soul:persona`），文件变更即时热重载，Agent 边干活边角色扮演。
- **移动端布局修复**（`dsh-web-mobile-fix`，AcidGr）：窄屏（≤400px）下设置面板、
  弹窗、侧栏、会话头布局修复，纯前端 CSS。
- **NSIS 安装器定制**（`build/installer.nsh`）：安装流程接入自定义脚本。

### 改进
- **重启窗口期排队任务**：服务重启时先 `killTree` 旧进程并 `waitForProcExit`
  等待其完全退出（释放文件锁），再处理插件市场排队中的安装/卸载任务、
  同步配套插件、自愈 profile 模块，最后启动新服务，避免文件占用与半套改状态。
- **插件原样分发**（`after-pack.js`）：打包后把 `assets/plugins/` 原样拷回应用目录，
  社区插件自带的 vendor 依赖（sqlite-vec / jieba / AI SDK / BM25 语料等）不再被
  electron-builder 清掉。
- 内置插件/皮肤拷贝逻辑支持根目录入口文件、vendor、node_modules、data 目录。

### 说明
- 安装版数据目录改为 `%APPDATA%\Deepseek Harness EAC v2.0\`；便携版仍跟随 exe。
- 产物命名 `Deepseek-Harness-EAC-v2.0-Portable/Setup-x64.exe`，自更新链路自动适配。

## [1.0.0] — 2026-08-15

### 品牌与新定位
- 项目更名 **Deepseek Harness EAC**（EAC = Embracing All Creation，揽尽万象）：
  Windows 桌面客户端正式释出，产物统一命名 `Deepseek-Harness-EAC-v1.0-Portable/Setup-x64.exe`。
- 自更新链路同步指向新仓库，产物命名与 electron-builder 配置对齐。

### 新增
- **界面皮肤体系**（`assets/skins/` + `dsh-skin-switch`）：内置 10 款 Web UI 皮肤
  （9 款 dsh-web-ui：xp/qq98/ths/blue-fantasy/dragon-heir/minecraft/trading/whale-song/miku，
  1 款 dsh-deep-whale maid-atelier），设置页卡片式互斥切换、默认不启用、重启生效；
  出处与许可随包标注（BSD-3-Clause / CC BY-NC-SA 4.0）。
- **快速配置插件**（`dsh-easy-setup`）：设置页视觉模型提供商/模型一键选择、
  `soul.md` 人设可视化编辑、从 Codex / Claude Code 目录一键迁移 skills + MCP + 记忆。
- **插件市场加固**（`dsh-plugin-marketplace`）：宿主 typert local store 显式注册
  远端端点，修复跨模块实例 SRC 标记不可见导致的 HTTP 404。
- **profile 模块遮蔽自愈**（`profile-module-heal.js`）：清理 web profile 中遮蔽
  fallback junction 的真实目录副本，修复 `prompt section already registered`、
  模型列表/模式切换失效等问题。
- **自动化测试**：`test/` 新增 easy-setup、skin-switch、profile-module-heal、
  persona-scope、skin-chrome-zindex 等单测（`npm test`）。

### 说明
- 便携版数据目录跟随 exe（`data\`）；安装版在 `%APPDATA%\Deepseek Harness EAC v1.0\`。
- 与 dsh CLI 共享 `DSH_HOME`（默认 `~/.dsh`），已有会话/凭据直接生效。

## [0.2.0] — 2026-08-14

### 新增
- **伴侣插件体系（一切插件化）**：新增 `assets/plugins/` 机制——宿主启动时把
  配套插件同步进 web profile（`~/.dsh/profiles/web`）并幂等打 `cordis.patch.yml`
  补丁启用。本版随客户端分发的插件：
  - `dsh-terminal`：会话内终端标签页（与 对话/轨迹/文件 并列）。在当前会话项目目录
    启动持久 PowerShell（SSE 流式，非 PTY），命令历史/清屏/重启/断线重连（保留
    512KB 回放）；显式 UTF-8 mini-REPL 规避 PS 5.1 重定向 stdin 的代码页问题；
  - `dsh-file-changes` + `dsh-client-file-changes`：会话文件修改追踪与一键还原。
    「文件」标签页聚合当前会话 agent 修改过的全部文件（新建/修改/删除 + 行级 diff），
    支持逐文件/全部还原（桌面壳做内容精确匹配后替换，冲突安全提示）。数据只读复用
    会话日志已持久化的 `tool/result.meta.diffs`（fs 写前锁内全文 diff），零写入、
    零格式变更；另提供项目文件树（`/api/dsh-files/list`）、站内 HTML/端口预览
    （`/dsh-files/static/*`、`ports`、`check`），全部仅回环；
  - `dsh-balance`：对话底部统计栏内联「本轮 ¥X.XX · 余额 ¥Y.YY」小部件
    （桌面壳读 `~/.dsh/.credentials.yaml` 调 `api.deepseek.com/user/balance`，
    15 分钟刷新，可配置价格档）；
  - `dsh-plugin-marketplace`：插件市场入口。
- **客户端自更新**（`client-updater.js`）：GitHub Releases → Gitee Releases 双源回退
  （`DSH_DESKTOP_RELEASE_API` 可自定义镜像），Gitee 100MB 分片自动下载合并；
  便携版原地替换 + 自动重启，安装版引导新安装包；失败自动保留当前版本。
- **跟随官方更新**（`updater.js`）：检测 `@deepseek-ai/dsh` 新版本，经用户同意后
  用内置 node+npm 安装到数据目录 overlay，staging 原子切换、失败回退、
  启动失败一键回退内置版本；尊重 `NPM_CONFIG_REGISTRY`。
- **会话完成系统通知**：agent 任务跑完弹 Windows 通知，点击回到窗口。
- **快捷键自动维护**：便携版自动创建/重建桌面+开始菜单快捷方式（exe 移动后自愈）。

### 说明
- 便携版数据目录跟随 exe（`data\`）；安装版在 `%APPDATA%\DSH Desktop\`。
- 与 dsh CLI 共享 `DSH_HOME`（默认 `~/.dsh`），已有会话/凭据直接生效。
