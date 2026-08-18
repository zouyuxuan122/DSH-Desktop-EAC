'use strict';

// 内置资产同步 + dsh 运行副本补丁（architecture-refactor-plan.md Phase 1：
// profile/ 领域）。启动与 syncCompanionPlugins 时重放的幂等操作：
//   1. syncBundledSkills —— 内置 skills 分发到 ~/.dsh/skills（带
//      .eac-skill.json 标记的目录由 EAC 管理，版本变化覆盖更新；
//      用户自建同名目录永不覆盖）；
//   2. applySessionManageFix —— dsh-session-manager 前置依赖的对话删除
//      补丁（锚点不匹配自动跳过，绝不损坏文件）；
//   3. patchApiproxyBridgeNamespace —— openclaw-bridge 设置命名空间白名单。
// 全部幂等、失败仅记录（不阻塞启动），与 main.js 原实现逐行一致。
//
// 注意：本模块位于 profile/ 子目录，引用应用根目录资源时 __dirname 需
// 上溯一层（../assets、../node_modules）。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function createRuntimePatches(deps) {
  const {
    dshHome, // () => string —— main.js 的 let，调用期取当前值
    userDataDir, // () => string —— 同上
    readJsonFile,
    patchSessionManage,
    log,
    fsImpl = fs,
    pathImpl = path,
    osImpl = os,
  } = deps;

  const BUNDLED_SKILLS_DIR = pathImpl.join(__dirname, '..', 'assets', 'skills');

  function syncBundledSkills() {
    try {
      const src = BUNDLED_SKILLS_DIR;
      if (!fsImpl.existsSync(src)) return;
      const destRoot = pathImpl.join(dshHome() || pathImpl.join(osImpl.homedir(), '.dsh'), 'skills');
      fsImpl.mkdirSync(destRoot, { recursive: true });
      const installed = [];
      for (const entry of fsImpl.readdirSync(src, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillSrc = pathImpl.join(src, entry.name);
        if (!fsImpl.existsSync(pathImpl.join(skillSrc, 'SKILL.md'))) continue;
        const skillDst = pathImpl.join(destRoot, entry.name);
        const markerSrc = readJsonFile(pathImpl.join(skillSrc, '.eac-skill.json')) || { version: 1, managed: true };
        const markerDst = readJsonFile(pathImpl.join(skillDst, '.eac-skill.json'));
        if (markerDst && markerDst.version === markerSrc.version) continue;
        if (!markerDst && fsImpl.existsSync(skillDst)) continue; // 用户自建同名技能：不动
        fsImpl.cpSync(skillSrc, skillDst, { recursive: true });
        installed.push(entry.name);
      }
      if (installed.length) log('boot', '已同步内置 skills 到 ' + destRoot + ': ' + installed.join(', '));
    } catch (err) {
      log('boot', '同步内置 skills 失败: ' + err.message);
    }
  }

  function runtimePatchRoots() {
    const home = dshHome() || pathImpl.join(osImpl.homedir(), '.dsh');
    return [
      pathImpl.join(home, 'profiles', 'node_modules'),
      pathImpl.join(__dirname, '..', 'node_modules'),
      pathImpl.join(userDataDir(), 'agent', 'node_modules'),
    ];
  }

  // 对话删除 / 归档管理（dsh-session-manager 插件的前置依赖）：
  // dsh-workspace + dsh-host-apiproxy + dsh-session + dsh-client-connection +
  // dsh-client-ui-workspace 的外科手术式扩展（详见 scripts/patch-session-manage.js
  // 头注释）。锚点不匹配（官方包结构变化）时自动跳过，绝不损坏文件。
  function applySessionManageFix() {
    for (const root of runtimePatchRoots()) {
      if (!root || !fsImpl.existsSync(root)) continue;
      try {
        const n = patchSessionManage(root, (m) => log('boot', m));
        if (n > 0) log('boot', '对话删除补丁: 已应用到 ' + root);
      } catch (err) {
        log('boot', '对话删除补丁失败(' + root + '): ' + err.message);
      }
    }
  }

  // openclaw-bridge 的设置命名空间白名单：dsh-host-apiproxy 的
  // settings.describe/mutate 只暴露 WEB_SETTINGS_NAMESPACES 列出的命名空间，
  // 补一行 "openclaw-bridge" 让设置页 ClawBot 栏可读写（同上游 install.ps1）。
  function patchApiproxyBridgeNamespace() {
    for (const root of runtimePatchRoots()) {
      if (!root || !fsImpl.existsSync(root)) continue;
      const apiproxy = pathImpl.join(root, '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js');
      if (!fsImpl.existsSync(apiproxy)) continue;
      try {
        let src = fsImpl.readFileSync(apiproxy, 'utf8');
        if (src.includes('"openclaw-bridge"')) continue;
        const marker = 'const WEB_SETTINGS_NAMESPACES = [';
        if (!src.includes(marker)) {
          log('boot', 'apiproxy 白名单锚点未找到，跳过（' + apiproxy + '）');
          continue;
        }
        src = src.replace(marker, marker + '\n\t"openclaw-bridge",\n\t');
        fsImpl.writeFileSync(apiproxy, src);
        log('boot', '已补丁 apiproxy 设置命名空间白名单: ' + apiproxy);
      } catch (err) {
        log('boot', 'apiproxy 白名单补丁失败(' + apiproxy + '): ' + err.message);
      }
    }
  }

  return {
    syncBundledSkills,
    runtimePatchRoots,
    applySessionManageFix,
    patchApiproxyBridgeNamespace,
  };
}

module.exports = { createRuntimePatches };
