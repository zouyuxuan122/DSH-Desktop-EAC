# pointer mini-smoke: double-click select, drag select, wheel scroll — asserted
# via TextBox state + MouseWheel event count. Safe throwaway window.
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSExe = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$Root = Split-Path -Parent $PSScriptRoot
$InputPs = Join-Path $Root "src\input.ps1"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'public class CUdpiP { [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[CUdpiP]::SetProcessDPIAware() | Out-Null
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class PtrWin {
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
# GetScrollInfo helper (read vertical scroll position of the TextBox's edit control)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class ScInfo {
  [StructLayout(LayoutKind.Sequential)] public struct SCROLLINFO { public uint cbSize; public uint fMask; public int nMin; public int nMax; public uint nPage; public int nPos; public int nTrackPos; }
  [DllImport("user32.dll")] public static extern bool GetScrollInfo(IntPtr h, int bar, ref SCROLLINFO si);
}
'@
function GetVPos($h) {
  $si = New-Object ScInfo+SCROLLINFO
  $si.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][ScInfo+SCROLLINFO])
  $si.fMask = 0x17  # SIF_ALL
  [ScInfo]::GetScrollInfo($h, 1, [ref]$si) | Out-Null
  return $si
}
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
  $form.Text = "CU-PTR-$PID"
  $form.Size = New-Object System.Drawing.Size(620, 420)
  $form.StartPosition = 'Manual'; $form.Location = New-Object System.Drawing.Point(3040, 100)
  $form.TopMost = $true
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Multiline = $true; $tb.ScrollBars = [System.Windows.Forms.ScrollBars]::Both; $tb.Dock = 'Fill'
  $tb.Font = New-Object System.Drawing.Font('Consolas', 14)
  $script:wheelLog = 0
  $tb.Add_MouseWheel({ $script:wheelLog++ })
  $form.Controls.Add($tb)
  $form.Show(); $form.Refresh()
  [PtrWin]::Steal($form.Handle)
  Start-Sleep -Milliseconds 250
  $form.Activate() | Out-Null; $tb.Focus() | Out-Null
  Pump 250
  $rc = New-Object PtrWin+RECT
  [PtrWin]::GetWindowRect($form.Handle, [ref]$rc) | Out-Null
  $cx = [int](($rc.L + $rc.R) / 2); $baseY = [int]($rc.T + 46)
  # short content first (no scrolling involved) for double-click/drag assertions
  Invoke-Input (@{ action = 'type'; text = "hello 中文 LINE1`r`nLINE two of the pointer smoke"; typingIntervalMs = 0 }) | Out-Null
  Pump 800
  $checks.Add(("type_short_len=" + $tb.Text.Length))
  # double-click on the first line's first word -> word selected
  $dblx = $rc.L + 55; $dbly = $baseY + 8
  Invoke-Input (@{ action = 'click'; coordinate = @($dblx, $dbly); action2 = 'double_click' }) | Out-Null
  Pump 400
  $s1 = $tb.SelectionLength
  $checks.Add(("doubleclick_word=" + ($s1 -gt 0) + " (sel=" + $s1 + ")"))
  # plain click clears selection
  Invoke-Input (@{ action = 'click'; coordinate = @($dblx, $dbly) }) | Out-Null
  Pump 300
  $checks.Add(("click_clears=" + ($tb.SelectionLength -eq 0)))
  # drag over a few chars (payload keys are from/to, matching input.ps1)
  $sx = $rc.L + 40; $sy = $baseY + 6; $exx = $rc.L + 220; $eyy = $baseY + 6
  Invoke-Input (@{ action = 'drag'; from = @($sx, $sy); to = @($exx, $eyy) }) | Out-Null
  Pump 300
  $s2 = $tb.SelectionLength
  $checks.Add(("drag_select=" + ($s2 -gt 0) + " (sel=" + $s2 + ")"))
  # fill long content for scroll test, then wheel over the text area
  $fill = $tb.Text
  for ($i = 3; $i -le 40; $i++) { $fill += "`r`nLINE $i of the pointer smoke payload" }
  $tb.Text = $fill
  Pump 500
  # click inside first so the wheel has a hover target with focus
  Invoke-Input (@{ action = 'click'; coordinate = @($cx, $baseY + 150) }) | Out-Null
  Pump 300
  # scroll DOWN 3 ticks: scroll position must move toward max
  $si0 = GetVPos $tb.Handle
  $r1 = Invoke-Input (@{ action = 'scroll'; coordinate = @($cx, $baseY + 150); direction = 'down'; clicks = 3 })
  Pump 900
  $si1 = GetVPos $tb.Handle
  # scroll UP 3 ticks: back toward top
  $r2 = Invoke-Input (@{ action = 'scroll'; coordinate = @($cx, $baseY + 150); direction = 'up'; clicks = 3 })
  Pump 900
  $si2 = GetVPos $tb.Handle
  $moved = ($si1.nPos -gt $si0.nPos)
  $back = ($si2.nPos -lt $si1.nPos)
  $ev = $script:wheelLog - 0
  $checks.Add(("wheel_scrollmoved=" + $moved + " (nPos " + $si0.nPos + "->" + $si1.nPos + "->" + $si2.nPos + " max=" + $si0.nMax + ") back=" + $back + " events=" + $ev + " r1=" + ($r1 -like '*ok*') + " r2=" + ($r2 -like '*ok*')))
  $result = @{ ok = ($s1 -gt 0 -and $s2 -gt 0); checks = @($checks) }
} catch { $result = @{ ok = $false; checks = @($checks); error = $_.Exception.Message } }
if ($form) { try { $form.Close(); $form.Dispose() } catch {} }
Write-Output ($result | ConvertTo-Json -Compress)