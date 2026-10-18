"""CI real-model fixture using the application's exact pinned URLs and checksums."""
from pathlib import Path
import hashlib
import json
import re
import urllib.request
import zipfile

source = Path('src-tauri/src/translation_llm.rs').read_text(encoding='utf-8')
def constant(name):
    match = re.search(r'const ' + name + r': [^=]+ = ([^;]+);', source)
    value = match.group(1).strip()
    return json.loads(value) if value.startswith('"') else int(value.replace('_', ''))

storage = Path('.cache/traduction-référence 日本語').resolve()
root = storage / 'translation-llm'
root.mkdir(parents=True, exist_ok=True)
for prefix, name in [('RUNTIME', 'llama.zip'), ('MODEL', 'model.gguf')]:
    path = root / name
    if not path.is_file() or path.stat().st_size != constant(prefix + '_SIZE'):
        with urllib.request.urlopen(constant(prefix + '_URL'), timeout=60) as response, path.open('wb') as output:
            while chunk := response.read(4 * 1024 * 1024):
                output.write(chunk)
    with path.open('rb') as file:
        digest = hashlib.file_digest(file, 'sha256').hexdigest()
    if path.stat().st_size != constant(prefix + '_SIZE') or digest != constant(prefix + '_SHA'):
        raise ValueError('MODEL_CHECKSUM_FAILED')
    print(f'Verified {name}: size and SHA-256', flush=True)
runtime = root / 'runtime'
with zipfile.ZipFile(root / 'llama.zip') as archive:
    for name in archive.namelist():
        if not (runtime / name).resolve().is_relative_to(runtime.resolve()):
            raise ValueError('INVALID_PATH')
    archive.extractall(runtime)
files = {}
for path in runtime.iterdir():
    if path.is_file():
        with path.open('rb') as file:
            files[path.name] = hashlib.file_digest(file, 'sha256').hexdigest()
(root / 'ready.json').write_text(json.dumps({'tag': constant('RUNTIME_TAG'), 'files': files}), encoding='utf-8')
Path('.cache/translation-fixture-path.txt').write_text(str(storage), encoding='utf-8')
print('Translation fixture ready (Unicode storage path).', flush=True)
