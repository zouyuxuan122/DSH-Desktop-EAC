// macOS v1：上游 Release 无 macOS 资产，客户端更新流程整体关闭。
// dsh agent 更新（updater.ts overlay）不经过本模块，不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, runClientUpdateFlow } from '../lib/desktop/client-update.js';

test('darwin 上 runClientUpdateFlow 直接返回，不触发任何 UI', async () => {
  let boxes = 0;
  init({
    log: () => {},
    showBox: async () => { boxes += 1; return { response: 0 }; },
    isQuitting: () => false,
    getAppVersion: () => '5.1.0',
    getUserDataDir: () => '/tmp/dsh-eac-darwin-test',
    getDshHome: () => null,
    getPlatform: () => 'darwin',
    openExternal: async () => true,
    showUpdateWindow: () => null,
    makeUpdateProgressPusher: () => ({ client: () => {}, agent: () => {}, force: () => {} }),
    prepareQuitForClientUpdate: async () => {},
    exitProcess: () => {},
    getExecDir: () => '/tmp/dsh-eac-darwin-test',
  });
  await runClientUpdateFlow(true);
  assert.equal(boxes, 0);
});
