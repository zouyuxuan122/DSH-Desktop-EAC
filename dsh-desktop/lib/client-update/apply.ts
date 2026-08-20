/**
 * lib/client-update/apply.ts — 应用更新（detached 脚本 + 主进程退出）（Task 6.1
 * 自 client-updater.js 提取）。
 *
 * applyUpdate()：写一个纯 ASCII 的 cmd 脚本并以 detached 方式启动，随后
 * 主进程退出。启动方式是整行引用 + /d /s /c：spawn('cmd.exe',
 * ['/c', script, a1, a2]) 让 Node 给每个含空格参数加引号，cmd /c 的
 * 剥引号规则会把首尾引号剥掉，路径在空格处断开 → "'C:\...\Deepseek'
 * is not recognized" 且被 stdio:'ignore' 吞掉 → 脚本静默不执行，
 * 用户点“立即重启”后毫无反应（v2.0.x 反馈）。/s + 外层再包一对引号
 * 剥掉后原样还原为带引号参数行；参数经 Unicode 命令行传递，中文
 * 用户名不受 cmd 文件 ANSI 编码影响：
 *   · 便携版：等旧 exe 解锁 → 备份 → 用新 exe 原地替换 → 重新启动；
 *     若旧 exe 所在目录只读，则退化为直接启动新 exe（保留旧文件）。
 *   · 安装版：固定短等待 → 无条件兜底强杀残留进程（不做 tasklist 轮询
 *     检测，管道在隐藏控制台下偶发挂死）→ 以向导方式启动新 Setup 安装包
 *     （安装器会记录原安装目录并在完成后自动启动新版本）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { isPortable } from './release.js';
import type { ClientUpdCtx } from './types.js';

/** buildApplyScript 的全部入参（路径/版本/运行时）。 */
export interface ApplyScriptParams {
  newExe: string;
  oldExe: string;
  portable: boolean;
  userDataDir: string;
  dshHome: string;
  installDir: string;
  profileDir: string;
  currentVersion: string;
  newVersion: string;
  nodeExe: string;
}

/** applyUpdate 的目录/版本参数（调用方按部署形态提供）。 */
export interface ApplyUpdateOpts {
  userDataDir?: string;
  dshHome?: string;
  installDir?: string;
  profileDir?: string;
  currentVersion?: string;
  newVersion?: string;
  nodeExe?: string;
}

/**
 * 生成 apply-update.cmd 的行内容（纯 ASCII，join('\r\n') 后落盘）。
 *
 * issue #8 回归约束（对应 test/client-updater-apply.test.mjs）：
 *   1. 安装版分支：不得用 tasklist|find 管道轮询旧进程（detached 隐藏控制台
 *      下偶发挂死，用户看到黑窗卡住、Setup 永不执行）；也不得有无界等待。
 *      改为固定短等待（ping）→ 无条件 taskkill /F /T 兜底强杀 → 运行 Setup，
 *      线性推进、总时长有界（主进程 spawn 后约 0.4s 即 app.exit(0)，且
 *      killTreeAndWait 已在 spawn 前等完 dsh web 进程树，检测本是冗余）。
 *   2. 全程写 apply-update.log（与脚本同目录），记录等待/强杀/运行/退出码。
 *   3. Setup 失败：保留安装包与日志供诊断，并拉起旧版应用，用户不被困住。
 *   4. 清理（删安装包+自删）仅在成功路径发生。
 *   5. 便携版分支保留 备份→替换→失败回滚 语义，同样有界等待并写日志。
 */
export function buildApplyScript(p: ApplyScriptParams): string[] {
  const { newExe, oldExe, portable, userDataDir, dshHome, installDir, profileDir, currentVersion, newVersion, nodeExe } = p;
  const lines: string[] = ['@echo off'];
  if (portable) {
    lines.push(
      'set "NEW=%~1"',
      'set "OLD=%~2"',
      'set "LOG=%~dp0apply-update.log"',
      'echo [%date% %time%] portable apply-update start > "%LOG%"',
      'set /a tries=0',
      ':wait',
      'set /a tries+=1',
      'if %tries% gtr 300 goto failed',
      'ping -n 2 127.0.0.1 >nul',
      'if not exist "%OLD%" goto replace',
      'copy /y "%OLD%" "%OLD%.bak" >nul 2>&1',
      'if errorlevel 1 goto wait',
      'del /f /q "%OLD%" >nul 2>&1',
      'if exist "%OLD%" goto wait',
      ':replace',
      'echo [%date% %time%] replacing portable exe >> "%LOG%"',
      'copy /y "%NEW%" "%OLD%" >nul 2>&1',
      'if errorlevel 1 goto failed',
      'del "%NEW%" >nul 2>&1',
      // V4.1 更新保障③：成功路径也保留 %OLD%.bak（上一版 exe）并落 marker。
      // 新版若崩溃（run-state 非干净退出 + marker 存在），下次启动自动回退。
      // 新版健康启动后由主进程清理（cleanupClientBackupIfHealthy）。
      'if exist "%OLD%.bak" copy /y "%OLD%" "%OLD%.crash" >nul 2>&1',
      'start "" "%OLD%"',
      'echo updated %date% %time% > "%OLD%.bak.marker"',
      'del "%~f0" >nul 2>&1',
      'exit /b 0',
      ':failed',
      'echo [%date% %time%] portable update failed, restoring >> "%LOG%"',
      // M3 修复：超时后先尽力复制回原位再启动，避免便携版从 updates 目录
      // 直接启动导致新建 data 目录、丢失设置。
      'if exist "%OLD%.bak" copy /y "%OLD%.bak" "%OLD%" >nul 2>&1',
      'if not exist "%OLD%" copy /y "%NEW%" "%OLD%" >nul 2>&1',
      'if exist "%OLD%" (start "" "%OLD%") else (start "" "%NEW%")',
      'if exist "%OLD%.bak" del "%OLD%.bak" >nul 2>&1',
      'del "%~f0" >nul 2>&1',
      'exit /b 0',
    );
  } else {
    // 安装版：不做进程检测。主进程 spawn 本脚本约 0.4s 后 app.exit(0)，
    // 且 spawn 前 killTreeAndWait 已等完 dsh web 进程树，单实例锁保证没有
    // 其他实例 —— 检测是冗余保险，而 tasklist|find 管道在 detached 隐藏
    // 控制台下偶发挂死（黑窗反馈的根源）。固定短等待给主进程留优雅退出
    // 时间，然后无条件兜底强杀（正常情况下进程已不在，taskkill 记一条
    // not found 到日志即通过），线性推进到 Setup，全程无管道无循环。
    //
    // V4.3 增量更新 PR（独有价值保留）：
    //   1) 备份 4 目录（userData / dshHome / profile / installDir）到
    //      <userData>/backups/<unix-ts>/ ，同时从注册表查询 InstallLocation
    //      并与实际 installDir 对比，两者都写入 manifest.json（安装目录被
    //      用户手动移动过时，备份/回滚以实际路径为准，注册表值仅记录）。
    //   2) Setup 调用添加 /S：oneClick: false 下 NSIS 静默走完所有步骤到原
    //      路径（读注册表 InstallLocation）。
    //   3) 成功路径写 <userData>/updates/.backup-ts marker（内容就是时间戳），
    //      新版健康启动后主进程 cleanupClientBackupIfHealthy →
    //      offerBackupCleanupConfirm 询问是否清理备份（保留 24h，超过不自动弹）。
    //   4) 失败路径：从备份目录反向 robocopy /MIR 回 4 目录，再拉起旧版。
    //   5) manifest.json 的内联 JS 用「应用自带 node」执行（第 10 参传入，
    //      打包在 resources\node\node.exe）：目标用户机器普遍没有系统 Node，
    //      裸调 PATH 上的 node 会 errorlevel 9009 → BAD=2 → 更新永远中止
    //      回滚（更新死循环，v3.0.1 自举陷阱同类）。nodeExe 缺失/不存在时
    //      降级 SKIP_BACKUP（回到 v4.3 无备份语义），绝不依赖 PATH。
    lines.push(
      'set "SETUP=%~1"',
      'set "EXENAME=%~2"',
      'set "OLD=%~3"',
      'set "UD=%~4"',
      'set "DSH=%~5"',
      'set "INST=%~6"',
      'set "PROF=%~7"',
      'set "OLDVER=%~8"',
      'set "NEWVER=%~9"',
      // nodeExe 不能经命令行传：batch 直接引用只到 %9（`%~10` 被解析成
      // `%~1` 后跟字面量 `0`，实测 NODEEXE 接成 "<第1参>0" → 备份被静默
      // 跳过）。曾怀疑 shift 接第 10 参导致脚本静默死亡 —— 2x2 矩阵探针
      // （shift × 结尾 CRLF，每组 8 轮真实 e2e）证明 shift 无辜，全部
      // 32/32 通过；当年的「死亡」是探针自身缺陷（临时目录删除后才断言、
      // 日志读错路径等）。仍选内联：无参数位数限制、零解析层不确定性，
      // `%` 转义为 `%%` 防止变量展开破坏路径。
      `set "NODEEXE=${String(nodeExe || '').replace(/%/g, '%%')}"`,
      'set "LOG=%~dp0apply-update.log"',
      'echo [%date% %time%] apply-update start > "%LOG%"',
      'echo [%date% %time%] oldVer=%OLDVER% newVer=%NEWVER% >> "%LOG%"',
      'echo [%date% %time%] userData=%UD% >> "%LOG%"',
      'echo [%date% %time%] dsh=%DSH% >> "%LOG%"',
      'echo [%date% %time%] install=%INST% >> "%LOG%"',
      'echo [%date% %time%] profile=%PROF% >> "%LOG%"',
      // --- 关键路径是否齐全：只要有一个为空就跳过备份（单测/开发回退到原语义）---
      'set "SKIP_BACKUP=0"',
      'if "%UD%"=="" set SKIP_BACKUP=1',
      'if "%DSH%"=="" set SKIP_BACKUP=1',
      'if "%INST%"=="" set SKIP_BACKUP=1',
      'if "%PROF%"=="" set SKIP_BACKUP=1',
      'if "%NODEEXE%"=="" set SKIP_BACKUP=1',
      'if not exist "%NODEEXE%" set SKIP_BACKUP=1',
      'if "%SKIP_BACKUP%"=="1" echo [%date% %time%] WARN: one of UD/DSH/INST/PROF/NODEEXE empty or missing, skipping backup (fallback semantics) >> "%LOG%"',
      'ping -n 4 127.0.0.1 >nul',
      'echo [%date% %time%] force-killing leftover app processes >> "%LOG%"',
      'taskkill /F /T /IM "%EXENAME%" >> "%LOG%" 2>&1',
      'ping -n 2 127.0.0.1 >nul',
      // --- 阶段 0：查注册表 InstallLocation（供 manifest 对比，不影响实际动作）---
      'if "%SKIP_BACKUP%"=="0" set "REG_INST="',
      'if "%SKIP_BACKUP%"=="0" for /f "tokens=2*" %%a in (\'reg query "HKCU\\Software\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKLM\\Software\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKCU\\Software\\WOW6432Node\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" if not defined REG_INST for /f "tokens=2*" %%a in (\'reg query "HKLM\\Software\\WOW6432Node\\Deepseek Harness EAC" /v InstallLocation 2^>nul ^| findstr /i InstallLocation\') do set "REG_INST=%%b"',
      'if "%SKIP_BACKUP%"=="0" echo [%date% %time%] InstallLocation(registry)=%REG_INST% >> "%LOG%"',
      'if "%SKIP_BACKUP%"=="0" if /i not "%REG_INST%" == "" if /i not "%REG_INST%" == "%INST%" echo [%date% %time%] WARN: InstallLocation registry vs actual mismatch (backup/rollback use actual path) >> "%LOG%"',
      // --- 阶段 1：生成时间戳 + 建备份根目录 ---
      'if "%SKIP_BACKUP%"=="0" set "TS="',
      'if "%SKIP_BACKUP%"=="0" for /f %%t in (\'powershell -NoProfile -Command "[DateTimeOffset]::Now.ToUnixTimeSeconds()" 2^>nul\') do set "TS=%%t"',
      'if "%SKIP_BACKUP%"=="0" if not defined TS set "TS=%date:~-10,4%%date:~-5,2%%date:~-2,2%%time:~0,2%%time:~3,2%%time:~6,2%"',
      'if "%SKIP_BACKUP%"=="0" set "TS=%TS: =0%"',
      'if "%SKIP_BACKUP%"=="0" set "BACKUP=%UD%\\backups\\%TS%"',
      'if "%SKIP_BACKUP%"=="0" echo [%date% %time%] backup root=%BACKUP% >> "%LOG%"',
      'if "%SKIP_BACKUP%"=="0" if not exist "%BACKUP%\\." mkdir "%BACKUP%" 2>nul',
      // robocopy 成功码 0..7（0=无复制/1=成功/2=额外文件/3=成功+额外/...7=成功+额外+不匹配），
      // errorlevel>=8 才是失败。/MIR=/E+/PURGE，/R:1 /W:1，不写日志头。
      'if "%SKIP_BACKUP%"=="0" set "BAD=0"',
      // --- 阶段 2a：备份 userData（除 updates/ 自身和 backups/ 自身外都复制）---
      'if "%SKIP_BACKUP%"=="0" if exist "%UD%\\." (',
      '  echo [%date% %time%] backing up userData =%UD% >> "%LOG%"',
      '  robocopy "%UD%" "%BACKUP%\\userdata" /MIR /XD "%UD%\\updates" "%UD%\\backups" "%UD%\\logs" /XF "*.log" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '  if errorlevel 8 set BAD=1',
      ')',
      // --- 阶段 2b：备份 .dsh 目录（不含 sessions/ 大文件与 node_modules/.cache）---
      'if "%SKIP_BACKUP%"=="0" if exist "%DSH%\\." (',
      '  echo [%date% %time%] backing up dsh =%DSH% >> "%LOG%"',
      '  robocopy "%DSH%" "%BACKUP%\\dsh" /MIR /XD "%DSH%\\sessions" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '  if errorlevel 8 set BAD=1',
      ')',
      // --- 阶段 2c：备份 web-desktop profile ---
      'if "%SKIP_BACKUP%"=="0" if exist "%PROF%\\." (',
      '  echo [%date% %time%] backing up profile =%PROF% >> "%LOG%"',
      '  robocopy "%PROF%" "%BACKUP%\\profile" /MIR /XD "%PROF%\\node_modules\\.cache" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '  if errorlevel 8 set BAD=1',
      ')',
      // --- 阶段 2d：备份安装目录（含 exe + resources 等；排除 node_modules/.cache 加速）---
      'if "%SKIP_BACKUP%"=="0" if exist "%INST%\\." (',
      '  echo [%date% %time%] backing up install =%INST% >> "%LOG%"',
      '  robocopy "%INST%" "%BACKUP%\\install" /MIR /XD "%INST%\\resources\\app\\node_modules\\.cache" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '  if errorlevel 8 set BAD=1',
      ')',
      // --- 阶段 3：写 manifest.json（Node 内联，携带版本号 + 路径 + registry 对比 + 回滚指引）---
      'if "%SKIP_BACKUP%"=="0" if "%BAD%" == "0" (',
      '  echo [%date% %time%] writing manifest.json >> "%LOG%"',
      // 注意：node 内联脚本读 process.env.ENV_MAN —— 变量名必须是
      // ENV_MAN（v4.4 实测 PR79 原稿写成 MAN，manifest 阶段 ENOENT: open ''
      // → BAD=2 → 更新中止回滚；此前被 %~10 触发的 SKIP_BACKUP 掩盖）。
      '  set "ENV_MAN=%BACKUP%\\manifest.json"',
      '  set "ENV_TS=%TS%"',
      '  set "ENV_UD=%UD%"',
      '  set "ENV_DSH=%DSH%"',
      '  set "ENV_PROF=%PROF%"',
      '  set "ENV_INST=%INST%"',
      '  set "ENV_REG=%REG_INST%"',
      '  set "ENV_OLD=%OLDVER%"',
      '  set "ENV_NEW=%NEWVER%"',
      '  set "ENV_BACK=%BACKUP%"',
      '  "%NODEEXE%" -e "try{const t=process.env;const fs=require(\'fs\');const p={userData:{src:t.ENV_UD||\'\',backup:pathJoin(t.ENV_BACK,\'userdata\')},dsh:{src:t.ENV_DSH||\'\',backup:pathJoin(t.ENV_BACK,\'dsh\')},profile:{src:t.ENV_PROF||\'\',backup:pathJoin(t.ENV_BACK,\'profile\')},install:{src:t.ENV_INST||\'\',backup:pathJoin(t.ENV_BACK,\'install\')}};function pathJoin(a,b){return require(\'path\').join(String(a||\'\'),String(b||\'\'));}const m={timestamp:Number(t.ENV_TS)||Date.now(),backupTs:String(t.ENV_TS||\'\'),oldVersion:t.ENV_OLD||\'\',newVersion:t.ENV_NEW||\'\',installLocation:{registry:t.ENV_REG||\'\',actual:t.ENV_INST||\'\',match:!!(t.ENV_REG&&t.ENV_INST&&String(t.ENV_REG).toLowerCase().replace(/[\\\\\\/]+$/g,\'\')===String(t.ENV_INST).toLowerCase().replace(/[\\\\\\/]+$/g,\'\'))},paths:p,rollbackGuide:\'4 directories each mirror-copied to the parallel ./userdata ./dsh ./profile ./install subdirs. Robocopy /MIR them back to paths.{userData,dsh,profile,install}.src, then launch OLD executable.\'};fs.writeFileSync(t.ENV_MAN||\'\',JSON.stringify(m,null,2));}catch(e){console.error(e.message);process.exit(1);}" >> "%LOG%" 2>&1',
      '  if errorlevel 1 set BAD=2',
      ')',
      'if "%SKIP_BACKUP%"=="0" if not "%BAD%" == "0" (',
      '  echo [%date% %time%] backup failed with code %BAD%, aborting update >> "%LOG%"',
      '  goto failed',
      ')',
      // --- 阶段 4：启动 NSIS 静默安装（oneClick: false，/S 下走到原路径）---
      'echo [%date% %time%] running setup /S >> "%LOG%"',
      // call 而非 start /wait：隐藏控制台下 start /wait 偶发不返回（实测
      // 子进程已退出、父脚本仍停滞，黑窗卡死的共因）；批处理直接调用另一
      // 个批处理则是 tail-call 语义不返回。call 对 .cmd/.exe 都同步等待、
      // 返回控制权并保留退出码。
      'call "%SETUP%" /S',
      'echo [%date% %time%] setup exit code %errorlevel% >> "%LOG%"',
      'if errorlevel 1 goto failed',
      'goto success',
      ':success',
      // --- 成功：落 .backup-ts marker（新版主进程读取后弹清理确认）；
      // SKIP_BACKUP 时跳过写 marker（没有备份目录要确认）
      'echo [%date% %time%] update applied >> "%LOG%"',
      'if "%SKIP_BACKUP%"=="0" (',
      '  echo [%date% %time%] writing backup-ts marker=%TS% >> "%LOG%"',
      '  if not exist "%UD%\\updates\\." mkdir "%UD%\\updates" 2>nul',
      '  echo %TS% > "%UD%\\updates\\.backup-ts"',
      ')',
      'del "%SETUP%" >nul 2>&1',
      // (goto) 2>nul 先终止批处理上下文，其后的 del/exit 在批处理之外
      // 执行：直接 del 自身再写 exit /b 0 的话，cmd 自删后读不到下一行，
      // 批处理异常终止（退出码 1）。
      '(goto) 2>nul & del "%~f0" >nul 2>&1 & exit /b 0',
      ':failed',
      'echo [%date% %time%] update failed, installer kept for diagnosis >> "%LOG%"',
      // --- 失败：从备份目录反向 robocopy /MIR 回原路径（如果备份已生成）---
      'if "%SKIP_BACKUP%"=="0" if defined TS if exist "%BACKUP%\\manifest.json" (',
      '  echo [%date% %time%] rolling back 4 directories from %BACKUP% >> "%LOG%"',
      '  set "RBAD=0"',
      '  if exist "%BACKUP%\\install\\." (',
      '    robocopy "%BACKUP%\\install" "%INST%" /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '    if errorlevel 8 set RBAD=1',
      '  )',
      '  if exist "%BACKUP%\\dsh\\." (',
      '    robocopy "%BACKUP%\\dsh" "%DSH%" /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '    if errorlevel 8 set RBAD=1',
      '  )',
      '  if exist "%BACKUP%\\profile\\." (',
      '    robocopy "%BACKUP%\\profile" "%PROF%" /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '    if errorlevel 8 set RBAD=1',
      '  )',
      '  if exist "%BACKUP%\\userdata\\." (',
      '    robocopy "%BACKUP%\\userdata" "%UD%" /MIR /XD "%UD%\\updates" "%UD%\\backups" "%UD%\\logs" /XF "*.log" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >> "%LOG%" 2>&1',
      '    if errorlevel 8 set RBAD=1',
      '  )',
      ')',
      // RBAD 判定必须是括号块外的独立语句：块内 %RBAD% 在整块解析期展开
      // （此时 set 尚未执行），恒为空串 → 永远走 else，日志字面就是
      // "rollback partially failed (code "（v4.4 实测）。移出后本行在块
      // 执行完才被解析，%RBAD% 已是 robocopy 的最终值；入口条件与块相同，
      // 块没跑时本行整体跳过。不用 ENABLEDELAYEDEXPANSION —— 它会把
      // 用户路径里的字面 ! 吃掉。与上方 BAD 的判定模式保持一致。
      'if "%SKIP_BACKUP%"=="0" if defined TS if exist "%BACKUP%\\manifest.json" if "%RBAD%"=="0" (echo [%date% %time%] rollback OK >> "%LOG%") else (echo [%date% %time%] rollback partially failed (code %RBAD%) >> "%LOG%")',
      'if not "%OLD%" == "" if exist "%OLD%" start "" "%OLD%"',
      'exit /b 1',
    );
  }
  return lines;
}

/**
 * 构造 spawn cmd.exe 用的整行命令（配合 /d /s /c 与 windowsVerbatimArguments）。
 *
 * 形如：""C:\app dir\apply-update.cmd" "C:\...\Setup.exe" "app.exe""
 * /s 语义下 cmd 剥掉最外层引号对，还原为带引号的标准参数行；脚本本体
 * 里的 %~1/%~2 因此拿到完整路径。中文路径经 Unicode 命令行传递不受影响
 * （实测 if exist 判定通过）。
 */
export function buildSpawnCommandLine(script: string, args: string[]): string {
  return '"' + [script, ...args].map((a) => `"${a}"`).join(' ') + '"';
}

/**
 * 派生分离的更新脚本进程并接管退出（调用后应用应尽快 exit）。
 * 注意：spawn 经 `import { spawn }` 引用 —— 编译产物为模块对象的属性访问，
 * 测试可在 require 本模块前替换 child_process.spawn 拦截（勿改成解构快照）。
 */
export function applyUpdate(
  ctx: ClientUpdCtx,
  pending: { path: string; version?: string },
  opts?: ApplyUpdateOpts,
): string {
  const newExe = pending.path;
  const portable = isPortable();
  const oldExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const exeBase = path.basename(oldExe);
  const script = path.join(ctx.userDataDir, 'updates', 'apply-update.cmd');
  const userDataDir = (opts && opts.userDataDir) || ctx.userDataDir || '';
  const dshHome = (opts && opts.dshHome) || process.env.DSH_HOME || '';
  const installDir = (opts && opts.installDir) || path.dirname(oldExe);
  const profileDir = (opts && opts.profileDir) || '';
  const currentVersion = (opts && opts.currentVersion) || '';
  const newVersion = (opts && opts.newVersion) || (pending && pending.version) || '';
  // 应用自带的 node 运行时（打包在 resources\node\node.exe）：manifest.json
  // 的内联 JS 用它执行 —— 用户机器没有系统 Node，绝不能依赖 PATH。
  const nodeExe = (opts && opts.nodeExe) || '';
  const lines = buildApplyScript({
    newExe,
    oldExe,
    portable,
    userDataDir,
    dshHome,
    installDir,
    profileDir,
    currentVersion,
    newVersion,
    nodeExe,
  });
  // 结尾必须带 CRLF：缺行尾的最后一行在 cmd 批解析器里行为不稳定
  // （实测 self-delete 收尾行偶发不被执行）。
  fs.writeFileSync(script, lines.join('\r\n') + '\r\n');
  ctx.log(
    'client-update',
    `启动更新脚本: ${script}（新: ${newExe}，旧: ${oldExe}，备份根: ${userDataDir}\\backups\\<ts>，node: ${nodeExe || '(无，跳过备份)'}）`,
  );
  const args = portable
    ? [newExe, oldExe]
    : [newExe, exeBase, oldExe, userDataDir, dshHome, installDir, profileDir, currentVersion, newVersion];
  const child = spawn('cmd.exe', ['/d', '/s', '/c', buildSpawnCommandLine(script, args)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.unref();
  return script;
}
