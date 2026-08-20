/**
 * picturereader — document_to_image tool.
 *
 * Converts a local Office/PDF document into a list of per-page PNG paths so a
 * text-only model can then analyze them with the existing image_scan /
 * image_ocr / image_sample / vision_analyze tools. Purely local (no network).
 *
 * Supported inputs: .pdf / .docx / .doc / .xlsx / .xls / .pptx / .ppt
 *
 * Conversion chain (runs in the isolated doc_venv Python via scripts/
 * doc-to-image.py so the timeouts / page caps / LibreOffice handling stay in
 * one reusable place):
 *
 *   .pdf  ──────────────►  PyMuPDF(fitz) render each page to PNG
 *   office  ──LibreOffice──► PDF ──fitz──► PNG
 *            (soffice --headless --convert-to pdf, independent profile)
 *
 * Environment requirements (checked at runtime, with clear messages instead
 * of crashes):
 *   - doc_venv at `C:\Users\Administrator\doc_venv\Scripts\python.exe` with
 *     pymupdf installed  → else hint "run node scripts/setup-doc-venv.mjs".
 *   - LibreOffice soffice.exe  → read from `DSH_SOFFICE` env, default
 *     `C:/Program Files/LibreOffice/program/soffice.exe` (glob-fallback for
 *     case). Missing → hint to install LibreOffice / set DSH_SOFFICE.
 *
 * @module picturereader/doc-tools
 */

import { extname, join, basename as pathBasename, resolve as pathResolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Absolute path to scripts/doc-to-image.py (this module lives in src/). */
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'doc-to-image.py');

/** The isolated venv python used to run the conversion chain (env overridable). */
const DOC_VENV_PY = process.env.DSH_DOC_PYTHON ?? 'C:\\Users\\Administrator\\doc_venv\\Scripts\\python.exe';

/** Hard cap on how many bytes we read into memory per input document. */
const MAX_INPUT_BYTES = 512 * 1024 * 1024; // 512 MB

const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']);

/** Validate an integer in [min, max], throwing a tool-prefixed error. */
function parseBoundedInt(raw, fallback, min, max, label) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`document_to_image: ${label} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('document_to_image: cancelled');
}

/** Resolve a writable out_dir: explicit path, or a temp dir under the OS tmp. */
function resolveOutDir(raw, fingerprint, cwd) {
  if (raw !== undefined && raw !== null && String(raw).trim().length > 0) {
    const p = String(raw).trim();
    // Resolve relative paths against the session cwd like other tools.
    return cwd ? pathResolve(cwd, p) : pathResolve(p);
  }
  const stamp = fingerprint && fingerprint !== 'anon' ? fingerprint : 'anon';
  return join(tmpdir(), 'picturereader-doc', stamp, `${Date.now()}-${randomBytes(4).toString('hex')}`);
}

/**
 * Run the doc-to-image.py conversion for a single document that has already
 * been materialized at a real local path. Returns the parsed JSON summary.
 */
function runDocPython(inputPath, outDir, prefix, dpi, maxPages, timeoutMs, signal) {
  throwIfAborted(signal);
  const args = [SCRIPT_PATH, inputPath, outDir, prefix, String(dpi), String(maxPages)];
  const res = spawnSync(DOC_VENV_PY, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  if (res.error) {
    if (res.error.code === 'ABORT_ERR' || signal?.aborted) {
      throw new Error('document_to_image: cancelled');
    }
    if (res.error.code === 'ENOENT') {
      throw new Error(
        `document_to_image: 转换所需的 Python 环境缺失。请先运行 \`node scripts/setup-doc-venv.mjs\` 创建 doc_venv（位于 ${DOC_VENV_PY}）。`
      );
    }
    if (res.error.code === 'ETIMEDOUT') {
      throw new Error('document_to_image: 转换超时（>120s），请检查文档是否损坏、过大，或降低 max_pages / dpi。');
    }
    throw new Error(`document_to_image: 调用转换脚本失败: ${res.error.message}`);
  }
  if (res.signal && res.signal === 'SIGTERM' && signal?.aborted) {
    throw new Error('document_to_image: cancelled');
  }
  if (res.signal || res.status === null) {
    throw new Error('document_to_image: 转换进程被终止（超时或中断）');
  }
  if (res.status !== 0 || !res.stdout) {
    // 失败或空输出：脚本以非零状态退出，stderr/stdout 里有 JSON error。
    const body = (res.stderr || res.stdout || '').trim();
    let msg = body;
    try {
      const parsed = JSON.parse(body.split('\n')[0]);
      if (parsed && parsed.error) msg = parsed.error;
    } catch { /* body is raw text */ }
    throw new Error(`document_to_image: 转换失败: ${msg || `退出码 ${res.status}`}`);
  }
  // 成功路径：解析最后一行 JSON（脚本只打印一行 JSON）。
  const line = res.stdout.trim().split('\n').filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch (e) {
    throw new Error(`document_to_image: 无法解析转换脚本输出: ${e.message}`);
  }
}

/**
 * Build the `document_to_image` tool.
 * @param ctx - the Cordis context providing `ctx.fs`.
 */
export function createDocumentToImageTool(ctx) {
  return {
    name: 'document_to_image',
    description: [
      'Convert a local Office/PDF document (pdf / docx / doc / xlsx / xls / pptx / ppt) into a list of per-page PNG image paths, ' +
        'so the pages can then be inspected with the existing image_scan / image_ocr / image_sample / vision_analyze tools. Purely local (no network).',
      'Parameters: file_path (required, a single document) — or file_paths (array) to convert several documents in one call; ' +
        'out_dir (optional, output directory; defaults to a temp dir under the system temp); ' +
        'dpi (optional 72..300, default 150 — higher = sharper but larger PNGs); ' +
        'max_pages (optional 1..500, default 50 — render only the first N pages of multi-page docs).',
      'Returns, per document: input (original name), page_count (total page count), ' +
        'pages: [{ index, path, width, height, bytes }], out_dir (where the PNGs live), and a summary.',
      'The PNGs remain on disk in out_dir so subsequent image_scan / image_ocr calls can read them by path.',
      'PDFs render directly with PyMuPDF; other Office formats are first converted to PDF via headless LibreOffice. ' +
        'Requires the doc_venv Python (pymupdf) and LibreOffice — if either is missing the tool returns a clear setup hint.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to a single document (pdf/docx/doc/xlsx/xls/pptx/ppt). Use either this or file_paths, not both.'
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of document paths to convert in one call (batch). Use either this or file_path, not both.'
        },
        out_dir: {
          type: 'string',
          description: 'Optional output directory for the generated PNGs. Defaults to a temp dir under the system temp.'
        },
        dpi: {
          type: 'integer',
          description: 'Render resolution in dots per inch (72..300, default 150).'
        },
        max_pages: {
          type: 'integer',
          description: 'Maximum number of pages to render (1..500, default 50). Pages beyond this are skipped (noted).'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          documents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                input: { type: 'string' },
                page_count: { type: 'integer' },
                rendered: { type: 'integer' },
                truncated: { type: 'boolean' },
                pages: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      index: { type: 'integer' },
                      path: { type: 'string' },
                      width: { type: 'integer' },
                      height: { type: 'integer' },
                      bytes: { type: 'integer' }
                    },
                    required: ['index', 'path', 'width', 'height', 'bytes']
                  }
                }
              },
              required: ['input', 'page_count', 'rendered', 'pages']
            }
          },
          out_dir: { type: 'string' },
          summary: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['documents', 'out_dir', 'summary']
      },
      render: (_args, value) => {
        const lines = [`documents converted to images (out_dir: ${value.out_dir})`];
        for (const d of value.documents || []) {
          lines.push(`  ${d.input}: ${d.rendered}/${d.page_count} page(s) rendered${d.truncated ? ' (truncated)' : ''}`);
          for (const p of d.pages || []) {
            lines.push(`    page ${p.index}: ${p.width}x${p.height}px, ${p.bytes} bytes → ${p.path}`);
          }
        }
        lines.push(value.summary || '');
        if (value.note) lines.push(value.note);
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      // ---- 参数收集与校验 ----
      const dpi = parseBoundedInt(args.dpi, 150, 72, 300, 'dpi');
      const maxPages = parseBoundedInt(args.max_pages, 50, 1, 500, 'max_pages');

      const fp = typeof args.file_path === 'string' ? args.file_path.trim() : '';
      const fps = Array.isArray(args.file_paths)
        ? args.file_paths.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
        : [];
      if (fp.length > 0 && fps.length > 0) {
        throw new Error('document_to_image: 请只传 file_path（单个）或 file_paths（批量），不要同时传两者。');
      }
      const targets = fp.length > 0 ? [fp] : fps;
      if (targets.length === 0) {
        throw new Error('document_to_image: 需要一个输入文件（file_path 或 file_paths）。');
      }

      const cwd = exec.agent?.session?.header?.cwd;
      const fingerprint = (exec.agent?.session?.id) || 'anon';
      const outDir = resolveOutDir(args.out_dir, fingerprint, cwd);

      // 预解析目标：解析路径、校验扩展名、读字节并落盘到临时目录（python 需真实本地路径）。
      const materialized = []; // { ext, localPath, displayPath }
      for (const rawPath of targets) {
        throwIfAborted(exec.signal);
        const target = await ctx.fs.resolve(rawPath, {
          ...(cwd !== undefined ? { cwd } : {}),
          signal: exec.signal
        });
        const display = target.displayPath;
        const ext = extname(display).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) {
          throw new Error(
            `document_to_image: 不支持的文件类型 "${ext}"（支持: pdf / docx / doc / xlsx / xls / pptx / ppt）: ${display}`
          );
        }
        const info = await ctx.fs.stat(target, exec.signal);
        if (!info) throw new Error(`document_to_image: 找不到文件: ${display}`);
        if (info.type !== 'file') throw new Error(`document_to_image: 不是普通文件: ${display}`);
        const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_INPUT_BYTES);
        // 落盘：临时目录 + 保留原扩展名（python 靠扩展名判断链路）。
        const tmpDir = mkdtempSync(join(tmpdir(), 'picturereader-src-'));
        const localPath = join(tmpDir, `${pathBasename(display) || 'doc'}${Date.now()}-${randomBytes(2).toString('hex')}${ext}`);
        writeFileSync(localPath, bytes);
        materialized.push({ ext, localPath, displayPath: display, tmpDir });
      }

      const documents = [];
      // 可注入 seam：测试可传 ctx._docRunner 替换真实 spawn（与 image-batch 的 ctx.ocrImage 注入一致）。
      const runner = (typeof ctx._docRunner === 'function') ? ctx._docRunner : runDocPython;
      try {
        for (let i = 0; i < materialized.length; i += 1) {
          throwIfAborted(exec.signal);
          const { ext, localPath, displayPath } = materialized[i];
          const prefix = `page_${i + 1}`; // 每文档一个独立前缀，批量时同 base 名互不覆盖
          const summary = runner(localPath, outDir, prefix, dpi, maxPages, 120_000, exec.signal);
          if (summary.error) {
            throw new Error(`document_to_image: ${summary.error}`);
          }
          documents.push({
            input: pathBasename(displayPath),
            page_count: summary.page_count ?? 0,
            rendered: (summary.pages || []).length,
            truncated: !!summary.truncated,
            pages: (summary.pages || []).map((p) => ({
              index: p.index,
              path: p.path,
              width: p.width,
              height: p.height,
              bytes: p.bytes
            }))
          });
        }
      } finally {
        // 清理源文件的临时落盘（PNG 输出保留在 out_dir 供后续工具读）。
        for (const m of materialized) {
          try {
            rmSync(m.tmpDir, { recursive: true, force: true });
          } catch { /* best effort */ }
        }
      }

      const totalPages = documents.reduce((s, d) => s + d.rendered, 0);
      const truncatedAny = documents.some((d) => d.truncated);
      const summary =
        `转换完成：${documents.length} 个文档，共渲染 ${totalPages} 页 PNG，输出目录 ${outDir}。` +
        (truncatedAny ? ' 部分文档超过 max_pages 仅渲染前 N 页，如需更多页请分批（提高 max_pages 或缩小 dpi）。' : '');

      return {
        documents,
        out_dir: outDir,
        summary,
        note: '每页 PNG 可直接用 image_scan / image_ocr / image_sample / vision_analyze 按 pages[].path 分析。'
      };
    }
  };
}

// 注册工厂，与 more-tools.js 的 registerMoreTools 风格一致（主会话按需调用）。
export function registerDocTools(ctx) {
  ctx.tools.register(createDocumentToImageTool(ctx));
}
