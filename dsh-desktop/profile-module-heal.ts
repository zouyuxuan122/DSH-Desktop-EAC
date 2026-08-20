/**
 * profile-module-heal.ts — profile node_modules 遮蔽清理（Task 7.1 自
 * profile-module-heal.js 迁 TS）。
 *
 * dsh 解析 profile 插件时先走 profile 自己的 node_modules（pnpm 管理的
 * out-of-tree 插件），再走安装闭包 fallback <home>/profiles/node_modules
 * （每包一条 junction，由 dsh-app-boot 维护）。当 pnpm 把闭包包
 * （@deepseek-ai/dsh-scope、cordis…）的真实拷贝提升进 profile 的
 * node_modules —— 例如 `dsh plugin add` 装的插件的 peer/传递依赖 ——
 * 这些拷贝会遮蔽 junction，以第二实例加载。Symbol 身份随即在整个插件树
 * 断裂（scoped 注册、prompt-section 注册表…），表现为
 * `prompt section "deployment:persona" is already registered`、设置页
 * 「设置命名空间不可用」、模型列表/模式切换失灵。
 *
 * healProfileModuleShadowing 删除 profile node_modules 里遮蔽 fallback
 * 链接的真实目录拷贝与 pnpm 链接拷贝，让解析回落到 junction —— 单实例、
 * 与宿主共享。无 fallback 对应的本地包（out-of-tree 插件本体）与刻意
 * link: 的开发安装（目标在 profile 自己的 .pnpm store 之外）不动。
 * 返回被删除的包名列表。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 清理 profile 模块遮蔽；返回被移除的包名（fallback 形式 full name）。 */
export function healProfileModuleShadowing(
  home: string,
  profile = 'web',
  log: (msg: string) => void = (): void => {},
): string[] {
  const fallbackDir = path.join(home, 'profiles', 'node_modules');
  const profileModulesDir = path.join(home, 'profiles', profile, 'node_modules');

  // Collect every package name the fallback exposes (scoped + unscoped).
  const names: Array<{ full: string; rel: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fallbackDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      names.push({ full: entry.name, rel: entry.name });
    } else if (entry.isDirectory()) {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(path.join(fallbackDir, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        names.push({ full: entry.name + '/' + child.name, rel: path.join(entry.name, child.name) });
      }
    }
  }

  const removed: string[] = [];
  for (const { full, rel } of names) {
    // Issue #7 guard: only delete the profile's real copy when the fallback
    // link it should fall back to is actually healthy (target dir has a
    // package.json). A damaged app node_modules (empty skeletons after a
    // botched upgrade) or a dangling junction means the shadow is the LAST
    // healthy copy — removing it would brick module resolution for good.
    const fallbackEntry = path.join(fallbackDir, rel);
    let fallbackHealthy = false;
    try {
      const st = fs.lstatSync(fallbackEntry);
      const target = st.isSymbolicLink() ? fs.realpathSync(fallbackEntry) : fallbackEntry;
      fallbackHealthy = fs.existsSync(path.join(target, 'package.json'));
    } catch {
      fallbackHealthy = false;
    }
    if (!fallbackHealthy) {
      log('fallback entry unhealthy, keeping shadow copy: ' + full);
      continue;
    }
    const shadow = path.join(profileModulesDir, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(shadow);
    } catch {
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      // Real directory copy (pnpm nodeLinker: hoisted) shadows the fallback.
      fs.rmSync(shadow, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      removed.push(full);
      log('removed shadowing copy: ' + full);
      continue;
    }
    if (stat.isSymbolicLink()) {
      // pnpm-managed link whose store lives INSIDE this profile's own .pnpm
      // also shadows the fallback with a second instance. Deliberate link:
      // dev installs point elsewhere — those stay (report only).
      // Windows junctions need unlink (rmSync force-only throws EISDIR).
      const target = safeReadlink(shadow);
      if (!target) continue;
      const norm = (p: string): string => String(p).replace(/\//g, '\\').toLowerCase();
      const storeRoot = norm(path.join(profileModulesDir, '.pnpm'));
      if (norm(path.resolve(path.dirname(shadow), target)).startsWith(storeRoot)) {
        try {
          fs.unlinkSync(shadow);
        } catch {
          fs.rmSync(shadow, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 });
        }
        removed.push(full);
        log('removed shadowing pnpm link: ' + full);
      }
    }
  }
  return removed;
}

function safeReadlink(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}
