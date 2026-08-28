'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// WSL 托管后端 —— Windows 壳经 wsl.exe 在 WSL 内安装 / 更新 / 运行自己的 dsh。
//
// WSL 内目录布局（默认 <安装目录> = ~/.dsh-desktop，可配置）：
//   <dir>/agent/node_modules/@deepseek-ai/dsh   当前生效版本（DSH_HOME=<dir>）
//   <dir>/agent-prev/...                        上一版本（更新/回退用）
//   <dir>/agent-staging/...                     npm 安装 staging（完成后原子 mv）
//   <dir>/dsh.pid                               dsh web 进程 pid（退出清理用）
//   <dir>/profiles、sessions、settings.yaml      dsh 自身数据（与本地模式同构）
// 配套插件同步不在这里：main.js 的 syncCompanionPlugins 经 UNC（effectiveDshHome
// = <dir> 的 UNC 等价路径）直接写入 WSL profile，与本模块解耦。
//
// 跨 WSL 调用约定（已在真实 wsl.exe 上实测）：
//   · wsl.exe 只接受 `--` 之后「按空格拆开的独立 argv 单词」；把整条命令拼成
//     一个带空格的字符串会被当成单个词直接 exec 而失败；
//   · `-e`（--exec）跳过默认 shell 的二次解析，argv 原样 execvp，最可靠；
//   · 必须用登录 shell（sh -lc）：fnm/nvm 的 node 只在登录 shell 的 PATH 里；
//   · 安装目录不允许包含空白字符，规避 shell 转义问题（发行版名允许含空格，
//     libuv 的引号处理会覆盖）。
const node_child_process_1 = require("node:child_process");
const fs = require("node:fs");
const PKG = '@deepseek-ai/dsh';
const WSL_EXE = 'wsl.exe';
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
    configured: false,
    distro: '',
    installDir: '', // Linux 绝对路径（无空白）
    uncDir: '', // Windows UNC 等价路径（main.js 的 DSH_HOME 映射用）
    nodeVersion: '', // WSL 内 node --version
    npmVersion: '', // WSL 内 npm --version
    lastError: '',
    logFn: null,
    versionCache: null,
};
function log(msg) {
    try {
        if (state.logFn) {
            state.logFn('wsl', msg);
            return;
        }
    }
    catch { }
    console.log('[wsl] ' + msg);
}
function fail(msg) {
    state.lastError = msg;
    throw new Error(msg);
}
// ---------------------------------------------------------------------------
// wsl.exe 原语
// ---------------------------------------------------------------------------
/** 同步执行一条 WSL 命令（探活/读文件用；长命令请用 runWsl）。 */
function runWslSync(cmd, timeoutMs = 60000) {
    const res = (0, node_child_process_1.spawnSync)(WSL_EXE, ['-d', state.distro, '-e', 'sh', '-lc', cmd], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error)
        return { ok: false, code: -1, stdout: '', stderr: String(res.error) };
    return { ok: res.status === 0, code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}
function runWsl(cmd, { timeoutMs = 20 * 60 * 1000, onLine } = {}) {
    return new Promise((resolve) => {
        const child = (0, node_child_process_1.spawn)(WSL_EXE, ['-d', state.distro, '-e', 'sh', '-lc', cmd], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            try {
                child.kill();
            }
            catch { }
        }, timeoutMs);
        child.stdout.on('data', (c) => {
            const text = c.toString('utf8');
            out += text;
            if (onLine) {
                for (const line of text.split(/\r?\n/)) {
                    if (line.trim()) {
                        try {
                            onLine(line);
                        }
                        catch { }
                    }
                }
            }
        });
        child.stderr.on('data', (c) => { err += c.toString('utf8'); });
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ ok: false, code: -1, timedOut: false, stdout: out, stderr: err, error: String(e.message || e) });
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ ok: !killed && code === 0, code, timedOut: killed, stdout: out, stderr: err });
        });
    });
}
/** wsl.exe 自身输出是 UTF-16LE（含 BOM）：解码并拆成干净的行。 */
function wslListDistros() {
    const res = (0, node_child_process_1.spawnSync)(WSL_EXE, ['-l', '-q'], { encoding: 'buffer', windowsHide: true, timeout: 30000 });
    if (res.error)
        return [];
    let text = '';
    const buf = res.stdout || Buffer.alloc(0);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
        text = buf.subarray(2).toString('utf16le');
    else
        text = buf.toString('utf16le');
    return text.replace(/^\uFEFF/, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
// ---------------------------------------------------------------------------
// 配置与探活
// ---------------------------------------------------------------------------
/**
 * 解析配置并探活（同步，boot 早期调用；失败抛错，错误信息可展示给用户）。
 * @param opts { distro?, installDir?, log }
 */
function configure(opts = {}) {
    state.logFn = opts.log || null;
    state.lastError = '';
    state.distro = String(opts.distro || '').trim();
    if (!state.distro) {
        const distros = wslListDistros();
        if (distros.length === 0) {
            fail('未检测到 WSL 发行版。请确认已安装 WSL（wsl --install），或通过设置 wslDistro 指定发行版名。');
        }
        state.distro = distros[0];
    }
    log(`使用 WSL 发行版: ${state.distro}`);
    // 安装目录：显式配置 > 默认 $HOME/.dsh-desktop（刻意不默认 ~/.dsh，
    // 避免与用户自有的 dsh 共用 DSH_HOME 导致版本迁移互相改写）。
    let dir = String(opts.installDir || '').trim();
    if (dir) {
        if (dir.startsWith('~'))
            dir = homeDir() + dir.slice(1);
        if (!dir.startsWith('/'))
            fail(`wslInstallDir 必须是 WSL 内的绝对路径（以 / 或 ~ 开头）: ${dir}`);
    }
    else {
        dir = homeDir() + '/.dsh-desktop';
    }
    if (/\s/.test(dir))
        fail(`wslInstallDir 不能包含空白字符（shell 命令拼接需要）: ${dir}`);
    state.installDir = dir;
    state.uncDir = '\\\\' + uncHost() + '\\' + state.distro + dir.replace(/\//g, '\\');
    log(`安装目录: ${dir}（UNC: ${state.uncDir}）`);
    // 探活 node / npm（登录 shell，fnm 等版本管理器的 profile 初始化会生效）。
    const nodeRes = runWslSync("sh -lc 'node --version'", 90000);
    const npmRes = runWslSync("sh -lc 'npm --version'", 90000);
    state.nodeVersion = nodeRes.ok ? (nodeRes.stdout || '').trim() : '';
    state.npmVersion = npmRes.ok ? (npmRes.stdout || '').trim() : '';
    if (!state.nodeVersion || !state.npmVersion) {
        fail('WSL 内未找到可用的 node/npm。请先在 WSL 里安装 Node.js（如 apt install nodejs npm，或 fnm/nvm），然后重启应用。\n' + nodeRes.stderr + npmRes.stderr);
    }
    log(`WSL 运行时: node ${state.nodeVersion} / npm ${state.npmVersion}`);
    state.configured = true;
    return self();
}
function homeDir() {
    const res = runWslSync("sh -lc 'printf %s \"$HOME\"'", 60000);
    const home = (res.stdout || '').trim();
    if (!res.ok || !home.startsWith('/'))
        fail('无法解析 WSL 用户主目录: ' + (res.stderr || res.stdout));
    return home;
}
/** UNC 主机前缀：wsl.localhost（Win11）失败时回落 wsl$（旧版）。 */
function uncHost() {
    for (const host of ['wsl.localhost', 'wsl$']) {
        try {
            if (fs.existsSync('\\\\' + host))
                return host;
        }
        catch { }
    }
    // 探测失败也返回 wsl.localhost（Win11 默认；旧版可手动改代码）。
    return 'wsl.localhost';
}
function isConfigured() { return state.configured; }
function isReady() { return state.configured && !state.lastError; }
function lastError() { return state.lastError; }
function installDirLinux() { return state.installDir; }
function uncHome() { return state.uncDir; }
function distroName() { return state.distro; }
/** 当前配置/探测状态快照（设置页展示用，不抛错）。 */
function status() {
    return {
        configured: state.configured,
        distro: state.distro,
        installDir: state.installDir,
        uncDir: state.uncDir,
        nodeVersion: state.nodeVersion,
        npmVersion: state.npmVersion,
        agentVersion: activeVersion(),
        lastError: state.lastError,
    };
}
// ---------------------------------------------------------------------------
// 安装 / 更新 / 回退
// ---------------------------------------------------------------------------
function agentBin() {
    return `${state.installDir}/agent/node_modules/@deepseek-ai/dsh/lib/bin.js`;
}
/** 内置壳自带的 dsh 版本（bootstrap 首次安装用）。 */
function bundledVersion() {
    try {
        return require(PKG + '/package.json').version;
    }
    catch {
        return 'latest';
    }
}
/**
 * 在 WSL 内执行一次 npm 安装并原子切换：装进 agent-staging，成功后
 * 旧 agent → agent-prev，staging → agent。失败保留现状并清理 staging。
 * 语义与 updater.js 的 Windows 路径对齐（save-exact / omit=dev /
 * 安装后校验入口文件 / 失败清理 staging）。
 */
async function installAgent(version, onLine) {
    const dir = state.installDir;
    const bin = `${dir}/agent-staging/node_modules/@deepseek-ai/dsh/lib/bin.js`;
    const cmd = `sh -lc 'set -eu; rm -rf ${dir}/agent-staging; mkdir -p ${dir}/agent-staging; cd ${dir}/agent-staging; export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false; npm install --save-exact --omit=dev --no-audit --no-fund --no-update-notifier ${PKG}@${version}; test -f ${bin}; cd ${dir}; if [ -d agent ]; then rm -rf agent-prev; mv agent agent-prev; fi; mv agent-staging agent; echo WSL_INSTALL_OK'`;
    const res = await runWsl(cmd, { timeoutMs: 30 * 60 * 1000, onLine });
    if (!res.ok || !res.stdout.includes('WSL_INSTALL_OK')) {
        const tail = (res.stderr || res.stdout || '').split(/\r?\n/).slice(-15).join('\n');
        await runWsl(`sh -lc 'rm -rf ${dir}/agent-staging'`).catch(() => { });
        throw new Error(`WSL 内 npm 安装 ${PKG}@${version} 失败（exit=${res.code}${res.timedOut ? '，超时' : ''}）:\n${tail}`);
    }
    state.versionCache = null;
    log(`${PKG}@${version} 已安装到 WSL（${dir}/agent）`);
}
/** 确保 agent 已安装（缺失时按内置版本安装；首次约数分钟）。 */
async function ensureInstalled() {
    const mk = await runWsl(`sh -lc 'mkdir -p ${state.installDir}'`);
    if (!mk.ok)
        fail(`无法在 WSL 内创建安装目录 ${state.installDir}: ${mk.stderr || mk.stdout}`);
    const check = await runWsl(`sh -lc 'test -f ${agentBin()} && echo EXISTS'`);
    if (check.ok && check.stdout.includes('EXISTS'))
        return false;
    const version = bundledVersion();
    log(`agent 缺失，开始在 WSL 内安装 ${PKG}@${version}（首次约数分钟）…`);
    await installAgent(version, (line) => log('npm: ' + line));
    return true;
}
/** 官方更新：与 ensureInstalled 同一路径（版本由 main.js 的检查流程决定）。 */
async function applyUpdate(version, onLine) {
    log(`开始更新 WSL 内 dsh 到 ${version}…`);
    await installAgent(version, onLine);
    return true;
}
/** 回退到上一版本（agent-prev → agent）。 */
async function rollback() {
    const dir = state.installDir;
    const res = await runWsl(`sh -lc 'cd ${dir} && rm -rf agent-failed && mv agent agent-failed 2>/dev/null || true; if [ -d agent-prev ]; then mv agent-prev agent; echo WSL_ROLLBACK_OK; else echo WSL_NO_PREV; fi'`);
    state.versionCache = null;
    if (res.stdout.includes('WSL_NO_PREV'))
        return false;
    log('已回退到上一版本（agent-prev）');
    return true;
}
async function hasPrevious() {
    const res = await runWsl(`sh -lc 'test -d ${state.installDir}/agent-prev && echo YES'`);
    return res.ok && res.stdout.includes('YES');
}
/** 当前生效版本（WSL 内读 package.json，失败返回 null）。 */
function activeVersion() {
    if (state.versionCache !== null)
        return state.versionCache;
    try {
        const res = runWslSync(`sh -lc 'cat ${state.installDir}/agent/node_modules/@deepseek-ai/dsh/package.json'`, 60000);
        if (res.ok) {
            state.versionCache = JSON.parse(res.stdout).version || null;
            return state.versionCache;
        }
    }
    catch { }
    state.versionCache = null;
    return null;
}
// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------
/**
 * 在 WSL 内启动 dsh web，返回 wsl.exe 子进程。
 * stdout（含 `dsh web: http://127.0.0.1:<port>` 就绪行）透传给调用方
 * （main.js 复用本地模式的 URL 解析与超时逻辑）；pid 写入 <dir>/dsh.pid。
 */
function spawnServer() {
    const dir = state.installDir;
    // env -u 清掉宿主 harness 残留（DSH_WEB_URL / 会话变量），避免 WSL 内 dsh 误判；
    // DSH_HOME 指向安装目录（profiles/sessions 数据与 agent 同目录）。
    const cmd = `sh -lc 'cd ${dir} && rm -f dsh.pid && echo $$ > dsh.pid && exec env -u DSH_WEB_URL -u DSH_SESSION_ID -u DSH_SESSION_JSONL -u DSH_SHELL -u NODE_OPTIONS DSH_HOME=${dir} node ${agentBin()} web --host 127.0.0.1 --port 0'`;
    log(`启动 WSL dsh web: ${cmd}`);
    const proc = (0, node_child_process_1.spawn)(WSL_EXE, ['-d', state.distro, '-e', 'sh', '-lc', cmd], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return proc;
}
/** 按 pid 文件优雅终止 WSL 内的 dsh web（绝不 wsl --terminate，那会杀整个发行版）。 */
async function stop() {
    const dir = state.installDir;
    const res = await runWsl(`sh -lc 'p=${dir}/dsh.pid; if [ -f $p ]; then kill $(cat $p) 2>/dev/null || true; fi; rm -f ${dir}/dsh.pid'`, { timeoutMs: 30000 });
    log('已请求终止 WSL 内 dsh web' + (res.ok ? '' : '（可能已退出）'));
}
function self() {
    return {
        configure, isConfigured, isReady, lastError, status,
        installDirLinux, uncHome, distroName,
        ensureInstalled, applyUpdate, rollback, hasPrevious, activeVersion,
        spawnServer, stop, bundledVersion,
        _internals: { runWsl, runWslSync, wslListDistros },
    };
}
module.exports = self();
