# picturereader

> **v3.3.2** — 给纯文本模型（DeepSeek / text-only）的全能「看图 / 读文档 / 修图」能力。
> 融合 **视觉孪生 adapter**（把任意文本模型原位包装成「支持图片」→ DSH 原生缩略图 + 图片块自动分析）、**三模式路由**、**本地像素级工具链**（scan / OCR×4 引擎 / crop / palette / compare / batch）、**文档转图片**（pdf / word / excel / ppt）、**本地修图工具 `image_edit`**（Pillow/OpenCV 纯 CPU：缩放 / 旋转 / 滤镜 / 合成 / 水印 / 去背景 / 超分等）与**可选外部 VLM 桥**。一个插件全包。
>
> **v3.3.0 新增**：**macOS 原生 Vision OCR 引擎**（`engine="macos"`，`scripts/setup-macos.mjs` 一键编译，PR #4 合入）；OCR 引擎选项按平台条件显示（macos 仅 macOS、windows 仅 Windows，paddle/rapid 跨平台始终显示）；修复 PaddleOCR 新环境首次调用三个缺陷（stdout 污染 / w/h→width/height / 缓存路径写死，issue #2）；设置卡 UI 重做（settings-panel 设计语言）；调试日志门控（llm/stream 桥不再刷屏）；peerDependencies 兼容 DSH 0.1.1-rc.2（issue #3）。

[![dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) [![dsh.so security](https://www.dsh.so/badge/picturereader.svg)](https://www.dsh.so/artifact/picturereader) [![dsh.so install](https://www.dsh.so/badge/install/picturereader.svg)](https://www.dsh.so/artifact/picturereader)

---

## 定位

DeepSeek 等纯文本模型没有视觉编码器，无法直接看图片；DSH 原生缩略图也需要模型被声明为「支持图片」才会渲染。

> ⭐ **已支持外部视觉 API（OpenAI 兼容端点 / LM Studio / 云端 VLM），由 LLM 自行按需调用**：配置好端点后，模型会在智能/严谨模式下自主判断"这张图值不值得外呼视觉模型"，需要时用 `vision_analyze` 调外部 API 做语义理解，简单内容则本地像素/OCR 搞定——**外部 API 是即插即用的增强能力，不是必须依赖**。

picturereader 现在解决三件事：

1. **把「看图/读文档」翻译成纯文本模型能理解的结构化证据**（像素级 hue/结构/材质分析 + OCR 实读 + 可选 VLM 语义描述），并沉淀为读图方法论 skill。
2. **通过「视觉孪生 adapter」让纯文本模型在 DSH 里获得原生缩略图体验**：勾选模型即生成「(视觉)」变体，粘贴图片显示原生缩略图、图片块进会话、并被自动分析成文本路径 + 本地证据再交给模型。即使上游先降级为 `attachment sha256` 文本，图片桥也会仅从本机附件对象库恢复经过文件头校验的图片并注入本地工具路径；模型拿到的永远是纯文本，不会触发 `UNSUPPORTED_CONTENT`。
3. **本地直接修图 / 批量处理图片**：`image_edit` 提供缩放、旋转、滤镜、合成、水印、去背景、拼接、透视校正等纯 CPU 动作，图片不出本机。

> **版本兼容性**：本版本专门兼容 **dsh 0.1.1-rc.2** 及 **dsheac 5.1.0**，已针对这两个版本进行适配测试与优化，确保稳定运行。同时兼容 DeepSeek Harness EAC 4.2.0 与 `@deepseek-ai/dsh-client-ui-workspace` rc.7。`peerDependencies` 采用 `^0.1.0-rc.6 || ^0.1.1-rc.2` 联合区间，覆盖两条 0.1.x 发布线。

> 🚀 **后续将作为 DeepSeek Harness EAC 的内置视觉插件**：本插件计划替换内置的 `dsh-tool-vision`，随 DSH EAC 桌面版直接捆绑发布，开箱即用。作为独立包发布的目的，是让非 EAC / 旧版用户也能通过 `dsh plugin add picturereader` 或 Git/npm 安装获得同等「看图 / 读文档」能力。

## 功能总览

### ① 视觉孪生 adapter（原生缩略图 + 自动分析）

- **Proxy 原位包装**：对被勾选的模型所属 provider，用 `Proxy` 把其 adapter 包装成「孪生」并原位替换（`registerTwinAdapters`，卸载经 `ctx.effect` 还原），不重复注册。
- **`listModels` / `resolveModel`**：对被勾选模型声明 `inputModalities: ['text','image']`、名称加「(视觉)」后缀 → DSH 认为它支持图片 → **原生缩略图渲染、图片块进会话、粘贴准入**全部解锁。
- **`stream` 拦截**：捕获请求里的 `image` block → 导出到 `~/.dsh/picturereader-vision/images/` → 替换成文本路径 + 本地工具链引导 → 转发给原始 adapter。**pi-ai 收到的是纯文本，不会报 `UNSUPPORTED_CONTENT`**；`opencode-go` 等走 `@earendil-works/pi-ai` 的 provider 同样经此孪生获得原生缩略图能力。
- 隐私模式下分析只走本地工具，绝不外发。

### ② 智能路由（隐私 / 智能 / 严谨 三模式）

**这是 picturereader 的"大脑"**：统一在 `routing.js` + `runtime.js` 收敛「什么时候走外部 VLM、什么时候只用本地、要不要交叉验证」，供各工具 / 图片桥 / 视觉孪生 `stream` / `vision_analyze` 共享，保证整条图链都遵守同一套路由策略。

#### 路由决策原理

每次看图，模型面对的问题其实是同一个：「这张图，值得花什么成本、用哪条路线读懂它？」picturereader 把答案预置成三种策略，模型据此自主决策，同时 host 侧做硬约束兜底：

```
图片进来 → 孪生 stream 拦截 / 工具被调用
        → 读入当前「模式」→ 得到该模式的路由策略
        → 模型 / 工具按策略选路线：
            本地像素分析（image_scan / image_sample）
            本地文字识别（image_ocr：windows / macos / paddle / rapid）
            外部语义理解（vision_analyze include_vlm=true → VLM）
            交叉验证（多路证据对照）
```

核心决策函数 `visionAnalyzeDefaults(mode)` 定义各模式"默认的证据组合"：

| 模式 | 默认 include_scan | 默认 include_ocr | 默认 include_vlm | allow_low_info |
|---|---|---|---|---|
| **隐私（privacy）** | ✅ | ✅ | ❌（硬禁） | ❌ |
| **智能（smart）** | ✅ | ❌（按需） | ✅（值得才调） | ❌ |
| **严谨（strict）** | ✅ | ✅ | ✅ | ❌ |

#### 三种模式的路线策略

**🕶 隐私模式（Privacy）——零外呼硬门禁**
- **绝不调用**任何外部视觉端点，即使你在设置卡配了 API。
- 约束是 host 侧强制：`runtime.js` 使 `isVlmConfigured()` 恒为 `false`，`vision_analyze` 强制 `include_vlm=false`，视觉孪生 `stream` 的降级文本也明确"只用本地工具"。
- 模型只能用本地工具：`image_scan` / `image_ocr` / `image_sample` / `image_crop` / `image_palette` / `image_compare` / `image_edit`。图片字节不出本机。
- 适用：敏感图片（身份证、合同、私人截图）、离线、零外部流量审计场景。

**⚡ 智能模式（Smart）——省轮数、省时间（默认）**
- 目标：**先把成本压到最低，复杂内容才值得外呼**。
- 决策流程：先 `image_scan` 快速看整体 → 自行判断：
  1. 图片以文字为主 → `image_ocr` 读文字即可，**不必调 VLM**；
  2. 普通图表 / 界面 / 简单内容 → `image_scan` + `image_sample` 自己看就能说清，**不必调 VLM**；
  3. 仅当内容复杂、需语义理解（照片、抽象画面）**且配置了端点**时，才 `vision_analyze(include_vlm=true)` 走外部 VLM。
- 视觉孪生死活都会先把图片导出成本地路径，模型可随时本地深挖，不会被困在"必须外呼"的死路。

**🎯 严谨模式（Strict）——交叉验证、细看细节**
- 目标：**可靠性优先**，不贪省。
- 决策：先 `image_scan` 了解整体 → 必要时 `image_ocr` 读文字、`image_sample` 细看细节 → 对关键判断做**交叉验证**（把像素证据、OCR 证据、（可选）VLM 语义描述相互对照，不轻信单一来源）。
- 允许使用外部 VLM（需配置），但强度更高、可追溯。
- 适用：需要高准确率与可复现结论的场景（审图、校对、数据分析）。

> **隐私硬门禁贯穿所有入口**：无论走哪个工具/桥，`runtime.js` 的模式快照都会在调用点做校验，`routePolicyText(mode)` 还会把当前策略注入给模型的提示里，双保险。

#### 与视觉孪生 adapter 的协同

三模式不仅约束 `vision_analyze`，也约束视觉孪生 `registerTwinAdapters` 的 `stream` 拦截：图片块总是被**无条件**替换成文本（路径 + 本地证据引导，这是模型能读懂的前提），但**是否/何时进一步外呼 VLM** 由当前模式决定——隐私模式恒不透传图片、不发起外部调用；智能/严谨模式在需要且已配置时才走外部语义理解。因此"原生缩略图"与"隐私零外呼"可以同时成立，互不冲突。

### ③ 本地工具链（纯本地读取）

| 工具 | 作用 |
|---|---|
| `image_scan` | 全局/区域扫描：颜色网格 + regions 色块 + shade diversity + texture + structure + hue families；支持 `focus`/`region`/`px_per_cell` 定向放大 |
| `image_ocr` | 文字识别**四引擎**：`windows`（内置）/ `macos`（macOS 原生 Vision，免装第三方，首次一条命令编译）/ `paddle`（选装，发光/弯曲/游戏字更强）/ `rapid`（选装，轻量快速）；paddle/rapid 缺失自动降级不崩溃 |
| `image_sample` | N×N 精确像素取样，判断材质/纹理 |
| `image_crop` | 按 region 裁剪并导出 PNG |
| `image_palette` | 颜色提取：主色列表（hex + 命名单 + 占比）+ 色相家族 |
| `image_compare` | 两图/两区域像素对比：mean_diff / diff_ratio / diff_box / verdict，可选差异可视化预览 |
| `image_batch` | 批量规模/上下文验证：批量扫描 + 类型判定 + 自动全量 OCR + 是否值得深入建议 |
| `vision_analyze` | 统一入口：低信息拦截 + 可选像素扫描 / OCR / VLM，按模式路由，返回多路证据 |

> **OCR 引擎平台说明**：`windows` 引擎仅在 Windows 平台可用、`macos` 引擎仅在 macOS 平台可用（设置卡按平台条件显示对应选项）；`paddle` / `rapid` 为跨平台选装引擎，任何平台都可使用。未配置时默认跟随当前平台原生引擎（Windows→windows、macOS→macos、其他→paddle），跨平台迁移的旧配置会自动回落到平台默认值。

### ④ 文档转图片 `document_to_image`

把 **pdf / docx / doc / xlsx / xls / pptx / ppt** 逐页转成 PNG（LibreOffice headless → PDF → PyMuPDF），供模型逐页 OCR / 扫描分析。纯本地、零网络；支持 `dpi` / `max_pages` / `out_dir` / 批量 `file_paths`。

### ⑤ 外部 VLM 桥（已支持，由 LLM 自行调用）

**已支持外部视觉 API，且调用时机完全交给 LLM 自主判断**：配置好 OpenAI 兼容端点后（LM Studio / llama-server / 云端网关 / GLM-4V-Flash 免费模型），模型在**智能 / 严谨模式**下会自行判断"这张图是否值得外呼视觉模型"——简单内容用本地像素/OCR 就够，复杂内容（照片、抽象画面、需语义理解）才通过 `vision_analyze(include_vlm=true)` 调 `sendVisionRequest` 以 data URI 送图给外部 VLM，取回语义描述。**baseURL 自动补 `/v1/chat/completions`**（无需手写完整路径）。

- LLM 自行调用 = 你不用手动切模型/手动发图，模型按模式策略在该外呼时自己调外部 API。
- 隐私模式仍为硬门禁：即使配置了外部 API 也绝不调用、绝不外发图片字节。

### ⑥ 设置卡片「图片阅读」

Web 设置页注册「图片阅读」卡片（settings-panel 设计语言：卡片分组 + 胶囊按钮 + 折叠高级项）：使用模式、外部视觉 API、视觉桥模型多选、OCR 引擎（平台条件显示）、高级设置（详见「设置卡字段」）。改动写 `~/.dsh/settings.yaml` 即时生效。

### ⑦ 粘贴即用 + 缩略图

开启视觉孪生并选择「(视觉)」模型变体后：粘贴/拖入图片 → 原生缩略图 → 图片块进会话 → 被孪生 `stream` 拦截 → 导出文本路径 + 本地证据 → 纯文本模型拿到结果，可继续用 `image_scan` / `image_ocr` 深挖。

### ⑧ 本地修图工具 `image_edit`

一个工具、多个 action 分发，后端为隔离的 `image_venv` Python（Pillow + OpenCV-headless，可选 rembg / rawpy / realesrgan CLI），**纯 CPU、无需 GPU / 大模型**。所有图片字节不出本机。

> 依赖安装：`node scripts/setup-image-venv.mjs`（核心）/ `node scripts/setup-image-venv.mjs --full`（再加 rembg + rawpy）。详见下方专门章节。

## image_edit 本地修图工具

本地批量 / 单张修图。调用示例：

```text
用 image_edit 把 <路径> 缩放到宽 800：action=resize, file_path=<路径>, width=800, height=600
给 <路径> 加左下角文字水印：action=watermark, file_path=<路径>, type=text, text="©2026", position=bottom_left, font_size=40
把 <背景> 和 <前景> 合成（贴图）：action=composite, file_path=<背景>, file_paths=[<前景>], position=bottom_right, alpha=0.8
把 <IMG1>、<IMG2> 水平拼接：action=stitch, file_path=<IMG1>, file_paths=[<IMG2>], direction=horizontal
```

### 支持的 action（P0 / P1 / P2）

| 分级 | action | 说明 | 依赖 |
|---|---|---|---|
| **P0** | `resize` | 缩放：`width,height` + `mode`（stretch/fit/fill） | Pillow |
| **P0** | `rotate` | 旋转：`angle`（度）+ `expand` + `fill` | Pillow |
| **P0** | `flip` | 翻转：`axis`（horizontal/vertical/both） | Pillow |
| **P0** | `convert` | 格式互转：png/jpg/webp/bmp/tiff/gif（由 out 扩展名决定） | Pillow |
| **P0** | `adjust` | 亮度/对比度/饱和度：`brightness,contrast,saturation`（1.0=不变） | Pillow |
| **P0** | `blur` | 模糊：`type`（gaussian/box/motion）+ `radius` | Pillow |
| **P0** | `sharpen` | 锐化：`radius,percent,threshold`（UnsharpMask） | Pillow |
| **P0** | `composite` | 合成/叠加（贴图）：主图叠加 `file_paths[0]` 于 `position` 与 `alpha` | Pillow |
| **P0** | `watermark` | 水印：`type=text`（`text,color,font_size`）或 `type=image`（`file_paths[0]`） | Pillow |
| **P0** | `thumbnail` | 缩略图：`width,height`（保持比例） | Pillow |
| **P1** | `edges` | 边缘检测/描边：`low,high`（Canny） | OpenCV |
| **P1** | `equalize_hist` | 直方图均衡化（增强对比度）：`mode`（auto/clahe） | OpenCV |
| **P1** | `denoise` | 降噪：`strength`（fastNlMeansDenoisingColored，纯 CPU） | OpenCV |
| **P1** | `perspective` | 透视校正（矫正歪斜文档/建筑照）：`points`（8 数）+`width,height` | OpenCV |
| **P1** | `stitch` | 多图拼接：`direction`（horizontal/vertical）+ `file_paths` | Pillow |
| **P1** | `remove_background` | 背景移除：U²-Net（`--full` 装 rembg，约 35MB，CPU 几十秒） | rembg |
| **P2** | `exif_read` | 读取 EXIF（Make/Model/曝光等） | Pillow |
| **P2** | `exif_write` | 写 EXIF：`fields`（标签名→值） | Pillow |
| **P2** | `raw_convert` | RAW 转图：`rawpy`（基于 libraw，`--full` 装） | rawpy |
| **P2** | `upscale` | 超分辨率放大 2–4x：realesrgan-ncnn-vulkan 独立 CLI（Vulkan，无需 PyTorch） | 外部 CLI |
| **P2** | `colorspace` | 色彩空间：`target`（rgb/hsv/lab/gray/cmyk） | OpenCV |
| **P2** | `morphology` | 形态学：`op`（erode/dilate/open/close/gradient）+`size` | OpenCV |

### 依赖与降级策略

- **P0 全部**仅需 Pillow；**P1 除 remove_background 外**仅需 OpenCV-headless。
- `remove_background` 需要 rembg（`--full`）；`raw_convert` 需要 rawpy（`--full`）；`upscale` 需要外部 realesrgan-ncnn-vulkan CLI（环境变量 `DSH_REALESRGAN_EXE`）。
- 可选依赖缺失时，**不是崩溃**，而是返回清晰的中文提示（"请先运行 `node scripts/setup-image-venv.mjs [--full]`" / "请设置 DSH_REALESRGAN_EXE"）。
- `image_venv` Python 未搭建时，工具返回 `node scripts/setup-image-venv.mjs` 安装提示（与 document_to_image 的 doc_venv 一致）。
- 全部动作默认超时 120s；`remove_background` 300s；`upscale` / `denoise` 更长，避免后台阻塞。

## 与主流多模态插件的差异 / 优势

对比常见方案（`dsh-tool-vision`、`dsh-image-paste`、`dsh-vision-bridge` 等）：

1. **不绑定单一厂商**：视觉孪生对任意 provider 生效（含 `opencode-go` / xiaomi / qiu 等 pi-ai 系），不是只适配某一家 API。
2. **全链路可离线**：隐私模式零外呼；本地纯 JS 像素工具 + 4 引擎 OCR（含平台原生引擎），不依赖云端。
3. **工具链完整**：裁剪 / 取色 / 对比 / 批量 / 文档转图 / **本地修图 image_edit**，一个插件全覆盖。
4. **原生缩略图**：真正 DSH 原生图片块（`inputModalities` 声明），非文本路径模拟。
5. **快**：本地工具毫秒级；可控 VLM 调用（低信息拦截 + 智能模式"值得才调"）省轮数与耗时。
6. **只写不读 key、隐私硬门禁**：API Key 以 `role:'secret'` 保存、只写不读不回显；隐私模式经 `runtime.js` 强制 `isVlmConfigured()=false`。

| 能力 | **picturereader** | dsh-tool-vision | dsh-image-paste | dsh-vision-bridge |
|---|---|---|---|---|
| 原生缩略图（文本模型） | ✅ 视觉孪生 adapter | ❌ | ⚠️ 部分 | ❌ |
| 任意 provider（含 pi-ai 系） | ✅ | 绑定厂商 | — | — |
| 隐私模式硬门禁 | ✅ | — | — | ❌ |
| 本地像素工具链（scan/ocr/crop/palette/compare） | ✅ 全内置 | ⚠️ 基础 | ❌ | ❌ |
| 本地修图（缩放/滤镜/水印/去背景等） | ✅ image_edit | ❌ | ❌ | ❌ |
| 文档转图片（pdf/word/excel/ppt） | ✅ | ❌ | ❌ | ❌ |
| 批量/上下文验证 | ✅ | ❌ | ❌ | ❌ |
| 外部 VLM 桥（可选，OpenAI 兼容） | ✅ | ✅ | ❌ | ✅ |
| 全离线可用 | ✅ | ⚠️ | ✅ | ❌ |

## 快速上手

```sh
# 1. 安装插件
dsh plugin --profile web add picturereader        # npm 包；或从源码: dsh plugin --profile web add .
dsh plugin --profile headless add picturereader

# 2.（推荐）安装读图方法论 skill
copy skills\image-reading.md %USERPROFILE%\.dsh\skills\          # Windows
# cp skills/image-reading.md ~/.dsh/skills/                      # macOS / Linux

# 3.（可选）增强 OCR 引擎
node scripts/setup-ocr.mjs       # PaddleOCR（发光/弯曲/游戏字更强；跨平台选装）
node scripts/setup-rapid.mjs     # RapidOCR（轻量快速；跨平台选装）
node scripts/setup-macos.mjs     # macOS 原生 Vision OCR（仅 macOS，需 Xcode 命令行工具）

# 4.（可选）文档转图片依赖（需已装 LibreOffice）
node scripts/setup-doc-venv.mjs  # 建 doc_venv 装 PyMuPDF

# 5.（可选）本地修图 image_edit 依赖
node scripts/setup-image-venv.mjs          # 建 image_venv 装 Pillow + OpenCV-headless + piexif
node scripts/setup-image-venv.mjs --full   # 再加 rembg（背景移除）+ rawpy（RAW）
```

重启 DSH Desktop 后：模型工具列表出现全部工具（含 `image_edit`），设置页出现「图片阅读」卡片。

### 启用视觉孪生（原生缩略图）

1. 在设置页「图片阅读」勾选要作为视觉孪生的文本模型，保存后**重启 DSH**。
2. 模型选择器中选择对应模型的「(视觉)」变体（如 `deepseek-v4-flash (视觉)`）。
3. 粘贴 / 拖入图片 → 原生缩略图 → 图片块自动分析为文本证据。

### 使用示例

```text
用 image_scan 看一下 <路径> 这张图，细看感兴趣的部分
（复杂场景可接着用 vision_analyze；如有文字先 image_ocr；一批图用 image_batch；
  文档用 document_to_image 逐页转成图片再看；
  要修改图片用 image_edit，如 action=resize / watermark / remove_background）
```

## Code Mode（工具折叠）兼容说明

DSH 的 `tools` 呈现有三种 `mode`：`native`（默认，模型可直呼所有工具）、`code`（只允许模型直呼 `run_code`，其它工具折叠进 `run_code` 的生成 SDK 内调用）、`both`（两种都能用）。

- **picturereader 所有工具与 mode 无关**：`native` / `both` 下全部可直呼；`code` 下也**完全可用**，只是要经 `run_code` 程序内调用（`await tools.image_scan(...)` / `await tools.image_edit(...)` / `await tools.vision_analyze(...)`）。工具会被自动投影进 `run_code` 生成的 SDK，一个都不少。
- **若报错** `Error: unknown tool "vision_analyze" ... only run_code is callable directly ...`——这不是插件坏了，而是当前会话处于 `code` 模式、仍以直呼方式发起了调用。两种情况任选其一：
  1. 把该部署的 `tools.mode` 设为 `both`（最省心：直呼 + run_code 都能用，不会降速）；
  2. 保持 `code` 模式，改用 `run_code` 程序调用（见下方示例）。
- **推荐**：日常使用直接保持 `native` 或 `both`；`code` 是平台级的"只留 run_code"硬化模式，对本地看图工具是净亏（更多轮数、更多 token），非必要不开。

在 `code` 模式下用 `run_code` 调用示例（Python）：

```python
async def main():
    r = await tools.image_scan({"file_path": r"C:\path\to\img.png"})
    return r

await main()
```

## 三模式（使用模式）

在 Web 设置 →「图片阅读」卡片顶部选择，修改即时生效。

| 模式 | 是否调用外部视觉 API | 模型行为引导 | 适用场景 |
|---|---|---|---|
| **隐私模式** | **绝不调用**（即使配置了 API） | 只走本地工具：image_scan / image_ocr / image_sample / image_crop / image_palette / image_compare / image_edit | 敏感图片、离线、零外部流量 |
| **智能模式**（默认） | 允许，但先本地看图再决定 | 先 `image_scan` 快速看，文字→OCR、简单图→本地、复杂图才 `vision_analyze` 外呼 | 日常，省轮数与耗时 |
| **严谨模式** | 允许 | 自行选择路线 + 多证据交叉验证 + 细看细节 | 需要高准确率与可追溯的场景 |

> 隐私模式约束是 host 侧硬门禁（`runtime.js`）：`isVlmConfigured()` 在此模式下恒返回 `false`，`vision_analyze` 强制 `include_vlm=false`，图片桥引导也明确「只用本地工具」。

## 设置卡字段（图片阅读）

设置卡片采用 settings-panel 设计语言（卡片分组 / 胶囊按钮 / 折叠高级项），包含：

- **使用模式**：隐私 / 智能 / 严谨（`mode`）。
- **启用外部视觉 API（选配）**：勾选后才显示并允许调用外部视觉端点；不勾选一律走本地，图片绝不外发（`vlm_enabled`）。
- 勾选后显示：
  - **视觉 API Base URL**（`vlm_base`，如 `https://api.openai.com/v1` 或 `http://127.0.0.1:1234`；留空=禁用外部 VLM）
  - **视觉模型**（`vlm_model`）
  - **视觉 API Key**（`vlm_key`，`password`+`secret`：只写不读，留空保持当前，填写保存即覆盖、不回显）
  - **Key 环境变量**（`vlm_key_env`，apiKey 为空时回退读取）
  - **默认 OCR 引擎**（`ocr_engine`：按平台条件显示——Windows 显示 windows/paddle/rapid，macOS 显示 macos/paddle/rapid，其他平台显示 paddle/rapid；未配置时默认跟随平台原生引擎）
- **视觉桥模型多选**（`vision_models`）：勾选即生成该模型的「(视觉)」变体；改动需**重启 DSH** 生效；已勾选模型会被兜底并入列表保持打钩，与孪生注入一致。
- **高级设置**（折叠）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `vlm_timeout_ms` | `300000` | 外部视觉请求超时（毫秒） |
| `vlm_max_tokens` | `8192` | 外部视觉最大输出 Tokens |
| `bridge_export_dir` | 空（系统临时目录） | 图片桥导出目录 |
| `max_image_bytes` | `52428800` (50MB) | 单张图片读取大小上限（字节） |
| `scan_default_size` | `32` | image_scan 默认格子大小 |
| `scan_palette` | `auto` | image_scan 默认色板（auto/full/basic/gray） |
| `scan_mode` | `auto` | image_scan 默认模式（auto/ascii/color） |
| `ocr_language` | 空 | OCR 默认语言（BCP-47，如 zh-Hans / en-US） |
| `multimodal_models` | 空 | 多模态白名单（逗号分隔，这些模型直收图片不降级） |
| `request_guard` | `true` | 请求保护（llm/stream 最后防线降级 image block） |
| `batch_probe_first` | `3` | image_batch 探测前几张（判断是否文字密集） |
| `batch_ocr_limit_chars` | `800` | image_batch 每张 OCR 截断字符数 |
| `doc_dpi` | `150` | document_to_image 渲染 DPI |
| `doc_max_pages` | `50` | document_to_image 最大页数 |
| `debug` | `false` | 调试日志（llm/stream 图片桥与模型缓存读取的诊断输出） |

## 环境变量

> 以下 venv 解释器默认路径指向作者开发环境，普通用户请按本机实际 venv 路径设置对应环境变量（或仅使用平台原生引擎：Windows 的 `windows` / macOS 的 `macos` 零依赖）。

### 本地修图 image_edit（选装，Pillow+OpenCV）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_IMAGE_PYTHON` | `C:\Users\Administrator\image_venv\Scripts\python.exe` | image_edit 后端 venv 解释器路径（Pillow/OpenCV） |
| `DSH_REALESRGAN_EXE` | `realesrgan-ncnn-vulkan` | 超分 CLI 可执行路径（`upscale` 用，Vulkan） |

### OCR（选装）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_PADDLE_PYTHON` | `C:\Users\Administrator\paddle_venv\Scripts\python.exe` | PaddleOCR 解释器路径 |
| `DSH_PADDLE_CACHE` | `~/.paddlex-cache` | PaddleX 模型缓存目录（v3.0.x 曾默认到作者开发机路径 `D:/coding/.../.paddlex-cache`，已修复为 HOME） |
| `DSH_RAPID_PYTHON` | `C:\Users\Administrator\rapid_venv\Scripts\python.exe` | RapidOCR 解释器路径 |
| `DSH_MACOS_OCR_BIN` | `~/.dsh/cache/picturereader/macos-ocr` | macOS Vision OCR 可执行文件路径（setup-macos.mjs 编译产物） |

### 文档转图片（选装）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_SOFFICE` | `C:/Program Files/LibreOffice/program/soffice.exe` | LibreOffice headless 可执行路径 |
| `DSH_DOC_PYTHON` | `C:\Users\Administrator\doc_venv\Scripts\python.exe` | 文档转换 venv 解释器路径（PyMuPDF） |

### 外部视觉 API / VLM（可选，也可在设置卡填）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `SEE_API_KEY` / `GLM_API_KEY` | 空 | 视觉 API Key（设置卡 `vlm_key` 优先级更高） |
| `SEE_BASE` | 智谱或设置卡 `vlm_base` | OpenAI 兼容视觉端点 |
| `SEE_MODEL` | `glm-4v-flash` 或设置卡 `vlm_model` | 视觉模型名 |
| `SEE_SERVER_EXE / MODEL / MMPROJ` | 空 | 本地 llama-server 自启路径（可选） |
| `SEE_SERVER_PORT / NGL / CTX` | `8080 / 20 / 16384` | 本地服务器参数 |

> 设置卡 `vlm_base / vlm_model / vlm_key` 优先于环境变量；隐私模式下即使配置也**不调用**。端点未写 `/v1` 时自动补 `/v1/chat/completions`。

## 已知限制

- **DSH attachment 单图默认约 5MB**：超大图片可能被宿主上传限制拦截；工具端的 `max_image_bytes`（默认 50MB）是读取上限。
- **原生缩略图需启用视觉孪生**：文本模型默认不被 DSH 视为「支持图片」，需在设置卡勾选生成「(视觉)」变体并重启。
- **WebP 暂不支持**：`image_scan` / `vision_analyze` 等对 WebP 报错，请先转成 PNG / JPEG；`image_edit` 的 `convert` 可把 WebP 转成 PNG/JPEG。
- **平台引擎不可跨平台**：`windows` / `macos` OCR 引擎分别限定对应平台（设置卡按平台显示）；跨平台迁移后旧配置会自动回落到当前平台默认引擎。
- **`image_edit` 部分动作需可选依赖**：`remove_background`（rembg）、`raw_convert`（rawpy）、`upscale`（realesrgan CLI）需 `--full` 安装或外部 CLI；缺失时返回安装提示而非崩溃。
- **rembg 首次运行需联网下载 U²-Net 模型**：约 35–176MB，缓存于 `~/.u2net`；之后离线可用。
- **paddle 引擎首次调用会下载模型**（多源 fallback，缓存于 `~/.paddlex-cache`）：下载过程可能打印干扰行，插件已做防御过滤，首次调用不再失败（issue #2 已修复）。
- **视觉桥模型勾选需重启 DSH** 生效（`vision_models` 的改动不会热加载）。
- **`dsh-file-drop` 需停用**：其「拖入图片即注入文本」与视觉孪生/图片桥的自动分析可能冲突（重复/竞争注入），建议在对应 profile 停用；原生缩略图 + 图片桥自动分析已覆盖该需求。
- **外部 VLM 依赖网络/端点**：未配置端点或离线时自动跳过并给出提示；隐私模式恒不调用。

## 拖拽上传问题排查

如果遇到图片拖拽上传不工作的问题，请按以下步骤排查：

1. **检查 `dsh-file-drop` 插件状态**：在 DSH 设置中检查 `dsh-file-drop` 插件是否启用。如果启用，请尝试禁用它，因为该插件可能与 picturereader 的图片桥冲突。

2. **检查视觉孪生配置**：确保在设置页「图片阅读」中已勾选需要视觉桥的模型，并重启 DSH。

3. **检查浏览器控制台**：打开浏览器开发者工具，查看控制台是否有 `[picturereader]` 相关的日志输出。如果有错误信息，请记录并反馈。

4. **检查网络请求**：在开发者工具的 Network 标签中，查看是否有 `/picturereader/models` 等请求。如果没有，可能是插件未正确加载。

5. **重启 DSH**：某些配置更改需要重启 DSH 才能生效。

## 测试情况

### v3.3.0

- `node --test` 全量 **146 通过 / 0 失败**：
  - `tests/macos.test.js`：macOS Vision OCR 引擎套件（Windows 平台自动跳过，需编译 `macos-ocr` 二进制后实跑）。
  - `tests/image-edit.test.js`：8 项单测（action 校验、参数构造、超时、错误透传）。
  - `tests/ocr.test.js`：paddle 引擎真实用例（本机 paddle_venv 实测 `image_ocr(engine="paddle")` 通过，验证 w/h→width/height 修复）。
  - 其余读图工具链、三模式、视觉孪生、document_to_image、batch、decode、sample 等全部通过。
- 后端 `scripts/image-edit.py` 端到端冒烟（Pillow + OpenCV）：**24/24 通过**。

### v3.1.0 集成测试

内置 `node:test` 单测（工具、三模式、桥）+ 真实素材集成测试通过：本地工具链、文档转图片（pdf/docx/pptx/xlsx）、外部 VLM 真调通路（LM Studio）、三模式路由、视觉孪生 Proxy 均验证通过（24/24）。

### v3.0.3 集成测试（2026-08-20）

132/132 单元测试通过 + 13/13 文档转换测试通过 + 全功能集成测试：

| 功能 | 状态 | 说明 |
|------|------|------|
| image_scan | ✅ | 4 种格式、region/focus/px_per_cell/palette/mode 全部正确 |
| image_ocr (windows) | ✅ | 中英文识别正常 |
| image_ocr (rapid) | ✅ | 带 confidence score |
| image_ocr (paddle) | ✅ | v3.0.3 修复字段名后正常 |
| image_sample | ✅ | 8×8 精确像素取样 |
| image_crop | ✅ | 裁剪导出 PNG |
| image_palette | ✅ | 主色提取 + hue families |
| image_compare | ✅ | 相同/不同图片判定正确 |
| image_batch | ✅ | v3.0.3 修复 cordis inject 后正常 |
| document_to_image | ✅ | PDF/DOCX/PPTX/XLSX 全部正常 |
| vision_analyze (本地) | ✅ | scan + OCR 证据返回正常 |
| 三模式路由 | ✅ | privacy/smart/strict 逻辑全部正确 |
| 视觉孪生 adapter | ✅ | 3 个 provider 激活 |
| 设置持久化 | ✅ | vision_models / ocr_engine / mode 全部保留 |

## 版本更新日志

### v3.3.2（本次）

- **修复文本模型附件降级链路**：当模型入口将图片改写为 `[image omitted ...; attachment sha256:…]` 时，图片桥会在本地附件对象库中按 SHA 前缀查找唯一对象，验证 PNG/JPEG/GIF/BMP/WebP 文件头后导出并注入 `image_scan` / `image_ocr` 引导；找不到、前缀歧义或非图片对象时保持原文本，不猜测路径。
- 修复全局 SHA 匹配正则的状态残留，避免同轮多次检测后遗漏附件。
- 新增 SHA 降级恢复与无效 SHA 保持原文本的回归用例；`npm test` 全量 **148 通过 / 0 失败**。

### v3.3.1（本次）

- 元数据修正：npm `description` 中 OCR 引擎数量更正为 ×4（windows / macos / paddle / rapid）。

### v3.3.0

- **新增 macOS 原生 Vision OCR 引擎**：`engine="macos"`（`scripts/macos-ocr.swift` + `scripts/setup-macos.mjs` 一键编译，默认中文优先、BCP-47 language 参数、像素坐标框契约与 paddle/rapid 一致），供 macOS 用户零第三方依赖使用（PR #4 合入）。
- **OCR 引擎按平台条件显示**：设置卡 `windows` 引擎仅 Windows、`macos` 引擎仅 macOS（paddle/rapid 跨平台始终显示），未配置时默认平台原生引擎；跨平台迁移旧配置自动回落。
- **修复 PaddleOCR 新环境首次调用必失败（issue #2）**：① AI Studio 下载源的 `<Response [404]>` stdout 污染 → 解码前过滤非 base64 行；② paddle 输出 `w/h` → 改为 schema 要求的 `width/height`；③ `paddleCacheHome()` 默认路径从作者开发机改为 `~/.paddlex-cache`。
- **peerDependencies 兼容 DSH 0.1.1-rc.2（issue #3）**：`^0.1.0-rc.6 || ^0.1.1-rc.2` 联合区间。
- **设置卡 UI 重做**：settings-panel 设计语言（卡片分组、胶囊按钮、32px 输入框、chevron 下拉、折叠箭头）；`scope.load()` 兼容无 load 宿主（EAC 桌面壳）。
- **调试日志门控**：llm/stream 图片桥诊断日志改由 `debug` 设置项控制，默认不再刷屏。

### v3.2.0

- **新增 `image_edit` 本地修图工具**：22 种纯 CPU 动作（Pillow + OpenCV-headless，可选 rembg / rawpy / realesrgan CLI）——P0 基础（resize/rotate/flip/convert/adjust/blur/sharpen/composite/watermark/thumbnail）、P1 进阶（edges/equalize_hist/denoise/perspective/stitch/remove_background）、P2 高级（exif_read/write/raw_convert/upscale/colorspace/morphology）。
- 新增 `scripts/setup-image-venv.mjs`（`--full` 装 rembg+rawpy）与 `scripts/image-edit.py` 后端。
- 新增环境变量 `DSH_IMAGE_PYTHON` / `DSH_REALESRGAN_EXE`。
- 新增 `tests/image-edit.test.js` 单测 8 项 + 后端 24/24 冒烟，全部通过。

### v3.1.x（前版）

- **v3.1.0**：新增 `read_image` 工具拦截（避免 image block 触发 `UNSUPPORTED_CONTENT`）；内置 `image-reading` 技能注册；内置依赖安装完整性修复落地。

### v3.0.x（前版）

- **v3.0.6**：修复依赖安装完整性（`jpeg-js`/`omggif`/`pngjs` 随插件预装），图析功能不再静默失败。
- **v3.0.5**：修复 `scope.load()` 兼容（设置页「图片阅读」空白）。
- **v3.0.4**：Code Mode 工具折叠兼容说明。
- **v3.0.3**：设置持久化修复、PaddleOCR 字段名、本地 VLM 端点检测、cordis4 兼容。
- **v3.0.0**：视觉孪生 adapter、三模式路由、本地工具链、文档转图片、3 引擎 OCR、设置卡。

## 开发 / 仓库布局

```sh
# 本仓库 main（DSH 版，源码位于仓库根目录）
npm install
npm test                       # node:test
node scripts/setup-ocr.mjs     # 可选（PaddleOCR）
node scripts/setup-rapid.mjs   # 可选（RapidOCR）
node scripts/setup-macos.mjs   # 可选（仅 macOS Vision OCR）
node scripts/setup-doc-venv.mjs# 可选（文档转换）
node scripts/setup-image-venv.mjs  # 可选（本地修图 image_edit，--full 加 rembg/rawpy）
node scripts/preview.mjs       # 生成 fixtures 并预览渲染
```

- **热插拔**：业务逻辑集中在 `src/core.js` 单文件，工具每次执行按 mtime 动态加载；工具定义（schema/描述）与设置卡改动需重启桌面端。
- **ZCode 版**：位于本仓库 [zcode 分支](https://github.com/jing-hy/picturereader/tree/zcode)（源码在 `zcode/`），经 MCP server 暴露工具，安装 `npm install picturereader-zcode`。两版共用 `src/core.js` 与读图方法论 skill。

## License

MIT