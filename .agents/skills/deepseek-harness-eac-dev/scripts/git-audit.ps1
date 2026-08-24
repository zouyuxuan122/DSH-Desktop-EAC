param(
    [Parameter(Mandatory = $false)]
    [string]$RepoPath = (Get-Location).Path,

    [Parameter(Mandatory = $false)]
    [string]$BaseRef = 'origin/main'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepoPath).Path

Push-Location $root
try {
    if ((git rev-parse --is-inside-work-tree 2>$null) -ne 'true') {
        throw "Not a Git worktree: $root"
    }

    $branch = (git branch --show-current).Trim()
    $head = (git rev-parse --short HEAD).Trim()
    $statusLines = @(git status --porcelain=v1)
    $stagedPaths = @(git diff --cached --name-only --diff-filter=ACMR)
    $remotes = @(git remote -v)
    $warnings = [System.Collections.Generic.List[string]]::new()
    $errors = [System.Collections.Generic.List[string]]::new()

    $staged = 0
    $unstaged = 0
    $untracked = 0
    $conflicts = 0
    foreach ($line in $statusLines) {
        if (-not $line) { continue }
        if ($line.StartsWith('??')) {
            $untracked += 1
            continue
        }
        $x = $line.Substring(0, 1)
        $y = $line.Substring(1, 1)
        if ($x -ne ' ') { $staged += 1 }
        if ($y -ne ' ') { $unstaged += 1 }
        if (($x + $y) -in @('DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU')) {
            $conflicts += 1
        }
    }

    if (-not $branch) {
        $errors.Add('HEAD is detached.')
    } elseif ($branch -eq 'main') {
        $warnings.Add('Current branch is main; team changes should use a task branch.')
    } elseif ($branch -notmatch '^(feat|fix|refactor|test|docs|chore|build|ci|release|hotfix|codex)/[a-z0-9][a-z0-9._-]*$') {
        $warnings.Add("Branch name does not match the team convention: $branch")
    }

    if ($conflicts -gt 0) {
        $errors.Add("Worktree contains $conflicts unresolved conflict(s).")
    }

    $behind = $null
    $ahead = $null
    git rev-parse --verify $BaseRef 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $counts = ((git rev-list --left-right --count "$BaseRef...HEAD").Trim() -split '\s+')
        if ($counts.Count -ge 2) {
            $behind = [int]$counts[0]
            $ahead = [int]$counts[1]
        }
        if ($behind -gt 0) {
            $warnings.Add("Branch is behind $BaseRef by $behind commit(s).")
        }
    } else {
        $warnings.Add("Base ref is unavailable: $BaseRef")
    }

    $dangerousStaged = [System.Collections.Generic.List[string]]::new()
    $largeStaged = [System.Collections.Generic.List[object]]::new()
    $secretCandidates = [System.Collections.Generic.List[string]]::new()
    $dangerPattern = '(^|/)(node_modules|target|dist|sessions|profiles|\.dsh)(/|$)|(^|/)\.env($|\.)|\.log$|diagnostic.*\.zip$'
    $secretPattern = '(?i)(sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{12,}|AKIA[A-Z0-9]{12,}|api[_-]?key\s*[:=]|client[_-]?secret\s*[:=]|authorization\s*[:=]\s*bearer)'

    foreach ($path in $stagedPaths) {
        $normalized = $path -replace '\\', '/'
        if ($normalized -match $dangerPattern) {
            $dangerousStaged.Add($normalized)
        }
        $full = Join-Path $root $path
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $size = (Get-Item -LiteralPath $full).Length
            if ($size -gt 5MB) {
                $largeStaged.Add([ordered]@{ path = $normalized; bytes = $size })
            }
        }
        try {
            $content = @(git show ":$path" 2>$null) -join "`n"
            if ($content -match $secretPattern) {
                $secretCandidates.Add($normalized)
            }
        } catch {
            # Binary or unreadable staged files are covered by size and path checks.
        }
    }

    if ($dangerousStaged.Count -gt 0) {
        $errors.Add('Staged paths include generated, runtime, user-data, log, or environment files.')
    }
    if ($largeStaged.Count -gt 0) {
        $warnings.Add("Staged content includes $($largeStaged.Count) file(s) larger than 5 MiB.")
    }
    if ($secretCandidates.Count -gt 0) {
        $warnings.Add('Staged content contains possible secret patterns; review manually.')
    }

    $originFetch = @($remotes | Where-Object { $_ -match '^origin\s+.+\(fetch\)$' })
    $originPush = @($remotes | Where-Object { $_ -match '^origin\s+.+\(push\)$' })

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
        repoRoot = $root
        head = $head
        branch = $branch
        detached = [bool](-not $branch)
        baseRef = $BaseRef
        ahead = $ahead
        behind = $behind
        worktree = [ordered]@{
            staged = $staged
            unstaged = $unstaged
            untracked = $untracked
            conflicts = $conflicts
        }
        stagedPaths = @($stagedPaths)
        dangerousStagedPaths = @($dangerousStaged)
        largeStagedFiles = @($largeStaged)
        secretCandidateFiles = @($secretCandidates)
        gitConfig = [ordered]@{
            autocrlf = (git config --get core.autocrlf)
            pullRebase = (git config --get pull.rebase)
        }
        remotes = [ordered]@{
            originFetch = @($originFetch)
            originPush = @($originPush)
        }
        warnings = @($warnings)
        errors = @($errors)
        readyForCommitReview = [bool](
            $errors.Count -eq 0 -and
            $conflicts -eq 0 -and
            $staged -gt 0 -and
            $branch -and
            $branch -ne 'main'
        )
    } | ConvertTo-Json -Depth 8
} finally {
    Pop-Location
}

if ($errors.Count -gt 0) {
    exit 2
}
