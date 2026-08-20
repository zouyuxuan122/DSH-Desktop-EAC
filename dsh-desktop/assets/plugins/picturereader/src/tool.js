/**
 * The model-facing `image_scan` tool: read a local image as a coarse pixel
 * grid (downscaled + color-quantized) so a text-only model can "see" layout,
 * colors and rough shapes.
 *
 * HOT RELOAD: the entire business logic lives in `core.js`, which is loaded
 * dynamically with a cache-busting query keyed on the file's mtime. Editing
 * `core.js` (rendering, palette, decode, precision/color-depth algorithms)
 * therefore takes effect on the NEXT tool call without a process restart.
 * The tool definition itself (schema/description) is fixed at boot and only
 * changes after a restart.
 * @module picturereader/tool
 */

import { extname } from 'node:path';
import { stat } from 'node:fs/promises';

/** Hard cap on file bytes we are willing to read for a scan. */
export const BYTE_CAP = 50 * 1024 * 1024;
/** Hard cap on decoded pixel count (pure-JS decoders are slow on huge images). */
export const MAX_PIXELS = 24_000_000;

const CORE_URL = new URL('./core.js', import.meta.url).href;

let coreCache = { url: null, mtime: -1, module: null };

/**
 * Load the latest `core.js`, refreshing the module whenever the file changes.
 * Exported for tests; the optional `target` overrides the module URL.
 * @param target - module URL to load (defaults to this package's core.js).
 * @returns the core module namespace.
 */
export async function importCore(target = CORE_URL) {
  const url = new URL(target);
  const info = await stat(url);
  if (coreCache.module !== null && coreCache.url === target && info.mtimeMs === coreCache.mtime) {
    return coreCache.module;
  }
  const module = await import(`${url.href}?t=${info.mtimeMs}`);
  coreCache = { url: target, mtime: info.mtimeMs, module };
  return module;
}

/** The most recent core module, for synchronous tool-result rendering. */
let latestCore = null;

/** Coerce the size argument into a bounded integer. */
function parseSize(raw) {
  const size = Number(raw ?? 32);
  if (!Number.isInteger(size) || size < 8 || size > 64) {
    throw new Error('image_scan: size must be an integer between 8 and 64');
  }
  return size;
}

function parseMode(raw) {
  const mode = String(raw ?? 'auto');
  if (mode !== 'auto' && mode !== 'ascii' && mode !== 'color') {
    throw new Error("image_scan: mode must be one of 'auto', 'ascii', 'color'");
  }
  return mode;
}

/**
 * Build the tool over one plugin context.
 * @param ctx - the Cordis context providing `ctx.fs` (resolve/stat/readBytes)
 *   and observation events.
 */
export function createImageScanTool(ctx) {
  return {
    name: 'image_scan',
    description: [
      'Read a local image file as a coarse pixel grid (downscaled + color-quantized) so a text-only model can see layout, colors and rough shapes.',
      'Use it to inspect charts, screenshots, diagrams, UI mockups or photos: report dominant colors with percentages, relative positions of regions, coarse structure and luminance patterns.',
      'The result includes a luminance grid (rows top->bottom, columns left->right; " "=transparent, "." darkest, "@" brightest), a color grid for colorful images (one letter per cell, see legend), a "grid coords" line giving the row/col range, and a regions list: connected color blobs with position (grid rows/cols), size, aspect and texture density.',
      'Semantic reading: use the regions list plus your world knowledge to infer WHAT the image contains, not just raw colors — e.g. a large rough round green blob above a thin brown stem reads as a tree; a dense cluster of small bright blobs near the center with a dark smooth frame reads as a screen with content. Combine regions with the grids and zoom (focus/region) to verify.',
      'Realism judgment: the "shade diversity" line and each region\'s "N shade(s)" mix tell you how many hue+brightness variations an area has — 1-2 shades means flat/synthetic artwork (a sticker or diagram), many shades means photo-like content with lighting and gradients. Use this to say whether something looks drawn vs photographed.',
      'Structural hints are listed too: parallel stripes (alternating color bands) suggest panels/grilles/blades (e.g. solar panels, louvres, ribs); left-right symmetry suggests manufactured/constructed objects; smooth bright-to-dark gradients across a blob suggest curved surfaces (cylinders, spheres — e.g. a round module). Use these shape cues to identify objects, then verify with px_per_cell or image_sample on the area.',
      'To inspect details, work iteratively: first scan the full image (any size, default 32), identify the region you care about, then call image_scan again with focus: [row0, col0, row1, col1] — rows/cols are read from the "grid coords" line of that full scan, and you MUST keep size the SAME as that scan (focus itself provides the zoom: the same grid then covers only the focused area, so each cell shows finer detail). If you want even more detail, zoom again into a smaller focus inside the previous focused result, still with the same size. Alternatively pass region: [x0, y0, x1, y1] (0..1 fractions) which works with any size.',
      'For fine detail on a specific subject (a person, an object, a face): request a pixel density with px_per_cell — the number of source pixels each cell represents (e.g. px_per_cell: 4 makes every cell show a 4x4 pixel area). The tool clamps to 64 cells per side and reports the actual density in the header ("~XxYpx per cell"); if the region is too large for your requested density, shrink the region (zoom the focus) and retry. Use px_per_cell with region/focus, never for a whole huge image (too many cells).',
      'palette sets the color depth: auto (default, picks by content), full (14 colors), basic (8 colors) or gray (black/gray/white only).',
      'Note: "colors by area" reports TRUE pixel-level color shares (small colored details are never diluted away), and the "hue families" line breaks colors down by hue regardless of darkness — use it to spot pink/cyan/green content that a dark palette would otherwise hide (e.g. blossoms, water, vegetation).',
      'Limitation: no OCR/text recognition and no fine detail — thin lines and small glyphs may disappear at coarse sizes; zoom into a region to inspect details.',
      'size = target cells on the longer side (8..64, default 32). mode auto picks the color grid when the image is colorful.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the image file (PNG/JPEG/GIF/BMP), resolved by the filesystem backend.'
        },
        size: {
          type: 'integer',
          description: 'Target cell count on the longer side (8..64, default 32). Mutually exclusive with px_per_cell.'
        },
        px_per_cell: {
          type: 'integer',
          description: 'Requested source pixels per cell for fine detail (e.g. 2-16); clamped to 64 cells per side, actual density reported in the header. Use with region/focus on a small area, mutually exclusive with size.'
        },
        mode: {
          type: 'string',
          enum: ['auto', 'ascii', 'color'],
          description: "auto = color grid when colorful, else luminance grid (default); ascii = luminance only; color = include color grid."
        },
        palette: {
          type: 'string',
          enum: ['auto', 'full', 'basic', 'gray'],
          description: 'Color depth: auto (default) = pick by content, full = 14 colors, basic = 8 colors, gray = black/gray/white only.'
        },
        region: {
          type: 'array',
          description: 'Optional [x0, y0, x1, y1] fractions in 0..1 to zoom into part of the image. Mutually exclusive with focus.',
          items: { type: 'number' }
        },
        focus: {
          type: 'array',
          description: 'Zoom target as grid coordinates [row0, col0, row1, col1] (inclusive, based on the full-image grid the current size produces — read rows/cols from the "grid coords" line of a previous image_scan output). Mutually exclusive with region.',
          items: { type: 'integer' }
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
          width: { type: 'integer' },
          height: { type: 'integer' },
          gridWidth: { type: 'integer' },
          gridHeight: { type: 'integer' },
          region: { type: 'string' },
          palette: { type: 'string', enum: ['full', 'basic', 'gray'] },
          mode: { type: 'string', enum: ['auto', 'ascii', 'color'] },
          distinctShades: { type: 'integer' },
          colors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string' },
                hex: { type: 'string' },
                count: { type: 'integer' },
                pct: { type: 'number' }
              },
              required: ['name', 'hex', 'count', 'pct']
            }
          },
          ascii: { type: 'string' },
          colorGrid: { type: 'string' },
          colorLegend: { type: 'string' }
        },
        required: ['path', 'width', 'height', 'gridWidth', 'gridHeight', 'region', 'palette', 'mode', 'colors', 'ascii']
      },
      render: (_args, value) => {
        const renderer = latestCore?.renderImageScan;
        const text = renderer !== undefined && renderer !== null ? renderer(value) : `image_scan result for ${value.path}: ${JSON.stringify(value)}`;
        return [{ type: 'text', text }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('image_scan: cancelled');
      const filePath = String(args.file_path ?? '').trim();
      if (filePath.length === 0) throw new Error('image_scan: file_path must be a non-empty string');

      const ext = extname(filePath).toLowerCase();
      const core = await importCore();
      latestCore = core;

      if (core.UNSUPPORTED_EXTENSIONS.has(ext)) {
        throw new Error('image_scan: WebP is not supported yet — convert the file to PNG or JPEG first');
      }
      if (!core.IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`image_scan: unsupported image type "${ext}" (supported: PNG, JPEG, GIF, BMP)`);
      }

      const mode = parseMode(args.mode);
      const palette = core.resolvePaletteArgument(args.palette);
      if (args.region !== undefined && args.focus !== undefined) {
        throw new Error('image_scan: region and focus are mutually exclusive — pass only one');
      }
      let pxPerCell;
      if (args.px_per_cell !== undefined) {
        pxPerCell = Number(args.px_per_cell);
        if (!Number.isInteger(pxPerCell) || pxPerCell < 1 || pxPerCell > 512) {
          throw new Error('image_scan: px_per_cell must be an integer between 1 and 512');
        }
        if (args.size !== undefined) {
          throw new Error('image_scan: size and px_per_cell are mutually exclusive — pass only one');
        }
      }
      const size = pxPerCell !== undefined ? 32 : parseSize(args.size);

      const cwd = exec.agent?.session?.header?.cwd;
      const target = await ctx.fs.resolve(filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (!info) {
        throw new Error(`image_scan: cannot read "${target.displayPath}": file not found`);
      }
      if (info.type !== 'file') {
        throw new Error(`image_scan: cannot read "${target.displayPath}": not a regular file`);
      }
      const data = await ctx.fs.readBytes(target, exec.signal, BYTE_CAP);

      const image = core.decodeImage(data, ext);
      if (image.width * image.height > MAX_PIXELS) {
        throw new Error(
          `image_scan: ${image.width}x${image.height} exceeds the ${MAX_PIXELS}-pixel decode limit — downscale or crop the file first`
        );
      }

      // Resolve the scan window. focus uses grid coordinates against the
      // full-image grid this size produces, so it must be resolved after decode.
      let regionArray;
      let regionDisplay;
      if (args.focus !== undefined) {
        const fullGridHeight = Math.max(1, Math.round(size * (image.height / image.width)));
        regionArray = core.resolveFocus(args.focus, size, fullGridHeight);
        regionDisplay = `focus [${args.focus.map(String).join(',')}]`;
      } else if (args.region !== undefined) {
        regionArray = core.normalizeRegion(args.region);
        regionDisplay = regionArray.map((v) => Math.round(v * 1000) / 1000).join(',');
      } else {
        regionDisplay = 'full';
      }

      const analysis = core.analyzeImage(image.data, image.width, image.height, { size, mode, region: regionArray, palette, pxPerCell });
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
      return {
        path: target.displayPath,
        width: image.width,
        height: image.height,
        region: regionDisplay,
        ...analysis
      };
    }
  };
}

/**
 * Build the model-facing `image_ocr` tool over one plugin context.
 * Recognizes text in an image (optionally within a region/focus) using the
 * Windows built-in OCR engine — fully local, no install.
 * @param ctx - the Cordis context providing `ctx.fs`.
 */
export function createImageOcrTool(ctx) {
  return {
    name: 'image_ocr',
    description: [
      'Recognize text in a local image. Three engines: engine="windows" (default) uses the Windows built-in OCR (no install, good for printed/UI text); engine="paddle" uses PaddleOCR via the local paddle_venv (much better for glowing, curved, stylized or game-rendered text and complex backgrounds, Chinese-friendly; ~2s model load per call); engine="rapid" uses RapidOCR via the local rapid_venv (bundled ONNX models, no network download, fast).',
      'Use it together with image_scan: when the pixel grid shows a dense, regular, high-contrast structure that looks like text (e.g. titles, labels, buttons, dialogs, glowing banners), call image_ocr on that region and read the actual characters. If the Windows engine returns nothing but text is expected, retry with engine="paddle" or engine="rapid".',
      'Parameters: file_path (required), region: [x0, y0, x1, y1] (0..1 fractions) or focus: [row0, col0, row1, col1] (grid coordinates) to restrict recognition to an area, language (optional BCP-47 tag like "zh-Hans" or "en-US", Windows engine only), engine ("windows" default, "paddle", "rapid").',
      'The result lists each recognized line with its pixel bounding box and confidence score (paddle).'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the image file (PNG/JPEG/GIF/BMP), resolved by the filesystem backend.'
        },
        region: {
          type: 'array',
          description: 'Optional [x0, y0, x1, y1] fractions in 0..1 to restrict recognition to part of the image. Mutually exclusive with focus.',
          items: { type: 'number' }
        },
        focus: {
          type: 'array',
          description: 'Optional [row0, col0, row1, col1] grid coordinates (inclusive) to restrict recognition to part of the image. Mutually exclusive with region.',
          items: { type: 'integer' }
        },
        language: {
          type: 'string',
          description: 'Optional BCP-47 language tag (e.g. "zh-Hans", "en-US"); defaults to the user languages. Windows engine only.'
        },
        engine: {
          type: 'string',
          enum: ['windows', 'paddle', 'rapid'],
          description: '"windows" (default) = Windows built-in OCR; "paddle" = PaddleOCR via local paddle_venv (better for glowing/curved/game text); "rapid" = RapidOCR via local rapid_venv (bundled ONNX models, fast).'
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
          width: { type: 'integer' },
          height: { type: 'integer' },
          region: { type: 'string' },
          engine: { type: 'string', enum: ['windows', 'paddle', 'rapid'] },
          note: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                text: { type: 'string' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                score: { type: 'number' }
              },
              required: ['text', 'x', 'y', 'width', 'height']
            }
          }
        },
        required: ['path', 'width', 'height', 'region', 'lines']
      },
      render: (_args, value) => {
        const renderer = latestCore?.renderOcr;
        const text = renderer !== undefined && renderer !== null ? renderer(value) : `ocr result for ${value.path}: ${JSON.stringify(value)}`;
        return [{ type: 'text', text }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('image_ocr: cancelled');
      const filePath = String(args.file_path ?? '').trim();
      if (filePath.length === 0) throw new Error('image_ocr: file_path must be a non-empty string');

      const ext = extname(filePath).toLowerCase();
      const core = await importCore();
      latestCore = core;

      if (core.UNSUPPORTED_EXTENSIONS.has(ext)) {
        throw new Error('image_ocr: WebP is not supported yet — convert the file to PNG or JPEG first');
      }
      if (!core.IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`image_ocr: unsupported image type "${ext}" (supported: PNG, JPEG, GIF, BMP)`);
      }
      if (args.region !== undefined && args.focus !== undefined) {
        throw new Error('image_ocr: region and focus are mutually exclusive — pass only one');
      }
      if (args.language !== undefined && String(args.language).trim().length === 0) {
        throw new Error('image_ocr: language must be a non-empty BCP-47 tag');
      }
      const engine = args.engine === undefined ? 'windows' : String(args.engine);
      if (engine !== 'windows' && engine !== 'paddle' && engine !== 'rapid') {
        throw new Error("image_ocr: engine must be 'windows' (default) or 'paddle' or 'rapid'");
      }

      const cwd = exec.agent?.session?.header?.cwd;
      const target = await ctx.fs.resolve(filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (!info) {
        throw new Error(`image_ocr: cannot read "${target.displayPath}": file not found`);
      }
      if (info.type !== 'file') {
        throw new Error(`image_ocr: cannot read "${target.displayPath}": not a regular file`);
      }
      const data = await ctx.fs.readBytes(target, exec.signal, BYTE_CAP);

      const image = core.decodeImage(data, ext);
      if (image.width * image.height > MAX_PIXELS) {
        throw new Error(
          `image_ocr: ${image.width}x${image.height} exceeds the ${MAX_PIXELS}-pixel decode limit — downscale or crop the file first`
        );
      }

      let regionArray;
      let regionDisplay;
      if (args.focus !== undefined) {
        const fullGridHeight = Math.max(1, Math.round(32 * (image.height / image.width)));
        regionArray = core.resolveFocus(args.focus, 32, fullGridHeight);
        regionDisplay = `focus [${args.focus.map(String).join(',')}]`;
      } else if (args.region !== undefined) {
        regionArray = core.normalizeRegion(args.region);
        regionDisplay = regionArray.map((v) => Math.round(v * 1000) / 1000).join(',');
      } else {
        regionDisplay = 'full';
      }

      // PaddleOCR / RapidOCR are optional engines: degrade gracefully to the
      // Windows engine (with a note) when they are missing or fail — never crash.
      const OPTIONAL = {
        paddle: { available: () => core.paddleAvailable(), install: 'node scripts/setup-ocr.mjs' },
        rapid: { available: () => core.rapidAvailable(), install: 'node scripts/setup-rapid.mjs' }
      };
      let effectiveEngine = engine;
      let note;
      const opt = OPTIONAL[engine];
      if (opt !== undefined && !(await opt.available())) {
        effectiveEngine = 'windows';
        note = `${engine[0].toUpperCase()}${engine.slice(1)}OCR is not installed (engine="${engine}" requested) — fell back to Windows OCR. To install it, run: ${opt.install} (see README).`;
      }
      let result;
      try {
        result = await core.ocrImage(data, ext, {
          region: regionArray,
          language: args.language === undefined ? undefined : String(args.language).trim(),
          engine: effectiveEngine
        });
      } catch (error) {
        if (opt !== undefined && effectiveEngine === engine) {
          effectiveEngine = 'windows';
          note = `${engine[0].toUpperCase()}${engine.slice(1)}OCR failed (${error.message.slice(0, 140)}) — fell back to Windows OCR.`;
          result = await core.ocrImage(data, ext, {
            region: regionArray,
            language: args.language === undefined ? undefined : String(args.language).trim(),
            engine: 'windows'
          });
        } else {
          throw error;
        }
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
      return {
        path: target.displayPath,
        width: result.width,
        height: result.height,
        region: regionDisplay,
        engine: effectiveEngine,
        ...(note !== undefined ? { note } : {}),
        lines: result.lines
      };
    }
  };
}

/**
 * Build the model-facing `image_sample` tool over one plugin context.
 * Samples a small region as an NxN grid of exact pixels so the model can
 * judge local material (texture pattern, smoothness, color variation).
 * @param ctx - the Cordis context providing `ctx.fs`.
 */
export function createImageSampleTool(ctx) {
  return {
    name: 'image_sample',
    description: [
      'Sample a small region of a local image as an NxN grid of EXACT pixels (one real pixel per cell, not an average) plus a local-contrast statistic.',
      'Use it to judge MATERIAL or TEXTURE where a coarse grid is not enough: smooth color gradients (skin, sky, water), high-contrast stripes (metal, wood grain, brushed surfaces), periodic repeats (fabric, brick), high-frequency noise (foliage, gravel), sharp edges (screen content, UI).',
      'Workflow: first use image_scan to locate the area, then call image_sample with a SMALL region (e.g. [x0, y0, x1, y1] fractions covering roughly 30-400 px per side) and an optional size (2..16, default 8). The region must be at least `size` pixels in each direction.',
      'Interpret the returned RGB grid: row 0 is the top, left to right. High contrast with stripes suggests metal/wood/rough material; smooth low-contrast transitions suggest skin/sky/uniform surfaces; repetitive patterns suggest fabric/texture.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the image file (PNG/JPEG/GIF/BMP), resolved by the filesystem backend.'
        },
        region: {
          type: 'array',
          description: 'Required [x0, y0, x1, y1] fractions in 0..1: the small area to sample. Must cover at least `size` pixels in each direction.',
          items: { type: 'number' }
        },
        size: {
          type: 'integer',
          description: 'Sample grid side length (2..16, default 8); the output is size x size exact pixels.'
        }
      },
      required: ['file_path', 'region']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          region: { type: 'string' },
          contrast: { type: 'number' },
          distinct: { type: 'integer' },
          stepX: { type: 'number' },
          stepY: { type: 'number' },
          points: { type: 'array' }
        },
        required: ['path', 'width', 'height', 'region', 'contrast', 'distinct', 'points']
      },
      render: (_args, value) => {
        const renderer = latestCore?.renderSample;
        const text = renderer !== undefined && renderer !== null ? renderer(value) : `texture sample for ${value.path}: ${JSON.stringify(value)}`;
        return [{ type: 'text', text }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('image_sample: cancelled');
      const filePath = String(args.file_path ?? '').trim();
      if (filePath.length === 0) throw new Error('image_sample: file_path must be a non-empty string');
      if (args.region === undefined) throw new Error('image_sample: region is required ([x0, y0, x1, y1] fractions)');

      const ext = extname(filePath).toLowerCase();
      const core = await importCore();
      latestCore = core;

      if (core.UNSUPPORTED_EXTENSIONS.has(ext)) {
        throw new Error('image_sample: WebP is not supported yet — convert the file to PNG or JPEG first');
      }
      if (!core.IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`image_sample: unsupported image type "${ext}" (supported: PNG, JPEG, GIF, BMP)`);
      }
      const size = args.size === undefined ? 8 : Number(args.size);
      if (!Number.isInteger(size) || size < 2 || size > 16) {
        throw new Error('image_sample: size must be an integer between 2 and 16');
      }
      const regionArray = core.normalizeRegion(args.region);

      const cwd = exec.agent?.session?.header?.cwd;
      const target = await ctx.fs.resolve(filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (!info) {
        throw new Error(`image_sample: cannot read "${target.displayPath}": file not found`);
      }
      if (info.type !== 'file') {
        throw new Error(`image_sample: cannot read "${target.displayPath}": not a regular file`);
      }
      const data = await ctx.fs.readBytes(target, exec.signal, BYTE_CAP);
      const image = core.decodeImage(data, ext);
      if (image.width * image.height > MAX_PIXELS) {
        throw new Error(
          `image_sample: ${image.width}x${image.height} exceeds the ${MAX_PIXELS}-pixel decode limit — downscale or crop the file first`
        );
      }

      const sample = core.samplePixels(image.data, image.width, image.height, regionArray, size);
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
      return {
        path: target.displayPath,
        width: sample.width,
        height: sample.height,
        region: regionArray.map((v) => Math.round(v * 1000) / 1000).join(','),
        contrast: sample.contrast,
        distinct: sample.distinct,
        stepX: sample.stepX,
        stepY: sample.stepY,
        points: sample.points
      };
    }
  };
}
