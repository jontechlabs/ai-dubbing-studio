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
    'tests/e2e/nativeMock.ts',
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
    if name.endswith('.json'):
        old_json, new_json = json.loads(original), json.loads(current)
        assert old_json['version'] == '0.27.0' and new_json['version'] == '0.27.1'
        new_json['version'] = old_json['version']
        assert new_json == old_json, f'Only root version changes permitted: {name}'
    else:
        before = b'name = "ai-dubbing-studio"\nversion = "0.27.0"'
        after = b'name = "ai-dubbing-studio"\nversion = "0.27.1"'
        assert current.count(after) == 1
        assert current.replace(after, before) == original.replace(b'\r\n', b'\n'), f'Only root version changes permitted: {name}'
worker_tree = git('rev-parse', 'HEAD:workers')
assert worker_tree == git('rev-parse', f'{base}:workers'), 'Workers or model/runtime manifests changed'
assert git('rev-parse', 'HEAD:src/mcp/catalog.json') == git('rev-parse', f'{base}:src/mcp/catalog.json')
fixture = 'tests/e2e/nativeMock.ts'
old_fixture = subprocess.check_output(['git', 'show', f'{base}:{fixture}'], cwd=root).decode().replace('\r\n', '\n')
new_fixture = (root / fixture).read_text(encoding='utf-8')
prefetch = "  // Read the fixture before navigation: a cold Windows filesystem read must\n  // not hold the intercepted media response behind the readiness assertion.\n  const previewData=await fs.readFile('public/demo.mp4');\n"
assert new_fixture.count(prefetch) == 1
assert new_fixture.replace(prefetch, '').replace('const data=previewData,range=', "const data=await fs.readFile('public/demo.mp4'),range=") == old_fixture, 'Only fixture byte prefetch is permitted; assertions stay unchanged'
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
