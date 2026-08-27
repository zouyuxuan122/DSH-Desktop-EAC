param(
  [string]$Python = $env:DSH_DAFEIYU_BUILD_PYTHON
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'runtime\helper.py'
$assets = Join-Path $projectRoot 'assets'
$output = Join-Path $projectRoot 'runtime\bin\win32-x64'
$work = Join-Path $projectRoot '.build\helper'
$projectPython = Join-Path $projectRoot '.build\python-env\Scripts\python.exe'

if (-not $Python) {
  $Python = if (Test-Path -LiteralPath $projectPython) { $projectPython } else { 'python' }
}

New-Item -ItemType Directory -Force -Path $output, $work | Out-Null

& $Python -c "import PyInstaller, PySide6; print(f'PyInstaller {PyInstaller.__version__}; PySide6 {PySide6.__version__}')"
if ($LASTEXITCODE -ne 0) {
  throw "The selected Python cannot import both PyInstaller and PySide6. Install requirements into the same interpreter or set DSH_DAFEIYU_BUILD_PYTHON. Selected: $Python"
}

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

$executable = Join-Path $output 'dsh-dafeiyu-helper.exe'
& node (Join-Path $PSScriptRoot 'test-packaged-helper.mjs') --executable $executable
if ($LASTEXITCODE -ne 0) {
  throw "Packaged helper visual smoke test failed with exit code $LASTEXITCODE"
}

Write-Output $executable
