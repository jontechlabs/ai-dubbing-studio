"""Verify an exact UI-only change before skipping unchanged full-weight TTS/VC."""
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
baseline = 'v0.28.0'
expected_base = 'b8f3a6bea9decfa6da6248aeefeab658925c0a10'
allowed = {
    'scripts/verify-ui-maintenance.py',
    'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json',
    'README.md', 'README.fr.md', 'docs/TIMELINE-PERFORMANCE.md', 'docs/TIMELINE-ZOOM.md',
    'docs/screenshots/timeline-zoom.png', 'docs/screenshots/timeline-long-film-fr.png',
    'src/components/Timeline.tsx', 'src/components/Waveform.tsx',
    'src/components/timelineRendering.ts', 'src/components/timelineRendering.test.ts',
    'src/hooks/useTimelineZoom.ts', 'src/locales/fr.json', 'src/locales/en.json',
    'tests/e2e/nativeMock.ts', 'tests/e2e/timeline-performance.pw.ts',
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
        assert old_json['version'] == '0.28.0' and new_json['version'] == '0.28.1'
        new_json['version'] = old_json['version']
        assert new_json == old_json, f'Only root version changes permitted: {name}'
    else:
        before = b'name = "ai-dubbing-studio"\nversion = "0.28.0"'
        after = b'name = "ai-dubbing-studio"\nversion = "0.28.1"'
        assert current.count(after) == 1
        assert current.replace(after, before) == original, f'Only root version changes permitted: {name}'
immutable = ['workers', 'src-tauri/src', 'resources', 'public', 'src/domain', 'src/services', 'src/mcp', 'pnpm-lock.yaml']
identities = {}
for name in immutable:
    identities[name] = git('rev-parse', f'HEAD:{name}')
    assert identities[name] == git('rev-parse', f'{base}:{name}'), f'Inference, DSP, transport or project data code changed: {name}'
# The only changed hook controls timeline presentation. All transport, playback,
# generation, job, persistence and MCP hooks must remain byte-identical.
hooks = git('ls-tree', '-r', '--name-only', base, 'src/hooks').splitlines()
assert hooks == git('ls-tree', '-r', '--name-only', 'HEAD', 'src/hooks').splitlines()
unchanged_hooks = {}
for name in hooks:
    if name == 'src/hooks/useTimelineZoom.ts': continue
    unchanged_hooks[name] = git('rev-parse', f'HEAD:{name}')
    assert unchanged_hooks[name] == git('rev-parse', f'{base}:{name}'), name
localized = {'timelineZoomLimitedHint', 'fitTimelineLimited', 'timelineVisibleWindow'}
for language in ['fr', 'en']:
    name = f'src/locales/{language}.json'
    before = json.loads(subprocess.check_output(['git', 'show', f'{base}:{name}'], cwd=root))
    after = json.loads((root/name).read_text(encoding='utf-8'))
    assert before.keys() <= after.keys(), 'Existing localization keys removed'
    assert {key for key in after if after[key] != before.get(key)} <= localized
report = {
    'baseline': baseline, 'baselineCommit': base, 'head': git('rev-parse', 'HEAD'),
    'workerTreeUnchanged': True, 'nativeTreeUnchanged': True, 'dspAndProjectCodeUnchanged': True,
    'toolCatalogUnchanged': True, 'nonTimelineHooksUnchanged': True, 'unchangedHooks': unchanged_hooks, 'immutableIdentities': identities, 'changedFiles': sorted(changed),
    'scope': 'Fresh Windows suites, native build, SDK, relay lifecycle, ASR and diagnostics. Full-weight TTS/VC is not repeated for byte-identical engine code.',
}
destination = root/'artifacts/ui-maintenance-validation.json'
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
print(json.dumps(report, indent=2))
