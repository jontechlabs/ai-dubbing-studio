"""Fail closed before skipping unchanged full-weight inference on an MCP patch."""
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
baseline = 'v0.27.0'
allowed = {
    '.github/workflows/windows.yml', 'scripts/verify-mcp-maintenance.py',
    'scripts/mcp-ssh-stdio.mjs', 'scripts/test-mcp-one-shot.mjs',
    'scripts/test-mcp-ssh-stdio.mjs', 'scripts/test-mcp.mjs',
    'src-tauri/src/mcp/client.rs',
    'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json', 'README.md', 'README.fr.md',
    'docs/MCP.md', 'docs/MCP-PROCESSES.md',
}

def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()

base = git('rev-parse', baseline + '^{commit}')
assert base == '7e67b3d37f1ab8bbcd5b3a6fa848c243a2a58d33', 'Unexpected baseline release'
subprocess.run(['git', 'merge-base', '--is-ancestor', base, 'HEAD'], cwd=root, check=True)
changed = set(git('diff', '--name-only', base, 'HEAD').splitlines())
assert changed and changed <= allowed, f'Non-MCP application changes require full neural validation: {changed - allowed}'
for name in ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']:
    original = subprocess.check_output(['git', 'show', f'{base}:{name}'], cwd=root)
    current = (root / name).read_bytes().replace(b'\r\n', b'\n')
    assert current.replace(b'0.27.1', b'0.27.0') == original.replace(b'\r\n', b'\n'), f'Only version changes permitted: {name}'
worker_tree = git('rev-parse', 'HEAD:workers')
assert worker_tree == git('rev-parse', f'{base}:workers'), 'Workers or model/runtime manifests changed'
assert git('rev-parse', 'HEAD:src/mcp/catalog.json') == git('rev-parse', f'{base}:src/mcp/catalog.json')
report = {
    'baseline': baseline, 'baselineCommit': base, 'head': git('rev-parse', 'HEAD'),
    'workerTreeUnchanged': True, 'workerTree': worker_tree,
    'toolCatalogUnchanged': True, 'changedFiles': sorted(changed),
    'scope': 'Fresh Windows suite, native application, SDK and relay lifecycle checks; unchanged full-weight inference is not repeated.',
}
destination = root / 'artifacts/mcp-maintenance-validation.json'
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2))
