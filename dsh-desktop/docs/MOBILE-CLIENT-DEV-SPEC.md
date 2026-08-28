# DSH Desktop 手机续聊客户端 · 实现开发文档

> 适用仓库：`zouyuxuan122/Deepseek-Harness-EAC`（本地工程根 `dsh_desktop`，内核 `@deepseek-ai/dsh@0.1.1-rc.2`）
> 版本批次：5.1.0 修复批次（内部代号 5.1.1）的后续功能；本批已交付「连接手机」桌面侧配对链路 + 白名单 RPC 桥 + 手机端**开发中占位页**。本文档指导把手机端占位页升级为**可用的续聊客户端**。
> 状态：2026-08-27 调研定稿（接口契约均为本仓库内核实测，非臆测）。

## 0. TL;DR

在手机上完成「会话列表 → 查看历史 → 发送消息 → 切换模型（可选新建会话）」的续聊闭环。桌面侧链路**零改动**（配对/批准/cookie/白名单转发都已就绪），需要做三件事：

1. **修正 `phone-bridge.ts` 的 `forwardRpc`**：现实现把手机端 `{method, params}` 原样 POST 到内核，但内核要求 `client-request` 信封（见 §4.1），**直调必 400**——这是启用 RPC 前必须修的隐藏 bug。
2. **新增手机端单页客户端**（一个静态 HTML，由桥服务）：会话列表 / 消息流 / 输入发送 / 模型切换 / 新建会话，轮询刷新（2s）。
3. **回归测试 + 真机模拟验收 + 重新打包**（§7）。

---

## 1. 背景与目标

### 1.1 现状（5.1.0 已交付）

- 桌面侧「连接手机」（设置页 → 增强功能下方「连接手机」分区，插件 `assets/plugins/dsh-phone/`）：
  - `window.dshDesktop.phoneBridge.start()` → sidecar 在 `0.0.0.0:<随机端口>` 起 LAN HTTP 桥（`tauri-shell/sidecar/phone-bridge.ts`，编译产物 `phone-bridge.js`，经 dsh-desktop 的 tsconfig include 一并 tsc 编译）。
  - 配对：`/pair?token=`（一次性、5 分钟 TTL、`timingSafeEqual`）；手机端轮询 `/api/pair-state?token=`；桌面批准走 `/desktop/decide`（**仅回环**）或 bridge RPC `phone.decide`；批准后签发一年期 `dsh_mobile=1; Path=/; HttpOnly; SameSite=Strict` cookie。
  - 断开：`phone.disconnect`（RPC，仅回环）/ HTTP `/desktop/disconnect` —— 轮换配对 token，旧 cookie 失去配对上下文后 `/api/rpc` 返回 401。
  - `/api/rpc`：白名单 RPC 转发（见 §4.3），cookie 校验；响应头 `no-store`。
  - `/`：当前为「手机端开发中」占位页（保留 PWA meta）。
- 已覆盖网络：`test/phone-bridge.test.ts`（4 个用例：配对/批准/cookie/RPC 转发/断开）。

### 1.2 目标（本文档）

- 手机浏览器打开桥地址 → （已配对会话）显示**会话列表** → 进入会话看**历史消息**（可向前翻页）→ **发送消息**并轮询看到回复 → **切换模型** →（可选）**新建会话** / 取消发送。
- 手机端不持有任何密钥/凭据——一切请求经桌面内核执行（`session.prompt` 在桌面侧 agent 运行，回复从桌面回流）。
- 无框架、无构建、无外链资源：单文件静态 HTML（内联 CSS/JS），桥直接以 `text/html` 服务。

### 1.3 非目标（明确不做）

- 屏幕远控 / scrcpy 类镜像（上游 dsh-desktop 也没有，属另一套系统）。
- 完整桌面功能（文件浏览、技能管理、插件市场…）。白名单 RPC 之外的方法一律拒绝。
- 图像消息收发（v1 渲染时跳过图片块）；SSE 实时推送为可选项（§4.5）。

---

## 2. 系统架构与数据流

```
手机浏览器 (LAN/PWA)
   │  http://<桌面IP>:<桥端口>/
   ▼
L2 Node sidecar —— tauri-shell/sidecar/phone-bridge.ts  (本改动主战场)
   │  0.0.0.0:<port>  只暴露：/  /pair  /api/pair-state  /api/rpc
   │                  (/desktop/* 仅回环)
   │  forwardRpc(): 组装 client-request 信封 → POST http://127.0.0.1:<webPort>/api/<method>
   ▼
L3 dsh 内核 web（仅回环监听）—— dsh-host-apiproxy 的 /api/* 注册表（invoke 分发）
```

- 配对时序（已有）：扫码 → `/pair?token=` 配对等待页 → 桌面批准 → 页面轮询到 `approved` 并收到 Set-Cookie → 跳转 `/`（客户端）。
- 续聊时序（新增）：客户端带 cookie 调 `/api/rpc {method,payload}` → 桥组装信封转发 → 内核执行 → `server-response` 解包 → 桥把 `value/error` 返回手机 → 手机轮询最新 `session.history` 刷新回复。

---

## 3. 现有资产盘点

| 项 | 状态 | 说明 |
|---|---|---|
| 配对 / 批准 / cookie / 断开 | ✅ 就绪 | phone-bridge.ts 已实现并通过单测 |
| `/api/rpc` 白名单 + cookie 校验 | ✅ 就绪 | 但 **forwardRpc 转发格式错误**（见下） |
| 手机端页面 | ⚠️ 占位 | `/` 返回「开发中」页，需替换为客户端 |
| PWA meta | ✅ 保留 | `apple-mobile-web-app-capable` 已在占位页 |
| 设置页入口 dsh-phone | ✅ 就绪 | 文案需从「开发中」改为「已可用」 |
| **forwardRpc 信封** | ❌ **隐藏 bug** | 直接把手机端 body 当内核 body 转发；内核要 `client-request` 信封（§4.1），现实现会 400 bad-request |
| `agentPreset.list/select` | ⚠️ 待验证 | allowlist 里有，但内核 apiproxy 注册表未见对应 invoke；开发时验证，不存在则从 allowlist 移除、UI 隐藏预设选择 |
| SSE 下行 `/api/events.mux` | ⏸️ 增强项 | 内核为 **GET SSE**（非 WS）；v1 用轮询即可 |

---

## 4. 协议契约（内核 0.1.1-rc.2 实测）

### 4.1 内核 HTTP API 信封（dsh-host-apiproxy）

- 路径：`POST http://127.0.0.1:<webPort>/api/<method>`（只接受 POST；`Content-Type: application/json` 必须，否则 415 裸文本）。
- 请求体（`clientRequestSchema`）：
  ```json
  { "type": "client-request", "rpcId": "<任意唯一字符串，手机端或桥自产>", "method": "session.list", "payload": {} }
  ```
- 成功响应（`serverResponseSchema`，HTTP 200）：
  ```json
  { "type": "server-response", "rpcId": "<回显>", "result": { "ok": true, "value": { ...业务值... } } }
  ```
  > 注：部分窄路径可能直接以业务对象作 result；开发实现以实测为准（解包时兼容 `result.ok===true && result.value` 与 `result` 即业务值两种形态）。
- 业务失败（HTTP 200 但 `result.ok=false`）：
  ```json
  { "type": "server-response", "rpcId": "...", "result": { "ok": false, "error": { "code": "...", "message": "...", "details": {...} } } }
  ```
- 路由级失败：404 `not found`、415 `content type must be application/json`、400 `body is not JSON`（均为裸文本）。信封校验失败返回 200 且 `result.ok=false, error.code = "bad-request"`。

### 4.2 手机 → 桥 `/api/rpc` 协议（建议定型，桥外契约）

- 请求：`POST /api/rpc`，`Content-Type: application/json`，携带 `Cookie: dsh_mobile=1`：
  ```json
  { "method": "session.history", "payload": { "sessionId": "..." } }
  ```
  （手机端不需要懂内核信封；`rpcId` 由桥自产随机。）
- 响应（桥统一形状）：
  - `200 { "ok": true, "value": <内核 result.value> }`
  - `200 { "ok": false, "error": { "code", "message" } }`（内核业务错误解包）
  - `401 { "error": "not paired" }`（无 cookie）
  - `400 { "error": "method not allowed" }`（不在白名单）
  - `502/503 { "error": ... }`（内核转发失败/内核未运行）
- **forwardRpc 修正点（必做）**：`phone-bridge.ts` 的 `forwardRpc(method, params)` 现在把手机端 body 直接转发；改为：
  1. 生成 `rpcId = randomUUID()`；
  2. `POST ${webUrl}/api/${method}`，body = `{type:'client-request', rpcId, method, payload: params ?? {}}`（`Connection: close`、30s 超时——现状已用 node:http agent:false，保留）；
  3. 解析响应：`result.ok===true` → `{ok:true, value:result.value}`；`result.ok===false` → `{ok:false, error:result.error}`；HTTP 非 200 → `{ok:false, error:{code:'http-'+status, message: 响应文本}}`。
  4. 完成后更新 `test/phone-bridge.test.ts`：mock 内核校验**收到的是信封**（`type==='client-request'`、`method` 与 `payload` 正确、rpcId 存在），并断言解包形状。

### 4.3 白名单 RPC 方法契约（均经 §4.1 信封调用）

> 以下字段为本仓库 `dsh-host-apiproxy/lib/index.js` schema 实测（方法名即 `/api/<method>`）。

**session.list**
- payload：`{}`（`cursor` 为预留位，不必传）
- value：`{ items: [ { sessionId, updatedAt(number ms), running(bool), blank(bool), parentSessionId?, origin?:'subagent', cwd?, agentPreset?, projections? } ] }`

**session.history**
- payload：`{ sessionId, beforeSeq?(number), maxMessages?(number) }`（无 beforeSeq = 尾部窗口；翻页传 `beforeSeq = 当前最早 event.seq`）
- value：`{ events: [ { event: { type, seq, time, data, sourceEventSeqs?, surfaceOp?, ignorable? }, view? } ], hasMore(bool), projections? }`
- 渲染 fold 规则见 §4.4。

**session.prompt**
- payload：`{ sessionId, mode: "queue" | "steer", content: [ { type:"text", text } | { type:"image", mediaType:"image/png|jpeg|webp|gif", data:"base64", name? } ], clientTimeZone? }`
- value：`{ accepted: true, command?: { kind:"success", text? } }`（回复通过轮询 history 获取，该接口是异步提交）
- v1 只发 `mode:"queue"`、`content:[{type:"text",text}]`。

**session.models**
- payload：`{ sessionId }`
- value：`{ current: { provider, model, reasoningEffort? }, routable(bool), groups: [ { id, name, models: [ { id, name, description?, reasoning?: { efforts:[{id,name,description?}], defaultEffort? } } ] } ], failures: [ { id, name, message } ] }`

**session.selectModel**
- payload：`{ sessionId, provider, model, reasoningEffort? }`
- value：`{ selected: { provider, model, reasoningEffort? } }`

**session.create**
- payload：`{ workspaceId? | cwd?（二选一，不可同时）, sessionId?, agentPreset? }`
- value：`{ sessionId, agentPreset? }`
- v1：不带 workspaceId/cwd（内核默认工作区），可带 `agentPreset`（若预设在 UI 可选）。

**session.cancel**
- payload：`{ sessionId }`
- value：`{ accepted: true }`（取消正在运行的轮次）

**workspace.list**（会话按工作区展示时用；v1 可只取 `items` 渲染工作区筛选或忽略）
- payload：`{}`
- value：`{ items: [ <workspaceView：含 id/name/path 等，开发时以实测为准> ], archivedSessionIds: [] }`

**agentPreset.list / agentPreset.select**（⚠️ 待验证）
- allowlist 中已保留，但 `dsh-host-apiproxy` 注册表未发现对应 invoke；`dsh-agent-presets` 包提供 `agentPresets` 服务，端点名可能是 `agentPreset.list/select` 或 `preset.*`。
- 开发时：在运行中的内核 `POST /api/agentPreset.list` 发空信封验证；**不存在 → 从 allowlist 移除这两个方法**，手机端不显示预设切换（`session.create` 的 `agentPreset` 字段也留空），并在文档记录。

### 4.4 消息 / 事件渲染规则（来自 session.history 的 events）

只展示「追加」事件（`event.surfaceOp === 'append'`；`'replace'` 是压缩替换副本，跳过可避免旧消息错乱；`surfaceOp === undefined` 的辅助事件按类型处理）：

| event.type | data 形状（实测） | 手机端渲染 |
|---|---|---|
| `user/message` | data 即消息 `{ role:'user', content:[...] }` | 右侧用户气泡：拼接 content 中全部 `text` 块文本 |
| `assistant/message` | `data.message = { role:'assistant', content:[...], usage? }`；`content.length===0` 的跳过 | 左侧助手气泡：全部 `text` 块；`thought/tool-call` 块折叠为一行小字（如「🔧 调用 bash」） |
| `tool/result` | `data.message = { role:'tool', content:[...] }` | 折叠工具行（工具名/简短摘要），默认不展开 payload |
| `turn/start` / `turn/end` | — | 用于判断运行中：最近一条 `turn/start` 未配对 `turn/end` → 显示「思考中…」 |
| `approval/*`、`question/*`、`command/run\|done`、`session/*` 等 | 宽类型 | 忽略或折叠为辅助行（v1 可一律忽略） |

- content blocks：`{type:'text', text}` 正常渲染；`{type:'tool-call'/'tool-result'/'thought'/'attachment'/'image'...}` 一律折叠/跳过。文本按换行符与代码围栏做简单保留（`white-space: pre-wrap`）。
- 翻页：上滑到顶时用 `beforeSeq = 当前最早 event.seq` 调 history，`hasMore===false` 停。
- v1 刷新策略：进入会话后每 **2s** 轮询 `session.history`（无 beforeSeq 尾部窗口，`maxMessages: 50`）；以最新 `event.seq` 是否增长判断是否有新内容，有则追加渲染并滚动到底。发送后保持轮询直至看到新 `assistant/message` 或 `turn/end`。

### 4.5 增强项（可选，不阻塞 v1）：内核事件下行

- 实测：`GET /api/events.mux` 是 **SSE**（`sseResponse`），**不是 WebSocket**。帧为 `muxFrameSchema` discriminatedUnion：
  - `session/event { sessionId, event, view? }`
  - `session/subscribed { sessionId, lastSeq }`
  - `approval/requested / approval/resolved`
  - `question/requested / question/resolved`
  - `session/queue ...`（其余类型见 `dsh-host-apiproxy/lib/index.js` L5101 起）
- 若做：桥内部以 SSE 连内核 mux（长连接，转发时**仅透传当前已配对会话的事件**），再以 SSE 或轮询桥端点发给手机；注意桥的 Node http `agent:false` 连接不能用于这种长连接（需独立 agent），且内核 mux SSE 会在内核重启时断开需重连。
- 结论：v1 直接用 §4.4 的 2s 轮询，**不做 mux**；轮询实现简单且对内核无压力（50 条尾部窗口）。

### 4.6 安全边界（保持 + 建议）

- 保持：配对 token 一次性 + 5min TTL + `timingSafeEqual`；`decide/disconnect` 仅回环；cookie `HttpOnly + SameSite=Strict + Path=/ + Max-Age 一年`；RPC 白名单；响应 `no-store`、`X-Frame-Options: DENY`；LAN 桥只暴露 `/、/pair、/api/pair-state、/api/rpc`（+ 新客户端页）。
- 建议新增：`/api/rpc` 每会话令牌桶限流（如 5 req/s，内存 Map 按 sessionId），防 LAN 内脚本滥用桌面内核。
- 手机端页面不内联任何密钥；仅经 `/api/rpc` 与桌面内核交互。

---

## 5. 手机端 UI 规格

- **技术**：单文件 `tauri-shell/sidecar/mobile-app.html`（内联 CSS/JS，`<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` + PWA meta + `theme-color`；深色移动风格；无外链资源）。桥以 `text/html; charset=utf-8` + `no-store` 服务该文件（路径 `/` 或 `/app`，建议 `/` 直接是客户端，`/pair` 保留配对页）。
- **状态机**：
  1. `unpaired`：`GET /api/pair-state?token=…` 不在配对中 / 无 cookie 且未批准 → 显示「未配对：请返回桌面端重新扫码」+ 按钮引导（回到 `/pair` 流程由桌面端重新发起）。
  2. `loading` / `ready` / `error`（错误 toast：`{error}` 文本 + 401 引导重配对）。
- **页面 A：会话列表**
  - onload：`session.list` → `items`；渲染卡片：标题（取最近一条用户/助手文本前 30 字，空白会话显示「新会话」）、`running` 徽标、`updatedAt` 相对时间。
  - 点击 → 页面 B；下拉刷新 `session.list`；右上「＋」→ `session.create({})` → 直入页面 B 并聚焦输入框。
- **页面 B：会话详情**
  - 顶部：返回按钮 + 会话标题 + 模型选择器（点击 → `session.models` → 分组选择 `selectModel`，成功后 toast）。
  - 消息区：§4.4 fold 渲染；滚动到顶触发 `beforeSeq` 翻页；运行中显示「思考中…」指示条。
  - 底部输入条：textarea（Enter 发送 / Shift+Enter 换行）、发送按钮（`session.prompt` `mode:'queue'`；失败/401 toast；发送后清空并保持轮询）、"停止"按钮（`session.cancel`，仅在 running 时显示）。
  - 每 2s 轮询 history（页面 B 激活时）；页面 A 回到列表时停止轮询。
- **离线/异常**：所有 fetch 失败 → 顶部横幅「与桌面连接中断」+ 重试按钮；401 → 跳回 unpaired。
- **文案**：中文。dsh-phone 设置页 client.js 文案从「手机端客户端正在开发中」改为「手机端续聊客户端已可用：扫码后在手机上继续会话」。

---

## 6. 文件级改动清单

1. `tauri-shell/sidecar/phone-bridge.ts`（+ 重新 tsc 生成 `phone-bridge.js`）
   - 修 `forwardRpc`：组装 §4.1 信封、§4.2 解包（隐藏 bug，必改）。
   - `/` 路由：从占位页改为服务 `mobile-app.html`（保留 PWA meta；`/pair`、`/api/pair-state`、`/api/rpc`、`/desktop/*` 不动）。
   - 可选：`/api/rpc` 限流；allowlist 按 §4.3 确认 `agentPreset.*`。
2. 新增 `tauri-shell/sidecar/mobile-app.html`（§5 客户端；可用 `phone-bridge.ts` 直接 `readFileSync` 或 `include_str` 风格读取——sidecar 是 Node，用 `fs.readFileSync(path.join(__dirname,'mobile-app.html'))`）。
3. `tauri-shell/stage-resources.mjs`：sidecar 拷贝清单（L220 循环）加入 `mobile-app.html`。
4. `tauri-shell/.gitignore`：`sidecar/phone-bridge.js` 已忽略（产物）；`mobile-app.html` 为源码文件需**提交**（勿加忽略）。
5. `dsh-desktop/assets/plugins/dsh-phone/lib/client.js`：占位文案改「已可用」；可补充「手机端无需安装 App，浏览器打开即可」。
6. `dsh-desktop/test/phone-bridge.test.ts`：新增用例——mock 内核校验**信封形状**（type/rpcId/method/payload）、内核 `result.ok=false` 解包、http 非 200 映射；保留原 4 用例。
7. `dsh-desktop/README.md` / `CHANGELOG.md`：更新「连接手机」说明。
8. `tauri-shell/tauri.conf.json` / `dsh-desktop/package.json`：**版本保持 5.1.0**（用户既定规则，勿 bump）。

## 7. 测试与验收（开发完成后必做）

- **单测**：`node scripts/test-runner.js test/phone-bridge.test.ts`（test-runner 在 `dsh-desktop/` 下运行，Node 24 type-stripping）；全量 `npm test` 保持 724 用例 719 通过 0 失败。
- **真机/模拟验收**（隔离环境）：
  1. `node stage-resources.mjs` → tauri build → `make-portable.mjs`（产物 `Deepseek-Harness-EAC-5.1.0-portable.zip`）。
  2. 全新解包 + `DSH_HOME=<隔离目录>` 启动便携版；浏览器（`agent-browser set device "iPhone 14"` 模拟手机视口）打开桌面端扫描出的 LAN URL。
  3. 走通：扫码配对页 → 桌面端「批准」→ 自动进入客户端 → 会话列表（需先在内核侧有一个真实会话与可用 provider/key，否则只验列表/历史/模型）→ 进入会话 → 发消息 → 2s 内看到新回复 → 切换模型成功 → 新建会话成功 → 桌面端「断开」后 `/api/rpc` 401、客户端回到未配对态。
  4. 无 provider 场景：发送报错路径 toast 正确、不白屏。
- **回归**：`cargo check --release`（tauri-shell）通过；全量测试绿；便携包冒烟（启动 → web 200 → `/plugins/dsh-phone/qrcode.js` 200）。

## 8. 风险与注意事项

- 内核信封/响应形状是 rc.2 实测；升级内核版本后需回归 §4 契约。
- `session.prompt` 依赖桌面内核可用（密钥/provider 在桌面侧）；手机端**不存密钥**是本设计的安全前提。
- `agentPreset.*` 若内核无端点：从 allowlist 移除并隐藏 UI 入口（§4.3 已验证性写法）。
- 老用户 profile 升级：新插件行由 companion-sync 启动幂等写入，无需迁移。
- mux SSE 下行是增强项，勿混入 v1 范围；轮询 2s 已足够续聊体验。

## 9. 参考代码位置（排查/开发入口）

- 桥本体：`tauri-shell/sidecar/phone-bridge.ts`（配对 `rotatePairing/pairingWaitPage`、`forwardRpc`、路由 `handle()`、`/` 占位页 `mobilePlaceholderPage`）。
- 内核 API 注册表与信封：`dsh-desktop/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js`（`clientRequestSchema` L4148、`session*Schema` L442-617、注册表 invoke L4700-4780、`toFetchHandler` L4978、`muxFrameSchema` L5101）。
- 消息事件类型/投影：`.../node_modules/@deepseek-ai/dsh-session/lib/index.js`（`SURFACE_EVENT_TYPES` L217-223、`deriveEventMessage` L281-291）。
- 桥的 RPC 接线：`tauri-shell/sidecar/server.ts`（`phone.*` 方法 + `currentWebInfo`）。
- 设置页入口：`dsh-desktop/assets/plugins/dsh-phone/lib/client.js`。
- 桥测试：`dsh-desktop/test/phone-bridge.test.ts`。