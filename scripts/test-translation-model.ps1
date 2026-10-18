$ErrorActionPreference = 'Stop'
python -X utf8 -B scripts/prepare-translation-model.py
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$env:DUBBING_REAL_TRANSLATION_ROOT = Get-Content -LiteralPath .cache/translation-fixture-path.txt -Raw -Encoding utf8
New-Item -ItemType Directory -Force artifacts | Out-Null
cargo test --locked --manifest-path src-tauri/Cargo.toml real_translation_model_fixture -- --ignored --nocapture | Tee-Object artifacts/translation-model-validation.txt
if ($LASTEXITCODE) { exit $LASTEXITCODE }
