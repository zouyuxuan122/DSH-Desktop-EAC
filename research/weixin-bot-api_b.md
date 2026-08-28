# 微信 Bot API 技术解析：腾讯 iLink 协议首次合法开放

> 2026 年，微信终于开放了合法的个人 Bot API。本文通过逆向分析 `@tencent-weixin/openclaw-weixin` 源码，完整还原了这套 **iLink Bot 协议**的技术细节，并给出可运行的裸调 Demo。

---

## 一、背景：这是历史性时刻

在此之前，开发者想让程序控制微信，只有两条路：

| 方式 | 典型实现 | 性质 |
|---|---|---|
| 逆向 iPad 协议 | WeChatPadPro、itchat | 灰色地带，违反协议，随时封号 |
| PC 客户端 Hook | 注入 DLL、内存读写 | 违法，高封号风险 |
| 企业微信 API | 官方开放，但只面向企业 | 合法，但不是"微信" |

**现在不同了。** 腾讯通过 [OpenClaw](https://docs.openclaw.ai)（一个 AI Gateway 框架）正式开放了微信个人账号的 Bot API，官方名称叫 **微信 ClawBot 插件功能**，底层协议叫 **iLink**（智联），接入域名是 `ilinkai.weixin.qq.com`——腾讯的官方服务器。

腾讯为此发布了专项使用条款《微信ClawBot功能使用条款》，签订地为深圳市南山区，适用中国大陆地区法律。这不是灰色地带——**这是腾讯的官方产品，有法律文件背书**。

---

## 二、两个 npm 包

腾讯在 npm 上发布了两个包，scope 为 `@tencent-weixin`：

### `@tencent-weixin/openclaw-weixin-cli`（v1.0.2）

一个 **CLI 安装工具**，3 个文件，核心是 `cli.mjs`。作用是：

1. 检测本机是否安装了 `openclaw` CLI
2. 调用 `openclaw plugins install "@tencent-weixin/openclaw-weixin"` 安装插件
3. 触发 `openclaw channels login` 引导扫码
4. 重启 OpenClaw Gateway

```bash
npx @tencent-weixin/openclaw-weixin-cli install
```

### `@tencent-weixin/openclaw-weixin`（v1.0.2）

这是真正的**协议实现包**，41 个 TypeScript 源文件，完整实现了 iLink Bot 协议的所有能力：

```
src/
├── auth/          # QR 码登录、账号存储
├── api/           # iLink HTTP API 封装
├── cdn/           # 媒体文件 AES-128-ECB 加解密 + CDN 上传
├── messaging/     # 消息收发、inbound/outbound 处理
├── monitor/       # 长轮询主循环
├── config/        # 配置 schema
└── storage/       # 状态持久化
```

---

## 三、iLink Bot API 协议详解

腾讯开放的接口全部在 `https://ilinkai.weixin.qq.com` 下，HTTP/JSON 协议，无需 SDK，可直接 `fetch` 调用。

### 3.1 鉴权流程

```
开发者               iLink 服务器               微信用户
   │                      │                        │
   │── GET get_bot_qrcode ──▶│                        │
   │◀──── { qrcode, url } ──│                        │
   │                      │◀─── 用户扫码 ────────────│
   │── GET get_qrcode_status ──▶│（长轮询）              │
   │◀── { status: "confirmed",  │                        │
   │      bot_token, baseurl } ──│                        │
   │                      │                        │
   │  持久化 bot_token，后续所有请求 Bearer 鉴权         │
```

**请求头固定套路：**

```javascript
{
  "Content-Type": "application/json",
  "AuthorizationType": "ilink_bot_token",
  "X-WECHAT-UIN": base64(String(randomUint32())),  // 每次随机
  "Authorization": `Bearer ${bot_token}`            // 登录后才有
}
```

`X-WECHAT-UIN` 是个特殊设计：随机生成一个 uint32，转十进制字符串，再 base64 编码。每次请求都变，起到防重放的作用。

### 3.2 完整 API 列表

| Endpoint | Method | 功能 |
|---|---|---|
| `/ilink/bot/get_bot_qrcode` | GET | 获取登录二维码（`?bot_type=3`） |
| `/ilink/bot/get_qrcode_status` | GET | 轮询扫码状态（`?qrcode=xxx`） |
| `/ilink/bot/getupdates` | POST | **长轮询收消息**（核心） |
| `/ilink/bot/sendmessage` | POST | 发送消息（文字/图片/文件/视频/语音） |
| `/ilink/bot/getuploadurl` | POST | 获取 CDN 预签名上传地址 |
| `/ilink/bot/getconfig` | POST | 获取 typing_ticket |
| `/ilink/bot/sendtyping` | POST | 发送"正在输入"状态 |

CDN 域名：`https://novac2c.cdn.weixin.qq.com/c2c`

### 3.3 消息收取：长轮询机制

与 Telegram Bot API 的 `getUpdates` 一模一样的设计：

```javascript
POST /ilink/bot/getupdates
{
  "get_updates_buf": "<上次返回的游标，首次为空字符串>",
  "base_info": { "channel_version": "1.0.2" }
}
```

服务器会**hold 住连接最多 35 秒**，直到有新消息才返回。响应体：

```json
{
  "ret": 0,
  "msgs": [ ...WeixinMessage[] ],
  "get_updates_buf": "<新游标，下次请求带上>",
  "longpolling_timeout_ms": 35000
}
```

**`get_updates_buf` 是关键**，类似数据库的 cursor，必须每次更新，否则会重复收到消息。

### 3.4 消息结构

每条消息（`WeixinMessage`）的核心字段：

```json
{
  "from_user_id": "o9cq800kum_xxx@im.wechat",
  "to_user_id": "e06c1ceea05e@im.bot",
  "message_type": 1,
  "message_state": 2,
  "context_token": "AARzJWAFAAABAAAAAAAp...",
  "item_list": [
    {
      "type": 1,
      "text_item": { "text": "你好" }
    }
  ]
}
```

**ID 格式规律：**
- 用户 ID：`xxx@im.wechat`
- Bot ID：`xxx@im.bot`

**消息类型（item_list[].type）：**

| type | 含义 |
|---|---|
| 1 | 文本 |
| 2 | 图片（CDN 加密存储） |
| 3 | 语音（silk 编码，附带转文字） |
| 4 | 文件附件 |
| 5 | 视频 |

### 3.5 context_token：对话关联的核心

这是整个协议里最关键的细节，也是最容易踩坑的地方。

**每条收到的消息都带有 `context_token`**，你在回复时**必须原样带上这个 token**，否则消息不会关联到正确的对话窗口。

```javascript
// 发送消息时必须带上 context_token
POST /ilink/bot/sendmessage
{
  "msg": {
    "to_user_id": "o9cq800kum_xxx@im.wechat",
    "message_type": 2,       // BOT 发出
    "message_state": 2,      // FINISH（完整消息）
    "context_token": "<从 inbound 消息里取>",  // ← 必填！
    "item_list": [
      { "type": 1, "text_item": { "text": "你好！" } }
    ]
  }
}
```

### 3.6 媒体文件：AES-128-ECB 加密

微信 CDN 上的所有媒体文件都经过 **AES-128-ECB** 加密：

```typescript
// 上传前加密
const encrypted = encryptAesEcb(fileBuffer, aesKey);
// CDN 下载后解密
const plaintext = decryptAesEcb(encryptedBuffer, aesKey);
```

发送图片的完整流程：
1. 生成随机 AES-128 key
2. 用 AES-128-ECB 加密文件
3. 调用 `getuploadurl` 获取预签名 URL
4. PUT 加密文件到 CDN
5. 在 `sendmessage` 中带上 `aes_key`（base64）和 CDN 引用参数

---

## 四、与旧方案的本质区别

| 维度 | 旧方案（WeChatPadPro 等） | iLink Bot API |
|---|---|---|
| 合法性 | 违反微信服务协议，灰色地带 | **官方开放，合法** |
| 稳定性 | 每次微信更新可能失效 | 服务器端 API，稳定 |
| 封号风险 | 极高，随时可能被封 | 正常使用无封号风险 |
| 协议层 | 模拟 iPad/移动端协议 | HTTP/JSON，标准接口 |
| 媒体支持 | 有限 | 图片/语音/文件/视频完整支持 |
| 群聊 | 需要特殊处理 | 原生支持（`group_id` 字段） |

---

## 五、最简裸调 Demo

以下是不依赖 `openclaw` 的纯 HTTP 实现（完整代码见仓库 `demo.mjs`）：

```javascript
const BASE_URL = "https://ilinkai.weixin.qq.com";

// 1. 登录：获取 QR 码
const { qrcode, qrcode_img_content } = await fetch(
  `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`
).then(r => r.json());

// 2. 等待扫码
let botToken, botBaseUrl;
while (true) {
  const status = await fetch(
    `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`
  ).then(r => r.json());

  if (status.status === "confirmed") {
    botToken = status.bot_token;
    botBaseUrl = status.baseurl;
    break;
  }
  await sleep(1000);
}

// 3. 长轮询收消息
let getUpdatesBuf = "";
while (true) {
  const { msgs, get_updates_buf } = await apiPost(
    "ilink/bot/getupdates",
    { get_updates_buf: getUpdatesBuf },
    botToken
  );
  getUpdatesBuf = get_updates_buf ?? getUpdatesBuf;

  for (const msg of msgs ?? []) {
    if (msg.message_type !== 1) continue; // 只处理用户消息
    const text = msg.item_list?.[0]?.text_item?.text;

    // 4. 回复（必须带 context_token）
    await apiPost("ilink/bot/sendmessage", {
      msg: {
        to_user_id: msg.from_user_id,
        message_type: 2,
        message_state: 2,
        context_token: msg.context_token,
        item_list: [{ type: 1, text_item: { text: `回复：${text}` } }]
      }
    }, botToken);
  }
}
```

---

## 六、接入 Claude Code Agent

配合 Anthropic 的 `@anthropic-ai/claude-agent-sdk`，可以在 15 分钟内搭出一个有实际能力的 AI 助手：

```javascript
import { query } from "@anthropic-ai/claude-agent-sdk";

async function askClaude(userText) {
  async function* messages() {
    yield {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: userText },
    };
  }

  let result = "";
  for await (const msg of query({
    prompt: messages(),
    options: {
      model: "sonnet",
      baseTools: [{ preset: "default" }],  // Bash, Read, WebSearch...
      deniedTools: ["AskUserQuestion"],
      cwd: process.cwd(),
      env: process.env,
      abortController: new AbortController(),
    },
  })) {
    if (msg.type === "result") result = msg.result ?? "";
  }
  return result;
}

// 收到微信消息后
const reply = await askClaude(inboundText);
await sendWeixinMessage(toUserId, reply, contextToken);
```

测试结果（本文写作时实测）：

> 用户发：「告诉我现在我是什么电脑，什么电量」
>
> Claude 调用 Bash 工具执行 `system_profiler`、`pmset -g batt`，回复了完整的机型 + 电量信息。

---

## 七、官方条款：你需要知道的边界

腾讯随这套 API 发布了《微信ClawBot功能使用条款》，有几条技术开发者必须了解：

### 7.1 腾讯只是"管道"，不是 AI 服务提供商

条款原文（3.2）：
> 我们仅提供微信ClawBot插件与第三方AI服务的信息收发，不存储你的输入内容与输出结果，不提供AI相关服务。

这意味着腾讯的定位非常清晰：**iLink 只是一条消息通道**。你接入的 Claude、GPT 等 AI 服务由你自己负责，腾讯不对 AI 的输出结果承担任何责任。

### 7.2 腾讯保留控制权

条款（4.7）：
> 我们有权决定支持本功能的微信软件客户端类型以及可使用本功能的条件、范围等规则，**有权决定你可连接的第三方AI服务的类型、范围、信息收发规模或频率等事项**，有权对你的输入内容、输出结果及技术连接等信息或行为进行识别，并根据安全或风险情况进行处置，采取风险提示、拦截、阻断等安全措施。

翻译成技术语言：
- 腾讯可以随时限速或封禁特定 AI 服务的接入
- 腾讯可以对内容进行过滤/拦截
- 腾讯可以终止你的连接

### 7.3 数据隐私：腾讯不存储内容，但收集日志

| 数据类型 | 处理方式 |
|---|---|
| 你发送的消息（文字/图片/语音/视频/文件） | 转发给第三方 AI，**不在腾讯服务器存储** |
| AI 返回的输出结果 | 转发给你，**不在腾讯服务器存储** |
| IP 地址、操作记录、设备信息 | **会被收集**，用于安全审计（条款 5.3） |

### 7.4 禁止行为（重要）

条款（4.6）明确禁止：
- 利用本功能**绕过、破解微信软件的技术保护措施**
- 违反国家法律法规
- 危害网络安全、数据安全及微信产品安全
- 侵犯他人合法权益

### 7.5 腾讯可以随时终止服务

条款（7.2）：
> 腾讯有权根据业务发展需要，自行决定变更、中断、中止或终止本功能服务。

这意味着**不应将核心业务完全依赖这套 API**，需要有降级方案。

---

## 八、技术层面的限制与未知

1. **`bot_type=3` 的含义未完全明确** — 源码硬编码了这个值，可能对应特定的微信账号类型或套餐
2. **需要 OpenClaw 账号体系** — 登录流程需要连接腾讯的 iLink 服务器，目前推测需要通过 OpenClaw 平台审核或注册
3. **群聊支持** — 源码有 `group_id` 字段和 `ChatType: "direct"` 的注释，群聊可能需要额外权限
4. **消息历史** — 没有拉取历史消息的 API，只有 `get_updates_buf` 游标机制
5. **速率限制** — 官方未公开，需要实测

---

## 九、合规前提下能做什么

基于这套 API，可以合法构建：

- **个人 AI 助手** — 直接在微信里使用 Claude / GPT（已实测）
- **通知机器人** — 监控报警、部署状态推送到微信
- **客服系统** — 多账号管理 + 自动分流
- **工作流自动化** — 接收微信指令触发 CI/CD、文件处理等
- **家庭群助手** — 家庭群内的 AI 助手
- **个人知识库** — 发消息自动归档到 Notion/飞书

---

## 十、资源

| 资源 | 链接 |
|---|---|
| 本文 Demo 仓库 | https://github.com/hao-ji-xing/openclaw-weixin |
| OpenClaw 文档 | https://docs.openclaw.ai |
| 插件包 npm | https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin |
| CLI 包 npm | https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin-cli |

---

*本文基于对 `@tencent-weixin/openclaw-weixin@1.0.2` 源码的分析和实测，截止 2026 年 3 月。API 设计可能随版本迭代变化。*
