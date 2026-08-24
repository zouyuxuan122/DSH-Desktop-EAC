# 微信 ClawBot 免 OpenClaw 直连自定义后端（DSH）技术调研报告

> 调研时间：2026-08 · 调研对象：腾讯官方 npm 包 @tencent-weixin/openclaw-weixin（源码级）、4 个社区免 OpenClaw 项目、以及微信 ClawBot 官方/社区教程。
> 标注约定：**官方事实** = 来自腾讯 npm 包源码与 README 的直接证据；**社区逆向/实测** = 来自社区文档与实测（可能随版本漂移）。

## 0. 结论速览（TL;DR）

1. **微信 ClawBot 底层是腾讯官方的 iLink 协议**，域名固定为 https://ilinkai.weixin.qq.com ，标准 HTTP/JSON，无需任何 SDK。腾讯官方 npm 包 README 里**直接公布了后端接入协议**（端点、请求头、消息结构）。
2. **关键网络结论：手机与你的 PC 从不直连。** 微信 App 里的 ClawBot 插件、以及你的自定义后端，**两边都是"客户端"，都只出站连腾讯云 ilinkai.weixin.qq.com**（后端用 HTTP 长轮询拉消息）。因此**不需要公网 IP、不需要端口映射、不需要 Tailscale、不需要内网穿透**。127.0.0.1 只关系到 DSH 自己的 Web 控制台。
3. **官方 npm 包是"OpenClaw 渠道插件"，不是独立 SDK**：它跑在 OpenClaw 网关进程内（peerDependencies: openclaw >=2026.5.12），但它的代码可被剥离复用。社区项目就是把它"剥"出来，用约 200~700 行代码直连 iLink，彻底不装 OpenClaw。
4. **微信设置里的"ClawBot 栏"不能配置网关/baseURL/模型/API key**，它只做一件事：扫码绑定/解绑（可选输入数字"配对码"）。所有模型、baseURL、API key 都配置在**后端（你的 DSH）这一侧**。
5. **最小协议集非常小**：登录用 2 个 GET（get_bot_qrcode、get_qrcode_status），收发消息用 2 个 POST（getupdates 长轮询、sendmessage）。文本机器人 MVP 约 500~700 行代码。
6. **两个硬约束必须知道**：① 登录 token/会话有效期约 **24 小时**，到期要重新扫码续连；② 用户主动发消息后，后端在接下来 24h 内**最多只能主动发 10 条**（含回复），属于"反主动推送"配额。

---

## 1. 总体架构：手机、腾讯云、后端三者关系

    ┌─────────────┐  出站 HTTPS    ┌──────────────────────┐   出站 HTTPS    ┌──────────────┐
    │  微信 App    │ ─────────────▶ │  腾讯 iLink 云         │ ◀────────────── │  你的后端 DSH │
    │ (ClawBot 插件)│               │ ilinkai.weixin.qq.com │ (长轮询 getupdates)│ (PC, 127.0.0.1)│
    └─────────────┘                └──────────────────────┘                 └──────────────┘
      扫码绑定（二维码指向 liteapp.weixin.qq.com，腾讯自己的小程序，非局域网地址）

- 手机端 ClawBot 插件是腾讯云的一个客户端；你的后端也是腾讯云的另一个客户端。
- 双方通过腾讯云**中继**收发消息，**没有 P2P、没有入站端口**。
- 绑定动作：后端请求腾讯云生成二维码 → 用户在微信里扫/点这个二维码（URL 是 https://liteapp.weixin.qq.com/q/... ，指向微信自己的小程序）→ 微信侧弹出"是否绑定"确认（必要时显示一个数字配对码，后端侧输入该数字）→ 腾讯云发放 bot_token。

**对网络可达性的直接回答**：微信插件在手机上、DSH 在 PC 上，两者物理网络互不相通**没关系**——它们各自出站到腾讯云即可。DSH 只需要：① 能出站 HTTPS 访问 ilinkai.weixin.qq.com（443）；② 能出站访问你的 LLM/模型服务；③（可选）本机浏览器访问 DSH 的 127.0.0.1 控制台。

---

## 2. 官方 npm 包 @tencent-weixin/openclaw-weixin 分析（官方事实）

### 2.1 它是什么
- 名称/版本：@tencent-weixin/openclaw-weixin@2.4.6 ，描述 "OpenClaw Weixin channel"，作者 Tencent，MIT。
- package.json 关键字段（官方）：peerDependencies: { openclaw: ">=2026.5.12" } ；openclaw.channel.id = "openclaw-weixin" ；openclaw.install.npmSpec 表明它按插件安装进 OpenClaw；ilink_appid: "bot"。
- 结论：**它是 OpenClaw 渠道插件（跑在网关进程内），不是独立可编程 SDK**。入口 index.ts 里 register(api){ api.registerChannel({ plugin: weixinPlugin }) } ，且启动时校验宿主 OpenClaw 版本（assertHostCompatibility）。
- 但它的 README 明文写了 **Backend API Protocol**（见下），等于官方把后端协议公开了。

### 2.2 关键常量（来自源码 src/auth/accounts.ts，官方）
    DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"        // iLink 主网关
    CDN_BASE_URL    = "https://novac2c.cdn.weixin.qq.com/c2c" // 媒体 CDN

### 2.3 请求头（来自 src/api/api.ts，官方）
    Content-Type: application/json
    AuthorizationType: ilink_bot_token
    X-WECHAT-UIN: base64(String(randomUint32()))   // 每次请求随机，防重放
    iLink-App-Id: bot                              // 来自 package.json 的 ilink_appid
    iLink-App-ClientVersion: <0x00MMNNPP>          // 版本号编码为 uint32
    Authorization: Bearer <bot_token>              // 登录后才有
    SKRouteTag: <可选，IDC 路由标签>

### 2.4 端点全集（官方源码 api.ts / login-qr.ts）
| 端点 | 方法 | 用途 |
|---|---|---|
| /ilink/bot/get_bot_qrcode?bot_type=3 | GET | 获取登录二维码（返回 qrcode + qrcode_img_content） |
| /ilink/bot/get_qrcode_status?qrcode=xxx[&verify_code=yyy] | GET | 长轮询扫码状态 |
| /ilink/bot/getupdates | POST | **长轮询收消息**（hold 约 35s） |
| /ilink/bot/sendmessage | POST | 发消息（文本/图片/文件/视频/语音） |
| /ilink/bot/getuploadurl | POST | 获取 CDN 预签名上传参数 |
| /ilink/bot/getconfig | POST | 取 typing_ticket（正在输入用） |
| /ilink/bot/sendtyping | POST | 显示/取消"正在输入" |
| /ilink/bot/msg/notifystart / notifystop | POST | 客户端启停通知 |

### 2.5 登录/扫码流程（官方 src/auth/login-qr.ts）
1. POST /ilink/bot/get_bot_qrcode?bot_type=3 ，body { local_token_list: [...] } → 返回 { qrcode, qrcode_img_content } ；qrcode_img_content 是一个 https://liteapp.weixin.qq.com/q/... 链接（微信小程序）。
2. 终端渲染二维码 / 打印该链接，用户用微信扫/点。
3. GET /ilink/bot/get_qrcode_status?qrcode=xxx 轮询，状态机：wait / scaned / confirmed / expired / scaned_but_redirect / need_verifycode / verify_code_blocked / binded_redirect。
4. need_verifycode：微信侧显示一个数字"配对码"，用户在终端输入后通过 &verify_code= 回传。
5. confirmed：返回 bot_token、ilink_bot_id（形如 xxx@im.bot）、ilink_user_id（形如 xxx@im.wechat）、baseurl。保存 token 后续使用。

### 2.6 消息结构要点（官方 README + types.ts）
- WeixinMessage：from_user_id / to_user_id（@im.wechat / @im.bot 后缀）、message_type（1=用户 2=Bot）、message_state（0/1/2）、context_token、item_list、get_updates_buf 游标。
- item_list[].type：1 文本 / 2 图片 / 3 语音(silk) / 4 文件 / 5 视频。
- 媒体一律走 CDN，内容用 **AES-128-ECB** 加密（aes_key base64 随消息携带）。

---

## 3. 社区"免 OpenClaw"项目逐一分析

### 3.1 co-pine/wx-robot-ilink（Node/TS，最简参考实现）
- 仓库：https://github.com/co-pine/wx-robot-ilink（"基于腾讯 OpenClaw 微信协议直接对接微信，无需安装 OpenClaw"）。
- 依赖只有 openai + qrcode-terminal ，**完全不依赖 @tencent-weixin/openclaw-weixin**。
- 代码结构：src/weixin/auth.ts（扫码登录）、src/weixin/api.ts（getUpdates/sendTextMessage）、src/bot.ts（长轮询主循环）、src/ai/chat.ts（OpenAI 兼容对话）。
- 它 hardcode BASE_URL="https://ilinkai.weixin.qq.com" ，凭证存 data/credentials.json。
- **回答你的问题"server 端如何终止微信插件的连接？讲什么协议？公网还是局域网？"**：
    - 它**根本不是 server**，没有监听任何端口。它是个**客户端**，向腾讯云 ilinkai.weixin.qq.com 发 POST /ilink/bot/getupdates 长轮询（35s）拉消息，再 POST /ilink/bot/sendmessage 回消息。
    - 协议是 **HTTP/JSON 长轮询**（不是 WebSocket，也不是它自己开的服务）。
    - **既不需要公网也不需要局域网暴露**：跑在任意能出网的地方即可，手机侧完全无感知。
- 环境变量：OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL / SYSTEM_PROMPT（任何 OpenAI 兼容模型，含 DeepSeek/GLM/Qwen）。

### 3.2 codeenxi/weixin-ClawBot-API（Python + Node，双实现）
- 仓库：https://github.com/codeenxi/weixin-ClawBot-API（"免 openclaw 部署和登录，直接接入与调用"）。
- 同上基于 iLink 直连，提供 bot.py + bot.js；AI 侧封装成 Anthropic 兼容（x-api-key + /v1/messages，默认 DusAPI）。
- 新增能力：getconfig + sendtyping 显示"正在输入"、AI 失败梯度重试、config.json 交互式配置、**24 小时自动重连**（到期前预警 → 扫码换新 token）。
- 重要提示（社区实测）：iLink 连接有效期 **24 小时**；sendmessage 的 msg 结构缺字段会"HTTP 200 但不投递"（静默丢失），必须带上 from_user_id:""、client_id、message_type:2、message_state:2、context_token。

### 3.3 SiverKing/weixin-ClawBot-API（codeenxi 的增强 fork）
- 仓库：https://github.com/SiverKing/weixin-ClawBot-API。
- 增加 DeepSeek 等 provider 选择（deepseek.py，OpenAI-compatible /chat/completions）、/help /time /重新连接 指令、打包好的 exe。
- 补充了 2.x 协议细节：header 增加 iLink-App-Id: bot、iLink-App-ClientVersion，body 增加 base_info: { channel_version, bot_agent }。

### 3.4 hao-ji-xing/cc-weixin + weixin-bot-api.md（协议逆向文档）
- cc-weixin（npm cc-weixin）：https://github.com/hao-ji-xing/cc-weixin —— "在微信里使用 Claude Code Agent"，约 200 行核心，直连 iLink，用 @anthropic-ai/claude-agent-sdk 做 Agent，token 存 .weixin-token.json。
- weixin-bot-api.md（https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md）：社区对 iLink 协议的完整逆向/实测文档，含裸调 Demo（不依赖 openclaw 的纯 fetch 实现）。

### 3.5 其它佐证
- 腾讯云文章《微信 ClawBot 只能接入 Claw 应用？不，看明白协议，你可以随便玩坏它》：https://cloud.tencent.cn/developer/article/2646635 —— 作者用 Go 重写了 iLink 客户端（github.com/Andrew-M-C/go.util/tree/master/wechat/clawbot），并实测出 **10 条/24h 主动推送上限**。
- OSCHINA《逆向iLink协议剖析：微信ClawBot能力边界与技术死穴》：https://my.oschina.net/u/9487999/blog/19364268
- 今日头条《无需 OpenClaw，把微信 ClawBot 接入了自己的 AI Agent》：https://m.toutiao.com/article/7627116036186161673/ ；linux.do《如何给微信clawbot接入chatgpt》：https://linux.do/t/topic/2112186

---

## 4. 关键问题 A：微信"设置里的 ClawBot 栏"能配置什么？

**结论（官方源码 + 教程交叉验证）：手机上那栏只负责"绑定/解绑 + 查看状态"，不能填自定义网关/baseURL/模型/API key。**

- 绑定方式唯一：**扫码/点链接绑定**。二维码由后端请求腾讯云生成，URL 指向 https://liteapp.weixin.qq.com/q/... （微信自己的小程序），扫后微信弹出"是否绑定"确认；部分场景要求一个**数字配对码**（need_verifycode），该数字由微信侧显示、后端侧输入（见官方 login-qr.ts 的 readVerifyCodeFromStdin）。
- 官方登录命令是 openclaw channels login --channel openclaw-weixin（在 **PC 终端**出二维码），**不是**在手机里填配置。模型/baseURL/API key 全部配置在 PC 侧（OpenClaw 的 openclaw.json 或社区项目的 config.json / .env）。
- 手机端 ClawBot 栏可见/可操作的（据教程与协议推断）：已绑定 Bot 的列表/状态、连接/断开（解绑）、以及绑定时可能出现的配对码。**没有任何证据表明它能配置端点**——因为腾讯把"你连哪个 AI"这件事刻意放在后端侧（腾讯只是"管道"，见条款：不提供 AI 服务）。
- 一句话回答：**只能扫码配对（+ 输配对码），不能填自定义网关/模型/baseURL/API key。** 自定义后端这一层完全在你的 PC 上完成。

---

## 5. 关键问题 B：自定义后端必须实现的最小协议集

社区项目本质上都是"**迷你 iLink 客户端**"（替代 OpenClaw 网关的角色），需要实现的方法就这些：

**（A）登录（一次性 + 每 24h 续期）**
| 调用 | 说明 |
|---|---|
| GET /ilink/bot/get_bot_qrcode?bot_type=3 | 拿二维码，展示给用户扫 |
| GET /ilink/bot/get_qrcode_status?qrcode=xxx[&verify_code=yyy] | 轮询 wait→scaned→(need_verifycode)→confirmed，拿 bot_token/baseurl/ilink_bot_id/ilink_user_id |

**（B）收发（核心，必需）**
| 调用 | 说明 |
|---|---|
| POST /ilink/bot/getupdates  body { get_updates_buf, base_info } | 长轮询，hold 约 35s，返回 { ret, msgs[], get_updates_buf, longpolling_timeout_ms } |
| POST /ilink/bot/sendmessage  body { msg: {to_user_id, message_type:2, message_state:2, context_token, item_list:[{type:1,text_item:{text}}]}, base_info } | 发文本回复 |

**（C）可选增强**
| 调用 | 说明 |
|---|---|
| POST /ilink/bot/getconfig → 取 typing_ticket | 显示"正在输入"前置 |
| POST /ilink/bot/sendtyping  {status:1|2} | 开/关"正在输入"（几秒自动消失，需 5~8s 重发） |
| POST /ilink/bot/getuploadurl + CDN PUT | 发图片/文件/视频/语音（AES-128-ECB 加密，较复杂） |

**（D）每个请求必须带的 header**
    Content-Type: application/json
    AuthorizationType: ilink_bot_token
    X-WECHAT-UIN: base64(随机uint32的十进制字符串)
    iLink-App-Id: bot
    iLink-App-ClientVersion: <版本号uint32>
    Authorization: Bearer <bot_token>

**（E）三个易踩坑点（社区实测）**
1. context_token 必须**原样取自当前这条收到的消息**再回传，否则回复不落到正确会话窗口（codeenxi 补充：不传有时也行，但不可复用旧值）。
2. get_updates_buf 是游标，**每次必须更新**，否则重复收消息。
3. sendmessage 的 msg 字段要带全 from_user_id:""、client_id、message_type、message_state，缺字段会"200 但不投递"。

**结论**：不装 OpenClaw 时，自定义后端要做的是一个"**出站 HTTP 长轮询客户端**"，最小化（纯文本单账号）约 **500~700 行**（登录约 150 + 轮询收发约 250 + 模型适配约 100 + 状态/重试约 150）。

---

## 6. 网络可达性：详细结论

| 方案 | 是否必需 | 说明 |
|---|---|---|
| 公网 IP / 端口映射 | **不需要** | 后端只出站连腾讯云，没有入站监听 |
| Tailscale / 内网穿透 (frp/ngrok) | **不需要** | 手机与 PC 不直连，穿透无处可用 |
| 局域网 IP | **不需要**（且无意义） | 手机从不访问 PC 的地址 |
| PC 出站 HTTPS 到 ilinkai.weixin.qq.com | **必需** | iLink 云网关 |
| PC 出站到 LLM 服务（DSH 本地或云） | **必需** | 模型调用 |
| 本机浏览器访问 DSH 127.0.0.1 | 仅控制台 | 与微信无关 |

**为什么你担心的"127.0.0.1 可达性"不是问题**：微信插件和 DSH 之间隔着腾讯云，二者各自的公网可达性由各自的上行网络保证，互不依赖。DSH 的 127.0.0.1 只服务于本机浏览器/本机调用，微信侧永远看不到这个地址。

**一个反向提醒**：若将来有人宣称"把微信 ClawBot 指向自建网关"，那是要实现腾讯云的**服务端**（即自己伪造 ilinkai.weixin.qq.com），既不现实也违反条款——正确做法始终是"作为客户端接入腾讯云，把 AI 这一侧换成 DSH"。

---

## 7. 微信直连 DSH、不经 OpenClaw 的可行方案清单

### 方案 A（推荐）：DSH 内置一个"微信 iLink 渠道"（原生集成）
- 在 DSH 内新增 channel：登录(QR) + 长轮询 + sendmessage + 会话路由到 DSH agent。
- 二维码渲染到 DSH Web 控制台（用户扫码），token 持久化，24h 自动重连。
- 优点：最贴合"微信直连 DSH"，会话/记忆/工具全走 DSH；缺点：要写 DSH 渠道代码。
- 工作量：MVP 2~3 人日，生产级 5~8 人日（见第 8 节）。

### 方案 B（最快 MVP）：复用 wx-robot-ilink，把它指向 DSH 的 OpenAI 兼容端点
- 若 DSH 暴露 /v1/chat/completions（或 /v1/messages），直接把 .env 的 OPENAI_BASE_URL 指向 http://127.0.0.1:<DSH端口>/v1、OPENAI_MODEL 填 DSH 的模型。
- 零/极少新代码（改配置即可）；桥进程与 DSH 同机，走 localhost。
- 缺点：能力受限于桥项目的会话实现（每用户一个 memory，无 DSH 原生工具/多 agent 编排）。

### 方案 C：独立桥接进程 + 本地事件接口（解耦、可替换）
- 起一个"iLink↔本地"桥（复用 cc-weixin / wx-robot-ilink 骨架），把收发的微信消息通过本地 HTTP/WebSocket 转发给 DSH 的 channel/agent。
- 优点：桥可独立重启/升级，DSH 只消费一个简单本地接口；缺点：多一个常驻进程 + 一层协议。

### 方案 D：写一个"OpenClaw 兼容 shim"（不推荐）
- 满足官方插件的宿主 API（plugin-sdk 的 registerChannel 等）让它以为自己在 OpenClaw 里跑。
- 优点：能直接复用官方插件全能力（含媒体）；缺点：要逆向 OpenClaw 插件 SDK 接口，成本高、随版本漂移，得不偿失。

**推荐路径**：先用**方案 B** 一天内打通"微信↔DSH"闭环验证，再按需投入**方案 A** 做原生集成。

---

## 8. 实现工作量估计

| 范围 | 内容 | 估计 |
|---|---|---|
| 方案 B（配置接入） | 复用 wx-robot-ilink 指向 DSH 端点 | 0.5~1 人日 |
| 方案 A MVP（原生渠道） | QR 登录 + 长轮询 + 文本收发 + 会话路由到 DSH agent + token 持久化 | 2~3 人日 |
| + 生产加固 | 24h 自动重连（含扫码 UX）、错误/退避重试、多账号、游标持久化、上下文隔离 | +2~3 人日（共 5~6） |
| + 体验 | 正在输入(typing)、/指令、引用回复、长文本分片 | +1~2 人日 |
| + 媒体 | 图片/文件：AES-128-ECB + getuploadurl + CDN 上传；语音 silk 转码 | +3~5 人日（难度主要在这里） |
| 完整对齐官方插件 | 多账号、媒体全类型、群聊（group_id）、监控上报 | 2~3 人周 |

**注意点**：
- 24h 重连无法"全自动免打扰"——用户必须重新扫码（官方也是扫码续期），DSH 需在控制台弹出二维码提醒。
- 媒体（尤其图片加密上传）是最大的隐性工作量，MVP 建议先只做文本 + 图片接收（接收侧解密可后续补）。

---

## 9. 风险与合规（务必知会用户）

1. **24 小时会话有效期**：token/连接每 24h 过期，需重新扫码；ilink_bot_id 每次重扫会变（社区实测）。
2. **主动推送配额**：用户发消息后，24h 内最多主动发 10 条（含回复）；用户再发消息则配额重置为 10（腾讯云文章实测）。适合"应答式助手"，不适合无上限主动推送/通知轰炸。
3. **腾讯条款**（《微信 ClawBot 功能使用条款》）：腾讯只是"管道"，可随时限速/拦截/终止；禁止绕过微信技术保护措施；不存储消息内容但收集 IP/设备/操作日志。不要用于核心业务、不要高频骚扰。
4. **群聊/媒体**：群聊需 group_id 且可能有额外权限；媒体需完整 CDN 加密流程。
5. **协议随版本漂移**：以上端点/字段基于 @tencent-weixin/openclaw-weixin@2.4.6 与社区 2026-03~05 实测，官方可能迭代；上线前用当前版本 src/api/api.ts 再核对一次。

---

## 10. 来源清单

- 官方包（源码级，事实依据）：npm @tencent-weixin/openclaw-weixin@2.4.6 —— README、src/api/api.ts、src/auth/login-qr.ts、src/auth/pairing.ts、src/auth/accounts.ts、src/config/config-schema.ts、index.ts；https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin （unpkg/jsdelivr 直取）。
- 官方 CLI：npm @tencent-weixin/openclaw-weixin-cli（仅安装器，非独立协议客户端）。
- co-pine/wx-robot-ilink：https://github.com/co-pine/wx-robot-ilink
- codeenxi/weixin-ClawBot-API：https://github.com/codeenxi/weixin-ClawBot-API
- SiverKing/weixin-ClawBot-API：https://github.com/SiverKing/weixin-ClawBot-API
- hao-ji-xing/openclaw-weixin（weixin-bot-api.md / protocol.md）：https://github.com/hao-ji-xing/openclaw-weixin
- hao-ji-xing/cc-weixin（npm cc-weixin）：https://github.com/hao-ji-xing/cc-weixin
- 腾讯云《微信 ClawBot 只能接入 Claw 应用？不，看明白协议…》：https://cloud.tencent.cn/developer/article/2646635 （10 条/24h 限制出处；Go 重写：github.com/Andrew-M-C/go.util/tree/master/wechat/clawbot）
- OSCHINA《逆向iLink协议剖析：微信ClawBot能力边界与技术死穴》：https://my.oschina.net/u/9487999/blog/19364268
- OpenClaw 微信渠道官方文档：https://docs.openclaw.ai/channels/wechat （zh-CN）
- 今日头条《无需 OpenClaw，把微信 ClawBot 接入了自己的 AI Agent》：https://m.toutiao.com/article/7627116036186161673/
- linux.do《如何给微信clawbot接入chatgpt》：https://linux.do/t/topic/2112186
