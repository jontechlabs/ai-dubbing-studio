[CmdletBinding()]
param([string]$ArchivePath)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'resources/toolchain.json') -Raw | ConvertFrom-Json
$cacheRoot = Join-Path $repoRoot '.cache/ffmpeg'
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
if (-not $ArchivePath) {
    $ArchivePath = Join-Path $cacheRoot "ffmpeg-$($manifest.version).zip"
    $verifiedCache = (Test-Path -LiteralPath $ArchivePath -PathType Leaf) -and ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -eq $manifest.sha256)
    if (-not $verifiedCache) {
        foreach ($source in @($manifest.archiveUrl, $manifest.mirrorUrl) | Where-Object { $_ }) {
            $downloadPath = Join-Path $cacheRoot "download-$([guid]::NewGuid().ToString('N')).tmp"
            try {
                Write-Host "Downloading pinned FFmpeg $($manifest.version) from $(([uri]$source).Host)..."
                Invoke-WebRequest -Uri $source -OutFile $downloadPath -TimeoutSec 180 -MaximumRetryCount 2 -RetryIntervalSec 3
                if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'Downloaded archive checksum mismatch' }
                Move-Item -LiteralPath $downloadPath -Destination $ArchivePath -Force
                $verifiedCache = $true
                break
            } catch {
                Write-Warning "FFmpeg source $(([uri]$source).Host) failed or did not match the pinned checksum; trying the next official source."
            } finally {
                if (Test-Path -LiteralPath $downloadPath -PathType Leaf) { Remove-Item -LiteralPath $downloadPath -Force }
            }
        }
        if (-not $verifiedCache) { throw 'Pinned FFmpeg archive unavailable from all official sources. No binaries were installed.' }
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
