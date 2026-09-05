#!/usr/bin/env node
/**
 * dsh-std v0.15 manifest 生成器（阶段 2，批次式）。
 *
 * 为 main 线 origin=upstream 与 origin=eac-original 的插件生成 dsh-plugin.json
 * （身份 + 来源钉址 + 最小 facets）。manifest 当前是**描述性元数据**：EAC 插件
 * 仍经 companion-sync / 注册表加载，不走 @dsh-std/adapter-dsh（其与内核 0.1.3
 * 的兼容性未验证）；manifest 让每个插件可被生态工具识别，并为将来切换适配层
 * 备好静态清单。
 *
 * eac-original（EAC 原研、私有维护）批次：无外部上游可钉，source.repository
 * 归属 EAC 主仓库，id 以主仓库反推 DNS 后再拼目录名保证唯一；x-eac 带
 * maintenance: 'eac-private' 与 autoUpdate: false（自动更新黑名单的声明面，
 * 强制点在 companion-sync 的 pluginUpdateSources）。
 *
 * 诚实性约束：facets/permissions 留空 = 尚未参与 std 协商，不编造能力声明；
 * 上游为 monorepo 时在 x-eac.sourceNote 注明；eac-original 无上游基线，
 * 不写 patched/patchNote。皮肤不生成（走 skin wiring，host facet 语义不实）。
 *
 * 用法：node scripts/gen-plugin-manifests.mjs [--ids C001,C004] [--dry]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ddRoot = join(repoRoot, 'dsh-desktop');
const ledger = JSON.parse(readFileSync(join(ddRoot, 'assets', 'SOURCES.json'), 'utf8'));

const SCHEMA_PIN = 'https://raw.githubusercontent.com/Yan-Zero/dsh-std/614dfa1ac168db79fcf4577cf0ebb34e2e3b944b/packages/manifest/schema/dsh-plugin-0.15.schema.json';
// eac-original 的来源归属：审计口径「best match = EAC 主仓库」（外部匹配审计
// PLUGIN-MATCH-REPORT 中这些行置信 0.94–0.97 均指向主仓库本体）。
const EAC_REPO = 'https://github.com/zouyuxuan122/DSH-Desktop-EAC';
const DRY = process.argv.includes('--dry');
const idsArg = process.argv.findIndex((a) => a === '--ids');
const onlyIds = idsArg >= 0 ? new Set(process.argv[idsArg + 1].split(',')) : null;

function manifestId(repository) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#]+)/.exec(String(repository || ''));
  if (!m) return null;
  return `io.github.${m[1]}.${m[2]}`.toLowerCase();
}

let written = 0;
for (const entry of ledger.components) {
  if (entry.line !== 'main') continue;
  if (entry.type !== 'plugin') continue; // 皮肤走 skin wiring；source-copy 非独立身份
  const isEacOriginal = entry.origin === 'eac-original';
  if (entry.origin !== 'upstream' && !isEacOriginal) continue;
  if (onlyIds && !onlyIds.has(entry.id)) continue;
  const dir = join(repoRoot, entry.path);
  if (existsSync(join(dir, 'dsh-plugin.json'))) {
    console.log(`[manifest] ${entry.id} ${entry.name}: 已有 manifest，不覆盖（手工文件优先）`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const upstream = entry.upstream || {};
  const repo = upstream.repository || pkg.repository?.url || (isEacOriginal ? EAC_REPO : null);
  if (!repo) {
    console.warn(`[manifest] ${entry.id} ${entry.name}: 无 repository，跳过`);
    continue;
  }
  const main = String(pkg.main || 'index.js').replace(/^\.\//, '');
  if (!existsSync(join(dir, main))) {
    console.error(`[manifest] ${entry.id} ${entry.name}: entry 不存在 ${main}`);
    process.exitCode = 1;
    continue;
  }
  const isMonorepo = /dsh_desktop|dsh-web/.test(repo);
  // eac-original 无独立仓库，主仓库反推 DNS + 目录名兜底唯一（manifestId(EAC_REPO)
  // 对 14 个插件同值，直接用会撞 id）。
  const id = isEacOriginal
    ? `${manifestId(EAC_REPO)}.${entry.path.split('/').pop()}`.toLowerCase()
    : (manifestId(repo) || entry.name);
  const manifest = {
    $schema: SCHEMA_PIN,
    manifestVersion: '0.15',
    id,
    name: pkg.name,
    version: pkg.version,
    facets: { host: { entry: main, apiVersion: 'v1alpha1' } },
    requires: { contracts: [] },
    permissions: [],
    contributes: { commands: [] },
    subscriptions: [],
    license: pkg.license || 'MIT',
    source: { repository: repo },
    overrides: [],
    'x-eac': {
      role: 'identity-metadata',
      note: isEacOriginal
        ? 'EAC 原研插件（私有维护，不参与内置插件自动更新）。EAC 经 companion-sync 注册表加载（非 std adapter）；facets 留空 = 尚未参与 std 协商'
        : 'EAC 经 companion-sync 注册表加载（非 std adapter）；facets 留空 = 尚未参与 std 协商',
      ...(isEacOriginal ? { maintenance: 'eac-private', autoUpdate: false } : {}),
      ledger: `assets/SOURCES.json#${entry.id}`,
      ...(isMonorepo ? { sourceNote: '上游为 monorepo（伴侣插件套件子目录）' } : {}),
      ...(isEacOriginal
        ? {}
        : entry.audit?.compare && entry.audit.compare !== 'byte-identical'
          ? { patched: true, patchNote: entry.audit.compare }
          : { patched: false }),
    },
  };
  if (DRY) {
    console.log(`[manifest:dry] ${entry.id} ${entry.name} -> ${manifest.id}`);
  } else {
    writeFileSync(join(dir, 'dsh-plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  written++;
}
console.log(`[manifest] 生成 ${written} 份${DRY ? '（dry run）' : ''}`);
