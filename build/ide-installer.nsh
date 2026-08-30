; Deepseek Harness EAC IDE 安装器（NSIS 3.x 独立脚本，非 electron-builder include）
; 由 scripts/build-ide-installer.cjs 调用 makensis 编译：
;   - /DDIST_DIR=<staging> 指向不含 runtime 的安装源（runtime 单独打成 runtime.7z）
; 深路径说明：runtime/ 内含 >260 字符路径（chromium-bidi 等，运行必需），
;   NSIS 无法直接打包 → 安装时用捆绑 7za.exe 解压 runtime.7z；卸载用 PowerShell 递归删除。
Unicode true
Name "Deepseek Harness EAC IDE"
OutFile "dist-ide\Deepseek-Harness-EAC-IDE-Setup-x64.exe"
!define APP_NAME "Deepseek Harness EAC IDE"
!define APP_LAUNCHER "Deepseek Harness EAC IDE.bat"
!define APP_ICO "Deepseek-Harness-EAC-IDE.ico"
!define INSTALL_REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepseekHarnessEACIDE"
!define STARTMENU_FOLDER "Deepseek Harness EAC IDE"
!ifndef RUNTIME_REL
  !define RUNTIME_REL "resources\app\extensions\dsh-eac-vscode\runtime"
!endif

!ifndef DIST_DIR
  !define DIST_DIR "dist-ide\.stage"
!endif

; C 盘空间不足的机器默认装到 D 盘（目录页仍可改）
; 安装器/卸载器自身图标（鲸鱼）
Icon "assets\icon.ico"
UninstallIcon "assets\icon.ico"

InstallDir "D:\Deepseek-Harness-EAC-IDE"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装" SecMain
  SetOutPath "$INSTDIR"
  File /r "${DIST_DIR}\*.*"

  ; 解压 runtime.7z（长路径由 7-Zip 原生支持）
  DetailPrint "正在解压运行时资产（约数十秒）…"
  nsExec::ExecToLog '"$INSTDIR\7za.exe" x "$INSTDIR\runtime.7z" -o"$INSTDIR" -y'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "运行时资产解压失败（错误码 $0）。请重试或改到短路径安装。"
    Abort
  ${EndIf}
  Delete "$INSTDIR\runtime.7z"
  Delete "$INSTDIR\7za.exe"

  ; 开始菜单 + 桌面快捷方式（指向启动器，图标用捆绑的 .ico）
  CreateDirectory "$SMPROGRAMS\${STARTMENU_FOLDER}"
  CreateShortcut "$SMPROGRAMS\${STARTMENU_FOLDER}\${APP_NAME}.lnk" "$INSTDIR\${APP_LAUNCHER}" "" "$INSTDIR\${APP_ICO}"
  CreateShortcut "$SMPROGRAMS\${STARTMENU_FOLDER}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_LAUNCHER}" "" "$INSTDIR\${APP_ICO}"

  ; 卸载注册表（HKCU，用户级安装）
  WriteRegStr HKCU "${INSTALL_REGKEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${INSTALL_REGKEY}" "DisplayIcon" "$INSTDIR\${APP_ICO}"
  WriteRegStr HKCU "${INSTALL_REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${INSTALL_REGKEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${INSTALL_REGKEY}" "DisplayVersion" "4.6.0"
  WriteRegStr HKCU "${INSTALL_REGKEY}" "Publisher" "zouyuxuan122"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  ; 先杀运行中的 IDE 进程（Windows 文件锁会阻碍删除）
  nsExec::Exec 'taskkill /F /T /IM "Code.exe"'
  nsExec::Exec 'taskkill /F /T /IM "dsh-eac-ide.exe"'

  ; 深路径树用 PowerShell 递归删除（无 260 字符限制）
  nsExec::ExecToLog 'powershell -NoProfile -Command "Remove-Item -LiteralPath \"$INSTDIR\${RUNTIME_REL}\" -Recurse -Force -ErrorAction SilentlyContinue"'

  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\${STARTMENU_FOLDER}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${STARTMENU_FOLDER}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${STARTMENU_FOLDER}"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  DeleteRegKey HKCU "${INSTALL_REGKEY}"
  ; 注意：%APPDATA%\Deepseek-Harness-EAC-IDE 与 ~/.dsh-v4lite 用户数据保留不删（与桌面版约定一致）
SectionEnd
