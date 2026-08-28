# computer-user / scripts/smoke-exec.ps1 — full safe-window smoke: type (CJK) +
# keypress chords + double-click + drag-select + mouse-wheel scroll, asserting
# each effect by reading back the WinForms TextBox state. All inside a throwaway
# window; nothing else on screen is touched.
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
public class ExecWin {
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
$form = $null
try {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "CU-EXEC-$PID"
  $form.Size = New-Object System.Drawing.Size(620, 460)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Location = New-Object System.Drawing.Point(3060, 90)
  $form.TopMost = $true
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Multiline = $true; $tb.ScrollBars = [System.Windows.Forms.ScrollBars]::Both; $tb.Dock = 'Fill'
  $tb.Font = New-Object System.Drawing.Font('Consolas', 14)
  $wheelLog = 0
  $tb.Add_MouseWheel({ $script:wheelLog++ })
  $form.Controls.Add($tb)
  $form.Show(); $form.Refresh()
  [ExecWin]::Steal($form.Handle)
  Start-Sleep -Milliseconds 250
  $form.Activate() | Out-Null; $tb.Focus() | Out-Null
  Pump 200
  $rc = New-Object ExecWin+RECT
  [ExecWin]::GetWindowRect($form.Handle, [ref]$rc) | Out-Null
  $w = $rc.R - $rc.L; $h = $rc.B - $rc.T
  $borderY = 38  # title bar + padding estimate
  # --- 1) click to focus + type text ---
  $cx = [int]($rc.L + $w * 0.5); $cy = [int]($rc.T + $borderY + 12)
  Invoke-Input (@{ action = 'click'; coordinate = @($cx, $cy) }) | Out-Null
  Pump 300
  Invoke-Input (@{ action = 'type'; text = $Text; typingIntervalMs = 5 }) | Out-Null
  Pump 800
  $norm = { param($s) ([string]$s).Replace("`r", "") }
  $checks.Add(("typeCJK_match=" + ($( & $norm $tb.Text) -eq $( & $norm $Text))))
  $len = $tb.Text.Length
  # --- 2) keypress ctrl+a selects all ---
  Invoke-Input (@{ action = 'keypress'; keys = @('ctrl', 'a') }) | Out-Null
  Pump 300
  $checks.Add(("keypress_ctrlA_selectAll=" + ($tb.SelectionLength -eq $len) + " (sel=" + $tb.SelectionLength + "/" + $len + ")"))
  # --- 3) double click on first line selects a word ---
  Invoke-Input (@{ action = 'click'; coordinate = @($cx, $cy + 16); action2 = 'double_click' }) | Out-Null
  Pump 300
  $checks.Add(("doubleClick_selects=" + (($tb.SelectionLength -gt 0) -and ($tb.SelectionLength -lt $len)) + " (sel=" + $tb.SelectionLength + ")"))
  # --- 4) drag from line1 to mid -> selection grows ---
  $sx = $rc.L + 6; $sy = $cy + 2; $emx = $cx + 160; $emy = $cy + 14
  Invoke-Input (@{ action = 'drag'; start_coordinate = @($sx, $sy); end_coordinate = @($emx, $emy) }) | Out-Null
  Pump 300
  $checks.Add(("drag_selects=" + ($tb.SelectionLength -gt 0) + " (sel=" + $tb.SelectionLength + ")"))
  # --- 5) wheel scroll over the text area (needs content overflow) ---
  $before = $script:wheelLog
  Invoke-Input (@{ action = 'scroll'; coordinate = @($cx, $cy + 60); direction = 'down'; clicks = 2 }) | Out-Null
  Invoke-Input (@{ action = 'scroll'; coordinate = @($cx, $cy + 60); direction = 'up'; clicks = 2 }) | Out-Null
  Pump 500
  $checks.Add(("wheel_received=" + (($script:wheelLog - $before) -gt 0) + " (events=" + ($script:wheelLog - $before) + ")"))
  # --- 6) right click does not throw ---
  $rr = Invoke-Input (@{ action = 'click'; coordinate = @($cx, $cy + 16); action2 = 'right_click' })
  Pump 300
  $checks.Add(("rightClick_ok=" + ($rr -like '*ok*')))
  # --- capture for OCR (text must be visible on screen) ---
  $png = Join-Path (Join-Path $Root "tests\_artifacts") "exec-text.png"
  $cap = Join-Path $Root "src\capture.ps1"
  $cb = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ outPath = $png; scale = 1 } | ConvertTo-Json -Compress)))
  & $PSExe -NoProfile -ExecutionPolicy Bypass -File $cap -Json $cb | Out-Null
  $ok = ($tb.Text -eq $Text)
  $result = @{ ok = $ok; checks = @($checks); png = $png }
} catch {
  $result = @{ ok = $false; checks = @($checks); error = $_.Exception.Message }
}
if ($form) { try { $form.Close(); $form.Dispose() } catch {} }
Write-Output ($result | ConvertTo-Json -Compress)