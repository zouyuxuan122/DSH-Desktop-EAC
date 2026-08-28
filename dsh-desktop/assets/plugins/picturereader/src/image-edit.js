/**
 * picturereader — image_edit tool.
 *
 * 本地修图 / 图像处理工具。一个工具、多个 action 分发（P0 基础变换 / P1 进阶 /
 * P2 可选高级），后端为隔离的 image_venv Python（scripts/image-edit.py，
 * 核心 Pillow + OpenCV-headless，可选 rembg/rawpy，纯 CPU，无需 GPU/大模型）。
 *
 * 与 document_to_image 相同的架构：
 *   - Node 端把输入图从 DSH 虚拟文件系统材料化为本地临时文件；
 *   - 构造 request JSON（含 action 与全部参数）写入临时文件；
 *   - spawnSync 调用 image_venv 的 python 跑 scripts/image-edit.py；
 *   - 解析其 stdout 的最后一行 JSON 作为结果。
 *
 * 环境变量：DSH_IMAGE_PYTHON 指向 image_venv 的 python.exe，默认
 *   C:\Users\Administrator\image_venv\Scripts\python.exe。
 * 缺失时返回清晰提示：`node scripts/setup-image-venv.mjs`。
 *
 * 支持 action:
 *   P0: resize / rotate / flip / convert / adjust / blur / sharpen /
 *       composite / watermark / thumbnail
 *   P1: edges / equalize_hist / denoise / perspective / stitch / remove_background
 *   P2: exif_read / exif_write / raw_convert / upscale / colorspace / morphology
 *
 * @module picturereader/image-edit
 */

import { join, basename as pathBasename, resolve as pathResolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Absolute path to scripts/image-edit.py (this module lives in src/). */
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'image-edit.py');

/** The isolated venv python used to run the image backend (env overridable). */
const IMAGE_VENV_PY = process.env.DSH_IMAGE_PYTHON ?? 'C:\\Users\\Administrator\\image_venv\\Scripts\\python.exe';

/** Hard cap on how many bytes we read into memory per input image. */
const MAX_INPUT_BYTES = 200 * 1024 * 1024; // 200 MB

/** Default action->timeout (ms). 背景移除 / 超分较慢。 */
const ACTION_TIMEOUT_MS = {
  default: 120_000,
  remove_background: 300_000,
  upscale: 600_000,
  denoise: 180_000,
  perspective: 120_000,
};

const ACTIONS = [
  // P0
  'resize', 'rotate', 'flip', 'convert', 'adjust', 'blur', 'sharpen',
  'composite', 'watermark', 'thumbnail',
  // P1
  'edges', 'equalize_hist', 'denoise', 'perspective', 'stitch', 'remove_background',
  // P2
  'exif_read', 'exif_write', 'raw_convert', 'upscale', 'colorspace', 'morphology',
];

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('image_edit: cancelled');
}

/** Resolve a writable output path: explicit out, or a generated path under out_dir/temp. */
function resolveOutPath(rawOut, rawDir, fingerprint, cwd) {
  const stamp = (fingerprint && fingerprint !== 'anon' ? fingerprint : 'anon');
  const base = rawDir !== undefined && rawDir !== null && String(rawDir).trim().length > 0
    ? (cwd ? pathResolve(cwd, String(rawDir).trim()) : pathResolve(String(rawDir).trim()))
    : join(tmpdir(), 'picturereader-edit', stamp);
  if (rawOut !== undefined && rawOut !== null && String(rawOut).trim().length > 0) {
    const p = String(rawOut).trim();
    return { out: (cwd ? pathResolve(cwd, p) : pathResolve(p)), base };
  }
  return { out: join(base, `edit_${Date.now()}-${randomBytes(4).toString('hex')}.png`), base };
}

/**
 * Run image-edit.py for a materialized request. Returns the parsed JSON result.
 */
function runImageEditPython(reqPath, timeoutMs, signal) {
  throwIfAborted(signal);
  const res = spawnSync(IMAGE_VENV_PY, [SCRIPT_PATH, reqPath], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  if (res.error) {
    if (res.error.code === 'ABORT_ERR' || signal?.aborted) {
      throw new Error('image_edit: cancelled');
    }
    if (res.error.code === 'ENOENT') {
      throw new Error(
        `image_edit: 图像处理所需的 Python 环境缺失。请先运行 \`node scripts/setup-image-venv.mjs\` 创建 image_venv（位于 ${IMAGE_VENV_PY}）。`
      );
    }
    throw new Error(`image_edit: 调用图像脚本失败: ${res.error.message}`);
  }
  if (res.signal && res.signal === 'SIGTERM' && signal?.aborted) {
    throw new Error('image_edit: cancelled');
  }
  if (res.signal || res.status === null) {
    throw new Error('image_edit: 处理进程被终止（超时或中断）');
  }
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line || '{}');
  } catch (e) {
    throw new Error(`image_edit: 无法解析图像脚本输出: ${e.message}`);
  }
  if (parsed?.error) {
    throw new Error(`image_edit: ${parsed.error}`);
  }
  return parsed;
}

/**
 * Build the `image_edit` tool.
 * @param ctx - the Cordis context providing `ctx.fs`.
 */
export function createImageEditTool(ctx) {
  return {
    name: 'image_edit',
    description: [
      'Local photo editing / image processing on a local image via a single unified tool (Pillow + OpenCV, pure CPU, no GPU/model). ' +
        'One call performs ONE action; see "action". All operate on a file_path and write to an output path.',
      'Supported actions (P0 基础): resize, rotate, flip, convert, adjust, blur, sharpen, composite, watermark, thumbnail.',
      'Supported actions (P1 进阶): edges, equalize_hist, denoise, perspective, stitch, remove_background.',
      'Supported actions (P2 高级): exif_read, exif_write, raw_convert, upscale, colorspace, morphology.',
      'Common params: action (required); file_path (input, required); out (optional output path, default auto in out_dir/temp); ' +
        'out_dir (optional); file_paths (array of extra inputs, used by composite/watermark/stitch). ' +
        'Action-specific params: see the action descriptions below.',
      'resize: width,height (required ints), mode (stretch|fit|fill, default stretch).',
      'rotate: angle (deg, required), expand (bool default true), fill (hex or r,g,b or transparent).',
      'flip: axis (horizontal|vertical|both, required).',
      'convert: format is inferred from OUT extension (png/jpg/webp/bmp/tiff/gif).',
      'adjust: brightness,contrast,saturation (float, 1.0 = unchanged).',
      'blur: type (gaussian|box|motion), radius (default 2).',
      'sharpen: radius (default 2), percent (default 150), threshold (default 3).',
      'composite: overlays file_paths[0] onto file_path at position (x,y or center/top_left/top_right/bottom_left/bottom_right/top_center/bottom_center) with alpha (0..1).',
      'watermark: type (text|image). text: text,color (#rrggbb),font_size,alpha,position. image: file_paths[0],position,alpha.',
      'thumbnail: width,height (max bounds, keeps aspect ratio).',
      'edges (P1): low,high (Canny thresholds).',
      'equalize_hist (P1): mode (auto|clahe).',
      'denoise (P1): strength (default 10).',
      'perspective (P1): points (8 ints, 4 corners), width,height (out size).',
      'stitch (P1): direction (horizontal|vertical), file_paths for additional images. mode (resize|raw).',
      'remove_background (P1): needs rembg installed. post_process (bool).',
      'exif_read (P2): returns extra.exif. exif_write (P2): fields (map of tag name -> value).',
      'raw_convert (P2): needs rawpy; input is a RAW file (cr2/nef/arw/dng...). camera_wb (bool).',
      'upscale (P2): needs realesrgan-ncnn-vulkan CLI (env DSH_REALESRGAN_EXE); scale (2|4), model, n.',
      'colorspace (P2): target (rgb|hsv|lab|gray|cmyk).',
      'morphology (P2): op (erode|dilate|open|close|gradient), size (kernel, default 3).',
      'Requires the image_venv Python (Pillow+OpenCV). If missing, returns a setup hint: `node scripts/setup-image-venv.mjs`.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: '要执行的处理动作。一次只能一个。'
        },
        file_path: {
          type: 'string',
          description: '主输入图片路径（必填）。raw_convert 时是 RAW 文件。'
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '附加输入数组（composite/watermark 的前景、stitch 的更多图）。'
        },
        out: {
          type: 'string',
          description: '输出路径（含扩展名，决定格式）。缺省自动生成到 out_dir 或临时目录。'
        },
        out_dir: {
          type: 'string',
          description: '输出目录（可选的，默认系统临时目录）。'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          out_path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          format: { type: 'string' },
          summary: { type: 'string' },
          extra: { type: 'object', additionalProperties: true }
        },
        required: ['ok', 'action', 'summary']
      },
      render: (_args, value) => {
        const lines = [value.summary || `image_edit (${value.action})`];
        if (value.out_path) {
          lines.push(`  output: ${value.out_path}`);
          lines.push(`  size: ${value.width}x${value.height}px, ${value.bytes} bytes, ${value.format || ''}`);
        }
        if (value.extra?.exif) {
          lines.push(`  exif fields: ${Object.keys(value.extra.exif).length}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      // ---- action 校验 ----
      const action = typeof args.action === 'string' ? args.action.trim() : '';
      if (!ACTION_SET.has(action)) {
        throw new Error(`image_edit: 未知 action "${action}"（支持: ${ACTIONS.join(', ')}）。`);
      }

      // ---- 材料化所有输入文件 ----
      const rawMain = typeof args.file_path === 'string' ? args.file_path.trim() : '';
      if (!rawMain) {
        throw new Error('image_edit: 需要 file_path（输入图片路径）。');
      }
      const raws = [rawMain];
      if (Array.isArray(args.file_paths)) {
        for (const p of args.file_paths) {
          if (typeof p === 'string' && p.trim().length > 0) raws.push(p.trim());
        }
      }

      const cwd = exec.agent?.session?.header?.cwd;
      const fingerprint = exec.agent?.session?.id || 'anon';
      const { out, base } = resolveOutPath(args.out, args.out_dir, fingerprint, cwd);

      const tmpDir = mkdtempSync(join(tmpdir(), 'picturereader-edit-src-'));
      const materialized = []; // { localPath }
      try {
        for (const raw of raws) {
          throwIfAborted(exec.signal);
          const target = await ctx.fs.resolve(raw, {
            ...(cwd !== undefined ? { cwd } : {}),
            signal: exec.signal
          });
          const display = target.displayPath;
          const info = await ctx.fs.stat(target, exec.signal);
          if (!info || info.type !== 'file') {
            throw new Error(`image_edit: 找不到文件: ${display}`);
          }
          const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_INPUT_BYTES);
          const localBase = pathBasename(display) || `img${Date.now()}`;
          // 保留原扩展名（Pillow/rawpy 均按内容/扩展名识别；raw_convert 输入是 RAW）。
          const localPath = join(tmpDir, localBase);
          writeFileSync(localPath, bytes);
          materialized.push({ localPath, displayPath: display });
        }

        // ---- 构造 request JSON（action + 全部透传参数 + 材料化路径）----
        const passKeys = ['width', 'height', 'mode', 'keep_ratio', 'angle', 'expand', 'fill', 'axis',
          'brightness', 'contrast', 'saturation', 'type', 'radius', 'percent', 'threshold',
          'position', 'alpha', 'text', 'color', 'font_size', 'low', 'high', 'strength',
          'points', 'direction', 'post_process', 'fields', 'camera_wb', 'scale', 'model', 'n',
          'target', 'op', 'size'];
        const params = {};
        for (const k of passKeys) {
          if (args[k] !== undefined && args[k] !== null) params[k] = args[k];
        }
        const request = {
          action,
          from: materialized[0].localPath,
          out,
          ...(materialized.length > 1 ? { from_extra: materialized.slice(1).map((m) => m.localPath) } : {}),
          ...params,
        };
        const reqPath = join(tmpDir, 'request.json');
        writeFileSync(reqPath, JSON.stringify(request));

        // ---- 调用后端（可注入 seam 便于测试）----
        const runner = typeof ctx._imageEditRunner === 'function'
          ? ctx._imageEditRunner
          : (rp, tm, sig) => runImageEditPython(rp, tm, sig);
        const timeout = ACTION_TIMEOUT_MS[action] || ACTION_TIMEOUT_MS.default;
        const result = runner(reqPath, timeout, exec.signal);

        return {
          ok: true,
          action,
          out_path: result.out_path ?? out,
          width: result.width ?? null,
          height: result.height ?? null,
          bytes: result.bytes ?? null,
          format: result.format ?? null,
          summary: result.summary || `image_edit ${action} 完成。`,
          extra: result.extra ?? undefined,
          _baseDir: base,
        };
      } finally {
        // 清理输入临时目录（输出保留在 out 供后续工具读）。
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* best effort */ }
      }
    }
  };
}

const ACTION_SET = new Set(ACTIONS);

// 注册工厂，与会话内其他工具一致（index.js 统一调用）。
export function registerImageEdit(ctx) {
  ctx.tools.register(createImageEditTool(ctx));
}
