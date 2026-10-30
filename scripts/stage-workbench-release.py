"""Stage v0.32.4 packages as a draft, only after authenticated CI evidence.

Never publishes a release, changes its tag or pushes an updater feed. The final
source archive is optional and must retain every compiled application input.
"""
from pathlib import Path
import argparse,ctypes,hashlib,json,os,re,subprocess,urllib.error,urllib.parse,urllib.request,zipfile
ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.cache/release-stage';WORK.mkdir(parents=True,exist_ok=True)
PROOF=ROOT/'.cache/release-stage-proof';PROOF.mkdir(parents=True,exist_ok=True)
SLUG='jontechlabs/ai-dubbing-studio';VERSION='0.32.4';TAG='v'+VERSION
TOKEN=os.environ['GH_TOKEN'];HEADERS={'Authorization':'Bearer '+TOKEN,'User-Agent':'Studio-v032-validated-stage'}
def gh(*args):return subprocess.check_output(['gh',*map(str,args)],cwd=ROOT,text=True,encoding='utf-8',errors='replace').strip()
def git(*args):return subprocess.check_output(['git',*map(str,args)],cwd=ROOT,text=True,encoding='utf-8').strip()
def sha(path):
 with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def api(path):
 try:
  with urllib.request.urlopen(urllib.request.Request('https://api.github.com/repos/'+SLUG+'/'+path,headers=HEADERS),timeout=60) as r:return json.load(r)
 except urllib.error.HTTPError as e:raise RuntimeError('GitHub API HTTP '+str(e.code)) from None
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
def download_artifact(run_id,name,folder):
 artifact=next(a for a in api(f'actions/runs/{run_id}/artifacts')['artifacts'] if a['name']==name)
 archive=WORK/(str(artifact['id'])+'.zip')
 if not archive.exists() or 'sha256:'+sha(archive)!=artifact['digest']:
  try:
   urllib.request.build_opener(NoRedirect).open(urllib.request.Request(artifact['archive_download_url'],headers=HEADERS),timeout=60)
   raise RuntimeError('Expected artifact redirect')
  except urllib.error.HTTPError as e:
   if e.code!=302:raise RuntimeError('Artifact redirect HTTP '+str(e.code)) from None
   url=e.headers['Location']
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Studio-v032-validated-stage'}),timeout=300) as r,archive.open('wb') as out:
    while b:=r.read(1024**2):out.write(b)
  except Exception as e:raise RuntimeError('Artifact transport failed: '+type(e).__name__) from None
 assert archive.stat().st_size==artifact['size_in_bytes'] and 'sha256:'+sha(archive)==artifact['digest']
 folder.mkdir(exist_ok=True)
 with zipfile.ZipFile(archive) as z:
  assert all((folder/p).resolve().is_relative_to(folder.resolve()) for p in z.namelist());assert z.testzip() is None;z.extractall(folder)
 return artifact
def read(path):return json.loads(path.read_text(encoding='utf-8-sig'))
def assert_source_inputs(code_head,target_head):
 subprocess.run(['git','merge-base','--is-ancestor',code_head,target_head],cwd=ROOT,check=True)
 changed=git('diff','--name-only',code_head,target_head,'--','src','src-tauri','workers','public','resources','package.json','pnpm-lock.yaml','docs/MCP.md').splitlines()
 assert set(changed)<={'resources/updates/windows-x64.json'},changed
def version_of(path):
 class Fixed(ctypes.Structure):_fields_=[(n,ctypes.c_uint32) for n in ['signature','struct','fileMS','fileLS','productMS','productLS','flagsMask','flags','os','type','subtype','dateMS','dateLS']]
 size=ctypes.windll.version.GetFileVersionInfoSizeW(str(path),None);assert size
 buf=ctypes.create_string_buffer(size);assert ctypes.windll.version.GetFileVersionInfoW(str(path),0,size,buf)
 pointer=ctypes.c_void_p();length=ctypes.c_uint();assert ctypes.windll.version.VerQueryValueW(buf,'\\',ctypes.byref(pointer),ctypes.byref(length))
 v=ctypes.cast(pointer,ctypes.POINTER(Fixed)).contents;return (v.productMS>>16,v.productMS&65535,v.productLS>>16,v.productLS&65535)
def no_private_entries(z):
 for name in z.namelist():
  parts=Path(name).parts
  assert '..' not in parts and not Path(name).is_absolute()
  assert not any(p in ['.git','node_modules','target','.cache'] for p in parts),name
  assert Path(name).suffix.lower() not in ['.key','.pfx','.p12','.ckpt','.safetensors','.gguf','.th'],name
  assert Path(name).name not in ['.env','mcp-endpoint.json','mcp-token','mcp-token.txt'],name
def upload(path):
 release=api('releases/'+str(DRAFT_ID));assert release['draft'] and release['prerelease']
 old=next((a for a in release['assets'] if a['name']==path.name),None)
 if old:assert old['digest']=='sha256:'+sha(path) and old['size']==path.stat().st_size
 else:
  url=f'https://uploads.github.com/repos/{SLUG}/releases/{DRAFT_ID}/assets?name='+urllib.parse.quote(path.name)
  try:
   with path.open('rb') as data:
    request=urllib.request.Request(url,data=data,headers={**HEADERS,'Content-Type':'application/octet-stream','Content-Length':str(path.stat().st_size)},method='POST')
    with urllib.request.build_opener(NoRedirect).open(request,timeout=300) as response:assert response.status==201
  except urllib.error.HTTPError as e:raise RuntimeError('Draft asset upload HTTP '+str(e.code)) from None
 asset=next(a for a in api('releases/'+str(DRAFT_ID))['assets'] if a['name']==path.name)
 assert asset['digest']=='sha256:'+sha(path) and asset['size']==path.stat().st_size and asset['state']=='uploaded'
 return dict(name=path.name,size=asset['size'],sha256=sha(path),id=asset['id'])
def main():
 global DRAFT_ID
 parser=argparse.ArgumentParser();parser.add_argument('--run',required=True);parser.add_argument('--models-run',required=True);parser.add_argument('--final-head');args=parser.parse_args()
 assert args.run.isdigit() and args.models_run.isdigit()
 run=api('actions/runs/'+args.run);assert run['status']=='completed' and run['conclusion']=='success' and run['path']=='.github/workflows/dubbing-workbench.yml'
 code_head=run['head_sha'];target=args.final_head or git('rev-parse','HEAD');assert re.fullmatch('[0-9a-f]{40}',target);assert_source_inputs(code_head,target)
 assert read(ROOT/'package.json')['version']==VERSION
 jobs=api(f'actions/runs/{args.run}/jobs?per_page=100')['jobs'];assert len(jobs)==1 and jobs[0]['conclusion']=='success'
 assert all(s['conclusion'] in ['success','skipped'] for s in jobs[0]['steps'])
 log=re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]','',gh('run','view',args.run,'--log'))
 for marker in ['199 passed','183 passed; 0 failed','Ran 103 tests','MCP_NATIVE_PROOF','Local Japanese transcription (ja)']:assert marker in log,marker
 ci=WORK/'ci';artifact=download_artifact(args.run,'windows-x64-development-build',ci);assert artifact['workflow_run']['head_sha']==code_head
 native=read(ci/'mcp-native-validation.json');assert native['officialSdk'] and native['toolCount']==134 and native['version']==VERSION
 assert native['jointReview']['commonSnapshot'] and native['jointReview']['subtitlesAndEveryTakePreserved'] and native['jointReview']['exclusionSkippedByBatch']
 assert native['dubbingWorkbench']['tools']==7 and native['dubbingWorkbench']['projectAndTakesUnchanged']
 assert native['sourceAndVolume']['allExistingTakesPreserved'] and native['sourceAndVolume']['staleRejected']
 identity=read(ci/'workbench-validation.json');assert identity['head']==code_head and len(identity['existingWorkerIdentities'])==327
 assert '188 passed' in log and '183 passed; 0 failed' in log
 reused=dict(head=code_head,chrome=199,native=183,typescript=188,sourceIdentical=True,frontendStepPassed=True,fresh=True)
 for row in read(ci/'reference-transcription-validation.json'):assert row['device']=='CPU' and '中学' in row['text']
 model_run=api('actions/runs/'+args.models_run);assert model_run['status']=='completed' and model_run['conclusion']=='success' and model_run['path']=='.github/workflows/audio-toolbox-smoke.yml'
 model_dir=WORK/'models';model_artifact=download_artifact(args.models_run,'audio-toolbox-model-validation',model_dir)
 model=read(next(model_dir.rglob('audio-toolbox-validation.json')));assert model['head']==model_run['head_sha'] and model_artifact['workflow_run']['head_sha']==model_run['head_sha']
 assert {r['model'] for r in model['models']}=={'bs-roformer-viperx-1297','mel-band-roformer-kim','htdemucs','htdemucs-ft','audiosep'}
 assert all(r['frames']==60000 and r['device']=='CPU' and r['sourceUnchanged'] for r in model['models']) and not model['gpuBenchmark']
 assert model['identities']==identity['newToolboxIdentities']
 assert all(sha(ROOT/p)==digest for p,digest in model['identities'].items())
 expected={}
 for line in (ci/'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
  digest,name=line.split('  ',1);assert Path(name).name==name and sha(ci/name)==digest;expected[name]=digest
 setup=ci/f'AI-Dubbing-Studio-{VERSION}-Setup.exe';signature=setup.with_suffix('.exe.sig');portable=ci/'AI-Dubbing-Studio-Windows-Portable.zip'
 assert version_of(setup)==(0,32,4,0)
 subprocess.run(['cargo','run','--quiet','--locked','--manifest-path','scripts/verify-update-signature/Cargo.toml','--','src-tauri/tauri.conf.json',str(setup),str(signature)],cwd=ROOT,check=True)
 with zipfile.ZipFile(portable) as z:
  no_private_entries(z);assert z.testzip() is None;prefix='AI-Dubbing-Studio-Windows/'
  assert prefix+'AI Dubbing Studio.exe' in z.namelist() and prefix+'binaries/ffmpeg.exe' in z.namelist()
  for p,digest in model['identities'].items():assert hashlib.sha256(z.read(prefix+p)).hexdigest()==digest,p
  expected_workers=set()
  for relative,destination in read(ROOT/'src-tauri/tauri.conf.json')['bundle']['resources'].items():
   if not destination.startswith('workers/'):continue
   source=(ROOT/'src-tauri'/relative).resolve();assert source.is_relative_to((ROOT/'workers').resolve())
   entries=source.rglob('*') if source.is_dir() else [source]
   for p in entries:
    if not p.is_file():continue
    name=destination.rstrip('/')+'/'+p.relative_to(source).as_posix() if source.is_dir() else destination
    assert '__pycache__' not in p.parts and p.suffix!='.pyc'
    assert z.read(prefix+name)==p.read_bytes(),name;expected_workers.add(prefix+name)
  assert {p for p in z.namelist() if p.startswith(prefix+'workers/') and not p.endswith('/')}==expected_workers
 # A draft with no published tag is not returned by /releases/tags/:tag.
 # Resolve it explicitly from the authenticated draft-inclusive release list.
 release=next((r for r in api('releases?per_page=100') if r['tag_name']==TAG),None)
 assert release is not None,'Prepare the verified draft with the authorized GitHub account before staging.'
 DRAFT_ID=release['id']
 assert release['draft'] and release['prerelease'];allowed=set(expected)|{f'AI-Dubbing-Studio-{VERSION}-Sources.zip','SHA256SUMS.txt'};assert all(a['name'] in allowed for a in release['assets'])
 assets=[upload(p) for p in [setup,signature,portable]]
 if args.final_head:
  source=WORK/f'AI-Dubbing-Studio-{VERSION}-Sources.zip';subprocess.run(['git','archive','--format=zip','--output='+str(source),target],cwd=ROOT,check=True)
  with zipfile.ZipFile(source) as z:
   no_private_entries(z);assert z.testzip() is None;assert read(ROOT/'package.json')['version']==json.loads(z.read('package.json'))['version']
   for p,digest in model['identities'].items():assert hashlib.sha256(z.read(p)).hexdigest()==digest
  assets.append(upload(source));sums=WORK/'SHA256SUMS.txt';sums.write_text(''.join(f'{a["sha256"]}  {a["name"]}\n' for a in assets),encoding='utf-8');assets.append(upload(sums))
 report=dict(version=VERSION,releaseId=release['id'],isDraft=True,runId=args.run,codeHead=code_head,sourceHead=args.final_head,modelsRun=args.models_run,modelHead=model['head'],artifactSha256=artifact['digest'],modelArtifactSha256=model_artifact['digest'],signatureVerified=True,tamperRejected=True,installerVersion=[0,32,4,0],assets=assets,signature=signature.read_text().strip(),toolCount=134,suiteCounts=dict(typescript=188,chrome=199,native=183,python=103),chromeProof=reused,neuralModels=model)
 (PROOF/'release-stage-validation.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
 for name in ['mcp-native-validation.json','workbench-validation.json','reference-transcription-validation.json']:(PROOF/name).write_bytes((ci/name).read_bytes())
 print('Draft packages staged and authenticated; no publication or updater push performed.',flush=True)
if __name__=='__main__':main()
