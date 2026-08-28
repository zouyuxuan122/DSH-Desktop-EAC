# computer-user / scripts/smoke-cmd.ps1 — verify real-world typing into a real
# console app (cmd.exe) and capture it for OCR, then close cleanly (exit).
param([string]$OutPng = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSExe = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$Root = Split-Path -Parent $PSScriptRoot
$InputPs = Join-Path $Root "src\input.ps1"
if ([string]::IsNullOrWhiteSpace($OutPng)) { $OutPng = Join-Path (Join-Path $Root "tests\_artifacts") "cmd-verify.png" }
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($OutPng)) | Out-Null

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class CmdWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  public struct RECT { public int L, T, R, B; }
  public static int FgTid() { uint p; return (int)GetWindowThreadProcessId(GetForegroundWindow(), out p); }
  public static void Steal(IntPtr hwnd) { int f = FgTid(); uint m = GetCurrentThreadId(); AttachThreadInput(m, (uint)f, true); try { SetForegroundWindow(hwnd); } finally { AttachThreadInput(m, (uint)f, false); } }
}
'@
function Invoke-Input($payload) {
  $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress)))
  $r = & $PSExe -NoProfile -ExecutionPolicy Bypass -File $InputPs -Json $b 2>&1
  return ($r -join "`n")
}
$marker = "CU-VERIFY-" + [string](Get-Random -Minimum 10000 -Maximum 99999)
$result = @{ ok = $false }
$proc = $null
try {
  $proc = Start-Process -FilePath "cmd.exe" -PassThru
  $hwnd = [IntPtr]::Zero
  for ($i = 0; $i -lt 20 -and $hwnd -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 300; $proc.Refresh(); $hwnd = $proc.MainWindowHandle }
  if ($hwnd -eq [IntPtr]::Zero) { throw "no cmd window handle" }
  [CmdWin]::Steal($hwnd)
  Start-Sleep -Milliseconds 300
  $rc = New-Object CmdWin+RECT
  [CmdWin]::GetWindowRect($hwnd, [ref]$rc) | Out-Null
  $cx = [int](($rc.L + $rc.R) / 2); $cy = [int](($rc.T + $rc.B) * 0.55)
  Invoke-Input (@{ action = 'click'; coordinate = @($cx, $cy) }) | Out-Null
  Start-Sleep -Milliseconds 200
  $t1 = Invoke-Input (@{ action = 'type'; text = "echo $marker"; sendEnter = $true; typingIntervalMs = 10 })
  Start-Sleep -Milliseconds 700
  # capture for OCR
  $cap = Join-Path $Root "src\capture.ps1"
  $cb = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ outPath = $OutPng; scale = 1 } | ConvertTo-Json -Compress)))
  $shot = & $PSExe -NoProfile -ExecutionPolicy Bypass -File $cap -Json $cb 2>&1
  Start-Sleep -Milliseconds 200
  # close cmd cleanly
  [CmdWin]::Steal($hwnd)
  Start-Sleep -Milliseconds 150
  Invoke-Input (@{ action = 'type'; text = "exit"; sendEnter = $true }) | Out-Null
  Start-Sleep -Milliseconds 700
  $proc.Refresh()
  $result = @{ ok = $true; marker = $marker; png = $OutPng; typed = ($t1 -join "`n"); stillAlive = (-not $proc.HasExited) }
} catch {
  $result.error = $_.Exception.Message
  if ($proc) { try { $proc.Kill() } catch {} }
}
Write-Output ($result | ConvertTo-Json -Compress)