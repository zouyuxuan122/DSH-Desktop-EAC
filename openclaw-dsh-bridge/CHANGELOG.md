# Changelog

本项目为 DSH（DeepSeek Harness）插件：微信官方 ClawBot / OpenClaw 网关 → DSH 会话桥接。
版本号遵循语义化版本；每次发布附测试状态（单元断言数由 `scripts/test.ps1` 输出）。

## [0.2.0] — 2026-08（ClawBot 设置栏）

> 用户可见的核心里程碑：DSH 设置页出现「ClawBot」栏，可自行配置接收模型。

### 新增
- **DSH 设置页「ClawBot」配置栏**（客户端 `lib/client.js`，注册 `settings.section` 槽位）：
  - 接收模型（`provider/model`，留空用 DSH 默认模型）；
  - 桥接 Token（留空保持现状）；端点地址展示。
- **宿主设置节**（`lib/index.js` + `installSettingsSection`）：`openclaw-bridge`
  命名空间经 settings 服务持久化（settings.yaml）、保存即热生效。
- **设置命名空间白名单补丁**：`install.ps1` 幂等把 `openclaw-bridge` 加进
  `dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES`（否则设置页读不到配置；
  上游注释标记为 deferred work）。

### 验证
- 协议层单元测试 22 项断言（路由/去重/会话隔离/鉴权/SSE）。
- 集成测试：真实 dsh web 实例验证 `settings.describe`/mutate 与热生效闭环。

## [0.1.0] — 2026-08（初始版本）

- OpenAI 兼容端点 `POST /openclaw-bridge/v1/chat/completions`（stream + 非 stream）；
- model 名 → 常驻 DSH 会话映射（跨轮记忆、独立工作区）；
- 历史去重（只注入新用户消息）；回环免 token、非回环 Bearer 鉴权；
- 一键安装（assets/plugins + profile 补丁）；MIT 许可证、合规声明。

## [0.3.0] — 2026-08（微信 iLink 直连，不经 OpenClaw）

- `lib/wechat.js`：腾讯官方 iLink 协议客户端（`ilinkai.weixin.qq.com`，
  HTTP 长轮询）——扫码登录、`getupdates` 收消息、`sendmessage` 回复、
  token 持久化、24h 过期自动待重扫；
- 设置栏「微信连接」面板：二维码/配对码/状态/断开（回环控制路由
  `/openclaw-bridge/wechat/{status,login,verify,logout}`）；
- 微信用户 → `wx-<uid>` 独立 DSH 会话；无需公网 IP/穿透（双方出站连腾讯云）。

## [0.4.0] — 2026-08（远程办公：工作目录 + 会话接管 + 白名单）

- `workspace` 配置：微信 agent 的真实工作目录（远程办公）；
- 微信指令 `/help` `/new` `/list` `/attach <sessionId>`（接管已有 DSH 会话，
  复用 dsh-host-apiproxy 同款 resume 路径）；
- `allowlist` 白名单：非名单微信用户静默忽略。

## [0.5.0] — 2026-08（第三方模型端点 + 审计修复）

### 新增
- `lib/openai-compat.js`：通用 OpenAI 兼容 LlmAdapter（provider `openclaw-custom`，
  按官方 `dsh-llm-deepseek` 逐段通用化）——工具调用、SSE 流式、错误映射、
  默认重试；设置栏新增 baseURL / API Key / 模型名，配置即热生效。
- 集成测试新增"真实 agent 循环经 openclaw-custom 调用 mock 第三方端点"验证。

### 修复（审计驱动）
- iLink `iLink-App-ClientVersion` 改为打包 uint32 的十进制字符串（0x020406 → 132102）；
- sendmessage 补 `run_id`（每次新生成）、空 `context_token` 省略、失败记录 errmsg；
- 设置日志脱敏（token / customApiKey 不回显）；health 限回环；
- S1 并发首建竞态（`rec.ready` Promise）、S2 空会话文件误判"已连接"、
  M1 长轮询代际标记防双循环、M3 失败重试不丢消息、M5 SSE \r\n 帧兼容；
- 版本号随 package.json 读取，不再硬编码。

### 验证
- 单元断言 52 项全过（协议 20 + 微信 iLink 21 + 自定义端点/适配器 11）。
