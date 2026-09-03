[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$ProfileSeedDir = $env:DSH_PROFILE_SEED_DIR
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$tauri = Join-Path $RepoRoot 'tauri-app'
$dist = Join-Path $RepoRoot 'dist'

function Get-Sha256Hex([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
        } finally {
            $sha.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

if ([string]::IsNullOrWhiteSpace($ProfileSeedDir)) {
    $ProfileSeedDir = Join-Path $RepoRoot 'distribution\profile-seed'
}
$requiredSeed = Join-Path $ProfileSeedDir 'profiles\web-desktop\node_modules'
if (-not (Test-Path -LiteralPath $requiredSeed -PathType Container)) {
    throw "Offline profile seed is incomplete. Set DSH_PROFILE_SEED_DIR to a reviewed seed: $requiredSeed"
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'vendor\node\node.exe') -PathType Leaf)) {
    throw 'vendor/node/node.exe is missing; run npm run fetch-runtime or attach the reviewed runtime cache.'
}

$env:DSH_PROFILE_SEED_DIR = (Resolve-Path -LiteralPath $ProfileSeedDir).Path
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Get-ChildItem -LiteralPath $dist -File -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host '[1/7] sanitize public seed'
& npm.cmd run seed:sanitize
if ($LASTEXITCODE -ne 0) { throw 'seed sanitization failed' }

Write-Host '[2/7] check and compile sidecar'
& npm.cmd --prefix $tauri run sidecar:check
if ($LASTEXITCODE -ne 0) { throw 'sidecar typecheck failed' }
& npm.cmd --prefix $tauri run sidecar:build
if ($LASTEXITCODE -ne 0) { throw 'sidecar build failed' }

Write-Host '[3/7] JavaScript tests'
$tests = @(Get-ChildItem (Join-Path $RepoRoot 'test') -Filter '*.test.mjs' -File | Select-Object -ExpandProperty FullName)
& node --test --test-concurrency=1 $tests
if ($LASTEXITCODE -ne 0) { throw 'JavaScript tests failed' }

Write-Host '[4/7] Rust tests'
& cargo test --locked --manifest-path (Join-Path $tauri 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed' }

Write-Host '[5/7] stage and bundle NSIS'
& node (Join-Path $RepoRoot 'tauri-shell\stage-resources.mjs')
if ($LASTEXITCODE -ne 0) { throw 'resource staging failed' }
& npm.cmd --prefix $tauri run bundle
if ($LASTEXITCODE -ne 0) { throw 'Tauri bundle failed' }

$builtSetup = Join-Path $tauri 'target\release\bundle\nsis\DSHEAC AIO_1.1.0_x64-setup.exe'
$setup = Join-Path $dist 'DSHEAC-AIO-v1-Setup-x64.exe'
Copy-Item -LiteralPath $builtSetup -Destination $setup -Force

Write-Host '[6/7] portable package'
& node (Join-Path $RepoRoot 'tauri-shell\make-portable.mjs') --out (Join-Path $dist 'portable')
if ($LASTEXITCODE -ne 0) { throw 'portable package failed' }

Write-Host '[7/7] release hashes'
$hashLines = foreach ($file in Get-ChildItem $dist -Recurse -File | Where-Object Name -ne 'SHA256SUMS.txt' | Sort-Object FullName) {
    $hash = Get-Sha256Hex $file.FullName
    $relative = $file.FullName.Substring($dist.Length + 1).Replace('\', '/')
    "$hash  $relative"
}
$hashLines | Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ascii
Write-Host "AIO release complete: $dist"
