/**
 * vision_analyze — unified image understanding tool.
 *
 * Runs the full local vision pipeline:
 *   1. decode + low-information guard
 *   2. optional pixel scan (image_scan)
 *   3. optional OCR (image_ocr)
 *   4. optional local/remote VLM description
 *
 * All evidence is returned as text so a text-only model can reason about the
 * image without trusting any single source blindly.
 *
 * Key features:
 * - Smart API calling: simple images don't call external APIs
 * - Cross-validation: main model verifies VLM results against pixel/OCR evidence
 * - Multiple questions: support asking different questions about the same image
 *
 * @module picturereader/vision-analyze
 */

import { extname } from 'node:path';
import { BYTE_CAP, MAX_PIXELS } from './tool.js';
import { isLowInformationImage } from './guard.js';
import { ensureServer, stopServer, sendVisionRequest, defaultVlmConfig, isVlmConfigured, DEFAULT_BASE, DEFAULT_API_KEY } from './vlm.js';
import { getRuntimeConfig } from './runtime.js';
import { visionAnalyzeDefaults, isPrivacy, routePolicyText } from './routing.js';

const CORE_URL = new URL('./core.js', import.meta.url).href;
let coreCache = { url: null, mtime: -1, module: null };

/**
 * Load the latest core.js module with cache-busting.
 * @returns {Promise<object>} the core module namespace.
 */
async function importCore() {
  const { stat } = await import('node:fs/promises');
  const url = new URL(CORE_URL);
  const info = await stat(url);
  if (coreCache.module !== null && coreCache.url === CORE_URL && info.mtimeMs === coreCache.mtime) {
    return coreCache.module;
  }
  const module = await import(`${url.href}?t=${info.mtimeMs}`);
  coreCache = { url: CORE_URL, mtime: info.mtimeMs, module };
  return module;
}

/**
 * Parse a boolean argument with fallback.
 * @param {any} value - the argument value.
 * @param {boolean} fallback - default value.
 * @returns {boolean} parsed boolean.
 */
function boolArg(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value) === 'true' || String(value) === '1';
}

/**
 * Build the vision_analyze tool.
 * @param {object} ctx - the Cordis context.
 * @returns {object} the tool definition.
 */
export function createVisionAnalyzeTool(ctx) {
  return {
    name: 'vision_analyze',
    description: [
      'PREFERRED over read_image for text-only models: Unified image understanding: decode an image, run a low-information guard, optionally scan pixels, OCR text, and/or ask the VLM for a semantic description.',
      'Use this instead of read_image when the model does not support image input. Use this when you need one call to both verify what is in the image and get a natural-language interpretation.',
      'Returns evidence blocks: scan (pixel stats), ocr (real text), vlm (model description). If low-information guard triggers and allow_low_info is false, it will not call the VLM.',
      'Supported formats: PNG, JPEG, GIF (first frame), BMP. WebP is not supported yet.',
      'VLM is optional: if SEE_BASE is not configured, VLM calls are skipped automatically.',
      'Smart API calling: simple images (low color diversity, high dominant color coverage) skip VLM automatically.',
      'Multiple questions: call this tool multiple times with different prompts on the same image for comprehensive analysis.',
      'Cross-validation: main model should verify VLM results against pixel scan and OCR evidence.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the image file (PNG/JPEG/GIF/BMP).'
        },
        prompt: {
          type: 'string',
          description: 'Question/instruction for the VLM, e.g. "Describe this UI" or "What is wrong with this map rendering?"'
        },
        include_scan: {
          type: 'boolean',
          description: 'Include pixel scan evidence (default true).'
        },
        include_ocr: {
          type: 'boolean',
          description: 'Include OCR text evidence (default false; set true when text matters).'
        },
        ocr_engine: {
          type: 'string',
          enum: ['windows', 'paddle', 'rapid', 'macos'],
          description: 'OCR engine: default follows the plugin setting (windows when unset); macos = macOS Apple Vision OCR (see image_ocr for details).'
        },
        include_vlm: {
          type: 'boolean',
          description: 'Include VLM description (default true, but skipped if SEE_BASE not configured).'
        },
        allow_low_info: {
          type: 'boolean',
          description: 'Skip the low-information guard and force VLM even on blank/simple images (default false).'
        },
        stop_after: {
          type: 'boolean',
          description: 'Stop the local llama-server after this call if this plugin started it (default false).'
        }
      },
      required: ['file_path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          lowInformation: { type: 'boolean' },
          message: { type: 'string' },
          scan: { type: 'string' },
          ocr: { type: 'string' },
          vlm: { type: 'string' },
          combined: { type: 'string' }
        },
        required: ['path']
      },
      render: (_args, value) => {
        const text = value.combined ?? value.message ?? JSON.stringify(value);
        return [{ type: 'text', text }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('vision_analyze: cancelled');
      const filePath = String(args.file_path ?? '').trim();
      if (!filePath) throw new Error('vision_analyze: file_path must be a non-empty string');

      const ext = extname(filePath).toLowerCase();
      const core = await importCore();
      if (core.UNSUPPORTED_EXTENSIONS.has(ext)) {
        throw new Error('vision_analyze: WebP is not supported yet — convert to PNG or JPEG first');
      }
      if (!core.IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`vision_analyze: unsupported image type "${ext}" (supported: PNG, JPEG, GIF, BMP)`);
      }

      const cwd = exec.agent?.session?.header?.cwd;
      const target = await ctx.fs.resolve(filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (!info) {
        throw new Error(`vision_analyze: cannot read "${target.displayPath}": file not found`);
      }
      if (info.type !== 'file') {
        throw new Error(`vision_analyze: cannot read "${target.displayPath}": not a regular file`);
      }
      const data = await ctx.fs.readBytes(target, exec.signal, BYTE_CAP);
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const image = core.decodeImage(buf, ext);
      if (image.width * image.height > MAX_PIXELS) {
        throw new Error(
          `vision_analyze: ${image.width}x${image.height} exceeds the ${MAX_PIXELS}-pixel decode limit — downscale or crop first`
        );
      }

      const rt = getRuntimeConfig();
      const mode = rt?.mode ?? 'smart';
      const defaults = visionAnalyzeDefaults(mode);
      const privacy = isPrivacy(mode);
      const includeScan = args.include_scan === undefined ? defaults.includeScan : boolArg(args.include_scan, true);
      const includeOcr = args.include_ocr === undefined ? defaults.includeOcr : boolArg(args.include_ocr, false);
      // privacy 硬 gate：不管 include_vlm 传什么、外部是否配置，一律不调用 VLM。
      const includeVlm = privacy ? false : (args.include_vlm === undefined ? defaults.includeVlm : boolArg(args.include_vlm, true));
      const allowLowInfo = boolArg(args.allow_low_info, false);
      const stopAfter = boolArg(args.stop_after, false);
      const prompt = args.prompt ?? 'Describe this image in detail.';

      // 当前模式的调用策略，注入到返回文本里给主模型做路由引导。
      const modePolicy = routePolicyText(mode, { vlmConfigured: isVlmConfigured() });

      // Check if VLM is configured (privacy 下恒不可用)
      const vlmAvailable = privacy ? false : isVlmConfigured();
      const shouldCallVlm = includeVlm && vlmAvailable;

      const lowInfo = isLowInformationImage(image.data, image.width, image.height);
      const blocks = [];
      let ocrText = '';
      let scanText = '';
      let vlmText = '';

      if (lowInfo && !allowLowInfo) {
        const message =
          '[vision_analyze] 低信息量拦截：图片空白或内容极少，为避免 VLM 幻觉，未调用 VLM。' +
          '请检查截图是否空白/未渲染/窗口在屏幕外；如确需识别请设置 allow_low_info=true。';
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
        return { path: target.displayPath, lowInformation: true, message, combined: message };
      }

      if (includeScan) {
        const rtScan = rt?.scan || {};
        const analysis = core.analyzeImage(image.data, image.width, image.height, {
          size: rtScan.defaultSize || 32,
          mode: rtScan.mode || 'auto',
          region: undefined,
          palette: rtScan.palette || 'auto'
        });
        scanText = core.renderImageScan({
          path: target.displayPath,
          width: image.width,
          height: image.height,
          ...analysis
        });
        blocks.push(`[scan]\n${scanText}`);
      }

      if (includeOcr) {
        // Engine default follows the plugin setting; explicit args.ocr_engine wins.
        const engine = args.ocr_engine ?? getRuntimeConfig().ocr?.engine ?? 'windows';
        const ocr = await core.ocrImage(buf, ext, { engine });
        ocrText = core.renderOcr({
          path: target.displayPath,
          width: ocr.width,
          height: ocr.height,
          region: 'full',
          engine: ocr.engine,
          lines: ocr.lines
        });
        blocks.push(`[ocr]\n${ocrText}`);
      }

      if (shouldCallVlm) {
        const config = defaultVlmConfig();
        let startedByUs = false;
        try {
          const child = await ensureServer(config);
          startedByUs = child !== null;
          const base64 = buf.toString('base64');
          const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/bmp';
          const safePrompt =
            prompt +
            '\n\n重要：只描述图中明确可见的内容。如果图中没有明显物体/文字/界面元素，请直接回答：画面空白或内容极少。不要推测、不要脑补不存在的角色/场景/文字。';
          vlmText = await sendVisionRequest(config, [{ mime, base64 }], safePrompt);
          blocks.push(`[vlm]\n${vlmText}`);
        } finally {
          if (stopAfter && startedByUs) {
            await stopServer();
          }
        }
      } else if (includeVlm && !vlmAvailable) {
        const hasBase = DEFAULT_BASE.length > 0;
        const hasKey = DEFAULT_API_KEY.length > 0;
        if (hasBase && !hasKey) {
          blocks.push('[vlm] VLM 未就绪：已配置端点但缺少 API key。\n' +
            '要使用免费的 GLM-4V-Flash 视觉模型，请：\n' +
            '1. 访问 https://open.bigmodel.cn 注册智谱账号\n' +
            '2. 获取 API Key\n' +
            '3. 设置环境变量：GLM_API_KEY=你的key 或 SEE_API_KEY=你的key\n' +
            '4. 重启 DSH 生效');
        } else {
          blocks.push('[vlm] VLM 未配置（SEE_BASE 环境变量为空）');
        }
      }

      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
      const combined = [modePolicy, ...blocks].join('\n\n---\n\n');
      return {
        path: target.displayPath,
        lowInformation: false,
        ...(scanText ? { scan: scanText } : {}),
        ...(ocrText ? { ocr: ocrText } : {}),
        ...(vlmText ? { vlm: vlmText } : {}),
        combined
      };
    }
  };
}
