# dsh-tdai-memory

**GitHub**: [Scorp1o117/dsh-tdai-memory](https://github.com/Scorp1o117/dsh-tdai-memory) · **npm**: [dsh-tdai-memory](https://www.npmjs.com/package/dsh-tdai-memory) · [English](README.md)

把 **TencentDB Agent Memory**（腾讯云开源的四层记忆系统，原为 OpenClaw 插件）移植进 DeepSeek Harness。

## 能力

- **L0 对话捕获**：每轮对话（turn 结束、请求边界）自动写入原始对话（JSONL + SQLite + FTS + 向量）
- **L1 结构化记忆**：后台管线用 LLM 从对话中提取事实/偏好/事件（persona / episodic / instruction），写入 `records/` + SQLite + FTS + 向量
- **L2 场景 / L3 画像**：场景块与用户画像生成（管线自动调度）
- **自动召回注入**：每次组装提示词时，按当前用户消息检索相关记忆 + 画像，作为动态上下文注入（模型"凭空想起"）
- **工具**：`tdai_memory_search`（L1 结构化检索）、`tdai_conversation_search`（L0 原文检索）

数据目录复用现有 `~/.memory-tencentdb/memory-tdai`，**旧记忆无缝继承**。

## 架构（移植方式）

| 层 | 内容 |
|---|---|
| 核心 | `tdai-memory-openclaw-plugin` 的 host-neutral 核心（`src/core`、`src/utils`），tsc 编译为 ESM（`dist-dsh/`），零改动 |
| 宿主适配 | `StandaloneHostAdapter`（官方 standalone 模式，OpenAI 兼容直调） |
| dsh 壳 | `index.js`：配置映射、`session/event`+`session/flush` 捕获、`agent.ctx` 上的 `system-prompt/assemble` waterfall 召回注入、工具注册、生命周期 |
| 备用 | `recall-inject.js`：preset 行形态的召回注入（挂在 agent preset 内时用） |

关键接线（都是踩坑换来的）：

- **捕获**：`session/flush` 监听器（await 语义，headless 退出前必完成）；`turn/start` 时间戳做 L0 cursor 下限；turn id 去重
- **headless 一次性任务**：flush 内再等 `core.handleSessionEnd()`（L1 提取跑完才退出；否则 5s 关闭超时会杀掉提取）
- **召回注入**：必须注册在 **`agent.ctx`** 上（组装在 agent 作用域进行，root 监听器收不到）；`session/created` 后延迟一 tick 从 `agents` 服务拿 agent

## 配置（profile patch + settings）

配置以 **settings 命名空间**驱动：profile patch 作为 base 层，`$DSH_HOME/settings.yaml` 的 `tdai-memory:` 节覆盖（LLM/embedding 密钥已迁到 settings.yaml）。Web UI 设置 → 记忆 可编辑全部字段（v0.2.0，含写-only 密钥）；TdaiCore 启动时构建，改动**重启后生效**。

```yaml
# $DSH_HOME/settings.yaml
tdai-memory:
  llm:
    apiKey: 'sk-...'
  embedding:
    apiKey: 'local-no-key'
```

```yaml
# profile patch（base 层）
- id: tdai-memory
  name: 'dsh-tdai-memory'
  config:
    extraction:
      enabled: true
      enableDedup: false      # dedup 的 LLM 输出解析不稳，先关
    llm:                      # L1/L2/L3 提取模型（OpenAI 兼容）
      baseUrl: 'https://opencode.ai/zen/go/v1'
      model: 'mimo-v2.5'      # deepseek-v4-flash 对提取 JSON 输出不合格
    embedding:                # 向量（OpenAI 兼容 /v1/embeddings）
      baseUrl: 'http://127.0.0.1:8088/v1'
      model: 'Qwen3-Embedding-0.6B'
      dimensions: 1024
      sendDimensions: false
```

## 已知取舍

- **提取模型**：`mimo-v2.5` 提取正确但单次 20-30s（后台执行，不阻塞对话）；`deepseek-v4-flash` 快但 JSON 输出不合规（提取 0 条）
- **dedup**：LLM 冲突检测输出解析不稳（曾导致 stored=0），默认关闭；开启需换更稳的模型
- **L1 记忆向量**：随存储写入（8088 embedding 快）；L0 向量走后台任务，headless 退出时由 `destroy()` drain
- **升级**：上游拉新代码后，在 tdai 项目目录重跑 `npx tsc -p dsh-tsconfig.json`（产物在 `dist-dsh/`）
