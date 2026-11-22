[CmdletBinding()]
param([string]$PortablePath, [switch]$NativeVoices, [switch]$GenerationTiming, [string]$SpectralProof, [string]$InworldProof)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
if(-not $PortablePath){$PortablePath=Join-Path $repoRoot 'artifacts/AI-Dubbing-Studio-Windows-Portable.zip'}
$testRoot=Join-Path $repoRoot ".cache/volume-leveling-native/$([guid]::NewGuid().ToString('N'))/Contrôle 日本語"
$dataRoot=Join-Path $testRoot 'session'
New-Item -ItemType Directory -Force $dataRoot | Out-Null
New-Item -ItemType Directory -Force (Join-Path $repoRoot 'artifacts') | Out-Null
if($SpectralProof) {
    $spectral = Get-Content -LiteralPath $SpectralProof -Raw | ConvertFrom-Json
    if($spectral.version -ne '0.57.0' -or $spectral.device -ne 'cpu' -or $spectral.caseCount -ne 8){throw 'Invalid CPU spectral test fixture'}
    $config = @{version=1;path=$spectral.modelStore} | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $dataRoot 'model-storage.json'),$config)
}
if($InworldProof) {
    if($SpectralProof){throw 'Use one isolated neural fixture at a time'}
    $inworld=Get-Content -LiteralPath $InworldProof -Raw | ConvertFrom-Json
    if($inworld.version -ne '0.58.0' -or $inworld.device -ne 'cpu' -or $inworld.goldens.Count -ne 2){throw 'Invalid Inworld CPU fixture'}
    $config=@{version=1;path=$inworld.modelStore} | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $dataRoot 'model-storage.json'),$config)
}
Expand-Archive -LiteralPath $PortablePath -DestinationPath $testRoot
$executable=Join-Path $testRoot 'AI-Dubbing-Studio-Windows/AI Dubbing Studio.exe'
[IO.File]::WriteAllText((Join-Path $dataRoot 'mcp-enabled'),'1')
$microphoneFile=Join-Path $dataRoot 'synthetic-microphone.wav'
$audioStream=[IO.File]::Create($microphoneFile)
$audioWriter=[IO.BinaryWriter]::new($audioStream)
try {
    $audioWriter.Write([Text.Encoding]::ASCII.GetBytes('RIFF'));$audioWriter.Write([uint32](36+48000));$audioWriter.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '));$audioWriter.Write([uint32]16);$audioWriter.Write([uint16]1);$audioWriter.Write([uint16]1);$audioWriter.Write([uint32]24000);$audioWriter.Write([uint32]48000);$audioWriter.Write([uint16]2);$audioWriter.Write([uint16]16);$audioWriter.Write([Text.Encoding]::ASCII.GetBytes('data'));$audioWriter.Write([uint32]48000)
    for($sample=0;$sample -lt 24000;$sample++){$audioWriter.Write([int16]([Math]::Sin($sample/24000*440*2*[Math]::PI)*6000))}
} finally {$audioWriter.Dispose();$audioStream.Dispose()}

foreach($phase in @('before','after')) {
    $endpoint=Join-Path $dataRoot 'mcp-endpoint.json'
    if(Test-Path -LiteralPath $endpoint){Remove-Item -LiteralPath $endpoint -Force}
    $stdout=Join-Path $testRoot "$phase.stdout.log"; $stderr=Join-Path $testRoot "$phase.stderr.log"
    $desktop=Start-Process -FilePath $executable -ArgumentList @('--ui-test',"`"$dataRoot`"",'--synthetic-microphone') -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    try {
        $until=[DateTime]::UtcNow.AddSeconds(60)
        while(-not(Test-Path -LiteralPath $endpoint)) {
            if($desktop.HasExited -or [DateTime]::UtcNow -ge $until){throw 'Desktop MCP did not start'}
            Start-Sleep -Milliseconds 250
        }
        node (Join-Path $PSScriptRoot 'test-volume-leveling-mcp.mjs') --exe $executable --endpoint $endpoint --test-root $testRoot --phase $phase --desktop-pid $desktop.Id --proof (Join-Path $repoRoot 'artifacts/mcp-native-validation.json')
        if($LASTEXITCODE){throw 'Official SDK volume levelling diagnostic failed'}
        if($phase -eq 'after' -and $NativeVoices) {
            node (Join-Path $PSScriptRoot 'test-native-voices-mcp.mjs') --exe $executable --endpoint $endpoint --test-root $testRoot --proof (Join-Path $repoRoot 'artifacts/native-voices-validation.json')
            if($LASTEXITCODE){throw 'Official SDK real native voice models diagnostic failed'}
        }
        if($phase -eq 'after' -and $GenerationTiming) {
            node (Join-Path $PSScriptRoot 'test-generation-timing-mcp.mjs') --exe $executable --endpoint $endpoint --test-root $testRoot --phase before --desktop-pid $desktop.Id --proof (Join-Path $repoRoot 'artifacts/generation-timing-validation.json')
            if($LASTEXITCODE){throw 'Take timing persistence setup failed'}
        }
    } catch {
        if(Test-Path -LiteralPath $stderr){Get-Content -LiteralPath $stderr -Tail 15}
        if(Test-Path -LiteralPath $stdout){Get-Content -LiteralPath $stdout -Tail 10}
        throw
    } finally {
        if(-not $desktop.HasExited){$desktop.Kill();$null=$desktop.WaitForExit(5000)}
    }
    if($phase -eq 'before') {
        # Isolated fixture fault injection: simulate shutdown during an unpaused
        # workflow. Restart must pause the queue, retain rows, and require retry.
        $queueFile=Join-Path $dataRoot 'task-queue.json'
        python (Join-Path $PSScriptRoot 'simulate-queue-interruption.py') $queueFile
        if($LASTEXITCODE){throw 'Isolated queue restart fixture failed'}
    }
}
if($GenerationTiming) {
    $endpoint=Join-Path $dataRoot 'mcp-endpoint.json'
    if(Test-Path -LiteralPath $endpoint){Remove-Item -LiteralPath $endpoint -Force}
    $desktop=Start-Process -FilePath $executable -ArgumentList @('--ui-test',"`"$dataRoot`"",'--synthetic-microphone') -WindowStyle Hidden -PassThru
    try {
        $until=[DateTime]::UtcNow.AddSeconds(60)
        while(-not(Test-Path -LiteralPath $endpoint)) {
            if($desktop.HasExited -or [DateTime]::UtcNow -ge $until){throw 'Take timing desktop restart did not start'}
            Start-Sleep -Milliseconds 250
        }
        node (Join-Path $PSScriptRoot 'test-generation-timing-mcp.mjs') --exe $executable --endpoint $endpoint --test-root $testRoot --phase after --desktop-pid $desktop.Id --proof (Join-Path $repoRoot 'artifacts/generation-timing-validation.json')
        if($LASTEXITCODE){throw 'Take timing persistence restart failed'}
        if($SpectralProof) {
            node (Join-Path $PSScriptRoot 'test-spectral-separation-mcp.mjs') --exe $executable --endpoint $endpoint --test-root $testRoot --neural-proof $SpectralProof --proof (Join-Path $repoRoot 'artifacts/spectral-sdk-validation.json')
            if($LASTEXITCODE){throw 'Packaged spectral separation SDK diagnostic failed'}
        }
        if($InworldProof) {
            node (Join-Path $PSScriptRoot 'test-inworld-isolator-mcp.mjs') --exe $executable --endpoint $endpoint --test-root $testRoot --neural-proof $InworldProof --proof (Join-Path $repoRoot 'artifacts/inworld-sdk-validation.json')
            if($LASTEXITCODE){throw 'Packaged Inworld isolation SDK diagnostic failed'}
        }

    } finally {
        if(-not $desktop.HasExited){$desktop.Kill();$null=$desktop.WaitForExit(5000)}
    }
}
