# computer-user / scripts/smoke-winforms.ps1 — safe-window end-to-end smoke test.
# Opens a throwaway WinForms window (unrelated to the user's apps), focuses its
# TextBox via a real click, types ASCII + CJK text through the real SendInput
# backend (input.ps1), then READS BACK the TextBox.Text to prove the physical
# keyboard events actually landed, and captures a screenshot for OCR verification.
# The window is closed at the end; nothing is left behind.
# The text to type is passed as base64(UTF8) so command-line encoding (ANSI
# codepage conversion in Windows PowerShell 5.1) can never garble CJK text.
param([string]$TextB64 = "", [string]$OutPng = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ([string]::IsNullOrWhiteSpace($TextB64)) {
  $Text = "hello 123!"
} else {
  $Text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextB64))
}
$PSExe = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$Root = Split-Path -Parent $PSScriptRoot
$InputPs = Join-Path $Root "src\input.ps1"

if ([string]::IsNullOrWhiteSpace($OutPng)) {
  $OutPng = Join-Path (Join-Path $Root "tests\_artifacts") "winforms-text.png"
}
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($OutPng)) | Out-Null

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class CUWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  public static int FgTid() { uint p; return (int)GetWindowThreadProcessId(GetForegroundWindow(), out p); }
}
'@
# DPI-aware so screen coords match pixels (same technique as capture.ps1).
Add-Type -TypeDefinition 'public class CUd { [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction SilentlyContinue
[CUd]::SetProcessDPIAware() | Out-Null

function Invoke-Input($payload) {
  $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress)))
  $r = & $PSExe -NoProfile -ExecutionPolicy Bypass -File $InputPs -Json $b 2>&1
  return ($r -join "`n")
}

# Steal foreground to our window: AttachThreadInput to the current foreground
# thread, SetForegroundWindow, detach — works even under Windows foreground
# restrictions because our IL matches the foreground app (Medium).
function Steal-Foreground($hwnd) {
  $fgTid = [CUWin]::FgTid()
  $myTid = [CUWin]::GetCurrentThreadId()
  [CUWin]::AttachThreadInput($myTid, $fgTid, $true) | Out-Null
  try { [CUWin]::SetForegroundWindow($hwnd) | Out-Null } finally { [CUWin]::AttachThreadInput($myTid, $fgTid, $false) | Out-Null }
}

# Form.Show() is non-modal: the script thread must drive the message pump
# manually or no WM_* message ever reaches the controls (PostMessage+SendInput
# both succeed but nothing happens). Pump drains the queue with DoEvents.
function Pump($ms) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $ms) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 8
  }
}

$result = @{ ok = $false }
$form = $null
try {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "CU-SMOKE-$([System.Diagnostics.Process]::GetCurrentProcess().Id)"
  $form.Size = New-Object System.Drawing.Size(560, 240)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  # top-right area of the screen — away from the user's IDE/EAC windows
  $form.Location = New-Object System.Drawing.Point(3080, 120)
  $form.TopMost = $true
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Multiline = $true
  $tb.Dock = [System.Windows.Forms.DockStyle]::Fill
  $tb.Font = New-Object System.Drawing.Font("Consolas", 18)
  $form.Controls.Add($tb)
  $form.Show()
  $form.Refresh()
  $hwnd = $form.Handle
  $form.Activate() | Out-Null
  Steal-Foreground $hwnd
  Start-Sleep -Milliseconds 350
  $rct = New-Object RECT
  [CUWin]::GetWindowRect($hwnd, [ref]$rct) | Out-Null
  $w = $rct.R - $rct.L; $h = $rct.B - $rct.T
  $cx = [int]($rct.L + $w / 2); $cy = [int]($rct.T + $h * 0.55)  # inside the filled TextBox

  # 1) real click to focus the TextBox (also activates the window)
  $click = Invoke-Input (@{ action = 'click'; coordinate = @($cx, $cy) })
  Pump 350
  $tb.Focus() | Out-Null
  # 2) real typing (SendInput) — the actual OS input path
  $typed = Invoke-Input (@{ action = 'type'; text = $Text; typingIntervalMs = 15 })
  Pump 900
  # 3) read back what the TextBox actually received
  $received = $tb.Text

  # 4) capture for OCR verification
  $payloadCap = @{ outPath = $OutPng; scale = 1 }
  $cb = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payloadCap | ConvertTo-Json -Compress)))
  $capPs = Join-Path $Root "src\capture.ps1"
  $shot = & $PSExe -NoProfile -ExecutionPolicy Bypass -File $capPs -Json $cb 2>&1

  # 5) close window
  $form.Close()
  $form.Dispose()
  $result = @{
    ok = ($received -eq $Text)
    hwnd = $hwnd.ToString()
    sentText = $Text
    receivedText = $received
    match = ($received -eq $Text)
    captured = $OutPng
    windowRect = @($rct.L, $rct.T, $rct.R, $rct.B)
    clickResult = ($click -join "`n")
    typeResult = ($typed -join "`n")
  }
} catch {
  $result.error = $_.Exception.Message
  if ($form) { try { $form.Close(); $form.Dispose() } catch {} }
}
Write-Output ($result | ConvertTo-Json -Compress)
