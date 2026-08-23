---
name: vision-analyze
description: Unified image understanding tool that combines pixel scan, OCR, and optional VLM for complete image analysis. Use when you need one call to both verify what is in the image and get a natural-language interpretation.
whenToUse: 需要一次性获取图片的多种证据（像素扫描 + OCR + VLM 描述）时使用。
---

# vision_analyze 统一识图工具

## 工具概述

`vision_analyze` 是 picturereader 的统一识图入口，一次调用可获取：
- **像素扫描证据**（image_scan）
- **OCR 文字识别**（image_ocr）
- **VLM 语义描述**（可选，需配置 SEE_BASE）

## 核心特性

### 1. 低信息量拦截
自动检测空白/简单图片，防止 VLM 幻觉：
- 颜色种类太少（≤8 种）
- 单一颜色占比过高（≥90%）
- 主导颜色且边缘稀少
- 亮度方差太小

### 2. 证据交叉验证
- VLM 描述与像素/OCR 冲突时，以像素/OCR 实测为准
- 所有证据以文本形式返回，供主模型推理

### 3. VLM 可选配置
- 默认不配置 VLM，只返回像素扫描和 OCR 证据
- 需要 VLM 时，设置 `SEE_BASE` 环境变量

### 4. 智能调用策略
- **简单图片**：不调用外部 API，使用像素扫描 + OCR 即可
- **复杂/精密图片**：调用外部 API 获取语义理解
- **多次提问**：支持对同一张图进行多次不同角度的提问

## 使用建议

### 推荐的工作流程

建议先用 `image_scan` 自己看，了解图片内容后再决定是否需要调用 VLM：

```
# 先看图片内容
image_scan(file_path="C:/shot.png", size=32)

# 根据结果决定下一步
# - 简单图片 → 直接描述，不需要 VLM
# - 需要文字 → image_ocr
# - 复杂场景 → vision_analyze（含 VLM）
```

### 何时调用 VLM

简单图片用像素扫描就够了，复杂场景可以调用 VLM 获取语义理解。具体由你根据图片内容判断。

### 交叉验证

主模型需要对 VLM 结果进行交叉验证：

1. **像素证据优先**：VLM 描述与像素扫描冲突时，以像素证据为准
2. **OCR 优先**：VLM 识别的文字与 OCR 冲突时，以 OCR 为准
3. **逻辑验证**：VLM 描述不符合逻辑时（如"天空是绿色的"），标记为幻觉
4. **多次提问验证**：对同一张图进行多次不同角度的提问，验证一致性

### 多次提问策略

对同一张图可以进行多次不同角度的提问，以获取更全面的理解：

```
# 第一次：整体描述
vision_analyze(
  file_path="C:/shot.png",
  prompt="描述这个图片的整体内容",
  include_scan=true,
  include_ocr=true,
  include_vlm=true
)

# 第二次：细节询问
vision_analyze(
  file_path="C:/shot.png",
  prompt="图片中有哪些文字？请详细列出",
  include_scan=false,
  include_ocr=false,
  include_vlm=true
)

# 第三次：推理判断
vision_analyze(
  file_path="C:/shot.png",
  prompt="这个界面设计是否合理？有哪些问题？",
  include_scan=false,
  include_ocr=false,
  include_vlm=true
)
```

## 使用方法

### 基本用法（无 VLM）
```
vision_analyze(
  file_path="C:/shot.png",
  include_scan=true,
  include_ocr=false,
  include_vlm=false
)
```

### 完整用法（含 VLM）
```
vision_analyze(
  file_path="C:/shot.png",
  prompt="描述这个界面，有哪些元素？布局是否正常？",
  include_scan=true,
  include_ocr=true,
  include_vlm=true,
  allow_low_info=false,
  stop_after=false
)
```

### 多次提问用法
```
# 对同一张图进行多次不同角度的提问
vision_analyze(file_path="C:/shot.png", prompt="整体描述", include_vlm=true)
vision_analyze(file_path="C:/shot.png", prompt="有哪些文字？", include_vlm=true)
vision_analyze(file_path="C:/shot.png", prompt="设计是否合理？", include_vlm=true)
```

## 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `file_path` | string | 必需 | 图片路径（PNG/JPEG/GIF/BMP） |
| `prompt` | string | "Describe this image in detail." | VLM 提示词 |
| `include_scan` | boolean | true | 是否包含像素扫描证据 |
| `include_ocr` | boolean | false | 是否包含 OCR 文字识别 |
| `ocr_engine` | string | "windows" | OCR 引擎：windows 或 paddle |
| `include_vlm` | boolean | true | 是否包含 VLM 描述（需配置 SEE_BASE） |
| `allow_low_info` | boolean | false | 是否允许低信息量图片调用 VLM |
| `stop_after` | boolean | false | 调用后是否停止本地 llama-server |

## 输出格式

```json
{
  "path": "C:/shot.png",
  "lowInformation": false,
  "scan": "[scan]\nimage: C:/shot.png (1920x1080 -> 32x18 cells, ...)\n...",
  "ocr": "[ocr]\nocr: C:/shot.png (1920x1080, region=full, engine=windows)\n...",
  "vlm": "[vlm]\n这是一个桌面应用程序的截图，包含...",
  "combined": "[scan]\n...\n\n---\n\n[ocr]\n...\n\n---\n\n[vlm]\n..."
}
```

## 使用场景

### 1. UI/界面验证
```
vision_analyze(
  file_path="C:/ui_screenshot.png",
  prompt="这个界面有哪些按钮？布局是否正常？有没有错位？",
  include_scan=true,
  include_ocr=true,
  include_vlm=true
)
```

### 2. 游戏截图分析
```
vision_analyze(
  file_path="C:/game_screenshot.png",
  prompt="这是什么游戏？画面中有什么角色/物体？",
  include_scan=true,
  include_ocr=true,
  include_vlm=true
)
```

### 3. 文档/图片 OCR
```
vision_analyze(
  file_path="C:/document.png",
  include_scan=false,
  include_ocr=true,
  include_vlm=false,
  ocr_engine="paddle"
)
```

### 4. 长任务视觉验证
```
# 循环验证流程
1. 截图
2. vision_analyze(file_path="C:/step1.png", include_scan=true, include_ocr=true)
3. 与预期比对
4. 不一致则修正
5. 再截图验证
```

## 配置说明

### PaddleOCR（可选）
```bash
# 安装 PaddleOCR
node scripts/setup-ocr.mjs

# 环境变量
DSH_PADDLE_PYTHON=C:\Users\Administrator\paddle_venv\Scripts\python.exe
DSH_PADDLE_CACHE=<插件目录>\.paddlex-cache
```

### VLM（可选，默认不配置）
```bash
# 本地 llama-server
SEE_BASE=http://127.0.0.1:8080/v1
SEE_MODEL=Huihui-Qwen3-VL-4B-Instruct-abliterated
SEE_SERVER_EXE=E:\llama\llama-server.exe
SEE_SERVER_MODEL=E:\llama\models\model.f16.gguf
SEE_SERVER_MMPROJ=E:\llama\models\mmproj-f16.gguf
SEE_SERVER_PORT=8080
SEE_SERVER_NGL=20
SEE_SERVER_CTX=16384

# 远程 API
SEE_BASE=https://api.openai.com/v1
SEE_MODEL=gpt-4-vision-preview
SEE_API_KEY=sk-xxx
```

## 注意事项

1. **VLM 可选**：默认不配置 VLM，`vision_analyze` 会跳过 VLM 调用，只返回像素扫描和 OCR 证据
2. **低信息量拦截**：空白/简单图片会自动拦截，不调用 VLM（防止幻觉）
3. **证据优先级**：像素扫描 > OCR > VLM（冲突时以实测为准）
4. **性能考虑**：VLM 调用需要 2-5 秒，建议在需要语义理解时才启用
5. **WebP 不支持**：需要先转换为 PNG/JPEG

## 与其他工具的关系

- **image_scan**：像素级扫描，返回详细的颜色/结构证据
- **image_ocr**：文字识别，返回 OCR 文本
- **image_sample**：材质/纹理取样
- **vision_analyze**：统一入口，组合以上证据 + 可选 VLM

**必须遵守的工作流程**：
1. **先用 `image_scan` 自己看**（像素扫描）→ 了解图片内容和复杂度
2. 根据扫描结果判断：
   - 简单图片（颜色单一、结构简单）→ 不需要 VLM，直接描述
   - 需要文字 → 用 `image_ocr`
   - 复杂场景（多人物、多物体、复杂背景）→ 用 `vision_analyze`（含 VLM）
   - 需要材质细节 → 用 `image_sample`
3. **不要直接调用 VLM**，先自己看再决定是否需要外部 API