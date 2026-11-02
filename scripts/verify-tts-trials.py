"""Verify unchanged engines; the new series only schedules existing inference."""
from pathlib import Path
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BASE = 'f4821d3a341bbdb87d5c783a04852933e702df1f'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


subprocess.run(['git', 'merge-base', '--is-ancestor', BASE, 'HEAD'], cwd=ROOT, check=True)
identities = {}
for name in ['workers', 'src/domain', 'public', 'pnpm-lock.yaml', 'src-tauri/src/tts.rs',
             'src-tauri/src/tts_session.rs', 'src-tauri/src/voice_engines.rs',
             'src-tauri/src/voice_capture.rs', 'src-tauri/src/prosody.rs']:
    identities[name] = git('rev-parse', 'HEAD:' + name)
    assert identities[name] == git('rev-parse', BASE + ':' + name), name
for name in ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']:
    before = subprocess.check_output(['git', 'show', BASE + ':' + name], cwd=ROOT)
    after = (ROOT / name).read_bytes().replace(b'\r\n', b'\n')
    assert after.replace(b'name = "ai-dubbing-studio"\nversion = "0.35.0"', b'name = "ai-dubbing-studio"\nversion = "0.34.1"') == before
for name in ['package.json', 'src-tauri/tauri.conf.json']:
    before = json.loads(subprocess.check_output(['git', 'show', BASE + ':' + name], cwd=ROOT))
    after = json.loads((ROOT / name).read_text(encoding='utf8'))
    assert after['version'] == '0.35.0'
    after['version'] = before['version']
    assert before == after
before = json.loads(subprocess.check_output(['git', 'show', BASE + ':src/mcp/catalog.json'], cwd=ROOT))
after = json.loads((ROOT / 'src/mcp/catalog.json').read_text(encoding='utf8'))
assert {c['name'] for c in before['commands']} == {c['name'] for c in after['commands']}
assert len(after['commands']) + len(after['builtins']) == 141
assert before['schemas'] == after['schemas']
report = dict(head=git('rev-parse', 'HEAD'), baseHead=BASE, immutableIdentities=identities,
              inferenceWorkersModelsAndDependenciesUnchanged=True, toolCount=141, projectFormat=26)
p = ROOT / 'artifacts/trials-source-identity.json'
p.parent.mkdir(exist_ok=True)
p.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report, indent=2))
