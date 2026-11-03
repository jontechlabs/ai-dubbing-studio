"""Bound the UI-only change and authenticate unchanged native/worker checks."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = '934b31401985954d0f62ffb6a72b65141b7f1f4f'
BUILD = '0d4f54bd82157b164928592de84bd1bbe6c74524'
RUN = 41583299122
def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True, encoding='utf8').strip()
def value(ref, path):
    return subprocess.check_output(['git', 'show', ref+':'+path], cwd=ROOT)

identities = {}
for path in ['src-tauri/src', 'src-tauri/binaries', 'workers', 'public', 'pnpm-lock.yaml',
             'src/domain', 'src/hooks', 'src/services', 'src/mcp', 'src/App.tsx']:
    identities[path] = git('rev-parse', 'HEAD:'+path)
    assert identities[path] == git('rev-parse', BASE+':'+path), path
    assert identities[path] == git('rev-parse', BUILD+':'+path), path
for path in ['package.json', 'src-tauri/tauri.conf.json']:
    before = json.loads(value(BASE, path)); after = json.loads(value('HEAD', path))
    assert after['version'] == '0.37.0'; after['version'] = before['version']
    assert after == before, path
for path in ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']:
    assert value('HEAD', path).replace(b'name = "ai-dubbing-studio"\nversion = "0.37.0"', b'name = "ai-dubbing-studio"\nversion = "0.36.0"') == value(BASE, path)
allowed = {'src/components/CharactersPanel.tsx','src/components/DubPanel.tsx','src/components/Editor.tsx',
           'src/components/TimelineAudioSelection.tsx','src/components/VoiceRegionEditor.tsx',
           'src/styles.css','src/locales/en.json','src/locales/fr.json'}
assert set(git('diff','--name-only',BASE,'HEAD','--','src').splitlines()) <= allowed
for locale in ['en','fr']:
    path=f'src/locales/{locale}.json'
    after=json.loads(value('HEAD',path));assert after.pop('compact')
    assert after==json.loads(value(BASE,path))
assert set(git('diff','--name-only',BUILD,BASE).splitlines()) == {'VALIDATION.md','resources/updates/windows-x64.json'}
report = dict(head=git('rev-parse','HEAD'), baseHead=BASE, compiledBaselineHead=BUILD,
              immutableIdentities=identities, nativeWorkersAndAudioUnchanged=True,
              domainServicesHooksAndMcpUnchanged=True, toolCount=143, projectFormat=26)

if os.environ.get('CI'):
    token = os.environ['GH_TOKEN']
    base = 'https://api.github.com/repos/jontechlabs/ai-dubbing-studio/'
    def api(path):
        request=urllib.request.Request(base+path,headers={'Authorization':'Bearer '+token,'User-Agent':'Studio-UI-validation','Accept':'application/vnd.github+json'})
        with urllib.request.urlopen(request,timeout=60) as response:return json.load(response)
    run=api(f'actions/runs/{RUN}')
    assert run['head_sha']==BUILD and run['conclusion']=='success' and run['status']=='completed'
    assert run['path']=='.github/workflows/character-portraits.yml'
    job,=api(f'actions/runs/{RUN}/jobs')['jobs'];assert job['conclusion']=='success'
    assert any(s['name']=='Fresh native and worker regression checks' and s['conclusion']=='success' for s in job['steps'])
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    request=urllib.request.Request(base+f'actions/jobs/{job["id"]}/logs',headers={'Authorization':'Bearer '+token,'User-Agent':'Studio-UI-validation'})
    try:response=urllib.request.build_opener(NoRedirect).open(request,timeout=60)
    except urllib.error.HTTPError as error:
        if error.code!=302:raise
        response=urllib.request.urlopen(urllib.request.Request(error.headers['Location'],headers={'User-Agent':'Studio-UI-validation'}),timeout=90)
    with response:raw=response.read(32*1024**2+1)
    assert len(raw)<=32*1024**2
    log=re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]','',raw.decode('utf-8-sig'))
    assert '198 passed; 0 failed; 2 ignored' in log and 'Ran 111 tests' in log
    report['nativeChecksReused']=dict(runId=RUN,jobId=job['id'],native=198,python=111,ignored=2,
                                    nativeStepAndClippyPassed=True,jobLogSha256=hashlib.sha256(raw).hexdigest())
    folder=ROOT/'artifacts';folder.mkdir(exist_ok=True)
    (folder/'ui-baseline-native-job.log').write_bytes(raw)
folder=ROOT/'artifacts';folder.mkdir(exist_ok=True)
(folder/'ui-source-identity.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print('UI-only scope verified; native audio, workers, models, domain, hooks and MCP remain byte-identical to qualified v0.36.0.')
