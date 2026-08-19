# dsh-tool-vision

**GitHub**: [Scorp1o117/dsh-tool-vision](https://github.com/Scorp1o117/dsh-tool-vision) · **npm**: [dsh-tool-vision](https://www.npmjs.com/package/dsh-tool-vision) · [English](README.md)

[![Enhancement Suite](https://img.shields.io/badge/part%20of-Enhancement%20Suite-3964fe)](https://github.com/Scorp1o117/dsh-enhancement-suite) [![npm](https://img.shields.io/npm/v/dsh-enhancement-suite)](https://www.npmjs.com/package/dsh-enhancement-suite)

属于 [DeepSeek Harness Enhancement Suite](https://github.com/Scorp1o117/dsh-enhancement-suite) —— Vision · Soul/Persona · 长期记忆 · 插件市场。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 外接**视觉模型**的插件。

DeepSeek 自家模型是纯文本的，而且 harness 的每次模型请求都**严格从会话日志推导**（`llm/stream` 请求必须与持久化推导一致，否则 agent-loop invariant 会报 `log-reconstruction desync`）。本插件用两条路径补上缺口：

1. **`inspect_image` 工具** —— 把图片（本地文件或 http(s) URL）发给任意支持 `image_url` 内容块的 OpenAI 兼容 `/chat/completions` 端点，把视觉模型的文字回答带回对话。
2. **图片桥（v0.2.1）** —— 粘贴的图片在**进入持久化日志之前**就被转换成 `inspect_image` 指引文本，拦截点是 `agent/pre-step` waterfall（这是 harness 唯一允许插件替换"进入某一步的消息"的缝；替换后的消息会**成为**持久化的 `user/message` 日志，所以请求重建 invariant 天然满足）。旧版本已经写进日志的图片消息，会在该会话下一次 pre-step 时用 surface `replace` 惰性修复。只有 `multimodalModels` 白名单内的模型直收图片块；**不参考模型的 `inputModalities` 声明**——因为很多配置为了通过 prompt 准入检查，会给纯文本模型声明 `input: [text, image]`（那只是声明，不代表上游真的能吃 `image_url`）。
3. **像素级视觉工具（v0.4.0，移植自 dsh-vision-router）** —— 14 个 `vision_*` 工具（看图问答/像素定位/元素检测/裁剪/像素对比/取色/OCR/长截图 OCR/SVG 矢量化/抠图/HTML 截图/桌面截图/图片展示/附件落盘），全部走**同一个** `inspect_image` 配置的端点（baseURL/apiKey/model），不做模型区分、不引入本地模型与降级链。工具产物写入工作区 `.dsh-tool-vision/` 目录。

- 除 dsh SDK 外零依赖 —— 兼容任意端点：OpenAI GPT-4o、Qwen-VL（DashScope）、GLM-4V（智谱）、Moonshot、Gemini 兼容端点、本地 Ollama 等。
- 注册在**全局工具层**：进程内所有 Agent 都能调用 `inspect_image`。
- **Web UI 设置栏（v0.3.0）**：设置 → 视觉模型 编辑 `tool-vision` 命名空间（API 地址、只写密钥、模型、桥接选项），写入 `settings.yaml`，**改动即时生效无需重启**。API 密钥存放在 `settings.yaml` 而非 profile patch；插件按包名挂载（`name: 'dsh-tool-vision'`）以便 web 端发现客户端 bundle。

## 安装

在 profile patch（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）里挂载：

```yaml
- insert:
    - id: tool-vision
      name: 'dsh-tool-vision'     # 前置：在 profile 里 pnpm add dsh-tool-vision
      config:
        baseURL: 'https://api.openai.com/v1'
        apiKeyEnv: 'VISION_API_KEY'
        model: 'gpt-4o-mini'
```

不装 npm 包、直接加载本地路径：

```yaml
    - id: tool-vision
      name: './plugins/dsh-tool-vision/index.js'
```

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `https://api.openai.com/v1` | OpenAI 兼容 API 基地址 |
| `apiKey` | `''` | API 密钥（优先于环境变量） |
| `apiKeyEnv` | `VISION_API_KEY` | 存放密钥的环境变量名 |
| `model` | `gpt-4o-mini` | 视觉模型 id |
| `maxTokens` | `1024` | 视觉调用最大输出 token |
| `timeoutMs` | `60000` | 单次请求超时 |
| `maxImageBytes` | `10MB` | 本地图片大小上限 |
| `description` | 默认描述 | 工具描述（模型可见） |
| `bridgeTextOnly` | `true` | 把粘贴图片转成文本指引（发给看不懂图片的模型时） |
| `bridgeExportDir` | 临时目录 | 桥接图片导出目录（`os.tmpdir()/dsh-vision-bridge`） |
| `multimodalModels` | `[]` | 直发图片块的模型 id（如 `mimo-v2.5`） |

## 图片桥配置

1. 在模型设置里给要贴图的模型声明图片输入（pi-ai 风格），让 harness 放行图片消息：
   ```yaml
   llm-pi-ai:
     providers:
       your-provider:
         models:
           - id: deepseek-v4-flash
             input: [text, image]
   ```
2. 在插件配置里列出真正多模态的模型，让它们直收图片块：
   ```yaml
   - id: tool-vision
     name: 'dsh-tool-vision'
     config:
       multimodalModels: ['mimo-v2.5', 'grok-4.5']
   ```

之后在文本模型下贴图，转录里会留下一条指引：
`[User sent an image, exported to: <path>. Inspect it with the inspect_image tool...]`
（该消息不再以像素图形式渲染），Agent 会调用视觉端点查看并把结果带回对话。

> 为什么不用 `llm/stream`？harness 会冻结每个请求，且 agent-loop invariant 会拒绝任何与会话日志推导不一致的请求；这个 cordis 版本的 waterfall `next()` 也无法替换请求参数。`agent/pre-step` 才是受支持的缝：它的决策消息**会成为**持久化日志，invariant 天然成立。

密钥解析顺序：`config.apiKey` → `process.env[apiKeyEnv]` → `process.env.OPENAI_API_KEY`。

## 工具：`inspect_image`

| 参数 | 必填 | 含义 |
|---|---|---|
| `path` | ✅ | 图片路径（绝对路径，或相对当前工作区）或 http(s) URL |
| `question` | – | 可选的具体问题 |
| `detail` | – | `auto` / `low` / `high` 分辨率提示 |

示例端点（`baseURL`）：

- **OpenAI**：`https://api.openai.com/v1` —— `gpt-4o`、`gpt-4o-mini`
- **阿里云 DashScope（Qwen-VL）**：`https://dashscope.aliyuncs.com/compatible-mode/v1` —— `qwen-vl-plus`、`qwen-vl-max`
- **智谱（GLM-4V）**：`https://open.bigmodel.cn/api/paas/v4` —— `glm-4v-flash`（免费档）、`glm-4v-plus`
- **Moonshot（Kimi）**：`https://api.moonshot.cn/v1` —— `moonshot-v1-8k-vision-preview`
- **Ollama 本地**：`http://localhost:11434/v1` —— `llama3.2-vision`（无需密钥）

## 限制

- 被桥接的图片以文本指引进入对话（转录而非像素）——文本模型无法做像素级上下文推理；视觉模型的描述通过 `inspect_image` 回传。
- 图片以 base64 传输；注意隐私与大小限制。
- 独立于 dsh-llm 的路由/重试体系；失败会向 Agent 返回明确错误。

## License

MIT
