/**
 * picturereader 运行时配置快照 (runtime.js)
 *
 * host 侧（index.js）注册 picturereader 设置命名空间后，把每次读取到的
 * 最新配置（mode + VLM 显式配置）注入本模块。各工具 / vlm.js /
 * vision-analyze.js / 图片桥在 execute 时读 getRuntimeConfig() 得到当前
 * 有效的模式与视觉端点，从而做到"改设置热生效 + privacy 硬 gate"。
 *
 * 两种注入方式：
 *  - setRuntimeConfig(cfg)：直接替换快照（测试 / 手动）。
 *  - setRuntimeSource(fn)：注册一个返回原始 config 的 getter（host 用
 *    installSettingsSection 的 getConfig），读取时惰性缓存最新值，保证
 *    mode / vlm 配置热更立即生效。
 *
 * 设计要点：vlm.js 顶部的静态 DEFAULT_BASE 等只是后盾（env / settings.yaml /
 * GLM 默认），runtime 里显式填写的 vlm 配置优先级最高；而 `mode` 的快照使
 * privacy 模式在任意调用点都能被识别，彻底拦截外部调用。
 *
 * @module picturereader/runtime
 */

import { normalizeMode } from './routing.js';

let current = { mode: 'smart', vlm: { baseUrl: '', model: '', apiKey: '', apiKeyEnv: '' } };
let sourceFn = null;

/** 从原始扁平 config 构建快照。 */
function build(raw) {
  const v = raw || {};
  return {
    mode: normalizeMode(v.mode),
    vlm: {
      baseUrl: String(v.vlm_base ?? ''),
      model: String(v.vlm_model ?? ''),
      apiKey: String(v.vlm_key ?? ''),
      apiKeyEnv: String(v.vlm_key_env ?? ''),
      enabled: v.vlm_enabled === undefined ? Boolean(v.vlm_base) : v.vlm_enabled === true,
      requestTimeoutMs: v.vlm_timeout_ms !== undefined ? Number(v.vlm_timeout_ms) : undefined,
      maxTokens: v.vlm_max_tokens !== undefined ? Number(v.vlm_max_tokens) : undefined,
    },
    bridge: {
      exportDir: String(v.bridge_export_dir ?? ''),
    },
    ocr: {
      engine: String(v.ocr_engine ?? 'windows'),
      language: String(v.ocr_language ?? ''),
    },
    scan: {
      defaultSize: v.scan_default_size !== undefined ? Number(v.scan_default_size) : 32,
      palette: String(v.scan_palette ?? 'auto'),
      mode: String(v.scan_mode ?? 'auto'),
    },
    batch: {
      probeFirst: v.batch_probe_first !== undefined ? Number(v.batch_probe_first) : 3,
      ocrLimitChars: v.batch_ocr_limit_chars !== undefined ? Number(v.batch_ocr_limit_chars) : 800,
    },
    doc: {
      dpi: v.doc_dpi !== undefined ? Number(v.doc_dpi) : 150,
      maxPages: v.doc_max_pages !== undefined ? Number(v.doc_max_pages) : 50,
    },
    maxImageBytes: v.max_image_bytes !== undefined ? Number(v.max_image_bytes) : 52428800,
    multimodalModels: String(v.multimodal_models ?? '').split(',').map(s => s.trim()).filter(Boolean),
    requestGuard: v.request_guard !== undefined ? Boolean(v.request_guard) : true,
    debug: v.debug === true,
  };
}

/** 若注册了 source getter，则先同步一次最新值。 */
function refresh() {
  if (sourceFn) {
    try {
      const raw = sourceFn();
      if (raw !== undefined && raw !== null) current = build(raw);
    } catch {
      // 读取失败则沿用上次快照。
    }
  }
}

/**
 * 注册一个返回原始 config 的 getter（host：() => getConfig()）。
 * @param {() => object|null} fn
 */
export function setRuntimeSource(fn) {
  sourceFn = typeof fn === 'function' ? fn : null;
  refresh();
}

/**
 * 直接替换运行时快照（测试 / 手动）。
 * @param {object} cfg - 支持 {mode, vlm:{...}} 结构，或扁平原始 config
 *   （含 vlm_base/vlm_model/vlm_key/vlm_key_env）。
 */
export function setRuntimeConfig(cfg = {}) {
  // 兼容扁平原始 config（含 vlm_base/vlm_key 等键）与 (mode, vlm) 结构两种形态。
  if (cfg && cfg.vlm === undefined && (cfg.vlm_base !== undefined || cfg.mode !== undefined)) {
    current = build(cfg);
  } else {
    const vlm = {
      baseUrl: String(cfg?.vlm?.baseUrl ?? ''),
      model: String(cfg?.vlm?.model ?? ''),
      apiKey: String(cfg?.vlm?.apiKey ?? ''),
      apiKeyEnv: String(cfg?.vlm?.apiKeyEnv ?? ''),
      // 选配：显式给定则用之；未给定时向后兼容"配了 baseUrl 即视为启用"。
      enabled: cfg?.vlm?.enabled ?? Boolean(cfg?.vlm?.baseUrl),
    };
    current = { mode: normalizeMode(cfg?.mode), vlm };
  }
}

/** 读取运行时快照（返回内部引用；调用方不应修改）。 */
export function getRuntimeConfig() {
  refresh();
  return current;
}

/** 当前有效模式（已归一化）。 */
export function currentMode() {
  refresh();
  return current.mode;
}

/** 当前模式下是否允许外部 VLM（privacy 恒 false）。 */
export function vlmAllowedByRuntime() {
  refresh();
  return current.mode !== 'privacy';
}
