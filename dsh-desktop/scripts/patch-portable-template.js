'use strict';

// Patch electron-builder's portable NSIS template so the portable exe keeps a
// cached unpack directory across runs.
//
// Default behaviour: RMDir /r $INSTDIR before extraction and after app exit,
// so every launch re-extracts app-64.7z (132MB / ~24k files) into %TEMP%.
// With Defender scanning each new file this makes cold start take minutes.
//
// Patched behaviour (unpackDirName must be a stable string in
// electron-builder.yml):
//   - if %TEMP%\<unpackDirName>\.dsh-portable-version equals ${VERSION}
//     and the app exe exists, run the cached app directly (no extraction);
//   - otherwise delete, re-extract, and write the version marker;
//   - never delete the cache after the app exits.
// A version bump therefore automatically invalidates the cache.

const fs = require('node:fs');
const path = require('node:path');

function patch() {
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
