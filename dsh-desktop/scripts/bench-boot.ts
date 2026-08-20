'use strict';
// ---------------------------------------------------------------------------
// bench-boot（Task 12.1/12.2）：冷启动关键路径基准测量（纯 Node，度量真实
// 编译产物）。
//
//   node scripts/bench-boot.js [--save <file>] [--compare <file>]
//                              [--runs N=3] [--hosts K=4] [--skip-hosts]
//
// 四段度量（对应架构文档 F2 性能专项的改造点）：
//   A. stamp-scan  全部配套插件源目录的内容戳记扫描（无缓存单遍走树）——
//                  戳记计算的原始走树成本。
//   B. copy-skip   戳记命中时 copyPluginPackage 的 no-op 路径，分冷/暖两态：
//                  冷 = 进程内首次调用（全量走树 + 目标戳记比对，即 boot 内
//                  第 1 次 sync 的稳态成本）；暖 = 进程内缓存命中（boot 内
//                  第 2 次 sync 的成本，Task 12.2 戳记缓存的核心收益）。
//   C. hosts       K 个 host-bootstrap 串行 vs 并行 spawn+init 握手（验证
//                  Extension Host 并行拉起收益；Rust Job 围栏全程在环）。
//
// IO 计数：包装 node:fs 原生模块对象的同步 API（tsc 的 __importStar 副本
// 属性是委托回原生对象的活 getter，补丁对全部被测模块生效）。多次运行取
// 中位数。报告：JSON（--save 落盘）+ 控制台表格；--compare 与旧基线对比
// （不劣化校验）。
//
// 注意：本脚本度量的是可脱离 Electron 的纯 Node 组件（plugin-copy /
// extension-host 均无 electron 运行时依赖）；完整应用冷启动的进程级开销
// （Electron 自身、窗口、dsh web 子进程）不在度量范围 —— 那部分由 e2e-v4
// 的「启动就绪 elapsed」行覆盖。
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  pluginStampOfUncached, copyPluginPackage, invalidatePluginStampCache,
} from '../lib/plugin-copy.js';
import { COMPANION_PLUGINS } from '../lib/plugin-registry-data.js';
import { RpcPeer } from '../lib/extension-host/rpc.js';

// --- CLI 参数 ----------------------------------------------------------------

function argNumber(name: string, def: number): number {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) || def : def;
}
function argString(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const RUNS = argNumber('runs', 3);
const HOSTS = argNumber('hosts', 4);
const SKIP_HOSTS = process.argv.includes('--skip-hosts');
const SAVE = argString('save');
const COMPARE = argString('compare');

// --- fs IO 计数器（CJS 下与被测模块共享同一 fs 模块对象）---------------------

// tsc 的 __importStar(require('node:fs')) 产出的是**副本对象**，其属性为
// getter-only 不可直接赋值；但 getter 委托回原生模块对象（__createBinding
// 语义），所以补丁打在原生模块对象上即可对所有 lib/*.js 的 fs 副本生效。
const realFs = require('node:fs') as typeof fs;

type SyncFn = (...args: never[]) => unknown;
const COUNTED: Array<[keyof typeof fs, string]> = [
  ['readdirSync', 'readdir'],
  ['statSync', 'stat'],
  ['lstatSync', 'lstat'],
  ['existsSync', 'exists'],
  ['readFileSync', 'readFile'],
  ['writeFileSync', 'writeFile'],
  ['copyFileSync', 'copyFile'],
  ['cpSync', 'cp'],
  ['mkdirSync', 'mkdir'],
];
const realFns = new Map<string, SyncFn>();
const ioCounts: Record<string, number> = {};
let counting = false;

function startIoCounting(): void {
  if (counting) return;
  for (const key of Object.keys(ioCounts)) delete ioCounts[key];
  counting = true;
  for (const [fn] of COUNTED) {
    const name = fn as string;
    const orig = (realFs as unknown as Record<string, SyncFn>)[name];
    if (!orig || realFns.has(name)) continue;
    realFns.set(name, orig);
    ioCounts[name] = 0;
    (realFs as unknown as Record<string, SyncFn>)[name] = ((...a: never[]) => {
      ioCounts[name] = (ioCounts[name] ?? 0) + 1;
      return orig(...a);
    }) as SyncFn;
  }
}

function stopIoCounting(): Record<string, number> {
  counting = false;
  for (const [name, orig] of realFns) {
    (realFs as unknown as Record<string, SyncFn>)[name] = orig;
  }
  realFns.clear();
  return { ...ioCounts };
}

/** 度量样：单次运行的耗时(ms) + IO 快照。 */
interface Sample {
  ms: number;
  io: Record<string, number>;
}

function measure(fn: () => void): Sample {
  startIoCounting();
  const t0 = process.hrtime.bigint();
  fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const io = stopIoCounting();
  return { ms, io };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function sumIo(samples: Sample[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples) {
    for (const [k, v] of Object.entries(s.io)) out[k] = (out[k] ?? 0) + v;
  }
  for (const k of Object.keys(out)) out[k] = Math.round((out[k] ?? 0) / samples.length);
  return out;
}

// --- 度量段 ------------------------------------------------------------------

/** 源目录解析：assets/plugins/<dir>（与 syncCompanionPlugins 的资产侧一致；
 *  覆盖层 userData/builtin-plugin-updates 属运行态，bench 不涉及）。 */
function pluginSources(): Array<{ id: string; name: string; src: string }> {
  const root = path.join(__dirname, '..', 'assets', 'plugins');
  const out: Array<{ id: string; name: string; src: string }> = [];
  for (const p of COMPANION_PLUGINS) {
    const dirName = p.dir ?? (p.name.includes('/') ? (p.name.split('/').pop() as string) : p.name);
    const src = path.join(root, dirName);
    if (!fs.existsSync(path.join(src, 'package.json'))) continue;
    out.push({ id: p.id, name: p.name, src });
  }
  return out;
}

function benchStampScan(sources: Array<{ id: string; name: string; src: string }>): { samples: Sample[]; note: string } {
  const samples: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    samples.push(measure(() => {
      for (const s of sources) pluginStampOfUncached(s.src);
    }));
  }
  return { samples, note: `${sources.length} 个插件源目录 × 无缓存单遍走树` };
}

function benchCopySkip(
  sources: Array<{ id: string; name: string; src: string }>,
  profileDir: string,
): { cold: Sample[]; warm: Sample[]; note: string } {
  // 预热：首轮真实拷贝（产生 dest 侧 .eac-copy-stamp.json），此后 no-op。
  invalidatePluginStampCache();
  for (const s of sources) copyPluginPackage(profileDir, s.src, s.name);
  // 冷态：每轮清缓存 → 度量「boot 第 1 次 sync」的全量走树 + 戳记比对。
  const cold: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    cold.push(measure(() => {
      invalidatePluginStampCache();
      for (const s of sources) copyPluginPackage(profileDir, s.src, s.name);
    }));
  }
  // 暖态：缓存命中 → 度量「boot 第 2 次 sync」的稳态成本。
  const warm: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    warm.push(measure(() => {
      for (const s of sources) copyPluginPackage(profileDir, s.src, s.name);
    }));
  }
  return {
    cold, warm,
    note: '冷 = 进程内首次 no-op（boot 第 1 次 sync）；暖 = 戳记缓存命中（boot 第 2 次 sync）',
  };
}

/** spawn 一个 host-bootstrap 并完成 init 握手（真实子进程 + 真实协议）。 */
async function spawnAndInit(
  nodeExe: string,
  hostPath: string,
  entryPath: string,
  dataDir: string,
  idx: number,
): Promise<number> {
  const t0 = Date.now();
  const child: ChildProcess = spawn(nodeExe, [hostPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  if (!child.stdin || !child.stdout) throw new Error('stdio pipe missing');
  const peer = new RpcPeer({
    write: child.stdin,
    onClosed: () => { /* bench 不关注 */ },
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('init 超时')), 20000);
    peer.request('init', {
      pluginId: `bench-plugin-${idx}`,
      entryPath,
      dataDir: path.join(dataDir, `bench-${idx}`),
      permissions: {},
    }).then(() => {
      clearTimeout(timer);
      resolve();
    }).catch(reject);
  });
  child.stdout.on('data', (c: Buffer) => peer.feed(c));
  child.stderr?.on('data', () => { /* 插件日志忽略 */ });
  await ready;
  try {
    child.kill();
  } catch { /* 已退出 */ }
  return Date.now() - t0;
}

async function benchHosts(
  nodeExe: string,
  hostPath: string,
  entryPath: string,
  dataDir: string,
): Promise<{ serialMs: number; parallelMs: number; k: number }> {
  // 串行：逐个 spawn + 握手
  const tS = Date.now();
  for (let i = 0; i < HOSTS; i++) await spawnAndInit(nodeExe, hostPath, entryPath, dataDir, i);
  const serialMs = Date.now() - tS;
  // 并行：同时 spawn，等待全部握手完成
  const tP = Date.now();
  await Promise.all(
    Array.from({ length: HOSTS }, (_, i) => spawnAndInit(nodeExe, hostPath, entryPath, dataDir, 100 + i)),
  );
  const parallelMs = Date.now() - tP;
  return { serialMs, parallelMs, k: HOSTS };
}

// --- 报告 --------------------------------------------------------------------

interface BenchReport {
  at: string;
  runs: number;
  stampScan: { medianMs: number; io: Record<string, number>; note: string };
  copySkip: {
    coldMs: number;
    warmMs: number;
    coldIo: Record<string, number>;
    warmIo: Record<string, number>;
    note: string;
  };
  hosts: { k: number; serialMs: number; parallelMs: number } | null;
  /** boot 内两次 sync 的合计成本（冷 + 暖）。 */
  totalMedianMs: number;
}

function fmtIo(io: Record<string, number>): string {
  const keys = Object.keys(io).filter((k) => (io[k] ?? 0) > 0);
  if (!keys.length) return '(无)';
  return keys.map((k) => `${k}×${io[k]}`).join(' ');
}

/** 对比模式可读入的旧版基线（copySkip 冷暖拆分前的格式）。 */
interface LegacyReport {
  at: string;
  stampScan: { medianMs: number };
  copySkip: { medianMs?: number; coldMs?: number; warmMs?: number };
  hosts: { parallelMs: number } | null;
  totalMedianMs: number;
}

// --- 主流程 ------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[bench-boot] runs=${RUNS} hosts=${HOSTS}`);
  const sources = pluginSources();
  if (!sources.length) {
    console.error('[bench-boot] 未发现任何配套插件源目录（assets/plugins 为空？）');
    process.exit(2);
  }

  // A. 戳记扫描（无缓存单遍走树）
  const scan = benchStampScan(sources);
  const scanMedian = median(scan.samples.map((s) => s.ms));
  console.log(`\nA. stamp-scan   ${scanMedian.toFixed(1)} ms/轮\n   IO: ${fmtIo(sumIo(scan.samples))}\n   ${scan.note}`);

  // B. 稳态 no-op 拷贝路径（冷 = boot 第 1 次 sync；暖 = 第 2 次 sync 缓存命中）
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bench-'));
  const profileDir = path.join(tmpRoot, 'profile-web-desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  const copy = benchCopySkip(sources, profileDir);
  const coldMedian = median(copy.cold.map((s) => s.ms));
  const warmMedian = median(copy.warm.map((s) => s.ms));
  console.log(`\nB. copy-skip    冷 ${coldMedian.toFixed(1)} ms / 暖 ${warmMedian.toFixed(1)} ms`);
  console.log(`   冷 IO: ${fmtIo(sumIo(copy.cold))}`);
  console.log(`   暖 IO: ${fmtIo(sumIo(copy.warm))}`);
  console.log(`   ${copy.note}`);

  // C. Host 串行 vs 并行拉起
  let hostsReport: BenchReport['hosts'] = null;
  if (!SKIP_HOSTS) {
    const vendorNode = path.join(__dirname, '..', 'vendor', 'node', 'node.exe');
    const nodeExe = fs.existsSync(vendorNode) ? vendorNode : process.execPath;
    const hostPath = path.join(__dirname, '..', 'host-bootstrap.js');
    const entryPath = path.join(__dirname, '..', 'assets', 'sdk-plugins', 'sample-sdk-plugin', 'index.js');
    const dataDir = path.join(tmpRoot, 'ext-data');
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(hostPath) && fs.existsSync(entryPath)) {
      const r = await benchHosts(nodeExe, hostPath, entryPath, dataDir);
      hostsReport = r;
      console.log(`\nC. hosts(${r.k})    串行 ${r.serialMs} ms → 并行 ${r.parallelMs} ms（收益 ${(100 - (r.parallelMs / r.serialMs) * 100).toFixed(0)}%）`);
    } else {
      console.log('\nC. hosts    跳过（host-bootstrap.js 或示例插件缺失）');
    }
  }

  const report: BenchReport = {
    at: new Date().toISOString(),
    runs: RUNS,
    stampScan: {
      medianMs: Math.round(scanMedian * 10) / 10,
      io: sumIo(scan.samples),
      note: scan.note,
    },
    copySkip: {
      coldMs: Math.round(coldMedian * 10) / 10,
      warmMs: Math.round(warmMedian * 10) / 10,
      coldIo: sumIo(copy.cold),
      warmIo: sumIo(copy.warm),
      note: copy.note,
    },
    hosts: hostsReport,
    totalMedianMs: Math.round((coldMedian + warmMedian) * 10) / 10,
  };
  console.log(`\n[bench-boot] boot 内两次 sync 合计（冷 + 暖）≈ ${report.totalMedianMs} ms`);

  if (SAVE) {
    fs.writeFileSync(SAVE, JSON.stringify(report, null, 2) + '\n');
    console.log(`[bench-boot] 基线已保存: ${SAVE}`);
  }

  if (COMPARE) {
    let old: LegacyReport;
    try {
      old = JSON.parse(fs.readFileSync(COMPARE, 'utf8')) as LegacyReport;
    } catch {
      console.error(`[bench-boot] 无法读取对比基线: ${COMPARE}`);
      process.exit(2);
    }
    console.log(`\n=== 对比 ${COMPARE}（${old.at}）===`);
    // 兼容旧基线格式（copySkip 只有 medianMs）：旧 no-op 每次都全量走树，
    // 冷暖同价；新格式冷 = 第 1 次 sync、暖 = 第 2 次 sync。
    const oldCold = old.copySkip.medianMs ?? old.copySkip.coldMs ?? 0;
    const oldWarm = old.copySkip.medianMs ?? old.copySkip.warmMs ?? 0;
    const oldTotal = old.copySkip.medianMs != null ? old.copySkip.medianMs * 2 : old.totalMedianMs;
    const rows: Array<[string, number, number]> = [
      ['stamp-scan 走树(ms)', report.stampScan.medianMs, old.stampScan.medianMs],
      ['copy-skip 冷·第1次sync(ms)', report.copySkip.coldMs, oldCold],
      ['copy-skip 暖·第2次sync(ms)', report.copySkip.warmMs, oldWarm],
      ['两次sync合计(ms)', report.totalMedianMs, oldTotal],
    ];
    for (const [label, now, was] of rows) {
      const d = ((now - was) / (was || 1)) * 100;
      const verdict = d <= 5 ? 'OK' : 'REGRESSION';
      console.log(`  ${label}  ${was} → ${now}  (${d >= 0 ? '+' : ''}${d.toFixed(1)}%)  ${verdict}`);
    }
    if (report.hosts && old.hosts) {
      console.log(`  hosts 并行(ms)  ${old.hosts.parallelMs} → ${report.hosts.parallelMs}`);
    }
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* 清理失败 */ }
}

main().catch((err) => {
  console.error('[bench-boot] 异常: ' + ((err as Error)?.stack || err));
  process.exit(1);
});
