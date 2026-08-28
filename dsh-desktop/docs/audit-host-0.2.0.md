# DSH Desktop 宿主代码审计报告（只读，dsh-desktop）

审计基线：源码 package.json 0.1.0 / 内置 @deepseek-ai/dsh 0.1.0-rc.6 / Electron 43.4.0 / vendored Node v24.15.0（Electron 内嵌 Node v24.18.1，两者均支持 node:zlib.zstdDecompressSync，session-watcher 可用）。所有 JS 通过 node --check。行号以当前工作区文件为准。

## 一、严重（发布前必须修复）

### H1. will-navigate 白名单是字符串前缀匹配，可把主窗口导航到任意站点/本地文件（全部 IPC 权限随之泄漏）
- 位置：main.js:289-294
- 结论：url.startsWith('file:') 放行任意 file:// URL；url.startsWith(webUrl) 对 "http://127.0.0.1:58217.evil.com"（同前缀异域）和 "http://127.0.0.1:58217@evil.com"（userinfo 技巧）都误判为本站。被导航进来的页面仍是同一个 webContents，preload 的 window.dshDesktop 桥完全可用，所有 IPC 的 event.sender === mainWindow.webContents 校验形同虚设。另未监听 will-redirect，302 跳转不受白名单约束。
- 修复：解析 URL 后按 origin 精确比较（protocol+host+port）；file: 一律 preventDefault（loading/updating 由主进程 loadFile 加载，无需放行渲染进程导航）；补 will-redirect 同规则。

### H2. dsh:file-revert 可在任意绝对路径创建/覆写/删除文件（无工作目录围栏）
- 位置：main.js:649-688
- 结论：注释声称"只有内容一致才动手，天然幂等且安全"，但"新建->删除/删除->恢复"分支是任意路径任意内容写文件（672-681 行只要求 content.includes(newText) 或文件不存在）。页面内任意 JS（XSS 或 H1 导航逃逸）即可在 Startup\evil.bat 等位置写入文件。无"必须是 agent 写入的文件/必须在会话 cwd 内"的约束。
- 修复：要求 path 位于当前会话 cwd（从会话日志 header.cwd 取）或显式项目根之下；创建/删除操作需额外确认。

### H3. dsh:file-open 用 ShellExecute 打开任意绝对路径（与 H2 组合成完整 RCE 链）
- 位置：main.js:691-702
- 结论：只校验绝对路径+存在性，.bat/.cmd/.exe/.lnk 会被系统默认动作"执行"而非"打开"。结合 H1（诱导导航）+ H2（先写文件）＝任意代码执行。
- 修复：与 H2 相同路径围栏；或扩展名白名单；.lnk/.bat/.exe 一律拒绝。

## 二、中（建议 0.2.0 一并修或至少收口）

### M1. 启动失败重试会泄漏孤儿 dsh web 进程（同一 DSH_HOME 双写风险）
- 位置：main.js:131-188（60s 超时 186 行；exit handler 163-184；handleBootFailure 重试 223-247）
- 结论：startServer 未在重入时先杀旧 serverProc；60s 超时 reject 后旧进程继续运行；用户反复点"重试"会累积多个 harness 进程同时写同一 DSH_HOME，正是 repair-session-log.js 要修的"拼接日志/撕裂帧"的成因之一。成功/失败路径也未 clearTimeout。
- 修复：startServer 开头 if (serverProc) killTree(serverProc)；settle 时清定时器。

### M2. killTree 用 taskkill /F 强杀 dsh web，可能撕裂正在写入的 session.jsonl.zstd 尾部
- 位置：main.js:94-108；调用点 459/616/1027/1237
- 结论：/F 无宽限期。agent 会话写入中强杀 -> 最后一个 zstd frame 残缺（torn tail）-> SessionWatcher 从此停在该帧不再解析（session-watcher.js:163-182 的 break 语义），dsh 侧也可能报错（仓库里 repair-session-log.js 的存在即佐证）。
- 修复：先尝试不带 /F 的 taskkill + 短等待（如 3s），再 /F；restart-service 在 kill 与 spawn 之间等待旧进程 exit。

### M3. 客户端自更新 cmd 脚本的等待循环无上限（应用可能"永久消失"）
- 位置：client-updater.js:258-281（:wait 循环无最大次数；262 行 copy 失败即 goto wait）
- 结论：便携版旧 exe 若一直被占用（杀软/残留句柄），脚本无限 ping 循环，新版本永远不启动；:failed 分支 start NEW 从 updates 目录启动 -> 便携版按 PORTABLE_EXECUTABLE_DIR 新建 data 目录，丢失原设置/会话上下文。
- 修复：wait 加最大次数（约 2 分钟）后走 failed；failed 分支先尝试把新 exe 复制到旧位置，失败再直启，并显式携带原数据目录。

### M4. agent 更新在 dsh web 运行中重命名 overlay，176 行不在 try 内
- 位置：updater.js:173-183
- 结论：fs.renameSync(overlay, backup)（176 行）在 try 之外；Windows 下运行中进程若持有 overlay 内文件句柄（静态资源流/ESM 锁），抛 EBUSY/EPERM 直接冒出原始错误，且 staging 目录残留（下次 applyUpdate 才清）。
- 修复：176 行纳入 try，失败时清理 staging 并给出可读错误；或交换前先优雅停服。

### M5. 客户端安装包无哈希校验
- 位置：client-updater.js:214-247（仅 64MB 最小尺寸 + 2MB 容差，242-244 行"继续，安装器会自校验"）
- 结论：与 agent 更新（npm registry integrity 保证）不同，exe 从 GitHub/Gitee 裸下载无 SHA256 校验，上游被投毒/镜像被劫持无兜底。
- 修复：release API 增加 sha256 字段并校验；或对安装包做 Authenticode 校验（需发布签名，见 L9）。

### M6. 预览静态文件服务暴露整个文件系统
- 位置：main.js:1095-1158
- 结论：仅校验回环地址，path.isAbsolute(p) 即放行任意绝对路径；无根目录约束、无 CSP/X-Content-Type-Options。浏览器跨域 fetch 读不到（无 CORS 头），但本机任意进程/被诱导的页面可用 script/img/CSS 探测，或直接把项目外文件当 JS 加载。
- 修复：根目录限制为会话工作目录；补安全响应头；非白名单扩展名 404。

### M7. 客户端更新"稍后重启"后每 12h 重复弹窗并重复下载
- 位置：main.js:978-995（未检查已有 pendingClientUpdate）+ 1048-1081
- 结论：用户选"稍后"后 pendingClientUpdate 已存在，但自动检查仍弹"发现新版本"并重新下载同名安装包（覆盖写）。
- 修复：runClientUpdateFlow 发现 pendingClientUpdate.version === latest 时跳过下载弹窗，只提醒"待安装"。

### M8. session-watcher 每 2 秒全量读文件 + 全量扫描帧（主进程阻塞）
- 位置：session-watcher.js:137-198（148 行 readFileSync 全文件；163 行 scanZstdFrames 全 buffer）
- 结论：长会话（数百 MB）每次轮询全量读盘；主进程同步 I/O 会卡窗口。虽只对新帧解码，但读/扫是 O(全文件)。
- 修复：用 fd 从 rec.consumed 字节偏移读增量；帧扫描也从偏移开始。

### M9. 插件市场"重启服务"不等待旧进程退出，新旧 dsh web 短暂并存
- 位置：main.js:609-626
- 结论：killTree 异步返回后立即 startAndShow；profile-boot 每次启动会重写 profiles/web 根配置（profile-boot-DG5t9aNs.js:143），两进程并发写 cordis.patch.yml/配置存在竞态。
- 修复：等待旧 proc exit（带超时）再重启。

## 三、低

- L1 成功路径不清 60s 定时器：main.js:186（finish 无 clearTimeout，.unref() 后仅空转一次）。
- L2 compareVersions 对两位版本号（"1.2"）返回 NaN：updater.js:68-85；当前版本恒三段，防御性修复。
- L3 插件同步不清理失效项：main.js:818-855——从 COMPANION_PLUGINS 移除或 assets 删除后，profiles/web/node_modules 旧目录与 cordis.patch.yml 条目永远残留（插件"卸载不掉"）；去重正则 id:\s*xxx\b 对 id: balance-extra 类 ID 误判（\b 在 '-' 前成立）可能跳过插入。
- L4 rollback 保留 agent-broken-* 不清理：updater.js:192-199，磁盘累积。
- L5 dsh:page-error 无 payload 上限：main.js:637-640，恶意页面可刷爆 desktop.log。
- L6 balance.readActiveModel 取 settings.yaml 首个 model: 行：balance.js:40-47；其他命名空间若含 model 键会误读价格档。建议锚定 agent-default-model 段。
- L7 静态端口竞态：main.js:567 返回的 previewStaticPort 可能为 0（listen 回调未完成时 chrome:init 先到），UI 需容忍 0 并重取。
- L8 发布版本不一致（见发布结论）：源码 package.json 0.1.0，dist/win-unpacked 内 app 为 0.2.0，dist 下 exe 仍为 0.1.0（0:50 与 5:35 两次构建混放）。
- L9 未签名（electron-builder.yml 无 win.sign）：SmartScreen 警告 + 无法 Authenticode 校验更新包（关联 M5）。
- L10 原生模块 ABI 依赖构建机 node 与 npm install 时一致（fetch-node.js 复制本机 node.exe）：README 已声明，属构建流程约束。

## 四、对重点问题的逐项回答

- A 端口：--port 0 由 dsh-host-webserver 绑定后取 listenedPort（node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:173），dsh-web-app 打印 "dsh web: http://127.0.0.1:<port>"（dsh-web-app/lib/index.js:107），main.js:156 正则解析 stdout——链路正确。启动超时 60s（等 URL 行）+ 120s（等 HTTP 就绪，main.js:190）。崩溃重启：webUrl 已就绪则弹窗"重新启动/退出"（main.js:170-183）。退出清理：before-quit -> killTree(taskkill /T /F)（main.js:1233-1242）有效但见 M2。多实例：requestSingleInstanceLock 正常（main.js:1221-1224）。
- B 插件同步：dsh-plugin-marketplace 已在 COMPANION_PLUGINS 登记（main.js:815），5 个插件齐全，用户担心的"只在 assets 不被同步"不成立。复制幂等（copyFileSync 覆盖 + 正则去重 840-847）；patch 格式 - insert:（无 id）在 dsh-app-boot.applyEntryPatches 中语义为"追加到根条目列表"（dsh-app-boot/lib/index.js:83），与 DSH 解析一致。插件目标目录 $DSH_HOME/profiles/web/node_modules/@deepseek-ai 与 marketplace 插件自身写入目标一致（dsh-plugin-marketplace/lib/index.js:48-50）。残留清理问题见 L3。
- C 更新流程：compareVersions 支持 0.x.x-rc.N 预发布；agent 下载由 npm integrity 保证（M5 只针对客户端 exe）；原子替换 staging->overlay、失败回滚 backup（M4 例外）；cordis.patch.yml 位于 DSH_HOME/profiles/web，updater.applyUpdate 只动 userData/agent，更新不会清插件补丁/白名单补丁，install 脚本重跑也不受影响；client-updater 与 updater 分工独立（不同目录、各自 busy 标志），可并发无冲突；重复提示见 M7。
- D 安全：webPreferences 正确（contextIsolation:true / nodeIntegration:false / sandbox:true，main.js:265-271）；openExternal/setWindowOpenHandler 有 ^https?:// 白名单；主要缺口即 H1-H3 与 M6。
- E 明显 BUG：全部文件语法通过；无未捕获 Promise 的明显静态问题；实际缺陷即上文 H1/M1/M3/M8/L8。另注意审计期间 scripts/term-shell-probe4.js 被并发删除（工作区在变，非代码问题）。

## 五、是否可发布 0.2.0

结论：不建议原样发布。阻断项：H1（导航逃逸，前缀匹配即可把窗口带进任意站点并接管全部 IPC 权限）、H2+H3（文件写/删/执行无路径围栏，构成 RCE 链）、M3（客户端更新可能让应用"永久消失"）、M1（重试启动泄漏孤儿进程，威胁会话日志完整性）。建议 0.2.0 至少修完 H1-H3 + M1 + M3，并统一版本号（源码 package.json bump 到 0.2.0 后重新构建两个目标，当前 dist 混放 0.1.0 exe 与 0.2.0 unpacked，客户端自更新的 tag 与 APP_VERSION 会比较错乱）；M2/M4/M5/M7 建议同批收口；M6/M8/L 系列可排 0.2.1。
