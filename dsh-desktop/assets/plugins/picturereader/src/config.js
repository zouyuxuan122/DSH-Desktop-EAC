/**
 * picturereader 设置命名空间 (config.js) — 纯逻辑部分
 *
 * schema（schemastery）在宿主侧 index.js 定义（DSH 运行时才可解析
 * @deepseek-ai/schemastery）；本模块只保留可独立测试的解析纯函数。
 *
 * 字段采用扁平 key（与 dsh-tool-vision 一致），避免嵌套带来的 YAML 歧义：
 *   mode            三模式（privacy / smart / strict）
 *   vlm_base        OpenAI 兼容视觉端点 URL
 *   vlm_model       视觉模型名
 *   vlm_key         视觉 API key（role:'secret'，只写不读、保存可覆盖、不回显）
 *   vlm_key_env     环境变量名（vlm_key 为空时回退读取）
 *   ocr_engine      默认 OCR 引擎（windows / paddle / rapid）
 * @module picturereader/config
 */

/** 本插件拥有的设置命名空间名。 */
export const NS = 'picturereader';

/** 合法模式（与 routing.MODE_KEYS 一致，避免循环依赖单独声明）。 */
export const MODE_KEYS = ['privacy', 'smart', 'strict'];

/** 合法 OCR 引擎。 */
export const OCR_ENGINE_KEYS = ['windows', 'paddle', 'rapid'];

/**
 * 把扁平配置映射成稳定的模式值（容错非法输入）。
 * @param {object} value - 原始配置对象。
 * @returns {'privacy'|'smart'|'strict'}
 */
export function modeOf(value) {
  const m = String(value?.mode ?? 'smart').trim();
  return MODE_KEYS.includes(m) ? m : 'smart';
}

/**
 * 从扁平配置解析 VLM 端点信息。
 * @param {object} value
 * @returns {{baseUrl:string, model:string, apiKey:string, apiKeyEnv:string}}
 */
export function vlmConfigOf(value) {
  const v = value ?? {};
  return {
    baseUrl: String(v.vlm_base ?? ''),
    model: String(v.vlm_model ?? ''),
    apiKey: String(v.vlm_key ?? ''),
    apiKeyEnv: String(v.vlm_key_env ?? ''),
  };
}

/**
 * 解析默认 OCR 引擎（容错）。
 * @param {object} value
 * @returns {'windows'|'paddle'|'rapid'}
 */
export function ocrEngineOf(value) {
  const e = String(value?.ocr_engine ?? 'windows').trim();
  return OCR_ENGINE_KEYS.includes(e) ? e : 'windows';
}

/** 读取 API key：优先 vlm_key，其次 环境变量 vlm_key_env，最后 ''。 */
export function resolveVlmApiKey(vlm) {
  if (vlm?.apiKey) return vlm.apiKey;
  const envName = vlm?.apiKeyEnv;
  if (envName) {
    const fromEnv = process.env[envName];
    if (fromEnv) return fromEnv;
  }
  return '';
}
