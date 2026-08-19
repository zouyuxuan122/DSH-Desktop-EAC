# dsh-tool-vision

[![中文文档](https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3-blue)](README.zh.md)

**GitHub**: [Scorp1o117/dsh-tool-vision](https://github.com/Scorp1o117/dsh-tool-vision) · **npm**: [dsh-tool-vision](https://www.npmjs.com/package/dsh-tool-vision)

[![Enhancement Suite](https://img.shields.io/badge/part%20of-Enhancement%20Suite-3964fe)](https://github.com/Scorp1o117/dsh-enhancement-suite) [![npm](https://img.shields.io/npm/v/dsh-enhancement-suite)](https://www.npmjs.com/package/dsh-enhancement-suite)

Part of the [DeepSeek Harness Enhancement Suite](https://github.com/Scorp1o117/dsh-enhancement-suite) — Vision · Soul/Persona · Long-term Memory · Plugin Marketplace.

External vision model for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DeepSeek's own models are text-only, and the harness derives every model
request strictly from the session log (`llm/stream` requests must equal the
durable derivation — the agent-loop invariant). This plugin bridges the gap
in two ways:

1. **`inspect_image` tool** — sends an image (local file, or http(s) URL) to
   **any OpenAI-compatible** `/chat/completions` endpoint that supports
   `image_url` content parts, and returns the vision model's textual answer
   into the agent loop.
2. **Image bridge (v0.2.1)** — pasted images are turned into `inspect_image`
   hints *before they enter the durable log*, on the `agent/pre-step`
   waterfall (the one seam where the harness lets a plugin replace the
   messages of a proposed step). Images already logged by an older version
   are repaired lazily with a surface `replace` on the session's first
   pre-step. Only models listed in `multimodalModels` receive image blocks
   directly; a model's declared `inputModalities` are never consulted,
   because profiles routinely declare `input: [text, image]` on text-only
   models just to pass the harness's prompt-admission check.

- Zero dependencies beyond the dsh SDK — works with any compatible endpoint:
  OpenAI GPT-4o, Qwen-VL (DashScope), GLM-4V (Zhipu), Moonshot, Gemini
  compatible endpoints, local Ollama, etc.
- Registered on the **global tools layer**: every agent in the process can
  call `inspect_image`.
- **Web UI settings section (v0.3.0)**: Settings → 视觉模型 edits the
  `tool-vision` namespace (API endpoint, write-only key, model, bridge
  options) in `settings.yaml`; changes hot-apply without a restart. The API
  key lives in `settings.yaml`, not the profile patch. Mount by package name
  (`name: 'dsh-tool-vision'`) so the web client bundle is discovered.

## Install

Mount in a profile patch (`$DSH_HOME/profiles/<name>/cordis.patch.yml`):

```yaml
- insert:
    - id: tool-vision
      name: 'dsh-tool-vision'     # after: pnpm add dsh-tool-vision in the profile
      config:
        baseURL: 'https://api.openai.com/v1'
        apiKeyEnv: 'VISION_API_KEY'
        model: 'gpt-4o-mini'
```

Or load it from a local path without npm:

```yaml
    - id: tool-vision
      name: './plugins/dsh-tool-vision/index.js'
```

## Config

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL. |
| `apiKey` | `''` | API key (takes precedence over env). |
| `apiKeyEnv` | `VISION_API_KEY` | Env var holding the key. |
| `model` | `gpt-4o-mini` | Vision model id. |
| `maxTokens` | `1024` | Max output tokens. |
| `timeoutMs` | `60000` | Per-request timeout. |
| `maxImageBytes` | `10MB` | Largest accepted local image. |
| `description` | default | Tool description shown to the model. |
| `bridgeTextOnly` | `true` | Bridge pasted images to text hints on models that cannot see images. |
| `bridgeExportDir` | temp | Export dir for bridged images (`os.tmpdir()/dsh-vision-bridge`). |
| `multimodalModels` | `[]` | Model ids that receive image blocks directly (e.g. `mimo-v2.5`). |

## Image bridge setup

1. In your model settings, declare image input on the models you paste
   images onto, so the harness admits image messages (pi-ai style):
   ```yaml
   llm-pi-ai:
     providers:
       your-provider:
         models:
           - id: deepseek-v4-flash
             input: [text, image]
   ```
2. List genuinely multimodal models in the plugin config so they receive
   image blocks untouched:
   ```yaml
   - id: tool-vision
     name: 'dsh-tool-vision'
     config:
       multimodalModels: ['mimo-v2.5', 'grok-4.5']
   ```

Then pasting an image while on a text-only model stores a hint like
`[User sent an image, exported to: <path>. Inspect it with the inspect_image tool...]`
in the transcript (the pasted image no longer renders as pixels in that
message), and the agent inspects it through the configured vision endpoint.

> Why not `llm/stream`? The harness freezes every request and the agent-loop
> invariant fails any request whose messages diverge from the session-log
> derivation (`log-reconstruction desync`), and this cordis waterfall's
> `next()` cannot replace request arguments. The `agent/pre-step` waterfall is
> the supported seam: its decision messages *become* the durable log, so the
> invariant stays satisfied.

Key resolution order: `config.apiKey` → `process.env[apiKeyEnv]` →
`process.env.OPENAI_API_KEY`.

## Tool: `inspect_image`

| Arg | Required | Meaning |
|---|---|---|
| `path` | ✅ | Image path (absolute, or relative to the current workspace) or http(s) URL. |
| `question` | – | Optional specific question about the image. |
| `detail` | – | `auto` / `low` / `high` resolution hint. |

Example endpoints (`baseURL`):

- **OpenAI**: `https://api.openai.com/v1` — `gpt-4o`, `gpt-4o-mini`
- **Alibaba DashScope (Qwen-VL)**: `https://dashscope.aliyuncs.com/compatible-mode/v1` — `qwen-vl-plus`, `qwen-vl-max`
- **Zhipu (GLM-4V)**: `https://open.bigmodel.cn/api/paas/v4` — `glm-4v-flash` (free tier), `glm-4v-plus`
- **Moonshot (Kimi)**: `https://api.moonshot.cn/v1` — `moonshot-v1-8k-vision-preview`
- **Ollama local**: `http://localhost:11434/v1` — `llama3.2-vision` (no key)


> **Note for users**
> - This plugin is a standard **profile bundle** (`dsh.bundle.patch`):
>   `dsh plugin --profile web add dsh-tool-vision` installs and mounts it in
>   one step — no manual `cordis.patch.yml` edits needed.
> - The settings section needs the `dsh-host-apiproxy` namespace allowlist;
>   the plugin patches it automatically on first start — **restart `dsh web`
>   once more** and the section appears. A dsh update overwrites the patch;
>   the next plugin start re-applies it.
> - Settings changes hot-apply (no restart needed).
> - Tested against DSH `0.1.0-rc.6`.


## Pixel-level vision tools (v0.4.0, ported from dsh-vision-router)

14 `vision_*` tools driven by the **same** configured endpoint as
`inspect_image` (baseURL/apiKey/model) — no provider chain, no local models,
no extra settings:

| Tool | Purpose |
|---|---|
| `vision_describe` | Image Q&A / multi-image comparison (optional structured JSON) |
| `vision_ground` | Locate a target and return its ORIGINAL-pixel bounding box |
| `vision_detect` | Enumerate elements (buttons, inputs, icons…) with numbered boxes |
| `vision_crop` | Crop a pixel region to a PNG artifact |
| `vision_pixel_diff` | Per-pixel comparison: ratio, worst regions, heatmap, report |
| `vision_colors` | Dominant-color quantization for palette matching |
| `vision_ocr` | Verbatim text transcription (letters only — not scene analysis) |
| `vision_long_screenshot_ocr` | Chunked long-screenshot transcription into Markdown |
| `vision_trace` | Potrace vectorization into colored SVG (worker-thread, safe) |
| `vision_extract_foreground` | Solid-background removal → transparent PNG |
| `vision_html_screenshot` | Headless render of a local .html (network blocked) |
| `vision_screenshot` | Desktop capture (Win: PowerShell; macOS: screencapture; Linux: import/scrot) |
| `vision_present` | Publish a generated image to the user via the host attachment store |
| `vision_materialize` | Copy an attachment/local image into the workspace as a real path |

Quality & safety details:

- **Content-hash cache** keyed by endpoint+model+image+question (no stale
  answers across model switches, failures are never cached).
- **Uniform 4MP downscale** before every model call; oversized inputs are
  rejected with a clear error (stat pre-check, 20MB cap on both file and
  attachment paths).
- **Rate-limit / 5xx auto-retry** with Retry-After-aware backoff; endpoint
  **content-safety rejections** are surfaced as `VISION_CONTENT_FILTERED`
  instead of a generic backend error.
- **Long-OCR bounds**: 120s total budget, 40-chunk cap, cancellation checks,
  stop-on-first-backend-failure.
- **Path containment** for relative inputs; artifacts land in
  `<workspace>/.dsh-tool-vision/`.
- **Bridge marker**: pasted images become a short `[图片: <path>]` marker and
  the usage rule lives in a system-prompt section (clean transcript, same
  model behavior).

Requires `sharp` / `potrace` / `puppeteer-core` (declared in dependencies;
missing ones degrade lazily with an install hint and never break other tools).

## Limitations

- A bridged image enters the conversation as a text hint (a transcript, not
  pixels) — pixel-precise in-context reasoning is not available to text-only
  models; the vision model's description comes back through `inspect_image`.
- Images are base64-transferred; mind privacy and size limits.
- Independent of the dsh-llm routing/retry system; failures return clear
  errors to the agent.

## License

MIT
