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
$desktop=Start-Process -FilePath $executable -ArgumentList @('--ui-test',"`"$dataRoot`"") -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
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
