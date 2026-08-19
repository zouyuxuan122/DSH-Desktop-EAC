/**
 * picturereader 视觉孪生 adapter
 *
 * 用 Proxy 把已注册的 adapter（如 PiAiAdapter，它服务 opencode-go / deepseek
 * / xiaomi / qiu 等多个 provider）包装成"孪生"：
 *
 *  - listModels / resolveModel：将被勾选的模型标成 inputModalities:['text',
 *    'image'] + 名称加「(视觉)」后缀 → DSH 原生缩略图/图片块进会话。
 *  - stream：拦截请求里的 image block → 用 picturereader 本地工具链分析 → 替换
 *    成文本 → 再转发给原始 adapter（pi-ai 收到纯文本，不会 UNSUPPORTED_CONTENT）。
 *
 * @module picturereader/picturereader-vision
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { contentHasImage } from '@deepseek-ai/dsh-llm';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const IMAGE_DIR = join(DSH_HOME, 'picturereader-vision', 'images');

/** 从配置读取被勾选的模型 Map<provider/id, entry>。 */
function selectedMap(getConfig) {
  try {
    const cfg = getConfig?.();
    const list = cfg?.vision_models;
    if (!Array.isArray(list)) return new Map();
    const map = new Map();
    for (const m of list) {
      const id = typeof m === 'string' ? m : m.id;
      const provider = (typeof m === 'object' ? m.provider : '') || '';
      if (id) map.set(provider + '/' + id, m);
    }
    return map;
  } catch { return new Map(); }
}

function isSelected(getConfig, provider, id) {
  const map = selectedMap(getConfig);
  return map.has(provider + '/' + id);
}

function noteOf(getConfig, provider, id) {
  const map = selectedMap(getConfig);
  const entry = map.get(provider + '/' + id);
  return entry && typeof entry === 'object' ? (entry.note || '') : '';
}

/** 给被勾选模型注入视觉元数据（inputModalities / pi-ai 的 input）。 */
function applyVisionMeta(model, provider, getConfig) {
  if (!model || !isSelected(getConfig, provider, model.id)) return model;
  const note = noteOf(getConfig, provider, model.id);
  const suffix = note ? ` (${note})` : ' (视觉)';
  const out = { ...model, name: (model.name || model.id) + suffix, inputModalities: ['text', 'image'] };
  // pi-ai 系列用 `input` 数组；一并注入，保证 resolveModel 也通过。
  if ('input' in model) out.input = [...model.input, 'image'];
  return out;
}

/** 把图片字节落盘为临时文件，返回路径。 */
async function saveImageBytes(bytes, mediaType) {
  await mkdir(IMAGE_DIR, { recursive: true });
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 24);
  const ext = mediaType === 'image/jpeg' ? '.jpg'
    : mediaType === 'image/webp' ? '.webp'
      : mediaType === 'image/gif' ? '.gif' : '.png';
  const path = join(IMAGE_DIR, hash + ext);
  try { await writeFile(path, bytes, { flag: 'wx' }); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
  return path;
}

/** 读图（经 attachments）并做本地说明，返回一段文本证据（path 供工具续读）。 */
async function analyzeImage(block, attachments) {
  let data;
  try {
    ({ data } = await attachments.readImage(block.attachment));
  } catch (e) {
    return `[图片]（读取失败：${e?.message || e}），请用 image_scan 分析附件`;
  }
  const path = await saveImageBytes(data, block.attachment.mediaType);
  return `[用户粘贴了一张图片]\n图片已导出到：${path}\n请先用 image_scan 分析该图片（如含文字再用 image_ocr），结合内容回答。`;
}

/** 把消息里的 image block 替换成分析文本。 */
async function sanitizeImages(ctx, messages) {
  const attachments = ctx.get?.('attachments') ?? ctx.attachments;
  const next = [];
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content) || !content.some((b) => b?.type === 'image')) { next.push(message); continue; }
    const blocks = [];
    for (const block of content) {
      if (block?.type !== 'image') { blocks.push(block); continue; }
      blocks.push({ type: 'text', text: await analyzeImage(block, attachments) });
    }
    next.push({ ...message, content: blocks });
  }
  return next;
}

/**
 * 对被选中模型所属的 provider，用 Proxy 包装原始 adapter 成孪生并原位替换
 * registration.adapter（避免 DUPLICATE_ADAPTER）。返回注册数；注册者用 ctx.effect
 * 在卸载时恢复原 adapter。
 */
export function registerTwinAdapters(ctx, llm, getConfig) {
  if (!llm || !getConfig) return 0;
  const map = selectedMap(getConfig);
  const providers = new Set();
  for (const key of map.keys()) {
    const prov = key.split('/')[0];
    if (prov) providers.add(prov);
  }

  const restores = [];
  let count = 0;
  for (const provider of providers) {
    let reg;
    try { reg = llm.registration(provider); } catch { continue; }
    if (!reg || !reg.adapter) continue;
    const orig = reg.adapter;

    const origList = orig.listModels.bind(orig);
    const origResolve = orig.resolveModel.bind(orig);
    const origStream = orig.stream.bind(orig);

    const twin = new Proxy(orig, {
      get(target, prop, receiver) {
        if (prop === 'listModels') {
          return async (p) => (await origList(p)).map((m) => applyVisionMeta(m, p, getConfig));
        }
        if (prop === 'resolveModel') {
          return async (p, m, signal) => applyVisionMeta(await origResolve(p, m, signal), p, getConfig);
        }
        if (prop === 'stream') {
          return async function* (options) {
            if (options?.messages?.some((msg) => contentHasImage(msg?.content))) {
              options = { ...options, messages: await sanitizeImages(ctx, options.messages) };
            }
            yield* origStream(options);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    reg.adapter = twin;
    restores.push({ reg, orig });
    count++;
  }

  if (count > 0) console.log(`[picturereader] vision twin active on provider(s): ${[...providers].join(', ')}`);

  if (restores.length > 0) {
    ctx.effect(
      () => () => { for (const { reg, orig } of restores) reg.adapter = orig; },
      'picturereader: vision twin restore',
    );
  }
  return count;
}
