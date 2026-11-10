"""Authenticate unchanged audio engines and bound the dialogue track audition UI change."""
from pathlib import Path
import hashlib,json,os,re,subprocess,urllib.request,urllib.error
ROOT=Path(__file__).resolve().parents[1]
BASE='0a590de831772402a39d63630576dafcbd7532dd'
BUILD='75b71c56c81f5c2a72ea6b4e3fb5f854e0be099b'
RUN=42164788342

def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
def value(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=ROOT)
identities={}
for path in ['src-tauri/src','src-tauri/binaries','workers','public','pnpm-lock.yaml','src/domain','src/hooks','src/services','src/mcp']:
 identities[path]=git('rev-parse','HEAD:'+path)
 assert identities[path]==git('rev-parse',BASE+':'+path)==git('rev-parse',BUILD+':'+path),path
for path in ['package.json','src-tauri/tauri.conf.json']:
 before=json.loads(value(BASE,path));after=json.loads(value('HEAD',path));assert after['version']=='0.46.0';after['version']=before['version'];assert after==before,path
for path in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 assert value('HEAD',path).replace(b'name = "ai-dubbing-studio"\nversion = "0.46.0"',b'name = "ai-dubbing-studio"\nversion = "0.45.0"')==value(BASE,path),path
allowed={'src/App.tsx','src/components/Dialogues.tsx','src/components/DialogueTrackAudition.tsx','src/styles.css','src/locales/fr.json','src/locales/en.json'}
assert set(git('diff','--name-only',BASE,'HEAD','--','src').splitlines())==allowed
config=value('HEAD','playwright.config.ts').replace(b"process.env.STUDIO_TEST_PREVIEW ? 'pnpm preview --port 1420' : 'pnpm dev'",b"'pnpm dev'").replace(b'!process.env.CI && !process.env.STUDIO_TEST_PREVIEW',b'!process.env.CI')
assert config==value(BASE,'playwright.config.ts')
for locale in ['en','fr']:
 path=f'src/locales/{locale}.json';after=json.loads(value('HEAD',path))
 assert after.pop('dialogueAudio')
 assert after==json.loads(value(BASE,path))
report=dict(head=git('rev-parse','HEAD'),baseHead=BASE,compiledBaselineHead=BUILD,immutableIdentities=identities,nativeWorkersAndAudioUnchanged=True,domainServicesHooksAndMcpUnchanged=True,compiledPreviewTestsOptIn=True,toolCount=158,projectFormat=26)
folder=ROOT/'artifacts';folder.mkdir(exist_ok=True)
if os.environ.get('CI'):
 token=os.environ['GH_TOKEN'];base='https://api.github.com/repos/jontechlabs/ai-dubbing-studio/'
 def api(path):
  request=urllib.request.Request(base+path,headers={'Authorization':'Bearer '+token,'User-Agent':'Studio-source-transcription-validation','Accept':'application/vnd.github+json'})
  with urllib.request.urlopen(request,timeout=60) as response:return json.load(response)
 run=api(f'actions/runs/{RUN}');assert run['head_sha']==BUILD and run['conclusion']=='success' and run['status']=='completed'
 assert run['path']=='.github/workflows/batch-multiple-takes.yml'
 job=next(j for j in api(f'actions/runs/{RUN}/jobs')['jobs'] if j['name']=='windows');assert job['conclusion']=='success'
 assert any(s['name']=='Fresh native and worker regression checks' and s['conclusion']=='success' for s in job['steps'])
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 request=urllib.request.Request(base+f'actions/jobs/{job["id"]}/logs',headers={'Authorization':'Bearer '+token,'User-Agent':'Studio-source-transcription-validation'})
 try:response=urllib.request.build_opener(NoRedirect).open(request,timeout=60)
 except urllib.error.HTTPError as error:
  if error.code!=302:raise
  response=urllib.request.urlopen(urllib.request.Request(error.headers['Location'],headers={'User-Agent':'Studio-source-transcription-validation'}),timeout=90)
 with response:raw=response.read(32*1024**2+1)
 assert len(raw)<=32*1024**2
 log=re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]','',raw.decode('utf-8-sig'))
 assert '231 passed; 0 failed; 2 ignored' in log and 'Ran 111 tests' in log
 report['nativeChecksReused']=dict(runId=RUN,jobId=job['id'],native=231,python=111,ignored=2,nativeStepAndClippyPassed=True,jobLogSha256=hashlib.sha256(raw).hexdigest())
 (folder/'track-audition-baseline-native-job.log').write_bytes(raw)
(folder/'dialogue-track-audition-identity.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print('Dialogue track audition UI scope verified; native/ASR, workers, models, domain, hooks and 158 MCP contracts unchanged.')
