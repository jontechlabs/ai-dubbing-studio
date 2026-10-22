# Finish validation of immutable packages when only the validation scripts changed.
# Refuse reuse if any application, worker, model manifest, dependency or asset differs.
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$buildHead='77600b73efb69ec9e7565ca286899bbddb2c9160'
$allowed=@('scripts/test-mcp.mjs','scripts/continue-package-validation.ps1','.github/workflows/continue-package-validation.yml')
$changed=@(git diff --name-only $buildHead HEAD)
if($LASTEXITCODE){throw 'Cannot compare application sources'}
foreach($name in $changed){if($name -notin $allowed){throw "Application source differs from the signed build: $name"}}
$download=Join-Path $repo '.cache/reused-build'
$sums=Get-ChildItem -LiteralPath $download -Filter SHA256SUMS.txt -Recurse -File | Where-Object {Test-Path -LiteralPath (Join-Path $_.Directory.FullName 'AI-Dubbing-Studio-Windows-Portable.zip')} | Select-Object -First 1
if(-not $sums){throw 'Immutable build artifact missing'}
$artifacts=Join-Path $repo 'artifacts'
New-Item -ItemType Directory -Force $artifacts | Out-Null
Get-ChildItem -LiteralPath $sums.Directory.FullName -File | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $artifacts}
foreach($line in (Get-Content -LiteralPath $sums.FullName)){
    $digest,$name=$line -split '  ',2
    if($name -notin @('AI-Dubbing-Studio-0.23.0-Setup.exe','AI-Dubbing-Studio-0.23.0-Setup.exe.sig','AI-Dubbing-Studio-Windows-Portable.zip')){throw 'Unexpected checksum entry'}
    if((Get-FileHash -LiteralPath (Join-Path $artifacts $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest){throw "Package changed: $name"}
}
$unpacked=Join-Path $repo '.cache/reused-portable'
Expand-Archive -LiteralPath (Join-Path $artifacts 'AI-Dubbing-Studio-Windows-Portable.zip') -DestinationPath $unpacked
$portable=Join-Path $unpacked 'AI-Dubbing-Studio-Windows'
$release=Join-Path $repo 'src-tauri/target/release'
New-Item -ItemType Directory -Force $release | Out-Null
Get-ChildItem -LiteralPath $portable -Force | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $release -Recurse}
Copy-Item -LiteralPath (Join-Path $release 'AI Dubbing Studio.exe') -Destination (Join-Path $release 'ai-dubbing-studio.exe')
New-Item -ItemType Directory -Force (Join-Path $repo 'src-tauri/binaries') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $portable 'binaries') -File | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $repo 'src-tauri/binaries')}
$proof=@{buildHead=$buildHead;buildRunId='39735610417';buildAttempt=2;artifactId='12408877433';validationHead=(git rev-parse HEAD).Trim();applicationTreeIdentical=$true;changedValidationFiles=$changed;packagesRebuilt=$false}
$proof | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $artifacts 'package-reuse-validation.json') -Encoding utf8
Write-Output 'Verified identical application sources and exact signed packages. Only validation scripts changed.'
