'use strict';

// 为 macOS 打包补齐 dsh-tdai-memory 插件的 darwin 原生负载（jieba / sqlite-vec）。
//
// 插件内置的 vendored node_modules 目前只提交了 linux / win 两个平台的负载
// （@node-rs/jieba-*-gnu|msvc、sqlite-vec-linux|windows-*），macOS 打包还需要
// @node-rs/jieba-darwin-{x64,arm64} 与 sqlite-vec-darwin-{x64,arm64}。
// npm 包不挑宿主平台：任何机器都能用 `npm pack` 拉取 darwin 二进制（无需 Mac），
// 版本号从 vendored 的 @node-rs/jieba / sqlite-vec 包内读取，保证与内置一致。
//
// 在 dist:mac 打包前执行（CI 的 macOS runner 与本地 Mac 均可）。幂等：
// 先删目标目录再解包，失败即抛错终止打包（after-pack 的 darwin 审计会再查一次）。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_NM = path.resolve(__dirname, '..', 'assets', 'plugins', 'dsh-tdai-memory', 'node_modules');

function vendoredVersion(rel) {
  const pkg = path.join(PLUGIN_NM, rel, 'package.json');
  const v = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  if (!v) throw new Error(`无法读取 ${rel} 的版本号（${pkg}）`);
  return v;
}

function targets() {
  const jieba = vendoredVersion('@node-rs/jieba');
  const vec = vendoredVersion('sqlite-vec');
  return [
    { name: '@node-rs/jieba-darwin-x64', version: jieba, binary: 'jieba.darwin-x64.node' },
    { name: '@node-rs/jieba-darwin-arm64', version: jieba, binary: 'jieba.darwin-arm64.node' },
    { name: 'sqlite-vec-darwin-x64', version: vec, binary: 'vec0.dylib' },
    { name: 'sqlite-vec-darwin-arm64', version: vec, binary: 'vec0.dylib' },
  ];
}

function main() {
  if (!fs.existsSync(path.join(PLUGIN_NM, 'sqlite-vec', 'package.json'))) {
    console.error('[fetch-darwin-natives] 找不到 dsh-tdai-memory 的 vendored 依赖树，请先执行 npm install');
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-darwin-natives-'));
  try {
    for (const t of targets()) {
      const spec = `${t.name}@${t.version}`;
      const tgz = execFileSync('npm', ['pack', spec, '--pack-destination', tmp, '--silent'], { encoding: 'utf8' })
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
      if (!tgz || !tgz.endsWith('.tgz')) throw new Error(`npm pack ${spec} 输出异常: ${JSON.stringify(tgz)}`);
      const stage = path.join(tmp, 'stage-' + t.name.replace(/\W+/g, '-'));
      fs.mkdirSync(stage, { recursive: true });
      execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', stage], { stdio: 'inherit' });
      const dest = path.join(PLUGIN_NM, ...t.name.split('/'));
      fs.rmSync(dest, { recursive: true, force: true });
      // 用 cpSync 而非 renameSync：/tmp 可能与仓库不在同一文件系统
      // （EXDEV），拷贝几 MB 二进制无感知，幂等重跑也安全。
      fs.cpSync(path.join(stage, 'package'), dest, { recursive: true });
      const bin = path.join(dest, t.binary);
      if (!fs.existsSync(bin)) throw new Error(`${spec} 解包后缺少 ${t.binary}`);
      console.log(`[fetch-darwin-natives] ${spec} -> ${path.relative(path.resolve(__dirname, '..'), dest)}`);
    }
    console.log('[fetch-darwin-natives] macOS 原生负载就绪（jieba / sqlite-vec darwin x64+arm64）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
