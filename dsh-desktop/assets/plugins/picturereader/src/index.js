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
