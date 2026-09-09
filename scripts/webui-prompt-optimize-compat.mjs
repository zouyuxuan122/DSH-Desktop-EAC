// Reviewed dsh-webui 0.5.1 boundary; the staging caller owns package validation.
// Current owner: ui-conversation SessionStandardProps, upstream c389f96bf3a9b6807cb71ed6bdad5849be0df6d8.
export function migrateWebuiPromptOptimize(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  source = source.replace(/\r\n/g, '\n');
  const old = 'function PromptOptimizeButton({ available, directory, input, inputActions, sessionId }) {';
  const current = 'function PromptOptimizeButton({ available, directory, useInput, inputActions, sessionId }) {\n\t\t\tconst input = useInput((state) => state);';
  if (!(source.includes(current) && !source.includes(old))) {
    if (source.split(old).length !== 2) {
      throw new Error('Unrecognized dsh-webui prompt optimizer component boundary');
    }
    source = source.replace(old, current);
  }
  // applySkills precedes optimizer registration. Its old shared locale name
  // throws when the current official ui-skill has already registered.
  for (const [start, oldText, newText] of [
    ['function applyPromptOptimize(ctx)', '"modelDirectories",\n\t\t\t\t"sessions"',
      '"modelDirectories",\n\t\t\t\t"remote.session",\n\t\t\t\t"sessions"'],
    ['//#region src/client/skill-source/locales.ts', 'NS$1 = "skill";', 'NS$1 = "webui.skill";'],
    ['function apply$3(ctx)', 'key: "skill",\n\t\t\t\tlocale: NS$1',
      'key: "skill",\n\t\t\t\tpriority: -100,\n\t\t\t\tlocale: NS$1'],
  ]) {
    const from = source.indexOf(start);
    const to = source.indexOf('//#endregion', from + start.length);
    if (from < 0 || to < from || source.indexOf(start, from + start.length) >= 0) {
      throw new Error('Unrecognized dsh-webui skill registration boundary');
    }
    const original = source.slice(from, to);
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    let region = original.replace(/\r\n/g, '\n');
    if (!(region.includes(newText) && !region.includes(oldText))) {
      if (region.split(oldText).length !== 2) throw new Error('Unrecognized dsh-webui skill registration');
      region = region.replace(oldText, newText);
    }
    source = source.slice(0, from) + region.replace(/\n/g, newline) + source.slice(to);
  }

  // A stale localStorage flag can be left by an older build after the server
  // default was changed back to enabled. The old client reads that flag before
  // the async settings sync and permanently skips the slot for this page load.
  // Reconcile the prompt optimizer after the server response so an enabled
  // server default takes effect without requiring a second manual refresh.
  const syncStart = Math.max(
    source.indexOf('function syncServerModules() {'),
    source.indexOf('function syncServerModules(onModulesSynced) {'),
  );
  const syncEnd = source.indexOf('//#endregion', syncStart);
  if (syncStart < 0 || syncEnd < syncStart) {
    throw new Error('Unrecognized dsh-webui module sync boundary');
  }
  let syncRegion = source.slice(syncStart, syncEnd);
  if (!syncRegion.includes('function syncServerModules(onModulesSynced) {')) {
    const syncOld = 'function syncServerModules() {';
    const syncStore = 'if (JSON.stringify(current) !== JSON.stringify(disabled)) storeModules(disabled);';
    const syncNewStore = [
      'const changed = JSON.stringify(current) !== JSON.stringify(disabled);',
      'if (changed) storeModules(disabled);',
      'onModulesSynced?.(disabled);',
    ].join('\n');
    if (syncRegion.split(syncOld).length !== 2 || syncRegion.split(syncStore).length !== 2) {
      throw new Error('Unrecognized dsh-webui module sync implementation');
    }
    syncRegion = syncRegion.replace(syncOld, 'function syncServerModules(onModulesSynced) {')
      .replace(syncStore, syncNewStore);
    source = source.slice(0, syncStart) + syncRegion + source.slice(syncEnd);
  }

  const applyStart = source.indexOf('function apply(ctx) {');
  const applyEnd = source.indexOf('//#endregion', applyStart);
  if (applyStart < 0 || applyEnd < applyStart) {
    throw new Error('Unrecognized dsh-webui root apply boundary');
  }
  let applyRegion = source.slice(applyStart, applyEnd);
  if (!applyRegion.includes('const mountPromptOptimize = () => {')) {
    const applyOld = /function apply\(ctx\) \{\s+const moduleOverrides = readStoredModules\(\);\s+const on = \(key\) => isModuleEnabled\(moduleOverrides, key\);\s+syncServerModules\(\);/;
    const applyNew = [
      'function apply(ctx) {',
      '\t\t\tconst moduleOverrides = readStoredModules();',
      '\t\t\tconst on = (key) => isModuleEnabled(moduleOverrides, key);',
      '\t\t\tlet promptOptimizeMounted = false;',
      '\t\t\tconst mountPromptOptimize = () => {',
      '\t\t\t\tif (promptOptimizeMounted) return;',
      '\t\t\t\tpromptOptimizeMounted = true;',
      '\t\t\t\tapplyPromptOptimize(ctx);',
      '\t\t\t};',
      '\t\t\tsyncServerModules((modules) => {',
      '\t\t\t\tif (isModuleEnabled(modules, "promptOptimize")) mountPromptOptimize();',
      '\t\t\t});',
    ].join('\n');
    if (!applyOld.test(applyRegion)) {
      throw new Error('Unrecognized dsh-webui root module setup');
    }
    applyRegion = applyRegion.replace(applyOld, applyNew);
  }
  const promptCall = 'if (on("promptOptimize")) applyPromptOptimize(ctx);';
  if (applyRegion.includes(promptCall)) {
    applyRegion = applyRegion.replace(promptCall, 'if (on("promptOptimize")) mountPromptOptimize();');
  }
  source = source.slice(0, applyStart) + applyRegion + source.slice(applyEnd);
  return newline === '\n' ? source : source.replace(/\n/g, newline);
}
