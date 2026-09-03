param(
    [Parameter(Mandatory = $false)]
    [string]$RepoPath = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepoPath).Path

function Count-Directories {
    param([string]$RelativePath)
    $path = Join-Path $root $RelativePath
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    return @(Get-ChildItem -LiteralPath $path -Directory).Count
}

function Count-Files {
    param([string]$RelativePath, [string]$Filter = '*')
    $path = Join-Path $root $RelativePath
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    return @(Get-ChildItem -LiteralPath $path -File -Filter $Filter).Count
}

$repositoryLayout = if (
    (Test-Path -LiteralPath (Join-Path $root 'dsh-desktop\package.json') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $root 'tauri-shell\tauri.conf.json') -PathType Leaf)
) {
    'modern-5x'
} elseif (
    (Test-Path -LiteralPath (Join-Path $root 'package.json') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $root 'tauri-app\tauri.conf.json') -PathType Leaf)
) {
    'aio-v1'
} else {
    throw 'Unsupported repository layout: expected modern 5.x or aio-v1 manifests.'
}

$layout = if ($repositoryLayout -eq 'modern-5x') {
    [ordered]@{
        desktopPackage = 'dsh-desktop\package.json'
        tauriConfig = 'tauri-shell\tauri.conf.json'
        plugins = 'dsh-desktop\assets\plugins'
        skins = 'dsh-desktop\assets\skins'
        agentPresets = 'dsh-desktop\assets\agent-presets'
        bundledSkills = 'dsh-desktop\assets\skills'
        desktopL2 = 'dsh-desktop\lib\desktop'
        sidecar = 'tauri-shell\sidecar'
        tests = 'dsh-desktop\test'
        testFilter = '*.test.ts'
    }
} else {
    [ordered]@{
        desktopPackage = 'package.json'
        tauriConfig = 'tauri-app\tauri.conf.json'
        plugins = 'assets\plugins'
        skins = 'assets\skins'
        agentPresets = 'assets\agent-presets'
        bundledSkills = 'distribution\profile-seed\skills'
        desktopL2 = ''
        sidecar = 'sidecar\src'
        tests = 'test'
        testFilter = '*.test.mjs'
    }
}

$desktopPackage = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $root $layout.desktopPackage) -Raw | ConvertFrom-Json
$tauriConfig = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $root $layout.tauriConfig) -Raw | ConvertFrom-Json

Push-Location $root
try {
    $files = @(git -c core.quotepath=false ls-files --cached --others --exclude-standard 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to collect repository files: $($files -join "`n")"
    }
    $status = @(git status --short --branch 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read Git status: $($status -join "`n")"
    }
    $head = (git rev-parse --short HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to resolve Git HEAD.'
    }
} finally {
    Pop-Location
}

$extensions = [ordered]@{}
$extensionNames = @(
    $files | ForEach-Object { [IO.Path]::GetExtension($_) }
)
foreach ($group in ($extensionNames | Group-Object | Sort-Object Count -Descending)) {
    $key = if ($group.Name) { $group.Name } else { '<none>' }
    $extensions[$key] = $group.Count
}

[ordered]@{
    schemaVersion = 1
    status = 'ready'
    generatedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
    repoRoot = $root
    repositoryLayout = $repositoryLayout
    gitHead = $head
    gitStatus = $status
    versions = [ordered]@{
        desktop = [string]$desktopPackage.version
        tauri = [string]$tauriConfig.version
        dsh = [string]$desktopPackage.dependencies.'@deepseek-ai/dsh'
    }
    counts = [ordered]@{
        plugins = Count-Directories $layout.plugins
        skins = Count-Directories $layout.skins
        agentPresets = Count-Directories $layout.agentPresets
        bundledSkills = Count-Directories $layout.bundledSkills
        desktopL2TypeScript = Count-Files $layout.desktopL2 '*.ts'
        sidecarTypeScript = Count-Files $layout.sidecar '*.ts'
        rustFiles = @($files | Where-Object { [IO.Path]::GetExtension($_) -eq '.rs' }).Count
        nodeTestFiles = Count-Files $layout.tests $layout.testFilter
        rootSmokeScripts = @(Get-ChildItem -LiteralPath $root -File | Where-Object Name -match '(smoke|upgrade-test).*\.js$').Count
        workflows = Count-Files '.github\workflows' '*'
    }
    extensions = $extensions
    warnings = @()
    errors = @()
} | ConvertTo-Json -Depth 8
