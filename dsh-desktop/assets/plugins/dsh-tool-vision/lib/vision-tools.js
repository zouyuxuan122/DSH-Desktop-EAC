// dsh-tool-vision — pixel-level vision tools (ported from dsh-vision-router).
//
// The 14 vision_* tools share ONE configured OpenAI-compatible endpoint
// (the plugin's own baseURL/apiKey/model settings — the same GLM endpoint
// inspect_image uses). No provider chain, no local models, no fallbacks:
// the router's tool *semantics* (prompts, parameter contracts, pixel
// post-processing) are kept; its routing/resilience machinery is not.
//
// Everything here is unit-testable without a harness: the only injected
// dependencies are `ctx` (attachments/fs services), `getConfig` (live
// settings) and `exec` (tool execution context).

import { createHash } from 'node:crypto'
import { join, dirname, isAbsolute, relative as relativePath, sep, win32 as winPath } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir as mkdirP, writeFile as writeFileP, readFile as readFileP, rm as rmP, stat as statP } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// ── image formats ──────────────────────────────────────────────────────────

export const IMAGE_EXTENSIONS = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

const EXT_BY_MEDIA = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
}

export function mediaTypeOf(path) {
  const match = String(path).toLowerCase().match(/\.([a-z0-9]+)$/)
  return match ? IMAGE_EXTENSIONS[match[1]] : undefined
}

/**
 * Detect the image format from magic bytes instead of the file extension.
 * Attachments are stored as content-addressed files WITHOUT an extension,
 * so extension-based detection rejects them; the pixel tools must sniff.
 */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  const head = (offset, count) => {
    const parts = []
    for (let i = offset; i < offset + count; i++) parts.push(bytes[i].toString(16).padStart(2, '0'))
    return parts.join('')
  }
  if (head(0, 8) === '89504e470d0a1a0a') return 'image/png'
  if (head(0, 3) === 'ffd8ff') return 'image/jpeg'
  const riff = head(0, 4)
  const webp = head(8, 4)
  if (riff === '52494646' && webp === '57454250') return 'image/webp'
  if (riff === '47494638') return 'image/gif' // GIF87a / GIF89a
  return undefined
}

// ── input resolution ───────────────────────────────────────────────────────

export function basenameOf(path) {
  const parts = String(path).split('/')
  return parts[parts.length - 1] || undefined
}

/**
 * True when the string is a durable attachment id such as "sha256:<hex>" —
 * the form the harness uses for uploaded images.
 */
export function isAttachmentIdInput(input) {
  return typeof input === 'string' && /^[a-z0-9]+:[0-9a-f]{32,}$/i.test(input.trim())
}

/** Cross-platform absolute-path test (posix drive-relative forms included). */
export function isAbsolutePath(input) {
  const value = String(input ?? '')
  return isAbsolute(value) || winPath.isAbsolute(value)
}

/** Largest local image accepted by the pixel tools, in bytes. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Resolve one tool argument (local path or attachment id) to image bytes. */
export async function readImageBytes(ctx, exec, imagePath) {
  const input = String(imagePath ?? '')
  let bytes
  let storedMediaType
  if (isAttachmentIdInput(input)) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('tool-vision: the attachment service is not available in this deployment')
    }
    const session = exec && exec.agent && exec.agent.session
    const ref = lookupAttachment(session, input.trim())
    if (ref === undefined) {
      throw new Error(
        `tool-vision: unknown attachment id "${input}" (it must come from an image uploaded in this conversation)`,
      )
    }
    let stored
    try {
      stored = await attachments.readImage(ref)
    } catch (error) {
      throw new Error(
        `tool-vision: failed to read attachment ${input} (${error && error.message ? error.message : String(error)})`,
      )
    }
    bytes = stored.data
    if (bytes && bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `tool-vision: image too large: ${input} (${bytes.length} bytes, limit ${MAX_IMAGE_BYTES})`,
      )
    }
    if (stored.ref && typeof stored.ref.mediaType === 'string') {
      storedMediaType = stored.ref.mediaType
    }
  } else {
    const fsService = ctx.get('fs')
    if (fsService === undefined) throw new Error('tool-vision: the fs service is not available')
    const resolved = await fsService.resolve(input)
    const target = toRealPath(fsService, resolved)
    // Second line of defense beyond the fs sandbox: a relative input must
    // resolve inside the session workspace (refuse ../ escapes).
    if (!isAbsolutePath(input)) {
      const root = workspaceOf(exec)
      const relative = relativePath(root, target)
      if (relative === '..' || relative.startsWith('..' + sep) || isAbsolutePath(relative)) {
        throw new Error(`tool-vision: path escapes the workspace: ${input}`)
      }
    }
    // Pre-check size BEFORE reading: a huge file must not be buffered whole
    // (readFileP has no limit and would OOM the process).
    const info = await statP(target).catch(() => null)
    if (info !== null && info.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `tool-vision: image too large: ${input} (${info.size} bytes, limit ${MAX_IMAGE_BYTES})`,
      )
    }
    bytes = await readFileP(target)
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`tool-vision: image too large: ${input} (${bytes.length} bytes, limit ${MAX_IMAGE_BYTES})`)
    }
  }
  const mediaType = sniffMediaType(bytes) ?? storedMediaType ?? mediaTypeOf(input)
  if (mediaType === undefined) {
    throw new Error(`unsupported image format ${input} (png/jpeg/webp/gif only)`)
  }
  return { bytes, mediaType }
}

/** Find an uploaded attachment ref in the session's recorded upload index. */
export function lookupAttachment(session, attachmentId) {
  if (!session) return undefined
  const recorded = session.recordedUploads
  if (recorded) {
    const ref = recorded.get ? recorded.get(attachmentId) : undefined
    if (ref) return ref
  }
  const events = session.events ?? []
  for (const event of events) {
    const data = event && event.data
    if (!data) continue
    for (const block of Array.isArray(data.content) ? data.content : []) {
      if (block && block.type === 'image' && block.attachment && block.attachment.attachmentId === attachmentId) {
        return block.attachment
      }
    }
    const message = data.message
    if (message && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && block.type === 'image' && block.attachment && block.attachment.attachmentId === attachmentId) {
          return block.attachment
        }
      }
    }
  }
  return undefined
}

/** Normalize an fs.resolve() result (string or { targetKey, displayPath }) to a real path. */
export function toRealPath(fsService, resolved) {
  if (typeof resolved === 'string') return resolved
  if (typeof fsService?.processPath === 'function') {
    const p = fsService.processPath(resolved)
    if (typeof p === 'string' && p !== '') return p
  }
  const key = resolved?.targetKey
  return typeof key === 'string' && key !== '' ? key : String(resolved ?? '')
}

// ── sharp (lazy) ───────────────────────────────────────────────────────────

let sharpPromise = null

/** Lazily load sharp; resolves null when the host cannot provide it. */
export function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((mod) => mod.default ?? mod)
      .catch(() => null)
  }
  return sharpPromise
}

/**
 * Downscale an image so its pixel count stays within maxPixels (router
 * default 4MP). Returns the original buffer when the image is already small
 * enough or when sharp is unavailable — pixel tools degrade gracefully
 * instead of failing.
 */
export async function downscaleImage(bytes, maxPixels) {
  if (!bytes || bytes.length === 0) return bytes
  const sharp = await loadSharp()
  if (!sharp) return bytes
  try {
    const image = sharp(bytes, { failOn: 'none' })
    const meta = await image.metadata()
    const width = Number(meta.width) || 0
    const height = Number(meta.height) || 0
    if (width <= 0 || height <= 0 || width * height <= maxPixels) return bytes
    const scale = Math.sqrt(maxPixels / (width * height))
    const resized = await image
      .resize({
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
        fit: 'inside',
      })
      .toBuffer()
    return resized && resized.length > 0 ? resized : bytes
  } catch {
    return bytes
  }
}

/** Image dimensions via sharp (0/0 when unavailable). */
export async function imageDims(bytes) {
  const sharp = await loadSharp()
  if (!sharp) return { width: 0, height: 0 }
  try {
    const meta = await sharp(bytes, { failOn: 'none' }).metadata()
    return { width: meta.width ?? 0, height: meta.height ?? 0 }
  } catch {
    return { width: 0, height: 0 }
  }
}

// ── content-hash cache ─────────────────────────────────────────────────────

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Small LRU+TTL cache for repeated image+question calls (router semantics). */
export function createCache(maxEntries, ttlMs) {
  const map = new Map()
  return {
    get(key) {
      const entry = map.get(key)
      if (!entry) return undefined
      if (entry.expires <= Date.now()) {
        map.delete(key)
        return undefined
      }
      map.delete(key)
      map.set(key, entry)
      return entry.value
    },
    set(key, value) {
      if (map.size >= maxEntries) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
      map.set(key, { value, expires: Date.now() + ttlMs })
    },
    size() {
      return map.size
    },
    clear() {
      map.clear()
    },
  }
}

// ── artifacts (tool outputs land in the session workspace) ─────────────────

export function workspaceOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  const cwd = session && session.header && session.header.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** Write a tool artifact under <workspace>/.dsh-tool-vision/ and return its path.
 *  Recursive: long-OCR writes stem/chunk-*.png subdirectories. */
export async function writeArtifact(exec, relPath, data) {
  const root = workspaceOf(exec)
  const target = join(root, '.dsh-tool-vision', relPath)
  await mkdirP(dirname(target), { recursive: true })
  await writeFileP(target, data)
  return target
}

/** Build an artifact filename stem from an input image reference. */
export function artifactStemOf(imagePath, suffix) {
  const base = String(basenameOf(imagePath) ?? 'image')
    .replace(/\.(png|jpe?g|webp|gif)$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 32)
  const fingerprint = createHash('sha256').update(String(imagePath)).digest('hex').slice(0, 8)
  return `${base || 'image'}-${fingerprint}-${suffix}`
}

// ── JSON & prompt helpers ──────────────────────────────────────────────────

const MAX_EXTRACT_JSON_CHARS = 200_000

/** Extract the first balanced JSON value ({...} or [...]) from model output. */
export function extractJson(text) {
  const source = String(text ?? '')
  const bounded = source.length > MAX_EXTRACT_JSON_CHARS
    ? source.slice(0, MAX_EXTRACT_JSON_CHARS)
    : source
  const fenced = bounded.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : bounded
  const start = candidate.search(/[[{]/)
  if (start === -1) return undefined
  const stack = []
  let inString = false
  let escaped = false
  for (let index = start; index < candidate.length; index++) {
    const char = candidate[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      if (stack.length === 0 || stack.pop() !== char) return undefined
      if (stack.length === 0) {
        try {
          const value = JSON.parse(candidate.slice(start, index + 1))
          return typeof value === 'object' && value !== null ? value : undefined
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** Legacy alias for callers of the earlier draft API. */
export function parseModelJson(text) {
  return extractJson(text)
}

/** Parse "x1,y1,x2,y2" (string) or {x1,y1,x2,y2} (object) into a valid pixel box. */
export function parseBox(value) {
  let box
  if (typeof value === 'string') {
    const parts = value.split(',').map((part) => Number(part.trim()))
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined
    box = { x1: parts[0], y1: parts[1], x2: parts[2], y2: parts[3] }
  } else if (value && typeof value === 'object') {
    box = { x1: value.x1, y1: value.y1, x2: value.x2, y2: value.y2 }
  } else {
    return undefined
  }
  const { x1, y1, x2, y2 } = box
  if (![x1, y1, x2, y2].every((n) => Number.isInteger(n))) return undefined
  if (x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1) return undefined
  return { x1, y1, x2, y2 }
}

/** Fixed JSON contract for vision_detect. */
export function visionDetectInstruction(target, width, height) {
  return (
    `The image is ${width}x${height} pixels. Find every "${String(target).slice(0, 300)}" in it. ` +
    'Return ONE JSON object and nothing else, shaped EXACTLY as:\n' +
    '{"elements":[{"label":"<short element name>","box":{"x1":0,"y1":0,"x2":0,"y2":0}},...]}\n' +
    '- "elements" is a numbered list (array order = element number) of every match, from top-left to bottom-right in reading order;\n' +
    '- every box is the tight bounding box in ORIGINAL image pixels, integers, 0 <= x1 < x2 <= ' +
    `${width}, 0 <= y1 < y2 <= ${height}` +
    ';\n- if nothing matches, return {"elements":[]}.'
  )
}

/** Structured JSON contract for vision_describe's json:true mode. */
export function describeStructuredInstruction(question) {
  return (
    `Look at the image and answer the question: 「${String(question).slice(0, 1500)}」. ` +
    'Return ONE JSON object and nothing else, shaped EXACTLY as:\n' +
    '{"summary":"<1-2 sentence answer to the question>",' +
    '"layout":[{"region":"<e.g. top-left / header / center>","content":"<what is there>"}],' +
    '"entities":[{"type":"<button|input|text|image|link|icon|other>","label":"<name or text>"}],' +
    '"text":"<the full text visible in the image, transcribed in reading order, as faithful as possible>"}\n' +
    '- "layout" lists the main regions in reading order (top-to-bottom, left-to-right);\n' +
    '- "entities" lists notable elements; use only the listed type values;\n' +
    '- "text" is the verbatim transcription; write "" when the image contains no text.'
  )
}

/** Shared vision_describe prompt. */
export function visionDescribePrompt(question, wantJson = false) {
  const raw = String(question ?? '').trim()
  const text = raw === ''
    ? 'Describe the image accurately and answer based only on visible content.'
    : raw
  return wantJson ? text + '\n\n' + describeStructuredInstruction(text) : text
}

/** Normalize a vision_detect answer into the canonical shape, clamping boxes. */
export function normalizeDetectResult(parsed, width, height) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.elements)) return undefined
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max))
  const elements = []
  for (const item of parsed.elements) {
    if (!item || typeof item !== 'object' || !item.box || typeof item.box !== 'object') continue
    const x1 = Math.round(Number(item.box.x1))
    const y1 = Math.round(Number(item.box.y1))
    const x2 = Math.round(Number(item.box.x2))
    const y2 = Math.round(Number(item.box.y2))
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue
    const box = {
      x1: clamp(x1, 0, width - 1),
      y1: clamp(y1, 0, height - 1),
      x2: clamp(x2, 1, width),
      y2: clamp(y2, 1, height),
    }
    if (box.x2 <= box.x1 || box.y2 <= box.y1) continue
    elements.push({
      number: elements.length + 1,
      label: typeof item.label === 'string' && item.label.trim() !== '' ? item.label.trim() : `element ${elements.length + 1}`,
      box,
    })
  }
  return { width, height, elements }
}

/** Normalize a structured vision_describe answer with defaults for missing fields. */
export function normalizeDescribeResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const layout = Array.isArray(parsed.layout) ? parsed.layout.filter((r) => r && typeof r === 'object' && typeof r.region === 'string' && typeof r.content === 'string') : []
  const entities = Array.isArray(parsed.entities)
    ? parsed.entities
        .filter((e) => e && typeof e === 'object' && typeof e.type === 'string' && typeof e.label === 'string')
        .map((e) => ({ type: e.type, label: e.label }))
    : []
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    layout,
    entities,
    text: typeof parsed.text === 'string' ? parsed.text : '',
  }
}

// ── pixel operations ───────────────────────────────────────────────────────

/** Per-pixel RGBA comparison; returns ratio, mask and worst 8x8 cells. */
export function computePixelDiff(bufferA, bufferB, threshold = 16, width = 0, height = 0) {
  const length = Math.min(bufferA.length, bufferB.length)
  const pixels = Math.floor(length / 4)
  let differing = 0
  const mask = new Uint8Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    const d =
      Math.max(
        Math.abs(bufferA[o] - bufferB[o]),
        Math.abs(bufferA[o + 1] - bufferB[o + 1]),
        Math.abs(bufferA[o + 2] - bufferB[o + 2]),
      ) - threshold
    if (d > 0) {
      differing += 1
      mask[i] = 1
    }
  }
  const ratio = pixels === 0 ? 0 : differing / pixels
  const cells = []
  if (width > 0 && height > 0) {
    const cols = 8
    const rows = 8
    const cw = Math.ceil(width / cols)
    const ch = Math.ceil(height / rows)
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let hit = 0
        let total = 0
        for (let y = cy * ch; y < Math.min((cy + 1) * ch, height); y++) {
          for (let x = cx * cw; x < Math.min((cx + 1) * cw, width); x++) {
            total += 1
            if (mask[y * width + x]) hit += 1
          }
        }
        if (total > 0 && hit > 0) {
          cells.push({
            x1: cx * cw,
            y1: cy * ch,
            x2: Math.min((cx + 1) * cw, width),
            y2: Math.min((cy + 1) * ch, height),
            ratio: hit / total,
            differing: hit,
            total,
          })
        }
      }
    }
    cells.sort((a, b) => b.ratio - a.ratio)
  }
  return { differing, total: pixels, ratio, mask, cells }
}

function asBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  return Buffer.from(chunk ?? [])
}

class AsyncByteReader {
  constructor(iterable) {
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('pixel diff stream must be async iterable')
    }
    this.iterator = iterable[Symbol.asyncIterator]()
    this.buffer = Buffer.alloc(0)
    this.done = false
  }

  async fill(minBytes) {
    while (!this.done && this.buffer.length < minBytes) {
      const next = await this.iterator.next()
      if (next.done) {
        this.done = true
        break
      }
      const chunk = asBuffer(next.value)
      if (chunk.length === 0) continue
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    }
  }

  consume(bytes) {
    const out = this.buffer.subarray(0, bytes)
    this.buffer = this.buffer.subarray(bytes)
    return out
  }
}

function cellBounds(index, width, height, cols, rows) {
  const cx = index % cols
  const cy = Math.floor(index / cols)
  const cw = Math.ceil(width / cols)
  const ch = Math.ceil(height / rows)
  const x1 = cx * cw
  const y1 = cy * ch
  const x2 = Math.min((cx + 1) * cw, width)
  const y2 = Math.min((cy + 1) * ch, height)
  return { x1, y1, x2, y2, total: Math.max(0, x2 - x1) * Math.max(0, y2 - y1) }
}

/**
 * Exact RGB pixel comparison over two RGBA async streams. The function never
 * materializes either full frame; it holds only the current upstream chunks
 * plus a bounded region counter grid.
 */
export async function compareRgbaStreams(
  streamA,
  streamB,
  { width, height, threshold = 16, cols = 8, rows = 8 } = {},
) {
  const w = Math.max(1, Math.floor(Number(width) || 1))
  const h = Math.max(1, Math.floor(Number(height) || 1))
  const limit = w * h
  const gate = Number.isFinite(Number(threshold)) && Number(threshold) >= 0
    ? Number(threshold)
    : 16
  const gridCols = Math.min(w, Math.max(1, Math.floor(Number(cols) || 8)))
  const gridRows = Math.min(h, Math.max(1, Math.floor(Number(rows) || 8)))
  const cellDiff = new Uint32Array(gridCols * gridRows)
  const readerA = new AsyncByteReader(streamA)
  const readerB = new AsyncByteReader(streamB)
  let pixels = 0
  let differing = 0

  while (pixels < limit) {
    await Promise.all([readerA.fill(4), readerB.fill(4)])
    if (readerA.buffer.length < 4 || readerB.buffer.length < 4) break
    const remainingBytes = (limit - pixels) * 4
    const usable = Math.min(
      remainingBytes,
      Math.floor(Math.min(readerA.buffer.length, readerB.buffer.length) / 4) * 4,
    )
    if (usable <= 0) break
    const a = readerA.consume(usable)
    const b = readerB.consume(usable)
    const chunkPixels = usable / 4
    for (let i = 0; i < chunkPixels; i++) {
      const o = i * 4
      const different =
        Math.max(
          Math.abs(a[o] - b[o]),
          Math.abs(a[o + 1] - b[o + 1]),
          Math.abs(a[o + 2] - b[o + 2]),
        ) > gate
      if (!different) continue
      differing += 1
      const absolute = pixels + i
      const x = absolute % w
      const y = Math.floor(absolute / w)
      const cx = Math.min(gridCols - 1, Math.floor((x * gridCols) / w))
      const cy = Math.min(gridRows - 1, Math.floor((y * gridRows) / h))
      cellDiff[cy * gridCols + cx] += 1
    }
    pixels += chunkPixels
  }

  if (pixels !== limit) {
    throw new Error(`pixel diff stream ended early (${pixels}/${limit} pixels)`)
  }
  await Promise.all([readerA.fill(1), readerB.fill(1)])
  if (readerA.buffer.length > 0 || readerB.buffer.length > 0) {
    throw new Error('pixel diff stream produced more RGBA bytes than the declared dimensions')
  }

  const cells = []
  for (let index = 0; index < cellDiff.length; index++) {
    const hit = cellDiff[index]
    if (hit === 0) continue
    const bounds = cellBounds(index, w, h, gridCols, gridRows)
    if (bounds.total <= 0) continue
    cells.push({
      x1: bounds.x1,
      y1: bounds.y1,
      x2: bounds.x2,
      y2: bounds.y2,
      ratio: hit / bounds.total,
      differing: hit,
      total: bounds.total,
    })
  }
  cells.sort((a, b) => b.ratio - a.ratio)
  return { differing, total: limit, ratio: limit === 0 ? 0 : differing / limit, mask: null, cells }
}

/** Render a diff heatmap: grayscale base, red where the mask marks a differing pixel. */
export function renderDiffHeatmap(originalRaw, mask, width, height) {  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const gray = Math.round(
      0.299 * originalRaw[o] + 0.587 * originalRaw[o + 1] + 0.114 * originalRaw[o + 2],
    )
    if (mask[i]) {
      out[o] = 255
      out[o + 1] = 0
      out[o + 2] = 0
      out[o + 3] = 255
    } else {
      out[o] = gray
      out[o + 1] = gray
      out[o + 2] = gray
      out[o + 3] = 255
    }
  }
  return out
}

/** Dominant colors via bin quantization of an RGBA raw buffer. */
export function quantizeColors(raw, topN = 8, bins = 32) {
  const step = 256 / bins
  const counts = new Map()
  const pixels = Math.floor(raw.length / 4)
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    if (raw[o + 3] < 128) continue
    const r = Math.floor(raw[o] / step) * step
    const g = Math.floor(raw[o + 1] / step) * step
    const b = Math.floor(raw[o + 2] / step) * step
    const key = `${r},${g},${b}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, count]) => {
      const [r, g, b] = key.split(',').map(Number)
      const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
      return { hex, count, share: pixels === 0 ? 0 : count / pixels }
    })
}

/** SVG overlay string drawing one red pixel box on a width x height canvas. */
export function boxToSvg(box, width, height) {
  return Buffer.from(
    `<svg width="${width}" height="${height}">` +
      `<rect x="${box.x1}" y="${box.y1}" width="${box.x2 - box.x1}" height="${box.y2 - box.y1}" ` +
      `fill="none" stroke="#ff2d55" stroke-width="${Math.max(2, Math.round(Math.max(width, height) / 400))}"/></svg>`,
  )
}

/** SVG overlay drawing numbered red boxes (detect inventory). */
export function boxesToSvg(boxes, width, height) {
  const stroke = Math.max(2, Math.round(Math.max(width, height) / 400))
  const labelR = Math.max(10, stroke * 4)
  const parts = [`<svg width="${width}" height="${height}">`]
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]
    parts.push(
      `<rect x="${box.x1}" y="${box.y1}" width="${box.x2 - box.x1}" height="${box.y2 - box.y1}" ` +
        `fill="none" stroke="#ff2d55" stroke-width="${stroke}"/>`,
    )
    const cx = Math.max(labelR, Math.min(box.x1, width - labelR))
    const cy = Math.max(labelR, Math.min(box.y1, height - labelR))
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${labelR}" fill="#ff2d55"/>` +
        `<text x="${cx}" y="${cy + labelR * 0.36}" text-anchor="middle" ` +
        `font-family="sans-serif" font-size="${Math.round(labelR * 1.2)}" fill="#ffffff" ` +
        `font-weight="bold">${i + 1}</text>`,
    )
  }
  parts.push('</svg>')
  return Buffer.from(parts.join(''))
}

export function scaledDimensions(width, height, maxPixels) {
  const w = Math.max(0, Math.floor(Number(width) || 0))
  const h = Math.max(0, Math.floor(Number(height) || 0))
  const limit = Math.max(1, Math.floor(Number(maxPixels) || 1))
  if (w <= 0 || h <= 0) return { width: w, height: h, scale: 1 }
  const pixels = w * h
  if (pixels <= limit) return { width: w, height: h, scale: 1 }
  const scale = Math.sqrt(limit / pixels)
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
    scale,
  }
}

export function scaleBox(box, fromWidth, fromHeight, toWidth, toHeight) {
  const sx = fromWidth > 0 ? toWidth / fromWidth : 1
  const sy = fromHeight > 0 ? toHeight / fromHeight : 1
  return {
    x1: Math.max(0, Math.round(box.x1 * sx)),
    y1: Math.max(0, Math.round(box.y1 * sy)),
    x2: Math.min(toWidth, Math.max(1, Math.round(box.x2 * sx))),
    y2: Math.min(toHeight, Math.max(1, Math.round(box.y2 * sy))),
  }
}

/** Draw one red pixel box onto an image buffer via sharp. */
export async function annotateBoxBuffer(bytes, box) {
  const sharp = await loadSharp()
  if (!sharp) return bytes
  const meta = await sharp(bytes, { failOn: 'none' }).metadata()
  const width = meta.width ?? box.x2
  const height = meta.height ?? box.y2
  const preview = scaledDimensions(width, height, 4_000_000)
  const displayBox = preview.scale === 1
    ? box
    : scaleBox(box, width, height, preview.width, preview.height)
  let image = sharp(bytes, { failOn: 'none' })
  if (preview.scale !== 1) image = image.resize(preview.width, preview.height, { fit: 'fill' })
  return image
    .composite([{ input: boxToSvg(displayBox, preview.width, preview.height), top: 0, left: 0 }])
    .png()
    .toBuffer()
}

/** Draw numbered boxes for a detected-element inventory onto an image buffer. */
export async function annotateBoxesBuffer(bytes, boxes) {
  const sharp = await loadSharp()
  if (!sharp) return bytes
  const meta = await sharp(bytes, { failOn: 'none' }).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (width <= 0 || height <= 0 || boxes.length === 0) return bytes
  const preview = scaledDimensions(width, height, 4_000_000)
  const displayBoxes = preview.scale === 1
    ? boxes
    : boxes.map((box) => scaleBox(box, width, height, preview.width, preview.height))
  let image = sharp(bytes, { failOn: 'none' })
  if (preview.scale !== 1) image = image.resize(preview.width, preview.height, { fit: 'fill' })
  return image
    .composite([{ input: boxesToSvg(displayBoxes, preview.width, preview.height), top: 0, left: 0 }])
    .png()
    .toBuffer()
}

/** Remove a solid-ish background via border flood fill; background becomes transparent. */
export function floodFillBackground(raw, width, height, tolerance = 40) {
  const total = width * height
  const out = Buffer.from(raw)
  const marked = new Uint8Array(total)
  let r = 0
  let g = 0
  let b = 0
  const corners = [0, width - 1, (height - 1) * width, total - 1]
  for (const c of corners) {
    const o = c * 4
    r += raw[o]
    g += raw[o + 1]
    b += raw[o + 2]
  }
  r /= 4
  g /= 4
  b /= 4
  const queue = []
  let head = 0
  const push = (x, y) => {
    const i = y * width + x
    if (marked[i]) return
    const o = i * 4
    const d = Math.max(Math.abs(raw[o] - r), Math.abs(raw[o + 1] - g), Math.abs(raw[o + 2] - b))
    if (d > tolerance) return
    marked[i] = 1
    queue.push(i)
  }
  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }
  while (head < queue.length) {
    const i = queue[head++]
    const x = i % width
    const y = (i - x) / width
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < height - 1) push(x, y + 1)
  }
  for (let i = 0; i < total; i++) {
    if (marked[i]) out[i * 4 + 3] = 0
  }
  return out
}

/** Cover a long/large image with bounded tiles in reading order. */
export function boundedOcrTiles(
  width,
  height,
  { chunkHeight = 1200, overlap = 120, maxTilePixels = 4_000_000 } = {},
) {
  const w = Math.max(1, Math.floor(Number(width) || 1))
  const h = Math.max(1, Math.floor(Number(height) || 1))
  const requestedHeight = Math.max(1, Math.min(h, Math.floor(Number(chunkHeight) || 1200)))
  const pixelLimit = Math.max(1, Math.floor(Number(maxTilePixels) || 4_000_000))
  const tileWidth = Math.min(w, Math.max(1, Math.floor(pixelLimit / requestedHeight)))
  const tileHeight = Math.min(requestedHeight, Math.max(1, Math.floor(pixelLimit / tileWidth)))
  const verticalOverlap = Math.min(
    Math.max(0, Math.floor(Number(overlap) || 0)),
    Math.max(0, Math.floor(tileHeight / 2)),
  )
  const verticalStep = Math.max(1, tileHeight - verticalOverlap)
  const tiles = []
  for (let top = 0; top < h; top += verticalStep) {
    const bottom = Math.min(h, top + tileHeight)
    for (let left = 0; left < w; left += tileWidth) {
      const right = Math.min(w, left + tileWidth)
      tiles.push({ left, right, top, bottom })
    }
    if (bottom >= h) break
  }
  return tiles
}

// ── potrace (worker-thread, hard timeout) ──────────────────────────────────

function runPotraceWorker(workerData, source, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let worker
    const finish = (error, svg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker?.terminate()
      if (error) reject(error)
      else resolve(svg)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void worker?.terminate()
      reject(
        new Error(
          'potrace timed out — the image is too large or too complex; crop it to the target region first',
        ),
      )
    }, timeoutMs)
    try {
      worker = new Worker(source, { eval: true, workerData })
      worker.once('message', (message) => {
        if (message && message.error) finish(new Error(message.error))
        else finish(undefined, message && message.svg)
      })
      worker.once('error', (error) => finish(error))
      worker.once('exit', (code) => {
        if (code !== 0 && !settled) finish(new Error(`potrace worker exited with code ${code}`))
      })
    } catch (error) {
      finish(error)
    }
  })
}

/** Vectorize an image buffer into an SVG string via potrace posterization. */
export function posterizeSvg(bytes, steps = 4, fillStrategy = 'dominant', timeoutMs = 60000) {
  const potraceUrl = pathToFileURL(createRequire(import.meta.url).resolve('potrace')).href
  const source = `
    import('node:worker_threads').then(({ parentPort, workerData }) => {
      import(workerData.potraceUrl).then((mod) => {
        const potrace = mod.default ?? mod
        potrace.posterize(Buffer.from(workerData.bytes), {
          steps: workerData.steps,
          fillStrategy: workerData.fillStrategy,
        }, (error, svg) => {
          parentPort.postMessage(error ? { error: String((error && error.message) || error) } : { svg })
        })
      }).catch((error) => {
        parentPort.postMessage({ error: String((error && error.message) || error) })
      })
    })
  `
  return runPotraceWorker({ potraceUrl, bytes, steps, fillStrategy }, source, timeoutMs)
}

/**
 * Color-preserving vectorization: quantize into the top colors, trace one
 * 1-bit mask per color with potrace, emit a colored SVG (one path per color).
 */
export function posterizeSvgColor(data, info, palette, timeoutMs = 60000) {
  const sharpUrl = pathToFileURL(createRequire(import.meta.url).resolve('sharp')).href
  const potraceUrl = pathToFileURL(createRequire(import.meta.url).resolve('potrace')).href
  const source = `
    import('node:worker_threads').then(({ parentPort, workerData }) => {
      Promise.all([import(workerData.sharpUrl), import(workerData.potraceUrl)]).then(([sharpMod, potraceMod]) => {
        const sharp = sharpMod.default ?? sharpMod
        const potrace = potraceMod.default ?? potraceMod
        const { width, height, palette } = workerData
        const raw = Buffer.from(workerData.raw)
        const hexRgb = (hex) => {
          const n = parseInt(hex.slice(1), 16)
          return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
        }
        const paletteRgb = palette.map((p) => hexRgb(p.hex))
        const pixels = width * height
        const masks = palette.map(() => Buffer.alloc(pixels))
        for (let p = 0; p < pixels; p++) {
          const o = p * 4
          if (raw[o + 3] < 128) continue
          let best = 0
          let bestD = Infinity
          for (let c = 0; c < paletteRgb.length; c++) {
            const dr = raw[o] - paletteRgb[c][0]
            const dg = raw[o + 1] - paletteRgb[c][1]
            const db = raw[o + 2] - paletteRgb[c][2]
            const d = dr * dr + dg * dg + db * db
            if (d < bestD) { bestD = d; best = c }
          }
          masks[best][p] = 1
        }
        const paths = []
        let pending = palette.length
        const maybeDone = () => {
          if (pending > 0) return
          const pathSvg = paths.map((p) => '<path fill="' + p.hex + '" d="' + p.d + '"/>').join('')
          parentPort.postMessage({
            ok: true,
            svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
              '" viewBox="0 0 ' + width + ' ' + height + '"><rect width="' + width + '" height="' + height +
              '" fill="#ffffff"/>' + pathSvg + '</svg>',
          })
        }
        if (pending === 0) { maybeDone(); return }
        palette.forEach((entry, index) => {
          const gray = Buffer.alloc(pixels)
          const mask = masks[index]
          for (let p = 0; p < pixels; p++) gray[p] = mask[p] ? 0 : 255
          sharp(gray, { raw: { width, height, channels: 1 } })
            .png()
            .toBuffer()
            .then((pngBuf) => {
              potrace.trace(pngBuf, (err, svg) => {
                pending -= 1
                if (!err && svg) {
                  const found = [...svg.matchAll(/d="([^"]+)"/g)].map((m) => m[1])
                  for (const d of found) paths.push({ hex: entry.hex, d })
                }
                maybeDone()
              })
            })
            .catch(() => {
              pending -= 1
              maybeDone()
            })
        })
      }).catch((error) => {
        parentPort.postMessage({ error: String((error && error.message) || error) })
      })
    })
  `
  return runPotraceWorker(
    { sharpUrl, potraceUrl, width: info.width, height: info.height, palette, raw: data },
    source,
    timeoutMs,
  )
}

// ── browser (HTML screenshot) ──────────────────────────────────────────────

/** Cross-platform Chrome/Chromium/Edge discovery. */
export function chromiumCandidates(env = {}, platform = typeof process !== 'undefined' ? process.platform : '') {
  const out = []
  const add = (value) => {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }
  add(env.CHROME_PATH)
  add(env.PUPPETEER_EXECUTABLE_PATH)

  if (platform === 'win32') {
    const pf = env.PROGRAMFILES
    const pfx86 = env['PROGRAMFILES(X86)']
    const local = env.LOCALAPPDATA
    if (pf) {
      add(winPath.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      add(winPath.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
    if (pfx86) {
      add(winPath.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      add(winPath.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
    if (local) {
      add(winPath.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      add(winPath.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      add(winPath.join(local, 'Chromium', 'Application', 'chrome.exe'))
    }
  } else if (platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    add('/Applications/Chromium.app/Contents/MacOS/Chromium')
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    add('/usr/bin/google-chrome')
    add('/usr/bin/google-chrome-stable')
    add('/usr/bin/chromium')
    add('/usr/bin/chromium-browser')
    add('/usr/bin/microsoft-edge')
    add('/usr/bin/microsoft-edge-stable')
  }
  return out
}

/** Wake lazy/revealed content before a full-page capture. */
export async function wakePageForFullCapture(page, viewportHeight) {
  const step = Number.isInteger(viewportHeight) && viewportHeight > 0 ? viewportHeight : 720
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto'
  })
  const total = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
  )
  for (let y = 0; y < total; y += step) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y)
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await new Promise((resolve) => setTimeout(resolve, 800))
}

/** Full scrollable page height (CSS px). */
export async function fullPageHeightOf(page) {
  return await page.evaluate(() =>
    Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      window.innerHeight,
    ),
  )
}

// ── model call (single configured endpoint) ────────────────────────────────

/** Endpoint content-safety rejection markers (GLM: "系统检测到输入或生成内容
 *  可能包含不安全或敏感内容…"; OpenAI-style: content_filter/policy/safety…). */
export const CONTENT_FILTER_RE =
  /敏感|不安全|内容审核|内容安全|政策|content.?filter|safety|inappropriate|flagged|拒绝.?内容|违反.*(规范|政策|安全)|inappropriate|violat/i

export function resolveApiKey(config) {
  if (config.apiKey) return config.apiKey
  if (config.apiKeyEnv) {
    const fromEnv = process.env[config.apiKeyEnv]
    if (fromEnv) return fromEnv
  }
  return process.env.OPENAI_API_KEY ?? ''
}

/** Turn image bytes into a data URL for the vision call.
 *  Defensive: attachment-service reads return Uint8Array (whose
 *  toString('base64') is a comma-joined number list, not base64), so always
 *  wrap in a real Buffer first. */
export function bytesToDataUrl(bytes, mediaType) {
  const mime = mediaType ?? 'image/png'
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * One OpenAI-compatible chat/completions call with image content parts.
 * This is the ONLY model-call path the ported tools use: the plugin's own
 * baseURL/apiKey/model settings drive every vision_* tool, exactly like
 * inspect_image.
 */
export async function callVisionModel(getConfig, prompt, imageUrls, options = {}) {
  const cfg = getConfig()
  const key = resolveApiKey(cfg)
  if (!key) {
    throw new Error(
      'tool-vision: vision API key missing: set the plugin config (apiKey / apiKeyEnv) or the OPENAI_API_KEY environment variable',
    )
  }
  const base = cfg.baseURL.endsWith('/') ? cfg.baseURL : `${cfg.baseURL}/`
  const endpoint = new URL('chat/completions', base)
  const controller = new AbortController()
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : cfg.timeoutMs
  const timer = setTimeout(
    () => controller.abort(new Error(`tool-vision: vision request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  const signal = options.signal
  const onSignalAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onSignalAbort, { once: true })
  }
  const content = [
    { type: 'text', text: prompt },
    ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
  ]
  const bodyOf = () => JSON.stringify({
    model: cfg.model,
    messages: [{ role: 'user', content }],
    max_tokens: Number.isFinite(options.maxTokens) ? options.maxTokens : cfg.maxTokens,
  })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const retryAfterOf = (response) => {
    const header = response?.headers?.get?.('retry-after')
    if (header) {
      const seconds = Number(header)
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 15000)
    }
    return 0
  }
  const MAX_TRANSIENT_RETRIES = 3
  try {
    let lastResponse = null
    let lastBody = null
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: bodyOf(),
        signal: controller.signal,
      })
      lastResponse = response
      lastBody = await response.json().catch(() => null)
      // Transient failures (rate limit / 5xx) retry with backoff; everything
      // else (4xx auth/format/content-filter) is terminal.
      const retriable =
        response.status === 429 ||
        response.status === 408 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      if (!response.ok && retriable && attempt < MAX_TRANSIENT_RETRIES) {
        const waitMs = retryAfterOf(response) || 800 * (attempt + 1)
        await sleep(waitMs)
        continue
      }
      break
    }
    const response = lastResponse
    const body = lastBody
    if (!response.ok) {
      const detailText = body?.error?.message ?? response.statusText
      throw new Error(
        `tool-vision: vision endpoint returned ${response.status}: ${detailText} (endpoint ${endpoint})`,
      )
    }
    const message = body?.choices?.[0]?.message
    let answer = message?.content ?? ''
    if (!answer.trim()) answer = message?.reasoning_content ?? ''
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new Error('tool-vision: vision endpoint returned an empty response')
    }
    const trimmed = answer.trim()
    // max_tokens truncation: glm-4v-flash caps at 1024; a truncated JSON or
    // transcript must not masquerade as a complete answer.
    const finishReason = body?.choices?.[0]?.finish_reason
    if (finishReason === 'length') {
      return `${trimmed}\n\n[注意:模型输出因 max_tokens 上限被截断(finish_reason=length);以上内容不完整。]`
    }
    return trimmed
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onSignalAbort)
  }
}

// ── shared tool plumbing ───────────────────────────────────────────────────

export const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * Build the 14 vision tools bound to this plugin instance.
 * @param {object} ctx - plugin context (attachments/fs services via ctx.get)
 * @param {() => object} getConfig - live settings getter
 */
export function registerVisionTools(ctx, getConfig) {
  const logger = ctx.logger

  /** Single-endpoint model call wrapper with the router's ok:false contract.
   *  `images` is a single Buffer, or an array of Buffers / data-URL strings. */
  const answerVisionForTool = async (images, mediaType, instruction, options = {}) => {
    try {
      // Uniform pixel budget for EVERY model call: ground/detect/ocr/etc.
      // must not ship raw 20MB images (base64 ~27MB -> endpoint 413/timeout).
      // Downscale only Buffer inputs; pre-made data URLs pass through.
      const bounded = Array.isArray(images)
        ? await Promise.all(images.map(async (item) => (typeof item === 'string' ? item : bytesToDataUrl(await downscaleImage(item, 4_000_000), mediaType ?? 'image/png'))))
        : [bytesToDataUrl(await downscaleImage(images, 4_000_000), mediaType)]
      const text = await callVisionModel(getConfig, instruction, bounded, {
        signal: options.signal ?? (options.exec && options.exec.signal),
      })
      return { ok: true, text }
    } catch (error) {
      const raw = error && error.message ? String(error.message) : String(error)
      // Endpoint content-safety rejections are NOT backend outages: the image
      // itself was refused. Surface them distinctly so the model tells the
      // user to pick a different image instead of reporting "vision down".
      if (CONTENT_FILTER_RE.test(raw)) {
        return {
          ok: false,
          code: 'VISION_CONTENT_FILTERED',
          retryable: false,
          contentFiltered: true,
          message:
            '图片被视觉端点的内容安全策略拒绝(检测到敏感或不安全内容)。' +
            '这不是网络或配置问题,请换一张图片或调整图片内容后再试。',
        }
      }
      return {
        ok: false,
        code: 'VISION_BACKEND_UNAVAILABLE',
        retryable: false,
        message: raw,
      }
    }
  }

  const saveArtifact = (exec, relPath, data) => writeArtifact(exec, relPath, data)
  const artifactStem = (imagePath, suffix) => artifactStemOf(imagePath, suffix)

  const tools = []

  // ── vision_describe ──────────────────────────────────────────────────────
  tools.push({
    name: 'vision_describe',
    description:
      'Look at images with the configured vision model and answer a focused question about them. ' +
      'For text-only sessions this is the bridge that provides image understanding. ' +
      'Supports comparing multiple images (e.g. a design mock vs an implementation screenshot). Provide ' +
      '`paths` (absolute local image file paths, png/jpeg/webp/gif) and/or ' +
      '`attachmentIds` (ids of images the user uploaded in this conversation), 1-4 images in ' +
      'total. `question` is the question to answer; be specific. Set `json: true` to require a ' +
      'single valid JSON object as the answer. ' +
      'FAILURE SEMANTICS: if the result is JSON with ok:false, the vision backend is unavailable. ' +
      'Do NOT call vision_describe again with a reworded question — rephrasing cannot fix an auth, ' +
      'rate-limit or outage problem. Answer from the information you already have and continue the ' +
      'text task, telling the user vision is temporarily unavailable.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute local image file paths and/or attachment ids (e.g. "sha256:...") of uploaded images, 1-4 images',
        },
        attachmentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attachment ids of images uploaded earlier in this conversation',
        },
        question: {
          type: 'string',
          description:
            'The question for the vision model, e.g. "compare the two images and list the differences"',
        },
        json: {
          type: 'boolean',
          description: 'Require the answer to be a single valid JSON object',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('vision_describe: the durable attachment service is not available in this deployment')
      }
      const blocks = []
      const contentIds = []
      const paths = Array.isArray(args.paths) ? args.paths : []
      const attachmentIds = Array.isArray(args.attachmentIds) ? args.attachmentIds : []
      if (paths.length + attachmentIds.length === 0 || paths.length + attachmentIds.length > 4) {
        throw new Error('vision_describe: provide 1-4 images via paths and/or attachmentIds')
      }

      for (const path of paths) {
        let bytes
        let mediaType
        try {
          ;({ bytes, mediaType } = await readImageBytes(ctx, exec, path))
        } catch (error) {
          throw new Error(
            `vision_describe: failed to read ${path} (${error && error.message ? error.message : String(error)})`,
          )
        }
        bytes = await downscaleImage(bytes, 4_000_000)
        let ref
        try {
          ref = await attachments.saveImage({ data: bytes, mediaType })
        } catch (error) {
          throw new Error(
            `vision_describe: image ${path} was rejected (${error && error.message ? error.message : String(error)})`,
          )
        }
        contentIds.push(String(ref.attachmentId))
        blocks.push({ type: 'image', attachment: ref })
      }

      for (const id of attachmentIds) {
        const session = exec && exec.agent && exec.agent.session
        const ref = lookupAttachment(session, String(id))
        if (ref === undefined) {
          throw new Error(
            `vision_describe: unknown attachment id "${id}" (it must come from an image uploaded in this conversation)`,
          )
        }
        let stored
        try {
          stored = await attachments.readImage(ref)
        } catch (error) {
          throw new Error(
            `vision_describe: failed to read attachment ${id} (${error && error.message ? error.message : String(error)})`,
          )
        }
        if (stored.data && stored.data.length > 0) {
          const resized = await downscaleImage(stored.data, 4_000_000)
          if (resized !== stored.data) {
            try {
              const resizedRef = await attachments.saveImage({
                data: resized,
                mediaType: stored.ref && stored.ref.mediaType ? stored.ref.mediaType : 'image/png',
                ...(stored.ref && stored.ref.name ? { name: stored.ref.name } : {}),
              })
              stored = { ref: resizedRef, data: resized }
            } catch {
              stored = { ...stored, data: resized }
            }
          }
        }
        contentIds.push(String(ref.attachmentId))
        blocks.push({ type: 'image', attachment: stored.ref })
      }

      const question = String(args.question ?? '')
      const wantJson = args.json === true
      const promptText = visionDescribePrompt(question, wantJson)
      // Cache key carries the endpoint/model identity: switching the vision
      // model must never serve stale answers from the previous model.
      const cfg = getConfig()
      const key = `${cfg.baseURL ?? ''}|${cfg.model ?? ''}|${contentIds.join('|')}|${wantJson ? 'json' : 'text'}|${question}`
      const cache = visionCache
      if (cacheEnabled()) {
        const hit = cache.get(key)
        if (hit !== undefined) return hit
      }

      // Call with all images as data URLs.
      const imageUrls = []
      for (const block of blocks) {
        const stored = await attachments.readImage(block.attachment)
        imageUrls.push(bytesToDataUrl(stored.data, stored.ref && stored.ref.mediaType ? stored.ref.mediaType : 'image/png'))
      }
      const vision = await answerVisionForTool(imageUrls, 'image/png', promptText, { exec })
      if (vision.ok === false) return JSON.stringify(vision)

      let text = vision.text
      if (wantJson) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const parsed = extractJson(text)
          if (parsed !== undefined) {
            const compact = JSON.stringify(normalizeDescribeResult(parsed) ?? parsed)
            if (cacheEnabled()) cache.set(key, compact)
            return compact
          }
          if (attempt === 0) {
            const retry = await answerVisionForTool(imageUrls, 'image/png', promptText + '\n\nThat output was not valid JSON. Respond with ONLY a valid JSON object now.', { exec })
            if (retry.ok === false) return JSON.stringify(retry)
            text = retry.text
          }
        }
        // Failure/fallback output must NOT be cached: it would poison the
        // cache for the whole TTL with an error string masquerading as an
        // answer.
        return `vision_describe: the model did not produce valid JSON. Raw output:\n${text.slice(0, 2000)}`
      }
      if (text !== '') {
        if (cacheEnabled()) cache.set(key, text)
        return text
      }
      // Empty output is a failure signal, not a cacheable answer.
      return '(the vision model returned empty content)'
    },
  })

  // ── vision_materialize ───────────────────────────────────────────────────
  tools.push({
    name: 'vision_materialize',
    description:
      'Copy an uploaded image attachment (sha256:...) or readable local image into the session workspace and return a real filesystem path. ' +
      'This tool performs NO vision model/network call. Use it after vision_describe returns ok:false when a local OCR/parser accepts only file_path. ' +
      'Never guess the attachment store path or search for a same-named file.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Uploaded image attachment id (recommended, e.g. sha256:...) or a readable local image path' },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const source = String(args.image ?? '')
      const { bytes, mediaType } = await readImageBytes(ctx, exec, source)
      const extension = mediaType === 'image/jpeg' ? '.jpg' : (EXT_BY_MEDIA[mediaType] ?? '.png')
      const target = await saveArtifact(exec, `${artifactStem(source, 'materialized')}${extension}`, bytes)
      return JSON.stringify({ path: target, bytes: bytes.length, mediaType })
    },
  })

  // ── vision_ground ────────────────────────────────────────────────────────
  tools.push({
    name: 'vision_ground',
    description:
      'Locate a target in an image and return its ORIGINAL-pixel bounding box (x1/y1/x2/y2), ' +
      'optionally producing an annotated PNG artifact. Pair with vision_crop and vision_pixel_diff ' +
      'for a verify-able pixel loop (reference -> implementation -> screenshot -> metrics). ' +
      'If the result is JSON with ok:false, the vision backend is unavailable — do not retry with ' +
      'reworded instructions this turn.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. "sha256:...") of an image uploaded in this conversation' },
        target: { type: 'string', description: 'What to locate, e.g. "the send button"' },
        annotate: { type: 'boolean', description: 'Also write an annotated PNG with the box drawn (default true)' },
      },
      required: ['image', 'target'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const { bytes, mediaType } = await readImageBytes(ctx, exec, args.image)
      const { width, height } = await imageDims(bytes)
      if (width <= 0 || height <= 0) throw new Error('vision_ground: could not read image dimensions')
      const instruction =
        `Target to locate: "${String(args.target).slice(0, 500)}". ` +
        `The image is ${width}x${height} pixels. Return ONE JSON object with integer fields ` +
        `{"x1":...,"y1":...,"x2":...,"y2":...} — the tight bounding box of that target in ` +
        `ORIGINAL image pixels (0 <= x1 < x2 <= ${width}, 0 <= y1 < y2 <= ${height}). ` +
        `Output only the JSON object.`
      const vision = await answerVisionForTool(bytes, mediaType, instruction, { exec })
      if (vision.ok === false) return JSON.stringify(vision)
      const parsed = extractJson(vision.text)
      const box = parsed !== undefined ? parseBox(parsed) : undefined
      if (box === undefined) {
        throw new Error(`vision_ground: the vision model did not return a valid box. Raw output: ${vision.text.slice(0, 500)}`)
      }
      let clamped = {
        x1: Math.max(0, Math.min(box.x1, width - 1)),
        y1: Math.max(0, Math.min(box.y1, height - 1)),
        x2: Math.max(1, Math.min(box.x2, width)),
        y2: Math.max(1, Math.min(box.y2, height)),
      }
      if (clamped.x2 - clamped.x1 < 2 || clamped.y2 - clamped.y1 < 2) {
        const retry = await answerVisionForTool(
          bytes,
          mediaType,
          `Your previous box ${JSON.stringify(clamped)} was a degenerate sliver, not the target. ` +
            `Return ONE JSON object with the FULL tight bounding box of the target in ORIGINAL ` +
            `image pixels (0 <= x1 < x2 <= ${width}, 0 <= y1 < y2 <= ${height}). Output only the JSON object.`,
          { exec },
        )
        if (retry.ok === false) return JSON.stringify(retry)
        const retryParsed = extractJson(retry.text)
        const retryBox = retryParsed !== undefined ? parseBox(retryParsed) : undefined
        if (retryBox === undefined) {
          throw new Error(
            `vision_ground: the vision model returned a degenerate box (${clamped.x1},${clamped.y1},${clamped.x2},${clamped.y2}) ` +
              `and the retry returned no valid box. Raw output: ${retry.text.slice(0, 500)}`,
          )
        }
        clamped = {
          x1: Math.max(0, Math.min(retryBox.x1, width - 1)),
          y1: Math.max(0, Math.min(retryBox.y1, height - 1)),
          x2: Math.max(1, Math.min(retryBox.x2, width)),
          y2: Math.max(1, Math.min(retryBox.y2, height)),
        }
        if (clamped.x2 - clamped.x1 < 2 || clamped.y2 - clamped.y1 < 2) {
          throw new Error(
            `vision_ground: the vision model returned only degenerate boxes for a ${width}x${height} image. ` +
              `Last raw output: ${retry.text.slice(0, 500)}`,
          )
        }
      }
      const result = { ...clamped, width, height }
      if (args.annotate !== false) {
        const annotated = await annotateBoxBuffer(bytes, clamped)
        result.annotatedPath = await saveArtifact(exec, `${artifactStem(args.image, 'ground')}.png`, annotated)
      }
      return JSON.stringify(result)
    },
  })

  // ── vision_detect ────────────────────────────────────────────────────────
  tools.push({
    name: 'vision_detect',
    description:
      'Find every element of a kind in an image (buttons, inputs, links, icons…) and return a ' +
      'numbered inventory with ORIGINAL-pixel boxes, optionally annotated on the image. The model ' +
      'can then reference "element #3" in follow-up vision_crop / vision_describe calls. ' +
      'If the result is JSON with ok:false, the vision backend is unavailable — do not retry with ' +
      'reworded instructions this turn.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. "sha256:...") of an image uploaded in this conversation' },
        target: {
          type: 'string',
          description: 'What kind of elements to list, e.g. "buttons", "input fields", "navigation links" (default: interactive elements)',
        },
        annotate: {
          type: 'boolean',
          description: 'Also write an annotated PNG with numbered boxes (default true)',
        },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const { bytes, mediaType } = await readImageBytes(ctx, exec, args.image)
      const { width, height } = await imageDims(bytes)
      if (width <= 0 || height <= 0) throw new Error('vision_detect: could not read image dimensions')
      const target = typeof args.target === 'string' && args.target.trim() !== '' ? args.target : 'interactive elements'
      const vision = await answerVisionForTool(bytes, mediaType, visionDetectInstruction(target, width, height), { exec })
      if (vision.ok === false) return JSON.stringify(vision)
      let text = vision.text
      let parsed = extractJson(text)
      if (parsed === undefined) {
        const retry = await answerVisionForTool(
          bytes,
          mediaType,
          visionDetectInstruction(target, width, height) +
            '\nYour previous answer was not valid JSON. Respond with ONLY the JSON object, no prose, no fences.',
          { exec },
        )
        if (retry.ok === false) return JSON.stringify(retry)
        parsed = extractJson(retry.text)
        text = retry.text
      }
      const result = normalizeDetectResult(parsed, width, height)
      if (result === undefined) {
        throw new Error(`vision_detect: the vision model did not return a valid inventory. Raw output: ${text.slice(0, 500)}`)
      }
      if (args.annotate !== false && result.elements.length > 0) {
        const annotated = await annotateBoxesBuffer(bytes, result.elements.map((e) => e.box))
        result.annotatedPath = await saveArtifact(exec, `${artifactStem(args.image, 'detect')}.png`, annotated)
      }
      return JSON.stringify(result)
    },
  })

  // ── vision_crop ──────────────────────────────────────────────────────────
  tools.push({
    name: 'vision_crop',
    description:
      'Crop a pixel region (x1,y1,x2,y2 in ORIGINAL pixels) out of an image and write the ' +
      'result as a PNG artifact for a closer look. Very large regions are rendered as a bounded ' +
      'preview; crop a smaller ORIGINAL-pixel region when tiny details must be preserved.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. "sha256:...") of an image uploaded in this conversation' },
        region: {
          type: 'string',
          description: 'Pixel box "x1,y1,x2,y2" in original image coordinates',
        },
      },
      required: ['image', 'region'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const { bytes } = await readImageBytes(ctx, exec, args.image)
      const { width, height } = await imageDims(bytes)
      const box = parseBox(args.region)
      if (box === undefined) {
        throw new Error(`vision_crop: invalid region "${args.region}" (expect "x1,y1,x2,y2" integers)`)
      }
      if (box.x2 > width || box.y2 > height) {
        throw new Error(`vision_crop: region exceeds image bounds (${width}x${height})`)
      }
      const sharp = await loadSharp()
      if (!sharp) throw new Error('vision_crop: the sharp image library is unavailable')
      const sourceWidth = box.x2 - box.x1
      const sourceHeight = box.y2 - box.y1
      const preview = scaledDimensions(sourceWidth, sourceHeight, 4_000_000)
      let pipeline = sharp(bytes, { failOn: 'none' }).extract({
        left: box.x1,
        top: box.y1,
        width: sourceWidth,
        height: sourceHeight,
      })
      if (preview.scale !== 1) {
        pipeline = pipeline.resize(preview.width, preview.height, { fit: 'fill' })
      }
      const cropped = await pipeline.png().toBuffer()
      const target = await saveArtifact(
        exec,
        `${artifactStem(args.image, `crop-${box.x1}-${box.y1}-${box.x2}-${box.y2}`)}.png`,
        cropped,
      )
      const meta = await sharp(cropped).metadata()
      return JSON.stringify({
        path: target,
        width: meta.width ?? preview.width,
        height: meta.height ?? preview.height,
        bytes: cropped.length,
        ...(preview.scale !== 1
          ? {
              preview: true,
              sourceRegion: box,
              sourceWidth,
              sourceHeight,
              scale: preview.scale,
              advice: 'This was a bounded preview of a large crop. Use vision_crop again with a smaller ORIGINAL-pixel region for tiny details.',
            }
          : {}),
      })
    },
  })

  // ── vision_present ───────────────────────────────────────────────────────
  const visionPresentOutput = {
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        label: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        bytes: { type: 'number' },
        safePresentation: { type: 'boolean' },
        attachment: {
          type: 'object',
          properties: {
            attachmentId: { type: 'string' },
            mediaType: { type: 'string' },
            bytes: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            name: { type: 'string' },
          },
          required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
          additionalProperties: false,
        },
      },
      required: ['path', 'label', 'width', 'height', 'bytes', 'safePresentation', 'attachment'],
      additionalProperties: false,
    },
    render: (_args, value) => {
      const attachment = value.attachment
      return [
        {
          type: 'text',
          text: JSON.stringify({
            path: value.path,
            label: value.label,
            width: value.width,
            height: value.height,
            bytes: value.bytes,
            safePresentation: true,
            attachmentId: String(attachment.attachmentId),
          }),
        },
        { type: 'image', attachment },
      ]
    },
  }
  tools.push({
    name: 'vision_present',
    description:
      'Present a generated local image directly to the user with the host-native image preview. ' +
      'MANDATORY PRESENTATION RULE: when you generate, edit, screenshot, or export an image and want the user to see it, ' +
      'you MUST call vision_present. read_image is only for model-side inspection; NEVER use read_image to present or send ' +
      'an image to the user. The image is retained in the session UI but sanitized out of later text-only model requests.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. "sha256:...") of an image uploaded in this conversation' },
        label: { type: 'string', description: 'Optional short user-facing label for the image' },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: visionPresentOutput,
    async execute(args, exec) {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('vision_present: the durable attachment service is not available in this deployment')
      }
      const { bytes, mediaType } = await readImageBytes(ctx, exec, args.image)
      const label =
        typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim().slice(0, 200) : 'image'
      const extension =
        mediaType === 'image/jpeg' ? 'jpg' :
        mediaType === 'image/webp' ? 'webp' :
        mediaType === 'image/gif' ? 'gif' : 'png'
      const target = await saveArtifact(exec, `${artifactStem(args.image, 'present')}.${extension}`, bytes)
      let attachment
      try {
        attachment = await attachments.saveImage({
          data: bytes,
          mediaType,
          name: label,
        })
      } catch (error) {
        throw new Error(
          `vision_present: failed to publish the image attachment (${error && error.message ? error.message : String(error)})`,
        )
      }
      return {
        path: target,
        label,
        width: attachment.width,
        height: attachment.height,
        bytes: attachment.bytes,
        safePresentation: true,
        attachment,
      }
    },
  })

  // ── vision_pixel_diff ────────────────────────────────────────────────────
  tools.push({
    name: 'vision_pixel_diff',
    description:
      'Compare two images pixel by pixel (sharp-based, no Python): returns the differing-pixel ' +
      'ratio, the worst 8x8-grid regions as original-pixel boxes, and writes a red heatmap PNG ' +
      'plus a JSON report as artifacts. Use it to verify an implementation against a reference.',
    parameters: {
      type: 'object',
      properties: {
        original: { type: 'string', description: 'Reference image path or attachment id (e.g. "sha256:...")' },
        rebuilt: { type: 'string', description: 'Candidate image path or attachment id (e.g. "sha256:..."); resized to the original size before comparing' },
        threshold: { type: 'number', description: 'Per-channel difference threshold, default 16' },
      },
      required: ['original', 'rebuilt'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const { bytes: originalBytes } = await readImageBytes(ctx, exec, args.original)
      const { bytes: rebuiltBytes } = await readImageBytes(ctx, exec, args.rebuilt)
      const sharp = await loadSharp()
      if (!sharp) throw new Error('vision_pixel_diff: the sharp image library is unavailable')
      const meta = await sharp(originalBytes, { failOn: 'none' }).metadata()
      const width = meta.width ?? 0
      const height = meta.height ?? 0
      if (width <= 0 || height <= 0) throw new Error('vision_pixel_diff: could not read original dimensions')
      const threshold = Number.isFinite(args.threshold) && args.threshold >= 0 ? Math.round(args.threshold) : 16
      const pixels = width * height
      let diff
      let heatmapPng
      let heatmapPreview = false
      let heatmapWidth = width
      let heatmapHeight = height
      if (pixels <= 4_000_000) {
        const originalRaw = await sharp(originalBytes, { failOn: 'none' })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        const rebuiltRaw = await sharp(rebuiltBytes, { failOn: 'none' })
          .resize(width, height, { fit: 'fill' })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        diff = computePixelDiff(originalRaw.data, rebuiltRaw.data, threshold, width, height)
        const heatmap = renderDiffHeatmap(originalRaw.data, diff.mask, width, height)
        heatmapPng = await sharp(heatmap, { raw: { width, height, channels: 4 } })
          .png()
          .toBuffer()
      } else {
        // Exact large-image metrics from streaming RGBA; heatmap bounded to 4MP.
        const originalStream = sharp(originalBytes, { failOn: 'none' }).ensureAlpha().raw()
        const rebuiltStream = sharp(rebuiltBytes, { failOn: 'none' })
          .resize(width, height, { fit: 'fill' })
          .ensureAlpha()
          .raw()
        diff = await compareRgbaStreams(originalStream, rebuiltStream, { width, height, threshold })
        const preview = scaledDimensions(width, height, 4_000_000)
        heatmapWidth = preview.width
        heatmapHeight = preview.height
        heatmapPreview = true
        const originalPreview = await sharp(originalBytes, { failOn: 'none' })
          .resize(preview.width, preview.height, { fit: 'fill' })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        const rebuiltPreview = await sharp(rebuiltBytes, { failOn: 'none' })
          .resize(preview.width, preview.height, { fit: 'fill' })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        const previewDiff = computePixelDiff(
          originalPreview.data,
          rebuiltPreview.data,
          threshold,
          preview.width,
          preview.height,
        )
        const heatmap = renderDiffHeatmap(originalPreview.data, previewDiff.mask, preview.width, preview.height)
        heatmapPng = await sharp(heatmap, {
          raw: { width: preview.width, height: preview.height, channels: 4 },
        }).png().toBuffer()
      }
      const worst = diff.cells.slice(0, 5).map((cell) => ({
        x1: cell.x1,
        y1: cell.y1,
        x2: cell.x2,
        y2: cell.y2,
        ratio: Number(cell.ratio.toFixed(4)),
        differing: cell.differing,
      }))
      const heatmapPath = await saveArtifact(exec, `${artifactStem(args.original, 'diff-heatmap')}.png`, heatmapPng)
      const report = {
        width,
        height,
        differingPixels: diff.differing,
        totalPixels: diff.total,
        differingRatio: Number(diff.ratio.toFixed(6)),
        threshold,
        worstRegions: worst,
        heatmapPath,
        heatmapWidth,
        heatmapHeight,
        heatmapPreview,
      }
      const reportPath = await saveArtifact(exec, `${artifactStem(args.original, 'diff-report')}.json`, Buffer.from(JSON.stringify(report, null, 2)))
      return JSON.stringify({ ...report, reportPath })
    },
  })

  // ── vision_colors ────────────────────────────────────────────────────────
  tools.push({
    name: 'vision_colors',
    description:
      'Extract the dominant colors of an image (sharp-based quantization) with their share of ' +
      'pixels, e.g. to match a palette when rebuilding a UI.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. "sha256:...") of an image uploaded in this conversation' },
        top: { type: 'number', description: 'How many colors to return, default 8' },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const { bytes } = await readImageBytes(ctx, exec, args.image)
      const top = Number.isInteger(args.top) && args.top > 0 ? args.top : 8
      const sharp = await loadSharp()
      if (!sharp) throw new Error('vision_colors: the sharp image library is unavailable')
      const raw = await sharp(bytes, { failOn: 'none' })
        .resize(64, 64, { fit: 'inside' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const colors = quantizeColors(raw.data, Math.min(top, 32))
      return JSON.stringify(colors)
    },
  })

  // ── vision_ocr ───────────────────────────────────────────────────────────
  tools.push({
    name: 'vision_ocr',
    description:
      'Transcribe TEXT from an image with the vision model. ' +
      'Returns the text and which engine produced it. ' +
      'SCOPE: vision_ocr reads letters, it does NOT recognize people, objects or scenes. Never use it ' +
      'as a fallback when vision_describe fails to identify who/what is in a picture ("这是谁" / ' +
      '"这是什么东西" questions are answered by vision_describe, not OCR). If vision_describe returns ' +
      'ok:false with a backend-unavailable code, calling vision_ocr instead will fail the same way — ' +
      'do not chain these tools as retries of each other. ' +
      'ACCURACY: OCR transcribes characters verbatim and is systematically unreliable for confusable ' +
      'glyphs (1/l, 0/O), spacing and line breaks; prefer vision_describe / vision_detect for semantic ' +
      'understanding and use OCR only when exact verbatim text is required (executable code, exact ' +
      'quotation, forms/contracts, table digits, CAPTCHAs). Treat OCR output as evidence to verify, ' +
      'never as ground truth.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. "sha256:...") of an image uploaded in this conversation' },
        engine: {
          type: 'string',
          description: '"auto" (default) or "vision": transcribe with the configured vision model. "tesseract" is not available in this build.',
        },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const { bytes, mediaType } = await readImageBytes(ctx, exec, args.image)
      const engine = args.engine === 'vision' ? 'vision' : 'auto'
      if (args.engine === 'tesseract') {
        throw new Error('vision_ocr: the local tesseract engine is not available in this build; use engine "auto" or "vision"')
      }
      const instruction =
        '请原样转述图中的所有文字，保持阅读顺序（从上到下、从左到右）与段落结构，不要添加解释。只输出文字本身。'
      const vision = await answerVisionForTool(bytes, mediaType, instruction, { exec })
      if (vision.ok === false) {
        return JSON.stringify({ engine: 'none', ...vision, text: '' })
      }
      return JSON.stringify({ engine, text: vision.text })
    },
  })

  // ── vision_long_screenshot_ocr ───────────────────────────────────────────
  tools.push({
    name: 'vision_long_screenshot_ocr',
    description:
      'Transcribe a LONG screenshot (chat logs, long documents) into ordered Markdown. ' +
      'Splits the image into overlapping horizontal chunks, OCRs each chunk with the vision ' +
      'model, and stitches the text in reading order. Writes chunk PNGs, the Markdown, and a ' +
      'manifest into the workspace artifacts directory.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. "sha256:...") of an image uploaded in this conversation' },
        chunkHeight: { type: 'number', description: 'Chunk height in pixels, default 1200' },
        overlap: { type: 'number', description: 'Overlap between adjacent chunks in pixels, default 120' },
        engine: { type: 'string', description: '"auto" (default) or "vision": transcribe with the configured vision model.' },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const { bytes, mediaType } = await readImageBytes(ctx, exec, args.image)
      const sharp = await loadSharp()
      if (!sharp) throw new Error('vision_long_screenshot_ocr: the sharp image library is unavailable')
      const meta = await sharp(bytes, { failOn: 'none' }).metadata()
      const width = meta.width ?? 0
      const height = meta.height ?? 0
      if (width <= 0 || height <= 0) {
        throw new Error('vision_long_screenshot_ocr: could not read image dimensions')
      }
      const chunkHeight =
        Number.isInteger(args.chunkHeight) && args.chunkHeight >= 400
          ? Math.min(args.chunkHeight, 2000)
          : 1200
      const overlap =
        Number.isInteger(args.overlap) && args.overlap >= 0
          ? Math.min(args.overlap, Math.floor(chunkHeight / 2))
          : 120
      if (args.engine === 'tesseract') {
        throw new Error('vision_long_screenshot_ocr: the local tesseract engine is not available in this build; use engine "auto" or "vision"')
      }
      const windows = boundedOcrTiles(width, height, {
        chunkHeight,
        overlap,
        maxTilePixels: 4_000_000,
      })
      // Hard bounds: a tall screenshot must never turn into an unbounded,
      // uncancellable model-call loop (router's 30s budget was dropped here,
      // so re-introduce explicit limits).
      const MAX_OCR_CHUNKS = 40
      const OCR_TOTAL_BUDGET_MS = 120_000
      const ocrStartedAt = Date.now()
      const signal = exec && exec.signal
      const stem = artifactStem(args.image, 'ocr')
      const results = []
      let visionFailed = false
      for (let i = 0; i < windows.length; i++) {
        if (signal?.aborted) break
        if (i >= MAX_OCR_CHUNKS) {
          results.push({
            chunk: i + 1,
            left: windows[i].left,
            right: windows[i].right,
            top: windows[i].top,
            bottom: windows[i].bottom,
            engine: 'skipped',
            chars: 0,
            text: '',
            error: 'chunk limit reached',
          })
          continue
        }
        if (Date.now() - ocrStartedAt > OCR_TOTAL_BUDGET_MS) {
          results.push({
            chunk: i + 1,
            left: windows[i].left,
            right: windows[i].right,
            top: windows[i].top,
            bottom: windows[i].bottom,
            engine: 'skipped',
            chars: 0,
            text: '',
            error: 'OCR total budget exhausted',
          })
          continue
        }
        const { left, right, top, bottom } = windows[i]
        const tileWidth = right - left
        const tileHeight = bottom - top
        const chunk = await sharp(bytes, { failOn: 'none' })
          .extract({ left, top, width: tileWidth, height: tileHeight })
          .png()
          .toBuffer()
        const chunkRel = `chunk-${String(i + 1).padStart(2, '0')}.png`
        await writeArtifact(exec, join(stem, chunkRel), chunk)
        let text = ''
        let used = 'none'
        // Upload JPEG without an alpha channel: some vision backends degrade
        // on RGBA PNGs and hallucinate token-fragment text.
        const visionBytes = await sharp(chunk, { failOn: 'none' })
          .removeAlpha()
          .jpeg({ quality: 92 })
          .toBuffer()
        const instruction =
          '请原样转述这张长截图分片中的所有文字，保持阅读顺序（从上到下、从左到右），' +
          '不要添加解释，只输出文字本身。如果画面中没有可见文字，只输出 EMPTY，不要编造内容。'
        if (!visionFailed) {
          const visionResult = await answerVisionForTool(visionBytes, 'image/jpeg', instruction, { exec })
          if (visionResult.ok === false) {
            // Backend failure: stop burning calls on the remaining chunks.
            visionFailed = true
            used = 'failed'
          } else {
            text = visionResult.text.trim()
            if (text.length > 12000) {
              const retry = await answerVisionForTool(
                visionBytes,
                'image/jpeg',
                '重新转写这张图片中的真实文字，保持阅读顺序。只输出图中肉眼可见的文字，' +
                  '禁止编造、禁止重复；总输出不超过 3000 字。没有任何文字就只输出 EMPTY。',
                { exec },
              )
              if (retry.ok === false) {
                visionFailed = true
                used = 'failed'
                text = ''
              } else {
                const retryText = retry.text.trim()
                if (retryText !== '') text = retryText
                used = 'vision'
              }
            } else {
              used = 'vision'
            }
            if (text === 'EMPTY') text = ''
          }
        }
        results.push({ chunk: i + 1, left, right, top, bottom, engine: used, chars: text.length, text })
      }
      const joined = results.map((r) => r.text).filter((t) => t !== '').join('\n\n')
      const engines = {}
      for (const r of results) engines[r.engine] = (engines[r.engine] ?? 0) + 1
      const manifest = {
        source: args.image,
        width,
        height,
        chunkHeight,
        overlap,
        chunks: results.length,
        engines,
        perChunk: results.map(({ text, ...rest }) => rest),
      }
      const manifestPath = await writeArtifact(exec, join(stem, 'manifest.json'), JSON.stringify(manifest, null, 2))
      const mdPath = await writeArtifact(exec, join(stem, 'ocr.md'), joined)
      return JSON.stringify({
        text: joined,
        chunks: results.length,
        engines,
        markdownPath: mdPath,
        manifestPath,
        artifactsDir: dirname(mdPath),
      })
    },
  })

  // ── vision_trace ─────────────────────────────────────────────────────────
  tools.push({
    name: 'vision_trace',
    description:
      'Vectorize an image (icon/logo) into an SVG via a local potrace pipeline (no Python). ' +
      'Default: COLOR-preserving vectorization — one path per dominant color with fill="#rrggbb". ' +
      'Set color=false for the layered grayscale posterization, where `steps` (1-16, default 4) ' +
      'controls levels. Writes the SVG as an artifact.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. "sha256:...") of an image uploaded in this conversation' },
        steps: { type: 'number', description: 'Posterization steps, 1-16, default 4 (only when color=false)' },
        color: { type: 'boolean', description: 'Preserve original colors (default true)' },
        colors: { type: 'number', description: 'Number of dominant colors in color mode, 1-16, default 8' },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const { bytes } = await readImageBytes(ctx, exec, args.image)
      const steps = Number.isInteger(args.steps) && args.steps > 0 ? Math.min(args.steps, 16) : 4
      const colorMode = args.color !== false
      // Trace-specific pixel budget: vectorization gains nothing beyond ~1MP.
      let traceBytes = bytes
      if (bytes && bytes.length > 0) {
        traceBytes = await downscaleImage(bytes, 1_000_000)
      }
      let svg
      let colorCount = 0
      try {
        if (colorMode) {
          const sharp = await loadSharp()
          if (!sharp) throw new Error('vision_trace: the sharp image library is unavailable')
          const colors = Number.isInteger(args.colors) && args.colors > 0 ? Math.min(args.colors, 16) : 8
          const raw = await sharp(traceBytes, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
          const palette = quantizeColors(raw.data, colors)
          colorCount = palette.length
          svg = await posterizeSvgColor(raw.data, raw.info, palette, getConfig().timeoutMs || 60000)
        } else {
          svg = await posterizeSvg(traceBytes, steps, 'dominant', getConfig().timeoutMs || 60000)
        }
      } catch (error) {
        throw new Error(
          `vision_trace: potrace failed (${error && error.message ? error.message : String(error)}). ` +
            'If potrace is missing, install the plugin dependencies in the profile (pnpm add potrace).',
        )
      }
      const target = await saveArtifact(
        exec,
        `${artifactStem(args.image, colorMode ? 'trace-color' : `trace-${steps}`)}.svg`,
        Buffer.from(svg),
      )
      return JSON.stringify({ path: target, bytes: Buffer.byteLength(svg), ...(colorMode ? { colors: colorCount } : {}) })
    },
  })

  // ── vision_extract_foreground ────────────────────────────────────────────
  tools.push({
    name: 'vision_extract_foreground',
    description:
      'Remove a solid-ish background (border flood fill with color tolerance, no Python) and ' +
      'write the cutout as a transparent PNG artifact. Best for logos on uniform backgrounds.',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. "sha256:...") of an image uploaded in this conversation' },
        tolerance: { type: 'number', description: 'Max per-channel color distance from the background, default 40' },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const { bytes } = await readImageBytes(ctx, exec, args.image)
      let fgBytes = bytes
      if (bytes && bytes.length > 0) {
        fgBytes = await downscaleImage(bytes, 4_000_000)
      }
      const tolerance = Number.isFinite(args.tolerance) && args.tolerance >= 0 ? Math.round(args.tolerance) : 40
      const sharp = await loadSharp()
      if (!sharp) throw new Error('vision_extract_foreground: the sharp image library is unavailable')
      const { data, info } = await sharp(fgBytes, { failOn: 'none' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const cutout = floodFillBackground(data, info.width, info.height, tolerance)
      const png = await sharp(cutout, {
        raw: { width: info.width, height: info.height, channels: 4 },
      })
        .png()
        .toBuffer()
      const target = await saveArtifact(exec, `${artifactStem(args.image, 'fg')}.png`, png)
      return JSON.stringify({ path: target, width: info.width, height: info.height, bytes: png.length })
    },
  })

  // ── vision_html_screenshot ───────────────────────────────────────────────
  tools.push({
    name: 'vision_html_screenshot',
    description:
      'Render a local .html/.htm file in the system Chrome (headless, network disabled by ' +
      'default) and save a PNG screenshot as an artifact — the verify step of the ' +
      'reference -> implementation -> screenshot -> pixel-diff loop. With fullPage: true the ' +
      'page keeps the requested viewport but the whole scrollable height is captured and the ' +
      'result JSON reports pageHeight (CSS px).',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Local .html or .htm file path' },
        width: { type: 'number', description: 'Viewport width, default 1200' },
        height: { type: 'number', description: 'Viewport height, default 720' },
        fullPage: {
          type: 'boolean',
          description:
            'Capture the complete scrollable page height at the requested viewport width ' +
            'instead of just the viewport (default false). Lazy-loaded images and ' +
            'scroll-triggered reveals are woken first; the result JSON then includes ' +
            'pageHeight (CSS px).',
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const source = String(args.source ?? '')
      if (!/\.(html?|htm)$/i.test(source)) {
        throw new Error('vision_html_screenshot: source must be a local .html/.htm file')
      }
      const fsService = ctx.get('fs')
      if (fsService === undefined) {
        throw new Error('vision_html_screenshot: the fs service is not available')
      }
      const resolved = await fsService.resolve(source)
      const targetPath = toRealPath(fsService, resolved)
      if (!existsSync(targetPath)) {
        throw new Error(`vision_html_screenshot: file not found: ${source}`)
      }
      let puppeteer
      try {
        puppeteer = await import('puppeteer-core')
      } catch {
        throw new Error(
          'vision_html_screenshot: puppeteer-core is not installed. Install the plugin dependencies in the profile (pnpm add puppeteer-core).',
        )
      }
      const candidates = chromiumCandidates(
        typeof process !== 'undefined' && process.env ? process.env : {},
        typeof process !== 'undefined' ? process.platform : '',
      )
      const executablePath = candidates.find((p) => existsSync(p))
      if (executablePath === undefined) {
        throw new Error(
          'vision_html_screenshot: no Chrome/Chromium/Edge found; install one or set CHROME_PATH / PUPPETEER_EXECUTABLE_PATH',
        )
      }
      const width = Number.isInteger(args.width) && args.width > 0 ? args.width : 1200
      const height = Number.isInteger(args.height) && args.height > 0 ? args.height : 720
      const fullPage = args.fullPage === true
      const launchArgs = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--incognito']
      if (fullPage) {
        launchArgs.push('--blink-settings=imagesLazyLoadingEnabled=false')
      }
      const browser = await puppeteer.default.launch({
        executablePath,
        headless: true,
        args: launchArgs,
      })
      try {
        const page = await browser.newPage()
        await page.setViewport({ width, height })
        // Honor the "network disabled by default" contract: the page may only
        // load file:/data:/blob: subresources; everything else is aborted so
        // a malicious local HTML cannot exfiltrate data or pull remote assets.
        await page.setRequestInterception(true)
        page.on('request', (request) => {
          const url = request.url() ?? ''
          if (/^(file|data|blob):/i.test(url)) request.continue()
          else request.abort()
        })
        await page.goto(pathToFileURL(targetPath).href, { waitUntil: 'networkidle0', timeout: 30000 })
        let pageHeight
        if (fullPage) {
          await wakePageForFullCapture(page, height)
          pageHeight = await fullPageHeightOf(page)
        }
        const png = fullPage
          ? await page.screenshot({ type: 'png', fullPage: true })
          : await page.screenshot({ type: 'png' })
        const stem = fullPage ? `shot-${width}x${height}-fullpage` : `shot-${width}x${height}`
        const target = await saveArtifact(exec, `${artifactStem(source, stem)}.png`, png)
        const result = { path: target, width, height, bytes: png.length }
        if (fullPage) {
          result.pageHeight = pageHeight
        }
        return JSON.stringify(result)
      } finally {
        await browser.close()
      }
    },
  })

  // ── vision_screenshot ────────────────────────────────────────────────────
  tools.push({
    name: 'vision_screenshot',
    description:
      'Capture the user\'s desktop screen as a PNG artifact (the virtual screen on Windows; the main display on macOS; the root display on Linux). ' +
      'Windows: PowerShell CopyFromScreen; macOS: screencapture; Linux: ImageMagick import (falls back to scrot; either command must be installed). ' +
      'Use it when you need to see what is on the user\'s screen right now — e.g. their current GUI, an app, or a page outside this browser. ' +
      'Optional identify=true also runs recognition on the capture with the configured vision model and returns the description alongside the path.',
    parameters: {
      type: 'object',
      properties: {
        identify: {
          type: 'boolean',
          description:
            'Also recognize the captured screen with the configured vision model and return the description text with the path. Default false.',
        },
      },
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const tmp = join(
        (typeof process !== 'undefined' && process.env && process.env.TMPDIR) || process.env.TEMP || '/tmp',
        `vision-screenshot-${Date.now()}-${Math.floor(Math.random() * 1e9)}.png`,
      )
      const platform = process.platform
      try {
        if (platform === 'win32') {
          const script = [
            'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
            '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
            '$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)',
            '$g=[System.Drawing.Graphics]::FromImage($bmp)',
            '$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)',
            `$bmp.Save('${tmp.replace(/'/g, "''")}')`,
            '$g.Dispose();$bmp.Dispose()',
          ].join('; ')
          await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
            timeout: 60000,
            windowsHide: true,
          })
        } else if (platform === 'darwin') {
          await promisify(execFile)('screencapture', ['-x', '-m', tmp], {
            timeout: 60000,
            windowsHide: true,
          })
        } else {
          try {
            await promisify(execFile)('import', ['-window', 'root', tmp], { timeout: 60000 })
          } catch {
            await promisify(execFile)('scrot', [tmp], { timeout: 60000 })
          }
        }
        if (!existsSync(tmp)) {
          throw new Error(
            `vision_screenshot: no output produced on ${platform} (is a screen available?)`,
          )
        }
        const data = await readFileP(tmp)
        const target = await saveArtifact(exec, `screenshot-${Date.now()}.png`, data)
        const result = { path: target, bytes: data.length }
        if (args.identify === true) {
          let identifyBytes = data
          try {
            const sharp = await loadSharp()
            if (sharp) {
              const downscaled = await sharp(data, { failOn: 'none' })
                .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
                .png()
                .toBuffer()
              if (downscaled.length > 0 && downscaled.length < data.length) {
                identifyBytes = downscaled
              }
            }
          } catch {
            /* keep the original capture */
          }
          const vision = await answerVisionForTool(
            identifyBytes,
            'image/png',
            'Describe what is currently visible on the user\'s screen, in detail and in reading order. Mention the app/window names you can see.',
            { exec },
          )
          if (vision.ok === false) {
            result.identify = { ok: false, ...vision, text: '' }
          } else {
            result.identify = { ok: true, text: vision.text }
          }
        }
        try {
          await rmP(tmp, { force: true })
        } catch {
          /* best-effort cleanup */
        }
        return JSON.stringify(result)
      } catch (error) {
        throw new Error(
          `vision_screenshot: failed (${error && error.message ? error.message : String(error)})`,
        )
      }
    },
  })

  for (const def of tools) {
    ctx.tools.register(def)
  }
  logger?.info?.('[tool-vision] registered %d pixel-level vision tools', tools.length)
  return tools.length
}

// ── cache instance shared across tools ─────────────────────────────────────

const visionCache = createCache(200, 3600 * 1000)
let cacheDisabled = false

function cacheEnabled() {
  return !cacheDisabled
}

/** Test hook: reset the shared cache. */
export function resetVisionCacheForTests() {
  visionCache.clear()
  cacheDisabled = false
}
