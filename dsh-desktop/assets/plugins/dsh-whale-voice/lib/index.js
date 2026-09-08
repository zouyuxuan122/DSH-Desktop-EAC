import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const name = "whale-voice";
const inject = [];
const ROUTE = "/plugins/dsh-whale-voice/config.json";
const PREPARE_ROUTE = "/plugins/dsh-whale-voice/prepare.json";
const TRANSCRIBE_ROUTE = "/plugins/dsh-whale-voice/transcribe.json";
const CONFIG_PATH = process.env.DSH_WHALE_VOICE_FILE || join(homedir(), ".dsh", "whale-voice", "config.json");
const LEGACY_PATH = process.env.APPDATA ? join(process.env.APPDATA, "dsh-whale-chan-client", "whale-voice.json") : "";
const RUNTIME_DIR = process.env.DSH_WHALE_VOICE_RUNTIME_DIR || join(homedir(), ".dsh", "whale-voice", "runtime");
const RUNTIME_PACKAGES = ["@huggingface/transformers@3.0.0", "opencc-js@1.4.2"];
const MODELS = ["onnx-community/whisper-tiny", "onnx-community/whisper-base", "onnx-community/whisper-small"];
const LANGUAGES = ["auto", "zh", "en", "ja", "ko"];
const DEVICES = ["cpu", "wasm", "gpu"];
const DEFAULT_CONFIG = Object.freeze({ model: MODELS[0], language: "zh", device: "cpu", cacheDir: "", microphoneId: "", simplifyChinese: true, micIcon: "" });
const LANGUAGE_NAMES = { auto: undefined, zh: "chinese", en: "english", ja: "japanese", ko: "korean" };
let pipelinePromise = null;
let pipelineKey = "";
let runtimePromise = null;
let transformersPromise = null;
let openCCPromise = null;

function normalizeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const icon = typeof source.micIcon === "string" ? source.micIcon : "";
  return {
    model: MODELS.includes(source.model) ? source.model : DEFAULT_CONFIG.model,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
    device: DEVICES.includes(source.device) ? source.device : DEFAULT_CONFIG.device,
    cacheDir: typeof source.cacheDir === "string" ? source.cacheDir.trim().slice(0, 1000) : "",
    microphoneId: typeof source.microphoneId === "string" ? source.microphoneId.slice(0, 500) : "",
    simplifyChinese: source.simplifyChinese !== false,
    // Keep the icon self-contained and prevent arbitrary URL schemes from being
    // injected into the client. 256 KiB is ample for a 32 px button asset.
    micIcon: /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(icon) && icon.length <= 350000 ? icon : ""
  };
}

async function readConfig() {
  try { return normalizeConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8"))); }
  catch {
    if (LEGACY_PATH) {
      try {
        const migrated = normalizeConfig(JSON.parse(await readFile(LEGACY_PATH, "utf8")));
        await saveConfig(migrated);
        return migrated;
      } catch {}
    }
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config) {
  const value = normalizeConfig(config);
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  const temp = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temp, CONFIG_PATH);
  return value;
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function cacheDir(config) {
  return config.cacheDir || join(homedir(), ".dsh", "whale-voice", "models");
}

async function fileExists(file) {
  try { await access(file); return true; } catch { return false; }
}

function npmInstallRuntime() {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(command, ["install", "--prefix", RUNTIME_DIR, "--omit=dev", "--no-package-lock", "--no-save", ...RUNTIME_PACKAGES], { stdio: "pipe", windowsHide: true });
    let output = "";
    child.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
    child.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
    const timeout = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Whisper 运行库下载失败（npm 退出码 ${code}）：${output.trim()}`)); });
  });
}

async function ensureRuntime(download = false) {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const transformers = join(RUNTIME_DIR, "node_modules", "@huggingface", "transformers", "package.json");
    const opencc = join(RUNTIME_DIR, "node_modules", "opencc-js", "package.json");
    if (!await fileExists(transformers) || !await fileExists(opencc)) {
      if (!download) throw new Error("Whisper 运行库尚未准备，请先在语音设置中点击“保存并准备模型”");
      await npmInstallRuntime();
    }
    if (!await fileExists(transformers) || !await fileExists(opencc)) throw new Error("Whisper 运行库下载未完成");
  })();
  try { return await runtimePromise; } catch (error) { runtimePromise = null; throw error; }
}

async function importRuntimePackage(parts) {
  const packageDir = join(RUNTIME_DIR, "node_modules", ...parts);
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const entry = manifest.module || manifest.main || "index.js";
  return import(pathToFileURL(join(packageDir, entry)).href);
}

async function getTransformers(download = false) {
  await ensureRuntime(download);
  transformersPromise ||= importRuntimePackage(["@huggingface", "transformers"]);
  return transformersPromise;
}

async function toSimplifiedChinese(text) {
  await ensureRuntime(false);
  openCCPromise ||= importRuntimePackage(["opencc-js"]);
  const opencc = await openCCPromise;
  const Converter = opencc.Converter || opencc.default?.Converter;
  return typeof Converter === "function" ? Converter({ from: "tw", to: "cn" })(text) : text;
}

async function getPipeline(config, download = false) {
  const key = `${config.model}\0${config.device}\0${cacheDir(config)}`;
  if (pipelinePromise && pipelineKey === key) return pipelinePromise;
  pipelineKey = key;
  pipelinePromise = (async () => {
    const transformers = await getTransformers(download);
    transformers.env.cacheDir = cacheDir(config);
    try { return await transformers.pipeline("automatic-speech-recognition", config.model, { device: config.device }); }
    catch { return transformers.pipeline("automatic-speech-recognition", config.model, { device: "cpu" }); }
  })();
  try { return await pipelinePromise; }
  catch (error) { pipelinePromise = null; pipelineKey = ""; throw error; }
}

async function transcribe(samples) {
  if (!Array.isArray(samples) || samples.length < 1600 || samples.length > 960000) throw new Error("invalid PCM audio");
  const config = await readConfig();
  const pcm = Float32Array.from(samples, (sample) => Number.isFinite(Number(sample)) ? Math.max(-1, Math.min(1, Number(sample))) : 0);
  const pipe = await getPipeline(config);
  const output = await pipe(pcm, { language: LANGUAGE_NAMES[config.language], task: "transcribe", return_timestamps: false });
  const raw = String(output?.text || output?.[0]?.text || "").trim();
  const text = config.language === "zh" && config.simplifyChinese !== false ? await toSimplifiedChinese(raw) : raw;
  return { text };
}

function createHandler() {
  return async (req, res) => {
    try {
      if (!isLoopback(req)) return json(res, 403, { ok: false, error: "loopback only" });
      if (req.method === "GET" || req.method === "HEAD") return json(res, 200, { config: await readConfig(), models: MODELS, languages: LANGUAGES, devices: DEVICES });
      if (req.method === "PUT" || req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, { ok: true, config: await saveConfig(body.config ?? body), dataPath: CONFIG_PATH });
      }
      return json(res, 405, { ok: false, error: "method not allowed" });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message || error) });
    }
  };
}

function createPrepareHandler() {
  return async (req, res) => {
    try {
      if (!isLoopback(req) || req.method !== "POST") return json(res, 405, { ok: false, error: "POST from loopback required" });
      await ensureRuntime(true);
      await getPipeline(await readConfig(), false);
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, 500, { ok: false, error: String(error?.message || error) }); }
  };
}

function createTranscribeHandler() {
  return async (req, res) => {
    try {
      if (!isLoopback(req) || req.method !== "POST") return json(res, 405, { ok: false, error: "POST from loopback required" });
      const body = await readBody(req, 12 * 1024 * 1024);
      return json(res, 200, { ok: true, ...(await transcribe(body.samples)) });
    } catch (error) { return json(res, 500, { ok: false, error: String(error?.message || error) }); }
  };
}

function apply(ctx) {
  ctx.effect(() => {
    const handler = createHandler();
    const prepareHandler = createPrepareHandler();
    const transcribeHandler = createTranscribeHandler();
    let disposed = false;
    let routeDisposer = null;
    let attempts = 0;
    const tryRegister = () => {
      if (disposed) return true;
      let webServer = null;
      try { webServer = typeof ctx.get === "function" ? ctx.get("webServer") : null; } catch {}
      try { webServer ||= ctx.webServer || null; } catch {}
      if (!webServer || typeof webServer.register !== "function") return false;
      routeDisposer = [
        webServer.register({ kind: "exact", path: ROUTE, handler }),
        webServer.register({ kind: "exact", path: PREPARE_ROUTE, handler: prepareHandler }),
        webServer.register({ kind: "exact", path: TRANSCRIBE_ROUTE, handler: transcribeHandler })
      ];
      return true;
    };
    const timer = tryRegister() ? null : setInterval(() => {
      attempts += 1;
      if (tryRegister() || attempts >= 20) clearInterval(timer);
    }, 500);
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      for (const dispose of routeDisposer || []) try { dispose?.(); } catch {}
    };
  }, "whale-voice: shared config route");
}

const plugin = { apply, inject, name };
export { CONFIG_PATH, DEFAULT_CONFIG, DEVICES, LANGUAGES, MODELS, apply, inject, name, normalizeConfig, transcribe };
export default plugin;
