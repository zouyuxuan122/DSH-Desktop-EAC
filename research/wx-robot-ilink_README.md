# wx-robot-ilink

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-Compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/)
[![WeChat](https://img.shields.io/badge/WeChat-iLink_API-07C160?logo=wechat&logoColor=white)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

一个极简的微信 AI 聊天机器人。基于腾讯 [OpenClaw 微信协议](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) 直接对接微信，无需安装 OpenClaw 框架，支持任何兼容 OpenAI 接口的 AI 模型。

## ✨ 特性

- **零框架依赖** — 直接对接微信 iLink API，不依赖 OpenClaw 运行时
- **兼容多种 AI 模型** — OpenAI、智谱 GLM、DeepSeek、通义千问等任何兼容 OpenAI 接口的模型
- **扫码即用** — 终端显示二维码，微信扫码完成登录
- **多轮对话** — 按用户维度维护对话上下文
- **凭证持久化** — 登录凭证自动保存，重启无需重新扫码

## 📋 前提条件

- Node.js >= 22

## 🚀 快速开始

### 1. 克隆并安装依赖

```bash
git clone https://github.com/yourname/wx-openclaw-robot.git
cd wx-openclaw-robot
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# AI 模型配置（兼容 OpenAI 接口的任意模型）
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# 系统提示词（可选）
SYSTEM_PROMPT=你是一个友好的AI助手，简洁明了地回答问题。
```

<details>
<summary>国内模型配置示例</summary>

**智谱 GLM：**
```env
OPENAI_API_KEY=your-zhipu-api-key
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_MODEL=glm-4
```

**DeepSeek：**
```env
OPENAI_API_KEY=your-deepseek-api-key
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-chat
```

</details>

### 3. 启动

```bash
npm run dev
```

首次启动会在终端显示二维码，用微信扫码并在手机上确认授权。登录成功后，机器人开始监听消息并自动回复。

## 💬 指令

| 指令 | 说明 |
|------|------|
| `/clear` | 清除当前对话上下文，重新开始 |
| `--logout` | 启动参数，清除已保存的登录凭证 |

清除凭证后重新登录：

```bash
npm run dev -- --logout
```

## 📁 项目结构

```
src/
├── index.ts          # 入口，加载配置并启动
├── bot.ts            # Bot 主循环（长轮询 + 消息分发）
├── ai/
│   └── chat.ts       # AI 对话层（OpenAI 兼容接口）
└── weixin/
    ├── types.ts      # 微信协议类型定义
    ├── api.ts        # 微信 HTTP API（收发消息）
    └── auth.ts       # 扫码登录认证
```

## 🔧 工作原理

```
微信用户发消息
    ↓
腾讯 iLink 网关
    ↓  getUpdates（长轮询）
wx-openclaw-robot
    ↓  调用 AI 模型
OpenAI 兼容 API
    ↓  返回回复
wx-openclaw-robot
    ↓  sendMessage
腾讯 iLink 网关
    ↓
微信用户收到回复
```

## 📜 协议说明

本项目使用腾讯官方 OpenClaw 微信渠道的公开 HTTP API 协议（`ilink/bot/*`），通过扫码授权方式合法接入微信。

## License

MIT
