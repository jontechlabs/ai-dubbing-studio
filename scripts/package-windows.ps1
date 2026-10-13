[CmdletBinding()]
param([string]$ExecutablePath, [string]$InstallerPath, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$version = $config.version
if (-not $ExecutablePath) { $ExecutablePath = Join-Path $repoRoot 'src-tauri/target/release/ai-dubbing-studio.exe' }
if (-not $InstallerPath) { $InstallerPath = Join-Path $repoRoot "src-tauri/target/release/bundle/nsis/AI Dubbing Studio_${version}_x64-setup.exe" }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'artifacts' }
foreach ($file in @($ExecutablePath, $InstallerPath, (Join-Path $repoRoot 'src-tauri/binaries/ffmpeg.exe'), (Join-Path $repoRoot 'src-tauri/binaries/ffprobe.exe'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing build input: $file. Run prepare-ffmpeg.ps1 and pnpm desktop:build first." }
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stageParent = Join-Path $repoRoot ".cache/package-$([guid]::NewGuid().ToString('N'))"
$portable = Join-Path $stageParent 'AI-Dubbing-Studio-Windows'
New-Item -ItemType Directory -Force -Path (Join-Path $portable 'binaries'), (Join-Path $portable 'demo') | Out-Null
Copy-Item -LiteralPath $ExecutablePath -Destination (Join-Path $portable 'AI Dubbing Studio.exe')
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe', 'FFMPEG-LICENSE.txt')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "src-tauri/binaries/$name") -Destination (Join-Path $portable "binaries/$name")
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'public/demo.mp4') -Destination (Join-Path $portable 'demo/demo.mp4')
foreach ($name in @('README.md', 'README.fr.md', 'VALIDATION.md', 'THIRD-PARTY-NOTICES.txt')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $name) -Destination (Join-Path $portable $name)
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs') -Destination (Join-Path $portable 'docs') -Recurse
$setupName = "AI-Dubbing-Studio-$version-Setup.exe"
$portableName = 'AI-Dubbing-Studio-Windows-Portable.zip'
Copy-Item -LiteralPath $InstallerPath -Destination (Join-Path $OutputDirectory $setupName) -Force
Compress-Archive -LiteralPath $portable -DestinationPath (Join-Path $OutputDirectory $portableName) -Force
$hashLines = foreach ($name in @($setupName, $portableName)) {
    "$((Get-FileHash -LiteralPath (Join-Path $OutputDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant())  $name"
}
[IO.File]::WriteAllLines((Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'SHA256SUMS.txt'), $hashLines, [Text.UTF8Encoding]::new($false))
Write-Host "Windows release packages and SHA256SUMS.txt are ready in $OutputDirectory"
