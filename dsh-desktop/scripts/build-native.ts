/**
 * scripts/build-native.ts — Rust 原生模块的可复现构建入口。
 *
 * 本机事实（Windows 10 1607 / build 14393）：VS18 BuildTools 的 MSVC 14.51
 * link.exe 进口了旧系统缺失的 API，启动即 0xC0000139（入口点不存在）。
 * Rust 工具链自带的 rust-lld（LLVM lld-link，MSVC 兼容驱动）完全胜任本
 * crate 的链接（仅依赖 kernel32），故构建统一走 lld-link：
 *   1. `rustc --print sysroot` 定位工具链内 rust-lld.exe；
 *   2. 复制为 %TEMP%/dsh-lld-link/lld-link.exe（argv0 即 flavor，免 -flavor
 *      参数；放 TEMP 避开仓库路径空格 —— CARGO_ENCODED_RUSTFLAGS 见下）；
 *   3. 以 CARGO_ENCODED_RUSTFLAGS=-Clinker=... 调 cargo（build/test/clippy 统一入口；
 *      encoded 形式：RUSTFLAGS 按空白切分且引号变字面字符，路径含空格必挂）。
 *
 * 用法（module 缺省 supervisor，保持既有调用零改动）：
 *   node scripts/build-native.js build [module] [--release] → cargo build
 *   node scripts/build-native.js test [module]              → cargo test --release
 *   node scripts/build-native.js clippy [module]            → cargo clippy --release
 *   node scripts/build-native.js copy [module]              → 仅复制 dll → index.node
 *
 * module ∈ supervisor（进程围栏）| snapshot（.dsh 快照备份引擎）。
 *
 * 构建后把 cdylib 产物复制为可 require 的 index.node（cargo 产物名固定为
 * dsh_<module>_native.{dll,so,dylib}，Node require 约定 .node 扩展名），
 * 并做存在性断言（predist 校验复用 `copy`） */
'use strict';
import cp = require('node:child_process');
import fs = require('node:fs');
import path = require('node:path');
import os = require('node:os');

const MODULES = ['supervisor', 'snapshot'] as const;
type Module = (typeof MODULES)[number];

function parseModuleArg(): Module {
  const arg = process.argv[3];
  if (!arg) return 'supervisor';
  if ((MODULES as readonly string[]).includes(arg)) return arg as Module;
  console.error(`[build-native] 未知模块: ${arg}（${MODULES.join(' | ')}）`);
  process.exit(1);
}

// 注意：不可命名为 `module`——CJS 包装参数遮蔽后 const 重声明是语法错误，
// Node 语法探测会误判为 ESM 加载。
const moduleName = parseModuleArg();
const crateRoot = path.join(__dirname, '..', 'native', moduleName);
const targetDir = path.join(crateRoot, 'target');
const manifest = path.join(crateRoot, 'Cargo.toml');
const artifactBase = `dsh_${moduleName}_native`;

const WINDOWS_MSVC_TARGET = 'x86_64-pc-windows-msvc';

function windowsCargoTarget(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const configured = process.env.CARGO_BUILD_TARGET;
  if (configured !== undefined && configured !== WINDOWS_MSVC_TARGET) {
    throw new Error(`[build-native] Windows 原生模块要求 ${WINDOWS_MSVC_TARGET}，当前 CARGO_BUILD_TARGET=${configured}`);
  }
  return WINDOWS_MSVC_TARGET;
}

function cargoReleaseDir(): string {
  const target = windowsCargoTarget();
  return target === undefined ? path.join(targetDir, 'release') : path.join(targetDir, target, 'release');
}

/** 取工具链 sysroot（失败抛出 —— 没有 rustc 时无法构建）。 */
function sysroot(): string {
  const r = cp.spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('rustc 不可用（请先安装 Rust 工具链）');
  return r.stdout.trim();
}

/** 准备 lld-link.exe（从工具链 rust-lld 复制；argv0 决定 MSVC link 兼容模式）。
 * 目标放到 %TEMP%/dsh-lld-link/ —— %TEMP% 本身也可能含空格用户名，
 * 最终由 CARGO_ENCODED_RUSTFLAGS（ 分隔、无空白切分歧义）兜底；
 * lld-link 落 TEMP 只是顺带避开仓库路径空格（DeepSeek Harness\dsh max）。 */
function prepareLldLink(): string {
  const src = path.join(sysroot(), 'lib', 'rustlib', 'x86_64-pc-windows-msvc', 'bin', 'rust-lld.exe');
  if (!fs.existsSync(src)) throw new Error(`rust-lld 不存在: ${src}`);
  const dstDir = path.join(os.tmpdir(), 'dsh-lld-link');
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, 'lld-link.exe');
  fs.copyFileSync(src, dst);
  return dst;
}

/** Windows 以 lld-link 为链接器；其他平台使用当前 Rust 工具链默认链接器。 */
function runCargo(sub: string, rest: string[]): number {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    const linker = prepareLldLink();
    // RUSTFLAGS 按空白拆分：linker 路径含空格（仓库路径 "DeepSeek Harness\
    // dsh max"，或 %TEMP% 本身含空格的用户名）会被截成多个参数。引号方案
    // 在 rustc 的 flags 解析里同样不可靠 —— 改用 CARGO_ENCODED_RUSTFLAGS
    //（\x1f 分隔的参数表，无空白歧义），并清掉 RUSTFLAGS 防止双重应用。
    env.CARGO_ENCODED_RUSTFLAGS = ['-C', `linker=${linker}`].join('\x1f');
    delete env.RUSTFLAGS;
  }
  const args = [sub, '--manifest-path', manifest, ...rest];
  const target = windowsCargoTarget();
  if (target !== undefined) args.push('--target', target);
  const r = cp.spawnSync('cargo', args, {
    stdio: 'inherit',
    env,
    cwd: crateRoot,
  });
  return r.status ?? 1;
}

/** 复制 cargo cdylib 产物 → index.node（存在性断言）。 */
function copyArtifact(): void {
  const releaseDir = cargoReleaseDir();
  const candidates =
    process.platform === 'win32' ? [`${artifactBase}.dll`]
    : process.platform === 'darwin' ? [`lib${artifactBase}.dylib`]
    : [`lib${artifactBase}.so`];
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
