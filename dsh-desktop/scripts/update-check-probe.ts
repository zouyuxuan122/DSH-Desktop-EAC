'use strict';

// 一次性探针：在真实 Electron 主进程里跑 client-updater 的更新检查，
// 验证 electron.net（系统代理 + 系统 CA）路径能否连通上游发布源。
// 用法：npx electron scripts/update-check-probe.js [当前版本号]

import { app, net } from 'electron';
import * as cu from '../client-updater.js';

const current = process.argv[2] || '0.0.0';

app.whenReady().then(async () => {
  const ctx: cu.ClientUpdCtx = {
    log: (tag, msg) => console.log(`[${tag}] ${msg}`),
    userDataDir: app.getPath('userData'),
    nodeExe: () => '',
    npmCli: () => '',
  };
  try {
    const rel = await cu.checkLatest(ctx, current);
    console.log('PROBE-OK version=' + rel.version + ' source=' + rel.source + ' assets=' + rel.assets.length);
    console.log('PROBE-ASSET(installed)=' + cu.selectAsset(rel).name);
    process.env.PORTABLE_EXECUTABLE_DIR = 'X';
    console.log('PROBE-ASSET(portable)=' + cu.selectAsset(rel).name);
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    // 下载路径冒烟：取 Setup 资产 URL，用同一条 electron.net 网络栈拉前
    // 64KB，验证重定向到 CDN 后数据能到达且是有效 PE 文件（MZ 头）。
    const setup = rel.assets.find((a) => /setup.*x64\.exe$/i.test(a.name));
    if (!setup) throw new Error('release 里没有 Setup x64 资产');
    await new Promise<void>((resolve, reject) => {
      let got = 0;
      let first2 = '';
      // Electron 运行时支持 destroy(err)（类型定义滞后），按运行时行为加宽。
      const req = net.request({ url: setup.url, redirect: 'follow' }) as Electron.ClientRequest & { destroy(err?: Error): void };
      const timer = setTimeout(() => req.destroy(new Error('下载探测超时')), 30000);
      req.on('response', (res) => {
        clearTimeout(timer);
        res.on('data', (c: Buffer) => {
          if (got === 0) first2 = c.subarray(0, 2).toString('latin1');
          got += c.length;
          if (got >= 65536) { try { req.destroy(); } catch { /* 已销毁 */ } }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error('下载探测 HTTP ' + res.statusCode)); return; }
          if (first2 !== 'MZ') { reject(new Error('下载探测内容非 PE 文件（头 ' + JSON.stringify(first2) + '）')); return; }
          console.log('PROBE-DOWNLOAD status=' + res.statusCode + ' bytes>=' + got + ' MZ=OK');
          resolve();
        });
        res.on('error', (err: Error) => {
          if (got >= 65536 && first2 === 'MZ') { console.log('PROBE-DOWNLOAD bytes>=' + got + ' MZ=OK（提前截断）'); resolve(); return; }
          reject(err);
        });
      });
      req.on('error', (err: Error) => {
        if (got >= 65536 && first2 === 'MZ') { resolve(); return; }
        reject(err);
      });
      req.end();
    });
    app.exit(0);
  } catch (err) {
    console.error('PROBE-FAIL ' + String((err as Error).message));
    app.exit(1);
  }
});
