/**
 * scripts/build-native.ts — Rust 围栏模块的可复现构建入口。
 *
 * 本机事实（Windows 10 1607 / build 14393）：VS18 BuildTools 的 MSVC 14.51
 * link.exe 进口了旧系统缺失的 API，启动即 0xC0000139（入口点不存在）。
 * Rust 工具链自带的 rust-lld（LLVM lld-link，MSVC 兼容驱动）完全胜任本
 * crate 的链接（仅依赖 kernel32），故构建统一走 lld-link：
 *   1. `rustc --print sysroot` 定位工具链内 rust-lld.exe；
 *   2. 复制为 target/lld-link.exe（argv0 即 flavor，免 -flavor 参数）；
 *   3. 以 RUSTFLAGS=-C linker=... 调 cargo（build/test/clippy 统一入口）。
 *
 * 用法：
 *   node scripts/build-native.js build [--release]   → cargo build
 *   node scripts/build-native.js test                → cargo test --release
 *   node scripts/build-native.js clippy              → cargo clippy --release
 *   node scripts/build-native.js copy                → 仅复制 dll → index.node
 *
 * 构建后把 cdylib 产物复制为可 require 的 index.node（cargo 产物名固定为
 * dsh_supervisor_native.{dll,so,dylib}，Node require 约定 .node 扩展名），
 * 并做存在性断言（predist 校验复用 `copy`）。
 */
'use strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const crateRoot = path.join(__dirname, '..', 'native', 'supervisor');
const targetDir = path.join(crateRoot, 'target');
const manifest = path.join(crateRoot, 'Cargo.toml');

/** 取工具链 sysroot（失败抛出 —— 没有 rustc 时无法构建）。 */
function sysroot(): string {
  const r = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('rustc 不可用（请先安装 Rust 工具链）');
  return r.stdout.trim();
}

/** 准备 lld-link.exe（从工具链 rust-lld 复制；argv0 决定 MSVC link 兼容模式）。 */
function prepareLldLink(): string {
  const src = path.join(sysroot(), 'lib', 'rustlib', 'x86_64-pc-windows-msvc', 'bin', 'rust-lld.exe');
  if (!fs.existsSync(src)) throw new Error(`rust-lld 不存在: ${src}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const dst = path.join(targetDir, 'lld-link.exe');
  fs.copyFileSync(src, dst);
  return dst;
}

/** 以 lld-link 为链接器调用 cargo（返回 cargo 退出码）。 */
function runCargo(sub: string, rest: string[]): number {
  const linker = prepareLldLink();
  const env = { ...process.env, RUSTFLAGS: `-C linker=${linker}` };
  const r = spawnSync('cargo', [sub, '--manifest-path', manifest, ...rest], {
    stdio: 'inherit',
    env,
    cwd: crateRoot,
  });
  return r.status ?? 1;
}

/** 复制 cargo cdylib 产物 → index.node（存在性断言）。 */
function copyArtifact(): void {
  const releaseDir = path.join(targetDir, 'release');
  const candidates =
    process.platform === 'win32' ? ['dsh_supervisor_native.dll']
    : process.platform === 'darwin' ? ['libdsh_supervisor_native.dylib']
    : ['libdsh_supervisor_native.so'];
  const found = candidates.find((f) => fs.existsSync(path.join(releaseDir, f)));
  if (!found) {
    console.error(`[build-native] 未找到 cargo 产物：${candidates.join(' / ')}（先 cargo build --release）`);
    process.exit(1);
  }
  const src = path.join(releaseDir, found);
  const dst = path.join(crateRoot, 'index.node');
  fs.copyFileSync(src, dst);
  console.log(`[build-native] ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dst)}`);
}

const mode = process.argv[2] ?? 'build';
switch (mode) {
  case 'build':
    if (runCargo('build', ['--release']) !== 0) process.exit(1);
    copyArtifact();
    break;
  case 'test':
    process.exit(runCargo('test', ['--release']));
  case 'clippy':
    process.exit(runCargo('clippy', ['--release', '--', '-D', 'warnings']));
  case 'copy':
    copyArtifact();
    break;
  default:
    console.error(`[build-native] 未知模式: ${mode}（build | test | clippy | copy）`);
    process.exit(1);
}
