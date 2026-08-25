param(
    [Parameter(Mandatory = $false)]
    [string]$SkillPath,

    [Parameter(Mandatory = $true)]
    [string]$RepoPath
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($SkillPath)) {
    $SkillPath = Split-Path -Parent $PSScriptRoot
}
$skillRoot = (Resolve-Path -LiteralPath $SkillPath).Path
$repoRoot = (Resolve-Path -LiteralPath $RepoPath).Path
$scripts = Join-Path $skillRoot 'scripts'
$shell = (Get-Process -Id $PID).Path
$failures = [System.Collections.Generic.List[string]]::new()
$passed = [System.Collections.Generic.List[string]]::new()

function Invoke-JsonFixture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Script,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $global:LASTEXITCODE = 0
    $raw = @(
        & $shell -NoLogo -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $scripts $Script) @Arguments
    )
    $exitCode = $LASTEXITCODE
    $text = $raw -join "`n"
    try {
        $data = $text | ConvertFrom-Json
    } catch {
        return [ordered]@{
            exitCode = $exitCode
            data = $null
            parseError = $_.Exception.Message
            raw = $text
        }
    }
    return [ordered]@{
        exitCode = $exitCode
        data = $data
        parseError = $null
        raw = $text
    }
}

function ConvertTo-FilesJsonBase64 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Json
    )

    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Json))
}

function Assert-Fixture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Failure
    )

    if ($Condition) {
        $passed.Add($Name)
    } else {
        $failures.Add("$Name`: $Failure")
    }
}

$classifyFiles = '["SKILL.md","references/task-playbooks.md"]'
$classify = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
    '-RepoPath', $skillRoot,
    '-FilesJsonBase64', (ConvertTo-FilesJsonBase64 $classifyFiles)
)
Assert-Fixture -Name 'classify-files-json' -Condition (
    $classify.exitCode -eq 0 -and
    $classify.data.schemaVersion -eq 1 -and
    $classify.data.status -eq 'ready' -and
    @($classify.data.files).Count -eq 2 -and
    $classify.data.files[0] -eq 'SKILL.md' -and
    $classify.data.files[1] -eq 'references/task-playbooks.md'
) -Failure ($classify.raw)

$nested = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
    '-RepoPath', $skillRoot,
    '-FilesJsonBase64', (ConvertTo-FilesJsonBase64 '[["SKILL.md"]]')
)
Assert-Fixture -Name 'reject-nested-files-json' -Condition (
    $nested.exitCode -eq 2 -and
    $nested.data.status -eq 'blocked'
) -Failure ($nested.raw)

$dependencyPatch = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-FilesJsonBase64',
    (ConvertTo-FilesJsonBase64 '["dsh-desktop/scripts/patch-deps.js","dsh-desktop/node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js","tauri-shell/stage-resources.mjs"]')
)
Assert-Fixture -Name 'dependency-patch-chain' -Condition (
    $dependencyPatch.exitCode -eq 0 -and
    $dependencyPatch.data.minimumValidation -eq 'package' -and
    'dependency-patches' -in @($dependencyPatch.data.matchedRules) -and
    @($dependencyPatch.data.unmatchedCodeFiles).Count -eq 0
) -Failure ($dependencyPatch.raw)

$tauriPackaging = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-FilesJsonBase64',
    (ConvertTo-FilesJsonBase64 '["tauri-shell/audit-linux-bundle.mjs","tauri-shell/stage-platform-cache.mjs","tauri-shell/tauri.linux.conf.json","tauri-shell/gen/schemas/linux-schema.json"]')
)
Assert-Fixture -Name 'tauri-packaging-root-files' -Condition (
    $tauriPackaging.exitCode -eq 0 -and
    $tauriPackaging.data.status -eq 'ready' -and
    $tauriPackaging.data.minimumValidation -eq 'package' -and
    'packaging' -in @($tauriPackaging.data.matchedRules) -and
    @($tauriPackaging.data.unmatchedCodeFiles).Count -eq 0
) -Failure ($tauriPackaging.raw)

$unknownCode = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-FilesJsonBase64', (ConvertTo-FilesJsonBase64 '["experimental/unknown-maintenance.ts"]')
)
Assert-Fixture -Name 'block-unmatched-code' -Condition (
    $unknownCode.exitCode -eq 2 -and
    $unknownCode.data.status -eq 'blocked' -and
    'experimental/unknown-maintenance.ts' -in @($unknownCode.data.unmatchedCodeFiles)
) -Failure ($unknownCode.raw)

$documentation = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-FilesJsonBase64', (ConvertTo-FilesJsonBase64 '["docs/HANDOVER-FIXTURE.md"]')
)
Assert-Fixture -Name 'documentation-rule' -Condition (
    $documentation.exitCode -eq 0 -and
    $documentation.data.status -eq 'ready' -and
    'documentation' -in @($documentation.data.matchedRules)
) -Failure ($documentation.raw)

$typescriptTest = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-FilesJsonBase64', (ConvertTo-FilesJsonBase64 '["dsh-desktop/test/preset-sync.test.ts"]')
)
Assert-Fixture -Name 'typescript-test-path' -Condition (
    $typescriptTest.exitCode -eq 0 -and
    $typescriptTest.data.status -eq 'ready' -and
    'test/preset-sync.test.ts' -in @($typescriptTest.data.suggestedTests) -and
    @($typescriptTest.data.missingSuggestedTests).Count -eq 0
) -Failure ($typescriptTest.raw)

$skillReference = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-FilesJsonBase64',
    (ConvertTo-FilesJsonBase64 '[".agents/skills/deepseek-harness-eac-dev/references/presets-and-profile.md"]')
)
Assert-Fixture -Name 'skill-rule-exclusive' -Condition (
    $skillReference.exitCode -eq 0 -and
    $skillReference.data.minimumValidation -eq 'targeted' -and
    @($skillReference.data.matchedRules).Count -eq 1 -and
    'skill-maintenance' -in @($skillReference.data.matchedRules)
) -Failure ($skillReference.raw)

$ciWorkflow = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-FilesJsonBase64', (ConvertTo-FilesJsonBase64 '[".github/workflows/ci.yml"]')
)
Assert-Fixture -Name 'ci-workflow-not-release' -Condition (
    $ciWorkflow.exitCode -eq 0 -and
    $ciWorkflow.data.minimumValidation -eq 'targeted' -and
    'ci-workflow' -in @($ciWorkflow.data.matchedRules) -and
    'release' -notin @($ciWorkflow.data.matchedRules)
) -Failure ($ciWorkflow.raw)

$verify = Invoke-JsonFixture -Script 'verify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-FilesJsonBase64',
    (ConvertTo-FilesJsonBase64 '[".agents/skills/deepseek-harness-eac-dev/SKILL.md",".agents/skills/deepseek-harness-eac-dev/references/task-playbooks.md"]')
)
Assert-Fixture -Name 'verify-files-json' -Condition (
    $verify.exitCode -eq 0 -and
    $verify.data.schemaVersion -eq 1 -and
    $verify.data.status -eq 'planned' -and
    @($verify.data.classification.files).Count -eq 2
) -Failure ($verify.raw)

$levelFloor = Invoke-JsonFixture -Script 'verify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-Level', 'targeted',
    '-FilesJsonBase64', (ConvertTo-FilesJsonBase64 '["dsh-desktop/lib/desktop/balance.ts"]')
)
Assert-Fixture -Name 'validation-level-floor' -Condition (
    $levelFloor.exitCode -eq 0 -and
    $levelFloor.data.classifiedMinimumLevel -eq 'full' -and
    $levelFloor.data.effectiveLevel -eq 'full' -and
    $levelFloor.data.levelAdjusted
) -Failure ($levelFloor.raw)

$partialPlan = Invoke-JsonFixture -Script 'verify-change.ps1' -Arguments @(
    '-RepoPath', $repoRoot,
    '-FilesJsonBase64', (ConvertTo-FilesJsonBase64 '[".gitattributes"]')
)
Assert-Fixture -Name 'manual-check-plan' -Condition (
    $partialPlan.exitCode -eq 0 -and
    $partialPlan.data.status -eq 'planned-partial' -and
    @($partialPlan.data.unverifiedChecks).Count -gt 0
) -Failure ($partialPlan.raw)

$nonGit = Join-Path $env:TEMP ('eac-skill-non-git-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $nonGit -Force | Out-Null
try {
    $gitFailure = Invoke-JsonFixture -Script 'classify-change.ps1' -Arguments @(
        '-RepoPath', $nonGit
    )
    Assert-Fixture -Name 'git-read-blocked' -Condition (
        $gitFailure.exitCode -eq 2 -and
        $gitFailure.data.status -eq 'blocked' -and
        -not $gitFailure.data.gitReadSucceeded
    ) -Failure ($gitFailure.raw)
} finally {
    $resolved = (Resolve-Path -LiteralPath $nonGit).Path
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP)
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

$status = if ($failures.Count -gt 0) { 'blocked' } else { 'ready' }
[ordered]@{
    schemaVersion = 1
    status = $status
    runtime = [ordered]@{
        version = $PSVersionTable.PSVersion.ToString()
        edition = $PSVersionTable.PSEdition
        executable = $shell
    }
    passed = @($passed)
    warnings = @()
    errors = @($failures)
} | ConvertTo-Json -Depth 8

if ($failures.Count -gt 0) {
    exit 2
}
