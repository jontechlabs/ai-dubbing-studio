[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$profileRoot = Join-Path $repoRoot '.cache/multilingual-validation'
New-Item -ItemType Directory -Force $profileRoot | Out-Null
# Reuse the CI CPU Torch 2.8 libraries; install the exact production headless
# dependency wheels into a separate environment. CUDA allocation is not tested.
python -m venv --system-site-packages (Join-Path $profileRoot 'python')
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
# Chatterbox's audio loading uses the matching TorchAudio backend.
python -m pip install torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE) { throw 'CPU TorchAudio installation failed' }
& $pythonPath -B (Join-Path $PSScriptRoot 'test-multilingual.py')
if ($LASTEXITCODE) { throw 'Actual multilingual inference failed' }
