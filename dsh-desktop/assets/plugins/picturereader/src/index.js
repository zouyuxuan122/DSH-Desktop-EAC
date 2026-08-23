/**
 * picturereader — pixel-to-text image reading for text-only DeepSeek Harness
 * models.
 *
 * One plugin row registers a full local image-understanding toolset plus an
 * optional external vision API bridge, governed by the user's chosen usage
 * mode（设置页"图片阅读"卡片）：
 *
 *  - 隐私模式（privacy）：绝不调用外部 API，全走本地工具。
 *  - 智能模式（smart）：先简单看图再决定是否外呼，省轮数/时间。
 *  - 严谨模式（strict）：自行选择 + 必要时交叉验证细节。
 *
 * Tools registered:
 *  image_scan / image_ocr / image_sample      — 本地像素理解（原有）
 *  image_crop / image_palette / image_compare — 本地工具链扩充
 *  image_batch                                — 批量规模/上下文验证
 *  vision_analyze                             — 统一图像理解（按模式路由）
 *  document_to_image                          — 文档(pdf/word/excel/ppt)转图片
 *
 * Settings: host 侧把 `picturereader` 命名空间写入 DSH settings.yaml；client.js
 * 在 Web 设置页注册"图片阅读"卡片。mode / VLM 端点热加载。
 *
 * @module picturereader
 */

import { createImageScanTool, createImageOcrTool, createImageSampleTool } from './tool.js';
import { createVisionAnalyzeTool } from './vision-analyze.js';
import { registerMoreTools } from './more-tools.js';
import { createImageBatchTool } from './image-batch.js';
import { createDocumentToImageTool } from './doc-tools.js';
import { NS } from './config.js';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { ensureSettingsNamespaceExposed } from './settings-expose.js';
import { setRuntimeSource } from './runtime.js';
import { attachImageBridge } from './bridge.js';
import { registerTwinAdapters } from './picturereader-vision.mjs';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 内置技能：image-reading */
const IMAGE_READING_SKILL = {
  name: 'image-reading',
  description: 'Read and understand images like a multimodal model using the picturereader tools (image_scan / image_ocr / image_sample). Applies a verified 5-step workflow (global tone → find subjects → verify text → judge material → synthesize) guided by grounded principles and cross-image insights. Use whenever you need to look at an image.',
  content: `# 读图方法论（image-reading）

目标：**像多模态模型一样"看"图并输出连贯描述**，每个结论可追溯、可验证。
本 skill 由 experience / skill / principle / insight 四层知识构成（按
Gogomoe 知识框架分类，教训均来自对真实图片的实测复盘）。

## 操作流程（skill）

### 1. 全局定调（第一轮扫描）

用默认参数（size=40）全图扫描，读四个字段：
- **\`hue families\`（最高优先级）**：按纯色相分族的真实占比。暗调/低饱和场景的
  真实颜色只在这里——\`colors by area\` 灰白占比高不代表画面灰白。
- **\`structure\`**：平行条带/对称性（解读见 insights）。
- **\`texture\`**：rough 高=写实照片；smooth 高=扁平或水面/天空/雾（见 insights）。
- **\`regions\`**：大结构的位置/大小/颜色。

### 2. 找主体（全局→局部，主动验证）

- 对**颜色异常区、深色大块、相邻竖长色块、小色块密集区**用 \`px_per_cell\` 定向放大
  （值越小越细：8-12 看轮廓，4-6 看结构，2-3 看细节；区域不够小时工具会提示实际密度，缩小 focus/region 重试）。
- 放大后按**形状**解读：头+肩+躯干=人物；弧线+对称明暗=圆柱/球/装置；
  竖直细长结构=石柱/塔/杆；交替细条=面板/栅格。
- **主体可能与背景低对比而"隐形"**（见 insights 4）——怀疑处必须放大确认，不能因 regions 未单列就跳过。

### 3. 文字验证

- 疑似文字/标识/UI → \`image_ocr\`（region/focus 限定）。
- Windows 引擎读不出但怀疑有字 → \`engine="paddle"\` 重试（发光/弯曲/游戏渲染文字）。
- **OCR 结果优先于模型描述**（见 insights 3）。

### 4. 材质判断

\`image_sample\` 对小块区域 8×8 取样，看 RGB 分布与 contrast 统计
（平滑渐变=天空/皮肤/水面；高对比条纹=金属/木纹；暗绿 G>R>B=植物/涂装）。

### 5. 综合描述

输出连贯描述（场景/主体/环境光线/细节），**每个结论标注证据等级**：
实锤（有像素/OCR/取样数据）vs 推断（基于结构推测，用"看起来像"）。
优先引用具体数字；不确定就说不确定，绝不编造。

## 行为准则（principles）

1. **证据分级**：任何结论标注"实测"或"推断"；推断必须说明依据。
2. **数字优先**：用具体指标（"蓝色调 74%""对称 80%""OCR 读出 1.00"）支撑描述，不用模糊形容词代替。
3. **先全局后局部**：第一轮定调，第二轮定向放大验证，不跳步。
4. **怀疑即验证**：对任何"可能漏掉的主体"，用放大/取样/OCR 验证后再下结论。
5. **不编造**：不确定就说明；模型（含多模态）的描述不可直接当作事实（见 insights 3）。

## 规律性洞察（insights，跨图归纳）

1. **暗调场景的真实颜色只在 hue families 里**：低饱和/暗色调（暮色、雾中、夜景）
   会被 14 色色板压成灰黑，\`colors\` 的灰白占比是假象——hue families 按纯色相分族不受影响。
2. **高对称 ≠ 一定人造物**：水面倒影/镜像构图也高度对称。区分看：平滑大面积
   （水面/天空 smooth 高）+ 水天分界线（上亮下暗、上下镜像）+ 竖直细长结构（石柱）
   = 湖泊/自然镜像；纹理复杂、颜色单调、几何硬边 = 人造建筑/装置。
3. **小模型读小字不可靠**：多模态小模型对低分辨率文字会幻觉（全图"读出"内容、
   裁剪后承认没有）；发光/弯曲/艺术字 Windows OCR 也失效——**文字一律以 OCR 实读为准**。
4. **低对比主体"隐形"**：暗色物体（如深色服装人物）在暗背景中融入背景黑块，
   粗网格和 regions 都不会标出——对深色区域主动放大是唯一可靠发现方式。
5. **平滑大面积 ≠ 扁平简笔画**：水面、天空、雾气、墙面都平滑（smooth 高），
   需结合色调/结构/场景判断，不能仅凭 smooth 判定"扁平"。
6. **"像什么"和"是什么"要分开**：结构证据（对称/形状/色调）支撑"像什么"；
   "是什么"需要 OCR/取样/更强证据，不满足时保持推断。
7. **hue families 是场景类型指纹**（34 张图训练归纳）：
   - cyan 高（>60%）= 水/雾/湖泊/晨雾场景（东方水景、浓雾遗址）
   - green 高（>40%）= 森林/竹林/草地/苔藓
   - orange 或 red 高 = 红披风/暖色服饰人物、火光、晚霞
   - blue 高（>70%）= 夜晚/冷色科幻场景
   - achromatic 高 + rough 高 = 废墟/岩石/暗环境
   - green + yellow 双高 = 翠绿能量带/发光植被/浮空仙境
   - 对称高 + 中央竖直结构 = 中央主体（瀑布/树/大门）居中构图
8. **多模态模型的颜色描述对"发光/能量"不可靠**（训练中反复出现）：把实测为
   cyan/blue/green 的冷色发光（屏幕光、能量屏障、雾中光柱）系统性说成"粉红/紫色"。
   发光元素的颜色一律以 hue 实测为准。
9. **人物识别信号**：orange/red 主调 + 局部暖色小块 + 对称 = 人物服饰候选；
   游戏角色常穿红/橙（红披风、红发、暖色战斗服），识别到暖色主调时应主动放大找人物。
10. **品牌/游戏名/标题文字**：多模态模型会猜错（"原神""崩坏3"实际是明日方舟终末地），
    必须 PaddleOCR 实读（游戏 HUD 底部常带游戏名/参数/水印）。

## 案例参考（experience，简短）

- 湖泊仙侠图：对称 97% 被误判为"人造立面"，实为水面倒影+湖中石柱+粉紫雾气
  → 教训沉淀为 insight 2。
- 游戏发光标语图：Windows OCR 12 格全空、多模态幻觉"问问答写"，
  PaddleOCR 一次读出「勇于探索叩问苍穹」→ 教训沉淀为 insight 3。
- 暗背景人物图：黑服人物融入背景被漏检，px_per_cell=3 放大后头肩躯干清晰
  → 教训沉淀为 insight 4。

（新增经验会持续按以上分类沉淀进本 skill。）

## vision_analyze 统一工具

当需要一次性获取多种证据时，使用 \`vision_analyze\`：
- 自动检测空白/简单图片（低信息量拦截）
- 可选像素扫描（include_scan）
- 可选 OCR 文字识别（include_ocr）
- 可选 VLM 语义描述（include_vlm，需配置 SEE_BASE）
- 所有证据以文本形式返回，供主模型推理

### 推荐的工作流程

建议先用 \`image_scan\` 自己看，了解图片内容后再决定是否需要调用 VLM。简单图片用像素扫描就够了，复杂场景可以调用 VLM。

### 多次提问

对同一张图可以进行多次不同角度的提问，获取更全面的理解。

### 交叉验证

VLM 描述与像素/OCR 证据冲突时，以实测为准。

详细用法见 \`skills/vision-analyze.md\`。`,
  modelInvocable: true,
  userInvocable: true,
};

/** 扫描结果存储路径（独立文件，不干扰 settings.yaml 的用户配置）。 */
const MODELS_CACHE = join(homedir(), '.dsh', 'picturereader-models.json');

export const name = 'picturereader';

/** 设置命名空间的运行时 schema（schemastery）。 */
const Config = z.object({
  mode: z
    .string()
    .default('smart')
    .description('使用模式：privacy 隐私 / smart 智能 / strict 严谨'),
  vlm_enabled: z
    .boolean()
    .default(false)
    .description('选配：是否启用外部视觉 API。勾选后才显示并允许调用外部视觉端点；未勾选一律走本地'),
  vision_bridge_enabled: z
    .boolean()
    .default(false)
    .description('（已废弃，改用 vision_models）'),
  vision_models: z
    .array(z.object({
      id: z.string(),
      provider: z.string().default(''),
      note: z.string().default(''),
    }))
    .default([])
    .description('视觉桥模型列表：被勾选的文本模型会生成「(视觉)」变体'),
  vlm_base: z
    .string()
    .default('')
    .description('OpenAI 兼容视觉端点 URL（如 https://api.openai.com/v1；空=禁用外部 VLM）'),
  vlm_model: z.string().default('gpt-4o-mini').description('视觉模型名'),
  vlm_key: z.string().default('').role('secret').description('视觉 API key（只写不读，不会回显）'),
  vlm_key_env: z
    .string()
    .default('')
    .description('环境变量名（vlm_key 为空时回退读取，如 VISUAL_API_KEY）'),
  ocr_engine: z
    .string()
    .default('windows')
    .description('默认 OCR 引擎：windows / paddle / rapid'),
  vlm_timeout_ms: z
    .number()
    .default(300000)
    .description('高级：外部视觉请求超时（毫秒）'),
  vlm_max_tokens: z
    .number()
    .default(8192)
    .description('高级：外部视觉最大输出 Tokens'),
  bridge_export_dir: z
    .string()
    .default('')
    .description('高级：图片桥导出目录（空=系统临时目录）'),
  max_image_bytes: z
    .number()
    .default(52428800)
    .description('高级：单张图片大小上限（字节，默认50MB）'),
  scan_default_size: z
    .number()
    .default(32)
    .description('高级：image_scan 默认格子大小（8..64）'),
  scan_palette: z
    .string()
    .default('auto')
    .description('高级：image_scan 默认色板（auto/full/basic/gray）'),
  scan_mode: z
    .string()
    .default('auto')
    .description('高级：image_scan 默认模式（auto/ascii/color）'),
  ocr_language: z
    .string()
    .default('')
    .description('高级：OCR 默认语言（BCP-47，如 zh-Hans / en-US）'),
  multimodal_models: z
    .string()
    .default('')
    .description('高级：多模态白名单（逗号分隔，这些模型直收图片不降级）'),
  request_guard: z
    .boolean()
    .default(true)
    .description('高级：请求保护（llm/stream 最后防线降级 image block）'),
  batch_probe_first: z
    .number()
    .default(3)
    .description('高级：image_batch 探测前几张（判断是否文字密集）'),
  batch_ocr_limit_chars: z
    .number()
    .default(800)
    .description('高级：image_batch 每张 OCR 截断字符数'),
  doc_dpi: z
    .number()
    .default(150)
    .description('高级：document_to_image 渲染 DPI（72..300）'),
  doc_max_pages: z
    .number()
    .default(50)
    .description('高级：document_to_image 最大页数（1..500）'),
  debug: z
    .boolean()
    .default(false)
    .description('高级：调试日志'),
});

/** Services required at runtime. */
export const inject = ['tools', 'fs', 'llm', 'attachments'];

export function apply(ctx, config) {
  // ── 把命名空间加进 dsh-host-apiproxy 白名单 ──
  try {
    ensureSettingsNamespaceExposed(ctx, NS, ctx.logger);
  } catch (error) {
    ctx.logger?.warn?.(`[picturereader] settings-expose failed: ${String(error)}`);
  }

  // ── 运行时快照：工具执行时惰性读最新 mode / VLM 配置 ──
  let sourceGetter = null;
  const getConfig = () => (sourceGetter ? sourceGetter() : config);
  setRuntimeSource(getConfig);

  // ── 注册工具（不需要 settings/llm 服务）──
  ctx.effect(() => {
    ctx.tools.register(createImageScanTool(ctx));
    ctx.tools.register(createImageOcrTool(ctx));
    ctx.tools.register(createImageSampleTool(ctx));
    ctx.tools.register(createVisionAnalyzeTool(ctx));
    registerMoreTools(ctx);
    ctx.tools.register(createImageBatchTool(ctx));
    ctx.tools.register(createDocumentToImageTool(ctx));
  });

  // ── 注册内置技能（image-reading）──
  try {
    if (ctx.skills && typeof ctx.skills.register === 'function') {
      ctx.effect(() => {
        return ctx.skills.register(IMAGE_READING_SKILL);
      }, 'picturereader: image-reading skill');
      console.log('[picturereader] registered image-reading skill');
    }
  } catch (error) {
    ctx.logger?.warn?.(`[picturereader] skill registration failed: ${String(error)}`);
  }

  // ── 注册模型列表 API 路由（供 client 设置卡读取扫描结果）──
  try {
    ctx.inject(['webServer'], (sctx) => {
      const webServer = sctx.webServer;
      if (!webServer || typeof webServer.register !== 'function') return;
      const handler = async (req, res) => {
        try {
          const data = await readFile(MODELS_CACHE, 'utf-8');
          console.log('[picturereader] models route: read', data.length, 'bytes from', MODELS_CACHE);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(data);
        } catch (err) {
          console.log('[picturereader] models route: read failed:', String(err));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
        }
      };
      ctx.effect(() => webServer.register({ kind: 'exact', path: '/picturereader/models', handler }), 'picturereader: models route');
    });
  } catch {}

  // ── 图片桥：等 attachments 服务就绪后再注册（读图需要它）──
  try {
    ctx.inject(['attachments'], (sctx) => {
      attachImageBridge(ctx);
    });
  } catch (error) {
    ctx.logger?.warn?.(`[picturereader] image bridge disabled: ${String(error)}`);
  }

  // ── 设置命名空间 + 模型扫描 + 视觉孪生路由（需要 settings 和 llm 服务）──
  ctx.inject(['settings', 'llm'], (sctx) => {
    const llm = sctx.llm;
    const settingsNs = settingsNamespace(NS);
    const scope = sctx.settings.register(settingsNs, Config, { base: config });
    sourceGetter = () => scope.get();
    scope.watch(() => { /* 触发热更 */ });

    // ── 扫描所有 provider 的文本模型 → 写入 available_text_models ──
    (async () => {
      try {
        if (!llm || typeof llm.listProviders !== 'function') {
          return;
        }
        const providers = llm.listProviders();
        const textModels = [];
        for (const p of providers) {
          try {
            const models = await llm.listModels(p.id);
            for (const m of models) {
              const mods = m.inputModalities || [];
              if (!mods.includes('image')) {
                textModels.push({ provider: p.id, id: m.id, name: m.name || m.id });
              }
            }
          } catch { /* 跳过 */ }
        }
        // 兜底：把用户已勾选的模型并入列表（即使某 provider 的模型扫描漏了，
        // 只要在 vision_models 里就应显示+打钩，与孪生保持一致）。
        try {
          const cfg = scope.get();
          const vms = Array.isArray(cfg?.vision_models) ? cfg.vision_models : [];
          for (const entry of vms) {
            const id = typeof entry === 'string' ? entry : entry?.id;
            const provider = typeof entry === 'object' ? (entry?.provider || '') : '';
            if (!id) continue;
            const exists = textModels.some((t) => t.provider === provider && t.id === id);
            if (!exists) textModels.push({ provider, id, name: id });
          }
        } catch { /* 兜底失败忽略 */ }
        if (textModels.length > 0) {
          await mkdir(join(MODELS_CACHE, '..'), { recursive: true });
          await writeFile(MODELS_CACHE, JSON.stringify(textModels, null, 2));
        }
      } catch {
        // 模型扫描失败静默
      }
    })();

    // ── 视觉孪生：包裹被勾选模型所属 provider 的 adapter，声明支持图片 + stream 拦截图片 ──
    try {
      registerTwinAdapters(ctx, llm, getConfig);
    } catch (e) {
      ctx.logger?.warn?.(`[picturereader] twin adapters failed: ${String(e?.message || e)}`);
    }
  });
}
