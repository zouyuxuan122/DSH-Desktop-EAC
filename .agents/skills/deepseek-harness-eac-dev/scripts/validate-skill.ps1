param(
    [Parameter(Mandatory = $false)]
    [string]$SkillPath = (Split-Path -Parent $PSScriptRoot),

    [Parameter(Mandatory = $false)]
    [string]$RepoPath,

    [Parameter(Mandatory = $false)]
    [switch]$SkipRuntimeMatrix
)

$ErrorActionPreference = 'Stop'
$skillRoot = (Resolve-Path -LiteralPath $SkillPath).Path
$repoRoot = if ($RepoPath) {
    (Resolve-Path -LiteralPath $RepoPath).Path
} else {
    $null
}

$errors = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$checkedReferences = [System.Collections.Generic.List[string]]::new()
$checkedScripts = [System.Collections.Generic.List[string]]::new()
$checkedTests = [System.Collections.Generic.List[string]]::new()
$currentPowerShellPath = (Get-Process -Id $PID).Path
$scriptTestResult = 'not-run'

function Add-Error {
    param([string]$Message)
    $errors.Add($Message)
}

function Add-Warning {
    param([string]$Message)
    $warnings.Add($Message)
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

function Get-CompatibleRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BasePath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPath
    )

    $baseFullPath = [IO.Path]::GetFullPath($BasePath)
    $targetFullPath = [IO.Path]::GetFullPath($TargetPath)
    $baseRoot = [IO.Path]::GetPathRoot($baseFullPath)
    $targetRoot = [IO.Path]::GetPathRoot($targetFullPath)
    if (-not [string]::Equals($baseRoot, $targetRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $targetFullPath
    }

    $trimCharacters = [char[]]@(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    $baseWithSeparator = (
        $baseFullPath.TrimEnd($trimCharacters) +
        [IO.Path]::DirectorySeparatorChar
    )
    $baseUri = New-Object System.Uri($baseWithSeparator)
    $targetUri = New-Object System.Uri($targetFullPath)
    $relative = [Uri]::UnescapeDataString(
        $baseUri.MakeRelativeUri($targetUri).ToString()
    )
    return $relative.Replace('/', [string][IO.Path]::DirectorySeparatorChar)
}

$skillFile = Join-Path $skillRoot 'SKILL.md'
$agentFile = Join-Path $skillRoot 'agents\openai.yaml'
foreach ($required in @($skillFile, $agentFile)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        Add-Error "Required Skill file is missing: $required"
    }
}

$skillContent = if (Test-Path -LiteralPath $skillFile) {
    Get-Content -Raw -Encoding UTF8 -LiteralPath $skillFile
} else {
    ''
}
$agentContent = if (Test-Path -LiteralPath $agentFile) {
    Get-Content -Raw -Encoding UTF8 -LiteralPath $agentFile
} else {
    ''
}

if ($skillContent -notmatch '(?s)\A---\r?\n.*?\r?\n---(?:\r?\n|\z)') {
    Add-Error 'SKILL.md is missing valid YAML frontmatter delimiters.'
}
if ($skillContent -notmatch '(?m)^name:\s*deepseek-harness-eac-dev\s*$') {
    Add-Error 'SKILL.md frontmatter name must be deepseek-harness-eac-dev.'
}
if ($skillContent -notmatch '(?m)^description:\s*\S.+$') {
    Add-Error 'SKILL.md frontmatter description is missing.'
}

foreach ($field in @('display_name', 'short_description', 'default_prompt')) {
    if ($agentContent -notmatch "(?m)^\s*$field\s*:\s*\S") {
        Add-Error "agents/openai.yaml is missing required field: $field"
    }
}

$referenceRoot = Join-Path $skillRoot 'references'
$allReferences = @()
if (-not (Test-Path -LiteralPath $referenceRoot -PathType Container)) {
    Add-Error "Required references directory is missing: $referenceRoot"
} else {
    $allReferences = @(
        Get-ChildItem -LiteralPath $referenceRoot -Filter '*.md' -File |
            ForEach-Object { "references/$($_.Name)" } |
            Sort-Object
    )
}

function Get-DocumentReferenceTargets {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Content,

        [Parameter(Mandatory = $true)]
        [string]$DocumentPath,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$KnownReferences
    )

    $targets = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($match in [regex]::Matches($Content, '`([^`\r\n]+\.md)`')) {
        $target = $match.Groups[1].Value -replace '#.*$', ''
        if ($target -like 'references/*.md') {
            [void]$targets.Add(($target -replace '\\', '/'))
        } elseif ($DocumentPath -like 'references/*') {
            $candidate = "references/$target" -replace '\\', '/'
            if ($candidate -in $KnownReferences) {
                [void]$targets.Add($candidate)
            }
        }
    }
    foreach ($match in [regex]::Matches($Content, '\[[^\]]*\]\(([^)\s]+\.md)(?:#[^)]*)?\)')) {
        $target = $match.Groups[1].Value.Trim('<', '>') -replace '#.*$', ''
        if ($target -like 'references/*.md') {
            [void]$targets.Add(($target -replace '\\', '/'))
        } elseif ($DocumentPath -like 'references/*' -and $target -notmatch '^[a-zA-Z]+:') {
            $baseDirectory = Split-Path -Parent $DocumentPath
            $candidateFullPath = [IO.Path]::GetFullPath(
                (Join-Path $skillRoot (Join-Path $baseDirectory $target))
            )
            $candidate = Get-CompatibleRelativePath `
                -BasePath $skillRoot `
                -TargetPath $candidateFullPath
            $candidate = $candidate -replace '\\', '/'
            if ($candidate -like 'references/*') {
                [void]$targets.Add($candidate)
            }
        }
    }
    return @($targets)
}

$documents = @{}
$documents['SKILL.md'] = $skillContent
foreach ($reference in $allReferences) {
    $documents[$reference] = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $skillRoot $reference)
}

$documentEdges = @{}
foreach ($document in $documents.Keys) {
    $targets = @(
        Get-DocumentReferenceTargets `
            -Content $documents[$document] `
            -DocumentPath $document `
            -KnownReferences $allReferences
    )
    $documentEdges[$document] = $targets
    foreach ($target in $targets) {
        if ($target -notin $allReferences) {
            Add-Error "Markdown reference is missing: $document -> $target"
        }
    }
}

$visitedDocuments = [System.Collections.Generic.HashSet[string]]::new()
$pendingDocuments = [System.Collections.Generic.Queue[string]]::new()
[void]$visitedDocuments.Add('SKILL.md')
$pendingDocuments.Enqueue('SKILL.md')
while ($pendingDocuments.Count -gt 0) {
    $document = $pendingDocuments.Dequeue()
    foreach ($target in @($documentEdges[$document])) {
        if ($target -in $allReferences -and $visitedDocuments.Add($target)) {
            $pendingDocuments.Enqueue($target)
        }
    }
}
foreach ($reference in $allReferences) {
    if ($reference -notin $visitedDocuments) {
        Add-Error "Reference is not reachable from SKILL.md: $reference"
    } else {
        $checkedReferences.Add($reference)
    }
}

$scriptRoot = Join-Path $skillRoot 'scripts'
$scriptFiles = @()
if (-not (Test-Path -LiteralPath $scriptRoot -PathType Container)) {
    Add-Error "Required scripts directory is missing: $scriptRoot"
} else {
    $scriptFiles = @(
        Get-ChildItem -LiteralPath $scriptRoot -Filter '*.ps1' -File |
            Sort-Object Name
    )
}
$testRoot = Join-Path $skillRoot 'tests'
$testScripts = if (Test-Path -LiteralPath $testRoot -PathType Container) {
    @(
        Get-ChildItem -LiteralPath $testRoot -Filter '*.ps1' -File |
            Sort-Object Name
    )
} else {
    @()
    Add-Error "Required tests directory is missing: $testRoot"
}
foreach ($script in @($scriptFiles) + @($testScripts)) {
    $checkedScripts.Add($script.Name)
    $scriptBytes = [IO.File]::ReadAllBytes($script.FullName)
    $hasUtf8Bom = (
        $scriptBytes.Length -ge 3 -and
        $scriptBytes[0] -eq 0xEF -and
        $scriptBytes[1] -eq 0xBB -and
        $scriptBytes[2] -eq 0xBF
    )
    if (-not $hasUtf8Bom) {
        Add-Error "$($script.Name) must use UTF-8 BOM for Windows PowerShell 5.1 compatibility."
    }
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $script.FullName,
        [ref]$tokens,
        [ref]$parseErrors
    )
    foreach ($parseError in @($parseErrors)) {
        Add-Error "$($script.Name):$($parseError.Extent.StartLineNumber): $($parseError.Message)"
    }
}

$rulesPath = Join-Path $referenceRoot 'change-rules.psd1'
$rules = @()
if (-not (Test-Path -LiteralPath $rulesPath -PathType Leaf)) {
    Add-Error "Change rules file is missing: $rulesPath"
} else {
    try {
        $rulesData = Import-PowerShellDataFile -LiteralPath $rulesPath
        if ($rulesData.SchemaVersion -ne 1) {
            Add-Error "Unsupported change-rules schema version: $($rulesData.SchemaVersion)"
        }
        $rules = @($rulesData.Rules)
    } catch {
        Add-Error "Unable to import change-rules.psd1: $($_.Exception.Message)"
    }
}

$ruleNames = [System.Collections.Generic.HashSet[string]]::new()
$allowedLevels = @('targeted', 'full', 'runtime', 'package')
foreach ($rule in $rules) {
    foreach ($field in @('Name', 'Domain', 'Pattern', 'Reference', 'Level', 'Tests', 'Smoke')) {
        if (-not $rule.ContainsKey($field)) {
            Add-Error "Change rule is missing field '$field': $($rule.Name)"
        }
    }
    if ($rule.Name -and -not $ruleNames.Add([string]$rule.Name)) {
        Add-Error "Duplicate change rule name: $($rule.Name)"
    }
    if ($rule.Level -and $rule.Level -notin $allowedLevels) {
        Add-Error "Change rule has invalid validation level '$($rule.Level)': $($rule.Name)"
    }
    if ($rule.Pattern) {
        try {
            [void](New-Object regex([string]$rule.Pattern))
        } catch {
            Add-Error "Change rule has invalid regex '$($rule.Pattern)': $($rule.Name)"
        }
    }
    if ($rule.Reference -and -not (Test-Path -LiteralPath (Join-Path $skillRoot $rule.Reference) -PathType Leaf)) {
        Add-Error "Change rule reference is missing: $($rule.Name) -> $($rule.Reference)"
    }
    foreach ($smoke in @($rule.Smoke)) {
        if ($smoke -isnot [string] -or [string]::IsNullOrWhiteSpace($smoke)) {
            Add-Error "Change rule has an invalid smoke entry: $($rule.Name)"
        }
    }
}

$parameterContracts = [ordered]@{
    'repo-preflight.ps1' = @('RepoPath', 'RequiredLevel')
    'repo-inventory.ps1' = @('RepoPath')
    'classify-change.ps1' = @('RepoPath', 'Files', 'FilesJson', 'FilesJsonBase64')
    'verify-change.ps1' = @('Level', 'RepoPath', 'Files', 'FilesJson', 'FilesJsonBase64', 'TestFiles', 'Execute')
    'git-audit.ps1' = @('RepoPath', 'BaseRef')
    'compare-skill-copy.ps1' = @('SourceSkillPath', 'InstalledSkillPath')
    'validate-skill.ps1' = @('SkillPath', 'RepoPath', 'SkipRuntimeMatrix')
}
foreach ($entry in $parameterContracts.GetEnumerator()) {
    $path = Join-Path $scriptRoot $entry.Key
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Add-Error "Script required by parameter contract is missing: $($entry.Key)"
        continue
    }
    $command = Get-Command $path
    foreach ($parameter in $entry.Value) {
        if (-not $command.Parameters.ContainsKey($parameter)) {
            Add-Error "$($entry.Key) is missing parameter: $parameter"
        }
    }
}

$classifierPath = Join-Path $scriptRoot 'classify-change.ps1'
if (Test-Path -LiteralPath $classifierPath -PathType Leaf) {
    $declaredTests = @(
        $rules |
            ForEach-Object { @($_.Tests) } |
            Where-Object { $_ -like 'test/*' } |
            Sort-Object
    )
    if ($repoRoot -and (Test-Path -LiteralPath (Join-Path $repoRoot 'dsh-desktop') -PathType Container)) {
        foreach ($test in $declaredTests) {
            $checkedTests.Add($test)
            if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "dsh-desktop\$test") -PathType Leaf)) {
                Add-Error "Classifier test path is missing: $test"
            }
        }
    } elseif ($declaredTests.Count -gt 0) {
        Add-Warning 'Repository path was not supplied or has no dsh-desktop directory; classifier test paths were not checked.'
    }

    $classifierFixtureFiles = @(
        'SKILL.md',
        'references/task-playbooks.md'
    )
    $classifierFixtureFilesJson = ConvertTo-JsonStringArray `
        -Values ([string[]]$classifierFixtureFiles)
    $classifierFixtureFilesJsonBase64 = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($classifierFixtureFilesJson)
    )
    $global:LASTEXITCODE = 0
    $classifierRaw = @(
        & $currentPowerShellPath -NoLogo -NoProfile -File $classifierPath `
            -RepoPath $skillRoot `
            -FilesJsonBase64 $classifierFixtureFilesJsonBase64
    ) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        Add-Error "Classifier output contract fixture failed with exit code $LASTEXITCODE."
    } else {
        try {
            $classifierFixture = $classifierRaw | ConvertFrom-Json
            foreach ($field in @(
                'schemaVersion',
                'status',
                'source',
                'gitReadSucceeded',
                'files',
                'fileClassifications',
                'unmatchedFiles',
                'minimumValidation',
                'requiresSkillValidation'
            )) {
                if ($field -notin $classifierFixture.PSObject.Properties.Name) {
                    Add-Error "Classifier output is missing field: $field"
                }
            }
            if (
                $classifierFixture.status -ne 'ready' -or
                'skill-maintenance' -notin @($classifierFixture.matchedRules) -or
                -not $classifierFixture.requiresSkillValidation -or
                @($classifierFixture.files).Count -ne 2 -or
                $classifierFixture.files[0] -ne $classifierFixtureFiles[0] -or
                $classifierFixture.files[1] -ne $classifierFixtureFiles[1]
            ) {
                Add-Error 'Classifier FilesJson fixture did not preserve two independent Skill-owned file paths.'
            }
        } catch {
            Add-Error "Classifier output is not valid JSON: $($_.Exception.Message)"
        }
    }
}

$verifyPath = Join-Path $scriptRoot 'verify-change.ps1'
if ($repoRoot -and (Test-Path -LiteralPath $verifyPath -PathType Leaf)) {
    $verifyFixtureFiles = @(
        '.agents/skills/deepseek-harness-eac-dev/SKILL.md',
        '.agents/skills/deepseek-harness-eac-dev/references/task-playbooks.md'
    )
    $verifyFixtureFilesJson = ConvertTo-JsonStringArray `
        -Values ([string[]]$verifyFixtureFiles)
    $verifyFixtureFilesJsonBase64 = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($verifyFixtureFilesJson)
    )
    $global:LASTEXITCODE = 0
    $verifyRaw = @(
        & $currentPowerShellPath -NoLogo -NoProfile -File $verifyPath `
            -RepoPath $repoRoot `
            -Level targeted `
            -FilesJsonBase64 $verifyFixtureFilesJsonBase64
    ) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        Add-Error "Verifier FilesJson fixture failed with exit code $LASTEXITCODE."
    } else {
        try {
            $verifyFixture = $verifyRaw | ConvertFrom-Json
            if (
                $verifyFixture.status -ne 'planned' -or
                @($verifyFixture.classification.files).Count -ne 2 -or
                $verifyFixture.classification.files[0] -ne $verifyFixtureFiles[0] -or
                $verifyFixture.classification.files[1] -ne $verifyFixtureFiles[1]
            ) {
                Add-Error 'Verifier FilesJson fixture did not preserve two independent file paths through classification.'
            }
        } catch {
            Add-Error "Verifier FilesJson fixture output is not valid JSON: $($_.Exception.Message)"
        }
    }
}

$testRunnerPath = Join-Path $testRoot 'run-tests.ps1'
if ($repoRoot -and (Test-Path -LiteralPath $testRunnerPath -PathType Leaf)) {
    $global:LASTEXITCODE = 0
    $testRaw = @(
        & $currentPowerShellPath -NoLogo -NoProfile -ExecutionPolicy Bypass `
            -File $testRunnerPath `
            -SkillPath $skillRoot `
            -RepoPath $repoRoot
    ) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        $scriptTestResult = 'failed'
        try {
            $testResult = $testRaw | ConvertFrom-Json
            Add-Error "Independent Skill script tests failed: $($testResult.errors -join '; ')"
        } catch {
            Add-Error "Independent Skill script tests failed with exit code $LASTEXITCODE."
        }
    } else {
        try {
            $testResult = $testRaw | ConvertFrom-Json
            if ($testResult.status -eq 'blocked') {
                $scriptTestResult = 'failed'
                Add-Error "Independent Skill script tests were blocked: $($testResult.errors -join '; ')"
            } else {
                $scriptTestResult = 'passed'
            }
        } catch {
            $scriptTestResult = 'failed'
            Add-Error "Independent Skill script test output is not valid JSON: $($_.Exception.Message)"
        }
    }
} elseif ($repoRoot) {
    $scriptTestResult = 'missing'
    Add-Error "Independent Skill script test runner is missing: $testRunnerPath"
} else {
    $scriptTestResult = 'skipped'
    Add-Warning 'Repository path was not supplied; independent Skill script tests were skipped.'
}

$smokeScripts = @(
    'boot-smoke.js',
    'gui-smoke.js',
    'update-smoke.js',
    'upgrade-test-441.js',
    'tauri-shell\stage-resources.mjs',
    'tauri-shell\make-portable.mjs'
)
if ($repoRoot) {
    foreach ($script in $smokeScripts) {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $script) -PathType Leaf)) {
            Add-Error "Validation script path is missing: $script"
        }
    }
}

$userCodexHome = if ($env:CODEX_HOME) {
    $env:CODEX_HOME
} else {
    Join-Path $env:USERPROFILE '.codex'
}
$officialValidator = Join-Path $userCodexHome 'skills\.system\skill-creator\scripts\quick_validate.py'
$python = Get-Command python -ErrorAction SilentlyContinue
$officialValidatorResult = 'not-run'
if ($python -and (Test-Path -LiteralPath $officialValidator -PathType Leaf)) {
    $global:LASTEXITCODE = 0
    $validatorOutput = @(
        & $python.Source -X utf8 $officialValidator $skillRoot 2>&1
    )
    if ($LASTEXITCODE -eq 0) {
        $officialValidatorResult = 'passed'
    } else {
        $officialValidatorResult = 'failed'
        Add-Error "Official Skill validator failed: $($validatorOutput -join "`n")"
    }
} else {
    Add-Warning 'Official Skill validator was not run because Python or quick_validate.py is unavailable.'
}

$ciPathCoverage = 'not-checked'
if ($repoRoot) {
    $relativeSkillPath = Get-CompatibleRelativePath `
        -BasePath $repoRoot `
        -TargetPath $skillRoot
    $relativeSkillPath = $relativeSkillPath -replace '\\', '/'
    $insideRepo = (
        $relativeSkillPath -ne '..' -and
        -not $relativeSkillPath.StartsWith('../') -and
        -not [IO.Path]::IsPathRooted($relativeSkillPath)
    )
    if (-not $insideRepo) {
        $ciPathCoverage = 'external-source'
        Add-Warning 'Skill source is outside the repository; repository CI paths cannot protect this copy.'
    } else {
        $workflowRoot = Join-Path $repoRoot '.github\workflows'
        $workflowContent = if (Test-Path -LiteralPath $workflowRoot -PathType Container) {
            @(
                Get-ChildItem -LiteralPath $workflowRoot -File |
                    ForEach-Object { Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName }
            ) -join "`n"
        } else {
            ''
        }
        $skillPrefix = ($relativeSkillPath.TrimEnd('/') + '/')
        if (
            $workflowContent -match [regex]::Escape($skillPrefix) -or
            $workflowContent -match '\.agents/skills/\*\*'
        ) {
            $ciPathCoverage = 'covered'
        } else {
            $ciPathCoverage = 'missing'
            Add-Warning "No workflow paths filter covers the installed Skill path: $relativeSkillPath"
        }
    }
}

$windowsPowerShell51 = 'not-checked'
$isWindowsPowerShell51 = (
    $PSVersionTable.PSVersion.Major -eq 5 -and
    $PSVersionTable.PSVersion.Minor -eq 1
)
if ($isWindowsPowerShell51) {
    $windowsPowerShell51 = 'current-runtime'
} elseif (-not $SkipRuntimeMatrix) {
    $windowsPowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $windowsPowerShellPath -PathType Leaf) {
        $runtimeArguments = @(
            '-NoLogo',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            $MyInvocation.MyCommand.Path,
            '-SkillPath',
            $skillRoot,
            '-SkipRuntimeMatrix'
        )
        if ($repoRoot) {
            $runtimeArguments += '-RepoPath'
            $runtimeArguments += $repoRoot
        }
        $global:LASTEXITCODE = 0
        $runtimeRaw = @(& $windowsPowerShellPath @runtimeArguments) -join "`n"
        $runtimeExitCode = $LASTEXITCODE
        if ($runtimeExitCode -ne 0) {
            $windowsPowerShell51 = 'failed'
            Add-Error "Windows PowerShell 5.1 Skill validation failed with exit code $runtimeExitCode."
        } else {
            try {
                $runtimeResult = $runtimeRaw | ConvertFrom-Json
                if ($runtimeResult.status -eq 'blocked') {
                    $windowsPowerShell51 = 'failed'
                    Add-Error "Windows PowerShell 5.1 Skill validation was blocked: $($runtimeResult.errors -join '; ')"
                } else {
                    $windowsPowerShell51 = 'passed'
                }
            } catch {
                $windowsPowerShell51 = 'failed'
                Add-Error "Windows PowerShell 5.1 output is not valid JSON: $($_.Exception.Message)"
            }
        }
    } else {
        $windowsPowerShell51 = 'unavailable'
        Add-Warning 'Windows PowerShell 5.1 is unavailable; compatibility validation was skipped.'
    }
} else {
    $windowsPowerShell51 = 'skipped'
}

$status = if ($errors.Count -gt 0) {
    'blocked'
} elseif ($warnings.Count -gt 0) {
    'warning'
} else {
    'ready'
}

[ordered]@{
    schemaVersion = 1
    status = $status
    ready = ($status -ne 'blocked')
    skillRoot = $skillRoot
    repoRoot = $repoRoot
    checkedReferences = @($checkedReferences)
    checkedScripts = @($checkedScripts)
    checkedTests = @($checkedTests)
    changeRules = [ordered]@{
        schemaVersion = $rulesData.SchemaVersion
        count = @($rules).Count
    }
    scriptTests = $scriptTestResult
    officialValidator = $officialValidatorResult
    ciPathCoverage = $ciPathCoverage
    currentPowerShell = [ordered]@{
        version = $PSVersionTable.PSVersion.ToString()
        edition = $PSVersionTable.PSEdition
        executable = $currentPowerShellPath
    }
    windowsPowerShell51 = $windowsPowerShell51
    warnings = @($warnings)
    errors = @($errors)
} | ConvertTo-Json -Depth 8

if ($status -eq 'blocked') {
    exit 2
}
