"""Bound this patch to accent presentation before reusing unchanged neural engines."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = 'a00567512abcf56470b9e476ff7260ff5df1e86d'
ALLOWED = {
    'src/components/DubPanel.tsx', 'src/components/VoiceAccentControl.tsx',
    'src/locales/fr.json', 'src/locales/en.json', 'tests/e2e/voice-accents.pw.ts',
    'docs/VOICE-ACCENTS.md', 'README.md', 'README.fr.md', 'VALIDATION.md',
    'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json', '.github/workflows/voice-accents.yml',
    'scripts/verify-accent-ui.py', 'resources/updates/windows-x64.json',
}


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


subprocess.run(['git', 'merge-base', '--is-ancestor', BASE, 'HEAD'], cwd=ROOT, check=True)
changed = set(git('diff', '--name-only', BASE, 'HEAD').splitlines())
assert changed and changed <= ALLOWED, sorted(changed - ALLOWED)
identities = {}
for path in ['workers', 'src-tauri/src', 'src/domain', 'src/hooks', 'src/services',
             'src/mcp', 'public', 'pnpm-lock.yaml']:
    identities[path] = git('rev-parse', 'HEAD:' + path)
    assert identities[path] == git('rev-parse', BASE + ':' + path), path
for name in ['package.json', 'src-tauri/tauri.conf.json']:
    old = json.loads(subprocess.check_output(['git', 'show', BASE + ':' + name], cwd=ROOT))
    new = json.loads((ROOT / name).read_text(encoding='utf8'))
    assert old['version'] == '0.34.0' and new['version'] == '0.34.1'
    new['version'] = old['version']
    assert old == new, name
for name in ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']:
    old = subprocess.check_output(['git', 'show', BASE + ':' + name], cwd=ROOT)
    new = (ROOT / name).read_bytes().replace(b'\r\n', b'\n')
    expected = b'name = "ai-dubbing-studio"\nversion = "0.34.1"'
    assert new.count(expected) == 1
    assert new.replace(expected, expected.replace(b'0.34.1', b'0.34.0')) == old, name
for language in ['fr', 'en']:
    name = f'src/locales/{language}.json'
    old = json.loads(subprocess.check_output(['git', 'show', BASE + ':' + name], cwd=ROOT))
    new = json.loads((ROOT / name).read_text(encoding='utf8'))
    assert old.keys() <= new.keys()
    assert all(key.startswith('ttsAccent') for key in new if new[key] != old.get(key))
# The only resource change allowed is the signed updater feed after qualification.
resource_changes = git('diff', '--name-only', BASE, 'HEAD', '--', 'resources').splitlines()
assert resource_changes in ([], ['resources/updates/windows-x64.json'])
report = dict(baseHead=BASE, head=git('rev-parse', 'HEAD'), changedFiles=sorted(changed),
              immutableIdentities=identities, inferenceWorkersUnchanged=True,
              nativeAudioAndProjectCodeUnchanged=True, dependencyLockUnchanged=True)
destination = ROOT / 'artifacts/accent-ui-identity.json'
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report, indent=2))
