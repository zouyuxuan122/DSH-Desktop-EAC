/**
 * VLM (Vision Language Model) bridge for picturereader.
 *
 * Talks to any OpenAI-compatible chat-completions endpoint that accepts
 * image_url data URIs. When the endpoint is a managed local llama-server
 * and it is not healthy, this module can auto-start it with the configured
 * multimodal model and (optionally) stop it after the request.
 *
 * @module picturereader/vlm
 */

import { spawn } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getRuntimeConfig } from './runtime.js';

// ---------------------------------------------------------------------------
// Configuration (environment variables first, then DSH settings.yaml fallback)
// ---------------------------------------------------------------------------

/**
 * Try to read DSH settings.yaml and extract tool-vision config.
 * @returns {Promise<{baseURL: string, model: string, apiKey: string}|null>}
 */
async function readDshToolVisionConfig() {
  try {
    const settingsPath = join(homedir(), '.dsh', 'settings.yaml');
    const content = await readFile(settingsPath, 'utf-8');
    // Simple YAML parsing for tool-vision section
    const lines = content.split('\n');
    let inToolVision = false;
    let baseURL = '';
    let model = '';
    let apiKey = '';
    let indent = -1;

    for (const line of lines) {
      // Detect start of tool-vision section
      if (line.match(/^tool-vision:\s*$/)) {
        inToolVision = true;
        indent = -1;
        continue;
      }

      if (inToolVision) {
        // Check if we've left the section (non-empty line with less or equal indent)
        const match = line.match(/^(\s*)\S/);
        if (match) {
          const currentIndent = match[1].length;
          if (indent === -1) {
            indent = currentIndent;
          } else if (currentIndent <= 0) {
            // New top-level key, exit tool-vision section
            break;
          }
        }

        // Parse key-value pairs
        const kvMatch = line.match(/^\s+(\w+):\s*(.+)$/);
        if (kvMatch) {
          const [, key, value] = kvMatch;
          const cleanValue = value.replace(/^["']|["']$/g, '').trim();
          if (key === 'baseURL') baseURL = cleanValue;
          else if (key === 'model') model = cleanValue;
          else if (key === 'apiKey') apiKey = cleanValue;
        }
      }
    }

    if (baseURL) {
      return { baseURL, model, apiKey };
    }
  } catch {
    // Settings file not found or parse error, ignore
  }
  return null;
}

/**
 * Read DSH settings.yaml and extract the `picturereader` namespace's VLM
 * fields (vlm_base / vlm_model / vlm_key). These come from the plugin's own
 * settings card and take priority over the legacy tool-vision namespace,
 * so the user's configured endpoint is honoured even when the plugin packs
 * a newer schema.
 * @returns {Promise<{baseURL: string, model: string, apiKey: string}|null>}
 */
async function readDshPicturereaderConfig() {
  try {
    const settingsPath = join(homedir(), '.dsh', 'settings.yaml');
    const content = await readFile(settingsPath, 'utf-8');
    const lines = content.split('\n');
    let inNs = false;
    let baseURL = '';
    let model = '';
    let apiKey = '';
    let indent = -1;
    const KEY_MAP = { vlm_base: 'baseURL', vlm_model: 'model', vlm_key: 'apiKey' };

    for (const line of lines) {
      if (line.match(/^picturereader:\s*$/)) {
        inNs = true;
        indent = -1;
        continue;
      }
      if (inNs) {
        const match = line.match(/^(\s*)\S/);
        if (match) {
          const currentIndent = match[1].length;
          if (indent === -1) {
            indent = currentIndent;
          } else if (currentIndent <= 0) {
            break;
          }
        }
        const kvMatch = line.match(/^\s+(\w+):\s*(.+)$/);
        if (kvMatch) {
          const [, key, value] = kvMatch;
          const target = KEY_MAP[key];
          const cleanValue = value.replace(/^["']|["']$/g, '').trim();
          if (target === 'baseURL') baseURL = cleanValue;
          else if (target === 'model') model = cleanValue;
          else if (target === 'apiKey') apiKey = cleanValue;
        }
      }
    }
    if (baseURL) return { baseURL, model, apiKey };
  } catch {
    // ignore parse errors
  }
  return null;
}

// Read config: priority env → picturereader namespace → legacy tool-vision namespace
const dshConfig = await readDshToolVisionConfig();
const dshPictConfig = await readDshPicturereaderConfig();

// ---------------------------------------------------------------------------
// GLM-4V-Flash: free built-in vision model from Zhipu AI
// https://open.bigmodel.cn — register to get your API key
// ---------------------------------------------------------------------------

/** GLM-4V-Flash default endpoint (OpenAI-compatible). */
const GLM4V_BASE = 'https://open.bigmodel.cn/api/paas/v4';
/** GLM-4V-Flash model name. */
const GLM4V_MODEL = 'glm-4v-flash';

/**
 * Resolve the GLM-4V-Flash API key.
 * Priority: env SEE_API_KEY > env GLM_API_KEY > DSH settings.yaml apiKey > empty.
 */
function resolveGlm4vKey() {
  return process.env.SEE_API_KEY ?? process.env.GLM_API_KEY ?? dshConfig?.apiKey ?? '';
}

/** OpenAI-compatible VLM endpoint (empty = VLM disabled). */
export const DEFAULT_BASE = process.env.SEE_BASE ?? dshPictConfig?.baseURL ?? dshConfig?.baseURL ?? GLM4V_BASE;
/** VLM model name. */
export const DEFAULT_MODEL = process.env.SEE_MODEL ?? dshPictConfig?.model ?? dshConfig?.model ?? GLM4V_MODEL;
/** Local llama-server executable path. */
export const DEFAULT_SERVER_EXE = process.env.SEE_SERVER_EXE ?? '';
/** Local model GGUF path. */
export const DEFAULT_SERVER_MODEL = process.env.SEE_SERVER_MODEL ?? '';
/** Vision projector path. */
export const DEFAULT_SERVER_MMPROJ = process.env.SEE_SERVER_MMPROJ ?? '';
/** Local server port. */
export const DEFAULT_PORT = Number(process.env.SEE_SERVER_PORT ?? 8080);
/** GPU layers for local server. */
export const DEFAULT_NGL = process.env.SEE_SERVER_NGL ?? '20';
/** Context size for local server. */
export const DEFAULT_CTX = Number(process.env.SEE_SERVER_CTX ?? 16384);
/** API key for remote endpoints (env > picturereader ns > legacy tool-vision ns > GLM). */
export const DEFAULT_API_KEY =
  process.env.SEE_API_KEY ?? dshPictConfig?.apiKey ?? dshConfig?.apiKey ?? process.env.GLM_API_KEY ?? '';

let serverStartPromise = null;
let serverChild = null;

/**
 * Effective API key: runtime explicit key → runtime env var → static default.
 * @param {object} rt - runtime config (may be undefined).
 * @returns {string}
 */
function effectiveApiKey(rt) {
  if (rt?.vlm?.apiKey) return rt.vlm.apiKey;
  const envName = rt?.vlm?.apiKeyEnv;
  if (envName) {
    const fromEnv = process.env[envName];
    if (fromEnv) return fromEnv;
  }
  return DEFAULT_API_KEY;
}

/**
 * Effective endpoint base URL: runtime explicit → static default.
 * @param {object} rt
 * @returns {string}
 */
function effectiveBase(rt) {
  return (rt?.vlm?.baseUrl || '').trim() || DEFAULT_BASE;
}

/**
 * Check if VLM is configured (has a base URL and API key for cloud endpoints).
 * 隐私模式（privacy）为硬门禁：即使配置了外部 API 也返回 false，绝不外呼。
 * @returns {boolean} true when VLM endpoint is configured and ready to use.
 */
export function isVlmConfigured() {
  const rt = getRuntimeConfig();
  if (rt?.mode === 'privacy') return false;
  // 选配（vlm_enabled）未勾选：即使配置了端点/Key 也视为未启用外部 VLM。
  if (rt?.vlm?.enabled === false) return false;
  const base = effectiveBase(rt);
  if (base.length === 0) return false;
  // Cloud endpoints require an API key; local endpoints (127.0.0.1/localhost) don't
  const isLocal = isLocalEndpoint(base);
  if (!isLocal && effectiveApiKey(rt).length === 0) return false;
  return true;
}

/**
 * Build health check URL from base URL.
 * @param {string} baseURL - the VLM endpoint base URL.
 * @returns {string} health check URL.
 */
export function healthUrlOf(baseURL) {
  return baseURL.replace(/\/v1$/, '').replace(/\/+$/, '') + '/health';
}

/**
 * Probe VLM endpoint health.
 * @param {string} baseURL - the VLM endpoint base URL.
 * @param {number} timeoutMs - timeout in milliseconds.
 * @returns {Promise<boolean>} true when healthy.
 */
export async function probe(baseURL, timeoutMs = 3000) {
  try {
    const res = await fetch(healthUrlOf(baseURL), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check if the endpoint is on localhost (no API key required).
 * @param {string} baseURL - the VLM endpoint base URL.
 * @returns {boolean} true when it's a local endpoint.
 */
function isLocalEndpoint(baseURL) {
  const u = baseURL.replace(/\/v1$/, '').replace(/\/+$/, '');
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u);
}

/**
 * Check if the endpoint is a managed local server.
 * @param {string} baseURL - the VLM endpoint base URL.
 * @param {number} port - the expected port.
 * @returns {boolean} true when it's a managed local endpoint.
 */
function isManagedEndpoint(baseURL, port) {
  const u = baseURL.replace(/\/v1$/, '').replace(/\/+$/, '');
  const m = u.match(/^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/);
  return m !== null && Number(m[2]) === port;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build llama-server command arguments.
 * @param {object} config - VLM configuration.
 * @returns {string[]} command arguments.
 */
export function buildServerArgs(config) {
  return [
    '-m', config.serverModel,
    '--mmproj', config.serverMmproj,
    '-ngl', String(config.ngl),
    '--ctx-size', String(config.ctxSize),
    '--parallel', '1',
    '--load-mode', 'none',
    '--threads', '16',
    '--threads-batch', '32',
    '--batch-size', '2048',
    '--ubatch-size', '512',
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--flash-attn', 'on',
    '--fit', 'off',
    '--split-mode', 'none',
    '--main-gpu', '0',
    '--prio', '1',
    '--jinja',
    '--reasoning', 'on',
    '--image-min-tokens', '1024',
    '--alias', config.model,
    '--host', '127.0.0.1',
    '--port', String(config.serverPort),
  ];
}

/**
 * Start local llama-server.
 * @param {object} config - VLM configuration.
 * @returns {Promise<ChildProcess>} the server process.
 */
async function startLocalServer(config) {
  for (const p of [config.serverExe, config.serverModel, config.serverMmproj]) {
    try {
      await stat(p);
    } catch {
      throw new Error(`picturereader: local server file not found: ${p}`);
    }
  }

  process.env.GGML_CUDA_NO_PINNED = '1';
  const child = spawn(config.serverExe, buildServerArgs(config), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  serverChild = child;

  const deadline = Date.now() + config.healthTimeoutMs;
  while (Date.now() < deadline) {
    if (await probe(config.baseURL, 2000)) return child;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(1000);
  }
  try {
    child.kill('SIGKILL');
  } catch {}
  throw new Error(
    `picturereader: local llama-server failed to become healthy at ${healthUrlOf(config.baseURL)} within ${config.healthTimeoutMs}ms`,
  );
}

/**
 * Ensure local llama-server is running (auto-start if needed).
 * @param {object} config - VLM configuration.
 * @returns {Promise<ChildProcess|null>} the server process, or null if not managed.
 */
export async function ensureServer(config) {
  if (!config.autoStart || !isManagedEndpoint(config.baseURL, config.serverPort)) {
    return null;
  }
  if (await probe(config.baseURL, 3000)) {
    serverStartPromise = null;
    return serverChild;
  }
  if (serverStartPromise !== null) {
    try {
      await serverStartPromise;
    } catch {
      serverStartPromise = null;
    }
    if (await probe(config.baseURL, 3000)) return serverChild;
  }
  serverStartPromise = startLocalServer(config).finally(() => {
    serverStartPromise = null;
  });
  await serverStartPromise;
  return serverChild;
}

/**
 * Stop local llama-server if running.
 */
export async function stopServer() {
  if (serverChild && serverChild.exitCode === null && serverChild.signalCode === null) {
    try {
      serverChild.kill('SIGKILL');
    } catch {}
  }
  serverChild = null;
  serverStartPromise = null;
}

/**
 * Send one image-only request to the VLM endpoint.
 * @param {object} config - VLM configuration.
 * @param {Array<{mime: string, base64: string}>} images - images to send.
 * @param {string} prompt - the prompt text.
 * @returns {Promise<string>} VLM response text.
 */
export async function sendVisionRequest(config, images, prompt) {
  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } });
  }

  const body = {
    model: config.model,
    stream: false,
    messages: [{ role: 'user', content }],
    max_tokens: config.maxTokens,
  };

  const headers = {
    'content-type': 'application/json',
  };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  const base = String(config.baseURL || '').trim().replace(/\/+$/, '');
  let endpoint;
  if (/\/v\d+\/chat\/completions$/.test(base) || /\/chat\/completions$/.test(base)) {
    endpoint = base;
  } else if (/\/v\d+$/.test(base)) {
    endpoint = `${base}/chat/completions`;
  } else {
    // OpenAI 兼容端点统一用 /v1/chat/completions（LM Studio / llama-server / 云端网关等）
    endpoint = `${base}/v1/chat/completions`;
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`picturereader: VLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const contentText = json?.choices?.[0]?.message?.content;
  if (typeof contentText !== 'string' || contentText.length === 0) {
    throw new Error('picturereader: VLM returned empty content');
  }
  return contentText;
}

/**
 * Build default VLM configuration.
 * @param {object} overrides - configuration overrides.
 * @returns {object} VLM configuration.
 */
export function defaultVlmConfig(overrides = {}) {
  const rt = getRuntimeConfig();
  return {
    baseURL: effectiveBase(rt),
    apiKey: effectiveApiKey(rt),
    model: (rt?.vlm?.model || '').trim() || DEFAULT_MODEL,
    serverExe: DEFAULT_SERVER_EXE,
    serverModel: DEFAULT_SERVER_MODEL,
    serverMmproj: DEFAULT_SERVER_MMPROJ,
    serverPort: DEFAULT_PORT,
    ngl: DEFAULT_NGL,
    ctxSize: DEFAULT_CTX,
    autoStart: true,
    healthTimeoutMs: 120_000,
    requestTimeoutMs: rt?.vlm?.requestTimeoutMs ?? 300_000,
    maxTokens: rt?.vlm?.maxTokens ?? 8192,
    ...overrides,
  };
}
