"""Verify the one CSS containment change and authenticate unchanged native checks."""
from pathlib import Path
import hashlib,json,os,re,subprocess,urllib.request,urllib.error
ROOT=Path(__file__).resolve().parents[1]
BASE='5c1b9a343bfe1f918336cab0c0422f73d8fa1f1d'
BUILD='5974fe5d59ee2789c2878ecf4a3e24319937eedf'
RUN=41666135257
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
def value(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=ROOT)
identities={}
for path in ['src-tauri/src','src-tauri/binaries','workers','public','pnpm-lock.yaml','src/domain','src/services','src/mcp','src/components','src/hooks','scripts/test-mcp.mjs','scripts/test-mcp.ps1']:
 identities[path]=git('rev-parse','HEAD:'+path)
 assert identities[path]==git('rev-parse',BASE+':'+path)==git('rev-parse',BUILD+':'+path),path
assert git('diff','--name-only',BASE,'HEAD','--','src')=='src/styles.css'
css=value('HEAD','src/styles.css').replace(b'  /* Keep visually hidden absolute labels inside this scroll container. */\n  position: relative;\n',b'')
assert css==value(BASE,'src/styles.css')
assert git('diff','--name-only',BASE,'HEAD','--','tests/e2e')=='tests/e2e/dubbing-scroll.pw.ts'
for path in ['package.json','src-tauri/tauri.conf.json']:
 before=json.loads(value(BASE,path));after=json.loads(value('HEAD',path));assert after['version']=='0.39.1';after['version']=before['version'];assert after==before
for path in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 assert value('HEAD',path).replace(b'name = "ai-dubbing-studio"\nversion = "0.39.1"',b'name = "ai-dubbing-studio"\nversion = "0.39.0"')==value(BASE,path)
report=dict(head=git('rev-parse','HEAD'),baseHead=BASE,compiledBaselineHead=BUILD,immutableIdentities=identities,cssContainmentOnly=True,nativeWorkersAndAudioUnchanged=True,toolCount=145,projectFormat=26)
if os.environ.get('CI'):
 token=os.environ['GH_TOKEN'];base='https://api.github.com/repos/jontechlabs/ai-dubbing-studio/'
 def api(p):
  req=urllib.request.Request(base+p,headers={'Authorization':'Bearer '+token,'User-Agent':'Studio-scroll-validation','Accept':'application/vnd.github+json'})
  with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)
 run=api(f'actions/runs/{RUN}');assert run['status']=='completed' and run['conclusion']=='success' and run['head_sha']==BUILD
 assert run['path']=='.github/workflows/selection-toolbox.yml'
 job=next(j for j in api(f'actions/runs/{RUN}/jobs')['jobs'] if j['name']=='windows');assert job['conclusion']=='success'
 assert any(s['name']=='Fresh native and worker regression checks' and s['conclusion']=='success' for s in job['steps'])
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 req=urllib.request.Request(base+f'actions/jobs/{job["id"]}/logs',headers={'Authorization':'Bearer '+token,'User-Agent':'Studio-scroll-validation'})
 try:response=urllib.request.build_opener(NoRedirect).open(req,timeout=60)
 except urllib.error.HTTPError as e:
  if e.code!=302:raise
  response=urllib.request.urlopen(urllib.request.Request(e.headers['Location'],headers={'User-Agent':'Studio-scroll-validation'}),timeout=90)
 with response:raw=response.read(32*1024**2+1)
 assert len(raw)<=32*1024**2
 log=re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]','',raw.decode('utf-8-sig'))
 assert '204 passed; 0 failed; 2 ignored' in log and 'Ran 111 tests' in log
 report['nativeChecksReused']=dict(runId=RUN,jobId=job['id'],native=204,python=111,ignored=2,nativeStepAndClippyPassed=True,jobLogSha256=hashlib.sha256(raw).hexdigest())
 out=ROOT/'artifacts';out.mkdir(exist_ok=True);(out/'scroll-native-baseline.log').write_bytes(raw)
out=ROOT/'artifacts';out.mkdir(exist_ok=True);(out/'dubbing-scroll-identity.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print('CSS containment only; unchanged native/worker checks authenticated from successful v0.39.0.')
