import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
export const REPORT_CONST = {
    PLUGIN: "plugin",
};
// ── Singleton ──
let _reporter;
export function initReporter(opts) {
    if (_reporter)
        return;
    if (!opts.enabled)
        return;
    switch (opts.type) {
        case "local":
            _reporter = new LocalReporter(opts.logger, opts.instanceId, opts.pluginVersion);
            break;
        // TODO: add new reporter type
        default:
            opts.logger.debug?.(`[memory-tdai] Unknown reporter type "${opts.type}", disabled reporting`);
            break;
    }
}
export function setReporter(reporter) {
    _reporter = reporter;
}
/**
 * Reset the reporter singleton so that the next `initReporter` call takes effect.
 * Must be called at plugin re-registration (hot-reload) to pick up config changes.
 */
export function resetReporter() {
    _reporter = undefined;
}
export function report(event, data) {
    if (!_reporter)
        return;
    try {
        _reporter.reportFunc(REPORT_CONST.PLUGIN, { event, ...data });
    }
    catch { /* never block business logic */ }
}
// ── LocalReporter (default) ──
class LocalReporter {
    logger;
    instanceId;
    pluginVersion;
    constructor(logger, instanceId, pluginVersion) {
        this.logger = logger;
        this.instanceId = instanceId;
        this.pluginVersion = pluginVersion;
    }
    reportFunc(category, payload) {
        try {
            this.logger.info(JSON.stringify({
                tag: "METRIC",
                category,
                plugin: "memory-tdai",
                instanceId: this.instanceId,
                pluginVersion: this.pluginVersion,
                ts: new Date().toISOString(),
                ...payload,
            }));
        }
        catch { /* swallow */ }
    }
}
// ── Instance ID (persisted per-install) ──
let _instanceIdCache;
export async function getOrCreateInstanceId(pluginDataDir) {
    if (_instanceIdCache)
        return _instanceIdCache;
    const idFile = path.join(pluginDataDir, ".metadata", "instance_id");
    try {
        const existing = (await fs.readFile(idFile, "utf-8")).trim();
        if (existing) {
            _instanceIdCache = existing;
            return existing;
        }
    }
    catch { /* file doesn't exist */ }
    const newId = randomUUID();
    await fs.mkdir(path.dirname(idFile), { recursive: true });
    await fs.writeFile(idFile, newId, "utf-8");
    _instanceIdCache = newId;
    return newId;
}
