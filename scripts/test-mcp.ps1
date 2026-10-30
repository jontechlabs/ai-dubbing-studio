[CmdletBinding()]
param([string]$PortablePath)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
if(-not $PortablePath){$PortablePath=Join-Path $repoRoot 'artifacts/AI-Dubbing-Studio-Windows-Portable.zip'}
$testRoot=Join-Path $repoRoot ".cache/mcp-native/$([guid]::NewGuid().ToString('N'))/Contrôle 日本語"
$dataRoot=Join-Path $testRoot 'session'
New-Item -ItemType Directory -Force $dataRoot | Out-Null
$speakerStore=Join-Path $repoRoot '.cache/speaker-separation-smoke/Référence 日本語/model-store'
$modelsRoot=$dataRoot
if(Test-Path -LiteralPath (Join-Path $speakerStore 'voice-engines/speaker-separation-runtime/ready.json')) {
    $modelsRoot=$speakerStore
    [IO.File]::WriteAllText((Join-Path $dataRoot 'model-storage.json'),(@{version=1;path=$speakerStore}|ConvertTo-Json -Compress))
}
$asrSource=Join-Path $repoRoot '.cache/reference-transcription/Référence 日本語/ggml-small-q5_1.bin'
if(Test-Path -LiteralPath $asrSource){
    $asrDirectory=Join-Path $modelsRoot 'whisper-reference'
    New-Item -ItemType Directory -Force $asrDirectory | Out-Null
    Copy-Item -LiteralPath $asrSource -Destination (Join-Path $asrDirectory 'ggml-small-q5_1.bin')
}
Expand-Archive -LiteralPath $PortablePath -DestinationPath $testRoot
$executable=Join-Path $testRoot 'AI-Dubbing-Studio-Windows/AI Dubbing Studio.exe'
[IO.File]::WriteAllText((Join-Path $dataRoot 'mcp-enabled'),'1')
$stdout=Join-Path $testRoot 'desktop.stdout.log'
$stderr=Join-Path $testRoot 'desktop.stderr.log'
$microphoneFile=Join-Path $dataRoot 'synthetic-microphone.wav'
$audioStream=[IO.File]::Create($microphoneFile)
$audioWriter=[IO.BinaryWriter]::new($audioStream)
try {
    $audioWriter.Write([Text.Encoding]::ASCII.GetBytes('RIFF'));$audioWriter.Write([uint32](36+48000));$audioWriter.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '));$audioWriter.Write([uint32]16);$audioWriter.Write([uint16]1);$audioWriter.Write([uint16]1);$audioWriter.Write([uint32]24000);$audioWriter.Write([uint32]48000);$audioWriter.Write([uint16]2);$audioWriter.Write([uint16]16);$audioWriter.Write([Text.Encoding]::ASCII.GetBytes('data'));$audioWriter.Write([uint32]48000)
    for($sample=0;$sample -lt 24000;$sample++){$audioWriter.Write([int16]([Math]::Sin($sample/24000*440*2*[Math]::PI)*6000))}
} finally {$audioWriter.Dispose();$audioStream.Dispose()}
# Fake capture switches must be set on WebView2 options, not its env variable.
$desktop=Start-Process -FilePath $executable -ArgumentList @('--ui-test',"`"$dataRoot`"",'--synthetic-microphone') -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr

try {
    $endpoint=Join-Path $dataRoot 'mcp-endpoint.json'
    $until=[DateTime]::UtcNow.AddSeconds(60)
    while(-not (Test-Path -LiteralPath $endpoint)){
        if($desktop.HasExited -or [DateTime]::UtcNow -ge $until){throw 'Desktop MCP did not start'}
        Start-Sleep -Milliseconds 250
    }
    node (Join-Path $PSScriptRoot 'test-mcp.mjs') --exe $executable --endpoint $endpoint --test-root $testRoot --movie (Join-Path $testRoot 'AI-Dubbing-Studio-Windows/demo/demo.mp4') --proof (Join-Path $repoRoot 'artifacts/mcp-native-validation.json')
    if($LASTEXITCODE){throw 'Official MCP SDK / packaged desktop diagnostic failed'}
} catch {
    if(Test-Path -LiteralPath $stderr){Get-Content -LiteralPath $stderr -Tail 15}
    if(Test-Path -LiteralPath $stdout){Get-Content -LiteralPath $stdout -Tail 10}
    throw
} finally {
    if(-not $desktop.HasExited){$desktop.Kill();$null=$desktop.WaitForExit(5000)}
}
