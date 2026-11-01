$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$testRoot=Join-Path $repoRoot '.cache/audio8-native/Studio 日本語'
$dataRoot=Join-Path $testRoot 'session'
New-Item -ItemType Directory -Force $dataRoot | Out-Null
Expand-Archive -LiteralPath (Join-Path $repoRoot 'artifacts/AI-Dubbing-Studio-Windows-Portable.zip') -DestinationPath $testRoot
$executable=Join-Path $testRoot 'AI-Dubbing-Studio-Windows/AI Dubbing Studio.exe'
[IO.File]::WriteAllText((Join-Path $dataRoot 'mcp-enabled'),'1')
$stdout=Join-Path $testRoot 'desktop.stdout.log'
$stderr=Join-Path $testRoot 'desktop.stderr.log'
$desktop=Start-Process -FilePath $executable -ArgumentList @('--ui-test',"`"$dataRoot`"") -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
try {
    $endpoint=Join-Path $dataRoot 'mcp-endpoint.json'
    $until=[DateTime]::UtcNow.AddSeconds(60)
    while(-not (Test-Path -LiteralPath $endpoint)) {
        if($desktop.HasExited -or [DateTime]::UtcNow -ge $until){throw 'Audio8 test studio did not start'}
        Start-Sleep -Milliseconds 250
    }
    node (Join-Path $PSScriptRoot 'test-audio8.mjs') --exe $executable --endpoint $endpoint --test-root $testRoot --movie (Join-Path $testRoot 'AI-Dubbing-Studio-Windows/demo/demo.mp4') --reference (Join-Path $repoRoot '.cache/reference-transcription/Référence 日本語/ja.wav') --proof (Join-Path $repoRoot 'artifacts/audio8-inference-validation.json')
    if($LASTEXITCODE){throw 'Audio8 packaged inference failed'}
} catch {
    if(Test-Path -LiteralPath $stderr){Get-Content -LiteralPath $stderr -Tail 15}
    throw
} finally {
    if(-not $desktop.HasExited){$desktop.Kill();$null=$desktop.WaitForExit(5000)}
}
