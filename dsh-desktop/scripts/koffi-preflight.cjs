'use strict';
// koffi FFI 冒烟探针：由桌面壳启动前以子进程运行（scripts/koffi-preflight.cjs）。
// koffi 3.1.3 / 3.1.4 的 win32-x64 预编译二进制在部分 Windows 机器上会在
// koffi.load() 处以访问违例（0xC0000005）崩溃。本探针把崩溃限制在子进程里，
// 父进程只读取退出码，据此决定是否把目录选择器降级为 browse 后端。
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const koffiDir = path.resolve(__dirname, '..', 'node_modules', 'koffi');
  const koffi = (await import(pathToFileURL(path.join(koffiDir, 'index.cjs')))).default;
  const kernel32 = koffi.load('kernel32.dll');
  const getCurrentProcessId = kernel32.func('GetCurrentProcessId', 'uint32', []);
  const pid = getCurrentProcessId();
  if (typeof pid !== 'number' || pid <= 0) throw new Error('unexpected pid: ' + pid);
  console.log('KOFFI_PREFLIGHT_OK pid=' + pid);
})().catch((err) => {
  console.error('KOFFI_PREFLIGHT_FAIL ' + ((err && err.message) || err));
  process.exit(2);
});
