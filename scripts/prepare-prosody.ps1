[CmdletBinding()]
param([string]$ArchivePath)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'resources/prosody-toolchain.json') -Raw | ConvertFrom-Json
$cacheRoot = Join-Path $repoRoot '.cache/praat'
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
if (-not $ArchivePath) {
    $ArchivePath = Join-Path $cacheRoot 'praat6467_win-x64v1.zip'
    if (-not (Test-Path -LiteralPath $ArchivePath)) {
        Invoke-WebRequest -Uri $manifest.archiveUrl -OutFile $ArchivePath
    }
}
if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ne $manifest.sha256) {
    throw 'Praat checksum mismatch. No binaries were installed.'
}
$expanded = Join-Path $cacheRoot "prepared-$([guid]::NewGuid().ToString('N'))"
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $expanded
$executable = @(Get-ChildItem -LiteralPath $expanded -Filter Praat.exe -Recurse)
if ($executable.Count -ne 1) { throw 'Expected exactly one Praat.exe in the verified archive.' }
$destination = Join-Path $repoRoot 'src-tauri/binaries'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath $executable[0].FullName -Destination (Join-Path $destination 'praat.exe') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'resources/PRAAT-LICENSE.txt') -Destination (Join-Path $destination 'PRAAT-LICENSE.txt') -Force
Write-Host "Praat $($manifest.version) is ready for local CPU prosody transfer."
