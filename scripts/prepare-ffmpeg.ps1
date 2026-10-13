[CmdletBinding()]
param([string]$ArchivePath)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'resources/toolchain.json') -Raw | ConvertFrom-Json
$cacheRoot = Join-Path $repoRoot '.cache/ffmpeg'
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
if (-not $ArchivePath) {
    $ArchivePath = Join-Path $cacheRoot "ffmpeg-$($manifest.version).zip"
    if (-not (Test-Path -LiteralPath $ArchivePath)) {
        Write-Host "Downloading FFmpeg $($manifest.version) from Gyan.dev..."
        Invoke-WebRequest -Uri $manifest.archiveUrl -OutFile $ArchivePath
    }
}
$actualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
if ($actualHash -ne $manifest.sha256) {
    throw "FFmpeg checksum mismatch. Expected $($manifest.sha256), got $actualHash. No binaries were installed."
}
$expandedRoot = Join-Path $cacheRoot "extracted-$([guid]::NewGuid().ToString('N'))"
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $expandedRoot
$upstreamRoot = Join-Path $expandedRoot "ffmpeg-$($manifest.version)-essentials_build"
$destination = Join-Path $repoRoot 'src-tauri/binaries'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $upstreamRoot "bin/$name") -PathType Leaf)) { throw "Archive is missing $name" }
}
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
    Copy-Item -LiteralPath (Join-Path $upstreamRoot "bin/$name") -Destination (Join-Path $destination $name) -Force
}
Copy-Item -LiteralPath (Join-Path $upstreamRoot 'LICENSE') -Destination (Join-Path $destination 'FFMPEG-LICENSE.txt') -Force
Write-Host "FFmpeg and FFprobe $($manifest.version) are ready in src-tauri/binaries."
