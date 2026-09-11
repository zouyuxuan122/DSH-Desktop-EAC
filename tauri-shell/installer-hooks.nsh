; Deepseek Harness EAC — Tauri NSIS 安装钩子。
; 职责：
;   1. Electron → Tauri 无缝接管（v5.0 切换）+ Tauri 覆盖升级清理：
;      检测旧壳卸载键（HKCU/HKLM 双 hive），静默卸载旧版再安装 ——
;      同安装目录、同快捷方式名，用户数据（%APPDATA%\Deepseek Harness EAC
;      与 ~/.dsh）不受影响。
;      R6 实测修正：electron-builder NSIS 的卸载键名 = **productName**
;      （"Deepseek Harness EAC"），不是应用 identifier（com.deepseek.dsh.desktop）。
;      三个候选键名都探测（productName、Electron identifier、
;      Tauri identifier），并同时查 HKCU 与 HKLM —— 旧版若曾 perMachine
;      安装（HKLM hive），只查 HKCU 会漏掉 → 已安装列表出现两个版本
;      （issue #224）。
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
;      d) UninstallString 仅整串被一对引号包裹才剥对，`"path" args` 形态保持
;         原值走脏值分支（防剥坏）；e) InstallLocation 为空时跳过 ExecWait
;         （_?= 空目录未定义），只清注册表键。

; 注意：currentUser 安装器对 HKLM 通常只有读权限，删除 HKLM 键会静默失败
; （NSIS DeleteRegKey 无错误返回）。该路径为 best-effort：尽力卸载旧文件并
; 提示，避免「两个版本并存 + 旧条目打开报错」；HKCU 场景才是全覆盖清理。

!macro DSH_TakeoverOldShell HIVE KEYNAME
  ReadRegStr $0 ${HIVE} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${KEYNAME}" "UninstallString"
  ${If} $0 != ""
    ; UninstallString 剥引号（窄修）：仅当整串恰被一对引号包裹（引号总数为 2
    ; 且首尾各一）才整体剥对 —— `"path" args` 形态若沿用旧的「删首字符 + StrCpy
    ; -1 删尾字符」会剥成 `path" arg` 的脏值；此时保持 $0 原值，交给下方
    ; FileExists 脏值分支兜底。NSIS 无内建子串搜索，引号计数用 $R0（工作副本，
    ; 逐字符右移）/ $R1（计数器）实现。
    StrCpy $3 $0
    StrCpy $R0 $0
    StrCpy $R1 0
    ${Do}
      StrCpy $4 $R0 1
      ${If} $4 == '"'
        IntOp $R1 $R1 + 1
      ${EndIf}
      StrCpy $R0 $R0 "" 1
    ${LoopUntil} $R0 == ""
    ${If} $R1 == 2
      StrCpy $4 $3 1
      StrCpy $R0 $3 1 -1
      ${If} $4 == '"'
      ${AndIf} $R0 == '"'
        StrCpy $3 $3 "" 1
        StrCpy $3 $3 -1
      ${EndIf}
    ${EndIf}
    ; InstallLocation 剥引号防御（_?= 需要目录路径）。
    ReadRegStr $1 ${HIVE} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${KEYNAME}" "InstallLocation"
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
      DetailPrint "DSH EAC: 检测到旧壳（${KEYNAME} @ ${HIVE}），静默卸载以接管安装（数据不受影响）"
      ; 程序路径必须用剥过引号的 $3：内嵌原始 $0 展开成 ""path" 会导致
      ; spawn 失败（R6 实测复现）。_?= 必须裸写不加引号：NSIS 卸载器原样
      ; 取命令行剩余串当安装目录，带引号会内嵌字面 " 而静默失效（实测退出码 2、
      ; 零删除）；也正因原样取剩余，含空格目录无需引号（官方文档示例 _?=$INSTDIR）。
      ; $1（InstallLocation）为空时 _?= 空目录行为未定义 —— 跳过卸载器调用，
      ; 只清注册表键（下方 DeleteRegKey 兜底）。
      ${If} $1 == ""
        DetailPrint "DSH EAC: 旧壳 InstallLocation 为空，跳过卸载器调用，仅清理注册表"
      ${Else}
        ExecWait '"$3" /S _?=$1' $R0
        DetailPrint "DSH EAC: 旧壳卸载退出码 $R0"
      ${EndIf}
    ${Else}
      DetailPrint "DSH EAC: 旧壳卸载键为脏值（卸载器缺失），仅清理注册表"
    ${EndIf}
    ; 卸载器自删后键可能残留，兜底清理。
    DeleteRegKey ${HIVE} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${KEYNAME}"
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

;   4. 安装形态选择（v5.4 单发行版双形态）：同一个安装包，安装时选
;      「完整版 / 精简版」。PREINSTALL 弹窗询问（静默安装 /S 默认完整版），
;      POSTINSTALL 把选择写入 $INSTDIR\dsh-desktop\profile.txt；companion-sync
;      启动时读取，精简版仅改变外围插件的「新行默认启停」（用户选择优先，
;      随时可在设置里启用全部）。文件缺失/脏值 = 完整版，永不阻塞启动。
Var DshProfileChoice

!macro DSH_AskInstallProfile
  StrCpy $DshProfileChoice "full"
  ; 本文件禁用任何管道符（installer-nsh-pipe 守护测试）：MessageBox 组合标志
  ; 需要管道符，故只用单一 MB_YESNO，不叠加图标位。
  MessageBox MB_YESNO \
    "请选择要安装的版本：$\n$\n\
    【是】完整版 —— 全部内置插件（多智能体 / 手机桥 / 桌宠等）$\n\
    【否】精简版 —— 精选插件，界面更简洁（后续可在「设置 → 插件 → 管理」$\n\
    一键启用全部功能，无需重装）$\n$\n\
    升级安装会重新询问，用户数据不受影响。" \
    /SD IDYES IDYES dsh_profile_full IDNO dsh_profile_lite
  dsh_profile_full:
    StrCpy $DshProfileChoice "full"
    Goto dsh_profile_done
  dsh_profile_lite:
    StrCpy $DshProfileChoice "lite"
  dsh_profile_done:
!macroend

!macro DSH_WriteProfileMarker
  ClearErrors
  FileOpen $R9 "$INSTDIR\dsh-desktop\profile.txt" w
  ${If} ${Errors}
    DetailPrint "DSH EAC: 写入安装形态标记失败（按默认完整版处理）"
  ${Else}
    FileWrite $R9 "$DshProfileChoice"
    FileClose $R9
    DetailPrint "DSH EAC: 安装形态 = $DshProfileChoice"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; 先杀进程再接管：旧壳运行中时其卸载器删不动被占用文件，宠物插件
  ; webm 等资源锁不释放则解压同样报「不能打开要写入的文件」。
  !insertmacro DSH_KillAppExe "dsh-eac-shell.exe"
  !insertmacro DSH_KillAppExe "Deepseek Harness EAC.exe"
  ; 句柄异步释放，给文件系统一点缓冲（NSIS 原生 Sleep，不产生网络行为）。
  Sleep 2000
  ; 三个候选键名 × HKCU/HKLM 双 hive：覆盖
  ;   - Electron 时代（productName 键 / com.deepseek.dsh.desktop 键，含
  ;     perMachine 安装残留在 HKLM 的情况）；
  ;   - Tauri 自身旧版（productName 键与 com.deepseek.dsh.desktop.tauri 键）。
  ; HKLM 只读/删除失败走 best-effort（currentUser 安装器无提权），
  ; 主路径（per-user 安装）在 HKCU 全覆盖。
  !insertmacro DSH_TakeoverOldShell HKCU "Deepseek Harness EAC"
  !insertmacro DSH_TakeoverOldShell HKCU "com.deepseek.dsh.desktop"
  !insertmacro DSH_TakeoverOldShell HKCU "com.deepseek.dsh.desktop.tauri"
  !insertmacro DSH_TakeoverOldShell HKLM "Deepseek Harness EAC"
  !insertmacro DSH_TakeoverOldShell HKLM "com.deepseek.dsh.desktop"
  !insertmacro DSH_TakeoverOldShell HKLM "com.deepseek.dsh.desktop.tauri"
  ; 不在安装/升级阶段删除 ~/.dsh 下的任何用户数据。退役 dsh-stt 的插件行与
  ; profile 包副本仍由应用内的精确迁移处理；模型缓存可能是 CLI 或其他产品
  ; 共用资产，只能由用户明确确认后单独清理。
  ; 安装形态：解压前询问（精简版/完整版），选择暂存到 $DshProfileChoice。
  !insertmacro DSH_AskInstallProfile
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 资源已解压到 $INSTDIR\dsh-desktop\，覆盖随包默认的 profile.txt（full）。
  !insertmacro DSH_WriteProfileMarker
!macroend