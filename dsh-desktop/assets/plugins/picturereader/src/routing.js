/**
 * picturereader 三模式路由 (routing.js)
 *
 * 用户在设置卡里选择一个使用模式，控制"什么时候走外部 VLM API、什么时候
 * 只用本地工具、要不要交叉验证"。这把语义集中在这里，供各工具 / 图片桥 /
 * vision_analyze 共享，保证行为一致：
 *
 * - privacy（隐私）：无论是否配置了外部 API 一律不调用。所有路线只走本地
 *   （image_scan / image_ocr / image_sample）。硬 gate，绝不外呼。
 * - smart（智能）：让 LLM 先简单看图（image_scan），再自己选是走外部 API、
 *   自己看细节、还是 OCR，目标是减少调用轮数与耗时。
 * - strict（严谨）：LLM 自行选择路线，在必要时交叉验证（多证据对照），
 *   可以仔细查看细节。
 *
 * @module picturereader/routing
 */

/** 三模式取值。 */
export const MODES = Object.freeze({
  privacy: 'privacy',
  smart: 'smart',
  strict: 'strict',
});

/** 三模式中文标签。 */
export const MODE_LABELS = Object.freeze({
  privacy: '隐私模式',
  smart: '智能模式',
  strict: '严谨模式',
});

/** 三模式英文标签。 */
export const MODE_LABELS_EN = Object.freeze({
  privacy: 'Privacy',
  smart: 'Smart',
  strict: 'Strict',
});

/** 合法模式集合。 */
export const MODE_KEYS = Object.freeze(Object.keys(MODES));

/** 归一化任意输入为一个合法模式值；非法值回退默认 'smart'。 */
export function normalizeMode(raw) {
  const v = String(raw ?? '').trim();
  return MODE_KEYS.includes(v) ? v : MODES.smart;
}

/**
 * 某模式下是否允许调用外部 VLM / 任何网络视觉 API。
 * 隐私模式为硬门禁：即使配置了外部 API 也不调用。
 * @param {string} mode - 归一化后的模式。
 * @returns {boolean} true=允许外呼（smart/strict），false=禁用（privacy）。
 */
export function vlmAllowed(mode) {
  return normalizeMode(mode) !== MODES.privacy;
}

/**
 * 隐私模式下即使配置了外部 API 也要强制本地——这是对 vision_analyze /
 * 图片桥的硬约束说明。
 */
export function isPrivacy(mode) {
  return normalizeMode(mode) === MODES.privacy;
}

/**
 * 某模式下 vision_analyze 的推荐证据默认。
 * @param {string} mode
 * @returns {{includeScan:boolean, includeOcr:boolean, includeVlm:boolean, allowLowInfo:boolean}}
 */
export function visionAnalyzeDefaults(mode) {
  const m = normalizeMode(mode);
  if (m === MODES.privacy) {
    // 隐私：本地证据为主，VLM 永远归零。
    return { includeScan: true, includeOcr: true, includeVlm: false, allowLowInfo: false };
  }
  if (m === MODES.smart) {
    // 智能：先 scan，OCR 按需，能调外部 VLM（省轮数靠"值得才调"引导）。
    return { includeScan: true, includeOcr: false, includeVlm: true, allowLowInfo: false };
  }
  // strict：全证据 + 允许多看细节，必要时交叉验证。
  return { includeScan: true, includeOcr: true, includeVlm: true, allowLowInfo: false };
}

/**
 * 把模式策略转成给纯文本 LLM 的中文行为引导（用于图片桥 hint、也用于
 * vision_analyze 的描述构成，让模型据此决定路线）。
 * @param {string} mode - 归一化后的模式。
 * @param {{vlmConfigured: boolean}} [opts]
 * @returns {string} 一段给模型的行为说明。
 */
export function routePolicyText(mode, opts = {}) {
  const m = normalizeMode(mode);
  const vlmConfigured = opts.vlmConfigured === undefined ? true : !!opts.vlmConfigured;
  if (m === MODES.privacy) {
    return (
      '【当前模式：隐私模式】绝不调用任何外部视觉 API，也不访问网络看模型。' +
      '对每张图只能使用本地工具：image_scan（看布局/颜色/结构）、image_ocr（读文字）、' +
      'image_sample（细看材质纹理）。请用这些本地工具自行理解图片内容。'
    );
  }
  if (m === MODES.smart) {
    return (
      '【当前模式：智能模式】先用 image_scan 快速看一眼图片（布局/颜色/是否含文字/是否照片）。' +
      '然后自行判断：' +
      '（1）若图片以文字为主 → 用 image_ocr 读文字即可，不必调 VLM；' +
      '（2）若图片是普通图表/界面/简单内容 → 用 image_scan + image_sample 自己看就能说清，不必调 VLM；' +
      '（3）仅当图片内容复杂、需要语义理解（如照片、抽象画面）' +
      (vlmConfigured ? '且值得时，才调用 vision_analyze(include_vlm=true) 走外部 VLM' : '）时才尝试 VLM，但当前未配置外部 VLM，尽量用本地工具') +
      '。目标是减少调用轮数与耗时，能本地就别外呼。'
    );
  }
  return (
    '【当前模式：严谨模式】自行选择路线并追求可靠：先用 image_scan 了解整体，' +
    '必要时用 image_ocr 读文字、image_sample 细看细节。对关键判断采用交叉验证：' +
    '把 image_scan / image_ocr ( / 外部 VLM) 多种证据相互对照，不轻易下结论。' +
    (vlmConfigured ? '需要语义理解且值得时可用 vision_analyze(include_vlm=true) 走外部 VLM。' : '当前未配置外部 VLM，优先用本地工具自行理解。') +
    '可以仔细查看细节，但要避免幻觉、给出有依据的描述。'
  );
}

/**
 * 渲染一条批量/桥接时用的简短模式说明（首行），供 hint 复用。
 * @param {string} mode
 * @returns {string}
 */
export function routeModeTag(mode) {
  const m = normalizeMode(mode);
  return `[模式:${MODE_LABELS[m]}]`;
}
