# dsh-stt

本地语音识别（STT）插件，for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

- **仅识别，不做 TTS**。识别文本填入输入框，说「发送」直接发送。
- **完全本地**：sherpa-onnx SenseVoice 离线识别，音频不上传任何服务器。
- **多轮语音交互**：点按切换麦克风待机 → 说唤醒词激活 → 说内容填框 → 说「发送」提交。
- **深度审批响应**：模型返回选择/确认时，语音说「允许/是」或「拒绝/取消」直接响应审批。
- **跨平台**：sherpa-onnx 引擎不随仓库分发，由整合包构建/安装时按目标平台自动拉取（Windows / macOS / Linux）。

## 安装

### 通过 dsh 插件命令（推荐）

```bash
dsh plugin --profile web add github:BAIKAI23333/dsh-stt
```

识别引擎（sherpa-onnx 原生二进制）**不随仓库分发**，安装后需在插件目录执行一次：

```bash
npm install --omit=dev
```

未安装引擎时插件可正常加载与配置，`status.binary = missing`、转写接口返回 503（`engine_missing`），客户端按钮灰化提示；引擎缺失不会影响宿主其它插件。SenseVoice 模型首次使用时按需下载（见下）。

### 整合包（EAC）

[Deepseek Harness EAC](https://github.com/BAIKAI23333/Deepseek-Harness-EAC) 内置本插件，构建时 CI 按目标平台自动安装引擎，开箱即用；详见其仓库内集成说明。

## 使用

1. 点输入框旁的**麦克风按钮** → 进入待机（按钮变蓝脉冲「监听中」）
2. 说**唤醒词**（默认「你好」，可在设置里改）→ 激活（按钮变绿「已激活」）
3. 激活后说话 → 识别文本填入输入框（连续说话自动续期，长句分段合并）
4. 说「发送」→ 提交草稿并发送
5. 再点按钮 → 关闭麦克风

**设置页**：「设置 → 语音识别」可改唤醒词、选择输入设备、麦克风自测、查看/下载模型。

## 模型

首次使用会自动下载 **SenseVoice** 模型（`~/.dsh/models/dsh-stt/`，约 230MB，断点续传）。下载源内置多源自动回退：GitHub Release 为主，失败自动切 hf-mirror 镜像；仍失败时设置页会显示「未就绪」引导（查看进度 / 手动重试）。也可自行修改 `~/.dsh/dsh-stt.json` 的 `downloadUrls.asr` 指向其它镜像。

支持语言：中文（带标点）、英文、日文、韩文、粤语。

## 接口（仅回环）

| 路由 | 说明 |
|---|---|
| `POST /api/dsh-stt/transcribe` | multipart `audio` 字段 → `{ text, durationMs, lowConfidence }`；引擎缺失时 503 `engine_missing` |
| `GET /api/dsh-stt/status` | 模型/引擎状态（`binary`：引擎二进制可用性） |
| `POST /api/dsh-stt/download` | 触发模型下载 |

所有路由仅接受 `127.0.0.1` / `::1` 回环请求。

## 交互细节

- **唤醒词**：待机时识别到唤醒词才激活；非唤醒词静默丢弃，绝不填框
- **长句**：VAD 切段的片段按序合并后一次填入（无多余标点）
- **发送**：仅开头/结尾的「发送」触发（`不要发送`/`你能发送吗` 不误触发；句末标点自动剥除）
- **审批**：页面有审批面板时，语音「允许/是」→ 通过，「拒绝/取消」→ 拒绝

## 开发

```bash
npm install          # 装 sherpa-onnx-node（引擎）与 esbuild（构建）
npm run build        # client/ 源码 + src/voice-logic.mjs → client.js
node --test test.mjs # 跑纯逻辑单测
```

- **语音纯逻辑**（VAD 参数 / 唤醒匹配 / 过滤 / 合并 / 发送词 / 审批意图 / 门控状态机）在 `src/voice-logic.mjs`，client 产物与单测直接引用同一实现，无双同步。
- **client 源码**在 `client/`：`entry.js`（UI 注入入口）+ `components/`（UI 组件）+ `lib/`（状态/采集/会话编排）。改源码后必须 `npm run build` 重新生成根目录 `client.js`（产物勿手改）。

## License

MIT
