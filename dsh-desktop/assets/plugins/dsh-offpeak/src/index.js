/**
 * dsh-offpeak — server half.
 *
 * DeepSeek API 峰谷定价（2026-08-17 起生效）高峰时段价格提醒：
 *   高峰：北京时间 9:00–12:00、14:00–18:00；闲时价格为高峰一半。
 *
 * 1. 监听会话事件 `user/message`：命令在高峰时段到达、当日未「不再提醒」、
 *    且生效日期已到（或 debug）时，生成一条待展示提醒（含命令文本、当前
 *    模型、价目表），浏览器经 GET /ds-offpeak/state 轮询取走弹窗。
 *    跨过高峰边界仍在执行的命令不会被打断——提醒只在下一条命令（高峰内）
 *    到达时出现。
 * 2. 定时执行：POST /ds-offpeak/schedule 登记 { 命令文本, atMs, 会话 }，
 *    持久化到 profile 目录 offpeak.json；服务端定时器到点后经 apiProxy
 *    的 sessions.prompt（与浏览器提交命令完全同一条路径）把命令文本重新
 *    提交给原会话，浏览器无需在线。
 * 3. 路由只接受同源 POST；除本地外不向任何地方上报数据。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 稳定插件名（profile 组合中的行 id）。 */
export const name = "offpeak";

/** 调价后价目表（元 / 百万 tokens，2026-08-17 生效）。 */
export const PRICES = {
  flash: {
    label: "DeepSeek V4 Flash",
    peak: { input: 3, output: 9, cacheRead: 0.1 },
    off: { input: 1.5, output: 4.5, cacheRead: 0.05 },
  },
  pro: {
    label: "DeepSeek V4 Pro",
    peak: { input: 9, output: 27, cacheRead: 0.3 },
    off: { input: 4.5, output: 13.5, cacheRead: 0.15 },
  },
};

/** 高峰窗口（分钟数，含起点不含终点）。 */
const DEFAULT_PEAK_WINDOWS = [
  { start: 9 * 60, end: 12 * 60 },
  { start: 14 * 60, end: 18 * 60 },
];

/** 允许定时的小时（避开 9:00–12:00、14:00–18:00 高峰，也避开 12–14 边界）。 */
const ALLOWED_HOURS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8,
  18, 19, 20, 21, 22, 23,
];

/** 定时任务的有效窗口：最远可排到两天后，避免误填。 */
const MAX_SCHEDULE_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;
const MIN_SCHEDULE_AHEAD_MS = 30 * 1000;

/** 调度器扫描间隔。 */
const TICK_MS = 15 * 1000;

/** 从运行参数推断 profile 名（与市场插件同一套逻辑）。 */
function argvProfile() {
  const argv = typeof process !== "undefined" ? process.argv : [];
  const flag = argv.indexOf("--profile");
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith("-")) {
    return argv[flag + 1];
  }
  return undefined;
}

/** 北京时间（Asia/Shanghai）的日期时间分解。 */
function beijingNow(nowMs = Date.now()) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute,
    minutes: hour * 60 + minute,
    iso: new Date(nowMs).toISOString(),
    epochMs: nowMs,
  };
}

/** 是否为高峰时段。 */
function isPeak(minutes, windows) {
  return windows.some((w) => minutes >= w.start && minutes < w.end);
}

/** 当前所处高峰窗口的起点分钟数（非高峰返回 null）。 */
function peakStartOf(minutes, windows) {
  const w = windows.find((win) => minutes >= win.start && minutes < win.end);
  return w === undefined ? null : w.start;
}

export function apply(ctx, config = {}) {
  const profile = typeof config.profile === "string" && config.profile !== "" ? config.profile : argvProfile() ?? "web";
  const effectiveFrom = typeof config.effectiveFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(config.effectiveFrom)
    ? config.effectiveFrom
    : "2026-08-17";
  const debug = config.debug === true;
  const windows = Array.isArray(config.peakWindows) && config.peakWindows.length > 0
    ? config.peakWindows.map((w) => ({
        start: Number(w.start),
        end: Number(w.end),
      })).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
    : DEFAULT_PEAK_WINDOWS;

  const home = typeof process !== "undefined" && process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ""
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  const statePath = config.statePath !== undefined && typeof config.statePath === "string"
    ? config.statePath
    : join(home, "profiles", profile, "offpeak.json");

  /** 生效判定：已到生效日，或 debug 忽略。 */
  const effective = (bj) => debug || bj.date >= effectiveFrom;

  /** 当前模型（provider/model）。 */
  let modelCache = { provider: "", model: "" };
  const readModel = (host) => {
    try {
      const svc = host.get("agentDefaultModel");
      if (svc !== undefined && typeof svc.currentSelection === "function") {
        const sel = svc.currentSelection();
        if (sel !== null && typeof sel === "object") {
          modelCache = {
            provider: typeof sel.provider === "string" ? sel.provider : "",
            model: typeof sel.model === "string" ? sel.model : "",
          };
        }
      }
    } catch {
      /* 读取失败保持上次值 */
    }
    return modelCache;
  };

  /** 模型归类：flash / pro / deepseek-other / other。 */
  const classifyModel = (model) => {
    const m = String(model).toLowerCase();
    if (m.includes("flash")) return "flash";
    if (m.includes("pro")) return "pro";
    return "deepseek-other";
  };

  /** 从会话事件里提取用户命令文本。 */
  const extractText = (event) => {
    const data = event !== null && typeof event === "object" ? event.data : undefined;
    if (typeof data === "string") return data;
    if (data === null || typeof data !== "object") return "";
    if (typeof data.text === "string") return data.text;
    const content = Array.isArray(data.content) ? data.content : [];
    const parts = content
      .map((block) => (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .filter((t) => t !== "");
    return parts.join("\n");
  };

  /** 定时任务是否由本插件自己提交（跳过提醒）。 */
  const isOwnSubmission = (event) => {
    const data = event !== null && typeof event === "object" ? event.data : undefined;
    const source = data !== null && typeof data === "object" ? data.source : undefined;
    return source !== null && typeof source === "object" && typeof source.rpcId === "string"
      && source.rpcId.startsWith("offpeak-");
  };

  // ---- 状态（内存 + 持久化） ----
  let state = {
    tasks: [], // { id, text, sessionId, atMs, createdAt, status: scheduled|executed|failed|cancelled, error? }
    reminded: null, // { date: "YYYY-MM-DD", dismissed: true }
    reminder: null, // { nonce, atMs, text, sessionId, model, modelKind }
    lastCommandStartAt: null, // epoch ms
  };

  const loadState = () => {
    try {
      if (existsSync(statePath)) {
        const parsed = JSON.parse(readFileSync(statePath, "utf8"));
        if (parsed !== null && typeof parsed === "object") {
          state = {
            tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter((t) => t !== null && typeof t === "object") : [],
            reminded: parsed.reminded !== null && typeof parsed.reminded === "object" ? parsed.reminded : null,
            reminder: null,
            lastCommandStartAt: null,
          };
        }
      }
    } catch (error) {
      if (ctx.logger?.warn !== undefined) {
        ctx.logger.warn(`[offpeak] state load failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const persist = () => {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      const snapshot = JSON.stringify({
        tasks: state.tasks,
        reminded: state.reminded,
      }, null, 2);
      writeFileSync(statePath, snapshot, "utf8");
    } catch (error) {
      if (ctx.logger?.warn !== undefined) {
        ctx.logger.warn(`[offpeak] state save failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  /** 命令到达时的提醒决策（核心规则）。 */
  const handleCommandStart = (session, event) => {
    const bj = beijingNow();
    if (!effective(bj)) return;
    if (isOwnSubmission(event)) return;
    const text = extractText(event);
    const sessionId = typeof session?.id === "string" ? session.id : "";
    state.lastCommandStartAt = bj.epochMs;

    if (!isPeak(bj.minutes, windows)) {
      state.reminder = null;
      return;
    }
    if (state.reminded !== null && state.reminded.date === bj.date && state.reminded.dismissed) {
      state.reminder = null;
      return;
    }
    const model = readModel(ctx);
    if (!/deepseek/i.test(model.provider)) {
      state.reminder = null;
      return;
    }
    state.reminder = {
      nonce: randomUUID(),
      atMs: bj.epochMs,
      text,
      sessionId,
      model: model.model,
      modelKind: classifyModel(model.model),
    };
  };

  /** 执行一条定时任务（与浏览器 session.prompt 同路径）。 */
  let apiProxyRef = null; // 由 inject 回调捕获（插件自身 ctx 取不到该服务）
  const executeTask = async (task) => {
    if (task.status === "executed" || task.status === "cancelled") return { ok: true, skipped: true };
    task.status = "running";
    try {
      const api = apiProxyRef !== null ? apiProxyRef : ctx.get("apiProxy");
      if (api === undefined || api === null || api.sessions === undefined || typeof api.sessions.prompt !== "function") {
        throw new Error(`apiProxy sessions.prompt unavailable (api=${api === undefined ? "undefined" : api === null ? "null" : "object"}, sessions=${api !== undefined && api !== null && api.sessions !== undefined ? "ok" : "missing"}, prompt=${api !== undefined && api !== null && api.sessions !== undefined && typeof api.sessions.prompt === "function" ? "ok" : "missing"})`);
      }
      const result = await api.sessions.prompt({
        rpcId: `offpeak-${task.id}`,
        payload: {
          sessionId: task.sessionId,
          mode: "queue",
          content: [{ type: "text", text: task.text }],
        },
      });
      // 服务端返回 `{ rpcId, result: { ok, value|error } }`（ok/err 辅助函数
      // 把业务结果包在 result 字段下）；兼容两种层级。
      const envelope = result !== null && typeof result === "object"
        ? result
        : null;
      const outcome = envelope !== null && envelope.result !== null && typeof envelope.result === "object"
        ? envelope.result
        : envelope;
      if (outcome !== null && outcome.ok === true) {
        task.status = "executed";
        task.error = undefined;
      } else {
        task.status = "failed";
        const errBody = outcome !== null && outcome.error !== null && typeof outcome.error === "object" ? outcome.error : null;
        task.error = errBody !== null
          ? String(errBody.message ?? "unknown error")
          : "unknown error";
      }
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
    }
    persist();
    return { ok: task.status !== "failed", task };
  };

  /** 调度器：到点执行，重启后补跑 overdue。 */
  const tick = async () => {
    const now = Date.now();
    for (const task of state.tasks) {
      if (task.status === "scheduled" && task.atMs <= now) {
        try {
          await executeTask(task);
        } catch {
          /* executeTask 内部已兜底 */
        }
      }
    }
    // 过期的「今日不再提醒」自然失效（按日期比对，无需清理）。
  };

  // ---- 会话事件监听：命令进入系统的唯一触发点 ----
  ctx.on("session/event", (session, event) => {
    if (event === null || typeof event !== "object" || event.type !== "user/message") return;
    handleCommandStart(session, event);
  });

  // ---- 加载持久化状态 + 启动调度器 ----
  loadState();
  ctx.effect(() => {
    const timer = setInterval(() => void tick(), TICK_MS);
    void tick();
    return () => clearInterval(timer);
  }, "offpeak: scheduler");

  // ---- HTTP 路由 ----
  ctx.inject(["webServer", "agentDefaultModel", "apiProxy"], (webCtx) => {
    // 捕获 apiProxy 服务引用：定时执行复用与浏览器完全相同的提交路径。
    apiProxyRef = webCtx.get("apiProxy") ?? null;
    if (apiProxyRef === null && ctx.logger?.warn !== undefined) {
      ctx.logger.warn("[offpeak] apiProxy not injectable — scheduled execution disabled");
    }
    const sameOrigin = (req) => {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (typeof origin !== "string" || origin === "" || typeof host !== "string" || host === "") return false;
      try {
        return new URL(origin).host === host;
      } catch {
        return false;
      }
    };

    const sendJson = (res, status, value) => {
      const body = JSON.stringify(value);
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    };

    const readJson = (req) => new Promise((resolvePromise) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          req.destroy();
          resolvePromise(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (chunks.length === 0) {
          resolvePromise(null);
          return;
        }
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolvePromise(null);
        }
      });
      req.on("error", () => resolvePromise(null));
    });

    /** 生成小时轮选项（服务端统一按北京时间计算，浏览器零时区逻辑）。 */
    const ALL_MINUTES = Array.from({ length: 60 }, (_, i) => i);
    const buildHourOptions = () => {
      const bj = beijingNow();
      const nowMinutes = bj.minutes;
      const nowHour = bj.hour;
      const todayAllowed = ALLOWED_HOURS.filter((h) => h > nowHour);
      const todayCurrent = ALLOWED_HOURS.includes(nowHour);
      const options = []; // { label, hour, dayOffset, atMs(分钟0档), minute:0, minutes:[] }
      const pushHour = (hour, dayOffset, minutes) => {
        // 以北京时间的年月日为准构造目标时刻（epoch ms = 北京时间 → UTC）。
        const atMs = Date.UTC(bj.year, bj.month - 1, bj.day + dayOffset, hour, 0)
          - 8 * 60 * 60 * 1000;
        options.push({
          label: `${dayOffset === 0 ? "今天" : dayOffset === 1 ? "明天" : "后天"} ${String(hour).padStart(2, "0")}:00`,
          hour,
          minute: 0,
          dayOffset,
          atMs,
          minutes,
        });
      };
      // 今天剩余的未来允许小时：完整 00–59 分钟档。
      for (const h of todayAllowed) pushHour(h, 0, [...ALL_MINUTES]);
      if (todayCurrent) {
        // 当前小时：只保留还没过去的分钟；无剩余档位则跳过该小时。
        const remaining = [];
        for (let m = nowMinutes + 1; m < nowHour * 60 + 60; m += 1) remaining.push(m - nowHour * 60);
        if (remaining.length > 0) pushHour(nowHour, 0, remaining);
      }
      // 次日 0–8 点：完整 00–59 分钟档。
      for (const h of [0, 1, 2, 3, 4, 5, 6, 7, 8]) pushHour(h, 1, [...ALL_MINUTES]);
      if (options.length === 0) {
        // 理论上不会发生（明天 0–8 恒可用）；兜底。
        pushHour(0, 1, [0]);
      }
      return options;
    };

    const serialize = () => {
      const bj = beijingNow();
      const model = readModel(webCtx);
      const modelKind = /deepseek/i.test(model.provider) ? classifyModel(model.model) : "other";
      return {
        enabled: effective(bj),
        effectiveFrom,
        debug,
        beijing: bj,
        peakWindows: windows.map((w) => ({
          start: w.start,
          end: w.end,
          label: `${String(Math.floor(w.start / 60)).padStart(2, "0")}:00–${String(Math.floor(w.end / 60)).padStart(2, "0")}:00`,
        })),
        inPeak: isPeak(bj.minutes, windows),
        model,
        modelKind,
        prices: PRICES,
        reminder: state.reminder,
        remindedToday: state.reminded !== null && state.reminded.date === bj.date && state.reminded.dismissed,
        tasks: state.tasks.map((t) => ({ ...t })),
        hourOptions: buildHourOptions(),
        serverTime: Date.now(),
      };
    };

    const route = (path, handler) => {
      webCtx.effect(
        () => webCtx.webServer.register({
          kind: "exact",
          path,
          handler,
        }),
        `offpeak: route ${path}`,
      );
    };

    route("/ds-offpeak/state", (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      const payload = serialize();
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(req.method === "HEAD" ? undefined : body);
    });

    // 确认提醒（继续执行 / 关闭）。
    route("/ds-offpeak/ack", async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: "untrusted origin" });
        return;
      }
      const body = await readJson(req);
      if (body === null || typeof body.nonce !== "string" || state.reminder === null || body.nonce !== state.reminder.nonce) {
        sendJson(res, 400, { ok: false, error: "nonce mismatch" });
        return;
      }
      state.reminder = null;
      sendJson(res, 200, { ok: true });
    });

    // 今日不再提醒。
    route("/ds-offpeak/dismiss", async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: "untrusted origin" });
        return;
      }
      const body = await readJson(req);
      const forToday = body !== null && body.forToday === true;
      if (forToday) {
        state.reminded = { date: beijingNow().date, dismissed: true };
        persist();
      }
      state.reminder = null;
      sendJson(res, 200, { ok: true, remindedToday: forToday });
    });

    // 登记定时任务。
    route("/ds-offpeak/schedule", async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: "untrusted origin" });
        return;
      }
      const body = await readJson(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: "bad json" });
        return;
      }
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const atMs = Number(body.atMs);
      if (text === "" || !Number.isFinite(atMs)) {
        sendJson(res, 400, { ok: false, error: "text and atMs required" });
        return;
      }
      if (atMs <= Date.now() + MIN_SCHEDULE_AHEAD_MS) {
        sendJson(res, 400, { ok: false, error: "atMs must be in the future" });
        return;
      }
      if (atMs > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
        sendJson(res, 400, { ok: false, error: "atMs too far in the future" });
        return;
      }
      // 会话 id 由浏览器端提供（拦截弹窗在消息发出前登记，服务端无从捕获会话）。
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      if (sessionId === "" || !/^[A-Za-z0-9-]+$/.test(sessionId)) {
        sendJson(res, 400, { ok: false, error: "sessionId required" });
        return;
      }
      const task = {
        id: randomUUID(),
        text,
        sessionId,
        atMs,
        createdAt: Date.now(),
        status: "scheduled",
      };
      state.tasks.push(task);
      state.reminder = null;
      persist();
      sendJson(res, 200, { ok: true, id: task.id, atMs: task.atMs });
    });

    // 取消定时任务。
    route("/ds-offpeak/cancel", async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: "untrusted origin" });
        return;
      }
      const body = await readJson(req);
      if (body === null || typeof body.id !== "string") {
        sendJson(res, 400, { ok: false, error: "id required" });
        return;
      }
      const task = state.tasks.find((t) => t.id === body.id);
      if (task === undefined) {
        sendJson(res, 404, { ok: false, error: "task not found" });
        return;
      }
      task.status = "cancelled";
      persist();
      sendJson(res, 200, { ok: true });
    });

    // 手动执行（调试/补跑）。
    route("/ds-offpeak/execute", async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: "untrusted origin" });
        return;
      }
      const body = await readJson(req);
      if (body === null || typeof body.id !== "string") {
        sendJson(res, 400, { ok: false, error: "id required" });
        return;
      }
      const task = state.tasks.find((t) => t.id === body.id);
      if (task === undefined) {
        sendJson(res, 404, { ok: false, error: "task not found" });
        return;
      }
      const result = await executeTask(task);
      sendJson(res, result.ok ? 200 : 502, result);
    });

    // 调试：模拟一次高峰时段的命令到达（仅 debug 模式可用）。
    route("/ds-offpeak/debug-remind", async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      if (!debug) {
        sendJson(res, 403, { ok: false, error: "debug disabled" });
        return;
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: "untrusted origin" });
        return;
      }
      const body = await readJson(req);
      const text = body !== null && typeof body.text === "string" ? body.text : "（模拟命令）";
      const sessionId = body !== null && typeof body.sessionId === "string" ? body.sessionId : "";
      const force = body !== null && body.force === true;
      if (force) {
        // 强制生成提醒（跳过高峰时段检查，便于非高峰时段验证弹窗链路）。
        const model = readModel(ctx);
        state.reminder = {
          nonce: randomUUID(),
          atMs: Date.now(),
          text,
          sessionId,
          model: model.model,
          modelKind: classifyModel(model.model),
        };
      } else {
        handleCommandStart({ id: sessionId }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } });
      }
      sendJson(res, 200, { ok: true, reminder: state.reminder });
    });
  });
}
