param(
    [Parameter(Mandatory = $false)]
    [string]$RepoPath = (Get-Location).Path,

    [Parameter(Mandatory = $false)]
    [ValidateSet('targeted', 'full', 'runtime', 'package')]
    [string]$RequiredLevel = 'targeted'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepoPath).Path

function Get-CommandProbe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        return [ordered]@{
            available = $false
            version = $null
            exitCode = $null
            error = "Command is unavailable: $Name"
        }
    }

    try {
        $global:LASTEXITCODE = 0
        $output = @(& $command.Source @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
        $first = $output | Select-Object -First 1
        return [ordered]@{
            available = ($exitCode -eq 0)
            version = if ($null -eq $first) { '' } else { $first.ToString() }
            exitCode = $exitCode
            error = if ($exitCode -eq 0) { $null } else { ($output -join "`n") }
        }
    } catch {
        return [ordered]@{
            available = $false
            version = $null
            exitCode = $null
            error = $_.Exception.Message
        }
    }
}

$requiredPaths = @(
    'dsh-desktop\package.json',
    'tauri-shell\Cargo.toml',
    'docs\adr\0002-shell-boundary-and-layering.md'
)
$missingPaths = @($requiredPaths | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $root $_))
})

$tools = [ordered]@{
    node = Get-CommandProbe -Name 'node' -Arguments @('--version')
    npm = Get-CommandProbe -Name 'npm' -Arguments @('--version')
    git = Get-CommandProbe -Name 'git' -Arguments @('--version')
    cargo = Get-CommandProbe -Name 'cargo' -Arguments @('--version')
    rustc = Get-CommandProbe -Name 'rustc' -Arguments @('--version')
}

$rustHost = $null
$rustHostError = $null
if ($tools.rustc.available) {
    $global:LASTEXITCODE = 0
    $rustOutput = @(& rustc -vV 2>&1)
    if ($LASTEXITCODE -eq 0) {
        $rustHost = $rustOutput |
            Where-Object { $_.ToString() -like 'host:*' } |
            Select-Object -First 1
        if ($rustHost) {
            $rustHost = $rustHost.ToString()
        }
    } else {
        $rustHostError = $rustOutput -join "`n"
    }
}

$warnings = [System.Collections.Generic.List[string]]::new()
$blockedReasons = [System.Collections.Generic.List[string]]::new()

if ($missingPaths.Count -gt 0) {
    $blockedReasons.Add("Repository shape is incomplete: $($missingPaths -join ', ')")
}

foreach ($name in @('node', 'npm', 'git')) {
    if (-not $tools[$name].available) {
        $blockedReasons.Add("Required command is unavailable or failed: $name")
    }
}

$requiresRust = $RequiredLevel -in @('runtime', 'package')
if ($requiresRust) {
    foreach ($name in @('cargo', 'rustc')) {
        if (-not $tools[$name].available) {
            $blockedReasons.Add("Validation level '$RequiredLevel' requires command: $name")
        }
    }
    if ($tools.rustc.available -and $rustHostError) {
        $blockedReasons.Add("Unable to determine Rust host: $rustHostError")
    } elseif ($tools.rustc.available -and $rustHost -notmatch 'windows-msvc') {
        $blockedReasons.Add("Validation level '$RequiredLevel' requires an MSVC Rust host; current host is: $rustHost")
    }
} elseif ($rustHost -and $rustHost -notmatch 'windows-msvc') {
    $warnings.Add("Rust host is not MSVC; runtime/package validation will be blocked: $rustHost")
}

$dlltoolAvailable = [bool](Get-Command dlltool -ErrorAction SilentlyContinue)
if ($rustHost -match 'windows-gnu' -and -not $dlltoolAvailable) {
    $warnings.Add('GNU Rust host is active but dlltool.exe is unavailable.')
}

$status = if ($blockedReasons.Count -gt 0) {
    'blocked'
} elseif ($warnings.Count -gt 0) {
    'warning'
} else {
    'ready'
}

$result = [ordered]@{
    schemaVersion = 1
    status = $status
    ready = ($status -ne 'blocked')
    requiredLevel = $RequiredLevel
    repoRoot = $root
    repositoryShapeOk = ($missingPaths.Count -eq 0)
    missingPaths = $missingPaths
    tools = $tools
    node = $tools.node.version
    npm = $tools.npm.version
    cargo = $tools.cargo.version
    rustc = $tools.rustc.version
    rustHost = $rustHost
    dlltool = $dlltoolAvailable
    recommendedRustHost = 'x86_64-pc-windows-msvc'
    rustEnvironmentReady = [bool](
        $tools.cargo.available -and
        $tools.rustc.available -and
        $rustHost -match 'windows-msvc'
    )
    git = $tools.git.version
    warnings = @($warnings)
    blockedReasons = @($blockedReasons)
    errors = @($blockedReasons)
}

$result | ConvertTo-Json -Depth 6
if ($status -eq 'blocked') {
    exit 2
}
