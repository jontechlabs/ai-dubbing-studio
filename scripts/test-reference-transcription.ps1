[CmdletBinding()]
param([string]$ExecutablePath)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ExecutablePath) { $ExecutablePath = Join-Path $repoRoot 'src-tauri/target/release/ai-dubbing-studio.exe' }
$testRoot = Join-Path $repoRoot '.cache/reference-transcription/Référence 日本語'
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
function Get-VerifiedFile([string]$url, [string]$path, [string]$sha256) {
    if (-not (Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
        Invoke-WebRequest -Uri $url -OutFile $path
    }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) { throw "Checksum mismatch: $path" }
}
$model = Join-Path $testRoot 'ggml-small-q5_1.bin'
$wav = Join-Path $testRoot 'ja.wav'
Get-VerifiedFile 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin' $model 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
Get-VerifiedFile 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/ja.wav' $wav '460bd8dccb0d2a5f4e29c628f837be4082d13defc64c3fc21dd1b6bb0e119095'
$raw = Join-Path $testRoot 'ja.f32'
& (Join-Path $repoRoot 'src-tauri/binaries/ffmpeg.exe') -hide_banner -loglevel error -i $wav -ac 1 -ar 16000 -f f32le -y $raw
if ($LASTEXITCODE) { throw 'Reference normalization failed' }
$proof = @()
foreach ($language in @('auto','ja')) {
    $result = Join-Path $testRoot "$language.json"
    $stdout = Join-Path $testRoot "$language.stdout.log"
    $stderr = Join-Path $testRoot "$language.stderr.log"
    $extendedModel = '\\?\' + [IO.Path]::GetFullPath($model)
    $arguments = @('--transcribe-reference', "`"$extendedModel`"", "`"$raw`"", $language, "`"$result`"")
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $worker = Start-Process -FilePath $ExecutablePath -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if (-not $worker.WaitForExit(180000)) { $worker.Kill(); throw 'Transcription worker deadline exceeded' }
    $worker.Refresh()
    if ($worker.ExitCode -ne 0) { Get-Content -LiteralPath $stderr -Tail 15; Get-Content -LiteralPath $stdout -Tail 5; throw "Transcription worker failed: $($worker.ExitCode)" }
    $text = (Get-Content -LiteralPath $result -Raw -Encoding utf8 | ConvertFrom-Json).text
    if (-not $text.Contains('中学')) { throw "Expected Japanese speech, got: $text" }
    $events = Get-Content -LiteralPath $stdout -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json }
    if (-not ($events | Where-Object stage -eq 'asrTranscribe')) { throw 'Missing structured progress' }
    $proof += [pscustomobject]@{language=$language; text=$text; seconds=[Math]::Round($watch.Elapsed.TotalSeconds,2); device='CPU'; extendedUnicodeModelPath=$true}
    Write-Output "Local Japanese transcription ($language): $text"
}
New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot 'artifacts') | Out-Null
$proof | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $repoRoot 'artifacts/reference-transcription-validation.json') -Encoding utf8
