param(
  [string]$Python = $env:DSH_DAFEIYU_BUILD_PYTHON
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'runtime\helper.py'
$assets = Join-Path $projectRoot 'assets'
$output = Join-Path $projectRoot 'runtime\bin\win32-x64'
$work = Join-Path $projectRoot '.build\helper'

if (-not $Python) {
  $Python = 'python'
}

New-Item -ItemType Directory -Force -Path $output, $work | Out-Null

& $Python -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --console `
  --name dsh-dafeiyu-helper `
  --distpath $output `
  --workpath $work `
  --specpath $work `
  --add-data "$assets;assets" `
  --paths (Join-Path $projectRoot 'runtime') `
  $entry

if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller failed with exit code $LASTEXITCODE"
}

Write-Output (Join-Path $output 'dsh-dafeiyu-helper.exe')
