"""Authenticate the 257 successful cases on identical app inputs; rerun the three corrected assertions."""
from pathlib import Path
import hashlib,json,os,re,subprocess,urllib.request,urllib.error
ROOT=Path(__file__).resolve().parents[1]
BASE='f63670cf40caf300c645058b842a87a499eb3ee0'
RUN=41631608560
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
def source(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=ROOT)
paths=['src','src-tauri','workers','public','resources','package.json','pnpm-lock.yaml',
       'vite.config.ts','playwright.config.ts','tsconfig.json','scripts/prepare-ffmpeg.ps1',
       'scripts/prepare-prosody.ps1','tests/e2e/nativeMock.ts']
identities={p:git('rev-parse','HEAD:'+p) for p in paths}
assert all(blob==git('rev-parse',BASE+':'+p) for p,blob in identities.items())
assert git('diff','--name-only',BASE,'HEAD','--','tests/e2e').splitlines()==['tests/e2e/voice-library.pw.ts']
before=source(BASE,'tests/e2e/voice-library.pw.ts')
after=source('HEAD','tests/e2e/voice-library.pw.ts')
new=b"    // The inspector retains the explicitly requested proposal when reopened.\n    await expect(panel.getByRole('button', { name: 'Actualiser la proposition' })).toBeEnabled();"
assert after.count(new)==1 and after.replace(new,b'    await expect(launch).toBeEnabled();')==before
report=dict(head=git('rev-parse','HEAD'),baselineHead=BASE,baselineRun=RUN,
            passed=257,correctedCases=3,identicalAppInputs=identities)
if os.environ.get('CI'):
    base='https://api.github.com/repos/jontechlabs/ai-dubbing-studio/'
    headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-browser-validation','Accept':'application/vnd.github+json'}
    def api(path):
        with urllib.request.urlopen(urllib.request.Request(base+path,headers=headers),timeout=60) as response:return json.load(response)
    run=api(f'actions/runs/{RUN}')
    assert run['head_sha']==BASE and run['status']=='completed' and run['conclusion']=='failure'
    assert run['path']=='.github/workflows/dubbing-inspector.yml'
    job,=api(f'actions/runs/{RUN}/jobs')['jobs']
    assert job['conclusion']=='failure'
    assert any(s['name']=='Fresh frontend unit, complete Chrome, lint and schema checks' and s['conclusion']=='failure' for s in job['steps'])
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    request=urllib.request.Request(base+f'actions/jobs/{job["id"]}/logs',headers=headers)
    try:response=urllib.request.build_opener(NoRedirect).open(request,timeout=60)
    except urllib.error.HTTPError as error:
        if error.code!=302:raise
        response=urllib.request.urlopen(urllib.request.Request(error.headers['Location'],headers={'User-Agent':'Studio-browser-validation'}),timeout=90)
    with response:raw=response.read(32*1024**2+1)
    assert len(raw)<=32*1024**2
    log=re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]','',raw.decode('utf-8-sig'))
    assert 'Running 260 tests using 1 worker' in log and '257 passed (' in log and '3 failed' in log
    for value in ['null','on','off']:
        assert f'tests\\e2e\\voice-library.pw.ts:210:3 › character matching only starts on request with legacy preference {value}' in log
    report.update(baselineJob=job['id'],jobLogSha256=hashlib.sha256(raw).hexdigest())
    (ROOT/'artifacts/ui-baseline-browser-job.log').write_bytes(raw)
(ROOT/'artifacts/ui-browser-identity.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print('257 Chrome cases authenticated on identical application inputs; three retained-state assertions must pass freshly.')
