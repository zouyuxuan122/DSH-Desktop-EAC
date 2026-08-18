'use strict';

// 配套插件 / 皮肤同步（architecture-refactor-plan.md Phase 1：profile/ 领域）。
//
// syncCompanionPlugins 从 main.js 原样迁出：把内置配套插件与皮肤同步进桌面
// 专属 profile（web-desktop），并维护 cordis.patch.yml 的 overlay 行 ——
// 幂等（已有行不重写，用户选择优先），每轮启动 / 服务重启 / agent 更新后
// 重放，失败仅记录不阻塞启动。整棵树的核心逻辑见 main.js 原实现，逐行保留。
//
// 依赖注入：本函数只引用稳定函数 / 常量 / 模块（无可变状态），全部经 deps
// 按引用传入；__dirname 位于 profile/ 子目录，引用应用根目录资源时需上溯
// 一层（../assets、../builtin-collision）。

function createCompanionSync(deps) {
  const {
    dshHomePath, ensureDesktopProfileInit,
    applySessionManageFix, patchApiproxyBridgeNamespace,
    desktopProfileDir, syncBundledPresets, ensureDefaultAgentPreset,
    loadBuiltinPluginState, removedPluginIds, removeOwnedPluginPackage,
    builtinPluginSourceDir, copyPluginPackage,
    healSoulMdPatchRow, healRowConfig, healRowDisabled,
    collectBundleEntryIds, removeBundledRowDuplicates,
    hasEntryId, configLinesFor, removePluginFromPatch,
    applyLegacySkinChoice, showMainWindow, ensureGuard,
    COMPANION_PLUGINS, SKINS_DIR, readJsonFile,
    removeMarketDuplicate = require('../builtin-collision').removeMarketDuplicate,
    fs, path, Notification, log,
  } = deps;

  function syncCompanionPlugins() {
    try {
      const home = dshHomePath();
    // 桌面专属 profile 必须先存在（未知 profile 不会被 dsh 自动初始化）。
    ensureDesktopProfileInit();
    // V4 运行时补丁（幂等，随启动 / 服务重启 / agent 更新后重放）：
    //  · 对话删除/归档 —— dsh-session-manager 插件的全链路前置依赖；
    //  · ClawBot 设置命名空间 —— openclaw-bridge 的设置页读写依赖。
    applySessionManageFix();
    patchApiproxyBridgeNamespace();
    const profileDirP = desktopProfileDir();
    // 内置社区 agent preset（anchored-standard：首请求锚定 Minimal 工具对，
    // 首次工具调用/回复后开放完整 Standard 目录）：安装到用户 preset 根。
    // preset 不进插件树，坏 preset 不会拖垮启动；已存在则跳过（用户手装
    // 或改过的版本优先），见 preset-sync.js。
    const presetsSynced = syncBundledPresets(
      path.join(__dirname, '..', 'assets', 'agent-presets'),
      path.join(home, '.agent-presets'),
      (m) => log('boot', m)
    );
    if (presetsSynced.installed.length) log('boot', '已安装内置 agent preset: ' + presetsSynced.installed.join(', '));
    // 默认 preset 指到内置的 anchored-standard（用户已在 settings.yaml 写过
    // default 则一律保留）。失败只降级为官方默认 preset，不影响启动。
    const defaultResult = ensureDefaultAgentPreset(home, 'anchored-standard', (m) => log('boot', m));
    if (defaultResult === 'set') log('boot', '已设置默认 agent preset: anchored-standard');
    else if (defaultResult === 'kept') log('boot', '用户已设置默认 agent preset，保持不变');
    fs.mkdirSync(path.join(profileDirP, 'node_modules'), { recursive: true });
    const builtinState = loadBuiltinPluginState(profileDirP);
    const pending = [];
    const removedIds = removedPluginIds();
    // V4.2：用户曾从市场安装过与内置插件同名的包时，写包前先迁移残留
    // （package.json 依赖/bundles + patch 行），让内置版干净接管，避免
    // duplicate loader entry；完成后系统通知告知「插件树变化」。
    const migratedBuiltins = [];
    for (const p of COMPANION_PLUGINS) {
      // 用户移除过的内置插件不再复制/登记；兼容旧的 settings 标记和本地
      // profile 状态文件两套卸载记录。卸载状态下同时清理已有副本。
      const uninstalled = builtinState.plugins[p.id]?.state === 'uninstalled';
      if (removedIds.has(p.id) || uninstalled) {
        if (uninstalled) {
          const cleaned = removeOwnedPluginPackage(profileDirP, p.name);
          if (!cleaned.ok) log('boot', `卸载状态下清理内置插件失败，已保留目录: ${p.id}（${cleaned.error}）`);
        }
        log('boot', `已按用户选择跳过被移除的内置插件: ${p.id}`);
        continue;
      }
      // 非 @deepseek-ai 作用域的配套包用显式 dir 指定 assets/plugins 下的目录名；
      // 回退解析按「最后一个路径段」取（@scope/name → name；无 scope → 原名）。
      // V4 修复：旧回退是 name.slice('@deepseek-ai/'.length) —— 对无 scope 的
      // 长包名会截出错误目录（dsh-session-manager → 'manager'），该插件被
      // 静默跳过（行与包都不落盘）。
      const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name);
      // V4.3：覆盖层优先 —— 用户更新过的内置插件从 <userData>/builtin-plugin-updates
      // 拷贝（不被资产版本还原）；应用升级后资产版本更新则自动接管。
      const src = builtinPluginSourceDir(dirName);
      if (!fs.existsSync(path.join(src, 'package.json'))) {
        log('boot', `配套插件源目录无效，跳过: ${p.id} → ${src}`);
        continue;
      }
      try {
        // 先快照（保护中心）：迁移属于配置面手术，出问题可一键回滚。
        const dupPreCheck = (() => {
          try {
            const pkg = readJsonFile(path.join(profileDirP, 'package.json'));
            const spec = pkg && pkg.dependencies && pkg.dependencies[p.name];
            if (spec && !String(spec).startsWith('link:') && !String(spec).startsWith('file:')) return true;
            if (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) && pkg.dsh.profile.bundles.includes(p.name)) return true;
            const patchText = fs.readFileSync(path.join(profileDirP, 'cordis.patch.yml'), 'utf8');
            const esc = String(p.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp("name:\\s*['\"]?" + esc + "['\"]?\\s*$", 'm').test(patchText);
          } catch { return false; }
        })();
        if (dupPreCheck) ensureGuard().snapshot('builtin-migrate:' + p.id);
        const migrated = removeMarketDuplicate(profileDirP, p.name, { log: (m) => log('boot', m) });
        if (migrated.changed && migrated.ok) {
          migratedBuiltins.push({ name: p.name, dep: migrated.removedDep.length > 0, rows: migrated.removedRows });
          log('boot', `内置插件 ${p.name} 已接管市场同名包（移除依赖 ${migrated.removedDep.length} 个、patch 行 ${migrated.removedRows.length} 个）`);
        }
      } catch (err) {
        log('boot', `内置插件同名迁移失败(${p.id}): ${String((err && err.message) || err)}`);
      }
      copyPluginPackage(profileDirP, src, p.name);
      // p.disabled: true 的配套插件默认以禁用行注册（如 dsh-dafeiyu 桌宠），
      // 用户可在「设置 → 插件 → 管理」里启用；已有行不重写，用户选择优先。
      pending.push({ id: p.id, name: p.name, disabled: p.disabled === true, config: p.config });
    }
    if (migratedBuiltins.length) {
      try {
        const names = migratedBuiltins.map((m) => m.name).join('、');
        const n = new Notification({
          title: '内置插件已接管同名市场包',
          body: `检测到市场安装的重复包，已改用内置版本（${names}）。插件树已自动整理，本次启动生效。`,
          icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        });
        n.on('click', () => showMainWindow());
        n.show();
      } catch (err) {
        log('boot', '内置接管通知发送失败: ' + err.message);
      }
    }
    // 内置皮肤：行 id 取皮肤包 skin.json 的 wiring.id（ui-skin-*）。
    for (const entry of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(SKINS_DIR, entry.name);
      const pkg = readJsonFile(path.join(src, 'package.json'));
      if (!pkg || typeof pkg.name !== 'string' || !pkg.name.includes('/')) continue;
      const skin = readJsonFile(path.join(src, 'skin.json'));
      const rowId = skin && skin.wiring && typeof skin.wiring.id === 'string' ? skin.wiring.id : '';
      if (!/^ui-skin-[\w-]+$/.test(rowId)) continue;
      copyPluginPackage(profileDirP, src, pkg.name);
      pending.push({ id: rowId, name: pkg.name, disabled: true });
    }
    // 内置插件清单标记：插件市场据此把目录里的同名插件标为「已内置」并
    // 拒绝重复安装 —— 内置包每次启动都被重新同步，市场覆盖安装会产生
    // duplicate loader entry / 模块双实例，必须从源头拦截。
    try {
      // 即使用户卸载了某个插件，也保留它的 builtin 身份，阻止市场重新
      // 安装一个同名副本；恢复动作由本地插件管理器统一完成。
      const builtinNames = COMPANION_PLUGINS.map((p) => p.name).concat(
        pending.filter((p) => p.id.startsWith('ui-skin-')).map((p) => p.name)
      );
      const marker = path.join(profileDirP, '.dsh-builtin-plugins.json');
      const prev = readJsonFile(marker);
      const next = {
        names: [...new Set(builtinNames)],
        installed: pending.map((p) => p.name),
        uninstalled: COMPANION_PLUGINS.filter((p) => builtinState.plugins[p.id]?.state === 'uninstalled').map((p) => p.name),
        updatedAt: new Date().toISOString(),
      };
      const prevComparable = prev && {
        names: Array.isArray(prev.names) ? prev.names : [],
        installed: Array.isArray(prev.installed) ? prev.installed : [],
        uninstalled: Array.isArray(prev.uninstalled) ? prev.uninstalled : [],
      };
      const nextComparable = {
        names: next.names,
        installed: next.installed,
        uninstalled: next.uninstalled,
      };
      if (!prev || JSON.stringify(prevComparable) !== JSON.stringify(nextComparable)) {
        fs.writeFileSync(marker, JSON.stringify(next, null, 2) + '\n');
      }
    } catch (err) {
      log('boot', '写入内置插件清单失败: ' + err.message);
    }
    // 注册到 profile 的 patch 层（幂等：已有行不重写，用户选择的皮肤/disabled 状态保留）。
    const patchFile = path.join(profileDirP, 'cordis.patch.yml');
    let patch = '';
    try { patch = fs.readFileSync(patchFile, 'utf8'); } catch { patch = ''; }
    let changed = false;
    // 卸载是持久状态，不只是一次性删目录：启动/服务重启同步前先清理
    // 由桌面端生成的 insert 行及插件管理器留下的 disabled 覆盖。
    for (const p of COMPANION_PLUGINS) {
      if (builtinState.plugins[p.id]?.state !== 'uninstalled') continue;
      const removed = removePluginFromPatch(patch, p.id);
      if (removed.text !== patch) {
        patch = removed.text;
        changed = true;
        log('boot', '已应用内置插件卸载状态: ' + p.id);
      }
    }
    // 先修存量坏行：v2.0.0 写入的 soul-md 行缺 config.path（见 patch-row-heal.js
    // 头注释），不修则升级用户仍会 “dsh web 启动失败 (退出码 1)”。
    const healed = healSoulMdPatchRow(patch);
    if (healed.healed.length) {
      patch = healed.patch;
      changed = true;
      log('boot', '已修复 profile patch 中缺 config.path 的 soul-md 行');
    }
    // V4：修复 v3.1.0 及以前写出的「无 config 的 dsh-pet 行」（loader 传
    // undefined → dsh-pet 读 config.fullRoot 崩 → 插件树整体加载失败）。
    const healedPet = healRowConfig(patch, 'dsh-pet', { size: 260, position: 'bottom-right' });
    if (healedPet.healed.length) {
      patch = healedPet.patch;
      changed = true;
      log('boot', '已修复 profile patch 中缺 config 的 dsh-pet 行（v3 存量坏行）');
    }
    // v4.0.2 迁移：存量启用中的 tool-vision 行一次性禁用（v4.0.1 插件
    // 每轮请求必炸 llm/stream；4.0.2 已修本体但按需求不再默认启动）。
    // 只改不带 disabled 键的原始行，用户显式启用/禁用的行不碰。
    const healedVisionOff = healRowDisabled(patch, 'tool-vision');
    if (healedVisionOff.healed.length) {
      patch = healedVisionOff.patch;
      changed = true;
      log('boot', '已禁用 profile patch 中的 tool-vision 行（v4.0.2 默认不启动，可在插件管理中重新启用）');
    }
    // 市场安装（dsh plugin add）会把插件登记进 package.json 的
    // dsh.profile.bundles，加载时执行其包内 patch 挂载行；若 overlay 里
    // 也有一行（syncCompanionPlugins 写的），整个插件树会以
    // “duplicate loader entry id” 崩溃。清掉 overlay 重复行（包内行保留）。
    let bundled = [];
    try { bundled = readJsonFile(path.join(profileDirP, 'package.json'))?.dsh?.profile?.bundles || []; } catch { bundled = []; }
    // 同一 entry id 被两处声明（bundle 的包内 patch + overlay 的配套行）会以
    // “duplicate loader entry id” 拖垮整个插件树。旧逻辑只按「包名 ∈ bundles」
    // 匹配，git/fork/link 安装的插件包名与配套行包名不符时永远删不掉（issue
    // #16）。这里再解析每个 bundle 包实际声明的 entry id 集合：overlay 中 id
    // 已被任一 bundle 声明（无论包名如何）即视为重复。
    const declaredBundleIds = collectBundleEntryIds(bundled, path.join(profileDirP, 'node_modules'));
    const rowIds = {};
    for (const p of COMPANION_PLUGINS) rowIds[p.id] = p.name;
    const deduped = removeBundledRowDuplicates(patch, rowIds, bundled, declaredBundleIds);
    if (deduped.removed.length) {
      patch = deduped.patch;
      changed = true;
      log('boot', '已移除与 bundle 登记重复的 patch 行: ' + deduped.removed.join(', '));
    }
    for (const p of pending) {
      if (hasEntryId(patch, p.id)) continue;
      // 已在 bundle 列表里的插件由其包内 patch 挂载，overlay 不能再写行
      // （会 duplicate loader entry id，拖垮整个插件树）。issue #16：
      // 补充按 entry id 判断 —— git/fork 插件包名不同但 id 相同同样要跳过，
      // 否则每次启动把崩溃行写回，用户删掉也没用。
      if (bundled.includes(p.name) || declaredBundleIds.has(p.id)) continue;
      let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (p.config) block += configLinesFor(p.config);
      if (p.disabled) block += `      disabled: true\n`;
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(patchFile, patch);
      log('boot', '已同步配套插件/皮肤到 web profile: ' + pending.map((p) => p.id).join(', '));
    }
    // 迁移带来的皮肤选择（migrateFromSharedWebProfile 记录）在此落位。
    applyLegacySkinChoice();
  } catch (err) {
    log('boot', '同步配套插件失败: ' + err.message);
  }
  }

  return { syncCompanionPlugins };
}

module.exports = { createCompanionSync };
