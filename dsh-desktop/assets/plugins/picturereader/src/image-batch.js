/**
 * image_batch — 批量规模/上下文验证工具 for the text-only DSH model.
 *
 * When a lot of images are handed over at once without per-file instructions,
 * a text-only model must not blindly call image_scan / image_ocr / VLM on each
 * one (that explodes the context and wastes calls). This tool gives the model a
 * compact MANIFEST of the whole batch in one shot:
 *
 *   1. decode every image (same extension validation + BYTE/MAX_PIXELS caps,
 *      bad singles are recorded as errors and skipped, never a whole-batch fail)
 *   2. 'auto' auto_ocr: probe the first few images with OCR; if they are
 *      text-dense ("the first few are all text"), treat the batch as a document
 *      / screenshot set and run full OCR on everything; otherwise only OCR
 *      the text-dense ones individually.
 *   3. classify each image (text / table / photo / chart / blank / unknown)
 *      and attach an ocr_excerpt / scan_preview / recommendation.
 *   4. summarise totals and tell the model which indices are worth deepening.
 *   5. soft-cap the total rendered text so a 50-file batch stays ~6k chars.
 *
 * Registration happens in index.js via the shared ctx.tools.register flow, so
 * this file only exports the factory.
 *
 * @module picturereader/image-batch
 */

import { extname } from 'node:path';
import { BYTE_CAP, MAX_PIXELS } from './tool.js';
import { getRuntimeConfig } from './runtime.js';

const CORE_URL = new URL('./core.js', import.meta.url).href;
let coreCache = { url: null, mtime: -1, module: null };

/** Load the newest core.js (cache-busted by mtime), same as tool.js / vision-analyze.js. */
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

/** The most recent core module, used by the synchronous output.render. */
let latestCore = null;

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILES = 50;
const DEFAULT_PROBE_FIRST = 3;
const DEFAULT_OCR_LIMIT_CHARS = 800;
const DEFAULT_SCAN_SIZE = 16; // lighter than single-image 32 to keep batches compact
const SOFT_OUTPUT_LIMIT = 6000; // ~char budget for the whole rendered batch

/** A line counts as OCR-recognised text if it is non-empty. */
function nonEmptyLines(ocrResult) {
  const lines = ocrResult && Array.isArray(ocrResult.lines) ? ocrResult.lines : [];
  return lines.filter((l) => typeof l?.text === 'string' && l.text.trim().length > 0).length;
}

/**
 * Classify an image into a coarse type using scan statistics + OCR line count.
 * Pure heuristic — the batch manifest is a triage aid, not a vision model.
 * @param analysis - result of core.analyzeImage.
 * @param ocrLines - number of non-empty OCR lines (0 when OCR wasn't run / none).
 * @param hasHorizontalStripes - whether the scan reported horizontal stripes.
 * @returns one of 'text' | 'table' | 'chart' | 'photo' | 'blank' | 'unknown'.
 */
export function classifyType(analysis, ocrLines, hasHorizontalStripes = false) {
  const rough = analysis?.texture?.rough ?? 0;
  const shades = analysis?.distinctShades ?? 0;
  const hueFraction =
    (analysis?.hues ?? []).filter((h) => h.name !== 'achromatic').reduce((s, h) => s + h.pct, 0) / 100;
  const regionCount = (analysis?.regions ?? []).length;

  // text-dense takes precedence over everything else (a blank-looking cell
  // grid can still be a screenshot of a document).
  if (ocrLines >= 2) {
    // text PLUS horizontal ruling lines reads like a table
    return hasHorizontalStripes ? 'table' : 'text';
  }
  // a single OCR line + ruling lines also leans table
  if (ocrLines === 1 && hasHorizontalStripes) return 'table';

  // blank: no text and almost nothing there (very low shade/texture diversity)
  if (shades <= 1 && rough < 8) return 'blank';

  // chart: several distinct color blobs + a decent colour spread
  if (regionCount >= 6 && hueFraction >= 0.05) return 'chart';

  // photo: high-frequency detail (rough texture) or many shades + colour
  if (rough >= 15 || (shades >= 6 && hueFraction >= 0.15)) return 'photo';
  if (hueFraction >= 0.2) return 'photo';

  return 'unknown';
}

/**
 * A default recommendation string per type, telling the model how to deepen.
 * @param type - the classified type.
 * @returns a short imperative recommendation.
 */
export function recommendFor(type) {
  switch (type) {
    case 'text': return 'read it with image_ocr (full text)';
    case 'table': return 'image_ocr for the cell text, then image_scan+sample for layout';
    case 'chart': return 'image_scan for axes/trends, then image_sample on points of interest';
    case 'photo': return 'rich photo-like content — the one case worth considering an external VLM';
    case 'blank': return 'skip — low information content';
    default: return 'quick image_scan to confirm what it holds';
  }
}

/** True if any structure hint mentions horizontal stripes. */
function hasHorizontalStripes(analysis) {
  return (analysis?.structure ?? []).some((h) => /horizontal stripes/i.test(String(h)));
}

/* Validate / normalise the auto_ocr argument. */
function parseAutoOcr(raw) {
  const value = raw === undefined ? 'auto' : String(raw);
  if (value !== 'auto' && value !== 'always' && value !== 'never') {
    throw new Error("image_batch: auto_ocr must be one of 'auto', 'always', 'never'");
  }
  return value;
}

/**
 * Build the model-facing `image_batch` tool over one plugin context.
 *
 * Test seam: if `ctx.ocrImage` is provided it replaces core.ocrImage (lets the
 * test suite inject deterministic OCR results without real OCR engines).
 * @param ctx - the Cordis context providing `ctx.fs` and `ctx.emit`.
 * @returns the tool definition.
 */
export function createImageBatchTool(ctx) {
  return {
    name: 'image_batch',
    description: [
      'Batch-scale / context-validation tool: given a LIST of image paths, return one compact manifest (per-file type guess + whether it has text + a short scan/OCR excerpt + a recommendation) plus a whole-batch summary, so you can decide which images are worth deepening WITHOUT blindly calling image_scan / image_ocr / VLM on each one.',
      'Use it when many images arrive together and none have individual instructions — e.g. "these are all screenshots" or a folder dump. It first probes a few images with OCR: if the first few are text-dense it treats the whole batch as documents/screenshots and runs OCR on everything (auto_ocr=auto); otherwise it only OCRs the text-dense ones and triages the rest by pixel stats.',
      'Each item reports: index, basename, width x height, type (text/table/photo/chart/blank/unknown), has_text, ocr_excerpt (truncated), scan_preview (truncated) and a recommendation. The summary tells you total counts and which indices are worth deepening.',
      'scale control: previews and OCR excerpts are truncated and the whole manifest is soft-capped (~6k chars) so a large batch stays cheap; if truncated, the summary notes that DeepSeek can still call image_ocr / image_scan directly on specific indices. Invalid / missing files are recorded as errors, never a whole-batch failure.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_paths: {
          type: 'array',
          description: 'List of image paths to batch (each may be relative to the working directory).',
          items: { type: 'string' }
        },
        auto_ocr: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: "'auto' (default) = probe the first few images; if text-dense, run full OCR on all, else only on the text-dense ones. 'always' = OCR every image. 'never' = no OCR at all."
        },
        preview: {
          type: 'string',
          enum: ['scan', 'none'],
          description: "'scan' (default) = include a truncated image_scan overview per image; 'none' = skip scan previews (smaller output)."
        },
        max_files: {
          type: 'integer',
          description: 'Hard display cap on how many images to process in one call (default 50); pass more and the tool asks you to split into batches.'
        },
        probe_first: {
          type: 'integer',
          description: "For auto_ocr='auto': how many leading images to OCR just to decide whether the batch is text-dense (default 3)."
        },
        ocr_limit_chars: {
          type: 'integer',
          description: 'Max characters of OCR text to keep per image (default 800), to bound context growth.'
        }
      },
      required: ['file_paths']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          summary: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                index: { type: 'integer' },
                basename: { type: 'string' },
                path: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                type: { type: 'string' },
                has_text: { type: 'boolean' },
                ocr_excerpt: { type: 'string' },
                scan_preview: { type: 'string' },
                recommendation: { type: 'string' },
                note: { type: 'string' },
                error: { type: 'string' }
              },
              required: ['index', 'basename', 'type', 'recommendation']
            }
          },
          processed: { type: 'integer' },
          errors: { type: 'integer' }
        },
        required: ['summary', 'items', 'processed', 'errors']
      },
      render: (_args, value) => {
        const lines = [];
        lines.push(value.summary ?? `image_batch: processed=${value.processed}, errors=${value.errors}`);
        for (const item of value.items ?? []) {
          if (item.error !== undefined && item.error !== null) {
            lines.push(`  [!] ${item.index}. ${item.basename} — ERROR: ${item.error}`);
            continue;
          }
          let line = `[${item.index}] ${item.basename} ${item.width}x${item.height} type=${item.type}${item.has_text ? ' text=yes' : ''} | ${item.recommendation}`;
          if (item.note !== undefined && item.note !== null) lines.push(`  note: ${item.note}`);
          if (item.ocr_excerpt !== undefined && item.ocr_excerpt !== null && item.ocr_excerpt.length > 0) {
            line += `\n    ocr: ${item.ocr_excerpt}`;
          }
          if (item.scan_preview !== undefined && item.scan_preview !== null && item.scan_preview.length > 0) {
            line += `\n    scan: ${item.scan_preview}`;
          }
          lines.push(line);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('image_batch: cancelled');
      const rawPaths = args.file_paths;
      if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
        throw new Error('image_batch: file_paths must be a non-empty array of image paths');
      }
      const maxFiles = args.max_files === undefined ? DEFAULT_MAX_FILES : Number(args.max_files);
      if (!Number.isInteger(maxFiles) || maxFiles < 1) {
        throw new Error('image_batch: max_files must be a positive integer');
      }
      const paths = rawPaths.map((p) => String(p).trim()).filter((p) => p.length > 0);
      if (paths.length === 0) throw new Error('image_batch: file_paths contains no usable paths');
      if (paths.length > maxFiles) {
        throw new Error(
          `image_batch: ${paths.length} files exceeds max_files=${maxFiles} for one call — split the batch and call again (or raise max_files)`
        );
      }

      const autoOcr = parseAutoOcr(args.auto_ocr);
      const previewMode = args.preview === undefined ? 'scan' : String(args.preview);
      if (previewMode !== 'scan' && previewMode !== 'none') {
        throw new Error("image_batch: preview must be 'scan' or 'none'");
      }
      const probeFirst = args.probe_first === undefined ? DEFAULT_PROBE_FIRST : Number(args.probe_first);
      if (!Number.isInteger(probeFirst) || probeFirst < 0) {
        throw new Error('image_batch: probe_first must be a non-negative integer');
      }
      const ocrLimitChars = args.ocr_limit_chars === undefined ? DEFAULT_OCR_LIMIT_CHARS : Number(args.ocr_limit_chars);
      if (!Number.isInteger(ocrLimitChars) || ocrLimitChars < 0) {
        throw new Error('image_batch: ocr_limit_chars must be a non-negative integer');
      }
      const scanSize = DEFAULT_SCAN_SIZE;

      const core = await importCore();
      latestCore = core;
      // Test seam: ctx.ocrImage replaces the real OCR pipeline.
      const ocrFn = typeof ctx.ocrImage === 'function' ? ctx.ocrImage : core.ocrImage.bind(core);

      const cwd = exec.agent?.session?.header?.cwd;
      const items = [];
      let processed = 0;
      let errors = 0;
      const decoded = []; // { index, path, basename, width, height, data, ext, target, info }

      // ------------------------------------------------------------------
      // pass 1: decode each image (bad singles are recorded, not fatal)
      // ------------------------------------------------------------------
      for (let i = 0; i < paths.length; i += 1) {
        if (exec.signal?.aborted) throw new Error('image_batch: cancelled');
        const filePath = paths[i];
        const entry = {
          index: i,
          path: filePath,
          basename: filePath.split(/[\\/]/).pop() || filePath,
          type: 'unknown',
          has_text: false,
          recommendation: recommendFor('unknown')
        };
        try {
          const ext = extname(filePath).toLowerCase();
          if (core.UNSUPPORTED_EXTENSIONS.has(ext)) {
            throw new Error('WebP is not supported yet — convert to PNG or JPEG first');
          }
          if (!core.IMAGE_EXTENSIONS.has(ext)) {
            throw new Error(`unsupported image type "${ext}" (supported: PNG, JPEG, GIF, BMP)`);
          }
          const target = await ctx.fs.resolve(filePath, {
            ...(cwd !== undefined ? { cwd } : {}),
            signal: exec.signal
          });
          const info = await ctx.fs.stat(target, exec.signal);
          if (!info) throw new Error('file not found');
          if (info.type !== 'file') throw new Error('not a regular file');
          const data = await ctx.fs.readBytes(target, exec.signal, BYTE_CAP);
          const image = core.decodeImage(data, ext);
          if (image.width * image.height > MAX_PIXELS) {
            throw new Error(
              `${image.width}x${image.height} exceeds the ${MAX_PIXELS}-pixel decode limit — downscale or crop the file first`
            );
          }
          entry.width = image.width;
          entry.height = image.height;
          entry.path = target.displayPath;
          processed += 1;
          // `image` carries the decoded RGBA (for analyze/scan); `raw` keeps the
          // original file bytes (core.ocrImage decodes internally, so it wants bytes).
          decoded.push({ ...entry, image, raw: data, ext, info, target });
        } catch (error) {
          entry.type = 'unknown';
          entry.error = error.message;
          errors += 1;
          items.push(entry);
        }
      }

      if (decoded.length === 0) {
        const summary =
          `image_batch: processed=0, errors=${errors} — none of the ${paths.length} file(s) could be decoded. ` +
          'Check the paths/extensions (PNG/JPEG/GIF/BMP) and file existence.';
        return { summary, items, processed, errors };
      }

      // ------------------------------------------------------------------
      // pass 2: classify + (optionally) OCR each decoded image
      // ------------------------------------------------------------------
      // analysis cache keyed by index
      const analyses = new Map();
      const analyze = (item) => {
        if (!analyses.has(item.index)) {
          analyses.set(
            item.index,
            core.analyzeImage(item.image.data, item.image.width, item.image.height, {
              size: scanSize,
              mode: 'auto',
              region: undefined,
              palette: 'auto',
              pxPerCell: undefined
            })
          );
        }
        return analyses.get(item.index);
      };

      // --- decide whether to run full OCR ---
      let fullOcr = false;
      let ocrReason = null;
      const results = new Map(); // index -> { lines, note }
      const runOcr = async (item) => {
        try {
          // Engine default follows the plugin setting ("windows" when unset).
          const engine = getRuntimeConfig().ocr?.engine ?? 'windows';
          const res = await ocrFn(item.raw, item.ext, { engine });
          results.set(item.index, { lines: res?.lines ?? [] });
          return results.get(item.index);
        } catch (error) {
          results.set(item.index, { lines: [], note: `OCR failed (${error.message.slice(0, 120)})` });
          return results.get(item.index);
        }
      };

      if (autoOcr === 'always') {
        fullOcr = true;
        ocrReason = "auto_ocr='always'";
      } else if (autoOcr === 'never') {
        fullOcr = false;
        ocrReason = "auto_ocr='never' — no OCR run";
      } else {
        // 'auto': probe the first `probeFirst` decoded images
        const probeCount = Math.min(probeFirst, decoded.length);
        let textDenseProbe = 0;
        for (let p = 0; p < probeCount; p += 1) {
          if (exec.signal?.aborted) throw new Error('image_batch: cancelled');
          const probeItem = decoded[p];
          const res = await runOcr(probeItem);
          if (nonEmptyLines(res) >= 2) textDenseProbe += 1;
        }
        if (textDenseProbe > 0) {
          // first few are text -> treat the whole batch as documents
          fullOcr = true;
          ocrReason = `probed first ${probeCount}; ${textDenseProbe} are text-dense -> treated the batch as documents and ran OCR on everything`;
        } else {
          fullOcr = false;
          ocrReason = `probed first ${probeCount}; none text-dense -> no full OCR (only individual text-dense images)`;
        }
      }

      // --- per-item type + excerpts ---
      for (const src of decoded) {
        if (exec.signal?.aborted) throw new Error('image_batch: cancelled');
        const analysis = analyze(src);
        const structureHasHStripes = hasHorizontalStripes(analysis);

        // determine OCR for this item
        let ocrLines = 0;
        let ocrText = '';
        let note = src.note;
        if (autoOcr === 'never') {
          ocrLines = 0;
        } else if (fullOcr) {
          let res = results.get(src.index);
          if (res === undefined) res = await runOcr(src);
          ocrLines = nonEmptyLines(res);
          ocrText = (res?.lines ?? []).map((l) => l.text).filter(Boolean).join(' ');
          if (res?.note) note = note ? `${note}; ${res.note}` : res.note;
        } else {
          // not full OCR: run OCR on this image to see if IT is text-dense
          let res = results.get(src.index);
          if (res === undefined) res = await runOcr(src);
          ocrLines = nonEmptyLines(res);
          if (ocrLines >= 2) {
            ocrText = (res?.lines ?? []).map((l) => l.text).filter(Boolean).join(' ');
          }
          if (res?.note) note = note ? `${note}; ${res.note}` : res.note;
        }

        const type = classifyType(analysis, ocrLines, structureHasHStripes);
        const hasText = ocrLines >= 2;
        let item = {
          index: src.index,
          path: src.path,
          basename: src.basename,
          width: src.width,
          height: src.height,
          type,
          has_text: hasText,
          recommendation: recommendFor(type),
          ...(note !== undefined ? { note } : {})
        };
        if (ocrText.length > 0) {
          item.ocr_excerpt = ocrText.length > ocrLimitChars ? `${ocrText.slice(0, ocrLimitChars)}…` : ocrText;
        }
        if (previewMode === 'scan') {
          const rendered = core.renderImageScan({ path: src.path, width: src.width, height: src.height, region: 'full', ...analysis });
          item.scan_preview = truncateScan(rendered);
        }
        ctx.emit('fs/observed', src.target, { kind: 'present', version: src.info.version }, exec);
        items.push(item);
      }

      // ------------------------------------------------------------------
      // summary
      // ------------------------------------------------------------------
      const okItems = items.filter((it) => it.error === undefined || it.error === null);
      const textCount = okItems.filter((it) => it.type === 'text' || it.type === 'table').length;
      const photoCount = okItems.filter((it) => it.type === 'photo').length;
      const blankCount = okItems.filter((it) => it.type === 'blank').length;
      const scanCount = okItems.filter((it) => it.has_text).length;

      const bigText = okItems
        .filter((it) => it.type === 'text' || it.type === 'table')
        .map((it) => it.index);
      const bigPhoto = okItems.filter((it) => it.type === 'photo').map((it) => it.index);

      let summary =
        `image_batch: ${processed} decoded / ${errors} error(s) out of ${paths.length} path(s). ` +
        `Types: ${textCount} text/table, ${photoCount} photo, ${blankCount} blank (rest mixed/unknown). ` +
        `${scanCount} image(s) contain text. ` +
        (fullOcr
          ? `Full OCR was run on the whole batch (${ocrReason}).`
          : `Full OCR was NOT run — ${ocrReason}.`) +
        ` Next step: ${bigPhoto.length > 0 ? `likely-photo indices worth a VLM look: ${bigPhoto.join(', ')}; ` : ''}` +
        `read the text-dense ones (${bigText.length > 0 ? bigText.join(', ') : 'none'}) with image_ocr and scan the chart/table indices (image_scan+image_sample); skip the blank ones.`;

      // soft output cap: if too big, tell the model to go one-by-one
      const renderedTotal = JSON.stringify({ summary, items, processed, errors }).length;
      if (renderedTotal > SOFT_OUTPUT_LIMIT) {
        summary +=
          ' [TRUNCATED] The full manifest is large — instead of relying on these truncated excerpts, call image_ocr / image_scan directly on the specific indices above.';
      }

      return { summary, items, processed, errors };
    }
  };
}

/** Truncate a scan render to a compact width/lines budget. */
function truncateScan(rendered) {
  const cut = 900;
  if (rendered.length <= cut) return rendered;
  const lines = rendered.split('\n');
  const kept = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length > cut) break;
    kept.push(line);
    total += line.length + 1;
  }
  const text = kept.join('\n');
  return text.length < rendered.length ? `${text}\n… (scan preview truncated)` : text;
}
