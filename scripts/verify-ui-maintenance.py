"""Verify an exact UI-only change before skipping unchanged full-weight TTS/VC."""
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
baseline = 'v0.27.1'
expected_base = 'a796afa1f18d16b0c9cde8c9b5ccfa8aebadb92f'
allowed = {
    '.github/workflows/windows.yml', 'scripts/verify-ui-maintenance.py',
    'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json',
    'README.md', 'README.fr.md', 'docs/COMPACT-WORKSPACE.md', 'docs/AUDIO-EFFECTS.md', 'docs/MCP-PROCESSES.md',
    'src/App.tsx', 'src/styles.css', 'src/locales/fr.json', 'src/locales/en.json',
    'src/components/Dialogues.tsx', 'src/components/EffectsChainEditor.tsx',
    'src/components/Modal.tsx', 'src/components/WorkspacePanels.tsx', 'src/components/VoiceRegionEditor.tsx',
    'tests/e2e/audio-effects.pw.ts', 'tests/e2e/compact-workspace.pw.ts',
    *('docs/screenshots/' + name for name in [
        'audio-effects-track-fr.png', 'audio-effects-voice-fr.png', 'track-global-volume-fr.png',
        'audio-effect-settings-fr.png', 'workspace-three-panels-fr.png', 'workspace-small-screen-fr.png',
    ]),
}

def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()

base = git('rev-parse', baseline + '^{commit}')
assert base == expected_base, 'Unexpected baseline release'
subprocess.run(['git', 'merge-base', '--is-ancestor', base, 'HEAD'], cwd=root, check=True)
changed = set(git('diff', '--name-only', base, 'HEAD').splitlines())
assert changed and changed <= allowed, f'Changes outside the UI maintenance scope: {changed - allowed}'
for name in ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']:
    original = subprocess.check_output(['git', 'show', f'{base}:{name}'], cwd=root).replace(b'\r\n', b'\n')
    current = (root / name).read_bytes().replace(b'\r\n', b'\n')
    if name.endswith('.json'):
        old_json, new_json = json.loads(original), json.loads(current)
        assert old_json['version'] == '0.27.1' and new_json['version'] == '0.28.0'
        new_json['version'] = old_json['version']
        assert new_json == old_json, f'Only root version changes permitted: {name}'
    else:
        before = b'name = "ai-dubbing-studio"\nversion = "0.27.1"'
        after = b'name = "ai-dubbing-studio"\nversion = "0.28.0"'
        assert current.count(after) == 1
        assert current.replace(after, before) == original, f'Only root version changes permitted: {name}'
immutable = ['workers', 'src-tauri/src', 'resources', 'public', 'src/domain', 'src/services', 'src/hooks', 'src/mcp', 'pnpm-lock.yaml']
identities = {}
for name in immutable:
    identities[name] = git('rev-parse', f'HEAD:{name}')
    assert identities[name] == git('rev-parse', f'{base}:{name}'), f'Inference, DSP, transport or project data code changed: {name}'
localized = {'local', 'voiceEditHelp', 'batchDubCompact', 'batchLipCompact', 'resizeInspector', 'resizeWorkspaceHint', 'subtitleInspector', 'fxSettings', 'fxSettingsTitle', 'fxOn', 'fxOff', 'fxDone', 'fxPosition', 'fxHelp', 'fxChainLimit', 'fxDraftHint', 'fxChainHint'}
for language in ['fr', 'en']:
    name = f'src/locales/{language}.json'
    before = json.loads(subprocess.check_output(['git', 'show', f'{base}:{name}'], cwd=root))
    after = json.loads((root/name).read_text(encoding='utf-8'))
    assert before.keys() <= after.keys(), 'Existing localization keys removed'
    assert {key for key in after if after[key] != before.get(key)} <= localized
report = {
    'baseline': baseline, 'baselineCommit': base, 'head': git('rev-parse', 'HEAD'),
    'workerTreeUnchanged': True, 'nativeTreeUnchanged': True, 'dspAndProjectCodeUnchanged': True,
    'toolCatalogUnchanged': True, 'immutableIdentities': identities, 'changedFiles': sorted(changed),
    'scope': 'Fresh Windows suites, native build, SDK, relay lifecycle, ASR and diagnostics. Full-weight TTS/VC is not repeated for byte-identical engine code.',
}
destination = root/'artifacts/ui-maintenance-validation.json'
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
print(json.dumps(report, indent=2))
