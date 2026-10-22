"""Run packaged workers with the production embedded Python path isolation.

Reuse only this test's fresh pinned CPU site-packages, never host/user packages.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import sysconfig
import urllib.request
import zipfile


def prepare(root, work):
    assert sys.prefix != sys.base_prefix, 'Install the isolated test dependencies first'
    dependencies = Path(sysconfig.get_path('purelib')).resolve()
    assert dependencies.is_relative_to(Path(sys.prefix).resolve())
    spec = json.loads((root / 'workers/cosyvoice-runtime.json').read_text())['python']
    archive = work / 'python-embedded.zip'
    if not archive.exists():
        with urllib.request.urlopen(spec['url'], timeout=120) as response:
            archive.write_bytes(response.read())
    assert archive.stat().st_size == spec['size']
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == spec['sha256']
    interpreter = work / 'Python isolé 日本語'
    interpreter.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        assert all(not Path(name).is_absolute() and '..' not in Path(name).parts for name in bundle.namelist())
        bundle.extractall(interpreter)
    # Production uses Lib/site-packages in this file. This explicit test-only
    # dependency directory contains the same pinned wheels, with CPU Torch.
    (interpreter / 'python312._pth').write_text(
        f'python312.zip\n.\n{dependencies}\nimport site\n', encoding='utf-8')
    executable = interpreter / 'python.exe'
    check = subprocess.run([str(executable), '-I', '-B', '-c',
        'import sys,json; assert sys.flags.isolated; print(json.dumps(sys.path))'],
        capture_output=True, text=True, encoding='utf-8', check=True)
    assert all(Path(path).resolve().is_relative_to(interpreter.resolve()) or
        Path(path).resolve().is_relative_to(dependencies) for path in json.loads(check.stdout))
    target = work / 'Paquet 日本語' / 'workers'
    prefix = 'AI-Dubbing-Studio-Windows/workers/'
    with zipfile.ZipFile(root / 'artifacts/AI-Dubbing-Studio-Windows-Portable.zip') as portable:
        for name in portable.namelist():
            if not name.startswith(prefix) or name.endswith('/'):
                continue
            relative = Path(name.removeprefix(prefix))
            assert not relative.is_absolute() and '..' not in relative.parts
            content = portable.read(name)
            assert content.replace(b'\r\n', b'\n') == (root / 'workers' / relative).read_bytes().replace(b'\r\n', b'\n'), name
            path = target / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    assert (target / 'cosyvoice_worker.py').is_file()
    print('Verified embedded isolated Python and exact packaged worker resources.', flush=True)
    return executable, target
