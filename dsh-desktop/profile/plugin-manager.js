'use strict';

// 插件启停/卸载管理（architecture-refactor-plan.md Phase 1：profile/ 领域）。
//
// 从 main.js 原样迁出：设置页「插件 → 管理」标签的数据与写盘 —— 四个 IPC
// 驱动（dsh:plugin-list / dsh:plugin-set-enabled / dsh:plugin-uninstall /
// dsh:plugin-restore）的实现 + 图片粘贴保存。写盘用纯文本手术
// （scripts/plugin-manager-patch.js），保留文件其它内容与注释。
//
// 依赖注入：稳定函数 / 常量 / 模块按引用传入；serverProc / restartingServer
// 是 main.js 的可变 let，以 getter（getServerProc / getRestartingServer）调用，
// 每次执行取当前值，与原先闭包读取等价。__dirname 位于 profile/ 子目录，
// 引用应用根目录 assets 时需上溯一层（../assets/plugins）。

function createPluginManager(deps) {
  const {
    desktopProfileDir,
    ensureDesktopProfileInit,
    builtinPluginSourceDir, copyPluginPackage, removeOwnedPluginPackage,
    collectPluginRows, loadBuiltinPluginState, setBuiltinPluginState, clearBuiltinPluginState,
    COMPANION_PLUGINS, onboardingLogic,
    updater, updCtx, readJsonFile,
    togglePluginInPatch, removePluginFromPatch, hasEntryId, configLinesFor,
    ensureGuard, syncCompanionPlugins, restartWebServiceCore,
    recoverWebServiceAfterPluginFailure,
    getServerProc,
    getRestartingServer,
    fs, path, os, log,
  } = deps;

  // 惰性加载 js-yaml（内置 dsh 的传递依赖）；缺失时管理页降级为空列表。
  let dshYamlDialect = null;
  let dshYamlTried = false;

function loadDshYamlDialect() {
  if (dshYamlTried) return dshYamlDialect;
  dshYamlTried = true;
  try {
    const yaml = require('js-yaml');
    // 与 dsh 相同的 entry-list 方言：`!!js` 表达式是合法标量。
    const jsType = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data) => typeof data === 'string',
      construct: (data) => ({ __jsExpr: data }),
    });
    dshYamlDialect = { load: (content) => yaml.load(content, { schema: yaml.JSON_SCHEMA.extend(jsType) }) };
  } catch {
    dshYamlDialect = null;
  }
  return dshYamlDialect;
}

function pluginManagerReadPatch() {
  const file = path.join(desktopProfileDir(), 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const yaml = loadDshYamlDialect();
  if (!yaml) return { file, text, entries: [] };
  try {
    const parsed = yaml.load(text);
    return { file, text, entries: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { file, text, entries: [] };
  }
}

function pluginManagerPackageDescription(name) {
  if (!name) return '';
  const candidates = [
    path.join(desktopProfileDir(), 'node_modules', ...name.split('/')),
    path.join(__dirname, '..', 'assets', 'plugins', name.includes('/') ? name.slice(name.indexOf('/') + 1) : name),
  ];
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && typeof pkg.description === 'string' && pkg.description) return pkg.description;
    } catch {}
  }
  return '';
}

function pluginManagerCollect() {
  const { entries } = pluginManagerReadPatch();
  let bundles = [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(desktopProfileDir(), 'package.json'), 'utf8'));
    bundles = (m && m.dsh && m.dsh.profile && Array.isArray(m.dsh.profile.bundles)) ? m.dsh.profile.bundles : [];
  } catch {}
  return collectPluginRows(entries, {
    companion: COMPANION_PLUGINS.map((p) => ({ id: p.id, name: p.name })),
    coreIds: onboardingLogic.CORE_PLUGIN_IDS,
    removedIds: removedPluginIds(),
    builtinStates: loadBuiltinPluginState(desktopProfileDir()).plugins,
    describe: (name) => pluginManagerPackageDescription(name),
    bundles,
  });
}

function pluginManagerResolveName(id) {
  const c = COMPANION_PLUGINS.find((p) => p.id === id);
  if (c) return c.name;
  const { entries } = pluginManagerReadPatch();
  for (const entry of entries) {
    if (entry && Array.isArray(entry.insert)) {
      const it = entry.insert.find((x) => x && x.id === id);
      if (it && it.name) return it.name;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// 内置插件「移除」（V4.2）：把插件的 id 记入 settings.removedPlugins 跳过
// syncCompanionPlugins，同时清掉 profile 里的 patch 行与 node_modules 副本。
// 区别于「禁用」（停用但保留，随时可开）——移除是卸载语义，重启不还原；
// 市场里重复安装同名内置包也不被拒绝（内置清单已不含它）。
// ---------------------------------------------------------------------------

function removedPluginIds() {
  try {
    const s = updater.loadSettings(updCtx());
    return new Set(Array.isArray(s.removedPlugins) ? s.removedPlugins : []);
  } catch { return new Set(); }
}

function saveRemovedPluginIds(ids) {
  const ctx = updCtx();
  const s = updater.loadSettings(ctx);
  s.removedPlugins = Array.from(ids);
  updater.saveSettings(ctx, s);
}

// 恢复单个配套插件：立即复制包 + 补写 patch 行（与 syncCompanionPlugins
// 的写入规则一致），重启服务后生效。源目录走「覆盖层优先」（V4.3）：
// 被恢复的内置插件若是已更新版本，恢复回来的就是更新版。
function restoreCompanionPlugin(p) {
  const profileDirP = desktopProfileDir();
  const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name);
  const src = builtinPluginSourceDir(dirName);
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    return { ok: false, error: '配套插件源目录无效: ' + src };
  }
  copyPluginPackage(profileDirP, src, p.name);
  const patchFile = path.join(profileDirP, 'cordis.patch.yml');
  let patch = '';
  try { patch = fs.readFileSync(patchFile, 'utf8'); } catch {}
  if (!hasEntryId(patch, p.id)) {
    let bundled = [];
    try { bundled = readJsonFile(path.join(profileDirP, 'package.json'))?.dsh?.profile?.bundles || []; } catch { bundled = []; }
    if (!bundled.includes(p.name)) {
      let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (p.config) block += configLinesFor(p.config);
      if (p.disabled) block += `      disabled: true\n`;
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      try { fs.writeFileSync(patchFile, patch); } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
  }
  return { ok: true };
}

// removed=true 移除（卸载语义）；removed=false 恢复。核心插件拒绝移除。
function pluginManagerSetRemoved(id, removed) {
  const p = COMPANION_PLUGINS.find((x) => x.id === id);
  if (!p) return { ok: false, error: '未知内置插件: ' + String(id) };
  if (onboardingLogic.CORE_PLUGIN_IDS.has(id)) {
    return { ok: false, error: '核心插件不可移除: ' + String(id) };
  }
  const removedSet = removedPluginIds();
  const patchFile = path.join(desktopProfileDir(), 'cordis.patch.yml');
  try {
    if (removed) {
      // 1) 清 patch 行（顶层 + insert 内层）
      let text = '';
      try { text = fs.readFileSync(patchFile, 'utf8'); } catch {}
      const removed = removePluginFromPatch(text, id);
      const patched = typeof removed === 'string' ? removed : removed.text;
      if (patched !== text) fs.writeFileSync(patchFile, patched, 'utf8');
      // 2) 删 profile node_modules 里的包副本（copyPluginPackage 的产物）
      const pkgDir = path.join(desktopProfileDir(), 'node_modules', p.name);
      fs.rmSync(pkgDir, { recursive: true, force: true });
      // 3) 记入跳过清单（下次 sync 不再写回）
      removedSet.add(id);
      saveRemovedPluginIds(removedSet);
      log('plugin-manager', '已移除内置插件 ' + id);
      return { ok: true, restartRequired: true };
    }
    // 恢复：清出跳过清单 + 立即复制包与行
    removedSet.delete(id);
    saveRemovedPluginIds(removedSet);
    const res = restoreCompanionPlugin(p);
    if (!res.ok) return res;
    log('plugin-manager', '已恢复内置插件 ' + id);
    return { ok: true, restartRequired: true };
  } catch (err) {
    log('plugin-manager', '移除/恢复插件 ' + id + ' 失败: ' + ((err && err.message) || err));
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// 图片粘贴保存（dsh-image-paste 插件）：只接受 image/* 的 data URL，
// base64 解码后原子写入 %TEMP%/dsh-paste/<清洗名>-<时间戳><ext>，返回
// { ok, path, size }。文件在临时目录，随系统清理，不污染工作区。
const IMAGE_PASTE_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_PASTE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/ico': '.ico',
  'image/x-icon': '.ico',
  'image/tiff': '.tiff',
};

function imagePasteSave(dataUrl, name) {
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return { ok: false, error: '不是合法的图片 data URL' };
  const mime = m[1].toLowerCase();
  if (!IMAGE_PASTE_EXT[mime]) return { ok: false, error: '不支持的图片类型: ' + mime };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return { ok: false, error: '图片内容为空' };
  if (buf.length > IMAGE_PASTE_MAX_BYTES) return { ok: false, error: '图片超过 15MB 上限' };
  const dir = path.join(os.tmpdir(), 'dsh-paste');
  fs.mkdirSync(dir, { recursive: true });
  const base = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40) || '粘贴图片';
  const file = path.join(dir, base + '-' + Date.now() + IMAGE_PASTE_EXT[mime]);
  fs.writeFileSync(file, buf);
  return { ok: true, path: file, size: buf.length };
}

// 写入/移除用户层 disabled 条目（纯文本手术见 scripts/plugin-manager-patch.js）：
// 与上游的差异 —— 「启用」保留顶层裸条目 {id, name} 而不是整条移除，这样
// 默认禁用的配套插件（dsh-dafeiyu）被用户启用后不会被下次 sync 重新插回
// disabled 行（sync 的「已有行不重写」规则自然接管）。
function pluginManagerSetEnabled(id, enabled) {
  const file = path.join(desktopProfileDir(), 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  if (!text.trim()) text = '# dsh web profile patch（由 Deepseek Harness EAC 维护）\n';

  const name = pluginManagerResolveName(id);
  if (!enabled && !name) return { ok: false, error: '无法解析插件包名: ' + id };

  let patched;
  try {
    patched = togglePluginInPatch(text, id, !!enabled, name);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  if (patched !== text) {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, patched, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
  return { ok: true };
}

function pluginManagerPatchRemove(id) {
  const file = path.join(desktopProfileDir(), 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  let result;
  try {
    result = removePluginFromPatch(text, id);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  if (result.text !== text) {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, result.text, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
  return { ok: true, removed: result.removed };
}

function companionSource(p) {
  const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name);
  return path.join(__dirname, '..', 'assets', 'plugins', dirName);
}

function builtinPluginDefinition(id) {
  return COMPANION_PLUGINS.find((p) => p.id === id) || null;
}

function builtinPluginMutation(id, state) {
  const p = builtinPluginDefinition(id);
  if (!p) return { ok: false, error: '该插件不是桌面配套插件: ' + String(id) };
  if (p.required || p.uninstallable === false) return { ok: false, error: '该插件是系统必需插件，不可卸载: ' + id };
  const profileDirP = desktopProfileDir();
  ensureDesktopProfileInit();
  if (state === 'uninstalled') {
    const removed = removeOwnedPluginPackage(profileDirP, p.name);
    if (!removed.ok) return removed;
    const patch = pluginManagerPatchRemove(id);
    if (!patch.ok) return patch;
    setBuiltinPluginState(profileDirP, id, 'uninstalled');
    return { ok: true, removed: removed.removed, patchRows: patch.removed };
  }
  clearBuiltinPluginState(profileDirP, id);
  return { ok: true };
}

function builtinPluginRollback(id, previousState) {
  const p = builtinPluginDefinition(id);
  if (!p) return;
  const profileDirP = desktopProfileDir();
  if (previousState === 'uninstalled') {
    setBuiltinPluginState(profileDirP, id, 'uninstalled');
    removeOwnedPluginPackage(profileDirP, p.name);
    pluginManagerPatchRemove(id);
  } else {
    clearBuiltinPluginState(profileDirP, id);
    const src = companionSource(p);
    if (fs.existsSync(path.join(src, 'package.json'))) copyPluginPackage(profileDirP, src, p.name);
    // Re-register the overlay row without starting a service. The next start
    // also runs this synchronizer, so a partial rollback remains recoverable.
    syncCompanionPlugins();
  }
}

async function pluginManagerUninstall(id) {
  const p = builtinPluginDefinition(id);
  if (!p) return { ok: false, error: '该插件不是桌面配套插件: ' + String(id) };
  if (p.required || p.uninstallable === false) return { ok: false, error: '该插件是系统必需插件，不可卸载: ' + id };
  if (getRestartingServer()) return { ok: false, error: '服务正在执行其它重启操作，请稍后重试' };
  const profileDirP = desktopProfileDir();
  const hadServer = !!getServerProc();
  const previous = loadBuiltinPluginState(profileDirP).plugins[id]?.state || 'installed';
  ensureGuard().snapshot('plugin-uninstall:' + id);
  const mutate = () => builtinPluginMutation(id, 'uninstalled');
  try {
    if (!getServerProc()) {
      const result = mutate();
      if (!result.ok) return result;
      syncCompanionPlugins();
      log('plugin-manager', '已卸载内置插件 ' + id + '（服务未运行）');
      return { ok: true, state: 'uninstalled', restartRequired: false };
    }
    const restarted = await restartWebServiceCore({ beforeSync: mutate });
    if (!restarted.ok) {
      builtinPluginRollback(id, previous);
      if (hadServer) await recoverWebServiceAfterPluginFailure();
      return { ok: false, error: '卸载后重启 Web 服务失败，已回滚：' + restarted.error };
    }
    log('plugin-manager', '已卸载内置插件 ' + id);
    return { ok: true, state: 'uninstalled', restartRequired: true, url: restarted.url };
  } catch (err) {
    try { builtinPluginRollback(id, previous); } catch (rollbackErr) { log('plugin-manager', '卸载回滚失败: ' + rollbackErr.message); }
    if (hadServer) await recoverWebServiceAfterPluginFailure();
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function pluginManagerRestore(id) {
  const p = builtinPluginDefinition(id);
  if (!p) return { ok: false, error: '该插件不是桌面配套插件: ' + String(id) };
  if (getRestartingServer()) return { ok: false, error: '服务正在执行其它重启操作，请稍后重试' };
  const profileDirP = desktopProfileDir();
  const hadServer = !!getServerProc();
  const previous = loadBuiltinPluginState(profileDirP).plugins[id]?.state || 'installed';
  if (previous !== 'uninstalled') return { ok: false, error: '该插件当前没有卸载状态: ' + id };
  ensureGuard().snapshot('plugin-restore:' + id);
  const mutate = () => builtinPluginMutation(id, 'installed');
  try {
    if (!getServerProc()) {
      const result = mutate();
      if (!result.ok) return result;
      syncCompanionPlugins();
      log('plugin-manager', '已恢复内置插件 ' + id + '（服务未运行）');
      return { ok: true, state: 'installed', restartRequired: false };
    }
    const restarted = await restartWebServiceCore({ beforeSync: mutate });
    if (!restarted.ok) {
      builtinPluginRollback(id, previous);
      if (hadServer) await recoverWebServiceAfterPluginFailure();
      return { ok: false, error: '恢复后重启 Web 服务失败，已回滚：' + restarted.error };
    }
    log('plugin-manager', '已恢复内置插件 ' + id);
    return { ok: true, state: 'installed', restartRequired: true, url: restarted.url };
  } catch (err) {
    try { builtinPluginRollback(id, previous); } catch (rollbackErr) { log('plugin-manager', '恢复回滚失败: ' + rollbackErr.message); }
    if (hadServer) await recoverWebServiceAfterPluginFailure();
    return { ok: false, error: String((err && err.message) || err) };
  }
}
  return {
    pluginManagerCollect,
    pluginManagerSetEnabled,
    pluginManagerSetRemoved,
    pluginManagerUninstall,
    pluginManagerRestore,
    imagePasteSave,
    pluginManagerResolveName,
    pluginManagerPatchRemove,
    builtinPluginDefinition,
    removedPluginIds,
    saveRemovedPluginIds,
    restoreCompanionPlugin,
    companionSource,
    builtinPluginMutation,
    builtinPluginRollback,
  };
}

module.exports = { createPluginManager };
