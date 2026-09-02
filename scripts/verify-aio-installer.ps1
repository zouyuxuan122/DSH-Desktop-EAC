[CmdletBinding()]
param(
    [string]$ProjectRoot = '',
    [int]$InstallTimeoutSeconds = 300,
    [int]$StartupTimeoutSeconds = 240,
    [int]$UninstallTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$installer = Join-Path $ProjectRoot 'dist\DSHEAC-AIO-v1-Setup-x64.exe'
$verificationRoot = Join-Path $ProjectRoot 'verification'
$runId = '{0}-{1}-{2}' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), $PID, ([guid]::NewGuid().ToString('N').Substring(0, 8))
# Keep the E2E root short enough for NSIS/node_modules while still testing
# spaces and non-ASCII installation paths. Reports remain under the project.
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ("aio-" + $runId.Substring($runId.Length - 8))
$installRoot = Join-Path $runRoot '安装目录 AIO'
$isolatedHome = Join-Path $runRoot 'isolated-dsh-home'
$isolatedUserData = Join-Path $runRoot 'isolated-user-data'
$reportPath = Join-Path $verificationRoot "verification-$runId.json"
$appProcess = $null
$installProcess = $null
$uninstallProcess = $null
$stage = 'initialization'
$failure = $null
$report = [ordered]@{
    edition = 'AIO'
    editionMeaning = 'All-in-One'
    release = 'v1'
    technicalSemVer = '1.0.0'
    verifiedAt = (Get-Date).ToString('o')
    installer = $installer
    installDirectory = $installRoot
    result = 'RUNNING'
}

function Wait-ProcessBounded([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds, [string]$Label) {
    if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
        try { & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F | Out-Null } catch {}
        throw "$Label timed out after $TimeoutSeconds seconds."
    }
    return $Process.ExitCode
}

function Test-HttpReady([string]$Url, [int]$TimeoutSec = 1) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
        return [ordered]@{
            ok = $true
            status = [int]$response.StatusCode
            length = [int64]$response.RawContentLength
        }
    } catch {
        return [ordered]@{ ok = $false; error = $_.Exception.Message }
    }
}

function Get-ListenerPid([int]$Port) {
    try {
        $row = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
        if ($null -ne $row) { return [int]$row.OwningProcess }
    } catch {}
    return 0
}

function Test-ProcessInTree([int]$CandidatePid, [int]$RootPid) {
    if ($CandidatePid -le 0 -or $RootPid -le 0) { return $false }
    $seen = @{}
    $current = $CandidatePid
    while ($current -gt 0 -and -not $seen.ContainsKey($current)) {
        if ($current -eq $RootPid) { return $true }
        $seen[$current] = $true
        try {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop
            if ($null -eq $proc) { return $false }
            $current = [int]$proc.ParentProcessId
        } catch { return $false }
    }
    return $false
}

function Get-OptionalProperty($Object, [string]$Name) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-AioUninstallEntries {
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    $entries = @()
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
            $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if ($null -eq $item) { continue }
            $displayName = Get-OptionalProperty $item 'DisplayName'
            if ($displayName -eq 'DSHEAC AIO' -or $displayName -eq 'DSHEAC AIO v1') {
                $entries += [pscustomobject]@{
                    key = $key.Name
                    displayName = $displayName
                    installLocation = Get-OptionalProperty $item 'InstallLocation'
                    uninstallString = Get-OptionalProperty $item 'UninstallString'
                }
            }
        }
    }
    return @($entries)
}

function Get-LogTail([string]$Path, [int]$Lines = 120) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    try { return (Get-Content -LiteralPath $Path -Encoding UTF8 -Tail $Lines -ErrorAction Stop) -join "`n" } catch { return '' }
}

New-Item -ItemType Directory -Path $verificationRoot -Force | Out-Null
try {
    if (-not (Test-Path -LiteralPath $installer)) { throw "Installer not found: $installer" }
    if (Test-Path -LiteralPath $runRoot) { throw "Refusing to reuse test directory: $runRoot" }
    New-Item -ItemType Directory -Path $runRoot | Out-Null

    $report.installerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
    $report.installerBytes = (Get-Item -LiteralPath $installer).Length

    # Coexistence is conditional: absence of the original product is N/A, not failure.
    $originalPidsBefore = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'Deepseek Harness EAC v4Lite.exe'
    } | Select-Object -ExpandProperty ProcessId | ForEach-Object { [int]$_ })
    $report.originalLite = [ordered]@{
        applicable = $originalPidsBefore.Count -gt 0
        pidsBefore = $originalPidsBefore
        runningBefore = $originalPidsBefore.Count -gt 0
    }

    $stage = 'install'
    Write-Host '[1/7] Installing DSHEAC AIO v1 silently into a Unicode path...'
    $installTimer = [Diagnostics.Stopwatch]::StartNew()
    $installProcess = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -PassThru
    $installExit = Wait-ProcessBounded $installProcess $InstallTimeoutSeconds 'Installer'
    $installTimer.Stop()
    $report.install = [ordered]@{ exitCode = $installExit; elapsedMs = $installTimer.ElapsedMilliseconds }
    if ($installExit -ne 0) { throw "Installer exited with code $installExit" }

    $stage = 'payload'
    Write-Host '[2/7] Validating installed payload and release identity...'
    $appExe = Join-Path $installRoot 'DSHEAC AIO.exe'
    $requiredFiles = @(
        $appExe,
        (Join-Path $installRoot 'resources\node\node.exe'),
        (Join-Path $installRoot 'resources\npm\bin\npm-cli.js'),
        (Join-Path $installRoot 'resources\app\sidecar\dist\shell-host.js'),
        (Join-Path $installRoot 'resources\app\assets\plugins\dsh-composer-dynamic-island\package.json'),
        (Join-Path $installRoot 'resources\app\assets\plugins\dsh-composer-dynamic-island\lib\client.js'),
        (Join-Path $installRoot 'resources\app\assets\plugins\dsh-composer-dynamic-island\dsh-plugin.json'),
        (Join-Path $installRoot 'resources\app\assets\plugins\dsh-composer-dynamic-island\EAC-VENDOR.json'),
        (Join-Path $installRoot 'resources\profile-seed\profiles\web-desktop\node_modules\@dsh-external\dsh-webui\package.json'),
        (Join-Path $installRoot 'resources\profile-seed\profiles\web-desktop\node_modules\dsh-usage-skill\package.json')
    )
    $missingFiles = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missingFiles.Count -gt 0) { throw "Installed payload is incomplete: $($missingFiles -join ', ')" }
    $reparsePoints = @(Get-ChildItem -LiteralPath $installRoot -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName)
    if ($reparsePoints.Count -gt 0) { throw "Installed payload contains reparse points: $($reparsePoints -join ', ')" }
    $payloadMeasure = Get-ChildItem -LiteralPath $installRoot -Recurse -File -Force | Measure-Object Length -Sum
    $registryEntries = @(Get-AioUninstallEntries)
    if ($registryEntries.Count -eq 0) { throw 'AIO uninstall registry entry was not created.' }
    $expectedInstallLocation = [IO.Path]::GetFullPath($installRoot).TrimEnd('\')
    $foreignRegistryEntry = @($registryEntries | Where-Object {
        if (-not $_.installLocation) { return $true }
        $actual = [IO.Path]::GetFullPath(([string]$_.installLocation).Trim('"')).TrimEnd('\')
        return -not [string]::Equals($actual, $expectedInstallLocation, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($foreignRegistryEntry.Count -gt 0) { throw 'AIO uninstall registry entry points outside the AIO install root.' }
    $report.payload = [ordered]@{
        fileCount = $payloadMeasure.Count
        bytes = [int64]$payloadMeasure.Sum
        missing = $missingFiles
        reparsePoints = $reparsePoints
        uninstallRegistry = $registryEntries
    }

    $stage = 'startup'
    Write-Host '[3/7] Starting the GUI with isolated data and a minimal PATH...'
    $saved = [ordered]@{
        DSH_HOME = $env:DSH_HOME
        DSH_DESKTOP_USERDATA = $env:DSH_DESKTOP_USERDATA
        DSH_DESKTOP_SKIP_PLUGIN_UPDATE = $env:DSH_DESKTOP_SKIP_PLUGIN_UPDATE
        DSH_DESKTOP_TEST_NO_SHORTCUTS = $env:DSH_DESKTOP_TEST_NO_SHORTCUTS
        PATH = $env:PATH
    }
    $env:DSH_HOME = $isolatedHome
    $env:DSH_DESKTOP_USERDATA = $isolatedUserData
    $env:DSH_DESKTOP_SKIP_PLUGIN_UPDATE = '1'
    $env:DSH_DESKTOP_TEST_NO_SHORTCUTS = '1'
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    try {
        $startTimer = [Diagnostics.Stopwatch]::StartNew()
        $appProcess = Start-Process -FilePath $appExe -WorkingDirectory $installRoot -PassThru
        $settingsJson = Join-Path $isolatedUserData 'settings.json'
        $testHealth = $null
        $webPort = 0
        $listenerPid = 0
        $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 400
            if ($appProcess.HasExited) { break }
            if (Test-Path -LiteralPath $settingsJson) {
                try {
                    $settings = Get-Content -Raw -LiteralPath $settingsJson | ConvertFrom-Json
                    $webPort = [int]$settings.webPort
                } catch {}
            }
            if ($webPort -gt 0) {
                $testHealth = Test-HttpReady "http://127.0.0.1:$webPort/" 1
                if ($testHealth.ok) {
                    $listenerPid = Get-ListenerPid $webPort
                    if (Test-ProcessInTree $listenerPid $appProcess.Id) { break }
                }
            }
        }
        $startTimer.Stop()
        if ($appProcess.HasExited) { throw "GUI exited early with code $($appProcess.ExitCode)." }
        if ($webPort -le 0 -or -not $testHealth -or -not $testHealth.ok) {
            throw 'The DSH web service did not become HTTP-ready before the deadline.'
        }
        if (-not (Test-ProcessInTree $listenerPid $appProcess.Id)) {
            throw "Port $webPort is not owned by the launched application process tree (listener PID $listenerPid)."
        }
        $report.startup = [ordered]@{
            elapsedMs = $startTimer.ElapsedMilliseconds
            appPid = $appProcess.Id
            webPort = $webPort
            listenerPid = $listenerPid
            health = $testHealth
            listenerBelongsToAppTree = $true
            minimalPath = $env:PATH
        }

        $stage = 'seed-and-privacy'
        Write-Host '[4/7] Verifying first-run profile seeding and privacy exclusions...'
        $profilePackage = Join-Path $isolatedHome 'profiles\web-desktop\package.json'
        if (-not (Test-Path -LiteralPath $profilePackage)) { throw 'The isolated profile snapshot was not seeded.' }
        $packageJson = Get-Content -Raw -LiteralPath $profilePackage | ConvertFrom-Json
        $dependencyNames = @($packageJson.dependencies.psobject.Properties.Name)
        $requiredPackages = @(
            '@dsh-external/dsh-webui', '@local/dsh-webui-statem-bridge',
            '@ha-na-bi/dsh-client-ui-custom', 'dsh-usage-skill', 'dsh-find-plugin',
            'dsh-plugin-wallpaper-engine', 'dsh-status-rotator'
        )
        $missingPackages = @($requiredPackages | Where-Object { $_ -notin $dependencyNames })
        if ($missingPackages.Count -gt 0) { throw "Expected profile packages are missing: $($missingPackages -join ', ')" }

        $islandProfileRoot = Join-Path $isolatedHome 'profiles\web-desktop\node_modules\dsh-composer-dynamic-island'
        $requiredIslandFiles = @(
            (Join-Path $islandProfileRoot 'package.json'),
            (Join-Path $islandProfileRoot 'lib\client.js'),
            (Join-Path $islandProfileRoot 'dsh-plugin.json'),
            (Join-Path $islandProfileRoot 'docs\COMPATIBILITY.md'),
            (Join-Path $islandProfileRoot 'EAC-VENDOR.json')
        )
        $missingIslandFiles = @($requiredIslandFiles | Where-Object { -not (Test-Path -LiteralPath $_) })
        if ($missingIslandFiles.Count -gt 0) {
            throw "Composer Dynamic Island was not copied into the first-run profile: $($missingIslandFiles -join ', ')"
        }
        $profilePatchText = Get-Content -Raw -LiteralPath (Join-Path $isolatedHome 'profiles\web-desktop\cordis.patch.yml')
        $islandPatchRows = [regex]::Matches($profilePatchText, '(?m)^\s*- id: composer-dynamic-island\s*$').Count
        if ($islandPatchRows -ne 1 -or $profilePatchText -notmatch "(?m)^\s*name: 'dsh-composer-dynamic-island'\s*$") {
            throw "Composer Dynamic Island profile patch is missing or duplicated (rows=$islandPatchRows)."
        }
        $builtinMarker = Get-Content -Raw -LiteralPath (Join-Path $isolatedHome 'profiles\web-desktop\.dsh-builtin-plugins.json') | ConvertFrom-Json
        if ('dsh-composer-dynamic-island' -notin @($builtinMarker.names)) {
            throw 'Composer Dynamic Island is absent from the built-in plugin marker.'
        }

        $publicSettingsFile = Join-Path $isolatedHome 'settings.yaml'
        $publicSettingsText = Get-Content -Raw -LiteralPath $publicSettingsFile
        $forbiddenSeedMetadata = @(
            (Join-Path $isolatedHome 'profiles\web-desktop\node_modules\.modules.yaml'),
            (Join-Path $isolatedHome 'profiles\web-desktop\node_modules\.pnpm-workspace-state-v1.json'),
            (Join-Path $isolatedHome 'profiles\web-desktop\node_modules\.pnpm\lock.yaml')
        )
        $retainedSeedMetadata = @($forbiddenSeedMetadata | Where-Object { Test-Path -LiteralPath $_ })
        if ($retainedSeedMetadata.Count -gt 0) {
            throw "Installed profile retained machine-local pnpm metadata: $($retainedSeedMetadata -join ', ')"
        }
        $forbiddenPublicSettings = [ordered]@{
            agentDefaultModel = '(?m)^agent-default-model:'
            providerCatalog = '(?m)^llm-pi-ai:'
            providerUrl = '(?i)vulcanapi\.com'
            apiEnvironmentName = '(?i)Q_API_KEY|DEEPSEEK_API_KEY'
            previousModelCatalog = '(?i)deepseek-v4-(flash|pro)'
            originalWorkspace = '(?i)H:[\\/]CODEX'
            originalUserProfile = '(?i)C:[\\/]Users[\\/]32621|\.dsh-v4lite'
        }
        $foundPrivateSettings = @()
        foreach ($entry in $forbiddenPublicSettings.GetEnumerator()) {
            if ($publicSettingsText -match $entry.Value) { $foundPrivateSettings += $entry.Key }
        }
        if ($foundPrivateSettings.Count -gt 0) {
            throw "Public installation retained private settings: $($foundPrivateSettings -join ', ')"
        }
        $report.profile = [ordered]@{
            requiredPackages = $requiredPackages
            missingPackages = $missingPackages
            composerDynamicIsland = [ordered]@{
                missingFiles = $missingIslandFiles
                patchRows = $islandPatchRows
                builtin = $true
            }
            privateSettingsFound = $foundPrivateSettings
            retainedMachineMetadata = $retainedSeedMetadata
        }

        $stage = 'coexistence'
        Write-Host '[5/7] Checking coexistence with the original Lite when applicable...'
        if ($originalPidsBefore.Count -gt 0) {
            $originalPidsAfter = @(Get-CimInstance Win32_Process | Where-Object {
                $_.Name -eq 'Deepseek Harness EAC v4Lite.exe'
            } | Select-Object -ExpandProperty ProcessId | ForEach-Object { [int]$_ })
            $continuousPids = @($originalPidsBefore | Where-Object { $_ -in $originalPidsAfter })
            $report.originalLite.pidsAfter = $originalPidsAfter
            $report.originalLite.continuousPids = $continuousPids
            $report.originalLite.runningAfter = $originalPidsAfter.Count -gt 0
            $report.originalLite.continuity = if ($continuousPids.Count -gt 0) { 'continuous' } elseif ($originalPidsAfter.Count -gt 0) { 'product restarted; no AIO kill target exists' } else { 'stopped' }
            if ($originalPidsAfter.Count -eq 0) { throw 'The original Lite product is no longer running.' }
        } else {
            $report.originalLite.status = 'N/A - original Lite was not running'
        }
    } finally {
        if ($null -ne $appProcess -and -not $appProcess.HasExited) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $appProcess.Id /T /F | Out-Null
            $appProcess.WaitForExit(15000) | Out-Null
        }
        $env:DSH_HOME = $saved.DSH_HOME
        $env:DSH_DESKTOP_USERDATA = $saved.DSH_DESKTOP_USERDATA
        $env:DSH_DESKTOP_SKIP_PLUGIN_UPDATE = $saved.DSH_DESKTOP_SKIP_PLUGIN_UPDATE
        $env:DSH_DESKTOP_TEST_NO_SHORTCUTS = $saved.DSH_DESKTOP_TEST_NO_SHORTCUTS
        $env:PATH = $saved.PATH
    }

    $stage = 'uninstall'
    Write-Host '[6/7] Uninstalling silently and checking filesystem/process/port residue...'
    $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter 'uninstall*.exe' -File | Select-Object -First 1
    if ($null -eq $uninstaller) { throw 'Uninstaller was not found in the installed payload.' }
    $uninstallTimer = [Diagnostics.Stopwatch]::StartNew()
    $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S') -PassThru
    $uninstallExit = Wait-ProcessBounded $uninstallProcess $UninstallTimeoutSeconds 'Uninstaller'
    if ($uninstallExit -ne 0) { throw "Uninstaller exited with code $uninstallExit" }
    # NSIS launches a temporary self-copy; the original launcher can exit before
    # the copy finishes deleting uninstall.exe and the install root.
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds($UninstallTimeoutSeconds)
    do {
        $installResidue = Test-Path -LiteralPath $installRoot
        $processResidue = @(Get-Process -Name 'DSHEAC AIO' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
        $portResidue = if ($report.Contains('startup')) { Get-ListenerPid ([int]$report.startup.webPort) } else { 0 }
        if (-not $installResidue -and $processResidue.Count -eq 0 -and $portResidue -le 0) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $cleanupDeadline)
    $uninstallTimer.Stop()
    if ($installResidue -or $processResidue.Count -gt 0 -or $portResidue -gt 0) {
        throw "Uninstall residue detected: installDir=$installResidue processes=$($processResidue -join ',') listenerPid=$portResidue"
    }
    if (-not (Test-Path -LiteralPath $isolatedHome) -or -not (Test-Path -LiteralPath $isolatedUserData)) {
        throw 'Silent uninstall did not preserve external user data as required.'
    }
    $registryResidue = @(Get-AioUninstallEntries)
    if ($registryResidue.Count -gt 0) { throw 'AIO uninstall registry entry remained after uninstall.' }
    $report.uninstall = [ordered]@{
        exitCode = $uninstallExit
        elapsedMs = $uninstallTimer.ElapsedMilliseconds
        installDirectoryExists = $installResidue
        processResidue = $processResidue
        listenerPidResidue = $portResidue
        externalUserDataPreserved = $true
        registryResidue = $registryResidue
    }

    $stage = 'report'
    Write-Host '[7/7] Writing verification report...'
    $report.result = 'PASS'
} catch {
    $failure = $_
    $report.result = 'FAIL'
    $report.failedStage = $stage
    $report.error = [ordered]@{
        message = $_.Exception.Message
        type = $_.Exception.GetType().FullName
        stack = $_.ScriptStackTrace
    }
} finally {
    if ($null -ne $appProcess -and -not $appProcess.HasExited) {
        try { & "$env:SystemRoot\System32\taskkill.exe" /PID $appProcess.Id /T /F | Out-Null } catch {}
    }
    $report.logs = [ordered]@{
        desktopTail = Get-LogTail (Join-Path $isolatedUserData 'logs\desktop.log')
        dshWebTail = Get-LogTail (Join-Path $isolatedUserData 'logs\dsh-web.log')
        sidecarTail = Get-LogTail (Join-Path $isolatedUserData 'logs\sidecar.log')
    }
    $report.completedAt = (Get-Date).ToString('o')
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
}

if ($null -ne $failure) {
    Write-Error "Verification failed at stage '$stage': $($failure.Exception.Message). Report: $reportPath"
    exit 1
}
Write-Host "Verification passed: $reportPath"
