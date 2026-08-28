# 微信 Claw Bot(@tencent-weixin/openclaw-weixin)

基于腾讯官方开放的 **openclaw-weixin**/**openclaw-weixin-api**/**openclaw-weixin-cli** 实现的微信个人账号 Bot，支持接入任意 AI 模型，实现微信自动对话。

---

## 简介

2026 年腾讯通过 [OpenClaw](https://docs.openclaw.ai) 平台正式开放了微信个人账号的 Bot API，官方名称为 **微信 ClawBot 插件功能**，底层协议为 **iLink**，接入域名 `ilinkai.weixin.qq.com` 为腾讯官方服务器。

本项目提供 Python 和 Node.js 两种实现，可直接接入 DusAPI、DeepSeek 等 AI 接口，实现收到微信消息后自动 AI 回复。**免 openclaw 部署和登录，直接接入与调用。**

---

## 功能

- 扫码登录微信（支持终端二维码渲染，缺少依赖时回退二维码链接）
- 长轮询实时接收消息
- 调用 AI 接口生成回复（Python 版支持 DusAPI / DeepSeek provider 选择）
- 发送前显示"正在输入"状态
- 内置梯度重试（AI 接口失败自动重试）
- **配置文件管理**：单个 `config.json` 分 provider 存放配置，启动时选择 AI 提供商，API Key 脱敏显示
- **24 小时自动重连**：到期前预警 → 用户确认 → 无缝切换新连接，全程不断线
- **Bot 指令系统**：`/help` `/指令` 查看指令列表，`/time` 查询剩余连接时间，`/重新连接` 手动触发重连，首次交互自动推送指令列表

---

## 文件结构

```
.
├── bot.py         # Python 实现（推荐）
├── bot.js         # Node.js 实现
├── dusapi.py      # AI 接口封装（Python，兼容 Anthropic 格式）
├── deepseek.py    # DeepSeek 接口封装（Python，OpenAI-compatible）
├── requirements.txt
├── config.json    # 配置文件（首次运行自动生成，勿提交到版本控制）
└── README.md
```

---

## 快速开始

> **懒得折腾？** 直接下载打包好的 exe 使用：[Releases](https://github.com/SiverKing/weixin-ClawBot-API/releases)

### Python 版

**安装依赖：**
```bash
pip install -r requirements.txt
```

**运行：**
```bash
python bot.py
```

首次运行会先选择 AI 提供商，再引导填写该提供商的 API Key、接口地址、模型和系统提示词。

---

### Node.js 版

**要求：** Node.js 18+

**配置 `package.json`（如不存在则创建）：**
```json
{ "type": "module" }
```

**运行：**
```bash
node bot.js
```

---

### 登录流程

1. 运行后先选择 AI 提供商，并确认或创建对应配置
2. 配置完成后终端打印扫码地址，并在安装 `qrcode[pil]` / `Pillow` 时直接渲染二维码
3. 手机微信扫码或打开链接，按提示连接
4. 如微信要求数字配对码，按终端提示输入手机端显示的数字
5. 扫码确认后终端显示"登录成功"及可用指令列表
6. 在微信中向 Bot 发送第一条消息，Bot 自动回复指令列表
7. 之后的消息均由 AI 自动回复

---

## 配置文件（config.json）

首次运行自动生成，所有 AI provider 配置都存放在同一个文件里，通过 `provider` 指定当前启用项。旧版扁平配置会自动迁移到 `providers.dusapi`。

```json
{
  "provider": "deepseek",
  "providers": {
    "dusapi": {
      "api_key": "your-dusapi-key",
      "base_url": "https://api.dusapi.com",
      "model": "gpt-5",
      "prompt": "你是一个有帮助的AI助手，请用中文简洁地回复。字数尽量少一些"
    },
    "deepseek": {
      "api_key": "your-deepseek-key",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-v4-flash",
      "prompt": "你是一个有帮助的AI助手，请用中文简洁地回复。字数尽量少一些"
    }
  }
}
```

再次运行时会先选择提供商，再显示该提供商配置（API Key 仅显示首尾各 5 位），选择继续、重新配置或切换提供商：

```
请选择 AI 提供商：
  1. DusAPI
  2. DeepSeek （默认）

============================================================
  当前选择：DeepSeek
  当前配置如下：
============================================================
  API Key  : sk-d0*****************************e8c5c
  API 地址 : https://api.deepseek.com
  模型     : deepseek-v4-flash
  提示词   : 你是一个有帮助的AI助手，请用中文简洁地回复。字数尽量...
------------------------------------------------------------

使用此配置继续？(直接回车或输入 Y 继续 / 输入 N 重新配置 / 输入 S 切换提供商):
```

### AI provider

| Provider | 文件 | 接口格式 | 默认地址 | 默认模型 |
|---|---|---|---|---|
| DusAPI | `dusapi.py` | Anthropic `/v1/messages` | `https://api.dusapi.com` | `gpt-5` |
| DeepSeek | `deepseek.py` | OpenAI-compatible `/chat/completions` | `https://api.deepseek.com` | `deepseek-v4-flash` |

DeepSeek 调用使用 `Authorization: Bearer <api_key>`，普通聊天默认关闭 `deepseek-v4-flash` 的 thinking。

---

## 24 小时自动重连

iLink 连接有效期为 24 小时，Bot 内置全自动续连机制。

### 流程

```
登录成功 → 开始 24h 倒计时
  ↓（剩余 2h 时）
向最近聊天用户发送预警：是否现在重新连接？(Y/N)
  ├─ 回复 Y → 立即重连，发送新二维码
  ├─ 回复 N → 每 30 分钟再次询问
  └─ 最后 30 分钟 → 强制重连，无需确认
扫码成功 → 新 token 原子替换，旧连接无缝切换，不掉线
```

### 可调参数（顶部 `RECONNECT_CONFIG`）

测试时可将数值改小，无需等 24 小时验证流程：

| 参数 | 说明 | 生产默认值 | 测试建议值 |
|---|---|---|---|
| `session_duration` | 会话总时长（秒） | `24 * 3600` | `300` |
| `warning_before` | 提前多久发警告（秒） | `2 * 3600` | `60` |
| `reminder_interval` | 回复 N 后多久再问（秒） | `30 * 60` | `30` |
| `force_before` | 最后多久强制重连（秒） | `30 * 60` | `60` |
| `qrcode_scan_timeout` | 等待扫码最长时间（秒） | `600` | `120` |

**Python 示例（测试配置）：**
```python
RECONNECT_CONFIG = {
    "session_duration":    300,
    "warning_before":       60,
    "reminder_interval":    30,
    "force_before":         60,
    "qrcode_scan_timeout": 120,
}
```

---

## Bot 指令

| 指令 | 说明 |
|---|---|
| `/help` 或 `/指令` | 查看全部指令列表 |
| `/time` | 查询当前连接剩余时间 |
| `/重新连接` | 手动触发重新连接（发送后需回复 Y 确认 / N 取消） |

**说明：**
- 用户首次发送消息时，Bot 自动回复可用指令列表
- `/重新连接` 发出后 Bot 会询问确认，回复 Y 立即重连并发送新二维码，回复 N 取消；若重连正在进行中则提示等待
- 非指令内容均转发给 AI 接口处理
- 后续如需扩展指令，在消息循环中添加对应分支，并更新 `COMMANDS_MSG` 常量即可

---

## AI 接口说明（dusapi.py）

`DusAPI` 封装了兼容 Anthropic 格式的 HTTP 接口，支持所有使用 `x-api-key` + `/v1/messages` 格式的服务，包括：

- [DusAPI](https://dusapi.com)（兼容多模型）
- Anthropic 官方 API
- 其他 Anthropic 格式的第三方代理

**DusConfig 参数：**

| 参数 | 说明 | 默认值 |
|---|---|---|
| `api_key` | API 密钥 | 必填 |
| `base_url` | 接口地址 | 必填 |
| `model1` | 模型名称 | `claude-sonnet-4-5` |
| `prompt` | 系统提示词 | `你是一个有帮助的AI助手。` |

---

## iLink Bot API 核心说明

### 请求头

每个请求都需要携带以下 Header：

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <随机uint32转base64，每次请求重新生成>
iLink-App-Id: bot
iLink-App-ClientVersion: <2.x 客户端版本号>
Authorization: Bearer <bot_token>
```

Python 版当前按 openclaw-weixin 2.x 风格补充 `base_info`：

```json
{
  "channel_version": "2.4.3",
  "bot_agent": "weixin-ClawBot-API/1.0.1 (python)"
}
```

### 消息收发流程

```
POST getupdates（长轮询，服务器 hold 35s）
  └─ 收到用户消息
       ├─ [手动重连待确认] Y → 立即重连 / N → 取消
       ├─ [定时预警待确认] Y → 触发重连 / N → 推迟提醒
       ├─ [首次] 发送指令列表，等待下一条消息
       ├─ [/help 或 /指令] 返回指令列表
       ├─ [/time] 返回剩余时间
       ├─ [/重新连接] 发送 Y/N 确认提示
       ├─ POST getconfig  → 获取 typing_ticket（每用户缓存，有效24h）
       ├─ POST sendtyping { status: 1 }  → 显示"正在输入"
       ├─ 调用 AI 接口
       ├─ POST sendmessage  → 发送回复
       └─ POST sendtyping { status: 2 }  → 取消"正在输入"
```

### sendmessage 必填字段

官方 SDK 要求 `sendmessage` 包含以下完整结构，缺少任意字段会导致消息静默丢失（HTTP 200 但不投递）：

```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<用户ID@im.wechat>",
    "client_id": "openclaw-weixin-<随机hex>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<从收到的消息中原样取>",
    "item_list": [
      { "type": 1, "text_item": { "text": "回复内容" } }
    ]
  },
  "base_info": {
    "channel_version": "2.4.3",
    "bot_agent": "weixin-ClawBot-API/1.0.1 (python)"
  }
}
```

> **注意**：`context_token` 必须使用当前收到消息中的值，不可复用旧消息的 token。

---

## 注意事项

1. **每次扫码登录 Bot ID 会变化**，这是 iLink 平台的设计，属于正常现象。
2. **仅限合规使用**，需遵守《微信 ClawBot 功能使用条款》，腾讯保留对内容过滤和限速的权利。
3. 本项目仅支持**文本消息**，图片/语音/文件等媒体消息需额外实现 CDN 加密上传流程。
4. Bot 不建议用于核心业务，腾讯可随时变更或终止该服务。
5. `config.json` 含有 API Key，**请勿提交到版本控制**（已在 `.gitignore` 中排除）。

---

## 依赖

| 环境 | 依赖 |
|---|---|
| Python | 见 `requirements.txt`：`aiohttp`、`requests`、`qrcode[pil]`、`pyinstaller`（打包用） |
| Node.js | 无需额外安装（Node.js 18+ 内置 fetch 和 readline） |

---

## 相关资源

- [OpenClaw 官方文档](https://docs.openclaw.ai)
- [官方 npm 包](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
- [DusAPI（兼容多模型的 AI 接口）](https://dusapi.com)
