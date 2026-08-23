# computer-user / scripts/smoke-cmd-wheel.ps1 — verify WHEEL actually scrolls a
# real console app (cmd.exe). Generates 50 lines, screenshots before, scrolls
# down/up at the console center, screenshots after, then closes with exit.
param([string]$PngA = "", [string]$PngB = "", [string]$PngC = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSExe = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$Root = Split-Path -Parent $PSScriptRoot
$InputPs = Join-Path $Root "src\input.ps1"
$art = Join-Path (Join-Path $Root "tests\_artifacts") ""
if ([string]::IsNullOrWhiteSpace($PngA)) { $PngA = $art + "wheel-a.png" }
if ([string]::IsNullOrWhiteSpace($PngB)) { $PngB = $art + "wheel-b.png" }
if ([string]::IsNullOrWhiteSpace($PngC)) { $PngC = $art + "wheel-c.png" }

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class CwWin {
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
Add-Type -TypeDefinition 'public class CUdpiC { [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[CUdpiC]::SetProcessDPIAware() | Out-Null
function Invoke-Input($payload) {
  $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress)))
  $r = & $PSExe -NoProfile -ExecutionPolicy Bypass -File $InputPs -Json $b 2>&1
  return ($r -join "`n")
}
function Shot($png) {
  $cap = Join-Path $Root "src\capture.ps1"
  $cb = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ outPath = $png; scale = 1 } | ConvertTo-Json -Compress)))
  & $PSExe -NoProfile -ExecutionPolicy Bypass -File $cap -Json $cb | Out-Null
}
$result = @{ ok = $false }
$proc = $null
try {
  $proc = Start-Process -FilePath "cmd.exe" -PassThru
  $hwnd = [IntPtr]::Zero
  for ($i = 0; $i -lt 20 -and $hwnd -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 300; $proc.Refresh(); $hwnd = $proc.MainWindowHandle }
  if ($hwnd -eq [IntPtr]::Zero) { throw "no cmd handle" }
  [CwWin]::Steal($hwnd)
  Start-Sleep -Milliseconds 300
  $rc = New-Object CwWin+RECT
  [CwWin]::GetWindowRect($hwnd, [ref]$rc) | Out-Null
  $cx = [int](($rc.L + $rc.R) / 2); $cy = [int](($rc.T + $rc.B) * 0.5)
  $wx = [int]$cx; $wy = [int]$cy - 40
  Invoke-Input (@{ action = 'click'; coordinate = @($wx, $wy) }) | Out-Null
  Start-Sleep -Milliseconds 250
  # generate 50 lines
  Invoke-Input (@{ action = 'type'; text = "for /l %i in (1,1,50) do echo LINE%i"; sendEnter = $true }) | Out-Null
  Start-Sleep -Milliseconds 1500
  Shot $PngA
  # scroll down 6 ticks
  $r1 = Invoke-Input (@{ action = 'scroll'; coordinate = @($wx, $wy); direction = 'down'; clicks = 6 })
  Start-Sleep -Milliseconds 700
  Shot $PngB
  $r2 = Invoke-Input (@{ action = 'scroll'; coordinate = @($wx, $wy); direction = 'up'; clicks = 6 })
  Start-Sleep -Milliseconds 700
  Shot $PngC
  # close
  [CwWin]::Steal($hwnd); Start-Sleep -Milliseconds 150
  Invoke-Input (@{ action = 'type'; text = "exit"; sendEnter = $true }) | Out-Null
  Start-Sleep -Milliseconds 700
  $proc.Refresh()
  $result = @{ ok = $true; a = $PngA; b = $PngB; c = $PngC; r1 = ($r1 -join "`n"); r2 = ($r2 -join "`n"); stillAlive = (-not $proc.HasExited) }
} catch {
  $result.error = $_.Exception.Message
  if ($proc) { try { $proc.Kill() } catch {} }
}
Write-Output ($result | ConvertTo-Json -Compress)