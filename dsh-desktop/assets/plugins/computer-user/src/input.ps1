# computer-user / input.ps1 — mouse & keyboard automation via SendInput.
# DPI-aware (SetProcessDPIAware) so virtual-screen pixel coordinates map to physical pixels.
# Input:  -Json <base64(UTF8 JSON)>
#    { "action": "move|click|rightclick|double|drag|scroll|type|keypress|getpos",
#      "coordinate": [x,y], "from": [x,y], "to": [x,y],
#      "action2": "click|right_click|double_click",
#      "text": string, "sendEnter": bool,
#      "keys": [names], "holdKeys": [names],
#      "direction": "up|down|left|right", "clicks": int,
#      "typingIntervalMs": int }
# Output: stdout JSON { ok, cursor:[x,y], ... } | { ok:false, error }
param([string]$Json = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($msg) { Write-Output (ConvertTo-Json -Compress @{ ok = $false; error = $msg }); exit 2 }
function To-U32([int]$v) { if ($v -lt 0) { return [uint32]($v + 4294967296) }; return [uint32]$v }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CU {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static INPUT K(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; i.U.ki.time = 0; i.U.ki.dwExtraInfo = IntPtr.Zero; return i; }
  public static INPUT M(uint mouseData, uint flags) { INPUT i = new INPUT(); i.type = 0; i.U.mi.dx = 0; i.U.mi.dy = 0; i.U.mi.mouseData = mouseData; i.U.mi.dwFlags = flags; i.U.mi.time = 0; i.U.mi.dwExtraInfo = IntPtr.Zero; return i; }
  public static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Wheel(uint signedDelta) { INPUT[] a = new INPUT[1]; a[0] = M(signedDelta, 0x0800); Send(a); }
  public static void KeyDown(ushort vk) { INPUT[] a = new INPUT[1]; a[0] = K(vk, 0, 0); Send(a); }
  public static void KeyUp(ushort vk)   { INPUT[] a = new INPUT[1]; a[0] = K(vk, 0, 0x0002); Send(a); }
  public static void CharDown(char c)   { INPUT[] a = new INPUT[1]; a[0] = K(0, (ushort)c, 0x0004); Send(a); }
  public static void CharUp(char c)     { INPUT[] a = new INPUT[1]; a[0] = K(0, (ushort)c, 0x0004 | 0x0002); Send(a); }
}
'@ -ErrorAction Stop

# DPI awareness so coordinates = physical pixels.
try { Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class CUdpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction Stop; [CUdpi]::SetProcessDPIAware() | Out-Null } catch {}

if ([string]::IsNullOrWhiteSpace($Json)) { Fail("missing -Json parameter") }
$cfg = $null
try { $cfg = ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json)) | ConvertFrom-Json) } catch { Fail("bad -Json: $($_.Exception.Message)") }
$action = [string]$cfg.action
if ([string]::IsNullOrWhiteSpace($action)) { Fail("action is required") }

$VK = @{
  'ctrl'=0x11; 'control'=0x11; 'shift'=0x10; 'alt'=0x12; 'super'=0x5B; 'meta'=0x5B; 'win'=0x5B; 'cmd'=0x5B;
  'enter'=0x0D; 'return'=0x0D; 'tab'=0x09; 'esc'=0x1B; 'escape'=0x1B; 'space'=0x20; 'backspace'=0x08;
  'delete'=0x2E; 'del'=0x2E; 'insert'=0x2D; 'home'=0x24; 'end'=0x23; 'pageup'=0x21; 'pagedown'=0x22;
  'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27; 'clear'=0x0C;
  'pause'=0x13; 'prtsc'=0x2C; 'printscreen'=0x2C; 'scrolllock'=0x91; 'numlock'=0x90; 'capslock'=0x14;
}
for ($i = 1; $i -le 24; $i++) { $VK["f$i"] = 0x6F + $i }   # F1=0x70
for ($i = 0; $i -lt 26; $i++) { $VK[[char](0x61 + $i)] = 0x41 + $i } # a-z -> A..Z VK
for ($i = 0; $i -lt 10; $i++) { $VK[[string]$i] = 0x30 + $i }        # 0-9

function Get-CursorJson { $p = New-Object CU+POINT; [CU]::GetCursorPos([ref]$p) | Out-Null; return @($p.X, $p.Y) }

function Resolve-Key($name) {
  $n = ([string]$name).Trim().ToLowerInvariant()
  if ($VK.ContainsKey($n)) { return @{ vk = [UInt16]$VK[$n] } }
  # single letters/digits map to VIRTUAL KEYS so they combine with modifiers
  # (ctrl+a must be VK_A, not an injected Unicode 'a' which never triggers shortcuts).
  if ($n.Length -eq 1) {
    $c = $n[0]
    if ($c -ge 'a' -and $c -le 'z') { return @{ vk = [UInt16](0x41 + ([int]$c - 97)) } }
    if ($c -ge '0' -and $c -le '9') { return @{ vk = [UInt16](0x30 + ([int]$c - 48)) } }
    return @{ ch = [char]$c }
  }
  return $null
}

switch ($action) {
  "getpos" {
    $c = Get-CursorJson
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; cursor = $c })
    exit 0
  }
  "move" {
    $x = [int]$cfg.coordinate[0]; $y = [int]$cfg.coordinate[1]
    [CU]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 30
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; cursor = @($x, $y) })
    exit 0
  }
  "click" {
    $x = [int]$cfg.coordinate[0]; $y = [int]$cfg.coordinate[1]
    $a = [string]$cfg.action2; if ([string]::IsNullOrWhiteSpace($a)) { $a = "click" }
    [CU]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 30
    if ($a -eq "right_click") {
      [CU]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
    } elseif ($a -eq "double_click") {
      [CU]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    } else {
      [CU]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    }
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; cursor = @($x, $y); action = $a })
    exit 0
  }
  "drag" {
    $sx = [int]$cfg.from[0]; $sy = [int]$cfg.from[1]
    $tx = [int]$cfg.to[0];   $ty = [int]$cfg.to[1]
    [CU]::SetCursorPos($sx, $sy) | Out-Null; Start-Sleep -Milliseconds 30
    if ($null -ne $cfg.holdKeys -and $cfg.holdKeys.Count -gt 0) {
      foreach ($hk in $cfg.holdKeys) { $r = Resolve-Key $hk; if ($null -ne $r -and $r.ContainsKey("vk")) { [CU]::KeyDown($r.vk) } }
      Start-Sleep -Milliseconds 40
    }
    [CU]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
      $px = [int]($sx + ($tx - $sx) * $i / $steps); $py = [int]($sy + ($ty - $sy) * $i / $steps)
      [CU]::SetCursorPos($px, $py) | Out-Null
      Start-Sleep -Milliseconds 12
    }
    [CU]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    if ($null -ne $cfg.holdKeys -and $cfg.holdKeys.Count -gt 0) {
      Start-Sleep -Milliseconds 30
      $rev = @($cfg.holdKeys); [array]::Reverse($rev)
      foreach ($hk in $rev) { $r = Resolve-Key $hk; if ($null -ne $r -and $r.ContainsKey("vk")) { [CU]::KeyUp($r.vk) } }
    }
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; from = @($sx, $sy); to = @($tx, $ty); cursor = @($tx, $ty) })
    exit 0
  }
  "scroll" {
    $x = [int]$cfg.coordinate[0]; $y = [int]$cfg.coordinate[1]
    $dir = [string]$cfg.direction; if ([string]::IsNullOrWhiteSpace($dir)) { $dir = "down" }
    $clicks = [int]$cfg.clicks; if ($clicks -le 0) { $clicks = 1 }
    [CU]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 20
    $notches = 120 * $clicks
    $vy = if ($dir -eq "down") { -$notches } else { $notches }
    $hz = if ($dir -eq "right") { -$notches } else { $notches }
    if ($dir -eq "left" -or $dir -eq "right") { [CU]::Wheel((To-U32 $hz)) }   # SendInput HWHEEL
    if ($dir -eq "up" -or $dir -eq "down")   { [CU]::Wheel((To-U32 $vy)) }     # SendInput WHEEL
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; cursor = @($x, $y); direction = $dir; clicks = $clicks })
    exit 0
  }
  "type" {
    $text = [string]$cfg.text
    $interval = [int]$cfg.typingIntervalMs; if ($interval -lt 0) { $interval = 0 }
    $count = 0
    foreach ($ch in $text.ToCharArray()) {
      [CU]::CharDown($ch); Start-Sleep -Milliseconds 8; [CU]::CharUp($ch)
      $count++
      if ($interval -gt 0) { Start-Sleep -Milliseconds $interval }
    }
    if ($cfg.sendEnter) { [CU]::KeyDown(0x0D); Start-Sleep -Milliseconds 20; [CU]::KeyUp(0x0D) }
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; chars = $count; sendEnter = [bool]$cfg.sendEnter; cursor = (Get-CursorJson) })
    exit 0
  }
  "keypress" {
    $keys = @($cfg.keys)
    if ($keys.Count -eq 0) { Fail("keypress requires at least one key") }
    $down = @()
    foreach ($k in $keys) { $r = Resolve-Key $k; if ($null -eq $r) { Fail("unknown key: $k") }; $down += ,$r }
    # press modifiers/specials first (VK), then each remaining (char for punctuation)
    foreach ($r in $down) { if ($r.ContainsKey("vk")) { [CU]::KeyDown($r.vk) } else { [CU]::CharDown($r.ch) } }
    Start-Sleep -Milliseconds 50
    $up = @($down); [array]::Reverse($up)
    foreach ($r in $up) { if ($r.ContainsKey("vk")) { [CU]::KeyUp($r.vk) } else { [CU]::CharUp($r.ch) } }
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; keys = ($keys -join "+"); cursor = (Get-CursorJson) })
    exit 0
  }
  default { Fail("unknown action: $action") }
}
