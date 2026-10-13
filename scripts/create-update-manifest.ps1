[CmdletBinding()]
param([Parameter(Mandatory)][string]$SignaturePath, [Parameter(Mandatory)][string]$InstallerUrl, [Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$version=(Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
if (-not $InstallerUrl.StartsWith('https://github.com/jontechlabs/ai-dubbing-studio/releases/download/')) { throw 'Unexpected installer host' }
$signature=(Get-Content -LiteralPath $SignaturePath -Raw).Trim()
if (-not $signature) { throw 'Missing updater signature' }
$manifest=@{ version=$version; notes='Séparation audio, lecteur optimisé, préférence GPU et mises à jour signées.'; pub_date=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); platforms=@{ 'windows-x86_64'=@{ url=$InstallerUrl; signature=$signature } } } | ConvertTo-Json -Depth 5
$destination=[IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
[IO.File]::WriteAllText($destination,$manifest + "`n",[Text.UTF8Encoding]::new($false))
