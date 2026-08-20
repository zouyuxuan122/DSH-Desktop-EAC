$ErrorActionPreference = 'Continue'
$cache = Join-Path $env:LOCALAPPDATA 'electron\Cache'
$items = @(
  @{ name = 'winCodeSign-2.6.0.7z';    url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z' },
  @{ name = 'nsis-3.0.4.1.7z';         url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z' },
  @{ name = 'nsis-resources-3.4.1.7z'; url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z' }
)
foreach ($it in $items) {
  $dirUrl = $it.url -replace '/[^/]+$', ''
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($dirUrl))).Replace('-','').ToLowerInvariant()
  $dir = Join-Path $cache $hash
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $dest = Join-Path $dir $it.name
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    & curl.exe -L --ssl-no-revoke --retry 3 --retry-delay 2 -C - -o $dest $it.url 2>$null
    $size = (Get-Item $dest -ErrorAction SilentlyContinue).Length
    Write-Output ($it.name + ' attempt=' + $attempt + ' exit=' + $LASTEXITCODE + ' size=' + $size)
    if ($LASTEXITCODE -eq 0 -or ($size -gt 0 -and $LASTEXITCODE -eq 33)) { break }
  }
}
Write-Output '=== sha512 verify ==='
Get-ChildItem $cache -Recurse -File -Filter '*.7z' | Where-Object { $_.Name -like 'winCodeSign*' -or $_.Name -like 'nsis*' } | ForEach-Object {
  $sha512 = [System.Security.Cryptography.SHA512]::Create()
  $h = [System.BitConverter]::ToString($sha512.ComputeHash([System.IO.File]::ReadAllBytes($_.FullName))).Replace('-','').ToLowerInvariant()
  Write-Output ($_.Name + ' sha512=' + $h.Substring(0, 24))
}
Write-Output 'winCodeSign expect: cdaec7154dda7cc31f88d886'
Write-Output 'nsis expect:        9877df902530f96357d13a7a'
