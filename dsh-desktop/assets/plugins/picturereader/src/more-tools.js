/**
 * picturereader extra tools — a second set of local image tools that sit
 * alongside the frame-free scanners in tool.js:
 *
 *   image_crop     — crop an image to a 0..1 fraction region and write the
 *                    result to a PNG file (temp dir by default, or an
 *                    explicit out_path).
 *   image_palette  — extract the dominant colors of an image (or a region)
 *                    via 3-bit/channel quantization, plus a hue-family
 *                    breakdown so a text-only model can reason about tone.
 *   image_compare  — pixel-wise comparison of two images (optionally within
 *                    the same fraction region), reporting mean/ratio/max diff
 *                    and a normalized difference bounding box, with an
 *                    optional red-marked difference preview PNG.
 *
 * All business logic is self-contained in this module and reuses the shared
 * primitives exported by `core.js` (decodeImage, normalizeRegion, cropRgba,
 * encodePng, classify, hueFamilyFor, luminance). It imports `importCore` and
 * the BYTE_CAP / MAX_PIXELS guards from `tool.js` so decode limits are
 * identical to the existing tools.
 *
 * HOT RELOAD: like tool.js, the core module is fetched through `importCore`
 * so edits to `core.js` take effect on the next tool call. The tool
 * definitions here (schema/description) are fixed at boot.
 * @module picturereader/more-tools
 */

import { extname, resolve as pathResolve, join, dirname } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { importCore, BYTE_CAP, MAX_PIXELS } from './tool.js';

/** Amount of area that a norm channel's leading bits dedicate to one 3-bit bucket. */
const BUCKET_SHIFT = 5; // 256 >> 5 = 8 buckets per channel (3 bits/channel)

/** A pixel whose mean RGB channel delta exceeds this fraction counts as "differing". */
const DIFF_PIXEL_THRESHOLD = 0.1;

const toHex = (v) => v.toString(16).padStart(2, '0');
const hexOf = (r, g, b) => `#${toHex(r)}${toHex(g)}${toHex(b)}`;
const round3 = (v) => Math.round(v * 1000) / 1000;

/** Validate an integer in [min, max], throwing a tool-prefixed error. */
function parseBoundedInt(raw, fallback, min, max, label) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`image: ${label} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/** Validate a 0..1 threshold. */
function parseThreshold(raw, fallback, label) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`image: ${label} must be a number between 0 and 1`);
  }
  return n;
}

/** Resolve a write target against a cwd; empty input resolves to null. */
function resolveWritePath(outPath, cwd) {
  if (outPath === undefined || outPath === null) return null;
  const text = String(outPath).trim();
  if (text.length === 0) return null;
  return pathResolve(cwd ?? process.cwd(), text);
}

/** Ensure the parent directory of a path exists (recursive). */
async function ensureDirFor(p) {
  await mkdir(dirname(p), { recursive: true });
}

/** Build a default crop temp path under the OS temp dir. */
function defaultCropPath() {
  const dir = join(tmpdir(), 'picturereader');
  return { dir, file: join(dir, `crop-${Date.now()}-${randomBytes(4).toString('hex')}.png`) };
}

/**
 * Pixel bounds (integer [x0,y0,w,h]) of a fraction region on an image.
 * @param normalize - the core `normalizeRegion` function (validates + defaults).
 * @param imgWidth - source pixel width.
 * @param imgHeight - source pixel height.
 * @param region - `[x0, y0, x1, y1]` fractions (or undefined = full image).
 * @returns an integer box `{ x0, y0, w, h }`.
 */
function regionBounds(normalize, imgWidth, imgHeight, region) {
  const [rx0, ry0, rx1, ry1] = normalize(region);
  const px0 = Math.max(0, Math.floor(rx0 * imgWidth));
  const px1 = Math.min(imgWidth, Math.ceil(rx1 * imgWidth));
  const py0 = Math.max(0, Math.floor(ry0 * imgHeight));
  const py1 = Math.min(imgHeight, Math.ceil(ry1 * imgHeight));
  return { x0: px0, y0: py0, w: px1 - px0, h: py1 - py0 };
}

/**
 * Load the core module (cache-busted by tool.js) once per process and return
 * its namespace. The lookup is memoized so repeated tool calls reuse it.
 * @returns the core module namespace.
 */
let corePromise = null;
async function loadCore() {
  if (corePromise === null) corePromise = importCore();
  return corePromise;
}

/**
 * Decode an image file bytes into `{ data, width, height }` after validating
 * the extension and pixel-count guard, matching the existing tools' behavior.
 */
async function decodeChecked(core, ext, bytes, tool, filePath) {
  if (core.UNSUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`${tool}: WebP is not supported yet — convert the file to PNG or JPEG first`);
  }
  if (!core.IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`${tool}: unsupported image type "${ext}" (supported: PNG, JPEG, GIF, BMP)`);
  }
  const image = core.decodeImage(bytes, ext);
  if (image.width * image.height > MAX_PIXELS) {
    throw new Error(
      `${tool}: ${image.width}x${image.height} exceeds the ${MAX_PIXELS}-pixel decode limit for "${filePath}" — downscale or crop the file first`
    );
  }
  return image;
}

// ---------------------------------------------------------------------------
// image_crop
// ---------------------------------------------------------------------------

/**
 * Build the `image_crop` tool: crop an image to a 0..1 fraction region and
 * write the result as a lossless PNG, either to an explicit out_path or a
 * unique file in the OS temp dir. The returned path is ready to feed back to
 * image_scan / image_ocr for continued analysis.
 * @param ctx - the Cordis context providing `ctx.fs`.
 */
export function createImageCropTool(ctx) {
  return {
    name: 'image_crop',
    description: [
      'Crop a local image to a rectangular fraction region and write the result as a lossless PNG file.',
      'Parameters: file_path (required, PNG/JPEG/GIF/BMP), region (required, [x0, y0, x1, y1] fractions in 0..1, with x1 > x0 and y1 > y0) selects the rectangle to keep, and out_path (optional — where to write the PNG; when empty a unique file is created under the system temp directory picturereader/).',
      'The valid region comes from a prior image_scan: pass the same region fractions that located the subject you now want isolated at full resolution.',
      'Returns the written output path plus the cropped pixel dimensions. Use image_scan / image_ocr on the returned path to continue analyzing the cropped result, or image_sample for fine texture detail.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source image file (PNG/JPEG/GIF/BMP), resolved by the filesystem backend.'
        },
        region: {
          type: 'array',
          description: 'Required [x0, y0, x1, y1] fractions in 0..1 to crop to. Must obey x1 > x0 and y1 > y0.',
          items: { type: 'number' }
        },
        out_path: {
          type: 'string',
          description: 'Optional output path for the cropped PNG. When empty, a unique file is written under the system temp directory (picturereader/).'
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
          generated: { type: 'boolean' },
          tempDir: { type: 'string' },
          outPath: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['path', 'width', 'height', 'generated', 'outPath']
      },
      render: (_args, value) => {
        const lines = [`crop: ${value.path} (${value.width}x${value.height}) -> ${value.outPath}`];
        if (value.generated) lines.push(`written to generated temp file under ${value.tempDir}`);
        if (value.note !== undefined) lines.push(value.note);
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('image_crop: cancelled');
      const tool = 'image_crop';
      const filePath = String(args.file_path ?? '').trim();
      if (filePath.length === 0) throw new Error('image_crop: file_path must be a non-empty string');
      if (args.region === undefined) {
        throw new Error('image_crop: region is required ([x0, y0, x1, y1] fractions)');
      }

      const ext = extname(filePath).toLowerCase();
      const core = await loadCore();
      const cwd = exec.agent?.session?.header?.cwd;
      const target = await ctx.fs.resolve(filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (!info) throw new Error(`image_crop: cannot read "${target.displayPath}": file not found`);
      if (info.type !== 'file') throw new Error(`image_crop: cannot read "${target.displayPath}": not a regular file`);
      const bytes = await ctx.fs.readBytes(target, exec.signal, BYTE_CAP);

      const image = await decodeChecked(core, ext, bytes, tool, target.displayPath);
      const region = core.normalizeRegion(args.region); // throws clear error on invalid
      const cropped = core.cropRgba(image.data, image.width, image.height, region);
      const pngBytes = core.encodePng(cropped.data, cropped.width, cropped.height);

      let outPath;
      let generated = false;
      let tempDir;
      const explicitOut = resolveWritePath(args.out_path, cwd);
      if (explicitOut !== null) {
        outPath = explicitOut;
        await ensureDirFor(outPath);
      } else {
        const def = defaultCropPath();
        tempDir = def.dir;
        outPath = def.file;
        generated = true;
        await mkdir(tempDir, { recursive: true });
      }
      await writeFile(outPath, pngBytes);

      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
      const result = {
        path: target.displayPath,
        width: cropped.width,
        height: cropped.height,
        generated,
        outPath,
        ...(tempDir !== undefined ? { tempDir } : {}),
        note: '可用 image_scan / image_ocr 对裁剪结果做进一步分析'
      };
      return result;
    }
  };
}

// ---------------------------------------------------------------------------
// image_palette
// ---------------------------------------------------------------------------

/**
 * Build the `image_palette` tool: extract the dominant colors (3-bit/channel
 * quantization) and hue-family tone of an image or a region, so a text-only
 * model can reason about color composition without a vision model.
 * @param ctx - the Cordis context providing `ctx.fs`.
 */
export function createImagePaletteTool(ctx) {
  return {
    name: 'image_palette',
    description: [
      'Extract the dominant colors of a local image (or a region of it) using 3-bit/channel quantization, plus a hue-family breakdown for an overall tone read.',
      'Parameters: file_path (required, PNG/JPEG/GIF/BMP), region (optional [x0, y0, x1, y1] fractions — restrict to a sub-area), top (number of dominant colors to return, 1..32, default 12), sample_step (optional sampling stride in pixels, default 1).',
      'Each dominant color gives its hex (#rrggbb, the bucket mean color), a classified palette name (black/white/gray/red/green/blue/yellow/cyan/orange/pink/purple/brown/...), its percent share of sampled pixels, and its RGB tuple.',
      'hue_families groups colors by hue family (red/orange/yellow/green/cyan/blue/purple/pink/achromatic) regardless of darkness, which is the most robust signal for overall image tone — a photo whose many colors all classify as gray still reports its true hue mix here.',
      'distinct reports how many distinct quantization buckets were found (coarse color diversity). Use it together with image_scan to understand palette vs layout.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source image file (PNG/JPEG/GIF/BMP), resolved by the filesystem backend.'
        },
        region: {
          type: 'array',
          description: 'Optional [x0, y0, x1, y1] fractions in 0..1 to restrict the analysis to part of the image.',
          items: { type: 'number' }
        },
        top: {
          type: 'integer',
          description: 'Number of dominant colors to return (1..32, default 12).'
        },
        sample_step: {
          type: 'integer',
          description: 'Optional sampling stride in pixels (default 1 = every pixel). Use a larger stride on huge images to bound cost.'
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
          top: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                hex: { type: 'string' },
                name: { type: 'string' },
                pct: { type: 'number' },
                rgb: {
                  type: 'object',
                  properties: { r: { type: 'integer' }, g: { type: 'integer' }, b: { type: 'integer' } }
                }
              },
              required: ['hex', 'name', 'pct', 'rgb']
            }
          },
          hue_families: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: { family: { type: 'string' }, pct: { type: 'number' } },
              required: ['family', 'pct']
            }
          },
          distinct: { type: 'integer' }
        },
        required: ['path', 'width', 'height', 'top', 'hue_families', 'distinct']
      },
      render: (_args, value) => {
        const lines = [`palette: ${value.path} (${value.width}x${value.height}, region=${value.region})`];
        if (value.top.length > 0) {
          lines.push(`dominant colors: ${value.top.map((c) => `${c.name} ${c.pct}% (${c.hex} rgb(${c.rgb.r},${c.rgb.g},${c.rgb.b}))`).join(', ')}`);
        } else {
          lines.push('dominant colors: (none found)');
        }
        if (value.hue_families.length > 0) {
          const colored = value.hue_families.filter((h) => h.family !== 'achromatic');
          const achromatic = value.hue_families.find((h) => h.family === 'achromatic');
          lines.push(`hue families: ${colored.map((h) => `${h.family} ${h.pct}%`).join(', ')}${achromatic ? `, achromatic ${achromatic.pct}%` : ''}`);
        }
        lines.push(`distinct quantization buckets: ${value.distinct}`);
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('image_palette: cancelled');
      const tool = 'image_palette';
      const filePath = String(args.file_path ?? '').trim();
      if (filePath.length === 0) throw new Error('image_palette: file_path must be a non-empty string');

      const top = parseBoundedInt(args.top, 12, 1, 32, 'top');
      const sampleStep = parseBoundedInt(args.sample_step, 1, 1, 100_000, 'sample_step');
      const ext = extname(filePath).toLowerCase();
      const core = await loadCore();
      const cwd = exec.agent?.session?.header?.cwd;
      const target = await ctx.fs.resolve(filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (!info) throw new Error(`image_palette: cannot read "${target.displayPath}": file not found`);
      if (info.type !== 'file') throw new Error(`image_palette: cannot read "${target.displayPath}": not a regular file`);
      const bytes = await ctx.fs.readBytes(target, exec.signal, BYTE_CAP);

      const image = await decodeChecked(core, ext, bytes, tool, target.displayPath);
      const region = args.region === undefined ? [0, 0, 1, 1] : core.normalizeRegion(args.region);

      const topList = [];
      const hueCounts = new Map();
      const buckets = new Map();
      const box = regionBounds(core.normalizeRegion, image.width, image.height, region);
      let total = 0;
      for (let y = box.y0; y < box.y0 + box.h; y += sampleStep) {
        for (let x = box.x0; x < box.x0 + box.w; x += sampleStep) {
          const p = (y * image.width + x) * 4;
          if (image.data[p + 3] < 128) continue;
          const r = image.data[p];
          const g = image.data[p + 1];
          const b = image.data[p + 2];
          const key = (r >> BUCKET_SHIFT) << 6 | (g >> BUCKET_SHIFT) << 3 | (b >> BUCKET_SHIFT);
          let bucket = buckets.get(key);
          if (bucket === undefined) {
            bucket = { r: 0, g: 0, b: 0, count: 0 };
            buckets.set(key, bucket);
          }
          bucket.r += r;
          bucket.g += g;
          bucket.b += b;
          bucket.count += 1;
          const fam = core.hueFamilyFor(r, g, b);
          hueCounts.set(fam, (hueCounts.get(fam) ?? 0) + 1);
          total += 1;
        }
      }
      if (total > 0) {
        for (const bucket of buckets.values()) {
          const ar = Math.round(bucket.r / bucket.count);
          const ag = Math.round(bucket.g / bucket.count);
          const ab = Math.round(bucket.b / bucket.count);
          topList.push({
            hex: hexOf(ar, ag, ab),
            name: core.classify(ar, ag, ab, 'full').name,
            pct: Math.round((bucket.count / total) * 1000) / 10,
            rgb: { r: ar, g: ag, b: ab },
            count: bucket.count
          });
        }
        topList.sort((a, b) => b.count - a.count);
        for (const item of topList) delete item.count;
      }
      const hueFamilies = [...hueCounts.entries()]
        .map(([family, count]) => ({ family, pct: Math.round((count / total) * 1000) / 10 }))
        .sort((a, b) => b.pct - a.pct);

      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
      return {
        path: target.displayPath,
        width: image.width,
        height: image.height,
        region: region.map((v) => Math.round(v * 1000) / 1000).join(','),
        top: topList.slice(0, top),
        hue_families: hueFamilies,
        distinct: buckets.size
      };
    }
  };
}

// ---------------------------------------------------------------------------
// image_compare
// ---------------------------------------------------------------------------

/**
 * Compare two RGBA images at a common sample grid. Both images use the same
 * normalized region; when regions have different pixel sizes (different image
 * dimensions) the grid is aligned on the minimum size, so only the overlapping
 * portion is compared.
 * @returns `{ meanDiff, diffRatio, maxDiff, diffBox, commonWidth, commonHeight, diffPixels, samples, cells }`.
 */
function compareRgba(dataA, imgWA, imgHA, dataB, imgWB, imgHB, normalize, region, downsample) {
  const boxA = regionBounds(normalize, imgWA, imgHA, region);
  const boxB = regionBounds(normalize, imgWB, imgHB, region);
  const gw = Math.min(boxA.w, boxB.w);
  const gh = Math.min(boxA.h, boxB.h);
  if (gw <= 0 || gh <= 0) throw new Error('image_compare: the comparison region has zero area');

  let samples = 0;
  let diffPixels = 0;
  let meanSum = 0;
  let maxDiff = 0;
  let dMinX = Infinity;
  let dMinY = Infinity;
  let dMaxX = -1;
  let dMaxY = -1;
  const cols = Math.max(1, Math.ceil(gw / downsample));
  const rows = Math.max(1, Math.ceil(gh / downsample));
  const cells = new Array(rows * cols);

  for (let gy = 0; gy < gh; gy += downsample) {
    const row = Math.floor(gy / downsample);
    for (let gx = 0; gx < gw; gx += downsample) {
      const col = Math.floor(gx / downsample);
      const ux = gw === 1 ? 0.5 : (gx + 0.5) / gw;
      const uy = gh === 1 ? 0.5 : (gy + 0.5) / gh;
      const ax = boxA.x0 + Math.floor(ux * boxA.w);
      const ay = boxA.y0 + Math.floor(uy * boxA.h);
      const bx = boxB.x0 + Math.floor(ux * boxB.w);
      const by = boxB.y0 + Math.floor(uy * boxB.h);
      const pa = (ay * imgWA + ax) * 4;
      const pb = (by * imgWB + bx) * 4;
      const dr = Math.abs(dataA[pa] - dataB[pb]) / 255;
      const dg = Math.abs(dataA[pa + 1] - dataB[pb + 1]) / 255;
      const db = Math.abs(dataA[pa + 2] - dataB[pb + 2]) / 255;
      const diff = (dr + dg + db) / 3;
      meanSum += diff;
      samples += 1;
      if (diff > maxDiff) maxDiff = diff;
      const differing = diff > DIFF_PIXEL_THRESHOLD;
      if (differing) {
        diffPixels += 1;
        if (ux < dMinX) dMinX = ux;
        if (uy < dMinY) dMinY = uy;
        if (ux > dMaxX) dMaxX = ux;
        if (uy > dMaxY) dMaxY = uy;
      }
      // base preview cell = image A color, differencing cells are red
      const cellIdx = row * cols + col;
      cells[cellIdx] = differing ? [255, 0, 0] : [dataA[pa], dataA[pa + 1], dataA[pa + 2]];
    }
  }
  const meanDiff = samples === 0 ? 0 : meanSum / samples;
  const diffRatio = samples === 0 ? 0 : diffPixels / samples;
  const diffBox = dMinX === Infinity
    ? null
    : [round3(Math.min(dMinX, dMaxX)), round3(Math.min(dMinY, dMaxY)), round3(Math.max(dMinX, dMaxX)), round3(Math.max(dMinY, dMaxY))];
  return { meanDiff, diffRatio, maxDiff, diffBox, commonWidth: gw, commonHeight: gh, diffPixels, samples, cells, cols, rows };
}

/**
 * Build the `image_compare` tool: pixel-wise comparison of two images (or the
 * same fraction region of both). Reports the mean/ratio/max diff, a normalized
 * difference bounding box, and a verdict, and optionally writes a red-marked
 * difference preview PNG.
 * @param ctx - the Cordis context providing `ctx.fs`.
 */
export function createImageCompareTool(ctx) {
  return {
    name: 'image_compare',
    description: [
      'Compare two local images pixel-by-pixel, optionally within the same 0..1 fraction region of both, and report how different they are.',
      'Parameters: file_path_a / file_path_b (required, PNG/JPEG/GIF/BMP), region (optional [x0,y0,x1,y1] fractions applied to both images — when omitted the full images are compared, aligned to the smaller size if dimensions differ), max_diff_threshold (optional 0..1, default 0.05; the pixel-difference share above which the verdict flips to "different"), downsample (optional 1..32 sampling stride, default 4 — controls how many pixels are sampled to bound cost), preview_path (optional — write a PNG that marks differing pixels red on top of image A).',
      'Returns mean_diff (average per-pixel RGB channel delta 0..1), diff_ratio (fraction of sampled pixels differing by more than 0.1), max_diff (the single largest pixel difference), size_diff (pixel dimension delta, or null when identical), and diff_box (the normalized [x0,y0,x1,y1] bounding box of differing pixels within the compared region, or null when identical).',
      'verdict is "size-diff" when the images have different dimensions, otherwise "different" when diff_ratio or mean_diff exceeds max_diff_threshold, otherwise "same". Use it to verify whether a re-export, a crop with text overlay, or a reprocessed image is effectively unchanged.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path_a: {
          type: 'string',
          description: 'Path to the first image file, resolved by the filesystem backend.'
        },
        file_path_b: {
          type: 'string',
          description: 'Path to the second image file, resolved by the filesystem backend.'
        },
        region: {
          type: 'array',
          description: 'Optional [x0, y0, x1, y1] fractions in 0..1 applied to both images.',
          items: { type: 'number' }
        },
        max_diff_threshold: {
          type: 'number',
          description: 'Optional 0..1 threshold (default 0.05) controlling the "same" vs "different" verdict.'
        },
        downsample: {
          type: 'integer',
          description: 'Optional sampling stride in pixels (1..32, default 4) controlling comparison cost.'
        },
        preview_path: {
          type: 'string',
          description: 'Optional output path for a difference preview PNG (differing pixels marked red on image A). When omitted no preview is written.'
        }
      },
      required: ['file_path_a', 'file_path_b']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path_a: { type: 'string' },
          path_b: { type: 'string' },
          width_a: { type: 'integer' },
          height_a: { type: 'integer' },
          width_b: { type: 'integer' },
          height_b: { type: 'integer' },
          size_diff: {
            type: 'object',
            properties: { w: { type: 'integer' }, h: { type: 'integer' } },
          },
          mean_diff: { type: 'number' },
          diff_ratio: { type: 'number' },
          max_diff: { type: 'number' },
          region_a: { type: 'string' },
          region_b: { type: 'string' },
          diff_box: {
            type: 'array',
            items: { type: 'number' },
          },
          verdict: { type: 'string', enum: ['same', 'different', 'size-diff'] },
          preview_path: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['path_a', 'path_b', 'width_a', 'height_a', 'width_b', 'height_b', 'region_a', 'region_b', 'verdict']
      },
      render: (_args, value) => {
        const lines = [
          `compare: ${value.path_a} (${value.width_a}x${value.height_a}) vs ${value.path_b} (${value.width_b}x${value.height_b})`
        ];
        lines.push(`verdict: ${value.verdict} | mean_diff=${round3(value.mean_diff)} diff_ratio=${round3(value.diff_ratio)} max_diff=${round3(value.max_diff)}`);
        if (value.size_diff) lines.push(`size_diff: w ${value.size_diff.w}, h ${value.size_diff.h}`);
        if (value.diff_box) lines.push(`difference region: ${value.diff_box.join(',')} (normalized within compared region)`);
        else lines.push('no differing pixels found (diff_box: null)');
        if (value.preview_path) lines.push(`preview: ${value.preview_path}`);
        if (value.note) lines.push(`note: ${value.note}`);
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('image_compare: cancelled');
      const tool = 'image_compare';
      const filePathA = String(args.file_path_a ?? '').trim();
      const filePathB = String(args.file_path_b ?? '').trim();
      if (filePathA.length === 0) throw new Error('image_compare: file_path_a must be a non-empty string');
      if (filePathB.length === 0) throw new Error('image_compare: file_path_b must be a non-empty string');

      const maxDiffThreshold = parseThreshold(args.max_diff_threshold, 0.05, 'max_diff_threshold');
      const downsample = parseBoundedInt(args.downsample, 4, 1, 32, 'downsample');
      const extA = extname(filePathA).toLowerCase();
      const extB = extname(filePathB).toLowerCase();
      const core = await loadCore();
      const cwd = exec.agent?.session?.header?.cwd;

      const targetA = await ctx.fs.resolve(filePathA, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
      const targetB = await ctx.fs.resolve(filePathB, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
      const infoA = await ctx.fs.stat(targetA, exec.signal);
      const infoB = await ctx.fs.stat(targetB, exec.signal);
      if (!infoA) throw new Error(`image_compare: cannot read "${targetA.displayPath}": file not found`);
      if (!infoB) throw new Error(`image_compare: cannot read "${targetB.displayPath}": file not found`);
      if (infoA.type !== 'file') throw new Error(`image_compare: cannot read "${targetA.displayPath}": not a regular file`);
      if (infoB.type !== 'file') throw new Error(`image_compare: cannot read "${targetB.displayPath}": not a regular file`);
      const bytesA = await ctx.fs.readBytes(targetA, exec.signal, BYTE_CAP);
      const bytesB = await ctx.fs.readBytes(targetB, exec.signal, BYTE_CAP);

      const imageA = await decodeChecked(core, extA, bytesA, tool, targetA.displayPath);
      const imageB = await decodeChecked(core, extB, bytesB, tool, targetB.displayPath);

      const sameSize = imageA.width === imageB.width && imageA.height === imageB.height;
      const sizeDiff = sameSize ? null : { w: Math.abs(imageA.width - imageB.width), h: Math.abs(imageA.height - imageB.height) };

      const region = args.region === undefined ? [0, 0, 1, 1] : core.normalizeRegion(args.region);
      const regionDisplay = region.map((v) => Math.round(v * 1000) / 1000).join(',');
      let note;
      if (!sameSize && args.region === undefined) {
        note = 'images differ in size and no region was given — compared aligned whole images at the smaller dimensions';
      }

      const cmp = compareRgba(imageA.data, imageA.width, imageA.height, imageB.data, imageB.width, imageB.height, core.normalizeRegion, region, downsample);

      let verdict;
      if (sizeDiff !== null) {
        verdict = 'size-diff';
      } else if (cmp.diffRatio > maxDiffThreshold || cmp.meanDiff > maxDiffThreshold) {
        verdict = 'different';
      } else {
        verdict = 'same';
      }

      let preview;
      const explicitPrev = resolveWritePath(args.preview_path, cwd);
      if (explicitPrev !== null) {
        const rgba = Buffer.alloc(cmp.rows * cmp.cols * 4);
        for (let i = 0; i < cmp.cells.length; i += 1) {
          const [pr, pg, pb] = cmp.cells[i] ?? [0, 0, 0];
          rgba[i * 4] = pr;
          rgba[i * 4 + 1] = pg;
          rgba[i * 4 + 2] = pb;
          rgba[i * 4 + 3] = 255;
        }
        const pngBytes = core.encodePng(rgba, cmp.cols, cmp.rows);
        await ensureDirFor(explicitPrev);
        await writeFile(explicitPrev, pngBytes);
        preview = explicitPrev;
      }

      ctx.emit('fs/observed', targetA, { kind: 'present', version: infoA.version }, exec);
      ctx.emit('fs/observed', targetB, { kind: 'present', version: infoB.version }, exec);
      return {
        path_a: targetA.displayPath,
        path_b: targetB.displayPath,
        width_a: imageA.width,
        height_a: imageA.height,
        width_b: imageB.width,
        height_b: imageB.height,
        ...(sizeDiff !== null && sizeDiff !== undefined ? { size_diff: sizeDiff } : {}),
        mean_diff: round3(cmp.meanDiff),
        diff_ratio: round3(cmp.diffRatio),
        max_diff: round3(cmp.maxDiff),
        region_a: regionDisplay,
        region_b: regionDisplay,
        ...(cmp.diffBox !== null && cmp.diffBox !== undefined ? { diff_box: cmp.diffBox } : {}),
        verdict,
        ...(preview !== undefined ? { preview_path: preview } : {}),
        ...(note !== undefined ? { note } : {})
      };
    }
  };
}

export const tools = [
  createImageCropTool,
  createImagePaletteTool,
  createImageCompareTool
];

// Register factories bound to a ctx when the host mounts this module.
export function registerMoreTools(ctx) {
  tools.forEach((factory) => ctx.tools.register(factory(ctx)));
}
