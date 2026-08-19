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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
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
export async function bridgeMessages(messages, ctx, dir) {
  const mode = getRuntimeConfig()?.mode ?? 'smart';
  const policy = routePolicyText(mode, { vlmConfigured: true });
  const next = [];
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content) || !content.some((b) => b?.type === 'image')) {
      next.push(message);
      continue;
    }
    const blocks = [];
    for (const block of content) {
      if (block?.type !== 'image') {
        blocks.push(block);
        continue;
      }
      let path;
      try {
        path = await exportImage(block.attachment, ctx, dir);
      } catch {
        // 导出失败时回退成纯提示，不让整轮崩。
        blocks.push({ type: 'text', text: '[图片附件已粘贴，将尝试读取分析]' });
        continue;
      }
      const name = block.attachment.name ? `（${block.attachment.name}）` : '';
      blocks.push({
        type: 'text',
        text:
          `用户粘贴了一张图片${name}，已导出到：${path}\n` +
          `${routeModeTag(mode)}\n` +
          policy +
          `\n请先用 image_scan 分析 ${path}（如含文字再用 image_ocr）。`,
      });
    }
    next.push(deepFreeze({ ...message, content: blocks }));
  }
  return next;
}

/**
 * 注册图片桥（agent/pre-step 桥 + llm/stream 兜底）。
 * @param {object} ctx - Cordis 上下文（inject: tools/llm/attachments）。
 * @param {() => object} 未使用 getConfig —— mode 从 runtime 读，保持实时。
 */
export function attachImageBridge(ctx) {
  // 注意：不在 agent/pre-step 读图降级 —— 该阶段图片 attachment 可能尚未落盘，
  // readImage 读不到会报错。真正的图片降级/分析放在 llm/stream（适配器层，此时
  // attachment 已保存）完成。

  // llm/stream 兜底：还带着 image block 的非多模态请求，降级后放行。
  ctx.on('llm/stream', (options, next) => {
    console.log('[picturereader] llm/stream fired, model=', options?.model, 'hasImage=', hasImageBlock(options?.messages));
    return (async function* () {
      let downstream;
      try {
        const rt = getRuntimeConfig();
        const guardOn = rt?.requestGuard !== false;
        const multimodal = rt?.multimodalModels || [];
        const model = options?.model || '';
        const inWhitelist = multimodal.includes(model);
        if (guardOn && !inWhitelist && hasImageBlock(options.messages)) {
          const exportDir = (rt?.bridge?.exportDir || '').trim() || join(os.tmpdir(), 'picturereader-bridge');
          const before = options.messages.reduce((n, m) => n + (Array.isArray(m?.content) ? m.content.filter(b => b?.type === 'image').length : 0), 0);
          const messages = await bridgeMessages(options.messages, ctx, exportDir);
          const after = messages.reduce((n, m) => n + (Array.isArray(m?.content) ? m.content.filter(b => b?.type === 'image').length : 0), 0);
          const changed = messages.some((m, i) => m !== options.messages[i]);
          console.log(`[picturereader] llm/stream images before=${before} after=${after} changed=${changed} model=${options.model}`);
          if (changed) {
            downstream = next({ ...options, messages });
          }
        }
      } catch (error) {
        console.log('[picturereader] llm/stream downgrade failed:', String(error && error.message || error));
      }
      yield* downstream ?? next();
    })();
  });
}
