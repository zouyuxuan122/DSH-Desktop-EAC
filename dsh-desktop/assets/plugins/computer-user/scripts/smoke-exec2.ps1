# computer-user / scripts/smoke-exec2.ps1 — robust full safe-window smoke with
# per-step try/catch: type(CJK) → keypress navigation (home/end) + insert →
# double-click → drag-select → wheel scroll, each asserted by TextBox state.
param([string]$TextB64 = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSExe = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$Root = Split-Path -Parent $PSScriptRoot
$InputPs = Join-Path $Root "src\input.ps1"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Exec2Win {
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
function Pump($ms) { $sw = [System.Diagnostics.Stopwatch]::StartNew(); while ($sw.ElapsedMilliseconds -lt $ms) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 8 } }
function Norm($s) { return ([string]$s).Replace("`r", "") }
function Invoke-Input($payload) {
  $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress)))
  $r = & $PSExe -NoProfile -ExecutionPolicy Bypass -File $InputPs -Json $b 2>&1
  return ($r -join "`n")
}

if ([string]::IsNullOrWhiteSpace($TextB64)) {
  $Text = "hello 中文 123!"
  for ($i = 2; $i -le 6; $i++) { $Text += "`r`n LINE $i of the smoke payload" }
} else {
  $Text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextB64))
}

$checks = [System.Collections.Generic.List[string]]::new()
$steps = [System.Collections.Generic.List[string]]::new()
$form = $null
$prog = Join-Path (Join-Path $Root "tests\_artifacts") "exec2.progress.log"
function Mark($m) { Add-Content -Path $prog -Value ("{0} {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $m) -Encoding UTF8 }
function Step($name, $body) {
  Mark "STEP $name start"
  try { & $body; Mark "STEP $name done" } catch { $script:steps.Add("$name ERROR: $($_.Exception.Message)"); Mark "STEP $name ERROR: $($_.Exception.Message)" }
}
try {
  Mark "building form"
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "CU-EXEC2-$PID"
  $form.Size = New-Object System.Drawing.Size(640, 480)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Location = New-Object System.Drawing.Point(3040, 80)
  $form.TopMost = $true
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Multiline = $true; $tb.ScrollBars = [System.Windows.Forms.ScrollBars]::Both; $tb.Dock = 'Fill'
  $tb.Font = New-Object System.Drawing.Font('Consolas', 14)
  $script:wheelLog = 0
  $tb.Add_MouseWheel({ $script:wheelLog++ })
  $form.Controls.Add($tb)
  $form.Show(); $form.Refresh()
  [Exec2Win]::Steal($form.Handle)
  Start-Sleep -Milliseconds 250
  $form.Activate() | Out-Null; $tb.Focus() | Out-Null
  Pump 250
  $rc = New-Object Exec2Win+RECT
  [Exec2Win]::GetWindowRect($form.Handle, [ref]$rc) | Out-Null
  $w = $rc.R - $rc.L; $h = $rc.B - $rc.T
  $borderY = 40
  $cx = [int]($rc.L + $w * 0.5); $cy = [int]($rc.T + $borderY + 14)

  Step 'click_focus_type' {
    Invoke-Input (@{ action = 'click'; coordinate = @($cx, $cy) }) | Out-Null
    Pump 300
    Invoke-Input (@{ action = 'type'; text = $Text; typingIntervalMs = 4 }) | Out-Null
    Pump 900
    $got = Norm $tb.Text; $want = Norm $Text
    $checks.Add(("typeCJK_match=" + ($got -eq $want) + " (len " + $got.Length + "/" + $want.Length + ")"))
  }

  Step 'keypress_end_insert' {
    Invoke-Input (@{ action = 'keypress'; keys = @('end') }) | Out-Null
    Pump 200
    Invoke-Input (@{ action = 'type'; text = 'TAIL'; typingIntervalMs = 0 }) | Out-Null
    Pump 300
    $checks.Add(("keypress_end_insert=" + ((Norm $tb.Text).EndsWith('TAIL'))))
  }

  Step 'keypress_home_insert' {
    Invoke-Input (@{ action = 'keypress'; keys = @('home') }) | Out-Null
    Pump 200
    Invoke-Input (@{ action = 'type'; text = 'HEAD'; typingIntervalMs = 0 }) | Out-Null
    Pump 300
    $checks.Add(("keypress_home_insert=" + ((Norm $tb.Text).StartsWith('HEAD'))))
  }

  Step 'doubleclick_select' {
    Invoke-Input (@{ action = 'click'; coordinate = @($cx, $cy + 18); action2 = 'double_click' }) | Out-Null
    Pump 300
    $s = $tb.SelectionLength
    $checks.Add(("doubleclick_select=" + ($s -gt 0) + " (sel=" + $s + ")"))
  }

  Step 'drag_select' {
    $sx = $rc.L + 8; $sy = $cy + 2; $emx = $rc.L + 200; $emy = $cy + 40
    Invoke-Input (@{ action = 'drag'; start_coordinate = @($sx, $sy); end_coordinate = @($emx, $emy) }) | Out-Null
    Pump 300
    $s = $tb.SelectionLength
    $checks.Add(("drag_select=" + ($s -gt 0) + " (sel=" + $s + ")"))
  }

  Step 'wheel_scroll' {
    $before = $script:wheelLog
    Invoke-Input (@{ action = 'scroll'; coordinate = @($cx, $cy + 80); direction = 'down'; clicks = 2 }) | Out-Null
    Invoke-Input (@{ action = 'scroll'; coordinate = @($cx, $cy + 80); direction = 'up'; clicks = 2 }) | Out-Null
    Pump 600
    $ev = $script:wheelLog - $before
    $checks.Add(("wheel_received=" + ($ev -gt 0) + " (events=" + $ev + ")"))
  }

  Step 'rightclick_ok' {
    $rr = Invoke-Input (@{ action = 'click'; coordinate = @($cx, $cy + 18); action2 = 'right_click' })
    Pump 300
    $checks.Add(("rightclick_ok=" + ($rr -like '*ok*')))
  }

  $png = Join-Path (Join-Path $Root "tests\_artifacts") "exec2-text.png"
  Step 'capture' {
    $cap = Join-Path $Root "src\capture.ps1"
    $cb = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ outPath = $png; scale = 1 } | ConvertTo-Json -Compress)))
    & $PSExe -NoProfile -ExecutionPolicy Bypass -File $cap -Json $cb | Out-Null
  }
  $result = @{ ok = $true; checks = @($checks); steps = @($steps); png = $png }
} catch {
  $result = @{ ok = $false; checks = @($checks); steps = @($steps); error = $_.Exception.Message }
}
if ($form) { try { $form.Close(); $form.Dispose() } catch {} }
Write-Output ($result | ConvertTo-Json -Compress)