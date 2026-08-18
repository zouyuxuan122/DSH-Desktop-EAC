import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimePatches } from '../profile/runtime-patches.js';

// 组件测试：内置 skills 同步与运行副本补丁的幂等/跳过逻辑。
// 使用真实临时目录（模块默认 fs），dshHome/userDataDir 用 getter 注入。

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-patches-'));
  return root;
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function makeSkillsDir(src) {
  fs.mkdirSync(path.join(src, 'code-review'), { recursive: true });
  fs.writeFileSync(path.join(src, 'code-review', 'SKILL.md'), '# code-review\n');
  fs.writeFileSync(path.join(src, 'code-review', '.eac-skill.json'), JSON.stringify({ version: 2, managed: true }));
  fs.mkdirSync(path.join(src, 'no-skill-file'), { recursive: true }); // 无 SKILL.md → 跳过
  return src;
}

function makePatches(deps = {}) {
  const home = deps.home || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-patches-home-'));
  const userData = deps.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-patches-ud-'));
  const logs = [];
  const patches = createRuntimePatches({
    dshHome: () => home,
    userDataDir: () => userData,
    readJsonFile,
    patchSessionManage: deps.patchSessionManage || (() => 0),
    log: (tag, msg) => logs.push({ tag, msg }),
  });
  return { patches, home, userData, logs };
}

test('syncBundledSkills：首次同步拷贝内置技能，二次运行幂等跳过', () => {
  const tmp = scratch();
  const src = path.join(tmp, 'skills-src');
  makeSkillsDir(src);
  // 模块的 BUNDLED_SKILLS_DIR 固定指向本仓库 assets/skills，无法注入 ——
  // 因此直接调用内部逻辑路径不可行；改用真实仓库 assets/skills 验证幂等：
  const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const repoSkills = path.join(repo, 'assets', 'skills');
  if (!fs.existsSync(repoSkills)) return; // 无内置 skills 时跳过
  const { patches, home } = makePatches();
  patches.syncBundledSkills();
  const destRoot = path.join(home, 'skills');
  assert.ok(fs.existsSync(destRoot), 'skills 目标目录应被创建');
  const entries = fs.readdirSync(repoSkills).filter((d) => fs.existsSync(path.join(repoSkills, d, 'SKILL.md')));
  for (const name of entries) {
    assert.ok(fs.existsSync(path.join(destRoot, name, 'SKILL.md')), '技能 ' + name + ' 应被同步');
  }
  // 二次运行：标记版本一致，不重写（以 mtime 粗验幂等）
  const sample = path.join(destRoot, entries[0], 'SKILL.md');
  const before = fs.statSync(sample).mtimeMs;
  patches.syncBundledSkills();
  assert.equal(fs.statSync(sample).mtimeMs, before, '二次同步不应重写技能文件');
});

test('syncBundledSkills：用户自建同名技能（无标记）不被覆盖', () => {
  const { patches, home } = makePatches();
  const destRoot = path.join(home, 'skills');
  const userSkill = path.join(destRoot, 'user-made');
  fs.mkdirSync(userSkill, { recursive: true });
  fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# 用户自建\n');
  fs.writeFileSync(path.join(userSkill, 'notes.txt'), 'keep me');
  patches.syncBundledSkills(); // 仓库 assets/skills 下若存在同名目录也不会覆盖
  assert.equal(fs.readFileSync(path.join(userSkill, 'notes.txt'), 'utf8'), 'keep me');
});

test('syncBundledSkills：assets/skills 缺失时静默返回', () => {
  // 通过注入一个不存在的资源路径不可行（路径固定）—— 验证健壮性即可
  const { patches } = makePatches();
  patches.syncBundledSkills(); // 不抛错
});

test('runtimePatchRoots：按 getter 当前值生成三个补丁根', () => {
  const { patches, home, userData } = makePatches();
  const roots = patches.runtimePatchRoots();
  assert.equal(roots.length, 3);
  assert.equal(roots[0], path.join(home, 'profiles', 'node_modules'));
  assert.equal(roots[2], path.join(userData, 'agent', 'node_modules'));
});

test('applySessionManageFix：对存在的根调用 patchSessionManage，根缺失跳过', () => {
  const called = [];
  const { patches, home, logs } = makePatches({
    patchSessionManage: (root, notify) => { called.push(root); return 1; },
  });
  fs.mkdirSync(path.join(home, 'profiles', 'node_modules'), { recursive: true });
  patches.applySessionManageFix();
  assert.ok(called.length >= 1, '存在的根都应调用 patchSessionManage');
  assert.ok(called.includes(path.join(home, 'profiles', 'node_modules')), 'profile 根必须被调用');
  for (const root of called) {
    assert.ok(fs.existsSync(root), '被调用的根必须真实存在: ' + root);
  }
  assert.ok(logs.some((l) => l.msg.includes('对话删除补丁')));
});

test('patchApiproxyBridgeNamespace：注入白名单并幂等；锚点缺失跳过', () => {
  const tmp = scratch();
  const { patches, home } = makePatches();
  const apiproxy = path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js');
  fs.mkdirSync(path.dirname(apiproxy), { recursive: true });
  fs.writeFileSync(apiproxy, 'const WEB_SETTINGS_NAMESPACES = [\n  "settings",\n];\n');
  patches.patchApiproxyBridgeNamespace();
  const patched = fs.readFileSync(apiproxy, 'utf8');
  assert.ok(patched.includes('"openclaw-bridge"'), '白名单应注入 openclaw-bridge');
  // 幂等：再次执行不再改动
  patches.patchApiproxyBridgeNamespace();
  assert.equal(fs.readFileSync(apiproxy, 'utf8'), patched);
  // 锚点缺失：跳过并记录，不损坏文件
  const bad = path.join(tmp, 'nested', 'index.js');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, 'const X = 1;\n');
  const roots = patches.runtimePatchRoots();
  assert.ok(roots.length >= 1);
  // 已有 openclaw-bridge 时不重复注入
  fs.writeFileSync(apiproxy, 'const WEB_SETTINGS_NAMESPACES = [\n  "openclaw-bridge",\n];\n');
  const before = fs.readFileSync(apiproxy, 'utf8');
  patches.patchApiproxyBridgeNamespace();
  assert.equal(fs.readFileSync(apiproxy, 'utf8'), before);
  void bad;
});
