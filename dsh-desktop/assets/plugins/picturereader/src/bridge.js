/**
 * picturereader 图片桥 (bridge.js)
 *
 * DSH 原生支持粘贴图片：粘贴后即生成 image content block，并在输入框/会话里
 * 渲染缩略图。但主模型一般是纯文本（如 deepseek-v4-flash），若直接把 image
 * block 发给文本型适配器会 UNSUPPORTED_CONTENT 导致整轮失败。本桥负责把发给
 * 文本模型的 image block 按当前使用模式降级为"本地图片理解引导"：
 *
 *  - agent/pre-step：把进入本轮的消息里的图片降级（privacy 只引导本地工具；
 *    smart/strict 附带对应策略，并说明何时可考虑 vision_analyze 走外部 VLM）。
 *  - llm/stream requestGuard：对仍带着 image block 的非多模态请求再兜底一次，
 *    避免适配器抛错。
 *
 * 隐私模式为硬 gate：即使配置了外部 API，降级后的引导也明确"只用本地工具"，
 * 绝不把图发给任何外部视觉端点。
 *
 * @module picturereader/bridge
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import os, { homedir } from 'node:os';
import { getRuntimeConfig } from './runtime.js';
import { routePolicyText, routeModeTag } from './routing.js';

const EXT_BY_MEDIA = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

const ATTACHMENT_OBJECTS_DIR = join(homedir(), '.dsh', 'attachments', 'v1', 'objects');
const SHA_ATTACHMENT_RE = /\[image omitted because this model accepts text only;\s*attachment sha256:([a-f0-9]{8,64})\]/gi;

function imageExtensionFromBytes(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg';
  if (data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) return '.gif';
  if (data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM') return '.bmp';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}

export function hasShaAttachmentReference(messages) {
  return (messages ?? []).some((message) => {
    if (!Array.isArray(message?.content)) return false;
    return message.content.some((block) => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return false;
      SHA_ATTACHMENT_RE.lastIndex = 0;
      return SHA_ATTACHMENT_RE.test(block.text);
    });
  });
}

async function resolveShaAttachment(prefix, objectsDir = ATTACHMENT_OBJECTS_DIR) {
  const normalized = String(prefix ?? '').toLowerCase();
  if (!/^[a-f0-9]{8,64}$/.test(normalized)) return null;
  try {
    const candidates = await readdir(join(objectsDir, normalized.slice(0, 2)), { withFileTypes: true });
    const matches = candidates.filter((entry) => entry.isFile() && entry.name.startsWith(normalized));
    if (matches.length !== 1) return null;
    return join(objectsDir, normalized.slice(0, 2), matches[0].name);
  } catch {
    return null;
  }
}

const exportedShaPaths = new Map();
export async function exportShaAttachment(prefix, dir, objectsDir = ATTACHMENT_OBJECTS_DIR) {
  const source = await resolveShaAttachment(prefix, objectsDir);
  if (!source) return null;
  const hash = basename(source);
  const cacheKey = join(dir, hash);
  const cached = exportedShaPaths.get(cacheKey);
  if (cached) return cached;
  const data = await readFile(source);
  const ext = imageExtensionFromBytes(data);
  if (!ext) return null;
  await mkdir(dir, { recursive: true });
  const path = join(dir, `attachment_${hash.slice(0, 12)}${ext}`);
  await writeFile(path, data);
  exportedShaPaths.set(cacheKey, path);
  return path;
}

function imageToolGuidance(path, mode, name = '') {
  const policy = routePolicyText(mode, { vlmConfigured: true });
  return `用户粘贴了一张图片${name}，已导出到：${path}\n` +
    `${routeModeTag(mode)}\n` +
    policy +
    `\n请先用 image_scan 分析 ${path}（如含文字再用 image_ocr）。`;
}

async function bridgeShaAttachmentText(text, dir, mode, objectsDir) {
  SHA_ATTACHMENT_RE.lastIndex = 0;
  const references = [...String(text).matchAll(SHA_ATTACHMENT_RE)];
  let bridged = String(text);
  for (const reference of references) {
    const path = await exportShaAttachment(reference[1], dir, objectsDir);
    if (path) bridged = bridged.replace(reference[0], imageToolGuidance(path, mode));
  }
  return bridged;
}

/** 判断消息是否含 image content block。 */
export function hasImageBlock(messages) {
  return (messages ?? []).some(
    (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'image'),
  );
}

/** 深冻结（与 harness 对持久消息的冻结一致）。 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** 导出 attachment 到磁盘，返回路径（按 attachmentId 缓存，进程内复用）。 */
const exportedPaths = new Map();
export async function exportImage(attachment, ctx, dir) {
  const cached = exportedPaths.get(attachment.attachmentId);
  if (cached) return cached;
  let data;
  const attachments = ctx.get?.('attachments') ?? ctx.attachments;
  try {
    ({ data } = await attachments.readImage(attachment));
  } catch (error) {
    throw new Error(`picturereader: cannot read pasted image: ${String(error && error.message || error)}`);
  }
  await mkdir(dir, { recursive: true });
  const ext = EXT_BY_MEDIA[attachment.mediaType] ?? '.img';
  const safeName = attachment.name
    ? attachment.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 40)
    : '';
  const base = (safeName ? `${safeName}_` : '') + attachment.attachmentId.slice(0, 12);
  const path = join(dir, `${base}${ext}`);
  await writeFile(path, data);
  exportedPaths.set(attachment.attachmentId, path);
  return path;
}

/**
 * 把消息里的 image block 替换成文本引导。纯函数（可测）。
 * 读取当前 runtime mode 生成对应策略。
 * @param {Array} messages - 待处理消息。
 * @param {object} ctx - 提供 ctx.attachments。
 * @param {string} dir - 图片导出目录。
 * @returns {Promise<Array>} 处理后消息（图片消息被替换成 fresh frozen 对象）。
 */
export async function bridgeMessages(messages, ctx, dir, { attachmentObjectsDir } = {}) {
  const mode = getRuntimeConfig()?.mode ?? 'smart';
  const next = [];
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) {
      next.push(message);
      continue;
    }
    const blocks = [];
    let changed = false;
    for (const block of content) {
      if (block?.type === 'image') {
        let path;
        try {
          path = await exportImage(block.attachment, ctx, dir);
        } catch {
          // 导出失败时回退成纯提示，不让整轮崩。
          blocks.push({ type: 'text', text: '[图片附件已粘贴，将尝试读取分析]' });
          changed = true;
          continue;
        }
        const name = block.attachment.name ? `（${block.attachment.name}）` : '';
        blocks.push({ type: 'text', text: imageToolGuidance(path, mode, name) });
        changed = true;
        continue;
      }
      if (block?.type === 'text' && typeof block.text === 'string') {
        const text = await bridgeShaAttachmentText(block.text, dir, mode, attachmentObjectsDir);
        if (text !== block.text) {
          blocks.push({ ...block, text });
          changed = true;
          continue;
        }
      }
      blocks.push(block);
    }
    next.push(changed ? deepFreeze({ ...message, content: blocks }) : message);
  }
  return next;
}

/**
 * 注册图片桥（agent/pre-step 桥 + llm/stream 兜底 + read_image 拦截）。
 * @param {object} ctx - Cordis 上下文（inject: tools/llm/attachments）。
 * @param {() => object} 未使用 getConfig —— mode 从 runtime 读，保持实时。
 */
export function attachImageBridge(ctx) {
  const debug = getRuntimeConfig()?.debug === true;
  if (debug) console.log('[picturereader] attachImageBridge called, ctx keys:', Object.keys(ctx || {}));
  // 注意：不在 agent/pre-step 读图降级 —— 该阶段图片 attachment 可能尚未落盘，
  // readImage 读不到会报错。真正的图片降级/分析放在 llm/stream（适配器层，此时
  // attachment 已保存）完成。

  // llm/stream 兜底：还带着 image block 的非多模态请求，降级后放行。
  ctx.on('llm/stream', (options, next) => {
    const hasImage = hasImageBlock(options?.messages);
    const hasShaAttachment = hasShaAttachmentReference(options?.messages);
    if (debug) {
      console.log('[picturereader] llm/stream fired, model=', options?.model, 'hasImage=', hasImage, 'hasShaAttachment=', hasShaAttachment, 'messagesCount=', options?.messages?.length);
      if (hasImage || hasShaAttachment) {
        console.log('[picturereader] Image input detected, processing...');
      }
    }
    return (async function* () {
      let downstream;
      try {
        const rt = getRuntimeConfig();
        const guardOn = rt?.requestGuard !== false;
        const multimodal = rt?.multimodalModels || [];
        const model = options?.model || '';
        const inWhitelist = multimodal.includes(model);

        if (debug) console.log('[picturereader] Bridge config:', { guardOn, inWhitelist, hasImage, hasShaAttachment, mode: rt?.mode });

        if (guardOn && !inWhitelist && (hasImage || hasShaAttachment)) {
          const exportDir = (rt?.bridge?.exportDir || '').trim() || join(os.tmpdir(), 'picturereader-bridge');
          if (debug) console.log('[picturereader] Processing images, exportDir:', exportDir);
          const before = options.messages.reduce((n, m) => n + (Array.isArray(m?.content) ? m.content.filter(b => b?.type === 'image').length : 0), 0);
          const messages = await bridgeMessages(options.messages, ctx, exportDir);
          const after = messages.reduce((n, m) => n + (Array.isArray(m?.content) ? m.content.filter(b => b?.type === 'image').length : 0), 0);
          const changed = messages.some((m, i) => m !== options.messages[i]);
          if (debug) console.log(`[picturereader] llm/stream images before=${before} after=${after} changed=${changed} model=${options.model}`);
          if (changed) {
            if (debug) console.log('[picturereader] Messages changed, calling next with modified messages');
            downstream = next({ ...options, messages });
          } else {
            if (debug) console.log('[picturereader] Messages not changed, using original');
          }
        } else {
          if (debug) console.log('[picturereader] Skipping image processing:', { guardOn, inWhitelist, hasImage, hasShaAttachment });
        }
      } catch (error) {
        console.log('[picturereader] llm/stream downgrade failed:', String(error && error.message || error));
      }
      yield* downstream ?? next();
    })();
  });

  // tools/post-execute 拦截：当 read_image 成功执行但返回了 image block 时，
  // 将其替换为文本引导，避免后续请求因 image block 导致 UNSUPPORTED_CONTENT 错误。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (exec.name === 'read_image' && !result.isError) {
        // 检查结果中是否包含 image block
        const hasImage = result.content?.some(b => b.type === 'image');
        if (hasImage) {
          const filePath = exec.arguments?.file_path || 'the image file';
          // 替换为文本引导，移除 image block
          result = {
            ...result,
            content: [{
              type: 'text',
              text: `[图片已读取: ${filePath}]\n\n当前模型不支持图像输入，无法直接处理图片。请使用 picturereader 的工具来分析此图片：\n- image_scan(file_path="${filePath}") — 像素级扫描，看布局/颜色/结构\n- image_ocr(file_path="${filePath}") — 文字识别\n- vision_analyze(file_path="${filePath}") — 统一图像理解\n\n这些工具适用于所有模型，不需要模型支持图像输入。`
            }]
          };
          console.log('[picturereader] intercepted read_image image block, replaced with text guidance');
        }
      }
    } catch (error) {
      console.log('[picturereader] tools/post-execute intercept failed:', String(error && error.message || error));
    }
    return next();
  });
}
