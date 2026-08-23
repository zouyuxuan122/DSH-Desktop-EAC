'use strict';

// plugin-guard.js — 桌面端内置的插件保护中心（融合社区三大保护插件并升华）：
//
//   lxzy-7/dsh-plugin-guard        → 安装前快照 / 一键与自动回滚 / 守护启动 /
//                                    事故报告（incident）
//   LX2000WASD/dsh-web-plugin-manager → 安装守卫（安装后验证 + 失败回滚）、
//                                    健康检查入口
//   chenw275-wq/dsh-plugin-healthcheck → 静态体检（模块遮蔽 / patch 行 / 高危
//                                    静态扫描），绝不执行插件代码
//
// 与三个独立插件不同，这里跑在 Electron 主进程里：
//   · 快照/回滚发生在「无服务进程持锁」的窗口期（重启间隙），不撞 Windows
//     文件锁；
//   · 守护启动直接包在 dsh web 的拉起链路上：起不来 → 体检 → 自动修复 →
//     重试 → 仍失败回滚到最后良好快照 → 再试 → 仍失败落事故报告并通知；
//   · junction 归属守卫（原生 dsh 共存，见 checkJunctionOwnership）。
//
// 原则（对齐 healthcheck 的 HARD RULE）：只动插件层与配置层
//（cordis.patch.yml / package.json / node_modules 里的遮蔽拷贝），
// 绝不修改 harness 内核或用户会话数据。

const fs = require('node:fs');
const path = require('node:path');

// 快照覆盖的 profile 配置面：插件树的全部「声明性」状态。
const GUARD_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'];
const MAX_SNAPSHOTS = 10;

// ── 静态高危扫描（healthcheck 的 C8 思路）────────────────────────────────
// 只做 readFileSync + 正则，绝不 require/执行插件代码；命中即报告（高危级），
// 不自动删除。模式面向「装完即失控」的常见木马形态，刻意保守以压低误报。
const TROJAN_PATTERNS = [
  { code: 'TROJAN_REMOTE_EXEC', re: /(?:child_process|execSync|spawnSync|exec|spawn)\s*\(\s*['"`](?:curl|wget|powershell|cmd|bash|sh)\b[^'"`]*['"`][\s\S]{0,200}(?:\|\s*(?:sh|bash|iex|Invoke-Expression)|-enc\b)/i },
  { code: 'TROJAN_DOWNLOAD_EXEC', re: /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr)\b[\s\S]{0,160}?(?:\|\s*(?:sh|bash|iex|Invoke-Expression)\b|Out-File[\s\S]{0,80}\.(?:ps1|bat|cmd|vbs))/i },
  { code: 'TROJAN_BASE64_EVAL', re: /(?:eval|Function)\s*\(\s*(?:atob|Buffer\.from\([^)]*,\s*['"]base64['"]\)|window\.atob)\s*\(/i },
  { code: 'TROJAN_PERSISTENCE', re: /(?:reg(?:\.exe)?\s+add[\s\S]{0,120}(?:Run|RunOnce)|Startup[\\\\/][\w.-]+\.(?:bat|cmd|ps1|vbs|lnk)|schtasks\s+\/create|Register-ScheduledTask)/i },
  { code: 'TROJAN_EXFIL_ENV', re: /(?:process\.env|os\.env)[\s\S]{0,120}(?:https?:\/\/|fetch\s*\(|XMLHttpRequest|net\.connect|dgram)/i },
];
const SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;   // 单文件扫描上限 2MB
const SCAN_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 单包总扫描上限 32MB
const SCAN_EXTS = /\.(c?js|mjs|cjs|json|yml|yaml|sh|ps1|bat|cmd)$/i;

function createGuard(opts) {
  const {
    getHome,          // () => string  有效的 DSH_HOME
    getProfile,       // () => string  桌面端使用的 profile 名
    dshBin,           // () => string  当前生效的 dsh bin（内置或 overlay）
    log = () => {},
  } = opts;

  const home = () => getHome() || path.join(require('node:os').homedir(), '.dsh');
  const profileDir = () => path.join(home(), 'profiles', getProfile());
  const guardDir = () => path.join(home(), 'guard');
  const rollbacksDir = () => path.join(home(), 'rollbacks', getProfile());
  const stateFile = () => path.join(guardDir(), 'state.json');
  const incidentsDir = () => path.join(guardDir(), 'incidents');

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    try { fs.renameSync(tmp, file); } catch {
      fs.rmSync(file, { force: true, maxRetries: 3 });
      fs.renameSync(tmp, file);
    }
  }

  // ── 快照 / 回滚（plugin-guard 的核心）────────────────────────────────
  // 只备份声明性配置（四个小文件），秒级完成；node_modules 实体不备份 ——
  // 回滚配置后，残留的包目录只是「不再被引用」，不影响加载。
  function snapshot(reason) {
    try {
      const dir = profileDir();
      if (!fs.existsSync(dir)) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
      const dest = path.join(rollbacksDir(), stamp);
      fs.mkdirSync(dest, { recursive: true });
      const files = [];
      const rows = [];
      for (const name of GUARD_FILES) {
        const src = path.join(dir, name);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(dest, name));
        files.push(name);
        if (name === 'cordis.patch.yml') {
          for (const id of patchRowIds(fs.readFileSync(src, 'utf8'))) rows.push(id);
        }
      }
      const meta = {
        id: stamp, reason: String(reason || 'manual'), at: new Date().toISOString(),
        files, pluginRows: rows,
      };
      writeJson(path.join(dest, 'meta.json'), meta);
      pruneSnapshots();
      log('guard', `已创建快照 ${stamp}（${reason}，${files.length} 个文件，${rows.length} 个插件行）`);
      return meta;
    } catch (err) {
      log('guard', '创建快照失败: ' + err.message);
      return null;
    }
  }

  function listSnapshots() {
    try {
      const root = rollbacksDir();
      if (!fs.existsSync(root)) return [];
      const out = [];
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = readJson(path.join(root, entry.name, 'meta.json'));
        if (!meta || !Array.isArray(meta.files) || meta.files.length === 0) continue;
        out.push(meta);
      }
      out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
      return out;
    } catch {
      return [];
    }
  }

  function pruneSnapshots() {
    try {
      const list = listSnapshots();
      for (let i = MAX_SNAPSHOTS; i < list.length; i += 1) {
        fs.rmSync(path.join(rollbacksDir(), list[i].id), { recursive: true, force: true, maxRetries: 2 });
      }
    } catch { /* 清理失败不影响主流程 */ }
  }

  function restore(id) {
    try {
      if (!/^[\w.-]+$/.test(String(id || ''))) return { ok: false, error: 'bad snapshot id' };
      const snapDir = path.join(rollbacksDir(), String(id));
      if (!fs.existsSync(snapDir)) return { ok: false, error: 'snapshot not found' };
      const dir = profileDir();
      fs.mkdirSync(dir, { recursive: true });
      // 回滚前给当前状态留一份「回滚前」快照，反悔有路。
      snapshot('pre-restore:' + id);
      const restored = [];
      for (const name of GUARD_FILES) {
        const src = path.join(snapDir, name);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(dir, name));
        restored.push(name);
      }
      log('guard', `已回滚 profile 到快照 ${id}（${restored.join(', ')}）`);
      return { ok: true, restored };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function state() {
    return readJson(stateFile(), {});
  }

  function markGood(id) {
    try {
      const s = state();
      s.lastGood = id || null;
      s.lastGoodAt = new Date().toISOString();
      writeJson(stateFile(), s);
    } catch { /* 标记失败无碍 */ }
  }

  function lastGoodSnapshot() {
    const s = state();
    if (!s.lastGood) return null;
    return listSnapshots().find((m) => m.id === s.lastGood) || null;
  }

  // ── 静态体检（healthcheck 的 L0/L1 思路）─────────────────────────────
  // 发现项：{ code, severity: 'high'|'medium'|'low', message, fixable }
  function healthCheck() {
    const findings = [];
    const dir = profileDir();

    // C3：profile node_modules 里遮蔽安装闭包 junction 的拷贝（真实目录或
    // pnpm 链接）→ 模块双实例 → Symbol 身份不一致 → 「设置命名空间不可用」。
    findings.push(...shadowFindings(dir));

    // patch 行体检：重复 entry id（duplicate loader entry → 整树崩溃）、
    // soul-md 行缺 config.path（v2.0.0 存量坏行）。
    findings.push(...patchFindings(dir));

    // junction 归属（原生 dsh 共存冲突，见 checkJunctionOwnership 注释）。
    findings.push(...junctionFindings());

    // 高危静态扫描：只扫非内置的第三方包。
    findings.push(...trojanFindings(dir));

    return { at: new Date().toISOString(), profile: getProfile(), findings };
  }

  // 供 main.js 周期性轻量检查（不打扰用户，只返回是否有异动）。
  function junctionFindings() {
    const out = [];
    try {
      const fallbackDir = path.join(home(), 'profiles', 'node_modules');
      const expected = expectedClosureRoot();
      if (!expected || !fs.existsSync(fallbackDir)) return out;
      for (const full of listFallbackNames(fallbackDir)) {
        const link = path.join(fallbackDir, full);
        let st;
        try { st = fs.lstatSync(link); } catch { continue; }
        if (!st.isSymbolicLink()) continue;
        const target = safeReadlink(link);
        if (!target) continue;
        const real = safeRealpath(link) || target;
        const expRoot = safeRealpath(expected) || expected;
        const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();
        if (!norm(real).startsWith(norm(expRoot))) {
          out.push({
            code: 'JUNCTION_FOREIGN',
            severity: 'high',
            message: `共享模块 ${full} 被外部 dsh 实例接管（指向 ${target}）`,
            fixable: true,
          });
        } else if (!fs.existsSync(real)) {
          out.push({
            code: 'JUNCTION_DANGLING',
            severity: 'high',
            message: `共享模块 ${full} 指向的目标已不存在（${target}）`,
            fixable: true,
          });
        }
      }
    } catch { /* 枚举失败按无发现处理 */ }
    return out;
  }

  function listFallbackNames(fallbackDir) {
    const names = [];
    let entries;
    try { entries = fs.readdirSync(fallbackDir, { withFileTypes: true }); } catch { return names; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink() || entry.isDirectory()) names.push(entry.name);
      else if (entry.isDirectory() === false && entry.name.includes('-')) continue;
      if (entry.isDirectory()) {
        let children;
        try { children = fs.readdirSync(path.join(fallbackDir, entry.name), { withFileTypes: true }); } catch { continue; }
        for (const child of children) {
          if (child.isSymbolicLink() || child.isDirectory()) names.push(entry.name + '/' + child.name);
        }
      }
    }
    return names;
  }

  // dshBin() 形如 <closure>/@deepseek-ai/dsh/lib/bin.js → 安装闭包根。
  function expectedClosureRoot() {
    try {
      return path.resolve(dshBin(), '../../../..');
    } catch {
      return null;
    }
  }

  function shadowFindings(dir) {
    const out = [];
    try {
      const fallbackDir = path.join(home(), 'profiles', 'node_modules');
      const modulesDir = path.join(dir, 'node_modules');
      if (!fs.existsSync(fallbackDir) || !fs.existsSync(modulesDir)) return out;
      for (const { full, rel } of fallbackPackages(fallbackDir)) {
        const shadow = path.join(modulesDir, rel);
        let st;
        try { st = fs.lstatSync(shadow); } catch { continue; }
        if (st.isDirectory() && !st.isSymbolicLink()) {
          out.push({ code: 'SHADOW_COPY', severity: 'high', message: `插件依赖把核心包 ${full} 装成了独立拷贝（模块双实例根源）`, fixable: true });
        } else if (st.isSymbolicLink()) {
          const target = safeReadlink(shadow) || '';
          const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();
          if (norm(target).includes(norm(path.join(modulesDir, '.pnpm')))) {
            out.push({ code: 'SHADOW_LINK', severity: 'high', message: `pnpm 把核心包 ${full} 链接进了 profile（模块双实例根源）`, fixable: true });
          }
        }
      }
    } catch { /* 枚举失败按无发现处理 */ }
    return out;
  }

  function fallbackPackages(fallbackDir) {
    const names = [];
    let entries;
    try { entries = fs.readdirSync(fallbackDir, { withFileTypes: true }); } catch { return names; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) names.push({ full: entry.name, rel: entry.name });
      else if (entry.isDirectory()) {
        let children;
        try { children = fs.readdirSync(path.join(fallbackDir, entry.name), { withFileTypes: true }); } catch { continue; }
        for (const child of children) {
          if (child.isSymbolicLink() || child.isDirectory()) {
            names.push({ full: entry.name + '/' + child.name, rel: path.join(entry.name, child.name) });
          }
        }
      }
    }
    return names;
  }

  function patchRowIds(patch) {
    const ids = [];
    const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
    let m;
    while ((m = re.exec(String(patch || ''))) !== null) ids.push(m[1]);
    return ids;
  }

  function patchFindings(dir) {
    const out = [];
    try {
      const file = path.join(dir, 'cordis.patch.yml');
      if (!fs.existsSync(file)) return out;
      const text = fs.readFileSync(file, 'utf8');
      const ids = patchRowIds(text);
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      for (const id of [...new Set(dup)]) {
        out.push({ code: 'PATCH_DUP_ID', severity: 'high', message: `patch 行 id 重复：${id}（会以 duplicate loader entry 拖垮整棵插件树）`, fixable: true });
      }
      if (/id:\s*soul-md\b/.test(text)) {
        const bad = /(^[\t ]*- id: soul-md\b[^\n]*\n[\t ]*name: ['"]?[^'"\n]+['"]?\n)(?![\t ]*config:)/m.test(text);
        if (bad) {
          out.push({ code: 'PATCH_SOUL_CONFIG', severity: 'medium', message: 'soul-md 行缺少 config.path（dsh web 退出码 1 的历史根因）', fixable: true });
        }
      }
    } catch { /* 读不了按无发现处理 */ }
    return out;
  }

  function trojanFindings(dir) {
    const out = [];
    try {
      const builtin = new Set(readJson(path.join(dir, '.dsh-builtin-plugins.json'), { names: [] }).names || []);
      const modulesDir = path.join(dir, 'node_modules');
      if (!fs.existsSync(modulesDir)) return out;
      let total = 0;
      const walk = (d, depth) => {
        if (depth > 4 || total > SCAN_MAX_TOTAL_BYTES || out.length >= 20) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name === '.pnpm' || e.name.startsWith('.')) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            const pkg = readJson(path.join(p, 'package.json'), null);
            if (pkg && builtin.has(pkg.name)) continue; // 内置分发包不扫
            walk(p, depth + 1);
          } else if (e.isFile() && SCAN_EXTS.test(e.name)) {
            let st;
            try { st = fs.statSync(p); } catch { continue; }
            if (st.size > SCAN_MAX_FILE_BYTES || total + st.size > SCAN_MAX_TOTAL_BYTES) continue;
            total += st.size;
            let text;
            try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
            for (const { code, re } of TROJAN_PATTERNS) {
              if (re.test(text)) {
                out.push({
                  code,
                  severity: 'high',
                  message: `静态扫描命中高危模式（${code}）：${path.relative(modulesDir, p)}`,
                  fixable: false,
                });
                break; // 每文件只报首个模式
              }
            }
          }
        }
      };
      walk(modulesDir, 0);
    } catch { /* 扫描失败按无发现处理 */ }
    return out;
  }

  // ── 修复执行器（只动插件/配置层）────────────────────────────────────
  function repair(findings) {
    const applied = [];
    const list = Array.isArray(findings) ? findings : (healthCheck().findings);
    const dir = profileDir();

    if (list.some((f) => f.code === 'SHADOW_COPY' || f.code === 'SHADOW_LINK')) {
      try {
        const { healProfileModuleShadowing } = require('./profile-module-heal');
        const removed = healProfileModuleShadowing(home(), getProfile(), (m) => log('guard', m));
        if (removed.length) applied.push('清理模块遮蔽: ' + removed.join(', '));
      } catch (err) {
        log('guard', '清理模块遮蔽失败: ' + err.message);
      }
    }

    if (list.some((f) => f.code === 'PATCH_DUP_ID' || f.code === 'PATCH_SOUL_CONFIG')) {
      try {
        const { healSoulMdPatchRow, removeBundledRowDuplicates, collectBundleEntryIds } = require('./patch-row-heal');
        const file = path.join(dir, 'cordis.patch.yml');
        let patch = fs.readFileSync(file, 'utf8');
        const healed = healSoulMdPatchRow(patch);
        if (healed.healed.length) { patch = healed.patch; applied.push('补写 soul-md 行 config.path'); }
        const ids = {};
        for (const id of patchRowIds(patch)) ids[id] = ids[id] || null;
        let bundled = [];
        try { bundled = readJson(path.join(dir, 'package.json'))?.dsh?.profile?.bundles || []; } catch { bundled = []; }
        const declaredBundleIds = collectBundleEntryIds(bundled, path.join(dir, 'node_modules'));
        const { patch: deduped, removed } = removeBundledRowDuplicates(patch, ids, bundled, declaredBundleIds);
        if (removed.length) {
          patch = deduped;
          applied.push('移除与 bundle 重复的 patch 行: ' + removed.join(', '));
        }
        if (healed.healed.length || removed.length) fs.writeFileSync(file, patch);
      } catch (err) {
        log('guard', '修复 patch 行失败: ' + err.message);
      }
    }

    if (list.some((f) => f.code === 'JUNCTION_FOREIGN' || f.code === 'JUNCTION_DANGLING')) {
      const result = repairJunctions();
      if (result.repaired.length) applied.push('恢复共享模块指向: ' + result.repaired.slice(0, 5).join(', ') + (result.repaired.length > 5 ? ` 等 ${result.repaired.length} 个` : ''));
    }

    return { applied };
  }

  // 把被外部 dsh 实例改指向的共享 junction 重新指回本客户端的安装闭包。
  // 这是「与原生 dsh 冲突」的根治面：dsh-app-boot 每次启动都会把
  // <home>/profiles/node_modules 的 junction 指向「自己」的闭包 —— 原生 CLI
  // 一跑，桌面的模块解析就被换血（版本错位 / npx 缓存被清后悬空）。
  // 这里以 dshBin() 推导闭包根，逐个纠正指向；闭包里不存在的名字（原生
  // 新版才有的包）保留原样并报告。
  function repairJunctions() {
    const repaired = [];
    const unknown = [];
    try {
      const fallbackDir = path.join(home(), 'profiles', 'node_modules');
      const expected = expectedClosureRoot();
      if (!expected || !fs.existsSync(fallbackDir)) return { repaired, unknown };
      fs.mkdirSync(fallbackDir, { recursive: true });
      const expRoot = safeRealpath(expected) || expected;
      const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();
      for (const { full, rel } of fallbackPackages(fallbackDir)) {
        const link = path.join(fallbackDir, rel);
        let st;
        try { st = fs.lstatSync(link); } catch { continue; }
        // 只处理链接；真实目录是历史损坏形态，交给人处理。
        if (!st.isSymbolicLink()) continue;
        const target = safeReadlink(link);
        if (!target) continue;
        const real = safeRealpath(link) || target;
        const good = norm(real).startsWith(norm(expRoot)) && fs.existsSync(real);
        if (good) continue;
        const want = path.join(expRoot, rel);
        if (!fs.existsSync(path.join(want, 'package.json'))) {
          unknown.push(full);
          continue;
        }
        try {
          removeLink(link);
          fs.symlinkSync(want, link, 'junction');
          repaired.push(full);
        } catch (err) {
          log('guard', `恢复 junction ${full} 失败: ` + err.message);
        }
      }
      if (repaired.length) {
        log('guard', '已把 ' + repaired.length + ' 个共享模块指回客户端闭包');
      }
      if (unknown.length) {
        log('guard', '闭包中不存在的共享模块（保留原指向）: ' + unknown.slice(0, 10).join(', '));
      }
    } catch (err) {
      log('guard', 'junction 归属修复失败: ' + err.message);
    }
    return { repaired, unknown };
  }

  // ── 事故报告（plugin-guard 的 incident）──────────────────────────────
  function reportIncident(title, detail) {
    try {
      fs.mkdirSync(incidentsDir(), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = String(title || 'incident').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const file = path.join(incidentsDir(), stamp + '-' + slug + '.md');
      const body = [
        '# ' + (title || '事故报告'),
        '',
        '- 时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
        '- profile：' + getProfile(),
        '- 客户端快照保留：' + listSnapshots().length + ' 份',
        '',
        '## 详情',
        '',
        '```',
        String(detail || '').slice(0, 20000),
        '```',
        '',
      ].join('\n');
      fs.writeFileSync(file, body);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function listIncidents() {
    try {
      const dir = incidentsDir();
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md') && !f.endsWith('.resolved.md'))
        .sort()
        .reverse()
        .map((f) => ({ id: f, title: f.replace(/\.md$/, '') }));
    } catch {
      return [];
    }
  }

  function readIncident(id) {
    try {
      if (!/^[\w.-]+\.md$/.test(String(id || ''))) return { ok: false, error: 'bad id' };
      const file = path.join(incidentsDir(), id);
      if (!fs.existsSync(file)) return { ok: false, error: 'not found' };
      return { ok: true, content: fs.readFileSync(file, 'utf8').slice(0, 30000) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function resolveIncident(id) {
    try {
      if (!/^[\w.-]+\.md$/.test(String(id || ''))) return { ok: false, error: 'bad id' };
      const file = path.join(incidentsDir(), id);
      if (!fs.existsSync(file)) return { ok: false, error: 'not found' };
      fs.renameSync(file, file + '.resolved.md');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // ── 守护启动（guarded boot）──────────────────────────────────────────
  // startOnce: () => Promise<url>（真正的拉起动作）。失败链路：
  //   体检 → 可修复项修复 → 重试 → 仍有最后良好快照则回滚 → 重试 → 事故报告。
  // 每层只重试一次，绝不无限循环。
  // V4.2：opts.preRetry(errText) 是配置级修复钩子（pnpm allowBuilds 等），
  // 返回 { applied: [...] }（或真值）即视为「已修复」，与 repair() 结果合并
  // 后一起重试一次；返回 false 则走原链路。钩子只调用一次。
  async function guardedBoot(startOnce, describeFailure, opts = {}) {
    const snap = snapshot('boot');
    try {
      const url = await startOnce();
      if (snap) markGood(snap.id);
      return url;
    } catch (firstErr) {
      log('guard', '守护启动：首次拉起失败，进入体检修复流程');
      const { findings } = healthCheck();
      const fixable = findings.filter((f) => f.fixable);
      for (const f of findings) log('guard', `[体检] ${f.code}(${f.severity}): ${f.message}`);

      // V4.2：allowBuilds 等配置级修复钩子（只调用一次，返回 false 不打扰）。
      let preApplied = [];
      if (opts.preRetry) {
        try {
          const r = await opts.preRetry(String((firstErr && firstErr.message) || firstErr));
          if (r && Array.isArray(r.applied) && r.applied.length) preApplied = r.applied;
          else if (r) preApplied = ['配置级修复钩子已应用'];
        } catch (err) {
          log('guard', 'preRetry 钩子失败: ' + String((err && err.message) || err));
        }
      }

      if (fixable.length || preApplied.length) {
        const { applied } = repair(findings);
        const all = [...applied, ...preApplied];
        if (all.length) {
          log('guard', '已应用修复: ' + all.join('；'));
          try {
            const url = await startOnce();
            if (snap) markGood(snap.id);
            reportIncident('boot-recovered', '首次启动失败，自动修复后恢复。\n修复项：\n- ' + all.join('\n- ') + '\n\n原始错误：\n' + String((firstErr && firstErr.message) || firstErr));
            return url;
          } catch (secondErr) {
            log('guard', '修复后重试仍失败，进入回滚流程');
            return rollbackPath(secondErr, snap, describeFailure);
          }
        }
      }
      return rollbackPath(firstErr, snap, describeFailure);
    }
  }

  async function rollbackPath(err, bootSnap, describeFailure) {
    const good = lastGoodSnapshot();
    if (good && (!bootSnap || good.id !== bootSnap.id)) {
      log('guard', `回滚到最后良好快照 ${good.id}（${good.reason}）`);
      const res = restore(good.id);
      if (res.ok) {
        repair(healthCheck().findings); // 回滚后再清一次遮蔽（pnpm 可能刚 hoist 过）
        try {
          const url = await guardedBootRetryOnce();
          return url;
        } catch (finalErr) {
          reportIncident('rollback-failed', '回滚到快照 ' + good.id + ' 后仍无法启动。\n\n最终错误：\n' + String((finalErr && finalErr.message) || finalErr));
          throw finalErr;
        }
      }
    }
    reportIncident('boot-failed', '启动失败且无可回滚快照。\n\n错误：\n' + String((err && err.message) || err) + (describeFailure ? '\n\n' + describeFailure() : ''));
    throw err;
  }

  // 回滚后的拉起也要留「最后良好」标记 —— 交给调用方包一层。
  let rollbackLift = null;
  function setRollbackLift(fn) { rollbackLift = fn; }
  async function guardedBootRetryOnce() {
    if (rollbackLift) return rollbackLift();
    throw new Error('rollback lift not configured');
  }

  // ── 启动失败归因（V4.2）────────────────────────────────────────────
  // 把启动报错文案里的包名/行 id 对应到 profile 里「可停用的插件」：
  //   · 命中 patch 行 id/name → 返回 { name, kind: 'patchRow', rowId }
  //   · 命中 bundles / dependencies 键 → 返回 { name, kind, rowId: null }
  // 归因失败（报错不含可识别包名）返回 null —— 调用方退回通用按钮。
  // 只读 profile 配置面，绝不执行插件代码。
  function attributeBootFailure(errText) {
    try {
      const text = String(errText || '');
      if (!text) return null;
      const dir = profileDir();
      const candidates = [];
      const push = (raw) => {
        const k = String(raw || '').replace(/['",.;:]+$/g, '');
        if (k && /^@?[A-Za-z0-9][A-Za-z0-9._@/+-]*$/.test(k) && !candidates.includes(k)) candidates.push(k);
      };
      const patterns = [
        /duplicate (?:loader )?entry[^\n]*?['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?/gi,
        /already registered[^\n]*?['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?/gi,
        /cannot find module\s+['"]([^'"]+)['"]/gi,
        /failed to (?:load|apply|initialize|resolve)\s+(?:plugin|entry|bundle)[^\n]*?['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?/gi,
        /(?:plugin|entry|bundle)\s+['"]?(@?[A-Za-z0-9][\w.@/-]*)['"]?\s+(?:failed|not found|unavailable|rejected)/gi,
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) push(m[1]);
      }
      if (candidates.length === 0) return null;

      const manifest = readJson(path.join(dir, 'package.json'), {});
      const bundles = (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)) ? manifest.dsh.profile.bundles : [];
      const depKeys = Object.keys(manifest.dependencies || {});
      // patch 行（顶层 + insert 内层）→ { id, name }
      let patchText = '';
      try { patchText = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'); } catch {}
      const rows = [];
      if (patchText) {
        const lines = patchText.split(/\r?\n/);
        let pendingId = null;
        for (const line of lines) {
          const idm = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(line);
          if (idm !== null) {
            if (pendingId !== null) rows.push({ id: pendingId, name: null });
            pendingId = idm[1];
            continue;
          }
          const nm = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
          if (nm !== null && pendingId !== null) {
            rows.push({ id: pendingId, name: nm[1] });
            pendingId = null;
            continue;
          }
          if (pendingId !== null && /^\s*-\s*insert:/.test(line)) {
            rows.push({ id: pendingId, name: null });
            pendingId = null;
          }
        }
        if (pendingId !== null) rows.push({ id: pendingId, name: null });
      }

      for (const cand of candidates) {
        const row = rows.find((r) => r.id === cand || r.name === cand);
        if (row) return { name: row.name || row.id, kind: 'patchRow', rowId: row.id };
        if (bundles.includes(cand)) return { name: cand, kind: 'bundle', rowId: null };
        if (depKeys.includes(cand)) return { name: cand, kind: 'dependency', rowId: null };
      }
      return null;
    } catch {
      return null;
    }
  }

  function safeReadlink(p) {
    try { return fs.readlinkSync(p); } catch { return null; }
  }

  // Windows 上 rmSync(force) 对 junction 会抛 ERR_FS_EISDIR —— 删链接必须
  // 走 unlink（只摘链接本身，绝不递归目标）。
  function removeLink(p) {
    try { fs.unlinkSync(p); return; } catch { /* fall through */ }
    fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 });
  }

  function safeRealpath(p) {
    try { return fs.realpathSync(p); } catch { return null; }
  }

  return {
    snapshot, listSnapshots, restore, markGood, lastGoodSnapshot,
    healthCheck, repair, repairJunctions, junctionFindings,
    reportIncident, listIncidents, readIncident, resolveIncident,
    guardedBoot, setRollbackLift, attributeBootFailure,
  };
}

module.exports = { createGuard, GUARD_FILES };
