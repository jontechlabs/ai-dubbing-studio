"""Reuse only passed Chrome/native checks whose entire inputs are identical.

New Python/model resources still require fresh worker/full-weight checks. The
Windows executable is rebuilt or separately authenticated as byte-identical,
then actual ASR and packaged SDK tests run again.
"""
from pathlib import Path
import json,os,re,subprocess,sys,urllib.error,urllib.request
ROOT=Path(__file__).resolve().parents[1]
run_id=sys.argv[1];assert run_id.isdigit()
def command(*args):return subprocess.check_output(args,cwd=ROOT,text=True,encoding='utf-8',errors='replace').strip()
run=json.loads(command('gh','api',f'repos/jontechlabs/ai-dubbing-studio/actions/runs/{run_id}'))
assert run['status']=='completed' and run['path']=='.github/workflows/dubbing-workbench.yml'
jobs=json.loads(command('gh','api',f'repos/jontechlabs/ai-dubbing-studio/actions/runs/{run_id}/jobs?per_page=100'))
assert jobs['total_count']<=100
steps=[s for j in jobs['jobs'] for s in j['steps']]
assert any(s['name']=='Frontend unit, browser, formatting, lint and MCP schemas' and s['conclusion']=='success' for s in steps)
head=command('git','rev-parse','HEAD');old=run['head_sha'];subprocess.run(['git','merge-base','--is-ancestor',old,head],cwd=ROOT,check=True)
protected=['src','src-tauri/tauri.conf.json','package.json','pnpm-lock.yaml','public','resources','scripts/generate-mcp.mjs','vite.config.ts','tsconfig.json','eslint.config.js','playwright.config.ts','tests/e2e']
changed=command('git','diff','--name-only',old,head,'--',*protected);assert not changed,changed
assert jobs['jobs'] and all(j['status']=='completed' for j in jobs['jobs'])
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
def job_log(job_id):
 request=urllib.request.Request(f'https://api.github.com/repos/jontechlabs/ai-dubbing-studio/actions/jobs/{job_id}/logs',headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-CI-proof'})
 try:response=urllib.request.build_opener(NoRedirect).open(request,timeout=60)
 except urllib.error.HTTPError as error:
  if error.code!=302:raise RuntimeError('Raw job log HTTP '+str(error.code)) from None
  response=urllib.request.urlopen(urllib.request.Request(error.headers['Location'],headers={'User-Agent':'Studio-CI-proof'}),timeout=60)
 with response:body=response.read(32*1024**2+1)
 assert len(body)<=32*1024**2
 return body.decode('utf-8-sig',errors='replace')
log='\n'.join(job_log(j['id']) for j in jobs['jobs'])
log=re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]','',log)
assert re.search(r'\b207 passed\b',log),'207 Chrome checks required'
assert re.search(r'Tests\s+198 passed',log),'198 TypeScript checks required'
native_unchanged=not command('git','diff','--name-only',old,head,'--','src-tauri','workers','docs/MCP.md','resources','scripts/prepare-ffmpeg.ps1','scripts/prepare-prosody.ps1')
reuse_native=native_unchanged and any(s['name']=='Native tests with real FFmpeg, lints and formatting' and s['conclusion']=='success' for s in steps)
if reuse_native:assert re.search(r'test result: ok\. 189 passed; 0 failed; 2 ignored',log)
proof=dict(runId=run_id,runConclusion=run['conclusion'],frontendStepPassed=True,nativeStepPassed=reuse_native,verifiedHead=old,head=head,native=189 if reuse_native else 0,chrome=207,typescript=198,protectedInputs=protected,sourceIdentical=True,freshChecks='198 TypeScript and 108 Python, shared schemas, real Japanese ASR, full-weight separators and packaged MCP SDK; only explicitly authenticated identical checks/packages may be reused')
out=ROOT/'artifacts';out.mkdir(exist_ok=True);(out/'reused-ui-native-validation.json').write_text(json.dumps(proof,indent=2)+'\n')
with open(os.environ['GITHUB_ENV'],'a',encoding='utf-8') as f:
 f.write('STUDIO_REUSED_CHROME=1\n')
 if reuse_native:f.write('STUDIO_REUSED_NATIVE_UI=1\n')
print('Identical Chrome inputs verified against successful frontend step',run_id,old,'; native checks reused:',reuse_native)
