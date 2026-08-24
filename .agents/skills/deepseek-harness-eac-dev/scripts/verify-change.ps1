param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('auto', 'targeted', 'full', 'runtime', 'package')]
    [string]$Level = 'auto',

    [Parameter(Mandatory = $false)]
    [string]$RepoPath = (Get-Location).Path,

    [Parameter(Mandatory = $false)]
    [string[]]$Files,

    [Parameter(Mandatory = $false)]
    [string]$FilesJson,

    [Parameter(Mandatory = $false)]
    [string]$FilesJsonBase64,

    [Parameter(Mandatory = $false)]
    [string[]]$TestFiles = @(),

    [Parameter(Mandatory = $false)]
    [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepoPath).Path
$desktop = Join-Path $root 'dsh-desktop'
$tauri = Join-Path $root 'tauri-shell'
$skillRoot = Split-Path -Parent $PSScriptRoot
$pwsh = (Get-Process -Id $PID).Path
$filesWereExplicit = (
    $PSBoundParameters.ContainsKey('Files') -or
    $PSBoundParameters.ContainsKey('FilesJson') -or
    $PSBoundParameters.ContainsKey('FilesJsonBase64')
)

if ($FilesJson -and $FilesJsonBase64) {
    [ordered]@{
        schemaVersion = 1
        status = 'blocked'
        phase = 'input'
        execute = [bool]$Execute
        repoRoot = $root
        error = 'Use either FilesJson or FilesJsonBase64, not both.'
        warnings = @()
        errors = @('Use either FilesJson or FilesJsonBase64, not both.')
    } | ConvertTo-Json -Depth 4
    exit 2
}

if ($FilesJsonBase64) {
    try {
        $FilesJson = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String($FilesJsonBase64)
        )
    } catch {
        $message = "FilesJsonBase64 is invalid: $($_.Exception.Message)"
        [ordered]@{
            schemaVersion = 1
            status = 'blocked'
            phase = 'input'
            execute = [bool]$Execute
            repoRoot = $root
            error = $message
            warnings = @()
            errors = @($message)
        } | ConvertTo-Json -Depth 4
        exit 2
    }
}

if ($FilesJson) {
    try {
        $trimmedFilesJson = $FilesJson.Trim()
        if (-not $trimmedFilesJson.StartsWith('[') -or -not $trimmedFilesJson.EndsWith(']')) {
            throw 'FilesJson root must be a JSON array.'
        }
        $parsedWrapper = ConvertFrom-Json -InputObject ('{"items":' + $trimmedFilesJson + '}')
        $parsedFiles = $parsedWrapper.items
        if ($parsedFiles -isnot [System.Array]) {
            throw 'FilesJson root must be a JSON array.'
        }
        $normalizedFiles = [System.Collections.Generic.List[string]]::new()
        $index = 0
        foreach ($file in $parsedFiles) {
            if ($file -isnot [string]) {
                $receivedType = if ($null -eq $file) { 'null' } else { $file.GetType().FullName }
                throw "FilesJson item $index must be a string; received $receivedType."
            }
            if ([string]::IsNullOrWhiteSpace($file)) {
                throw "FilesJson item $index must not be empty."
            }
            $normalizedFiles.Add($file)
            $index += 1
        }
        $Files = [string[]]$normalizedFiles.ToArray()
    } catch {
        $message = "FilesJson is invalid: $($_.Exception.Message)"
        [ordered]@{
            schemaVersion = 1
            status = 'blocked'
            phase = 'input'
            execute = [bool]$Execute
            repoRoot = $root
            error = $message
            warnings = @()
            errors = @($message)
        } | ConvertTo-Json -Depth 4
        exit 2
    }
}

if ($Files) {
    $normalizedFiles = [System.Collections.Generic.List[string]]::new()
    $index = 0
    foreach ($file in $Files) {
        if ([string]::IsNullOrWhiteSpace($file) -or $file -eq 'System.Object[]') {
            $message = "Files item $index is not a valid path string."
            [ordered]@{
                schemaVersion = 1
                status = 'blocked'
                phase = 'input'
                execute = [bool]$Execute
                repoRoot = $root
                error = $message
                warnings = @()
                errors = @($message)
            } | ConvertTo-Json -Depth 4
            exit 2
        }
        $normalizedFiles.Add($file)
        $index += 1
    }
    $Files = [string[]]$normalizedFiles.ToArray()
}

function Invoke-JsonScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $global:LASTEXITCODE = 0
    $raw = @(& $pwsh -NoLogo -NoProfile -File $ScriptPath @Arguments)
    $exitCode = $LASTEXITCODE
    $text = $raw -join "`n"
    $data = $null
    if ($text) {
        try {
            $data = $text | ConvertFrom-Json
        } catch {
            return [ordered]@{
                exitCode = if ($exitCode -eq 0) { 2 } else { $exitCode }
                data = $null
                parseError = $_.Exception.Message
                raw = $text
            }
        }
    }
    return [ordered]@{
        exitCode = $exitCode
        data = $data
        parseError = $null
        raw = $text
    }
}

function ConvertTo-JsonStringArray {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$Values
    )

    $encodedValues = @(
        foreach ($value in @($Values)) {
            ConvertTo-Json -InputObject $value -Compress
        }
    )
    return '[' + ($encodedValues -join ',') + ']'
}

$classifierArguments = @('-RepoPath', $root)
if ($filesWereExplicit) {
    $classifierFilesJson = ConvertTo-JsonStringArray -Values ([string[]]@($Files))
    $classifierArguments += '-FilesJsonBase64'
    $classifierArguments += [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($classifierFilesJson)
    )
}
$classificationRun = Invoke-JsonScript `
    -ScriptPath (Join-Path $PSScriptRoot 'classify-change.ps1') `
    -Arguments $classifierArguments

if ($classificationRun.exitCode -ne 0 -or -not $classificationRun.data -or $classificationRun.data.status -eq 'blocked') {
    $classificationError = if ($classificationRun.parseError) {
        "Unable to parse classifier output: $($classificationRun.parseError)"
    } elseif ($classificationRun.data) {
        ($classificationRun.data.errors -join '; ')
    } else {
        'Classifier did not return structured output.'
    }
    [ordered]@{
        schemaVersion = 1
        status = 'blocked'
        phase = 'classification'
        execute = [bool]$Execute
        repoRoot = $root
        classification = $classificationRun.data
        error = $classificationError
        rawClassifierOutput = if ($classificationRun.parseError) { $classificationRun.raw } else { $null }
        warnings = @()
        errors = @($classificationError)
    } | ConvertTo-Json -Depth 8
    exit 2
}

$classification = $classificationRun.data
$levelRank = @{ targeted = 1; full = 2; runtime = 3; package = 4 }
$classifiedLevel = if ($classification.minimumValidation) {
    $classification.minimumValidation
} else {
    'targeted'
}
$requestedEffectiveLevel = if ($Level -eq 'auto') { $classifiedLevel } else { $Level }
$effectiveLevel = if ($levelRank[$requestedEffectiveLevel] -lt $levelRank[$classifiedLevel]) {
    $classifiedLevel
} else {
    $requestedEffectiveLevel
}
$levelAdjusted = ($Level -ne 'auto' -and $effectiveLevel -ne $Level)

$preflightRun = Invoke-JsonScript `
    -ScriptPath (Join-Path $PSScriptRoot 'repo-preflight.ps1') `
    -Arguments @('-RepoPath', $root, '-RequiredLevel', $effectiveLevel)
$preflight = $preflightRun.data

$allTests = [System.Collections.Generic.HashSet[string]]::new()
foreach ($test in @($classification.suggestedTests) + @($TestFiles)) {
    if ($test) {
        [void]$allTests.Add($test)
    }
}

$missingTests = [System.Collections.Generic.List[string]]::new()
foreach ($test in $allTests) {
    if (-not (Test-Path -LiteralPath (Join-Path $desktop $test))) {
        $missingTests.Add($test)
    }
}

$automatedChecks = [System.Collections.Generic.List[object]]::new()
$manualChecks = [System.Collections.Generic.List[object]]::new()
$seenAutomated = [System.Collections.Generic.HashSet[string]]::new()
$seenManual = [System.Collections.Generic.HashSet[string]]::new()

function Add-AutomatedCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Id,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,

        [Parameter(Mandatory = $true)]
        [string]$Executable,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $key = "$WorkingDirectory|$Executable|$($Arguments -join [char]31)"
    if ($seenAutomated.Add($key)) {
        $automatedChecks.Add([ordered]@{
            id = $Id
            label = $Label
            workingDirectory = $WorkingDirectory
            executable = $Executable
            arguments = @($Arguments)
            command = "$Executable $($Arguments -join ' ')".Trim()
        })
    }
}

function Add-ManualCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Id,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if ($seenManual.Add($Description)) {
        $manualChecks.Add([ordered]@{
            id = $Id
            description = $Description
            required = $true
        })
    }
}

$hasRequestedWork = (
    @($classification.files).Count -gt 0 -or
    $Level -ne 'auto' -or
    $allTests.Count -gt 0
)

if ($hasRequestedWork) {
    Add-AutomatedCheck `
        -Id 'typescript-build' `
        -Label 'TypeScript build' `
        -WorkingDirectory $desktop `
        -Executable 'npm' `
        -Arguments @('run', 'build')
}

foreach ($test in ($allTests | Sort-Object)) {
    Add-AutomatedCheck `
        -Id "targeted-$($test -replace '[^a-zA-Z0-9]+', '-')" `
        -Label "Targeted test: $test" `
        -WorkingDirectory $desktop `
        -Executable 'node' `
        -Arguments @('--test', $test)
}

if ($hasRequestedWork -and $effectiveLevel -in @('full', 'runtime', 'package')) {
    Add-AutomatedCheck `
        -Id 'node-full-suite' `
        -Label 'Full Node test suite' `
        -WorkingDirectory $desktop `
        -Executable 'npm' `
        -Arguments @('test')
}

if ($hasRequestedWork -and $effectiveLevel -in @('runtime', 'package')) {
    Add-AutomatedCheck `
        -Id 'rust-check' `
        -Label 'Rust check' `
        -WorkingDirectory $tauri `
        -Executable 'cargo' `
        -Arguments @('check')
    Add-AutomatedCheck `
        -Id 'bridge-runtime' `
        -Label 'Sidecar bridge test' `
        -WorkingDirectory $tauri `
        -Executable 'cargo' `
        -Arguments @('run', '--', '--bridge-test')
    Add-AutomatedCheck `
        -Id 'boot-smoke' `
        -Label 'Boot smoke' `
        -WorkingDirectory $root `
        -Executable 'node' `
        -Arguments @('boot-smoke.js')
    Add-AutomatedCheck `
        -Id 'gui-smoke' `
        -Label 'GUI smoke' `
        -WorkingDirectory $root `
        -Executable 'node' `
        -Arguments @('gui-smoke.js')
}

if ($hasRequestedWork -and $effectiveLevel -eq 'package') {
    Add-AutomatedCheck `
        -Id 'update-smoke' `
        -Label 'Update smoke' `
        -WorkingDirectory $root `
        -Executable 'node' `
        -Arguments @('update-smoke.js')
    Add-AutomatedCheck `
        -Id 'upgrade-smoke' `
        -Label 'Upgrade smoke' `
        -WorkingDirectory $root `
        -Executable 'node' `
        -Arguments @('upgrade-test-441.js')
    Add-AutomatedCheck `
        -Id 'stage-resources' `
        -Label 'Stage Tauri resources' `
        -WorkingDirectory $root `
        -Executable 'node' `
        -Arguments @('tauri-shell/stage-resources.mjs')
    Add-AutomatedCheck `
        -Id 'tauri-package' `
        -Label 'Tauri package build' `
        -WorkingDirectory $tauri `
        -Executable 'npx' `
        -Arguments @('-y', '@tauri-apps/cli@2', 'build')
    Add-AutomatedCheck `
        -Id 'portable-package' `
        -Label 'Portable package' `
        -WorkingDirectory $tauri `
        -Executable 'node' `
        -Arguments @('make-portable.mjs')

    Add-ManualCheck -Id 'real-install' -Description '在干净目录完成真实安装、冷启动、退出和卸载验收。'
    Add-ManualCheck -Id 'portable-transaction' -Description '使用真实便携包执行 A→B 升级与故障 B→A 回退。'
    Add-ManualCheck -Id 'failure-injection' -Description '覆盖每个目录交换 checkpoint 的故障注入和重复恢复。'
    Add-ManualCheck -Id 'lock-and-process' -Description '覆盖文件锁、helper 中断、残留 PID 和退出零孤儿。'
    Add-ManualCheck -Id 'user-data-integrity' -Description '升级、失败和回退前后验证用户数据目录哈希不变。'
    Add-ManualCheck -Id 'host-environments' -Description '在中文或空格路径、非系统盘、低磁盘和普通用户权限下验收。'
}

foreach ($check in @($classification.smokeChecks)) {
    if (-not $check) {
        continue
    }
    if ($check -like 'MANUAL:*') {
        Add-ManualCheck `
            -Id "manual-$($manualChecks.Count + 1)" `
            -Description $check.Substring('MANUAL:'.Length).Trim()
    } elseif ($check -match '^node\s+--test\s+(.+)$') {
        Add-AutomatedCheck `
            -Id 'suggested-node-test' `
            -Label "Suggested smoke: $check" `
            -WorkingDirectory $root `
            -Executable 'node' `
            -Arguments @('--test', $Matches[1])
    } elseif ($check -match '^node\s+(.+)$') {
        Add-AutomatedCheck `
            -Id 'suggested-node-smoke' `
            -Label "Suggested smoke: $check" `
            -WorkingDirectory $root `
            -Executable 'node' `
            -Arguments @($Matches[1])
    } elseif ($check -match '^cd tauri-shell;\s*cargo\s+(.+)$') {
        Add-AutomatedCheck `
            -Id 'suggested-cargo-smoke' `
            -Label "Suggested smoke: $check" `
            -WorkingDirectory $tauri `
            -Executable 'cargo' `
            -Arguments @($Matches[1] -split '\s+')
    } elseif ($check -eq 'git diff --check') {
        Add-AutomatedCheck `
            -Id 'git-diff-check' `
            -Label 'Git whitespace check' `
            -WorkingDirectory $root `
            -Executable 'git' `
            -Arguments @('diff', '--check')
    } else {
        Add-ManualCheck `
            -Id "manual-$($manualChecks.Count + 1)" `
            -Description "执行分类器建议检查：$check"
    }
}

if ($classification.requiresSkillValidation) {
    Add-AutomatedCheck `
        -Id 'skill-self-check' `
        -Label 'Skill self validation' `
        -WorkingDirectory $skillRoot `
        -Executable $pwsh `
        -Arguments @(
            '-NoLogo',
            '-NoProfile',
            '-File',
            (Join-Path $PSScriptRoot 'validate-skill.ps1'),
            '-SkillPath',
            $skillRoot,
            '-RepoPath',
            $root
        )
}

$planErrors = [System.Collections.Generic.List[string]]::new()
if ($missingTests.Count -gt 0) {
    $planErrors.Add("Requested test paths are missing: $($missingTests -join ', ')")
}
if ($preflightRun.parseError) {
    $planErrors.Add("Unable to parse preflight output: $($preflightRun.parseError)")
} elseif ($preflightRun.exitCode -ne 0 -or -not $preflight -or $preflight.status -eq 'blocked') {
    $reasons = if ($preflight) { @($preflight.blockedReasons) -join '; ' } else { 'No structured preflight output.' }
    $planErrors.Add("Preflight blocked validation: $reasons")
}

$planStatus = if ($planErrors.Count -gt 0) {
    'blocked'
} elseif (-not $hasRequestedWork) {
    'no-changes'
} elseif ($manualChecks.Count -gt 0) {
    'planned-partial'
} else {
    'planned'
}

$planResult = [ordered]@{
    schemaVersion = 1
    status = $planStatus
    requestedLevel = $Level
    classifiedMinimumLevel = $classifiedLevel
    effectiveLevel = $effectiveLevel
    levelAdjusted = $levelAdjusted
    repoRoot = $root
    execute = [bool]$Execute
    classification = $classification
    preflight = $preflight
    automatedChecks = @($automatedChecks)
    manualChecks = @($manualChecks)
    unverifiedChecks = @($manualChecks)
    steps = @($automatedChecks | ForEach-Object {
        "[$($_.workingDirectory)] $($_.command)"
    })
    warnings = @(
        @($classification.warnings) +
        @($preflight.warnings)
    )
    errors = @($planErrors)
}

if (-not $Execute) {
    $planResult | ConvertTo-Json -Depth 10
    if ($planStatus -eq 'blocked') {
        exit 2
    }
    return
}

if ($planStatus -eq 'blocked') {
    $planResult | ConvertTo-Json -Depth 10
    exit 2
}

$completedChecks = [System.Collections.Generic.List[object]]::new()
foreach ($check in $automatedChecks) {
    Write-Host "== $($check.label) =="
    Push-Location $check.workingDirectory
    try {
        $global:LASTEXITCODE = 0
        & $check.executable @($check.arguments) 2>&1 |
            ForEach-Object { Write-Host $_ }
        $exitCode = $LASTEXITCODE
    } catch {
        $exitCode = if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }
        $completedChecks.Add([ordered]@{
            id = $check.id
            status = 'failed'
            exitCode = $exitCode
            error = $_.Exception.Message
        })
        [ordered]@{
            schemaVersion = 1
            status = 'failed'
            phase = 'automated-validation'
            requestedLevel = $Level
            classifiedMinimumLevel = $classifiedLevel
            effectiveLevel = $effectiveLevel
            levelAdjusted = $levelAdjusted
            completedChecks = @($completedChecks)
            manualChecks = @($manualChecks)
            unverifiedChecks = @($manualChecks)
            warnings = @($classification.warnings)
            errors = @($_.Exception.Message)
        } | ConvertTo-Json -Depth 8
        exit 3
    } finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        $completedChecks.Add([ordered]@{
            id = $check.id
            status = 'failed'
            exitCode = $exitCode
            error = "$($check.label) failed with exit code $exitCode"
        })
        [ordered]@{
            schemaVersion = 1
            status = 'failed'
            phase = 'automated-validation'
            requestedLevel = $Level
            classifiedMinimumLevel = $classifiedLevel
            effectiveLevel = $effectiveLevel
            levelAdjusted = $levelAdjusted
            completedChecks = @($completedChecks)
            manualChecks = @($manualChecks)
            unverifiedChecks = @($manualChecks)
            warnings = @($classification.warnings)
            errors = @("$($check.label) failed with exit code $exitCode")
        } | ConvertTo-Json -Depth 8
        exit 3
    }

    $completedChecks.Add([ordered]@{
        id = $check.id
        status = 'passed'
        exitCode = 0
        error = $null
    })
}

$finalStatus = if ($manualChecks.Count -gt 0) { 'partial' } else { 'passed' }
[ordered]@{
    schemaVersion = 1
    status = $finalStatus
    requestedLevel = $Level
    classifiedMinimumLevel = $classifiedLevel
    effectiveLevel = $effectiveLevel
    levelAdjusted = $levelAdjusted
    repoRoot = $root
    classification = $classification
    preflight = $preflight
    completedChecks = @($completedChecks)
    manualChecks = @($manualChecks)
    unverifiedChecks = @($manualChecks)
    warnings = @(
        @($classification.warnings) +
        @($preflight.warnings)
    )
    errors = @()
} | ConvertTo-Json -Depth 10

if ($finalStatus -eq 'partial') {
    exit 4
}
