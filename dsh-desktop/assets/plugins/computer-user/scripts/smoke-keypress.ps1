# keypress mini-smoke: type "zzz", Home+insert HEAD, End+insert TAIL — proves key
# chords/navigation keys really drive the focused control. Safe throwaway window.
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSExe = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$Root = Split-Path -Parent $PSScriptRoot
$InputPs = Join-Path $Root "src\input.ps1"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'public class CUdpiK { [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[CUdpiK]::SetProcessDPIAware() | Out-Null
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class KpWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  public static int FgTid() { uint p; return (int)GetWindowThreadProcessId(GetForegroundWindow(), out p); }
  public static void Steal(IntPtr hwnd) { int f = FgTid(); uint m = GetCurrentThreadId(); AttachThreadInput(m, (uint)f, true); try { SetForegroundWindow(hwnd); } finally { AttachThreadInput(m, (uint)f, false); } }
}
'@
function Pump($ms) { $sw = [System.Diagnostics.Stopwatch]::StartNew(); while ($sw.ElapsedMilliseconds -lt $ms) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 8 } }
function Invoke-Input($payload) {
  $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress)))
  $r = & $PSExe -NoProfile -ExecutionPolicy Bypass -File $InputPs -Json $b 2>&1
  return ($r -join "`n")
}
$checks = [System.Collections.Generic.List[string]]::new()
$form = $null
try {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "CU-KP-$PID"
  $form.Size = New-Object System.Drawing.Size(520, 240)
  $form.StartPosition = 'Manual'; $form.Location = New-Object System.Drawing.Point(3060, 110)
  $form.TopMost = $true
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Multiline = $true; $tb.Dock = 'Fill'; $tb.Font = New-Object System.Drawing.Font('Consolas', 16)
  $form.Controls.Add($tb)
  $form.Show(); $form.Refresh()
  [KpWin]::Steal($form.Handle)
  Start-Sleep -Milliseconds 250
  $form.Activate() | Out-Null; $tb.Focus() | Out-Null
  Pump 250
  Invoke-Input (@{ action = 'click'; coordinate = @(3200, 200) }) | Out-Null   # roughly inside the TextBox
  Pump 300
  Invoke-Input (@{ action = 'type'; text = 'zzz'; typingIntervalMs = 0 }) | Out-Null
  Pump 300
  $checks.Add(("type_baseline=" + ($tb.Text -eq 'zzz')))
  Invoke-Input (@{ action = 'keypress'; keys = @('home') }) | Out-Null
  Pump 200
  Invoke-Input (@{ action = 'type'; text = 'HEAD'; typingIntervalMs = 0 }) | Out-Null
  Pump 300
  $checks.Add(("home_insert_prefix=" + $tb.Text.StartsWith('HEAD')))
  Invoke-Input (@{ action = 'keypress'; keys = @('end') }) | Out-Null
  Pump 200
  Invoke-Input (@{ action = 'type'; text = 'TAIL'; typingIntervalMs = 0 }) | Out-Null
  Pump 300
  $checks.Add(("end_insert_suffix=" + $tb.Text.EndsWith('TAIL')))
  Invoke-Input (@{ action = 'keypress'; keys = @('ctrl', 'a') }) | Out-Null
  Pump 200
  $checks.Add(("ctrl_a_noerror=executed"))
  $result = @{ ok = $true; text = $tb.Text; checks = @($checks) }
} catch { $result = @{ ok = $false; checks = @($checks); error = $_.Exception.Message } }
if ($form) { try { $form.Close(); $form.Dispose() } catch {} }
Write-Output ($result | ConvertTo-Json -Compress)