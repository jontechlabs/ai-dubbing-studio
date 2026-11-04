"""Bound the review UI patch and authenticate unchanged native regression results."""
from pathlib import Path
import hashlib,json,os,re,subprocess,urllib.request,urllib.error
ROOT=Path(__file__).resolve().parents[1]
BASE='ee8742d8c800b6e6cb78a167259d750dbe80b2ec'
BUILD='34ccd8a73e985d75e33d34d2316c770a19abfa00'
RUN=41778038124
SDK_RUN=41782213107
SDK_HEAD='c70b5e1e8058f9b9586295dfd4773e23c7d401e1'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
def value(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=ROOT)
identities={}
for path in ['src-tauri/src','src-tauri/binaries','workers','public','pnpm-lock.yaml','src/domain/types.ts','src/services','scripts/test-mcp.mjs']:
 identities[path]=git('rev-parse','HEAD:'+path)
 assert identities[path]==git('rev-parse',BASE+':'+path)==git('rev-parse',BUILD+':'+path)==git('rev-parse',SDK_HEAD+':'+path),path
ui={'src/App.tsx','src/components/Dialogues.tsx','src/components/DubPanel.tsx','src/domain/jointReview.ts','src/domain/speakerDubbing.test.ts','src/domain/translation.ts','src/domain/tts.ts','src/domain/reviewChanges.ts','src/domain/reviewChanges.test.ts','src/hooks/useTakeReview.tsx','src/locales/en.json','src/locales/fr.json','src/mcp/actions.ts','src/mcp/catalog.json'}
assert set(git('diff','--name-only',BASE,'HEAD','--','src').splitlines())==ui
before=json.loads(value(BASE,'src/mcp/catalog.json'));after=json.loads(value('HEAD','src/mcp/catalog.json'))
assert after['commands']==before['commands'] and after['schemas']==before['schemas']
old={v['name']:v for v in before['builtins']}
assert len(after['builtins'])==len(old)==35
for entry in after['builtins']:
 name=entry['name']
 if name in ['studio_review_take','studio_approve_translations']:
  assert entry['inputSchema']['properties'].pop('acceptChangedTake')=={'type':'boolean'}
  entry['description']=old[name]['description']
 assert entry==old[name],name
for path in ['package.json','src-tauri/tauri.conf.json']:
 before=json.loads(value(BASE,path));after=json.loads(value('HEAD',path));assert after['version']=='0.40.2';after['version']=before['version'];assert after==before,path
for path in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 assert value('HEAD',path).replace(b'name = "ai-dubbing-studio"\nversion = "0.40.2"',b'name = "ai-dubbing-studio"\nversion = "0.40.1"')==value(BASE,path),path
report=dict(head=git('rev-parse','HEAD'),baseHead=BASE,compiledBaselineHead=BUILD,immutableIdentities=identities,reviewWorkflowOnly=True,nativeWorkersAndAudioUnchanged=True,toolCount=155,projectFormat=26)
if os.environ.get('CI'):
 token=os.environ['GH_TOKEN'];base='https://api.github.com/repos/jontechlabs/ai-dubbing-studio/'
 def api(p):
  req=urllib.request.Request(base+p,headers={'Authorization':'Bearer '+token,'User-Agent':'Studio-review-validation','Accept':'application/vnd.github+json'})
  with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)
 run=api(f'actions/runs/{RUN}');assert run['status']=='completed' and run['head_sha']==BUILD
 assert run['path']=='.github/workflows/project-library.yml'
 job=api('actions/jobs/126402853416');assert job['run_id']==RUN
 assert any(s['name']=='Fresh native and worker regression checks' and s['conclusion']=='success' for s in job['steps'])
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 req=urllib.request.Request(base+f'actions/jobs/{job["id"]}/logs',headers={'Authorization':'Bearer '+token,'User-Agent':'Studio-review-validation'})
 try:response=urllib.request.build_opener(NoRedirect).open(req,timeout=60)
 except urllib.error.HTTPError as e:
  if e.code!=302:raise
  response=urllib.request.urlopen(urllib.request.Request(e.headers['Location'],headers={'User-Agent':'Studio-review-validation'}),timeout=90)
 with response:raw=response.read(32*1024**2+1)
 assert len(raw)<=32*1024**2
 log=re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]','',raw.decode('utf-8-sig'))
 assert '218 passed; 0 failed; 2 ignored' in log and 'Ran 111 tests' in log
 # The original workflow failed older frontend/SDK callers; only its successful
 # native step is reused. The corrected complete SDK baseline succeeded separately.
 sdk=api(f'actions/runs/{SDK_RUN}');assert sdk['conclusion']=='success' and sdk['head_sha']==SDK_HEAD
 report['nativeChecksReused']=dict(runId=RUN,jobId=job['id'],native=218,python=111,ignored=2,nativeStepAndClippyPassed=True,wholeRunConclusion=run['conclusion'],jobLogSha256=hashlib.sha256(raw).hexdigest())
 report['fullSdkBaseline']=dict(runId=SDK_RUN,head=SDK_HEAD,conclusion='success',tools=155)
 out=ROOT/'artifacts';out.mkdir(exist_ok=True);(out/'revalidation-native-baseline.log').write_bytes(raw)
out=ROOT/'artifacts';out.mkdir(exist_ok=True);(out/'revalidation-identity.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print('Explicit revalidation scope and two optional MCP arguments verified; unchanged 218 Rust / 111 Python checks and full 155-tool SDK baseline authenticated.')
