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

$desktopPackage = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $root 'dsh-desktop\package.json') -Raw | ConvertFrom-Json
$tauriConfig = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $root 'tauri-shell\tauri.conf.json') -Raw | ConvertFrom-Json

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
    gitHead = $head
    gitStatus = $status
    versions = [ordered]@{
        desktop = [string]$desktopPackage.version
        tauri = [string]$tauriConfig.version
        dsh = [string]$desktopPackage.dependencies.'@deepseek-ai/dsh'
    }
    counts = [ordered]@{
        plugins = Count-Directories 'dsh-desktop\assets\plugins'
        skins = Count-Directories 'dsh-desktop\assets\skins'
        agentPresets = Count-Directories 'dsh-desktop\assets\agent-presets'
        bundledSkills = Count-Directories 'dsh-desktop\assets\skills'
        desktopL2TypeScript = Count-Files 'dsh-desktop\lib\desktop' '*.ts'
        sidecarTypeScript = Count-Files 'tauri-shell\sidecar' '*.ts'
        rustFiles = @($files | Where-Object { [IO.Path]::GetExtension($_) -eq '.rs' }).Count
        nodeTestFiles = Count-Files 'dsh-desktop\test' '*.test.ts'
        rootSmokeScripts = @(Get-ChildItem -LiteralPath $root -File | Where-Object Name -match '(smoke|upgrade-test).*\.js$').Count
        workflows = Count-Files '.github\workflows' '*'
    }
    extensions = $extensions
    warnings = @()
    errors = @()
} | ConvertTo-Json -Depth 8
