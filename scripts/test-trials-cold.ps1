$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$testRoot=Join-Path $repoRoot '.cache/trials-cold/Studio 日本語'
$dataRoot=Join-Path $testRoot 'session'
New-Item -ItemType Directory -Force $dataRoot | Out-Null
Expand-Archive -LiteralPath (Join-Path $repoRoot 'artifacts/AI-Dubbing-Studio-Windows-Portable.zip') -DestinationPath $testRoot
$executable=Join-Path $testRoot 'AI-Dubbing-Studio-Windows/AI Dubbing Studio.exe'
[IO.File]::WriteAllText((Join-Path $dataRoot 'mcp-enabled'),'1')
$desktop=Start-Process -FilePath $executable -ArgumentList @('--ui-test',"`"$dataRoot`"") -WindowStyle Hidden -PassThru
try {
 $endpoint=Join-Path $dataRoot 'mcp-endpoint.json'
 $until=[DateTime]::UtcNow.AddSeconds(60)
 while(-not (Test-Path -LiteralPath $endpoint)){if($desktop.HasExited -or [DateTime]::UtcNow -ge $until){throw 'Cold diagnostic did not start'};Start-Sleep -Milliseconds 250}
 node (Join-Path $PSScriptRoot 'test-trials-cold.mjs') --exe $executable --endpoint $endpoint --test-root $testRoot --movie (Join-Path $testRoot 'AI-Dubbing-Studio-Windows/demo/demo.mp4') --reference (Join-Path $repoRoot '.cache/reference-transcription/Référence 日本語/ja.wav') --proof (Join-Path $repoRoot 'artifacts/audio8-cold-validation.json')
 if($LASTEXITCODE){throw 'Cold single-take generation failed'}
 python (Join-Path $PSScriptRoot 'check-trials-audio.py') $executable
 if($LASTEXITCODE){throw 'Cold single-take analysis failed'}
} finally {if(-not $desktop.HasExited){$desktop.Kill();$null=$desktop.WaitForExit(5000)}}
