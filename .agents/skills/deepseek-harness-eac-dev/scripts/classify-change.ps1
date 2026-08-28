param(
    [Parameter(Mandatory = $false)]
    [string]$RepoPath = (Get-Location).Path,

    [Parameter(Mandatory = $false)]
    [string[]]$Files,

    [Parameter(Mandatory = $false)]
    [string]$FilesJson,

    [Parameter(Mandatory = $false)]
    [string]$FilesJsonBase64
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepoPath).Path
$source = 'explicit-files'
$gitReadSucceeded = $null
$gitError = $null
$gitWarnings = [System.Collections.Generic.List[string]]::new()
$inputError = $null
$filesWereExplicit = (
    $PSBoundParameters.ContainsKey('Files') -or
    $PSBoundParameters.ContainsKey('FilesJson') -or
    $PSBoundParameters.ContainsKey('FilesJsonBase64')
)

function Invoke-GitRead {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GitPath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $GitPath
    $startInfo.Arguments = $Arguments -join ' '
    $startInfo.WorkingDirectory = (Get-Location).Path
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result

    return [ordered]@{
        exitCode = $process.ExitCode
        output = @($stdout -split "\r?\n" | Where-Object { $_ })
        error = @($stderr -split "\r?\n" | Where-Object { $_ })
    }
}

if ($FilesJson -and $FilesJsonBase64) {
    $inputError = 'Use either FilesJson or FilesJsonBase64, not both.'
}

if (-not $inputError -and $FilesJsonBase64) {
    try {
        $FilesJson = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String($FilesJsonBase64)
        )
    } catch {
        $inputError = "FilesJsonBase64 is invalid: $($_.Exception.Message)"
    }
}

if (-not $inputError -and $FilesJson) {
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
        $inputError = "FilesJson is invalid: $($_.Exception.Message)"
    }
}

if (-not $inputError -and $Files) {
    $normalizedFiles = [System.Collections.Generic.List[string]]::new()
    $index = 0
    foreach ($file in $Files) {
        if ([string]::IsNullOrWhiteSpace($file) -or $file -eq 'System.Object[]') {
            $inputError = "Files item $index is not a valid path string."
            break
        }
        $normalizedFiles.Add($file)
        $index += 1
    }
    if (-not $inputError) {
        $Files = [string[]]$normalizedFiles.ToArray()
    }
}

if ($inputError) {
    [ordered]@{
        schemaVersion = 1
        status = 'blocked'
        source = $source
        gitReadSucceeded = $null
        gitError = $null
        files = @()
        fileClassifications = @()
        unmatchedFiles = @()
        matchedRules = @()
        domains = @()
        references = @()
        alwaysRead = @('references/architecture.md', 'references/coding-conventions.md')
        minimumValidation = $null
        suggestedTests = @()
        missingSuggestedTests = @()
        smokeChecks = @()
        requiresSkillValidation = $false
        warnings = @()
        errors = @($inputError)
    } | ConvertTo-Json -Depth 6
    exit 2
}

if (-not $filesWereExplicit -and (-not $Files -or $Files.Count -eq 0)) {
    $source = 'git-worktree'
    Push-Location $root
    try {
        $gitCommand = Get-Command git -ErrorAction SilentlyContinue
        if (-not $gitCommand) {
            $gitError = 'Git command is unavailable.'
        } else {
            $insideRead = Invoke-GitRead `
                -GitPath $gitCommand.Source `
                -Arguments @('rev-parse', '--is-inside-work-tree')
            if ($insideRead.exitCode -ne 0 -or ($insideRead.output | Select-Object -First 1) -ne 'true') {
                $details = @($insideRead.error) -join '; '
                $gitError = if ($details) {
                    "Not a Git worktree: $root. $details"
                } else {
                    "Not a Git worktree: $root"
                }
            } else {
                foreach ($line in $insideRead.error) {
                    $gitWarnings.Add($line)
                }
                $collected = [System.Collections.Generic.List[string]]::new()
                $gitCommands = @(
                    @('diff', '--name-only'),
                    @('diff', '--cached', '--name-only'),
                    @('ls-files', '--others', '--exclude-standard')
                )
                foreach ($arguments in $gitCommands) {
                    $read = Invoke-GitRead `
                        -GitPath $gitCommand.Source `
                        -Arguments $arguments
                    if ($read.exitCode -ne 0) {
                        $details = @($read.error) -join '; '
                        $gitError = "Git read failed with exit code $($read.exitCode): git $($arguments -join ' ')"
                        if ($details) {
                            $gitError += ". $details"
                        }
                        break
                    }
                    foreach ($line in $read.error) {
                        $gitWarnings.Add($line)
                    }
                    foreach ($line in $read.output) {
                        if ($line) {
                            $collected.Add($line.ToString())
                        }
                    }
                }
                if (-not $gitError) {
                    $Files = @($collected | Sort-Object -Unique)
                    $gitReadSucceeded = $true
                }
            }
        }
    } finally {
        Pop-Location
    }
}

if ($gitError) {
    [ordered]@{
        schemaVersion = 1
        status = 'blocked'
        source = $source
        gitReadSucceeded = $false
        gitError = $gitError
        files = @()
        fileClassifications = @()
        unmatchedFiles = @()
        matchedRules = @()
        domains = @()
        references = @()
        alwaysRead = @('references/architecture.md', 'references/coding-conventions.md')
        minimumValidation = $null
        suggestedTests = @()
        missingSuggestedTests = @()
        smokeChecks = @()
        requiresSkillValidation = $false
        warnings = @()
        errors = @($gitError)
    } | ConvertTo-Json -Depth 6
    exit 2
}

$Files = @($Files | Where-Object { $_ })

$rulesPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'references\change-rules.psd1'
if (-not (Test-Path -LiteralPath $rulesPath -PathType Leaf)) {
    [ordered]@{
        schemaVersion = 1
        status = 'blocked'
        source = $source
        gitReadSucceeded = $gitReadSucceeded
        gitError = $null
        files = @($Files)
        fileClassifications = @()
        unmatchedFiles = @($Files)
        unmatchedCodeFiles = @($Files)
        unmatchedDocumentationFiles = @()
        matchedRules = @()
        domains = @()
        references = @()
        alwaysRead = @('references/architecture.md', 'references/coding-conventions.md')
        minimumValidation = $null
        suggestedTests = @()
        missingSuggestedTests = @()
        smokeChecks = @()
        requiresSkillValidation = $false
        warnings = @()
        errors = @("Change rules file is missing: $rulesPath")
    } | ConvertTo-Json -Depth 6
    exit 2
}
$rulesData = Import-PowerShellDataFile -LiteralPath $rulesPath
$rules = @($rulesData.Rules)

$levelRank = @{ targeted = 1; full = 2; runtime = 3; package = 4 }
$minimumLevel = 'targeted'
$domains = @{}
$tests = [System.Collections.Generic.HashSet[string]]::new()
$smoke = [System.Collections.Generic.HashSet[string]]::new()
$matchedRules = [System.Collections.Generic.HashSet[string]]::new()
$fileClassifications = [System.Collections.Generic.List[object]]::new()
$unmatchedFiles = [System.Collections.Generic.List[string]]::new()
$unmatchedCodeFiles = [System.Collections.Generic.List[string]]::new()
$unmatchedDocumentationFiles = [System.Collections.Generic.List[string]]::new()
$unmatchedOtherFiles = [System.Collections.Generic.List[string]]::new()
$requiresSkillValidation = $false
$rootSkillFile = Join-Path $root 'SKILL.md'
$isSkillSourceRoot = (
    (Split-Path -Leaf $root) -eq 'deepseek-harness-eac-dev' -and
    (Test-Path -LiteralPath $rootSkillFile -PathType Leaf) -and
    (Get-Content -Raw -Encoding UTF8 -LiteralPath $rootSkillFile) -match '(?m)^name:\s*deepseek-harness-eac-dev\s*$'
)
foreach ($file in $Files) {
    $normalized = $file -replace '\\', '/'
    $matchPath = if (
        $isSkillSourceRoot -and
        $normalized -match '^(SKILL\.md|agents/openai\.yaml|references/.*\.(md|psd1)|scripts/.*\.ps1|tests/.*\.ps1)$'
    ) {
        "deepseek-harness-eac-dev/$normalized"
    } else {
        $normalized
    }
    $fileRules = [System.Collections.Generic.List[string]]::new()
    $fileDomains = [System.Collections.Generic.HashSet[string]]::new()
    $fileReferences = [System.Collections.Generic.HashSet[string]]::new()
    $fileLevel = 'targeted'
    if ($normalized -match '^dsh-desktop/(test/.+\.test\.ts)$') {
        [void]$tests.Add($Matches[1])
    }
    $matchingRules = @($rules | Where-Object { $matchPath -match $_.Pattern })
    $exclusiveRules = @($matchingRules | Where-Object { $_.Exclusive })
    if ($exclusiveRules.Count -gt 0) {
        $matchingRules = $exclusiveRules
    }
    foreach ($rule in $matchingRules) {
        $domains[$rule.Domain] = $rule.Reference
        [void]$matchedRules.Add($rule.Name)
        $fileRules.Add($rule.Name)
        [void]$fileDomains.Add($rule.Domain)
        [void]$fileReferences.Add($rule.Reference)
        foreach ($test in $rule.Tests) { [void]$tests.Add($test) }
        foreach ($check in $rule.Smoke) { [void]$smoke.Add($check) }
        if ($rule.SelfCheck) {
            $requiresSkillValidation = $true
        }
        if ($levelRank[$rule.Level] -gt $levelRank[$minimumLevel]) {
            $minimumLevel = $rule.Level
        }
        if ($levelRank[$rule.Level] -gt $levelRank[$fileLevel]) {
            $fileLevel = $rule.Level
        }
    }
    $classificationStatus = 'matched'
    if ($fileRules.Count -eq 0) {
        $unmatchedFiles.Add($normalized)
        if ($normalized -match '\.(md|txt)$') {
            $unmatchedDocumentationFiles.Add($normalized)
            $classificationStatus = 'unmatched-documentation'
        } elseif (
            $normalized -match '\.(js|cjs|mjs|jsx|ts|tsx|rs|ps1|psm1|psd1|json|ya?ml|toml|nsh|xml|html|css|scss)$' -or
            $normalized -match '(^|/)(src|lib|scripts|\.github/workflows)(/|$)'
        ) {
            $unmatchedCodeFiles.Add($normalized)
            $classificationStatus = 'unmatched-code'
        } else {
            $unmatchedOtherFiles.Add($normalized)
            $classificationStatus = 'unmatched-other'
        }
    }
    $fileClassifications.Add([ordered]@{
        file = $normalized
        status = $classificationStatus
        matchedRules = @($fileRules)
        domains = @($fileDomains | Sort-Object)
        references = @($fileReferences | Sort-Object)
        minimumValidation = $fileLevel
    })
}

$missingSuggestedTests = [System.Collections.Generic.List[string]]::new()
foreach ($test in $tests) {
    if (-not (Test-Path -LiteralPath (Join-Path $root "dsh-desktop\$test"))) {
        $missingSuggestedTests.Add($test)
    }
}

$skillRoot = Split-Path -Parent $PSScriptRoot
$missingReferences = [System.Collections.Generic.List[string]]::new()
foreach ($reference in $domains.Values) {
    if (-not (Test-Path -LiteralPath (Join-Path $skillRoot $reference))) {
        $missingReferences.Add($reference)
    }
}

$errors = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
foreach ($gitWarning in $gitWarnings) {
    $warnings.Add("Git warning: $gitWarning")
}
if ($missingSuggestedTests.Count -gt 0) {
    $errors.Add("Suggested test paths are missing: $($missingSuggestedTests -join ', ')")
}
if ($missingReferences.Count -gt 0) {
    $errors.Add("Rule references are missing: $($missingReferences -join ', ')")
}
if ($unmatchedCodeFiles.Count -gt 0) {
    $errors.Add("Classification is incomplete for code or configuration files: $($unmatchedCodeFiles -join ', ')")
}
if ($unmatchedDocumentationFiles.Count -gt 0) {
    $warnings.Add("Documentation files did not match a specific rule: $($unmatchedDocumentationFiles -join ', ')")
}
if ($unmatchedOtherFiles.Count -gt 0) {
    $warnings.Add("Non-code files require manual impact review: $($unmatchedOtherFiles -join ', ')")
}
$status = if ($errors.Count -gt 0) { 'blocked' } else { 'ready' }

$result = [ordered]@{
    schemaVersion = 1
    status = $status
    source = $source
    gitReadSucceeded = $gitReadSucceeded
    gitError = $null
    files = @($Files)
    fileClassifications = @($fileClassifications)
    unmatchedFiles = @($unmatchedFiles)
    unmatchedCodeFiles = @($unmatchedCodeFiles)
    unmatchedDocumentationFiles = @($unmatchedDocumentationFiles)
    unmatchedOtherFiles = @($unmatchedOtherFiles)
    matchedRules = @($matchedRules | Sort-Object)
    domains = @($domains.Keys | Sort-Object)
    references = @($domains.Values | Sort-Object -Unique)
    alwaysRead = @('references/architecture.md', 'references/coding-conventions.md')
    minimumValidation = $minimumLevel
    suggestedTests = @($tests | Sort-Object)
    missingSuggestedTests = @($missingSuggestedTests)
    smokeChecks = @($smoke | Sort-Object)
    requiresSkillValidation = $requiresSkillValidation
    warnings = @($warnings)
    errors = @($errors)
}

$result | ConvertTo-Json -Depth 6
if ($status -eq 'blocked') {
    exit 2
}
