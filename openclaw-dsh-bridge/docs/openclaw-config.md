# OpenClaw 配置指南

把 OpenClaw 的模型后端指向 DSH 桥接插件。以下配置基于 OpenClaw 官方文档
（docs2.openclaw.ai），配置键名以官方为准。

## 1. 打开配置文件

```bash
# 新版 OpenClaw（2026.5+）
nano ~/.openclaw/openclaw.json
# 旧版 Clawdbot 迁移用户
nano ~/.clawdbot/clawdbot.json
```

## 2. 注册 DSH 桥接 provider

```json5
{
  models: {
    mode: "merge",          // merge（默认）在官方模型目录上追加，不要用 replace
    providers: {
      dsh: {
        baseUrl: "http://127.0.0.1:<port>/openclaw-bridge/v1",   // 注意键名是 baseUrl
        api: "openai-completions",                              // 走 /v1/chat/completions
        apiKey: "见下方说明",                                     // 回环地址其实无需真值
        models: [
          { id: "main",       name: "DSH 主会话",       reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 32000 },
          { id: "work",       name: "DSH 工作会话",     reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 32000 },
          // 每个 id 对应一个独立的 DSH 会话（独立记忆与工作区）
          // id 请用小写字母/数字/中划线，勿含斜杠
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "dsh/main" },   // 引用格式：provider/model-id
    },
  },
}
```

要点：

- **`<port>`** 换成 DSH 启动日志里 `[openclaw-bridge] mounted on http://127.0.0.1:<port>...`
  那一行的端口。
- **baseUrl 结尾到 `/v1`**：OpenClaw 会自动追加 `/chat/completions`。
- **apiKey**：桥接插件对回环请求免鉴权，这里填任意非空字符串即可；若 OpenClaw 与
  DSH 不在同一台机器（非回环），填 `~/.dsh/openclaw-bridge/token.txt` 里的 token，
  或使用环境变量引用 `apiKey: "${OPENCLAW_BRIDGE_TOKEN}"`（需在 OpenClaw 的
  `~/.openclaw/.env` 里定义该变量）。
- **model id → DSH 会话**：`agents` 里引用的 model id 会被桥接插件用作会话 key。
  给不同用途配置不同 id（如 `main`/`work`），即可得到互不干扰的多个 DSH 会话；
  也可以为不同 OpenClaw agent 指定不同 model，实现"一人一会话"。
- 回环地址默认不受 OpenClaw SSRF 防护限制，无需 `request.allowPrivateNetwork`；
  若走局域网 IP，需要给 provider 加 `request: { allowPrivateNetwork: true }`。

## 3. 重启网关并验证

```bash
openclaw gateway restart
openclaw models list          # 应看到 dsh/main、dsh/work
openclaw doctor
```

在终端直接发一条测试消息（不经微信）：

```bash
openclaw message send --agent main --text "你好，介绍一下你自己"
```

回复应来自 DSH agent（可在 DSH 侧看到对应的 bridge 会话与工作区文件）。

## 4. 微信官方 ClawBot 插件接入

微信链路与后端无关，按腾讯官方插件流程走（OpenClaw 官方文档 channels/wechat）：

```bash
# 安装官方插件（腾讯官方 CLI，会重启网关）
npx -y @tencent-weixin/openclaw-weixin-cli@latest install

# 在跑网关的机器上执行，终端输出官方授权二维码，用微信扫码
openclaw channels login --channel openclaw-weixin
```

- 无需在手机上填网关地址：插件走腾讯 iLink 云通道（消息经腾讯中转），
  这也是为什么微信端不需要你的机器有公网 IP。
- 新发件人首次发消息会触发 8 位大写配对码，在网关侧批准：
  ```bash
  openclaw pairing list openclaw-weixin
  openclaw pairing approve openclaw-weixin <CODE>
  ```

## 5. 安全建议（官方 checklist 摘录）

- 网关保持默认 `bind: "loopback"`；不要在公网裸奔。
- 建议开启 DM 配对：`session.dmScope: "per-channel-peer"`、`dmPolicy: "pairing"`。
- 若确需手机在外网访问网关，优先 Tailscale / SSH 隧道，不要直接端口映射。
- 桥接后的 agent 拥有 DSH 完整工具能力：只批准可信发件人，保持默认的独立工作区。

## 参考

- OpenClaw 模型 provider：https://docs2.openclaw.ai/concepts/model-providers
- OpenClaw 微信频道：https://docs2.openclaw.ai/channels/wechat
- 网关暴露与安全：https://docs2.openclaw.ai/gateway/security/exposure-runbook
