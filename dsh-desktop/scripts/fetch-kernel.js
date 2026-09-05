'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// 一键重建 vendored 内核 tarball 缓存（vendor/kernel/<version>/）。
//
// Why: @deepseek-ai/dsh 0.1.2-alpha.1 尚未发布 npm，只能从 GitHub tag 源码
// 构建官方 release:pack 链。tarball 缓存不入库（vendor/ 已 gitignore），本
// 脚本保证缓存可复现：下载 tag → 解包 → 套 Windows 构建补丁 → pnpm install
// → build:official → 双家族 pack → 落位 vendor/kernel/<version>/。
//
// Windows 补丁两处（均为构建工具脚本，不进任何包产物）：
//   1. scripts/release/pack.ts  —— 裸 spawn('pnpm') 在 Windows 找不到 .cmd，
//      改走 pnpmInvocation（npm_execpath + node）；
//   2. scripts/release/tarball.ts —— tar 走相对路径，GNU tar / bsdtar
//      均不把 `D:\...` 当远程 tape 主机，避免依赖 --force-local。
//
// 前置：pnpm 版本必须等于内核 packageManager 钉住的版本（脚本自校验）。
// 用法：npm run fetch-kernel [-- <tag>]（默认 dsh-v0.1.2-alpha.1）
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const REPO = 'deepseek-ai/deepseek-harness';
const DEFAULT_TAG = 'dsh-v0.1.3-alpha.1';
const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, 'vendor', 'kernel', '.build');
const TMP = path.join(os.tmpdir(), 'dsh-kernel-build');
/** 把 lockfile 里 file:vendor tarball 的 integrity 同步为实际产物 hash。 */
function syncLockfileIntegrity(dest, version) {
    const lockPath = path.join(ROOT, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const prefix = `file:vendor/kernel/${version}/`;
    let updated = 0;
    for (const entry of Object.values(lock.packages)) {
        if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(prefix))
            continue;
        const file = entry.resolved.slice(prefix.length);
        const tarball = path.join(dest, file);
        if (!fs.existsSync(tarball)) {
            throw new Error(`lockfile 引用的 tarball 不存在: ${tarball}`);
        }
        const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
        if (entry.integrity !== integrity) {
            entry.integrity = integrity;
            updated += 1;
        }
    }
    if (updated > 0) {
        fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }
    console.log(`fetch-kernel: 同步 lockfile integrity ${updated} 个（${version}）`);
}
function run(command, args, cwd, env) {
    const result = cp.spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
    if (result.error !== undefined)
        throw result.error;
    if (result.status !== 0)
        throw new Error(`命令失败（${String(result.status)}）: ${command} ${args.join(' ')}`);
}
function capture(command, args) {
    const result = cp.spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0 || result.error !== undefined) {
        throw new Error(`命令失败: ${command} ${args.join(' ')}`);
    }
    return (result.stdout ?? '').trim();
}
/** 解析 npm 的 JS CLI（避免 Windows 下裸 spawn npm.ps1 导致 ENOENT）。 */
function resolveNpmCli() {
    if (process.env.npm_execpath)
        return process.env.npm_execpath;
    let dir = path.dirname(process.execPath);
    for (let depth = 0; depth < 4; depth += 1) {
        for (const sub of ['node_modules/npm/bin/npm-cli.js', 'lib/node_modules/npm/bin/npm-cli.js']) {
            const candidate = path.join(dir, sub);
            if (fs.existsSync(candidate))
                return candidate;
        }
        dir = path.dirname(dir);
    }
    throw new Error(`找不到 npm CLI（从 ${path.dirname(process.execPath)} 向上查找失败）`);
}
/** 解析 pnpm 的 JS 入口（npm 全局 root 下的 pnpm/bin/pnpm.cjs）。 */
function resolvePnpmEntry() {
    const entry = path.join(capture(process.execPath, [resolveNpmCli(), 'root', '-g']), 'pnpm', 'bin', 'pnpm.cjs');
    if (!fs.existsSync(entry)) {
        throw new Error(`找不到 pnpm 的 JS 入口（${entry}）。请先 npm install -g pnpm@<内核钉住的版本>`);
    }
    const version = capture(process.execPath, [entry, '--version']);
    return { entry, version };
}
function extractKernelArchive(tgzPath) {
    const result = cp.spawnSync('tar', ['-xzf', path.basename(tgzPath)], { cwd: WORK, stdio: 'inherit' });
    if (result.error !== undefined)
        throw result.error;
    if (result.status === 0)
        return;
    const srcDir = findKernelSourceDirectory();
    // Windows 的 bsdtar 会在不支持的 symlink 上返回非零，但仍会完整解出
    // 内核构建所需源码。只接受经严格校验的这一个已知降级路径。
    if (process.platform === 'win32' && srcDir !== undefined && hasKernelBuildInputs(srcDir)) {
        console.warn(`fetch-kernel: tar 因 Windows 不支持的链接条目返回 ${String(result.status)}，已校验源码完整，继续构建`);
        return;
    }
    throw new Error(`解包失败（${String(result.status)}）: tar -xzf ${path.basename(tgzPath)}`);
}
function findKernelSourceDirectory() {
    const srcDir = fs.readdirSync(WORK).find((entry) => entry.startsWith('deepseek-harness-') && fs.statSync(path.join(WORK, entry)).isDirectory());
    return srcDir === undefined ? undefined : path.join(WORK, srcDir);
}
function hasKernelBuildInputs(src) {
    return [
        'package.json',
        'scripts/pnpm-invocation.ts',
        'scripts/release/pack.ts',
        'scripts/release/tarball.ts',
    ].every((file) => fs.existsSync(path.join(src, file)));
}
function main() {
    const tag = process.argv[2] || DEFAULT_TAG;
    const version = tag.replace(/^dsh-v/, '');
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
        throw new Error(`无法从 tag 推导版本号: ${tag}`);
    }
    const dest = path.join(ROOT, 'vendor', 'kernel', version);
    if (fs.existsSync(dest)) {
        syncLockfileIntegrity(dest, version);
        console.log(`fetch-kernel: 缓存已存在 ${dest}（如需重建请先删除）`);
        return;
    }
    const pnpm = resolvePnpmEntry();
    console.log(`fetch-kernel: tag=${tag} version=${version} pnpm=${pnpm.version}`);
    // 内核 packageManager 钉死 pnpm 版本（当前 11.7.0）：build.ts 内部会再起
    // `pnpm` 子进程，版本不符会直接拒绝执行。
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    const tgzPath = path.join(WORK, `${tag}.tar.gz`);
    const url = `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`;
    // 本机 DNS 偶发解析失败（codeload.github.com 间歇 NXDOMAIN）；预下载兜底
    // 存在则直接复用，避免整链重跑。路径由环境变量 DSH_KERNEL_TARBALL 指定。
    const preTarball = process.env.DSH_KERNEL_TARBALL;
    if (preTarball && fs.existsSync(preTarball)) {
        fs.copyFileSync(preTarball, tgzPath);
        console.log(`fetch-kernel: 使用预下载 tarball ${preTarball}`);
    }
    else {
        const curlArgs = ['-fsSL', '-o', tgzPath, url];
        if (process.platform === 'win32')
            curlArgs.splice(1, 0, '--ssl-no-revoke'); // 本机证书库校验坑
        console.log(`fetch-kernel: 下载 ${url}`);
        run('curl', curlArgs, WORK);
    }
    console.log('fetch-kernel: 解包');
    extractKernelArchive(tgzPath);
    const src = findKernelSourceDirectory();
    if (src === undefined)
        throw new Error('解包后找不到源码目录');
    // 补丁 1：pack.ts 走 pnpmInvocation（Windows spawn('pnpm') ENOENT）。
    const packTs = path.join(src, 'scripts', 'release', 'pack.ts');
    let pack = fs.readFileSync(packTs, 'utf8');
    const packAnchor = "await runConcurrent('pnpm', ['--dir', member.directory, 'pack', '--pack-destination', destination])";
    if (!pack.includes(packAnchor))
        throw new Error('pack.ts 锚点未命中，上游脚本已变化，需人工评估补丁');
    pack = pack.replace("import { isEntry, runConcurrent } from './process.ts'", "import { pnpmInvocation } from '../pnpm-invocation.ts'\nimport { isEntry, runConcurrent } from './process.ts'").replace(packAnchor, "const invocation = pnpmInvocation(['--dir', member.directory, 'pack', '--pack-destination', destination])\n  await runConcurrent(invocation.command, invocation.args)");
    fs.writeFileSync(packTs, pack);
    // 补丁 2：tarball.ts 的 tar 盘符问题（相对路径，GNU tar / bsdtar 通用）。
    const tarballTs = path.join(src, 'scripts', 'release', 'tarball.ts');
    let tarball = fs.readFileSync(tarballTs, 'utf8');
    const tarImport = "import { readFileSync } from 'node:fs'";
    if (!tarball.includes(tarImport))
        throw new Error('tarball.ts 锚点未命中: import');
    tarball = tarball.replace(tarImport, "import { readFileSync } from 'node:fs'\nimport { relative } from 'node:path'").replace("import { capture } from './process.ts'", "import { capture } from './process.ts'\n\nfunction tarCmd(tarball: string, ...rest: string[]): string[] {\n  return [...rest, relative(process.cwd(), tarball)]\n}");
    const tarAnchorList = [
        "capture('tar', ['-tzf', tarball])",
        "capture('tar', ['-xOzf', tarball, 'package/package.json'])",
    ];
    for (const anchor of tarAnchorList) {
        if (!tarball.includes(anchor))
            throw new Error(`tarball.ts 锚点未命中: ${anchor}`);
    }
    tarball = tarball
        .replace(tarAnchorList[0], "capture('tar', tarCmd(tarball, '-tzf'))")
        .replace(tarAnchorList[1], "capture('tar', tarCmd(tarball, '-xOzf', 'package/package.json'))");
    fs.writeFileSync(tarballTs, tarball);
    // git init：lefthook postinstall 等 git 探针在无仓库目录会失败。
    cp.spawnSync('git', ['init', '-q'], { cwd: src });
    // commit hash：构建元数据要求 7 位以上十六进制；tarball 无 .git，取 tag 指向的 commit。
    const refJson = capture('curl', process.platform === 'win32'
        ? ['--ssl-no-revoke', '-fsSL', `https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`]
        : ['-fsSL', `https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`]);
    const commitSha = JSON.parse(refJson).object.sha;
    const baseEnv = {
        npm_execpath: pnpm.entry,
        TEMP: TMP,
        TMP,
        DSH_CLIENT_COMMIT_HASH: commitSha.slice(0, 7).toLowerCase(),
    };
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    console.log('fetch-kernel: pnpm install（首次较慢）');
    run(process.execPath, [pnpm.entry, 'install'], src, baseEnv);
    console.log('fetch-kernel: build:official');
    run(process.execPath, [pnpm.entry, 'run', 'build:official'], src, baseEnv);
    console.log('fetch-kernel: pack dsh / vendor');
    run(process.execPath, [pnpm.entry, 'exec', 'tsx', 'scripts/release/pack.ts', '--family', 'dsh', '--out', 'dist/npm-dsh', '--concurrency', '8'], src, baseEnv);
    run(process.execPath, [pnpm.entry, 'exec', 'tsx', 'scripts/release/pack.ts', '--family', 'vendor', '--out', 'dist/npm-vendor', '--concurrency', '8'], src, baseEnv);
    fs.mkdirSync(dest, { recursive: true });
    for (const family of ['npm-dsh', 'npm-vendor']) {
        const from = path.join(src, 'dist', family);
        for (const file of fs.readdirSync(from))
            fs.copyFileSync(path.join(from, file), path.join(dest, file));
    }
    const count = fs.readdirSync(dest).filter((f) => f.endsWith('.tgz')).length;
    syncLockfileIntegrity(dest, version);
    console.log(`fetch-kernel: 完成，${count} 个 tarball → ${path.relative(ROOT, dest)}（${os.EOL}接线：npm run gen-kernel-overrides && npm install）`);
}
try {
    main();
}
catch (err) {
    console.error('fetch-kernel:', err.message);
    process.exit(1);
}
