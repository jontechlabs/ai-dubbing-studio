[CmdletBinding()]
param([string]$PortablePath)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
if(-not $PortablePath){$PortablePath=Join-Path $repoRoot 'artifacts/AI-Dubbing-Studio-Windows-Portable.zip'}
$testRoot=Join-Path $repoRoot ".cache/volume-leveling-native/$([guid]::NewGuid().ToString('N'))/Contrôle 日本語"
$dataRoot=Join-Path $testRoot 'session'
New-Item -ItemType Directory -Force $dataRoot | Out-Null
New-Item -ItemType Directory -Force (Join-Path $repoRoot 'artifacts') | Out-Null
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
