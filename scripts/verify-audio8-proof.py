"""Reuse successful Chrome/native checks only for identical application inputs.

The authenticated baseline failed solely because an obsolete Python assertion
expected eight rather than nine models. The Python suite, package build and all
neural/MCP diagnostics always run freshly. Any application change runs the full
Chrome/native suites again.
"""
from pathlib import Path
import json
import os
import re
import subprocess
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
SLUG='jontechlabs/ai-dubbing-studio'
RUN=41327211134
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
def api(p):
 with urllib.request.urlopen(urllib.request.Request('https://api.github.com/repos/'+SLUG+'/'+p,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-Audio8-identity-check'}),timeout=60) as r:return json.load(r)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
def raw_log(job):
 request=urllib.request.Request(f'https://api.github.com/repos/{SLUG}/actions/jobs/{job}/logs',headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-Audio8-identity-check'})
 try:response=urllib.request.build_opener(NoRedirect).open(request,timeout=60)
 except urllib.error.HTTPError as e:
  if e.code!=302:raise RuntimeError('Log HTTP '+str(e.code)) from None
  response=urllib.request.urlopen(urllib.request.Request(e.headers['Location'],headers={'User-Agent':'Studio-Audio8-identity-check'}),timeout=60)
 with response:body=response.read(32*1024**2+1)
 assert len(body)<=32*1024**2
 return re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]','',body.decode('utf-8-sig',errors='replace'))
run=api('actions/runs/'+str(RUN))
assert run['status']=='completed' and run['conclusion']=='failure' and run['path']=='.github/workflows/audio8.yml'
base=run['head_sha'];head=git('rev-parse','HEAD')
assert base=='7aa155bc9268b2c8fea13162d976941b73e4792f'
subprocess.run(['git','merge-base','--is-ancestor',base,head],cwd=ROOT,check=True)
allowed={'workers/test_fish.py','scripts/verify-audio8.py','scripts/verify-audio8-proof.py','.github/workflows/audio8.yml'}
changed=set(git('diff','--name-only',base,head).splitlines())
if changed-allowed:
 print('Application inputs changed; full fresh Chrome and native checks required.',flush=True)
 raise SystemExit(0)
assert git('show','HEAD:workers/test_fish.py')==git('show',base+':workers/test_fish.py').replace("len(manifest['variants']),8)","len(manifest['variants']),9)")
jobs=api(f'actions/runs/{RUN}/jobs?per_page=100')['jobs'];assert len(jobs)==1 and jobs[0]['status']=='completed'
steps=jobs[0]['steps']
for name in ['Complete frontend, Chrome and MCP schema checks','Native regression tests, lints and formatting']:
 assert any(s['name']==name and s['conclusion']=='success' for s in steps)
assert [s['name'] for s in steps if s['conclusion']=='failure']==['Worker regression tests']
log=raw_log(jobs[0]['id'])
for marker in ['210 passed','Tests  200 passed','191 passed; 0 failed; 2 ignored','9 != 8','test_model_and_runtime_manifests_include_all_engines_and_verified_files']:
 assert marker in log,marker
proof=dict(head=head,verifiedHead=base,runId=RUN,applicationInputsIdentical=True,changedDiagnostics=sorted(changed),chrome=210,native=191,typescript=200,frontendStepPassed=True,nativeStepPassed=True,freshWorkerSuiteRequired=True,freshPackageAndNeuralDiagnosticsRequired=True)
(ROOT/'artifacts').mkdir(exist_ok=True)
(ROOT/'artifacts/audio8-checks-reuse.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf8')
with open(os.environ['GITHUB_ENV'],'a',encoding='utf8') as f:f.write('STUDIO_AUDIO8_CHECKS_REUSED=1\n')
print('AUDIO8_CHECKS_REUSED',json.dumps(proof),flush=True)
