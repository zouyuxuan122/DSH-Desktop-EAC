// dsh-stt — 语音识别（仅 STT）host 半区。
//
// 对齐 SPEECH_DESIGN.md「采集与识别分离」：host 只负责「说了什么」——
// 一个转写接口（multipart audio → text）+ 模型状态/下载。VAD、唤醒词、
// 过滤、合并、门控全部在浏览器 client 半区（可单测、零模型依赖）。
//
//   POST /api/dsh-stt/transcribe   multipart/form-data 字段 audio → { text }
//   GET  /api/dsh-stt/status       模型/引擎状态
//   POST /api/dsh-stt/download     模型下载（仅 ASR）
//
// 所有路由仅接受回环地址请求（isLoopback 防护）。模型首次启动下载到
// ~/.dsh/models/dsh-stt/（可配镜像源），断点续传循环直到文件完整。

import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import https from 'node:https';

const require = createRequire(import.meta.url);

const NAME = 'dsh-stt';
const inject = ['webServer'];

const MODELS_ROOT = join(homedir(), '.dsh', 'models', 'dsh-stt');
const CONFIG_FILE = join(homedir(), '.dsh', 'dsh-stt.json');

// ── 模型清单（下载源可被 config.downloadUrls 覆盖为镜像）─────────────
const DEFAULT_MODELS = {
  asr: {
    name: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2',
    files: ['model.int8.onnx', 'tokens.txt'],
  },
};

const DEFAULT_CONFIG = {
  autoDownload: true,   // 缺模型时自动下载
  downloadUrls: {},     // 覆盖默认下载源（镜像），key: asr（只能手改配置文件）
};

// ── 运行时状态 ───────────────────────────────────────────────
let sherpa = null;            // sherpa-onnx-node 模块（懒加载）
let config = { ...DEFAULT_CONFIG };
let modelsState = {};         // { asr: 'missing'|'downloading'|'ready'|'error' }
let downloadProgress = {};    // { asr: { done, total, pct } }
let activeDownloads = new Map();

// 引擎实例（懒加载，模型就绪后创建）
let asrEngine = null;

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      config = { ...DEFAULT_CONFIG, ...saved };
    }
  } catch {
    // 配置损坏则用默认
  }
}

function writeConfig(text) {
  const tmp = CONFIG_FILE + '.tmp';
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, CONFIG_FILE);
}

function saveConfig() {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    const persisted = {};
    if (config.autoDownload !== DEFAULT_CONFIG.autoDownload) persisted.autoDownload = config.autoDownload;
    writeConfig(JSON.stringify({ ...DEFAULT_CONFIG, ...persisted }, null, 2));
  } catch {
    // 写配置失败不致命
  }
}

function modelDir(key) { return join(MODELS_ROOT, key); }

function modelReady(key) {
  const def = DEFAULT_MODELS[key];
  if (!def) return false;
  const dir = modelDir(key);
  if (!existsSync(dir)) return false;
  return def.files.every((f) => findFileInTree(dir, f) !== null);
}

function allModelsReady() { return Object.keys(DEFAULT_MODELS).every((k) => modelReady(k)); }

// 在解压目录树中递归寻找指定文件名（模型目录名可能带版本前缀）
export function findFileInTree(root, name) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findFileInTree(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

// ── 引擎加载（懒加载单例）──────────────────────────────────
function loadSherpa() {
  if (sherpa) return sherpa;
  try {
    sherpa = require('sherpa-onnx-node');
  } catch (err) {
    throw new Error('sherpa-onnx-node 加载失败: ' + err.message);
  }
  return sherpa;
}

function asrModelConfig() {
  const dir = modelDir('asr');
  const model = findFileInTree(dir, 'model.int8.onnx') || findFileInTree(dir, 'model.onnx');
  const tokens = findFileInTree(dir, 'tokens.txt');
  if (!model || !tokens) throw new Error('ASR 模型不完整');
  return {
    senseVoice: { model, language: 'zh', useInverseTextNormalization: 1 },
    tokens,
  };
}

function createAsr() {
  const s = loadSherpa();
  if (!asrEngine) {
    // OfflineRecognizer（SenseVoice）：decodeAsync 异步解码，不阻塞事件循环
    asrEngine = new s.OfflineRecognizer({
      modelConfig: asrModelConfig(),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    });
  }
  return asrEngine;
}

// ── WAV 解析（16k mono PCM16 / f32 均可）────────────────────
// 返回 { samples: Float32Array(-1~1), sampleRate }
export function parseWavToF32(uint8) {
  if (uint8.length < 44) throw new Error('not a wav file');
  const data = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
  const riff = String.fromCharCode(uint8[0], uint8[1], uint8[2], uint8[3]);
  if (riff !== 'RIFF') throw new Error('not a RIFF file');
  const fmt = data.getUint32(16, true);
  const audioFormat = data.getUint16(20, true);
  const numChannels = data.getUint16(22, true);
  const sampleRate = data.getUint32(24, true);
  const bitsPerSample = data.getUint16(34, true);
  let offset = 12 + 8 + fmt;
  let dataOffset = -1;
  let dataLen = 0;
  while (offset + 8 <= uint8.length) {
    const chunkId = String.fromCharCode(uint8[offset], uint8[offset + 1], uint8[offset + 2], uint8[offset + 3]);
    const chunkLen = data.getUint32(offset + 4, true);
    if (chunkId === 'data') { dataOffset = offset + 8; dataLen = chunkLen; break; }
    offset += 8 + chunkLen + (chunkLen % 2);
  }
  if (dataOffset < 0) throw new Error('no data chunk');

  if (audioFormat === 3) {
    const count = Math.floor(dataLen / 4);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = data.getFloat32(dataOffset + i * 4, true);
    return { samples: out, sampleRate };
  }
  if (audioFormat !== 1) throw new Error('unsupported audio format ' + audioFormat);
  const bytesPerSample = bitsPerSample / 8;
  const count = Math.floor(dataLen / bytesPerSample / numChannels);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const byteOff = dataOffset + i * numChannels * bytesPerSample;
    if (bytesPerSample === 2) out[i] = data.getInt16(byteOff, true) / 32768;
    else if (bytesPerSample === 1) out[i] = (data.getUint8(byteOff) - 128) / 128;
    else out[i] = data.getInt32(byteOff, true) / 2147483648;
  }
  return { samples: out, sampleRate };
}

// ── 转写（一次性喂整段 + tail padding，等效离线）────────────
export function transcribeWav(wavUint8) {
  const { samples, sampleRate } = parseWavToF32(wavUint8);
  return transcribeSamples(samples, sampleRate);
}

// OfflineRecognizer（SenseVoice）：decodeAsync 异步解码，不阻塞事件循环。
// 整段喂入（离线模型天然支持），结果含标点（useInverseTextNormalization）。
export async function transcribeSamples(samples, sampleRate) {
  const engine = createAsr();
  const stream = engine.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  await engine.decodeAsync(stream);
  const result = engine.getResult(stream);
  const text = (result.text || '').trim();
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  return { text, durationMs, lowConfidence: text.length === 0 };
}

// ── multipart 解析（极简：只取 name="audio" 字段的原始字节）──
// 兼容 fetch FormData 上传的 multipart/form-data。零依赖手写。
export function extractMultipartAudio(body, contentType) {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = (m[1] || m[2]).trim();
  const delim = Buffer.from('--' + boundary);
  let idx = body.indexOf(delim);
  while (idx !== -1) {
    const next = body.indexOf(delim, idx + delim.length);
    if (next === -1) break;
    const part = body.subarray(idx + delim.length, next);
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) { idx = next; continue; }
    const header = part.subarray(0, sep).toString('utf8');
    if (/name="audio"/.test(header)) {
      let data = part.subarray(sep + 4);
      // 去掉段尾的 \r\n
      if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
        data = data.subarray(0, data.length - 2);
      }
      return data;
    }
    idx = next;
  }
  return null;
}

// ── 模型下载（断点续传循环直到完整）───────────────────────
// 仅保留白名单字段（通用防注入工具；下载源等敏感配置只能手改配置文件）
export function pickFields(obj, keys) {
  const out = {};
  if (obj === null || typeof obj !== 'object') return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function resolveUrl(key) {
  return config.downloadUrls?.[key] || DEFAULT_MODELS[key].url;
}

function downloadFile(url, dest, onProgress, expectedSize) {
  return new Promise((resolve, reject) => {
    let existing = 0;
    try { existing = statSync(dest).size; } catch {}
    if (expectedSize && existing >= expectedSize) { resolve({ done: true, already: true }); return; }
    const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {};
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(new URL(res.headers.location, url).toString(), dest, onProgress, expectedSize).then(resolve, reject);
        return;
      }
      if (res.statusCode === 416) { res.resume(); resolve({ done: true, resumed: true }); return; }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = (existing > 0 && res.statusCode === 206)
        ? existing + Number(res.headers['content-length'] || 0)
        : Number(res.headers['content-length'] || 0);
      const out = createWriteStream(dest, { flags: existing > 0 && res.statusCode === 206 ? 'a' : 'w' });
      let done = existing > 0 && res.statusCode === 206 ? existing : 0;
      res.on('data', (c) => { done += c.length; onProgress?.({ done, total }); });
      out.on('error', reject);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve({ done, total })));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('download timeout')));
  });
}

function extractTarball(tarball, key) {
  const workDir = join(MODELS_ROOT, key + '.tmp');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  // 1GB 高压缩 bz2 解压可能 >5min；给足 20 分钟（同步阻塞可接受，仅发生在模型就绪前）
  const r = spawnSync('tar', ['-xjf', tarball, '-C', workDir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 1200000 });
  if (r.status !== 0) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error('tar 解压失败: ' + (r.stderr || '').toString().slice(0, 300));
  }
  const finalDir = modelDir(key);
  mkdirSync(finalDir, { recursive: true });
  const def = DEFAULT_MODELS[key];
  for (const f of def.files) {
    const src = findFileInTree(workDir, f);
    if (!src) throw new Error('解压后缺少文件 ' + f);
    copyFileSync(src, join(finalDir, f));
  }
  rmSync(workDir, { recursive: true, force: true });
}

async function downloadModel(key) {
  if (modelReady(key)) return { ok: true, already: true };
  if (activeDownloads.has(key)) return { ok: false, error: 'downloading' };
  const def = DEFAULT_MODELS[key];
  activeDownloads.set(key, true);
  modelsState[key] = 'downloading';
  downloadProgress[key] = { done: 0, total: 0, pct: 0 };
  try {
    mkdirSync(MODELS_ROOT, { recursive: true });
    // 换模型时清空旧模型目录：防 findFileInTree 匹配到旧文件 + 腾空间
    rmSync(modelDir(key), { recursive: true, force: true });
    mkdirSync(modelDir(key), { recursive: true });
    const tarball = join(MODELS_ROOT, key + '.tar.bz2');
    // 下载（断点续传循环直到文件完整）；下载完成后解压一次（不再循环重试解压）
    let downloaded = false;
    for (let attempts = 0; attempts < 12 && !downloaded; attempts++) {
      try {
        const r = await downloadFile(resolveUrl(key), tarball, (p) => {
          downloadProgress[key] = {
            done: p.done, total: p.total,
            pct: p.total ? Math.round((p.done / p.total) * 100) : 0,
          };
        }, def.size);
        downloaded = !!r.done;
      } catch (err) {
        if (attempts >= 11) throw err;
      }
    }
    if (!downloaded) throw new Error('模型下载不完整');
    extractTarball(tarball, key);
    rmSync(tarball, { force: true });
    if (!modelReady(key)) throw new Error('模型文件不完整');
    modelsState[key] = 'ready';
    downloadProgress[key] = { done: 1, total: 1, pct: 100 };
    return { ok: true };
  } catch (err) {
    modelsState[key] = 'error';
    return { ok: false, error: err.message };
  } finally {
    activeDownloads.delete(key);
  }
}

async function ensureModels() {
  if (allModelsReady()) return { ok: true };
  if (!config.autoDownload) {
    const missing = Object.keys(DEFAULT_MODELS).filter((k) => !modelReady(k));
    return { ok: false, error: 'models missing: ' + missing.join(','), missing };
  }
  const keys = Object.keys(DEFAULT_MODELS).filter((k) => !modelReady(k));
  const results = await Promise.all(keys.map((k) => downloadModel(k)));
  return { ok: results.every((r) => r.ok), results };
}

// ── HTTP 工具 ───────────────────────────────────────────────
function isLoopback(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, maxBytes = 60 * 1024 * 1024, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { req.destroy(new Error('body read timeout')); }, timeoutMs);
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { clearTimeout(timer); reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function guarded(req, res, handler) {
  if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
  handler(req, res).catch((err) => {
    try { sendJson(res, 500, { error: err.message }); } catch {}
  });
}

// ── 路由 handlers ───────────────────────────────────────────
async function handleStatus(req, res) {
  const models = {};
  for (const key of Object.keys(DEFAULT_MODELS)) {
    models[key] = modelReady(key) ? 'ready' : (modelsState[key] || 'missing');
  }
  sendJson(res, 200, {
    engine: allModelsReady() ? 'ready' : 'pending-download',
    models,
    download: downloadProgress,
    version: sherpa ? sherpa.version : null,
  });
}

async function handleTranscribe(req, res) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
  const body = await readBody(req);
  const audio = extractMultipartAudio(body, req.headers['content-type']);
  if (!audio || audio.length < 44) { sendJson(res, 400, { error: 'empty audio' }); return; }
  if (!allModelsReady()) {
    const e = await ensureModels();
    if (!e.ok) { sendJson(res, 503, { error: 'model not ready', ...e }); return; }
  }
  try {
    const result = await transcribeWav(audio);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleDownload(req, res) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
  const body = await readBody(req, 1024 * 1024);
  let patch;
  try { patch = body.length ? JSON.parse(body.toString('utf8')) : {}; } catch { sendJson(res, 400, { error: 'bad json' }); return; }
  const key = patch.key;
  if (key && !DEFAULT_MODELS[key]) { sendJson(res, 400, { error: 'unknown model ' + key }); return; }
  const keys = key ? [key] : Object.keys(DEFAULT_MODELS).filter((k) => !modelReady(k));
  if (!keys.length) { sendJson(res, 200, { ok: true, already: true }); return; }
  const results = [];
  for (const k of keys) results.push(await downloadModel(k));
  sendJson(res, 200, { ok: results.every((r) => r.ok), results });
}

function apply(ctx) {
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: '/api/dsh-stt/status', handler: (req, res) => guarded(req, res, handleStatus) }),
    ctx.webServer.register({ kind: 'exact', path: '/api/dsh-stt/transcribe', handler: (req, res) => guarded(req, res, handleTranscribe) }),
    ctx.webServer.register({ kind: 'exact', path: '/api/dsh-stt/download', handler: (req, res) => guarded(req, res, handleDownload) }),
  ];
  loadConfig();
  if (config.autoDownload && !allModelsReady()) {
    ensureModels();
  }
  return () => { for (const d of disposers) d(); };
}

export { NAME as name, inject, apply, NAME };
