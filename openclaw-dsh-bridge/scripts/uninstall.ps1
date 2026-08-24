param(
  [string]$Target = "",
  [switch]$KeepData
)
# Uninstall dsh-openclaw-bridge from DSH Desktop and the web profile.
# Rolls back all four install artifacts; optionally keeps bridge data
# (token, wechat session, workspaces) unless -KeepData is omitted.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if (-not $Target) {
  $candidates = @(
    "D:\app\dsh\DSH Desktop\resources\app",
    (Join-Path $env:LOCALAPPDATA "Programs\dsh-desktop\resources\app"),
    (Join-Path $env:ProgramFiles "dsh-desktop\resources\app")
  )
  $Target = $candidates | Where-Object { Test-Path (Join-Path $_ "main.js") } | Select-Object -First 1
}
if (-not $Target -or -not (Test-Path (Join-Path $Target "main.js"))) {
  throw "DSH Desktop install not found. Pass -Target pointing at its resources\app directory."
}

# 1) Remove the cordis.patch.yml insert entry
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\web"
$patchFile = Join-Path $profileDir "cordis.patch.yml"
if (Test-Path $patchFile) {
  $patch = Get-Content -LiteralPath $patchFile -Raw
  if ($patch -match "id:\s*openclaw-bridge\b") {
    $patch = $patch -replace "(?m)^- insert:\r?\n    - id: openclaw-bridge\r?\n      name: '@deepseek-ai/dsh-openclaw-bridge'\r?\n", ""
    $patch = $patch -replace "(?m)^- insert:\r?\n    - id: openclaw-bridge\r?\n      name: '@deepseek-ai/dsh-openclaw-bridge'\r?\n", ""
    $patch = $patch.TrimEnd() + [Environment]::NewLine
    Set-Content -LiteralPath $patchFile -Value $patch -Encoding UTF8
    Write-Host "[1/4] removed openclaw-bridge entry from cordis.patch.yml"
  } else {
    Write-Host "[1/4] cordis.patch.yml has no openclaw-bridge entry (skipped)"
  }
}

# 2) Remove the plugin directories (profile + Desktop assets)
$dest1 = Join-Path $profileDir "node_modules\@deepseek-ai\dsh-openclaw-bridge"
if (Test-Path $dest1) { Remove-Item -LiteralPath $dest1 -Recurse -Force; Write-Host "[2/4] removed profile copy" }
else { Write-Host "[2/4] profile copy already gone" }
$dest2 = Join-Path $Target "assets\plugins\dsh-openclaw-bridge"
if (Test-Path $dest2) { Remove-Item -LiteralPath $dest2 -Recurse -Force; Write-Host "[2/4] removed assets/plugins copy" }
else { Write-Host "[2/4] assets/plugins copy already gone" }

# 3) Revert the dsh-host-apiproxy whitelist patch
$apiproxy = Join-Path $Target "node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js"
if (Test-Path $apiproxy) {
  $src = [System.IO.File]::ReadAllText($apiproxy)
  if ($src -match '"openclaw-bridge"') {
    $src = $src -replace "(?m)^\t\"openclaw-bridge\",\r?\n", ""
    [System.IO.File]::WriteAllText($apiproxy, $src, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[3/4] reverted WEB_SETTINGS_NAMESPACES patch in dsh-host-apiproxy"
  } else {
    Write-Host "[3/4] dsh-host-apiproxy not patched (skipped)"
  }
}

# 4) Optional: remove bridge data
if (-not $KeepData) {
  $data = Join-Path $env:USERPROFILE ".dsh\openclaw-bridge"
  if (Test-Path $data) { Remove-Item -LiteralPath $data -Recurse -Force; Write-Host "[4/4] removed bridge data at $data" }
  else { Write-Host "[4/4] no bridge data (skipped)" }
} else {
  Write-Host "[4/4] kept bridge data (-KeepData)"
}

Write-Host ""
Write-Host "Done. Restart DSH Desktop; the ClawBot settings section and [openclaw-bridge] log line will be gone."
