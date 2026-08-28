param(
    [Parameter(Mandatory = $true)]
    [string]$SourceSkillPath,

    [Parameter(Mandatory = $true)]
    [string]$InstalledSkillPath
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $SourceSkillPath).Path
$installedRoot = (Resolve-Path -LiteralPath $InstalledSkillPath).Path
$missing = [System.Collections.Generic.List[string]]::new()
$extra = [System.Collections.Generic.List[string]]::new()
$different = [System.Collections.Generic.List[string]]::new()

function Get-RelativeFileMap {
    param([string]$Root)

    $map = @{}
    foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File) {
        $rootWithSeparator = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        $rootUri = New-Object Uri($rootWithSeparator)
        $fileUri = New-Object Uri($file.FullName)
        $relative = [Uri]::UnescapeDataString(
            $rootUri.MakeRelativeUri($fileUri).ToString()
        ) -replace '\\', '/'
        $map[$relative] = $file.FullName
    }
    return $map
}

$sourceFiles = Get-RelativeFileMap -Root $sourceRoot
$installedFiles = Get-RelativeFileMap -Root $installedRoot

foreach ($relative in $sourceFiles.Keys) {
    if (-not $installedFiles.ContainsKey($relative)) {
        $missing.Add($relative)
        continue
    }
    $sourceHash = (Get-FileHash -LiteralPath $sourceFiles[$relative] -Algorithm SHA256).Hash
    $installedHash = (Get-FileHash -LiteralPath $installedFiles[$relative] -Algorithm SHA256).Hash
    if ($sourceHash -ne $installedHash) {
        $different.Add($relative)
    }
}
foreach ($relative in $installedFiles.Keys) {
    if (-not $sourceFiles.ContainsKey($relative)) {
        $extra.Add($relative)
    }
}

$errors = [System.Collections.Generic.List[string]]::new()
if ($missing.Count -gt 0) {
    $errors.Add("Installed copy is missing files: $($missing -join ', ')")
}
if ($extra.Count -gt 0) {
    $errors.Add("Installed copy contains extra files: $($extra -join ', ')")
}
if ($different.Count -gt 0) {
    $errors.Add("Installed copy differs from source: $($different -join ', ')")
}
$status = if ($errors.Count -gt 0) { 'blocked' } else { 'ready' }

[ordered]@{
    schemaVersion = 1
    status = $status
    sourceSkillRoot = $sourceRoot
    installedSkillRoot = $installedRoot
    sourceFileCount = $sourceFiles.Count
    installedFileCount = $installedFiles.Count
    missingFiles = @($missing)
    extraFiles = @($extra)
    differentFiles = @($different)
    warnings = @()
    errors = @($errors)
} | ConvertTo-Json -Depth 6

if ($status -eq 'blocked') {
    exit 2
}
