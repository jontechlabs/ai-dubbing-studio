[CmdletBinding()]
param([string]$PortablePath)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
if(-not $PortablePath){$PortablePath=Join-Path $repoRoot 'artifacts/AI-Dubbing-Studio-Windows-Portable.zip'}
$testRoot=Join-Path $repoRoot ".cache/mcp-native/$([guid]::NewGuid().ToString('N'))/Contrôle 日本語"
$dataRoot=Join-Path $testRoot 'session'
New-Item -ItemType Directory -Force $dataRoot | Out-Null
Expand-Archive -LiteralPath $PortablePath -DestinationPath $testRoot
$executable=Join-Path $testRoot 'AI-Dubbing-Studio-Windows/AI Dubbing Studio.exe'
[IO.File]::WriteAllText((Join-Path $dataRoot 'mcp-enabled'),'1')
$stdout=Join-Path $testRoot 'desktop.stdout.log'
$stderr=Join-Path $testRoot 'desktop.stderr.log'
$microphoneFile=Join-Path $repoRoot '.cache/microphone-native-input.wav'
$audioStream=[IO.File]::Create($microphoneFile)
$audioWriter=[IO.BinaryWriter]::new($audioStream)
try {
    $audioWriter.Write([Text.Encoding]::ASCII.GetBytes('RIFF'));$audioWriter.Write([uint32](36+48000));$audioWriter.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '));$audioWriter.Write([uint32]16);$audioWriter.Write([uint16]1);$audioWriter.Write([uint16]1);$audioWriter.Write([uint32]24000);$audioWriter.Write([uint32]48000);$audioWriter.Write([uint16]2);$audioWriter.Write([uint16]16);$audioWriter.Write([Text.Encoding]::ASCII.GetBytes('data'));$audioWriter.Write([uint32]48000)
    for($sample=0;$sample -lt 24000;$sample++){$audioWriter.Write([int16]([Math]::Sin($sample/24000*440*2*[Math]::PI)*6000))}
} finally {$audioWriter.Dispose();$audioStream.Dispose()}
$previousBrowserArguments=$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
try {
    # Synthetic microphone only; never request the runner/user's physical input.
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=`"$microphoneFile`""
$desktop=Start-Process -FilePath $executable -ArgumentList @('--ui-test',"`"$dataRoot`"") -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
} finally { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=$previousBrowserArguments }
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
