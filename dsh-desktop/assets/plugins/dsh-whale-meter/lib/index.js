import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const name = "whale-meter";
const inject = [];
const ROUTE = "/plugins/dsh-whale-meter/state.json";
const PRICE_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
const DATA_PATH = process.env.DSH_WHALE_METER_FILE || join(homedir(), ".dsh", "whale-meter", "usage.json");
const DAY = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = Object.freeze({
  autoUpdatePrice: true,
  model: "deepseek-v4-flash",
  currency: "¥",
  usdToCurrency: 7.2,
  cacheHit: 0.014,
  cacheMiss: 0.44,
  output: 1.32,
  text: "🐋 大肥鱼偷吃了你 {tokens} token · ≈{currency}{cost}",
  composerText: "本会话 {tokens} token · ≈{currency}{cost}",
  composerPosition: "above-right",
  sidebarText: "{tokens}"
});

function blankState() {
  return { version: 1, config: { ...DEFAULT_CONFIG }, pricing: { source: "built-in", checkedAt: 0, error: "" }, sessions: {} };
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeUsage(value) {
  const input = finite(value?.uncachedInputTokens ?? value?.inputTokens);
  const output = finite(value?.outputTokens);
  const cacheRead = finite(value?.cacheReadTokens);
  const cacheWrite = finite(value?.cacheWriteTokens);
  return { uncachedInputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

function normalizeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    autoUpdatePrice: source.autoUpdatePrice !== false,
    model: typeof source.model === "string" && source.model ? source.model.slice(0, 100) : DEFAULT_CONFIG.model,
    currency: typeof source.currency === "string" && source.currency ? source.currency.slice(0, 8) : DEFAULT_CONFIG.currency,
    usdToCurrency: finite(source.usdToCurrency, DEFAULT_CONFIG.usdToCurrency),
    cacheHit: finite(source.cacheHit, DEFAULT_CONFIG.cacheHit),
    cacheMiss: finite(source.cacheMiss, DEFAULT_CONFIG.cacheMiss),
    output: finite(source.output, DEFAULT_CONFIG.output),
    text: typeof source.text === "string" && source.text ? source.text.slice(0, 240) : DEFAULT_CONFIG.text,
    composerText: typeof source.composerText === "string" && source.composerText ? source.composerText.slice(0, 240) : DEFAULT_CONFIG.composerText,
    composerPosition: ["above-left", "above-right", "inside-left", "inside-right", "hidden"].includes(source.composerPosition) ? source.composerPosition : DEFAULT_CONFIG.composerPosition,
    sidebarText: typeof source.sidebarText === "string" && source.sidebarText ? source.sidebarText.slice(0, 120) : DEFAULT_CONFIG.sidebarText
  };
}

function normalizeState(raw) {
  const state = blankState();
  if (!raw || typeof raw !== "object") return state;
  state.config = normalizeConfig(raw.config);
  state.pricing = raw.pricing && typeof raw.pricing === "object" ? { ...state.pricing, ...raw.pricing } : state.pricing;
  if (raw.sessions && typeof raw.sessions === "object") {
    for (const [id, row] of Object.entries(raw.sessions)) {
      if (!id || !row || typeof row !== "object") continue;
      state.sessions[id.slice(0, 200)] = {
        id: id.slice(0, 200),
        title: typeof row.title === "string" ? row.title.slice(0, 200) : id.slice(0, 200),
        updatedAt: finite(row.updatedAt),
        usage: normalizeUsage(row.usage)
      };
    }
  }
  return state;
}

function calculateCost(usage, config) {
  const u = normalizeUsage(usage);
  const c = normalizeConfig(config);
  const usd = (u.uncachedInputTokens * c.cacheMiss + u.cacheReadTokens * c.cacheHit + u.cacheWriteTokens * c.cacheMiss + u.outputTokens * c.output) / 1_000_000;
  return usd * c.usdToCurrency;
}

function totalsOf(sessions) {
  const total = normalizeUsage({});
  for (const row of Object.values(sessions || {})) {
    const usage = normalizeUsage(row?.usage);
    for (const key of Object.keys(total)) total[key] += usage[key];
  }
  return total;
}

function extractOfficialPrices(html, model = "deepseek-v4-flash") {
  const source = String(html || "");
  const modelNames = [...source.matchAll(/<td[^>]*>\s*(deepseek-[^<\s]+)\s*<\/td>/gi)].map((match) => match[1].toLowerCase());
  const requested = /deepseek-(chat|reasoner)/i.test(model) ? "deepseek-v4-flash" : String(model).toLowerCase();
  const modelIndex = modelNames.indexOf(requested);
  const pricingStart = source.search(/PRICING/i);
  const pricingEnd = source.search(/Concurrency Limit/i);
  if (modelIndex >= 0 && pricingStart >= 0) {
    const rowStart = source.lastIndexOf("<tr", pricingStart);
    const table = source.slice(rowStart >= 0 ? rowStart : pricingStart, pricingEnd > pricingStart ? pricingEnd : undefined);
    const prices = {};
    let bucket = "";
    for (const match of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = match[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#xA0;/gi, " ").replace(/\s+/g, " ").trim();
      if (/CACHE HIT/i.test(row)) bucket = "cacheHit";
      else if (/CACHE MISS/i.test(row)) bucket = "cacheMiss";
      else if (/OUTPUT TOKENS/i.test(row)) bucket = "output";
      const values = [...row.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)].map((item) => Number(item[1]));
      if (bucket && /\bPEAK\b/i.test(row) && !/OFF-PEAK/i.test(row) && Number.isFinite(values[modelIndex])) prices[bucket] = values[modelIndex];
    }
    if ([prices.cacheHit, prices.cacheMiss, prices.output].every(Number.isFinite)) return prices;
  }
  const text = source.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#xA0;/gi, " ").replace(/\s+/g, " ");
  const start = text.toLowerCase().indexOf(model.toLowerCase());
  const area = start >= 0 ? text.slice(start, start + 10000) : text;
  const numbers = [...area.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  if (numbers.length < 3) return null;
  // The current table may contain off-peak and peak rows. Prefer the peak triplet
  // for a conservative estimate; with a single row, use its first triplet.
  const candidate = numbers.length >= 6 ? numbers.slice(3, 6) : numbers.slice(0, 3);
  if (!candidate.every(Number.isFinite)) return null;
  return { cacheHit: candidate[0], cacheMiss: candidate[1], output: candidate[2] };
}

async function readState() {
  try { return normalizeState(JSON.parse(await readFile(DATA_PATH, "utf8"))); }
  catch { return blankState(); }
}

async function saveState(state) {
  await mkdir(dirname(DATA_PATH), { recursive: true });
  const temp = `${DATA_PATH}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(normalizeState(state), null, 2) + "\n", "utf8");
  await rename(temp, DATA_PATH);
}

async function refreshPrice(state, force = false) {
  if (!state.config.autoUpdatePrice && !force) return state;
  if (!force && Date.now() - finite(state.pricing.checkedAt) < DAY) return state;
  try {
    const response = await fetch(PRICE_URL, { headers: { "user-agent": "dsh-whale-meter/0.1" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const prices = extractOfficialPrices(await response.text(), state.config.model);
    if (!prices) throw new Error("price table format not recognized");
    state.config = { ...state.config, ...prices };
    state.pricing = { source: PRICE_URL, checkedAt: Date.now(), error: "" };
  } catch (error) {
    state.pricing = { ...state.pricing, checkedAt: Date.now(), error: String(error?.message || error) };
  }
  await saveState(state);
  return state;
}

async function readBody(req, limit = 1024 * 1024) {
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

function publicState(state) {
  const totals = totalsOf(state.sessions);
  return { ...state, totals, totalTokens: Object.values(totals).reduce((sum, value) => sum + value, 0), cost: calculateCost(totals, state.config), dataPath: DATA_PATH };
}

function createHandler() {
  return async (req, res) => {
    try {
      let state = await readState();
      if (req.method === "GET" || req.method === "HEAD") {
        state = await refreshPrice(state, false);
        return json(res, 200, publicState(state));
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        state.config = normalizeConfig({ ...state.config, ...(body.config || {}) });
        if (body.refreshPrice === true) state.pricing.checkedAt = 0;
        await saveState(state);
        state = await refreshPrice(state, body.refreshPrice === true);
        return json(res, 200, publicState(state));
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        for (const row of Array.isArray(body.sessions) ? body.sessions : []) {
          if (!row || typeof row.id !== "string" || !row.id) continue;
          const id = row.id.slice(0, 200);
          const next = normalizeUsage(row.usage);
          const previous = state.sessions[id]?.usage;
          // Session projections are cumulative. Never regress persisted counters.
          if (previous) for (const key of Object.keys(next)) next[key] = Math.max(next[key], finite(previous[key]));
          state.sessions[id] = { id, title: typeof row.title === "string" ? row.title.slice(0, 200) : id, updatedAt: Date.now(), usage: next };
        }
        await saveState(state);
        return json(res, 200, publicState(state));
      }
      return json(res, 405, { ok: false, error: "method not allowed" });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message || error) });
    }
  };
}

function apply(ctx) {
  ctx.effect(() => {
    const handler = createHandler();
    let disposed = false;
    let routeDisposer = null;
    let attempts = 0;
    const tryRegister = () => {
      if (disposed) return true;
      let webServer = null;
      try { webServer = typeof ctx.get === "function" ? ctx.get("webServer") : null; } catch {}
      try { webServer ||= ctx.webServer || null; } catch {}
      if (!webServer || typeof webServer.register !== "function") return false;
      routeDisposer = webServer.register({ kind: "exact", path: ROUTE, handler });
      return true;
    };
    const timer = tryRegister() ? null : setInterval(() => {
      attempts += 1;
      if (tryRegister() || attempts >= 20) clearInterval(timer);
    }, 500);
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      try { routeDisposer?.(); } catch {}
    };
  }, "whale-meter: local persistence route");
}

const plugin = { apply, inject, name };
export { DEFAULT_CONFIG, apply, calculateCost, extractOfficialPrices, inject, name, normalizeConfig, normalizeUsage, totalsOf };
export default plugin;
