# openclaw-dsh-bridge

微信官方 ClawBot 插件 → OpenClaw 网关 → **DSH 会话** 的桥接插件。

让微信里的消息直接驱动一个运行在 DeepSeek Harness（DSH）里的真实 agent：
有工作区文件、能跑命令、跨轮记忆、工具完整——不是只接了个聊天 API 的假机器人。

## 架构

```
微信 App（安卓端官方 ClawBot 插件，腾讯官方通道）
        │
        ▼
OpenClaw 网关（与 DSH 同一台机器，或经 token 走局域网）
        │  OpenAI 兼容协议 POST /openclaw-bridge/v1/chat/completions
        ▼
本插件（运行在 DSH webServer 内的 Cordis 插件）
        │  agents.create + agent.followup + session 事件流
        ▼
DSH Agent 会话（每 model 名一个常驻会话，独立工作区）
```

## 特性

- **OpenAI 兼容端点**：任何支持自定义 baseURL 的 OpenAI 兼容客户端都能接入
  （OpenClaw / 任意网关），支持 stream 与非 stream 两种返回。
- **会话映射**：OpenClaw 端配置的 `model` 名映射到一个常驻 DSH 会话，
  跨轮记忆、工具状态、工作区文件全部连续。
- **历史去重**：网关每轮回放完整 messages，插件只注入新增的用户消息，
  不产生重复上下文。
- **隔离**：每个映射会话有独立工作目录 `~/.dsh/openclaw-bridge/workspace/<key>`，
  不接触你日常使用的目录。
- **安全**：默认仅 127.0.0.1 可访问；跨主机访问必须携带 Bearer token。

## 快速开始

### 1. 安装插件到 DSH Desktop

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本会：
1. 把插件复制进 `DSH Desktop/resources/app/assets/plugins/dsh-openclaw-bridge/`；
2. 同步到 `~/.dsh/profiles/web/node_modules/@deepseek-ai/`；
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加启用条目；
4. 给 `dsh-host-apiproxy` 的设置命名空间白名单打补丁（加入 `openclaw-bridge`，
   否则设置页的 ClawBot 栏读不到配置）。

> 注意：第 4 步改的是 DSH 核心包（MIT 许可），DSH Desktop 更新后可能被覆盖，
> 重新跑一遍 install.ps1 即可恢复。

### 2. DSH 设置里的 ClawBot 栏

重启 DSH Desktop 后，打开 **设置 → ClawBot**：

- **接收模型**：形如 `provider/model`（如 `deepseek-official/deepseek-v4-pro`），
  留空 = 使用 DSH 默认模型；保存后立即生效（新会话使用新模型）；
- **桥接 Token**：非回环访问时要求的 Bearer token；留空保存 = 保持现状。

接入端点（OpenAI 兼容）：`http://127.0.0.1:<port>/openclaw-bridge/v1/chat/completions`，
其中 `<port>` 见启动日志的 `[openclaw-bridge] mounted on ...` 一行。

重启 DSH Desktop（或 `dsh web`），启动日志里会出现：

```
[openclaw-bridge] mounted on http://127.0.0.1:<port>/openclaw-bridge/v1/chat/completions
```

验证：

```powershell
curl http://127.0.0.1:<port>/openclaw-bridge/health
```

### 3. 配置 OpenClaw（可选，兼容链路）

把 OpenClaw 的模型 provider 指到上面的端点（模型名随意，推荐形如 `dsh-bridge/<用途>`，
**每个不同的模型名对应一个独立的 DSH 会话**）。具体配置见
[docs/openclaw-config.md](docs/openclaw-config.md)。

### 4. 微信直连（iLink 渠道，不经 OpenClaw）

重启 DSH Desktop 后，打开 **设置 → ClawBot → 微信连接**：

1. 点 **连接微信** —— 卡片上会出现一个二维码（指向微信官方小程序
   `liteapp.weixin.qq.com`，腾讯自己的域名）；
2. 在微信里启用官方 ClawBot 插件，用它扫这个码（或点开旁边的链接），
   在微信里确认绑定；若微信要求输入配对码，把它填回设置页并提交；
3. 状态变为 **已连接** 后，直接给这个 Bot 发消息即可。

底层机制：

- 走腾讯官方 **iLink 协议**（`ilinkai.weixin.qq.com`，HTTP 长轮询）——
  手机和电脑**从不直连**，两边都只是出站连腾讯云，**不需要公网 IP、
  端口映射、内网穿透**；
- 每个微信用户映射一个独立 DSH 会话（记忆与工作区互相隔离）；
- 回复自动发回微信（原样回传 `context_token`）。

### 4.5 配置第三方公司模型（自定义 baseURL）

设置 → ClawBot → **第三方模型端点（OpenAI 兼容）**：

- `baseURL`：填了它，接收模型就改走这个端点（如 `https://api.siliconflow.cn/v1`、
  one-api 聚合网关、Ollama 的 `http://127.0.0.1:11434/v1` 等）；
- `API Key`：该端点的密钥（无鉴权的本地端点可留空）；
- `模型名`：该端点上的模型 id（如 `deepseek-ai/DeepSeek-V3`、`qwen2.5:7b`）。

保存后立即生效，微信里的 agent 会用这家公司的模型干活——**完整能力保留**
（工具调用、流式、错误重试），因为插件内置了一个通用 OpenAI 兼容 LlmAdapter
（`lib/openai-compat.js`，按 DSH 官方 `dsh-llm-deepseek` 适配器逐段通用化）。
留空 baseURL 则回到上面的"接收模型"字段（DSH 内置 provider）。

### 5. 远程办公：工作目录 + 会话接管 + 白名单

**让微信里的 agent 操作你的真实项目目录**：设置 → ClawBot → "微信工作目录"
填绝对路径（如 `C:\Users\you\Desktop\work`）→ 保存，然后微信里发
`/new` 开新会话——之后的 agent 工具（读写文件、跑命令）都在该目录里干活。

**接管已有 DSH 会话**（"控制我的一些对话"）：在微信里发指令

- `/help` —— 查看指令
- `/list` —— 列出可接管的会话（live + 已持久化，含 id 和工作目录）
- `/attach <会话id>` —— 接管该会话，之后的消息都进入它（与 DSH 界面
  里看到的是同一个会话、同一段记忆、同一个工作区）
- `/new` —— 开新会话（丢弃当前绑定）

**安全（强烈建议）**：设置 → ClawBot → "微信用户白名单"，填你自己的
`xxx@im.wechat`（/list 后或日志里能看到）——白名单外的消息会被静默忽略。
微信驱动的是你 PC 上真实的 agent（有完整文件/命令能力），务必只放行自己。

两个腾讯侧的硬约束（官方条款）：

- **会话每 24 小时过期**，需在设置页重新扫码续连；
- 用户发消息后 24h 内最多**主动发 10 条**（含回复）——适合应答式助手，
  不适合做主动推送轰炸。

> 注意：二维码图片由浏览器经 `api.qrserver.com` 渲染（第三方仅看到短时效的
> 绑定链接）；不想外发可在卡片上点链接、把链接发到手机微信里点开。
> 若你的机器无法出站访问 `ilinkai.weixin.qq.com`（如受防火墙限制），此功能不可用。

## 协议

`POST /openclaw-bridge/v1/chat/completions`

请求（OpenAI chat completions 子集）：

```json
{
  "model": "dsh-bridge/main",
  "stream": true,
  "messages": [
    { "role": "user", "content": "帮我把这个月的日志按天分组" }
  ]
}
```

- `model`：会话 key。不同值 → 不同 DSH 会话（互不共享记忆与文件）。
- `messages`：只取 `role: "user"` 的文本；system/assistant 消息由 DSH 自身管理，
  直接忽略（网关侧的回放历史仅用于"哪些用户消息还没注入过"的去重判断）。
- `stream: true` 时按 OpenAI SSE 格式返回增量 chunk，以 `data: [DONE]` 结束。

## 安全模型

- 回环地址（127.0.0.1 / ::1）请求**免 token**；
- 非回环请求必须携带 `Authorization: Bearer <token>` 或
  `x-openclaw-bridge-token: <token>`；
- token 来源：环境变量 `OPENCLAW_BRIDGE_TOKEN`；未设置时首次启动自动生成并
  持久化到 `~/.dsh/openclaw-bridge/token.txt`；
- OpenClaw 与 DSH 不在同一台机器时，请**务必**显式设置 token，并自行承担
  网络暴露风险（建议只在可信局域网或经 TLS 反代）。

> 安全提示：桥接后的 agent 拥有 DSH 的全部工具能力（文件、命令、网络等）。
> 任何能往 OpenClaw 发消息的人都能触发这些动作。请为桥接会话设置独立工作区
> （默认已隔离），并谨慎决定谁能与机器人对话。

## 合规说明

- 本项目**只**使用微信官方 ClawBot 插件通道，仓库内不含任何微信协议、
  hook 或逆向代码；
- 插件本体 MIT 许可证；依赖的 DSH 核心包（`@deepseek-ai/*`）均为 MIT；
- 本项目与腾讯、OpenClaw 基金会、DeepSeek 均无隶属关系；
- 使用者自行承担账号风险与数据处理义务；若对外提供托管服务，聊天内容
  属于个人信息，需自行满足《个人信息保护法》等要求；
- 本项目不提供法律建议。

## 更新与卸载

**更新**：`git pull` 后重跑 `install.ps1` 并重启 DSH Desktop。注意两类"副本失效"：

- DSH Desktop 更新会整体替换 `resources/app`，清掉 apiproxy 白名单补丁与
  assets/plugins 副本；
- `~/.dsh/profiles/web` 是 npm 托管的 profile，未声明的插件目录可能被 npm 修剪。

两者都只需重跑 `install.ps1`（幂等）即可恢复。

**卸载**：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

脚本会回滚四处安装产物（cordis.patch.yml 条目、profile 副本、assets/plugins 副本、
apiproxy 白名单补丁），并默认删除桥接数据（token/微信会话/工作区，
加 `-KeepData` 保留），之后重启 DSH Desktop 即完全移除。

## 测试

```powershell
# 协议层单元测试（52 项断言：mock DSH 核心服务 + mock 腾讯 iLink 云 + mock OpenAI 端点，
# 覆盖路由/去重/会话隔离/鉴权/SSE/微信全链路/自定义端点适配器）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test.ps1

# 集成测试：克隆 DSH home、起一个真实的 dsh web 实例（独立端口），
# 跑通 插件 -> agent -> 真实模型 全链路（含流式）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\integration-test.ps1
```

`install.ps1` 参数：`-Target`（DSH Desktop 的 resources\app 目录，留空自动探测）、
`-DshHome`（DSH home 覆盖，默认 `~/.dsh`）、`-SkipDesktop`（只装 profile，不复制到 Desktop）。

## 开发

```bash
node --check lib/index.js   # 语法检查（无构建步骤）
```

插件是纯 ESM、零构建；运行时只依赖 node 内置模块与 DSH 核心包
（peerDependencies 声明，随 DSH 提供）。

## 许可证

[MIT](LICENSE)
