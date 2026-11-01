"""Prove that adding Audio8 never replaces any established model/runtime/core."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BASE = '6617440e2b5d1ed60780be6fd76c4786ad2a12b2'
def git(*args): return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
changed = {'workers/voice-engines.json','workers/voice-quality.json','workers/test_fish.py'}
preserved = {}
for row in git('ls-tree','-r','--format=%(objectname) %(path)',BASE,'workers').splitlines():
    sha,path = row.split(' ',1)
    if path in changed: continue
    assert git('rev-parse',f'HEAD:{path}') == sha,path
    preserved[path] = sha
old_test=git('show',f'{BASE}:workers/test_fish.py')
assert (ROOT/'workers/test_fish.py').read_text(encoding='utf8').strip()==old_test.replace("len(manifest['variants']),8)","len(manifest['variants']),9)")
for path,key in [('workers/voice-engines.json','variants'),('workers/voice-quality.json','variants')]:
    old = json.loads(git('show',f'{BASE}:{path}'))
    new = json.loads((ROOT/path).read_text(encoding='utf8'))
    if isinstance(old[key],list):
        assert new['engine'] == old['engine']
        assert new[key][:-1] == old[key]
        assert new[key][-1]['id'] == 'audio8-realistic-06b-gguf-q8'
    else:
        assert new['version'] == old['version']
        assert {k:v for k,v in new[key].items() if not k.startswith('audio8-')} == old[key]
report=dict(head=git('rev-parse','HEAD'),baseline=BASE,unchangedWorkerIdentities=preserved,existingEngineArchiveUnchanged=True,existingModelAndQualityEntriesUnchanged=True)
(ROOT/'artifacts').mkdir(exist_ok=True)
(ROOT/'artifacts/audio8-identity.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print('AUDIO8_IDENTITY',len(preserved),'existing worker/model/runtime/source files unchanged',flush=True)
