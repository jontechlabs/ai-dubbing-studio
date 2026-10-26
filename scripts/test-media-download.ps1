# Exercise the real preparation script with test-owned archives and mocked HTTP.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path $repoRoot ".cache/media-download-checks/$([guid]::NewGuid().ToString('N'))"
$seedRoot = Join-Path $testRoot 'seed/ffmpeg-9.0.2-essentials_build'
New-Item -ItemType Directory -Force (Join-Path $seedRoot 'bin') | Out-Null
foreach ($name in @('ffmpeg.exe','ffprobe.exe')) { [IO.File]::WriteAllText((Join-Path $seedRoot "bin/$name"), "synthetic-$name") }
[IO.File]::WriteAllText((Join-Path $seedRoot 'LICENSE'), 'Synthetic test license')
$seedZip = Join-Path $testRoot 'verified.zip'
Compress-Archive -LiteralPath $seedRoot -DestinationPath $seedZip
$seedHash = (Get-FileHash -LiteralPath $seedZip -Algorithm SHA256).Hash
$calls = [Collections.Generic.List[string]]::new()
Set-Item Function:\Invoke-WebRequest -Value {
    param($Uri, $OutFile, $TimeoutSec, $MaximumRetryCount, $RetryIntervalSec)
    $calls.Add([string]$Uri)
    if (([uri]$Uri).Host -eq 'primary.invalid') { throw 'Synthetic HTTP 503' }
    Copy-Item -LiteralPath $seedZip -Destination $OutFile
}.GetNewClosure()
function New-Fixture([string]$name, [string]$hash) {
    $fixtureRoot = Join-Path $testRoot $name
    foreach ($dir in @('scripts','resources','src-tauri/binaries','.cache/ffmpeg')) { New-Item -ItemType Directory -Force (Join-Path $fixtureRoot $dir) | Out-Null }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'prepare-ffmpeg.ps1') -Destination (Join-Path $fixtureRoot 'scripts/prepare-ffmpeg.ps1')
    @{version='9.0.2';archiveUrl='https://primary.invalid/archive.zip';mirrorUrl='https://mirror.invalid/archive.zip';sha256=$hash} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRoot 'resources/toolchain.json') -Encoding utf8NoBOM
    return $fixtureRoot
}
$good = New-Fixture 'fallback' $seedHash
[IO.File]::WriteAllText((Join-Path $good '.cache/ffmpeg/ffmpeg-9.0.2.zip'), 'partial cache')
& (Join-Path $good 'scripts/prepare-ffmpeg.ps1')
if ($calls.Count -ne 2 -or $calls[0] -notmatch 'primary.invalid' -or $calls[1] -notmatch 'mirror.invalid') { throw 'Official source fallback was not used' }
foreach ($name in @('ffmpeg.exe','ffprobe.exe')) { if ([IO.File]::ReadAllText((Join-Path $good "src-tauri/binaries/$name")) -ne "synthetic-$name") { throw 'Wrong extracted binary' } }
Write-Host 'PASS: unavailable primary and partial cache recover through a verified mirror'
$calls.Clear()
& (Join-Path $good 'scripts/prepare-ffmpeg.ps1')
if ($calls.Count) { throw 'Verified cached archive downloaded again' }
Write-Host 'PASS: verified cache is reused without downloading'
$bad = New-Fixture 'bad-hash' ('0' * 64)
[IO.File]::WriteAllText((Join-Path $bad 'src-tauri/binaries/ffmpeg.exe'), 'original')
$failed = $false
try { & (Join-Path $bad 'scripts/prepare-ffmpeg.ps1') } catch { $failed = $true }
if (-not $failed -or [IO.File]::ReadAllText((Join-Path $bad 'src-tauri/binaries/ffmpeg.exe')) -ne 'original') { throw 'Bad checksum replaced existing binaries' }
Write-Host 'PASS: wrong mirror checksum cannot replace installed binaries'
$calls.Clear(); $failed = $false
try { & (Join-Path $bad 'scripts/prepare-ffmpeg.ps1') -ArchivePath $seedZip } catch { $failed = $true }
if (-not $failed -or $calls.Count) { throw 'Explicit archive failure triggered an unwanted download' }
Write-Host 'PASS: explicit archive checksum failure is preserved without downloading'
