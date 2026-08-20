/**
 * lib/plugin-manager-core.ts — 插件启停/移除管理与图片粘贴（Task 5.2 提取）。
 *
 * 设置页「插件 → 管理」标签的数据与写盘（IPC dsh:plugin-list /
 * dsh:plugin-set-enabled / dsh:plugin-set-removed 驱动）；写盘用纯文本手术
 * （scripts/plugin-manager-patch.js），保留文件其它内容与注释。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as updater from '../updater.js';
import { togglePluginInPatch, removePluginFromPatch, hasEntryId } from '../scripts/plugin-manager-patch.js';
import { collectPluginRows } from '../plugin-manager-state.js';
import { CORE_PLUGIN_IDS, type PatchEntry } from '../scripts/onboarding.js';
import { configLinesFor } from '../patch-row-heal.js';
import { state } from './state.js';
import { log } from './log.js';
import { updCtx } from './proc.js';
import { desktopProfileDir } from './paths.js';
import { COMPANION_PLUGINS, builtinPluginSourceDir } from './plugin-registry-data.js';
import { readJsonFile, copyPluginPackage } from './plugin-copy.js';

/** 通用操作结果。 */
export interface OpResult {
  ok: boolean;
  error?: string;
  restartRequired?: boolean;
}

// 惰性加载 js-yaml（内置 dsh 的传递依赖）；缺失时管理页降级为空列表。
function loadDshYamlDialect(): { load(content: string): unknown } | null {
  if (state.dshYamlTried) return state.dshYamlDialect;
  state.dshYamlTried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml') as typeof import('js-yaml');
    // 与 dsh 相同的 entry-list 方言：`!!js` 表达式是合法标量。
    const jsType = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data: unknown) => typeof data === 'string',
      construct: (data: unknown) => ({ __jsExpr: data }),
    });
    state.dshYamlDialect = {
      load: (content: string) =>
        yaml.load(content, { schema: yaml.JSON_SCHEMA.extend(jsType) }),
    };
  } catch {
    state.dshYamlDialect = null;
  }
  return state.dshYamlDialect;
}

/** 读取 profile cordis.patch.yml（损坏/yaml 缺失时返回空 entries）。 */
export function pluginManagerReadPatch(): {
  file: string;
  text: string;
  entries: PatchEntry[];
} {
  const file = path.join(desktopProfileDir(), 'cordis.patch.yml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* 尚未创建 */
  }
  const yaml = loadDshYamlDialect();
  if (!yaml) return { file, text, entries: [] };
  try {
    const parsed = yaml.load(text);
    return { file, text, entries: Array.isArray(parsed) ? (parsed as PatchEntry[]) : [] };
  } catch {
    return { file, text, entries: [] };
  }
}

/** 从 profile 副本或资产目录读插件包 description。 */
export function pluginManagerPackageDescription(name: string): string {
  if (!name) return '';
  const candidates = [
    path.join(desktopProfileDir(), 'node_modules', ...name.split('/')),
    path.join(
      __dirname, '..', 'assets', 'plugins',
      name.includes('/') ? name.slice(name.indexOf('/') + 1) : name,
    ),
  ];
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        description?: unknown;
      };
      if (pkg && typeof pkg.description === 'string' && pkg.description) return pkg.description;
    } catch {
      /* 无 package.json：下一个候选 */
    }
  }
  return '';
}

/** 汇总管理页插件行（配套表 + patch 行 + bundles + 移除清单）。 */
export function pluginManagerCollect(): unknown[] {
  const { entries } = pluginManagerReadPatch();
  let bundles: string[] = [];
  try {
    const m = JSON.parse(
      fs.readFileSync(path.join(desktopProfileDir(), 'package.json'), 'utf8'),
    ) as { dsh?: { profile?: { bundles?: string[] } } };
    bundles = m && m.dsh && m.dsh.profile && Array.isArray(m.dsh.profile.bundles)
      ? m.dsh.profile.bundles
      : [];
  } catch {
    /* 无 package.json */
  }
  return collectPluginRows(entries, {
    companion: COMPANION_PLUGINS.map((p) => ({ id: p.id, name: p.name })),
    coreIds: CORE_PLUGIN_IDS,
    removedIds: removedPluginIds(),
    describe: (name: string) => pluginManagerPackageDescription(name),
    bundles,
  }) as unknown[];
}

/** 由插件 id 解析包名（配套表优先，回退 patch 行）。 */
export function pluginManagerResolveName(id: string): string {
  const c = COMPANION_PLUGINS.find((p) => p.id === id);
  if (c) return c.name;
  const { entries } = pluginManagerReadPatch();
  for (const entry of entries) {
    const e = entry as { insert?: { id?: string; name?: string }[] } | null;
    if (e && Array.isArray(e.insert)) {
      const it = e.insert.find((x) => x && x.id === id);
      if (it && it.name) return it.name;
    }
  }
  return '';
}

/** 读取用户移除清单（settings.removedPlugins）。 */
export function removedPluginIds(): Set<string> {
  try {
    const s = updater.loadSettings(updCtx());
    return new Set(Array.isArray(s.removedPlugins) ? (s.removedPlugins as string[]) : []);
  } catch {
    return new Set();
  }
}

/** 写用户移除清单。 */
export function saveRemovedPluginIds(ids: Set<string>): void {
  const ctx = updCtx();
  const s = updater.loadSettings(ctx);
  s.removedPlugins = Array.from(ids);
  updater.saveSettings(ctx, s);
}

// 恢复单个配套插件：立即复制包 + 补写 patch 行（与 syncCompanionPlugins
// 的写入规则一致），重启服务后生效。源目录走「覆盖层优先」（V4.3）。
export function restoreCompanionPlugin(p: { id: string; name: string; dir?: string; config?: Record<string, unknown>; disabled?: boolean }): OpResult {
  const profileDirP = desktopProfileDir();
  const dirName = p.dir ?? (p.name.includes('/') ? (p.name.split('/').pop() as string) : p.name);
  const src = builtinPluginSourceDir(dirName);
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    return { ok: false, error: '配套插件源目录无效: ' + src };
  }
  copyPluginPackage(profileDirP, src, p.name);
  const patchFile = path.join(profileDirP, 'cordis.patch.yml');
  let patch = '';
  try {
    patch = fs.readFileSync(patchFile, 'utf8');
  } catch {
    /* 尚未创建 */
  }
  if (!hasEntryId(patch, p.id)) {
    let bundled: string[] = [];
    try {
      bundled =
        ((readJsonFile(path.join(profileDirP, 'package.json'))?.dsh as
          | { profile?: { bundles?: string[] } }
          | undefined)?.profile?.bundles) ?? [];
    } catch {
      bundled = [];
    }
    if (!bundled.includes(p.name)) {
      let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (p.config) block += configLinesFor(p.config);
      if (p.disabled) block += '      disabled: true\n';
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
      else if (patch.trim() === '')
        patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      try {
        fs.writeFileSync(patchFile, patch);
      } catch (err) {
        return { ok: false, error: String((err as Error).message) };
      }
    }
  }
  return { ok: true };
}

// removed=true 移除（卸载语义）；removed=false 恢复。核心插件拒绝移除。
export function pluginManagerSetRemoved(id: string, removed: boolean): OpResult {
  const p = COMPANION_PLUGINS.find((x) => x.id === id);
  if (!p) return { ok: false, error: '未知内置插件: ' + String(id) };
  if (CORE_PLUGIN_IDS.has(id)) {
    return { ok: false, error: '核心插件不可移除: ' + String(id) };
  }
  const removedSet = removedPluginIds();
  const patchFile = path.join(desktopProfileDir(), 'cordis.patch.yml');
  try {
    if (removed) {
      // 1) 清 patch 行（顶层 + insert 内层）
      let text = '';
      try {
        text = fs.readFileSync(patchFile, 'utf8');
      } catch {
        /* 尚未创建 */
      }
      const patched = removePluginFromPatch(text, id);
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
    log('plugin-manager', '移除/恢复插件 ' + id + ' 失败: ' + String((err as Error).message));
    return { ok: false, error: String((err as Error).message) };
  }
}

// 写入/移除用户层 disabled 条目（纯文本手术）：「启用」保留顶层裸条目
// {id, name} 而不是整条移除，这样默认禁用的配套插件（dsh-pet）被用户启用后
// 不会被下次 sync 重新插回 disabled 行（sync 的「已有行不重写」规则接管）。
export function pluginManagerSetEnabled(id: string, enabled: boolean): OpResult {
  const file = path.join(desktopProfileDir(), 'cordis.patch.yml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* 尚未创建 */
  }
  if (!text.trim()) text = '# dsh web profile patch（由 Deepseek Harness EAC 维护）\n';

  const name = pluginManagerResolveName(id);
  if (!enabled && !name) return { ok: false, error: '无法解析插件包名: ' + id };

  let patched: string;
  try {
    patched = togglePluginInPatch(text, id, !!enabled, name);
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
  if (patched !== text) {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, patched, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 图片粘贴保存（dsh-image-paste 插件）：只接受 image/* 的 data URL，
// base64 解码后原子写入 %TEMP%/dsh-paste/<清洗名>-<时间戳><ext>。文件在临时
// 目录，随系统清理，不污染工作区。
// ---------------------------------------------------------------------------
const IMAGE_PASTE_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_PASTE_EXT: Record<string, string> = {
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

/** 保存粘贴图片（校验类型/大小，写临时目录，返回 {ok,path,size}）。 */
export function imagePasteSave(dataUrl: string, name: string): { ok: boolean; path?: string; size?: number; error?: string } {
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m || !m[1] || !m[2]) return { ok: false, error: '不是合法的图片 data URL' };
  const mime = m[1].toLowerCase();
  if (!IMAGE_PASTE_EXT[mime]) return { ok: false, error: '不支持的图片类型: ' + mime };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return { ok: false, error: '图片内容为空' };
  if (buf.length > IMAGE_PASTE_MAX_BYTES) return { ok: false, error: '图片超过 15MB 上限' };
  const dir = path.join(os.tmpdir(), 'dsh-paste');
  fs.mkdirSync(dir, { recursive: true });
  const base =
    String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40) || '粘贴图片';
  const file = path.join(dir, base + '-' + Date.now() + IMAGE_PASTE_EXT[mime]);
  fs.writeFileSync(file, buf);
  return { ok: true, path: file, size: buf.length };
}
