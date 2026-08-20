// artifact-keep.mjs — 跨 pnpm 重写保留第三方插件的本地构建产物。
//
// 背景（用户反馈 / codex 诊断确认）：meow-memory 这类从 GitHub 安装的插件，
// tarball 里不带构建好的 lib/，也没有 prepack 脚本 —— pnpm v10 还会封锁
// 未 allowBuilds 的构建脚本，所以装好后 lib/ 只能靠人工补齐。而 `dsh
// plugin` 只是 pnpm 的转发器：任何一次安装/卸载（含桌面端更新后重放的
// 排队市场任务）都会按锁文件重新解包整棵 profile node_modules，人工补的
// lib/ 随之蒸发，插件名下只剩解析不到入口的残树。
//
// 方案：凡是桌面端要触发 pnpm 的地方，跑之前把 profile node_modules 里的
// 第三方包目录快照到 <home>/.dsh/plugin-artifact-cache/<profile>/，跑完
// 之后把「磁盘上消失而快照里有」的文件补回去（只补缺，绝不覆盖现存
// 文件，天然幂等）。配套插件（随包分发、启动即重建）与 @deepseek-ai 官方
// 闭包不进快照；包版本变化（用户真的升级了插件）时放弃旧快照。
//
// 本模块被两处共用（单一实现）：
//   · Electron 主进程 main.js —— 排队市场任务（processPendingMarketOps）
//     与启动兜底恢复；
//   · 插件市场 host 半边（host.js startOp）—— 服务运行中的安装/卸载。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 单包快照上限：超过的视为「巨型包」（可能是装错了东西），跳过不缓存。
const MAX_PKG_BYTES = 48 * 1024 * 1024
// 快照包数量上限：正常第三方插件集合远小于此。
const MAX_PKG_COUNT = 64
// node_modules 顶层不参与快照的目录/文件。
const SKIP_NAMES = new Set(['.bin', '.pnpm', '.store', '.modules.yaml', '.locks', '.cache'])
// 桌面壳闭包 / 内置分发范围：这些包由壳层重建，缓存它们只会浪费空间。
const MANAGED_PREFIXES = ['@deepseek-ai/', '@sanqi-normal/']

/** 列出 profile node_modules 里的第三方包名（含 scope，如 meow-memory）。 */
export function listThirdPartyPackages(profileDir, managedNames = []) {
  const nm = join(profileDir, 'node_modules')
  if (!existsSync(nm)) return []
  const managed = new Set(managedNames)
  const out = []
  const visit = (dir, prefix) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      if (e.name.startsWith('@')) {
        visit(join(dir, e.name), e.name + '/')
        continue
      }
      const name = prefix + e.name
      if (SKIP_NAMES.has(name) || managed.has(name)) continue
      if (MANAGED_PREFIXES.some((p) => name.startsWith(p))) continue
      out.push(name)
    }
  }
  visit(nm, '')
  return out
}

/** 目录字节数（超限时提前终止，over=true）。 */
function dirStat(dir, capBytes) {
  let total = 0
  let over = false
  const walk = (d) => {
    if (over) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (over) return
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        try { total += statSync(p).size } catch {}
      }
      if (total > capBytes) { over = true; return }
    }
  }
  walk(dir)
  return { bytes: total, over }
}

/** 全量拷贝 src → dst（覆盖式，快照写入专用）。返回 { files, bytes }。 */
function copyTreeAll(src, dst) {
  let files = 0
  let bytes = 0
  const walk = (s, d) => {
    let entries
    try { entries = readdirSync(s, { withFileTypes: true }) } catch { return }
    mkdirSync(d, { recursive: true })
    for (const e of entries) {
      const sp = join(s, e.name)
      const dp = join(d, e.name)
      if (e.isDirectory()) walk(sp, dp)
      else if (e.isFile()) {
        try {
          copyFileSync(sp, dp)
          files += 1
          bytes += statSync(sp).size
        } catch {}
      }
      // 符号链接（pnpm 的 .pnpm 结构等）：跳过，快照只保真实文件。
    }
  }
  walk(src, dst)
  return { files, bytes }
}

/** 只补 dst 缺失的文件（回填专用，绝不覆盖现存内容）。返回补回的文件数。 */
function copyTreeMissing(src, dst) {
  let files = 0
  const walk = (s, d) => {
    let entries
    try { entries = readdirSync(s, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const sp = join(s, e.name)
      const dp = join(d, e.name)
      if (e.isDirectory()) {
        if (!existsSync(dp)) mkdirSync(dp, { recursive: true })
        walk(sp, dp)
      } else if (e.isFile()) {
        if (existsSync(dp)) continue
        try {
          mkdirSync(dirname(dp), { recursive: true })
          copyFileSync(sp, dp)
          files += 1
        } catch {}
      }
    }
  }
  walk(src, dst)
  return files
}

/**
 * 快照 profile 的第三方包到 cacheDir。managedNames：由桌面壳重建的包
 * （配套插件/皮肤），不进快照。返回 { kept: [name], skipped: [name] }。
 */
export function snapshotArtifacts(profileDir, cacheDir, { managedNames = [], log = () => {} } = {}) {
  const names = listThirdPartyPackages(profileDir, managedNames)
  if (names.length === 0) return { kept: [], skipped: [] }
  const kept = []
  const skipped = []
  for (const name of names.slice(0, MAX_PKG_COUNT)) {
    const src = join(profileDir, 'node_modules', ...name.split('/'))
    if (!existsSync(src)) continue
    const st = dirStat(src, MAX_PKG_BYTES)
    if (st.over) { skipped.push(name); continue }
    const dst = join(cacheDir, ...name.split('/'))
    try {
      rmSync(dst, { recursive: true, force: true, maxRetries: 2 })
      mkdirSync(dst, { recursive: true })
      const r = copyTreeAll(src, dst)
      kept.push(name)
      log(`snapshot ${name}: ${r.files} files (${Math.round(r.bytes / 1024)} KB)`)
    } catch (err) {
      skipped.push(name)
      log(`snapshot ${name} 失败: ${err.message}`)
    }
  }
  if (names.length > MAX_PKG_COUNT) skipped.push(...names.slice(MAX_PKG_COUNT))
  return { kept, skipped }
}

/** 列出 cacheDir 里已缓存的包名。 */
function listCacheEntries(cacheDir) {
  if (!existsSync(cacheDir)) return []
  const out = []
  const visit = (dir, prefix) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      if (e.name.startsWith('@')) {
        visit(join(dir, e.name), e.name + '/')
        continue
      }
      out.push(prefix + e.name)
    }
  }
  visit(cacheDir, '')
  return out
}

function readVersionSafe(pkgFile) {
  try { return JSON.parse(readFileSync(pkgFile, 'utf8')).version } catch { return null }
}

/**
 * 回填：把快照里「磁盘上已消失」的文件补回 profile node_modules。
 * 包已被卸载（目录没了）→ 删除对应快照；包版本已变化（真升级）→ 放弃
 * 旧快照，不回填陈旧文件。
 */
export function restoreArtifacts(profileDir, cacheDir, { log = () => {} } = {}) {
  const entries = listCacheEntries(cacheDir)
  const result = { restored: [], dropped: [], files: 0 }
  for (const name of entries) {
    const cacheRoot = join(cacheDir, ...name.split('/'))
    const dstRoot = join(profileDir, 'node_modules', ...name.split('/'))
    const installedVersion = readVersionSafe(join(dstRoot, 'package.json'))
    if (installedVersion === null) {
      try { rmSync(cacheRoot, { recursive: true, force: true }) } catch {}
      result.dropped.push(name)
      continue
    }
    const snapVersion = readVersionSafe(join(cacheRoot, 'package.json'))
    if (snapVersion !== installedVersion) {
      try { rmSync(cacheRoot, { recursive: true, force: true }) } catch {}
      result.dropped.push(`${name}@${snapVersion}->${installedVersion}`)
      continue
    }
    const n = copyTreeMissing(cacheRoot, dstRoot)
    if (n > 0) {
      result.restored.push(`${name}(${n} 文件)`)
      result.files += n
    }
  }
  if (result.restored.length) {
    log(`已回填第三方插件构建产物: ${result.restored.join(', ')}`)
  }
  return result
}
