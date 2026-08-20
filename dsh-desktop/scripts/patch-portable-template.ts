'use strict';

// 给 electron-builder 的 portable NSIS 模板打补丁，让便携版 exe 跨启动
// 保留解包缓存目录。
//
// 默认行为：解包前与应用退出后各执行一次 RMDir /r $INSTDIR，每次启动都
// 把 app-64.7z（132MB / 约 2.4 万个文件）重新解到 %TEMP%。Defender 对
// 每个新文件扫描，冷启动要花数分钟。
//
// 补丁后行为（unpackDirName 必须是 electron-builder.yml 里的固定字符串）：
//   - 若 %TEMP%\<unpackDirName>\.dsh-portable-version 等于 ${VERSION}
//     且应用 exe 存在，直接运行缓存副本（跳过解包）；
//   - 否则删除、重新解包并写入版本标记；
//   - 应用退出后永不删除缓存。
// 版本号变更即自动失效缓存。

import * as fs from 'node:fs';
import * as path from 'node:path';

function patch(): void {
  const libPackage = require.resolve('app-builder-lib/package.json');
  const template = path.join(path.dirname(libPackage), 'templates', 'nsis', 'portable.nsi');
  let text = fs.readFileSync(template, 'utf8');

  if (text.includes('DSH_PORTABLE_CACHE_PATCH')) {
    console.log('[portable-cache] template already patched:', template);
    return;
  }

  const before = `  RMDir /r $INSTDIR\n  SetOutPath $INSTDIR\n`;
  if (!text.includes(before)) {
    throw new Error('portable.nsi structure changed: missing initial extraction block');
  }
  const cacheCheck = `  ; DSH_PORTABLE_CACHE_PATCH: reuse previous extraction when version marker matches.\n  ClearErrors\n  FileOpen $R1 "$INSTDIR\\.dsh-portable-version" r\n  IfErrors dsh_portable_extract\n  FileClose $R1\n  IfFileExists "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" dsh_portable_has_exe dsh_portable_extract\ndsh_portable_has_exe:\n  FileOpen $R1 "$INSTDIR\\.dsh-portable-version" r\n  FileRead $R1 $R2\n  FileClose $R1\n  StrCmp $R2 "\${VERSION}" dsh_portable_run dsh_portable_extract\ndsh_portable_extract:\n  RMDir /r $INSTDIR\n  SetOutPath $INSTDIR\n`;
  text = text.replace(before, cacheCheck);

  const extractionEnd = `  !endif\n\n  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'\n`;
  if (!text.includes(extractionEnd)) {
    throw new Error('portable.nsi structure changed: missing extraction end block');
  }
  const markerAndRun = `  !endif\n\n  FileOpen $R1 "$INSTDIR\\.dsh-portable-version" w\n  FileWrite $R1 "\${VERSION}"\n  FileClose $R1\n\ndsh_portable_run:\n  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'\n`;
  text = text.replace(extractionEnd, markerAndRun);

  const cleanup = `  SetOutPath $EXEDIR\n\tRMDir /r $INSTDIR\n`;
  if (!text.includes(cleanup)) {
    throw new Error('portable.nsi structure changed: missing final cleanup block');
  }
  text = text.replace(cleanup, `    SetOutPath $EXEDIR\n    ; DSH_PORTABLE_CACHE_PATCH: keep the extracted cache for next launch.\n`);

  fs.writeFileSync(template, text, 'utf8');
  console.log('[portable-cache] patched template:', template);
}

patch();
