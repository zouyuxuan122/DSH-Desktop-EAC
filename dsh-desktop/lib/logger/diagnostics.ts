/**
 * lib/logger/diagnostics.ts — 诊断 zip 导出（AC-8）（Task 14 自 api.ts 拆出）。
 *
 * 把 logs/main.NN、settings.json、dsh-settings.yaml、profile patch、更新器
 * 待装元数据与最近备份 manifest 打成一个 zip 供问题上报；所有配置文件入包
 * 前再次脱敏（JSON → deepRedact，YAML → 浅掩码）；跳过大型备份归档本体。
 *
 * 与 api.ts 存在受控循环引用：本文件顶层不读取 api 的任何绑定（仅在
 * buildDiagnosticsZip 函数体内访问 _state/makeActionTrace），api.ts 组装
 * loggerAPI 时本模块已初始化完毕 —— ESM live binding / CJS 命名空间访问
 * 两种形态下均安全。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { deepRedact, _valueMasked } from './redact.js';
import { _state, makeActionTrace } from './api.js';
import type { DiagnosticsZipOpts } from './api.js';

/** zip 条目清单行。 */
interface ManifestEntry {
  name: string;
  size: number;
  mtime: string;
}

/** archiver 的最小结构类型。 */
interface ArchiverLike {
  on(ev: 'error', cb: (e: Error) => void): void;
  pipe(w: NodeJS.WritableStream): void;
  append(data: Buffer | string, opts: { name: string; date?: Date }): void;
  finalize(): Promise<void>;
}

/** 构建诊断 zip（详见文件头）。返回 zip 绝对路径。 */
export async function buildDiagnosticsZip(opts: DiagnosticsZipOpts): Promise<string> {
  if (!opts.logsDir || !opts.userDataDir || !opts.dshHome) {
    throw new Error('buildDiagnosticsZip: logsDir, userDataDir, dshHome are all required');
  }
  const logsDir = opts.logsDir;
  const userDataDir = opts.userDataDir;
  const dshHome = opts.dshHome;
  const outDir = opts.outDir || logsDir;
  fs.mkdirSync(outDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zipName = `dsh-diagnostics-${ts}.zip`;
  const zipPath = path.join(outDir, zipName);
  const output = fs.createWriteStream(zipPath);

  let archiver: ((format: string, opts?: Record<string, unknown>) => ArchiverLike) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    archiver = require('archiver');
  } catch (e) {
    throw new Error('archiver dep missing: ' + String((e as Error).message));
  }
  const archiverFn = archiver as (format: string, opts?: Record<string, unknown>) => ArchiverLike;
  const archive = archiverFn('zip', { zlib: { level: 9 } });
  archive.on('error', (e: Error) => {
    throw e;
  });
  archive.pipe(output);

  const manifestEntries: ManifestEntry[] = [];
  let totalSize = 0;

  /** buffer → 归档条目 + 清单记录。 */
  function addBuffer(name: string, buf: Buffer | string, opts2: { mtime?: Date } = {}): void {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
    archive.append(b, { name, date: opts2.mtime || new Date() });
    totalSize += b.length;
    manifestEntries.push({ name, size: b.length, mtime: (opts2.mtime || new Date()).toISOString() });
  }

  // (1) 日志：logsDir/main.NN（已 PII 掩码，逐行再跑一次值掩码做纵深防御）。
  if (fs.existsSync(logsDir)) {
    const logFiles = fs.readdirSync(logsDir)
      .filter((f) => /^main\.\d{2}$/.test(f))
      .sort();
    for (const f of logFiles) {
      const src = path.join(logsDir, f);
      let text: string;
      try {
        text = fs.readFileSync(src, 'utf8');
      } catch (e) {
        _state.onError(e);
        continue;
      }
      // 逐行：先 JSON.parse + deepRedact；失败则 shallow 值掩码。
      let masked = '';
      for (const line of text.split('\n')) {
        if (!line) {
          masked += '\n';
          continue;
        }
        let m = line;
        try {
          const obj = JSON.parse(line) as unknown;
          m = JSON.stringify(deepRedact(obj));
        } catch {
          m = _valueMasked(line) as string;
        }
        masked += m + '\n';
      }
      const st = fs.statSync(src);
      addBuffer('logs/' + f, masked, { mtime: st.mtime });
    }
  }

  // (2) 配置文件：settings.json（JSON → deepRedact）与 YAML（浅掩码）。
  {
    const src = path.join(userDataDir, 'settings.json');
    if (fs.existsSync(src)) {
      try {
        const raw = fs.readFileSync(src, 'utf8');
        let out = raw;
        try {
          out = JSON.stringify(deepRedact(JSON.parse(raw)), null, 2) as string;
        } catch {
          out = _valueMasked(raw) as string;
        }
        const st = fs.statSync(src);
        addBuffer('config/settings.json', out, { mtime: st.mtime });
      } catch (e) {
        _state.onError(e);
      }
    }
  }
  {
    const src = path.join(userDataDir, 'dsh-settings.yaml');
    if (fs.existsSync(src)) {
      try {
        const masked = _valueMasked(fs.readFileSync(src, 'utf8')) as string;
        const st = fs.statSync(src);
        addBuffer('config/dsh-settings.yaml', masked, { mtime: st.mtime });
      } catch (e) {
        _state.onError(e);
      }
    }
  }
  {
    const profileDir = path.join(userDataDir, 'profiles', 'web-desktop');
    const src = path.join(profileDir, 'cordis.patch.yml');
    if (fs.existsSync(src)) {
      try {
        const masked = _valueMasked(fs.readFileSync(src, 'utf8')) as string;
        const st = fs.statSync(src);
        addBuffer('config/profile/cordis.patch.yml', masked, { mtime: st.mtime });
      } catch (e) {
        _state.onError(e);
      }
    }
  }

  // (3) 更新器的待装更新元数据。
  {
    const updaterDir = path.join(dshHome, 'updater');
    if (fs.existsSync(updaterDir)) {
      for (const f of fs.readdirSync(updaterDir)) {
        if (!/^pending-client-update-.*\.json$/i.test(f)) continue;
        const src = path.join(updaterDir, f);
        try {
          const raw = fs.readFileSync(src, 'utf8');
          let masked = raw;
          try {
            masked = JSON.stringify(deepRedact(JSON.parse(raw)), null, 2);
          } catch {
            masked = _valueMasked(raw) as string;
          }
          const st = fs.statSync(src);
          addBuffer('updater/' + f, masked, { mtime: st.mtime });
        } catch (e) {
          _state.onError(e);
        }
      }
    }
  }

  // (4) 最近一次备份的 manifest（仅 manifest，绝不含备份归档本体）。
  {
    const backupRoot = path.join(dshHome, 'updater', 'backup');
    if (fs.existsSync(backupRoot)) {
      // 遍历子目录，取 mtime 最新的。
      let newestDir: string | null = null;
      let newestMtime = -1;
      for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = path.join(backupRoot, entry.name);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > newestMtime) {
            newestMtime = st.mtimeMs;
            newestDir = p;
          }
        } catch {
          /* 单目录 stat 失败跳过 */
        }
      }
      if (newestDir) {
        const mani = path.join(newestDir, 'manifest.json');
        if (fs.existsSync(mani)) {
          try {
            const raw = fs.readFileSync(mani, 'utf8');
            let masked = raw;
            try {
              masked = JSON.stringify(deepRedact(JSON.parse(raw)), null, 2);
            } catch {
              masked = _valueMasked(raw) as string;
            }
            const st = fs.statSync(mani);
            addBuffer('updater/backup/latest.manifest.json', masked, { mtime: st.mtime });
          } catch (e) {
            _state.onError(e);
          }
        }
      }
    }
  }

  // (5) diagnostics.json + manifest.json（大小预估 → 先算尺寸再追加）。
  const diagnostics: Record<string, unknown> = {
    bootTraceId: _state.bootTraceId || makeActionTrace('diag').actionId,
    appVersion: _state.appVersion || '0.0.0',
    env: _state.env || 'unknown',
    exportedAt: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch(),
    pid: process.pid,
    nodeVersion: process.version,
    host: (os.hostname() || '').slice(0, 64),
    entriesCount: manifestEntries.length,
    totalSize, // 占位，追加 manifest 后更新
  };
  const diagJSON0 = JSON.stringify(diagnostics, null, 2);
  const maniStub = JSON.stringify(
    {
      version: 1,
      generatedAt: diagnostics.exportedAt,
      entries: manifestEntries.map((e) => ({ ...e })),
    },
    null,
    2,
  );
  totalSize += Buffer.byteLength(diagJSON0, 'utf8') + Buffer.byteLength(maniStub, 'utf8');
  diagnostics.totalSize = totalSize;

  addBuffer('diagnostics.json', JSON.stringify(diagnostics, null, 2), { mtime: new Date() });

  const finalManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: manifestEntries.map((e) => ({ ...e })),
  };
  archive.append(Buffer.from(JSON.stringify(finalManifest, null, 2), 'utf8'), { name: 'manifest.json', date: new Date() });

  // 收尾：等 output 完全关闭（避免文件句柄共享冲突）。
  const finished = new Promise<void>((res, rej) => {
    output.once('close', () => res());
    output.once('error', rej);
    process.nextTick(() => {
      if (output.closed) res();
    });
  });
  await archive.finalize();
  await finished;

  return zipPath;
}
