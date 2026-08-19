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
4 目录备份/回滚 + 结构化日志 + 插件自写 patch 行保护）。

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
  「关于」对话框附交流群号（523412163）与反馈指引。

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
