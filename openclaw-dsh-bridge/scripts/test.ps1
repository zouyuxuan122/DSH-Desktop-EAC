# Run protocol-level unit tests. Copies the plugin into the DSH Desktop node_modules
# tree so @deepseek-ai/* imports resolve, then runs the test and cleans up.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$target = "D:\app\dsh\DSH Desktop\resources\app"
if (-not (Test-Path (Join-Path $target "main.js"))) {
  $target = Read-Host "Enter the DSH Desktop resources\app directory"
}
$nm = Join-Path $target "node_modules\@deepseek-ai\dsh-openclaw-bridge"
$tmpHome = Join-Path $env:TEMP ("dsh-bridge-test-home-" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $nm "lib") | Out-Null
  Copy-Item (Join-Path $repo "package.json") (Join-Path $nm "package.json") -Force
  Copy-Item (Join-Path $repo "lib\*.js") (Join-Path $nm "lib") -Force
  Copy-Item (Join-Path $repo "test\bridge.test.mjs") (Join-Path $target ".bridge-test.mjs") -Force

  $env:USERPROFILE = $tmpHome
  & "C:\Program Files\nodejs\node.exe" (Join-Path $target ".bridge-test.mjs")
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "tests failed (exit $code)" }
  Write-Host "Tests passed"
} finally {
  Remove-Item -LiteralPath $nm -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $target ".bridge-test.mjs") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tmpHome -Recurse -Force -ErrorAction SilentlyContinue
}
