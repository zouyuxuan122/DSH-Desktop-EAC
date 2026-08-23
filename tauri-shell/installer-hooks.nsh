; Deepseek Harness EAC — Tauri NSIS 安装钩子。
; 职责：
;   1. Electron → Tauri 无缝接管（v5.0 切换）：检测旧 Electron 壳卸载键，
;      静默卸载旧版再安装 —— 同安装目录、同快捷方式名，用户数据
;      （%APPDATA%\Deepseek Harness EAC 与 ~/.dsh）不受影响。
;      R6 实测修正：electron-builder NSIS 的卸载键名 = **productName**
;      （"Deepseek Harness EAC"），不是应用 identifier（com.deepseek.dsh.desktop）。
;      两个候选键都探测，存在即处理。
;   2. 防御注册表脏值：
;      a) InstallLocation 内嵌引号会炸批处理解析 —— 读取后剥引号再使用。
;      b) UninstallString 指向已删除的卸载器（本机实测脏键：指向不存在的
;         D:\Deepseek Harness EACeac\uninstall.exe）—— 文件不存在时跳过
;         ExecWait，只清注册表键，避免静默安装被无效路径卡死。
;      c) R6 复核实锤（mock 卸载器 + 最小安装器 A/B 对照）：ExecWait 必须用
;         剥过引号的 $3 作程序路径 —— 原实现内嵌原始 $0，真实键值带整串引号时
;         展开成 ""path" 导致 spawn 静默失败；_?= 必须裸写 —— NSIS 卸载器原样
;         取命令行剩余串当目录，带引号反而失效（实测退出码 2、零删除），
;         含空格目录无需引号；尾反斜杠先剥防边界歧义。

!macro DSH_TakeoverOldShell KEYNAME
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${KEYNAME}" "UninstallString"
  ${If} $0 != ""
    ; UninstallString 常带整串引号：剥掉再判存。
    StrCpy $3 $0
    StrCpy $4 $3 1
    ${If} $4 == '"'
      StrCpy $3 $3 "" 1
      StrCpy $3 $3 -1
    ${EndIf}
    ; InstallLocation 剥引号防御（_?= 需要目录路径）。
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${KEYNAME}" "InstallLocation"
    ${If} $1 != ""
      StrCpy $2 $1 1
      ${If} $2 == '"'
        StrCpy $1 $1 "" 1
        StrCpy $1 $1 -1
      ${EndIf}
      ; 尾反斜杠在带引号命令行里会转义收尾引号，先剥掉（盘符根除外）。
      StrLen $2 $1
      ${If} $2 > 3
        StrCpy $2 $1 1 -1
        ${If} $2 == '\'
          StrCpy $1 $1 -1
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$3"
      DetailPrint "DSH EAC: 检测到旧壳（${KEYNAME}），静默卸载以接管安装（数据不受影响）"
      ; 程序路径必须用剥过引号的 $3：内嵌原始 $0 展开成 ""path" 会导致
      ; spawn 失败（R6 实测复现）。_?= 必须裸写不加引号：NSIS 卸载器原样
      ; 取命令行剩余串当安装目录，带引号会内嵌字面 " 而静默失效（实测退出码 2、
      ; 零删除）；也正因原样取剩余，含空格目录无需引号（官方文档示例 _?=$INSTDIR）。
      ExecWait '"$3" /S _?=$1' $R0
      DetailPrint "DSH EAC: 旧壳卸载退出码 $R0"
    ${Else}
      DetailPrint "DSH EAC: 旧壳卸载键为脏值（卸载器缺失），仅清理注册表"
    ${EndIf}
    ; 卸载器自删后键可能残留，兜底清理。
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${KEYNAME}"
  ${EndIf}
!macroend

;   3. 升级/接管前结束运行中的应用进程树（用户实测反馈：安装时报
;      「不能打开要写入的文件: ...\dsh-pet\assets\thumb\东张西望.webm」——
;      旧壳运行中（宠物动画等资源被占用）时，卸载与解压都会撞锁）。
;      taskkill /T 按镜像名整树终结（node sidecar / dsh web 均为子孙进程，
;      一并结束释放句柄）；进程不存在时退出码非零，属预期，不视为失败。

!macro DSH_KillAppExe EXENAME
  DetailPrint "DSH EAC: 结束运行中的 ${EXENAME} 进程树（升级需独占安装文件）"
  nsExec::ExecToLog 'taskkill /F /T /IM "${EXENAME}"'
  Pop $R1
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; 先杀进程再接管：旧壳运行中时其卸载器删不动被占用文件，宠物插件
  ; webm 等资源锁不释放则解压同样报「不能打开要写入的文件」。
  !insertmacro DSH_KillAppExe "dsh-eac-shell.exe"
  !insertmacro DSH_KillAppExe "Deepseek Harness EAC.exe"
  ; 句柄异步释放，给文件系统一点缓冲。
  nsExec::ExecToLog 'ping -n 3 -w 500 127.0.0.1'
  Pop $R1
  !insertmacro DSH_TakeoverOldShell "Deepseek Harness EAC"
  !insertmacro DSH_TakeoverOldShell "com.deepseek.dsh.desktop"
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend
