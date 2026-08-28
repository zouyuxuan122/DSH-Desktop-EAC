param(
  [string]$Target = "",
  [string]$DshHome = "",
  [switch]$SkipDesktop
)
# Install this plugin into DSH Desktop (assets/plugins) and sync it to the web profile.
# -Target: DSH Desktop resources\app directory (auto-detected when empty)
# -DshHome: DSH home override (defaults to ~/.dsh); useful for tests/custom homes
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

# 1) Copy into DSH Desktop assets/plugins (survives future DSH Desktop updates via its own sync)
if (-not $SkipDesktop) {
  if (-not $Target) {
    $candidates = @(
      "D:\app\dsh\DSH Desktop\resources\app",
      (Join-Path $env:LOCALAPPDATA "Programs\dsh-desktop\resources\app"),
      (Join-Path $env:ProgramFiles "dsh-desktop\resources\app"),
      (Join-Path ${env:ProgramFiles(x86)} "dsh-desktop\resources\app")
    )
    $Target = $candidates | Where-Object { Test-Path (Join-Path $_ "main.js") } | Select-Object -First 1
  }
  if (-not $Target -or -not (Test-Path (Join-Path $Target "main.js"))) {
    throw "DSH Desktop install not found. Pass -Target pointing at its resources\app directory (or -SkipDesktop for profile-only install)."
  }
  $pluginDir = Join-Path $Target "assets\plugins\dsh-openclaw-bridge"
New-Item -ItemType Directory -Force -Path (Join-Path $pluginDir "lib") | Out-Null
Copy-Item (Join-Path $repo "package.json") (Join-Path $pluginDir "package.json") -Force
Copy-Item (Join-Path $repo "lib\*.js") (Join-Path $pluginDir "lib") -Force
  Write-Host "[1/3] plugin copied to $pluginDir"

  # 1b) Settings namespace whitelist patch: settings.describe/mutate only expose
  # WEB_SETTINGS_NAMESPACES entries; add openclaw-bridge so the settings page
  # ClawBot section can read/write its config.
  $apiproxy = Join-Path $Target "node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js"
  if (Test-Path $apiproxy) {
    $src = [System.IO.File]::ReadAllText($apiproxy)
    if ($src -notmatch '"openclaw-bridge"') {
      $marker = 'const WEB_SETTINGS_NAMESPACES = ['
      $insert = [Environment]::NewLine + [char]9 + '"openclaw-bridge",' + [Environment]::NewLine + [char]9
      if ($src.Contains($marker)) {
        $src = $src.Replace($marker, $marker + $insert)
        [System.IO.File]::WriteAllText($apiproxy, $src, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[1b/3] patched WEB_SETTINGS_NAMESPACES in dsh-host-apiproxy (restart to take effect)"
      } else {
        Write-Host "[1b/3] WEB_SETTINGS_NAMESPACES marker not found (skipped)"
      }
    } else {
      Write-Host "[1b/3] dsh-host-apiproxy already patched (skipped)"
    }
  } else {
    Write-Host "[1b/3] dsh-host-apiproxy not found (skipped whitelist patch)"
  }
}

# 2) Sync into the web profile (same approach as DSH Desktop's syncCompanionPlugins)
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $DshHome "profiles\web"
$dest = Join-Path $profileDir "node_modules\@deepseek-ai\dsh-openclaw-bridge"
New-Item -ItemType Directory -Force -Path (Join-Path $dest "lib") | Out-Null
Copy-Item (Join-Path $repo "package.json") (Join-Path $dest "package.json") -Force
Copy-Item (Join-Path $repo "lib\*.js") (Join-Path $dest "lib") -Force
Write-Host "[2/3] plugin synced to $dest"

# 3) Patch the profile composition to load the plugin
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$patch = if (Test-Path $patchFile) { Get-Content -LiteralPath $patchFile -Raw } else { "" }
if ($patch -notmatch "id:\s*openclaw-bridge\b") {
  $blockLines = @(
    "- insert:",
    "    - id: openclaw-bridge",
    "      name: '@deepseek-ai/dsh-openclaw-bridge'"
  )
  $block = ($blockLines -join [Environment]::NewLine) + [Environment]::NewLine
  if ($patch.Trim() -eq "" -or $patch -match '^\s*\[\]\s*$') {
    $patch = "# dsh web profile patch (maintained by openclaw-dsh-bridge)" + [Environment]::NewLine + $block
  } else {
    $patch = $patch.TrimEnd() + [Environment]::NewLine + $block
  }
  Set-Content -LiteralPath $patchFile -Value $patch -Encoding UTF8
  Write-Host "[3/3] appended openclaw-bridge entry to cordis.patch.yml"
} else {
  Write-Host "[3/3] cordis.patch.yml already contains openclaw-bridge (skipped)"
}

Write-Host ""
Write-Host "Done. Restart DSH Desktop (or dsh web), then look for this line in the startup log:"
Write-Host "  [openclaw-bridge] mounted on http://127.0.0.1:<port>/openclaw-bridge/v1/chat/completions"
Write-Host "Health check: http://127.0.0.1:<port>/openclaw-bridge/health"
Write-Host "Next: point OpenClaw's custom provider baseURL at the chat/completions endpoint above."
