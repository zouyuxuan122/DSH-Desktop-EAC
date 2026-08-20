/**
 * picturereader core — the entire business logic in ONE self-contained module.
 *
 * The plugin loads this module dynamically with a cache-busting query on every
 * tool execution (see `importCore` in tool.js), so edits to this file take
 * effect on the next `image_scan` call WITHOUT a process restart. That only
 * works because this module has no relative imports of its own source files:
 * the only static dependencies are stable npm packages (pngjs / jpeg-js /
 * omggif), which Node keeps cached.
 *
 * Everything is pure JS, no native dependencies:
 * - decoding: PNG (pngjs), JPEG (jpeg-js), GIF first frame (omggif), BMP (built-in)
 * - palette: configurable depth (full 14 / basic 8 / gray 3) with an
 *   achromatic gate so dark grays never misclassify as brown
 * - pipeline: region crop, aspect-fit downscale, per-cell average + saturated
 *   "accent" color (keeps thin colored lines visible), luminance/color grids
 * - OCR: Windows.Media.Ocr via a spawned PowerShell (built into Windows 10+,
 *   local, no install; Chinese needs the language pack)
 * @module picturereader/core
 */

import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import { GifReader } from 'omggif';
import { spawn } from 'node:child_process';
import { writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------

export const PALETTE = [
  { name: 'black', hex: '#101010', code: 'K' },
  { name: 'white', hex: '#f5f5f5', code: 'W' },
  { name: 'gray', hex: '#8a8a8a', code: 'G' },
  { name: 'red', hex: '#d81b1b', code: 'R' },
  { name: 'darkred', hex: '#8f1d1d', code: 'E' },
  { name: 'orange', hex: '#f07a1b', code: 'O' },
  { name: 'yellow', hex: '#f2d024', code: 'Y' },
  { name: 'green', hex: '#2e9e44', code: 'N' },
  { name: 'cyan', hex: '#1bb8c4', code: 'C' },
  { name: 'blue', hex: '#1b5fd8', code: 'B' },
  { name: 'darkblue', hex: '#1d2f6e', code: 'V' },
  { name: 'purple', hex: '#7b2fc0', code: 'P' },
  { name: 'pink', hex: '#e060a8', code: 'I' },
  { name: 'brown', hex: '#7a4a21', code: 'T' }
];

/** Valid palette keys; `auto` resolves at analysis time. */
export const PALETTE_KEYS = ['auto', 'full', 'basic', 'gray'];

const BASIC_NAMES = ['black', 'white', 'gray', 'red', 'green', 'blue', 'yellow', 'cyan'];
const GRAY_NAMES = ['black', 'gray', 'white'];

/** Palette lookup by depth key. */
export const PALETTES = {
  full: PALETTE,
  basic: BASIC_NAMES.map((name) => PALETTE.find((entry) => entry.name === name)),
  gray: GRAY_NAMES.map((name) => PALETTE.find((entry) => entry.name === name))
};

/** Names treated as achromatic in every palette. */
export const GRAY_FAMILY = new Set(['black', 'white', 'gray']);

/** Saturation (max-min) below which a color is treated as achromatic and classified by luminance only. */
export const ACHROMATIC_SATURATION = 40;

/** Luminance stops for achromatic classification (names exist in every palette). */
const ACHROMATIC_STOPS = [
  { upTo: 64, name: 'black' },
  { upTo: 192, name: 'gray' },
  { name: 'white' }
];

const RGB_CACHE = new Map();

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

function rgbFor(paletteKey) {
  let rgb = RGB_CACHE.get(paletteKey);
  if (rgb === undefined) {
    rgb = PALETTES[paletteKey].map((entry) => hexToRgb(entry.hex));
    RGB_CACHE.set(paletteKey, rgb);
  }
  return rgb;
}

/**
 * Map an RGB triple to the nearest named palette entry.
 *
 * Near-achromatic colors (low saturation) are classified by luminance into
 * black / gray / white first: pure Euclidean distance would misclassify dark
 * grays as brown or dark blue because the gray stop sits mid-brightness. In
 * the `gray` palette every color is classified by luminance only.
 * @param r - red channel 0..255.
 * @param g - green channel 0..255.
 * @param b - blue channel 0..255.
 * @param paletteKey - `'full'` (default), `'basic'` or `'gray'`.
 * @returns the nearest entry's index, name, and whether it is achromatic.
 */
export function classify(r, g, b, paletteKey = 'full') {
  const palette = PALETTES[paletteKey];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (paletteKey === 'gray' || max - min < ACHROMATIC_SATURATION) {
    const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    for (const stop of ACHROMATIC_STOPS) {
      if (stop.upTo === undefined || luma < stop.upTo) {
        const index = palette.findIndex((entry) => entry.name === stop.name);
        return {
          index,
          name: stop.name,
          gray: true
        };
      }
    }
  }
  const rgb = rgbFor(paletteKey);
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < rgb.length; i += 1) {
    const [pr, pg, pb] = rgb[i];
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return {
    index: best,
    name: palette[best].name,
    gray: GRAY_FAMILY.has(palette[best].name)
  };
}

/**
 * Validate a raw palette argument.
 * @param raw - the model-supplied value.
 * @returns the validated key ('auto' allowed).
 */
export function resolvePaletteArgument(raw) {
  const key = String(raw ?? 'auto');
  if (!PALETTE_KEYS.includes(key)) {
    throw new Error("image_scan: palette must be one of 'auto', 'full', 'basic', 'gray'");
  }
  return key;
}

/** Build the one-line legend for a palette, e.g. "K=black, W=white, ...". */
export function colorLegendFor(paletteKey) {
  return PALETTES[paletteKey].map((entry) => `${entry.code}=${entry.name}`).join(', ');
}

// ---------------------------------------------------------------------------
// bmp decoding
// ---------------------------------------------------------------------------

/**
 * Decode a BMP buffer into RGBA. BI_RGB / BI_BITFIELDS, 8/24/32 bpp,
 * BITMAPINFOHEADER (40), V4 (108), V5 (124) and OS/2 BITMAPCOREHEADER (12).
 * 16 bpp and RLE-compressed variants are rejected with a clear message.
 * @param buffer - the raw file bytes.
 * @returns `{ width, height, data }` with data as a `Buffer` of RGBA rows
 *   top-to-bottom, left-to-right.
 */
export function decodeBmp(buffer) {
  if (buffer.length < 26) throw new Error('not a valid BMP: file too small');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint16(0, true) !== 0x4d42) throw new Error('not a valid BMP: bad magic bytes');
  const dataOffset = view.getUint32(10, true);
  const dibSize = view.getUint32(14, true);
  try {
    if (dibSize === 12) {
      const width = view.getUint16(18, true);
      const height = view.getUint16(20, true);
      const bpp = view.getUint16(24, true);
      return renderBmpRows(view, buffer, {
        width,
        height: -height, // OS/2 core is bottom-up
        bpp,
        compression: 0,
        dataOffset,
        paletteOffset: 26,
        paletteEntrySize: 3
      });
    }
    if (dibSize !== 40 && dibSize !== 108 && dibSize !== 124) {
      throw new Error(`unsupported BMP DIB header (${dibSize} bytes)`);
    }
    const width = view.getInt32(18, true);
    const height = view.getInt32(22, true);
    const bpp = view.getUint16(28, true);
    const compression = view.getUint32(30, true);
    if (width <= 0 || height === 0) throw new Error('invalid BMP dimensions');
    if (bpp === 16) throw new Error('16-bit BMP is not supported');
    if (compression === 1 || compression === 2) throw new Error('RLE-compressed BMP is not supported');
    if (compression !== 0 && compression !== 3) throw new Error(`unsupported BMP compression (${compression})`);
    return renderBmpRows(view, buffer, {
      width,
      height,
      bpp,
      compression,
      dataOffset,
      paletteOffset: 14 + dibSize,
      paletteEntrySize: 4
    });
  } catch (error) {
    if (error instanceof RangeError) throw new Error('not a valid BMP: truncated pixel data');
    throw error;
  }
}

function renderBmpRows(view, buffer, { width, height, bpp, compression, dataOffset, paletteOffset, paletteEntrySize }) {
  const topDown = height < 0;
  const h = Math.abs(height);
  const w = width;
  let palette = null;
  if (bpp <= 8) {
    const count = bpp === 8 ? 256 : 1 << bpp;
    palette = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const off = paletteOffset + i * paletteEntrySize;
      palette[i] = { r: view.getUint8(off + 2), g: view.getUint8(off + 1), b: view.getUint8(off) };
    }
  }
  let masks = null;
  if (compression === 3) {
    masks = {
      r: view.getUint32(paletteOffset, true),
      g: view.getUint32(paletteOffset + 4, true),
      b: view.getUint32(paletteOffset + 8, true)
    };
  }
  const rowBytes = Math.ceil((w * bpp) / 32) * 4;
  if (dataOffset + h * rowBytes > buffer.length) throw new Error('not a valid BMP: truncated pixel data');
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const srcRow = topDown ? y : h - 1 - y;
    const rowStart = dataOffset + srcRow * rowBytes;
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let r;
      let g;
      let b;
      if (bpp === 24) {
        const p = rowStart + x * 3;
        b = view.getUint8(p);
        g = view.getUint8(p + 1);
        r = view.getUint8(p + 2);
      } else if (bpp === 32) {
        const p = rowStart + x * 4;
        if (masks) {
          const pixel = view.getUint32(p, true);
          r = maskChannel(pixel, masks.r);
          g = maskChannel(pixel, masks.g);
          b = maskChannel(pixel, masks.b);
        } else {
          b = view.getUint8(p);
          g = view.getUint8(p + 1);
          r = view.getUint8(p + 2);
        }
      } else if (bpp === 8) {
        const color = palette[view.getUint8(rowStart + x)] ?? { r: 0, g: 0, b: 0 };
        r = color.r;
        g = color.g;
        b = color.b;
      } else {
        throw new Error(`unsupported BMP bit depth (${bpp})`);
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function maskChannel(pixel, mask) {
  if (mask === 0) return 0;
  const shift = ctz(mask);
  const max = mask >>> shift;
  const value = (pixel & mask) >>> shift;
  return max === 255 ? value : Math.round((value * 255) / max);
}

function ctz(value) {
  let n = 0;
  let v = value >>> 0;
  while ((v & 1) === 0 && n < 32) {
    v >>>= 1;
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// image decoding
// ---------------------------------------------------------------------------

/** Extensions this plugin can decode, keyed by lowercase extension. */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp']);
/** Recognized-but-unsupported extensions (friendly error rather than silent fail). */
export const UNSUPPORTED_EXTENSIONS = new Set(['.webp']);

/**
 * Decode an image buffer into RGBA pixels.
 * @param buffer - raw file bytes.
 * @param ext - lowercase file extension including the dot (e.g. ".png").
 * @returns `{ width, height, data }` where data is a `Buffer` of RGBA rows,
 *   top-to-bottom, left-to-right.
 */
export function decodeImage(buffer, ext) {
  switch (ext) {
    case '.png': return decodePng(buffer);
    case '.jpg':
    case '.jpeg': return decodeJpeg(buffer);
    case '.gif': return decodeGif(buffer);
    case '.bmp': return decodeBmp(buffer);
    default: throw new Error(`image_scan: unsupported image type "${ext}"`);
  }
}

function decodePng(buffer) {
  let png;
  try {
    png = PNG.sync.read(buffer);
  } catch (error) {
    throw new Error(`image_scan: not a valid PNG (${error.message})`, { cause: error });
  }
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}

function decodeJpeg(buffer) {
  let raw;
  try {
    raw = jpeg.decode(buffer, { formatAsRGBA: true, useTArray: true, maxMemoryUsageInMB: 1024 });
  } catch (error) {
    throw new Error(`image_scan: not a valid JPEG (${error.message})`, { cause: error });
  }
  return {
    width: raw.width,
    height: raw.height,
    data: Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength)
  };
}

function decodeGif(buffer) {
  let reader;
  try {
    reader = new GifReader(buffer);
  } catch (error) {
    throw new Error(`image_scan: not a valid GIF (${error.message})`, { cause: error });
  }
  if (reader.numFrames() < 1) throw new Error('image_scan: GIF contains no frames');
  const { width, height } = reader;
  const pixels = new Uint8Array(width * height * 4);
  try {
    reader.decodeAndBlitFrameRGBA(0, pixels);
  } catch (error) {
    throw new Error(`image_scan: cannot decode GIF frame (${error.message})`, { cause: error });
  }
  return { width, height, data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength) };
}

// ---------------------------------------------------------------------------
// pipeline: downscale, classify, render
// ---------------------------------------------------------------------------

/** Luminance ramp, darkest first; index = luminance fraction over 9 levels. */
export const RAMP = '.:-=+*#%@';

/** Valid grid sizes (target cells on the longer side). */
export const SIZE_RANGE = { min: 8, max: 64 };

/** Threshold for the auto mode: fraction of non-gray cells that switches to the color grid. */
export const COLOR_MODE_FRACTION = 0.1;

/** A cell's saturation above which its accent color is trusted over the average. */
export const ACCENT_SATURATION = 60;

/** Auto palette thresholds: colored-cell fraction that selects full / basic / gray. */
export const AUTO_PALETTE_FRACTIONS = { full: 0.2, basic: 0.03 };

/**
 * Convert a grid-coordinate focus `[row0, col0, row1, col1]` into a fraction
 * region. Rows/cols are INCLUSIVE bounds of the full-image grid that a
 * previous `image_scan` output used (gridWidth = size, gridHeight follows the
 * image aspect — see the "grid coords" line in the render). This lets the
 * model zoom by saying "rows 8-14, cols 15-30" instead of hand-computing
 * 0..1 fractions.
 * @param focus - `[row0, col0, row1, col1]` inclusive grid coordinates.
 * @param gridWidth - the full-image grid width (the size argument).
 * @param gridHeight - the full-image grid height for that size.
 * @returns the equivalent `[x0, y0, x1, y1]` fraction region.
 */
export function resolveFocus(focus, gridWidth, gridHeight) {
  if (!Array.isArray(focus) || focus.length !== 4) {
    throw new Error('image_scan: focus must be [row0, col0, row1, col1] grid coordinates (inclusive)');
  }
  const [row0, col0, row1, col1] = focus.map((v) => Number(v));
  for (const v of [row0, col0, row1, col1]) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error('image_scan: focus values must be non-negative integers');
    }
  }
  if (row1 < row0 + 1 || col1 < col0 + 1) {
    throw new Error('image_scan: focus must span at least 2 rows and 2 columns (row1 > row0, col1 > col0)');
  }
  if (row1 >= gridHeight || col1 >= gridWidth) {
    throw new Error(`image_scan: focus out of range — the grid is ${gridWidth}x${gridHeight} (rows 0..${gridHeight - 1}, cols 0..${gridWidth - 1})`);
  }
  return [
    col0 / gridWidth,
    row0 / gridHeight,
    (col1 + 1) / gridWidth,
    (row1 + 1) / gridHeight
  ];
}

/**
 * Validate a 0..1 region and normalize it to `[x0, y0, x1, y1]`.
 * @param region - `[x0, y0, x1, y1]` fractions of the image, or undefined for full image.
 * @returns the normalized region.
 */
export function normalizeRegion(region) {
  if (region === undefined) return [0, 0, 1, 1];
  if (!Array.isArray(region) || region.length !== 4) {
    throw new Error('image_scan: region must be [x0, y0, x1, y1] fractions in 0..1');
  }
  const [x0, y0, x1, y1] = region.map((v) => Number(v));
  for (const v of [x0, y0, x1, y1]) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error('image_scan: region values must be numbers in 0..1');
    }
  }
  if (x1 <= x0 || y1 <= y0) {
    throw new Error('image_scan: region must have x1 > x0 and y1 > y0');
  }
  return [x0, y0, x1, y1];
}

/**
 * Analyze an image into a coarse cell grid plus color statistics.
 * @param rgba - RGBA `Buffer` (length `imgWidth * imgHeight * 4`).
 * @param imgWidth - source pixel width.
 * @param imgHeight - source pixel height.
 * @param options - `{ size, mode, region, palette, pxPerCell }`. `size` = target
 *   cells on the longer side; `pxPerCell` (mutually exclusive) = requested
 *   source pixels per cell, clamped to the 64-cell-per-side limit (the result
 *   reports the actual density via `regionWidth`/`regionHeight`).
 * @returns the analysis result consumed by {@link renderImageScan}.
 */
export function analyzeImage(rgba, imgWidth, imgHeight, { size, mode, region, palette, pxPerCell }) {
  const requestedPalette = resolvePaletteArgument(palette);
  const [rx0, ry0, rx1, ry1] = normalizeRegion(region);
  const rw = Math.max(1e-6, rx1 - rx0);
  const rh = Math.max(1e-6, ry1 - ry0);

  const px0 = Math.max(0, Math.floor(rx0 * imgWidth));
  const px1 = Math.min(imgWidth, Math.ceil(rx1 * imgWidth));
  const py0 = Math.max(0, Math.floor(ry0 * imgHeight));
  const py1 = Math.min(imgHeight, Math.ceil(ry1 * imgHeight));
  const regionWidth = px1 - px0;
  const regionHeight = py1 - py0;

  // Grid resolution: either size cells on the longer side, or a requested
  // pixel-per-cell density (clamped to 64 cells per side).
  let gridWidth;
  let gridHeight;
  if (pxPerCell !== undefined && pxPerCell > 0) {
    gridWidth = Math.min(64, Math.max(1, Math.round(regionWidth / pxPerCell)));
    gridHeight = Math.min(64, Math.max(1, Math.round(gridWidth * (regionHeight / Math.max(1, regionWidth)))));
  } else {
    gridWidth = size;
    gridHeight = Math.max(1, Math.round(size * ((rh * imgHeight) / (rw * imgWidth))));
  }

  const cells = new Array(gridWidth * gridHeight); // holes = fully transparent
  let contentCells = 0;

  for (let cy = 0; cy < gridHeight; cy += 1) {
    const y0 = py0 + Math.floor((cy * (py1 - py0)) / gridHeight);
    const y1 = py0 + Math.floor(((cy + 1) * (py1 - py0)) / gridHeight);
    for (let cx = 0; cx < gridWidth; cx += 1) {
      const x0 = px0 + Math.floor((cx * (px1 - px0)) / gridWidth);
      const x1 = px0 + Math.floor(((cx + 1) * (px1 - px0)) / gridWidth);
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let n = 0;
      let accentSat = -1;
      let accentR = 0;
      let accentG = 0;
      let accentB = 0;
      let minLuma = Infinity;
      let maxLuma = -Infinity;
      for (let y = y0; y < y1; y += 1) {
        const row = y * imgWidth * 4;
        for (let x = x0; x < x1; x += 1) {
          const p = row + x * 4;
          const a = rgba[p + 3];
          if (a < 128) continue;
          const r = rgba[p];
          const g = rgba[p + 1];
          const b = rgba[p + 2];
          sumR += r;
          sumG += g;
          sumB += b;
          n += 1;
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          if (luma < minLuma) minLuma = luma;
          if (luma > maxLuma) maxLuma = luma;
          const sat = Math.max(r, g, b) - Math.min(r, g, b);
          if (sat > accentSat) {
            accentSat = sat;
            accentR = r;
            accentG = g;
            accentB = b;
          }
        }
      }
      if (n === 0) continue;
      const avgR = Math.round(sumR / n);
      const avgG = Math.round(sumG / n);
      const avgB = Math.round(sumB / n);
      cells[cy * gridWidth + cx] = {
        luminance: luminance(avgR, avgG, avgB),
        detail: minLuma === Infinity ? 0 : Math.min(1, (maxLuma - minLuma) / 255),
        shade: shadeFor(avgR, avgG, avgB),
        avgR,
        avgG,
        avgB,
        accentR,
        accentG,
        accentB,
        accentSat
      };
      contentCells += 1;
    }
  }

  // Pixel-level color statistics: sample the region's actual pixels (not the
  // downsampled cells) so small colored details (pink blossoms, red banners,
  // cyan water) are reported at their TRUE area share instead of being diluted
  // into a gray cell average. Always uses the full 14-color palette, plus a
  // hue-family breakdown (BY HUE ONLY — survives dark/desaturated colors).
  const { colors: pixelColors, hues: pixelHues } = pixelColorStats(rgba, imgWidth, imgHeight, [rx0, ry0, rx1, ry1]);
  // Colored fraction judged by hue, not by the palette gate: a misty scene
  // whose colors are all dark/desaturated still counts as colorful.
  const coloredFractionPixel = pixelHues.filter((h) => h.name !== 'achromatic').reduce((sum, h) => sum + h.pct, 0) / 100;

  // Resolve the palette first (auto needs the colored fraction; pixel-level
  // is far more reliable than the coarse grid's for small color regions).
  const coloredFractionFull = coloredFractionPixel;
  const paletteKey =
    requestedPalette === 'auto'
      ? coloredFractionFull >= AUTO_PALETTE_FRACTIONS.full
        ? 'full'
        : coloredFractionFull >= AUTO_PALETTE_FRACTIONS.basic
          ? 'basic'
          : 'gray'
      : requestedPalette;

  const colors = pixelColors;
  const coloredFraction = coloredFractionPixel;
  const resolvedMode = mode === 'auto' ? (coloredFraction >= COLOR_MODE_FRACTION ? 'color' : 'ascii') : mode;

  // When the caller explicitly wants the color grid (mode="color"), auto must
  // not fall to the achromatic gray palette — the color grid needs colors.
  const effectivePaletteKey = requestedPalette === 'auto' && resolvedMode === 'color' && paletteKey === 'gray'
    ? 'basic'
    : paletteKey;

  // Global shade diversity + texture mix: how many distinct hue+brightness
  // buckets the image uses and how much fine detail it has. Many shades and
  // high rough share = photo-like; few shades + mostly smooth = flat artwork.
  const distinctShades = new Set();
  let smoothCells = 0;
  let mediumCells = 0;
  let roughCells = 0;
  for (const cell of cells) {
    if (!cell) continue;
    distinctShades.add(cell.shade);
    if (cell.detail < 0.15) smoothCells += 1;
    else if (cell.detail < 0.35) mediumCells += 1;
    else roughCells += 1;
  }
  const texture = {
    smooth: Math.round((smoothCells / Math.max(1, contentCells)) * 1000) / 10,
    medium: Math.round((mediumCells / Math.max(1, contentCells)) * 1000) / 10,
    rough: Math.round((roughCells / Math.max(1, contentCells)) * 1000) / 10
  };

  const result = {
    gridWidth,
    gridHeight,
    palette: effectivePaletteKey,
    colors,
    hues: pixelHues,
    mode: resolvedMode,
    distinctShades: distinctShades.size,
    texture,
    regionWidth,
    regionHeight,
    regions: buildBlobs(cells, gridWidth, gridHeight, effectivePaletteKey, contentCells),
    structure: structuralHints(cells, gridWidth, gridHeight, effectivePaletteKey),
    ascii: buildAsciiGrid(cells, gridWidth, gridHeight)
  };
  if (resolvedMode === 'color') {
    result.colorGrid = buildColorGrid(cells, gridWidth, gridHeight, effectivePaletteKey);
    result.colorLegend = colorLegendFor(effectivePaletteKey);
  }
  return result;
}

/**
 * Classify a color into a shade bucket: hue family + brightness level, or
 * black/gray/white when nearly achromatic. Used to measure color diversity
 * (flat artwork has 1-2 shades per region; photos have many).
 * @param r - red 0..255.
 * @param g - green 0..255.
 * @param b - blue 0..255.
 * @returns e.g. 'green-dark', 'blue-mid', 'gray', 'white'.
 */
export function shadeFor(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  if (max - min < 40) {
    if (luma < 40) return 'black';
    if (luma < 100) return 'darkgray';
    if (luma < 170) return 'gray';
    if (luma < 225) return 'lightgray';
    return 'white';
  }
  let hue;
  const d = max - min;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = ((hue * 60) % 360 + 360) % 360;
  let family;
  if (hue < 15 || hue >= 345) family = 'red';
  else if (hue < 45) family = 'orange';
  else if (hue < 70) family = 'yellow';
  else if (hue < 160) family = 'green';
  else if (hue < 200) family = 'cyan';
  else if (hue < 260) family = 'blue';
  else if (hue < 310) family = 'purple';
  else family = 'pink';
  const level = luma < 85 ? 'dark' : luma < 170 ? 'mid' : 'light';
  return `${family}-${level}`;
}

/** How many region rows are rendered before collapsing into "+N more". */
export const MAX_RENDERED_REGIONS = 8;

/**
 * Connected-color-region analysis (blob detection) on the classified grid:
 * 8-connected flood fill over same-color cells. The output is pure,
 * deterministic image structure — the MODEL does the semantic interpretation
 * ("a large round green blob with rough texture on a thin brown stem" -> tree).
 * @param cells - the sparse cell array from `analyzeImage` (holes = transparent).
 * @param gridWidth - grid width in cells.
 * @param gridHeight - grid height in cells.
 * @param paletteKey - the resolved palette.
 * @param contentCells - opaque cell count (for percentages).
 * @returns regions sorted by area: `{ color, code, cells, pct, rows, cols, w, h, aspect, density }`.
 */
export function buildBlobs(cells, gridWidth, gridHeight, paletteKey, contentCells) {
  const visited = new Uint8Array(cells.length);
  const blobs = [];
  const palette = PALETTES[paletteKey];
  for (let start = 0; start < cells.length; start += 1) {
    if (visited[start] || !cells[start]) continue;
    const colorIndex = cellColorIndex(cells[start], paletteKey);
    const stack = [start];
    visited[start] = 1;
    let count = 0;
    let detailSum = 0;
    let r0 = Infinity;
    let r1 = -1;
    let c0 = Infinity;
    let c1 = -1;
    const shades = new Map();
    while (stack.length > 0) {
      const index = stack.pop();
      const row = Math.floor(index / gridWidth);
      const col = index % gridWidth;
      count += 1;
      detailSum += cells[index].detail;
      shades.set(cells[index].shade, (shades.get(cells[index].shade) ?? 0) + 1);
      if (row < r0) r0 = row;
      if (row > r1) r1 = row;
      if (col < c0) c0 = col;
      if (col > c1) c1 = col;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 0 || nr >= gridHeight || nc < 0 || nc >= gridWidth) continue;
          const ni = nr * gridWidth + nc;
          if (visited[ni] || !cells[ni]) continue;
          if (cellColorIndex(cells[ni], paletteKey) === colorIndex) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }
    }
    const shadeList = [...shades.entries()]
      .map(([name, cellsCount]) => ({ name, pct: Math.round((cellsCount / count) * 1000) / 10 }))
      .sort((a, b) => b.pct - a.pct);
    const blobWidth = c1 - c0 + 1;
    const blobHeight = r1 - r0 + 1;
    blobs.push({
      color: palette[colorIndex].name,
      code: palette[colorIndex].code,
      cells: count,
      pct: Math.round((count / Math.max(1, contentCells)) * 1000) / 10,
      rows: [r0, r1],
      cols: [c0, c1],
      w: blobWidth,
      h: blobHeight,
      aspect: Math.round((blobWidth / blobHeight) * 10) / 10,
      density: detailSum / count < 0.15 ? 'smooth' : detailSum / count < 0.35 ? 'medium' : 'rough',
      shades: shadeList
    });
  }
  return blobs.sort((a, b) => b.cells - a.cells);
}

/** The color-grid color index for one cell under a palette (null for transparent). */
function cellColorIndex(cell, paletteKey) {
  if (!cell) return null;
  const avgClass = classify(cell.avgR, cell.avgG, cell.avgB, paletteKey);
  if (paletteKey === 'gray' || cell.accentSat <= ACCENT_SATURATION) return avgClass.index;
  const accentClass = classify(cell.accentR, cell.accentG, cell.accentB, paletteKey);
  return accentClass.gray ? avgClass.index : accentClass.index;
}

function countColored(cells, paletteKey) {
  let count = 0;
  for (const cell of cells) {
    const index = cellColorIndex(cell, paletteKey);
    if (index === null) continue;
    if (!GRAY_FAMILY.has(PALETTES[paletteKey][index].name)) count += 1;
  }
  return count;
}

function colorStats(cells, paletteKey, contentCells) {
  const palette = PALETTES[paletteKey];
  const counts = new Map();
  for (const cell of cells) {
    const index = cellColorIndex(cell, paletteKey);
    if (index === null) continue;
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([index, count]) => ({
      name: palette[index].name,
      hex: palette[index].hex,
      count,
      pct: Math.round((count / contentCells) * 1000) / 10
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * TRUE pixel-level color statistics for a region: sample the actual pixels
 * (every `sampleStep`-th in both axes) and classify each against the full
 * 14-color palette. Unlike cell-average statistics, small colored regions
 * keep their real area share, so a few percent of pink blossoms or red
 * banners are reported instead of being diluted into gray.
 *
 * Also returns `hues`: hue-FAMILY shares (red/orange/yellow/green/cyan/blue/
 * purple/pink/achromatic), which are insensitive to darkness — a dark olive
 * hillside that the 14-color palette would fold into "black" is still
 * reported as green-family 12%.
 * @param rgba - RGBA `Buffer`.
 * @param imgWidth - source width.
 * @param imgHeight - source height.
 * @param region - `[x0, y0, x1, y1]` fractions.
 * @param sampleStep - sampling stride in pixels (auto-grown for huge regions).
 * @returns `{ colors, hues }` where both are `[{ name, pct }]` arrays.
 */
export function pixelColorStats(rgba, imgWidth, imgHeight, region, sampleStep) {
  const [rx0, ry0, rx1, ry1] = normalizeRegion(region);
  const x0 = Math.max(0, Math.floor(rx0 * imgWidth));
  const x1 = Math.min(imgWidth, Math.ceil(rx1 * imgWidth));
  const y0 = Math.max(0, Math.floor(ry0 * imgHeight));
  const y1 = Math.min(imgHeight, Math.ceil(ry1 * imgHeight));
  const regionW = x1 - x0;
  const regionH = y1 - y0;
  // keep ~2M samples max; stride 3 default
  const step = sampleStep ?? Math.max(3, Math.ceil(Math.sqrt((regionW * regionH) / 2_000_000)));
  const colorCounts = new Map();
  const hueCounts = new Map();
  let total = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const p = (y * imgWidth + x) * 4;
      if (rgba[p + 3] < 128) continue;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      const index = classify(r, g, b, 'full').index;
      colorCounts.set(index, (colorCounts.get(index) ?? 0) + 1);
      const family = hueFamilyFor(r, g, b);
      hueCounts.set(family, (hueCounts.get(family) ?? 0) + 1);
      total += 1;
    }
  }
  const toList = (counts) => [...counts.entries()]
    .map(([key, count]) => ({ name: key, count, pct: total === 0 ? 0 : Math.round((count / total) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);
  return {
    colors: toList(colorCounts).map(({ name, count, pct }) => ({ name: PALETTE[name].name, hex: PALETTE[name].hex, count, pct })),
    hues: toList(hueCounts).map(({ name, count, pct }) => ({ name, count, pct }))
  };
}

/** Hue family names that are considered chromatic (everything else is achromatic). */
const COLOR_FAMILIES = new Set(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']);

/**
 * Hue family of a color BY HUE ONLY (no saturation gate): dark/desaturated
 * colors like an olive hillside or misty pink blossoms keep their family, so
 * hue statistics survive scenes the 14-color palette would flatten to gray.
 * Truly colorless pixels (channel spread < 8) return 'achromatic'.
 * @param r - red 0..255.
 * @param g - green 0..255.
 * @param b - blue 0..255.
 * @returns 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'purple' | 'pink' | 'achromatic'.
 */
export function hueFamilyFor(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 8) return 'achromatic';
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = ((hue * 60) % 360 + 360) % 360;
  if (hue < 15 || hue >= 345) return 'red';
  if (hue < 45) return 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 160) return 'green';
  if (hue < 200) return 'cyan';
  if (hue < 260) return 'blue';
  if (hue < 310) return 'purple';
  return 'pink';
}

/** Rec.601 luma for an RGB triple. */
export function luminance(r, g, b) {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

function rampChar(luma) {
  return RAMP[Math.min(RAMP.length - 1, Math.floor((luma / 255) * RAMP.length))];
}

function buildAsciiGrid(cells, gridWidth, gridHeight) {
  const rows = [];
  for (let cy = 0; cy < gridHeight; cy += 1) {
    let row = '';
    for (let cx = 0; cx < gridWidth; cx += 1) {
      const cell = cells[cy * gridWidth + cx];
      row += !cell ? ' ' : rampChar(cell.luminance);
    }
    rows.push(row);
  }
  return rows.join('\n');
}

function buildColorGrid(cells, gridWidth, gridHeight, paletteKey) {
  const palette = PALETTES[paletteKey];
  const rows = [];
  for (let cy = 0; cy < gridHeight; cy += 1) {
    let row = '';
    for (let cx = 0; cx < gridWidth; cx += 1) {
      const index = cellColorIndex(cells[cy * gridWidth + cx], paletteKey);
      row += index === null ? ' ' : palette[index].code;
    }
    rows.push(row);
  }
  return rows.join('\n');
}

/**
 * Render an analysis result as model-facing text.
 * @param value - the analysis result (plus `path`/`width`/`height`/`region`).
 * @returns the multi-line text fed back to the model.
 */
export function renderImageScan(value) {
  const lines = [];
  const regionW = value.regionWidth ?? value.width;
  const regionH = value.regionHeight ?? value.height;
  const cellW = Math.round((regionW / value.gridWidth) * 10) / 10;
  const cellH = Math.round((regionH / value.gridHeight) * 10) / 10;
  lines.push(`image: ${value.path} (${value.width}x${value.height} -> ${value.gridWidth}x${value.gridHeight} cells, ~${cellW}x${cellH}px per cell, region=${value.region}, palette=${value.palette}, mode=${value.mode})`);
  lines.push(`grid coords: rows 0..${value.gridHeight - 1}, cols 0..${value.gridWidth - 1}; zoom with focus: [row0,col0,row1,col1] (keep size unchanged, see below) or region: [x0,y0,x1,y1] (0..1 fractions)`);
  if (value.distinctShades !== undefined) {
    lines.push(`shade diversity: ${value.distinctShades} distinct shades | texture: smooth ${value.texture?.smooth ?? 0}%, medium ${value.texture?.medium ?? 0}%, rough ${value.texture?.rough ?? 0}% (many shades + rough = photo-like; few shades + smooth = flat artwork)`);
  }
  if (value.structure !== undefined && value.structure.length > 0) {
    lines.push(`structure: ${value.structure.join('; ')}`);
  }
  if (value.regions !== undefined && value.regions.length > 0) {
    lines.push('regions (connected color blobs, by area; rows/cols in grid coords, w/h aspect, texture density, shade mix):');
    for (const region of value.regions.slice(0, MAX_RENDERED_REGIONS)) {
      const shadeMix = region.shades.slice(0, 3).map((s) => `${s.name} ${s.pct}%`).join(', ');
      const shadeCount = region.shades.length;
      lines.push(`- ${region.color} ${region.pct}% @ rows ${region.rows[0]}..${region.rows[1]}, cols ${region.cols[0]}..${region.cols[1]}, ${region.w}x${region.h}, w/h=${region.aspect}, ${region.density}, ${shadeCount} shade(s): ${shadeMix}`);
    }
    if (value.regions.length > MAX_RENDERED_REGIONS) {
      lines.push(`(+ ${value.regions.length - MAX_RENDERED_REGIONS} smaller blobs)`);
    }
  }
  if (value.colors.length > 0) {
    lines.push(`colors by area: ${value.colors.map((c) => `${c.name} ${c.pct}% (${c.hex})`).join(', ')}`);
  } else {
    lines.push('colors by area: (fully transparent)');
  }
  if (value.hues !== undefined && value.hues.length > 0) {
    const coloredHues = value.hues.filter((h) => h.name !== 'achromatic');
    const achromatic = value.hues.find((h) => h.name === 'achromatic');
    if (coloredHues.length > 0) {
      lines.push(`hue families: ${coloredHues.map((h) => `${h.name} ${h.pct}%`).join(', ')}${achromatic ? `, achromatic ${achromatic.pct}%` : ''}`);
    }
  }
  lines.push('');
  lines.push("luminance grid (rows top->bottom, cols left->right; ' '=transparent; '.' darkest -> '@' brightest):");
  lines.push(value.ascii);
  if (value.colorGrid !== undefined) {
    lines.push('');
    lines.push(`color grid (one letter per cell; legend: ${value.colorLegend}):`);
    lines.push(value.colorGrid);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// crop + PNG encode + OCR (Windows.Media.Ocr via PowerShell)
// ---------------------------------------------------------------------------

/**
 * Crop an RGBA buffer to a fraction region.
 * @param rgba - RGBA `Buffer`.
 * @param imgWidth - source width.
 * @param imgHeight - source height.
 * @param region - `[x0, y0, x1, y1]` fractions, or undefined for the full image.
 * @returns `{ data, width, height }` with the cropped RGBA.
 */
export function cropRgba(rgba, imgWidth, imgHeight, region) {
  const [rx0, ry0, rx1, ry1] = normalizeRegion(region);
  const x0 = Math.max(0, Math.floor(rx0 * imgWidth));
  const x1 = Math.min(imgWidth, Math.ceil(rx1 * imgWidth));
  const y0 = Math.max(0, Math.floor(ry0 * imgHeight));
  const y1 = Math.min(imgHeight, Math.ceil(ry1 * imgHeight));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    rgba.copy(data, y * w * 4, (y0 + y) * imgWidth * 4, (y0 + y) * imgWidth * 4 + w * 4);
  }
  return { data, width: w, height: h };
}

/** Encode an RGBA buffer as PNG bytes (lossless, for feeding OCR). */
export function encodePng(rgba, width, height) {
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  return PNG.sync.write(png);
}

/**
 * Build the PowerShell command that runs Windows.Media.Ocr on a PNG file and
 * emits a UTF-8 JSON payload as base64 on stdout.
 * @param pngPath - absolute path to the PNG to recognize.
 * @param language - optional BCP-47 tag (e.g. 'zh-Hans'); defaults to the user's languages.
 * @returns the PowerShell command string (joined statements).
 */
export function buildOcrCommand(pngPath, language) {
  const esc = (s) => String(s).replaceAll("'", "''");
  const engineLine =
    language === undefined
      ? '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()'
      : `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('${esc(language)}'))`;
  return [
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]',
    '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]',
    '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]',
    "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    'Function Await($WinRtTask, $ResultType) {',
    '  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)',
    '  $netTask = $asTask.Invoke($null, @($WinRtTask))',
    '  $netTask.Wait(-1) | Out-Null',
    '  $netTask.Result',
    '}',
    `$path = '${esc(pngPath)}'`,
    '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])',
    '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
    '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
    '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
    engineLine,
    "if ($engine -eq $null) { Write-Error 'no OCR engine for the requested language'; exit 2 }",
    '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
    '$lines = @()',
    'foreach ($line in $result.Lines) {',
    '  $words = @()',
    '  foreach ($w in $line.Words) {',
    '    $words += [PSCustomObject]@{ Text = $w.Text; X = [int]$w.BoundingRect.X; Y = [int]$w.BoundingRect.Y; W = [int]$w.BoundingRect.Width; H = [int]$w.BoundingRect.Height }',
    '  }',
    '  $lines += [PSCustomObject]@{ Text = $line.Text; X = [int]$line.BoundingRect.X; Y = [int]$line.BoundingRect.Y; W = [int]$line.BoundingRect.Width; H = [int]$line.BoundingRect.Height; Words = $words }',
    '}',
    '$json = [PSCustomObject]@{ Width = $decoder.PixelWidth; Height = $decoder.PixelHeight; Lines = $lines } | ConvertTo-Json -Depth 5',
    '[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))'
  ].join('; ');
}

/**
 * Run Windows OCR on a PNG file and parse the result.
 * @param pngPath - absolute path to the PNG.
 * @param options - `{ language }`.
 * @returns `{ width, height, lines }` where each line is
 *   `{ text, x, y, width, height }` (pixel box aggregated from its words).
 */
export function runOcr(pngPath, { language } = {}) {
  const command = buildOcrCommand(pngPath, language);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('image_ocr: OCR timed out after 30s'));
    }, 30_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`image_ocr: cannot start OCR engine: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`image_ocr: OCR engine failed (exit ${code}): ${stderr.trim().slice(0, 300)}`));
        return;
      }
      try {
        const json = Buffer.from(stdout.trim(), 'base64').toString('utf8');
        const parsed = JSON.parse(json);
        const lines = (parsed.Lines ?? []).map((line) => {
          let minX = Infinity;
          let minY = Infinity;
          let maxRight = -Infinity;
          let maxBottom = -Infinity;
          for (const word of line.Words ?? []) {
            minX = Math.min(minX, word.X);
            minY = Math.min(minY, word.Y);
            maxRight = Math.max(maxRight, word.X + word.W);
            maxBottom = Math.max(maxBottom, word.Y + word.H);
          }
          return {
            text: line.Text,
            x: minX === Infinity ? 0 : minX,
            y: minY === Infinity ? 0 : minY,
            width: maxRight === -Infinity ? 0 : maxRight - minX,
            height: maxBottom === -Infinity ? 0 : maxBottom - minY
          };
        });
        resolve({ width: parsed.Width, height: parsed.Height, lines });
      } catch (error) {
        reject(new Error(`image_ocr: cannot parse OCR result: ${error.message}`));
      }
    });
  });
}

/**
 * Full OCR pipeline: decode -> optional region crop -> PNG temp file ->
 * OCR engine -> cleanup. Returns recognized text lines with pixel boxes.
 * @param buffer - raw image bytes.
 * @param ext - lowercase extension ('.png' etc.).
 * @param options - `{ region, language, engine }`. engine: 'windows'
 *   (Windows.Media.Ocr, default), 'paddle' (PaddleOCR via the local
 *   paddle_venv) or 'rapid' (RapidOCR via the local rapid_venv) — Paddle and
 *   Rapid are far better at glowing/curved/game-rendered text.
 * @returns `{ width, height, lines }`.
 */
export async function ocrImage(buffer, ext, { region, language, engine = 'windows' } = {}) {
  const image = decodeImage(buffer, ext);
  let work = image;
  if (region !== undefined) {
    const cropped = cropRgba(image.data, image.width, image.height, normalizeRegion(region));
    work = cropped;
  }
  const pngBytes = encodePng(work.data, work.width, work.height);
  // WSL compat: powershell.exe (Windows OCR) cannot reach a WSL /tmp path and
  // GetFileFromPathAsync rejects forward slashes — write the temp PNG under
  // /mnt/c/Windows/Temp and hand Windows a backslash path.
  const isWsl = process.platform === 'linux' && /microsoft/i.test(release());
  const tmpBase = isWsl ? '/mnt/c/Windows/Temp' : tmpdir();
  const tmpName = `picturereader-ocr-${randomBytes(6).toString('hex')}.png`;
  const tmpPath = join(tmpBase, tmpName);
  const winPath = isWsl ? `C:\\Windows\\Temp\\${tmpName}` : tmpPath;
  await writeFile(tmpPath, pngBytes);
  try {
    if (engine === 'paddle') {
      const result = await runPaddleOcr(tmpPath);
      return { width: work.width, height: work.height, lines: result.lines };
    }
    if (engine === 'rapid') {
      const result = await runRapidOcr(tmpPath);
      return { width: work.width, height: work.height, lines: result.lines };
    }
    return await runOcr(winPath, { language });
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

/** Absolute path to the local PaddleOCR environment (paddle_venv); overridable via DSH_PADDLE_PYTHON. */
export function paddlePython() {
  return process.env.DSH_PADDLE_PYTHON ?? 'C:/Users/Administrator/paddle_venv/Scripts/python.exe';
}
/** PaddleX model cache (the default ~/.paddlex is broken on this machine); overridable via DSH_PADDLE_CACHE. */
export function paddleCacheHome() {
  return process.env.DSH_PADDLE_CACHE ?? 'D:/coding/picturereader/.paddlex-cache';
}

/**
 * Whether the optional PaddleOCR environment is available. PaddleOCR is an
 * OPTIONAL engine: when it is missing, callers must degrade gracefully to the
 * Windows engine instead of failing.
 * @param python - python executable to probe (defaults to the configured path).
 * @returns true when the interpreter exists.
 */
export async function paddleAvailable(python = paddlePython()) {
  try {
    await stat(python);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run PaddleOCR on a PNG file via the local paddle_venv. Strongly better than
 * Windows OCR for glowing, curved, or game-rendered text (verified on the
 * ENDFIELD "勇于探索叩问苍穹" banner). Model load takes ~2s per call.
 * @param pngPath - absolute path to the PNG.
 * @returns `{ lines: [{ text, score, x, y, width, height }] }` (box aggregated).
 */
export function runPaddleOcr(pngPath) {
  const escaped = String(pngPath).replaceAll("'", "''");
  const script = [
    'import base64, json, sys',
    'from paddleocr import PaddleOCR',
    "ocr = PaddleOCR(lang='ch', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, enable_mkldnn=False)",
    `result = ocr.predict(r'${escaped}')`,
    'lines = []',
    'for res in result:',
    "    texts = res.get('rec_texts') or []",
    "    scores = res.get('rec_scores') or []",
    "    polys = res.get('rec_polys') or []",
    '    for i, t in enumerate(texts):',
    '        if i < len(polys):',
    '            pts = [[int(float(v)) for v in pt] for pt in polys[i]]',
    '            xs = [pt[0] for pt in pts]; ys = [pt[1] for pt in pts]',
    '            box = {"x": min(xs), "y": min(ys), "width": max(xs)-min(xs), "height": max(ys)-min(ys)}',
    '        else:',
    '            box = {"x": 0, "y": 0, "width": 0, "height": 0}',
    "        score = round(float(scores[i]), 3) if i < len(scores) else 0.0",
    "        lines.append({'text': t, 'score': score, **box})",
    "out = json.dumps({'lines': lines}, ensure_ascii=False)",
    "sys.stdout.write(base64.b64encode(out.encode('utf-8')).decode('ascii'))"
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(paddlePython(), ['-c', script], {
      env: { ...process.env, PADDLE_PDX_CACHE_HOME: paddleCacheHome(), PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('image_ocr: PaddleOCR timed out after 60s'));
    }, 60_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`image_ocr: cannot start PaddleOCR: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').filter((l) => l.includes('Error') || l.includes('error') || l.includes('Traceback')).slice(-3).join(' | ') || stderr.trim().slice(-200);
        reject(new Error(`image_ocr: PaddleOCR failed (exit ${code}): ${tail}`));
        return;
      }
      try {
        const json = Buffer.from(stdout.trim(), 'base64').toString('utf8');
        const parsed = JSON.parse(json);
        resolve({ lines: parsed.lines ?? [] });
      } catch (error) {
        reject(new Error(`image_ocr: cannot parse PaddleOCR result: ${error.message}`));
      }
    });
  });
}

/** Absolute path to the local RapidOCR environment (rapid_venv); overridable via DSH_RAPID_PYTHON. */
export function rapidPython() {
  return process.env.DSH_RAPID_PYTHON ?? 'C:/Users/Administrator/rapid_venv/Scripts/python.exe';
}

/**
 * Whether the optional RapidOCR environment is available. RapidOCR is an
 * OPTIONAL engine: when it is missing, callers must degrade gracefully to the
 * Windows engine instead of failing.
 * @param python - python executable to probe (defaults to the configured path).
 * @returns true when the interpreter exists AND `rapidocr_onnxruntime` imports.
 */
export async function rapidAvailable(python = rapidPython()) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn(python, ['-c', 'import rapidocr_onnxruntime'], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: 'ignore'
    });
    const timer = setTimeout(() => { child.kill(); finish(false); }, 30_000);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * Run RapidOCR on a PNG file via the local rapid_venv. Uses the bundled
 * det/rec/cls ONNX models (no network download on first run — verified on
 * rapidocr_onnxruntime 1.2.3). Better than Windows OCR for glowing, curved,
 * or game-rendered text.
 * @param pngPath - absolute path to the PNG (forward slashes recommended).
 * @returns `{ lines: [{ text, score, x, y, width, height }] }` (box aggregated).
 */
export function runRapidOcr(pngPath) {
  const script = [
    'import json, sys',
    'from rapidocr_onnxruntime import RapidOCR',
    '_engine = RapidOCR()',
    '_result, _elapse = _engine(sys.argv[1])',
    '_out = []',
    'for _it in (_result or []):',
    '    _pts = [[float(c) for c in _p] for _p in _it[0]]',
    '    _xs = [_p[0] for _p in _pts]; _ys = [_p[1] for _p in _pts]',
    "    _out.append({'text': _it[1], 'score': float(_it[2]), 'x': int(min(_xs)), 'y': int(min(_ys)), 'width': int(max(_xs)-min(_xs)), 'height': int(max(_ys)-min(_ys))})",
    "print(json.dumps({'lines': _out}, ensure_ascii=False), flush=True)"
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(rapidPython(), ['-c', script, String(pngPath)], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('image_ocr: RapidOCR timed out after 60s'));
    }, 60_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`image_ocr: cannot start RapidOCR: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').filter((l) => l.includes('Error') || l.includes('error') || l.includes('Traceback')).slice(-3).join(' | ') || stderr.trim().slice(-200);
        reject(new Error(`image_ocr: RapidOCR failed (exit ${code}): ${tail}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ lines: parsed.lines ?? [] });
      } catch (error) {
        reject(new Error(`image_ocr: cannot parse RapidOCR result: ${error.message}`));
      }
    });
  });
}

/**
 * Render OCR results as model-facing text.
 * @param value - `{ path, width, height, region, lines }`.
 * @returns the multi-line text.
 */
export function renderOcr(value) {
  const lines = [];
  lines.push(`ocr: ${value.path} (${value.width}x${value.height}, region=${value.region}, engine=${value.engine ?? 'windows'})`);
  if (value.note !== undefined) {
    lines.push(`note: ${value.note}`);
  }
  if (value.lines.length === 0) {
    lines.push('no text recognized in this region');
  } else {
    lines.push(`recognized ${value.lines.length} line(s):`);
    value.lines.forEach((line, index) => {
      const score = line.score !== undefined ? ` score=${line.score}` : '';
      lines.push(`${index + 1}. "${line.text}" @ (${line.x},${line.y}) ${line.width}x${line.height}${score}`);
    });
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// pixel-level texture sampling (material hints for the model)
// ---------------------------------------------------------------------------

/**
 * Sample a small region as an NxN grid of EXACT pixels (one sample per cell,
 * taken at the cell center — not an average). Together with the contrast
 * statistic this lets the model judge local material: smooth gradients (skin,
 * sky), high-contrast stripes (metal, wood grain), periodic repeats (fabric),
 * high-frequency noise (foliage).
 * @param rgba - RGBA `Buffer`.
 * @param imgWidth - source width.
 * @param imgHeight - source height.
 * @param region - `[x0, y0, x1, y1]` fractions; must cover at least `size` px
 *   in each direction so samples are distinct.
 * @param size - grid side length (2..16, default 8).
 * @returns `{ width, height, points, contrast, distinct, stepX, stepY }`.
 */
export function samplePixels(rgba, imgWidth, imgHeight, region, size = 8) {
  const grid = Math.min(16, Math.max(2, Math.round(size)));
  const [rx0, ry0, rx1, ry1] = normalizeRegion(region);
  const x0 = Math.floor(rx0 * imgWidth);
  const x1 = Math.ceil(rx1 * imgWidth);
  const y0 = Math.floor(ry0 * imgHeight);
  const y1 = Math.ceil(ry1 * imgHeight);
  const regionW = x1 - x0;
  const regionH = y1 - y0;
  if (regionW < grid || regionH < grid) {
    throw new Error(
      `image_sample: the region is only ${regionW}x${regionH}px — too small for a ${grid}x${grid} sample; enlarge the region or use a smaller size`
    );
  }
  const points = [];
  const colors = new Set();
  for (let gy = 0; gy < grid; gy += 1) {
    const row = [];
    const py = y0 + Math.floor(((gy + 0.5) * regionH) / grid);
    for (let gx = 0; gx < grid; gx += 1) {
      const px = x0 + Math.floor(((gx + 0.5) * regionW) / grid);
      const p = (Math.min(imgHeight - 1, py) * imgWidth + Math.min(imgWidth - 1, px)) * 4;
      const color = [rgba[p], rgba[p + 1], rgba[p + 2]];
      row.push(color);
      colors.add((color[0] << 16) | (color[1] << 8) | color[2]);
    }
    points.push(row);
  }
  // adjacent-sample contrast: mean RGB distance between horizontal neighbours
  let diffSum = 0;
  let diffCount = 0;
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid - 1; gx += 1) {
      const a = points[gy][gx];
      const b = points[gy][gx + 1];
      diffSum += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      diffCount += 1;
    }
  }
  return {
    width: regionW,
    height: regionH,
    stepX: regionW / grid,
    stepY: regionH / grid,
    points,
    contrast: diffCount === 0 ? 0 : Math.round((diffSum / diffCount / 3 / 255) * 1000) / 1000,
    distinct: colors.size
  };
}

/**
 * Render a texture sample as model-facing text: an NxN grid of exact RGB
 * triples plus interpretation hints.
 * @param value - `{ path, width, height, region, points, contrast, distinct, stepX, stepY }`.
 * @returns the multi-line text.
 */
export function renderSample(value) {
  const lines = [];
  const grid = value.points.length;
  lines.push(`texture sample: ${value.path} region ${value.region} (${value.width}x${value.height} px, ${grid}x${grid} exact pixels, ~${Math.round(value.stepX * 10) / 10}px apart)`);
  for (const row of value.points) {
    lines.push(row.map(([r, g, b]) => `(${r},${g},${b})`).join(' '));
  }
  const contrastLabel = value.contrast < 0.04 ? 'smooth (gradient, uniform)' : value.contrast < 0.12 ? 'subtle texture' : 'high contrast (rough/material)';
  lines.push(`stats: local contrast ${value.contrast} -> ${contrastLabel}; ${value.distinct} distinct colors`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// structural hints: stripes, symmetry (shape evidence for the model)
// ---------------------------------------------------------------------------

/** The dominant color index of a row or column (null if fully transparent). */
function dominantIndex(seq) {
  const counts = new Map();
  for (const index of seq) {
    if (index === null) continue;
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Longest run of adjacent elements that are all pairwise different (and non-null). */
function longestAlternating(seq) {
  let bestStart = 0;
  let bestLength = 0;
  let start = 0;
  for (let i = 1; i <= seq.length; i += 1) {
    const alternates = i < seq.length && seq[i] !== null && seq[i - 1] !== null && seq[i] !== seq[i - 1];
    if (alternates) continue;
    const length = i - start;
    if (length > bestLength) {
      bestLength = length;
      bestStart = start;
    }
    start = i;
  }
  return { start: bestStart, length: bestLength };
}

/**
 * Detect parallel stripes (alternating color bands) in a row/column of
 * dominant colors. Panels, grilles and blades produce 2-4 colors alternating
 * across several adjacent columns/rows (e.g. K/Y/K/Y for solar panels).
 * @param seq - dominant color index per column (or row), null for empty.
 * @returns `{ start, length, colors }` or null.
 */
function detectStripe(seq) {
  const { start, length } = longestAlternating(seq);
  if (length < 4) return null;
  const colors = new Set(seq.slice(start, start + length).filter((v) => v !== null));
  if (colors.size < 2 || colors.size > 4) return null;
  return { start, length, colors: [...colors] };
}

/**
 * Compute structural shape evidence from the classified grid: parallel
 * stripes (vertical/horizontal alternating bands -> panels/grilles/blades)
 * and left-right symmetry (manufactured/constructed objects).
 * @param cells - the sparse cell array.
 * @param gridWidth - grid width.
 * @param gridHeight - grid height.
 * @param paletteKey - the resolved palette.
 * @returns an array of human-readable hints (empty when none found).
 */
export function structuralHints(cells, gridWidth, gridHeight, paletteKey) {
  const hints = [];
  // per-column dominant colors
  const colMajors = [];
  for (let c = 0; c < gridWidth; c += 1) {
    const column = [];
    for (let r = 0; r < gridHeight; r += 1) column.push(cellColorIndex(cells[r * gridWidth + c], paletteKey));
    colMajors.push(dominantIndex(column));
  }
  const vertical = detectStripe(colMajors);
  if (vertical !== null) {
    hints.push(`${vertical.length} vertical stripes (${vertical.colors.length} alternating colors) at cols ${vertical.start}..${vertical.start + vertical.length - 1}`);
  }
  // per-row dominant colors
  const rowMajors = [];
  for (let r = 0; r < gridHeight; r += 1) {
    const row = [];
    for (let c = 0; c < gridWidth; c += 1) row.push(cellColorIndex(cells[r * gridWidth + c], paletteKey));
    rowMajors.push(dominantIndex(row));
  }
  const horizontal = detectStripe(rowMajors);
  if (horizontal !== null) {
    hints.push(`${horizontal.length} horizontal stripes (${horizontal.colors.length} alternating colors) at rows ${horizontal.start}..${horizontal.start + horizontal.length - 1}`);
  }
  // left-right symmetry (always reported as a number; >= 0.5 flagged as notable)
  let same = 0;
  let total = 0;
  for (let r = 0; r < gridHeight; r += 1) {
    for (let c = 0; c < Math.floor(gridWidth / 2); c += 1) {
      const a = cellColorIndex(cells[r * gridWidth + c], paletteKey);
      const b = cellColorIndex(cells[r * gridWidth + (gridWidth - 1 - c)], paletteKey);
      if (a === null && b === null) continue;
      total += 1;
      if (a === b) same += 1;
    }
  }
  const symmetry = total === 0 ? 0 : same / total;
  hints.push(`left-right symmetry ${Math.round(symmetry * 100)}%${symmetry >= 0.5 ? ' (suggestive of manufactured/constructed shapes)' : ''}`);
  return hints;
}
