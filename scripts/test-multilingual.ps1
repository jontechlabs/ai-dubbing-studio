[CmdletBinding()]
param([switch]$VoiceConversionOnly)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$profileRoot = Join-Path $repoRoot '.cache/multilingual-validation'
New-Item -ItemType Directory -Force $profileRoot | Out-Null
# Start without inherited site-packages: the profile must provide every
# dependency. CPU Torch replaces only the three CUDA wheels for this runner.
python -m venv (Join-Path $profileRoot 'python')
if ($LASTEXITCODE) { throw 'Cannot prepare multilingual test environment' }
$requirements = @()
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'workers/multilingual-runtime.json') -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
    if ($file.name -match '^(torch|torchvision|torchaudio)-') { continue }
    $source = if ($file.bundledPath) { (Join-Path $repoRoot ('workers/' + $file.bundledPath)) } else { $file.url }
    $requirements += "$source --hash=sha256:$($file.sha256)"
}
$requirementsPath = Join-Path $profileRoot 'requirements.txt'
$requirements | Set-Content -LiteralPath $requirementsPath -Encoding utf8
$pythonPath = Join-Path $profileRoot 'python/Scripts/python.exe'
& $pythonPath -m pip install --no-deps --require-hashes -r $requirementsPath
if ($LASTEXITCODE) { throw 'Pinned headless dependency installation failed' }
& $pythonPath -m pip install --no-deps torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE) { throw 'CPU Torch profile installation failed' }
if (-not $VoiceConversionOnly) {
    & $pythonPath -B (Join-Path $PSScriptRoot 'test-multilingual.py')
    if ($LASTEXITCODE) { throw 'Actual multilingual inference failed' }
} elseif (-not (Test-Path -LiteralPath (Join-Path $profileRoot 'chatterbox-multilingual-v3-standalone.wav'))) {
    throw 'Authenticated Standard source audio must be restored before VC-only validation'
}

& $pythonPath -B (Join-Path $PSScriptRoot 'test-voice-conversion.py')
if ($LASTEXITCODE) { throw 'Actual offline voice conversion failed' }
