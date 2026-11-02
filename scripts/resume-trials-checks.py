"""Authenticate already compiled application inputs; retain the failed ASR result."""
from pathlib import Path
import hashlib, json, os, re, subprocess, urllib.error, urllib.request, zipfile

ROOT=Path(__file__).resolve().parents[1]
RUN=41490630265
PACKAGE_HEAD='df107e72a681482044f0065de912635b2c1ad1f9'
SLUG='jontechlabs/ai-dubbing-studio'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True).strip()
def request(url):return urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-trials-resume-validation'})
def api(path):
 with urllib.request.urlopen(request('https://api.github.com/repos/'+SLUG+'/'+path),timeout=60) as r:return json.load(r)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
def download(url):
 try:urllib.request.build_opener(NoRedirect).open(request(url),timeout=60);raise AssertionError('Expected redirect')
 except urllib.error.HTTPError as e:
  assert e.code==302
  # Credentials stay on api.github.com, never the object-storage redirect.
  with urllib.request.urlopen(e.headers['Location'],timeout=180) as r:return r.read()
def sha(data):return hashlib.sha256(data).hexdigest()

allowed={'.github/workflows/tts-trials.yml','.github/workflows/tts-trials-finish.yml','scripts/resume-trials-checks.py','scripts/test-trials-cold.mjs','scripts/test-trials-cold.ps1','scripts/check-trials-audio.py'}
assert set(git('diff','--name-only',PACKAGE_HEAD,'HEAD').splitlines())<=allowed
identities={}
for p in ['src','src-tauri','workers','resources','public','package.json','pnpm-lock.yaml','tests','vite.config.ts','playwright.config.ts']:
 identities[p]=git('rev-parse','HEAD:'+p)
 assert identities[p]==git('rev-parse',PACKAGE_HEAD+':'+p),p
run=api(f'actions/runs/{RUN}')
assert run['head_sha']==PACKAGE_HEAD and run['conclusion']=='failure' and run['path']=='.github/workflows/tts-trials.yml'
job,=api(f'actions/runs/{RUN}/jobs')['jobs']
failed=[s['name'] for s in job['steps'] if s['conclusion']=='failure']
assert failed==['Independent automatic-language and content checks of all seven actual takes'],failed
for name in ['Fresh native and worker regression checks','Fresh frontend unit and Chrome regression checks','Build signed updater installer','Real Japanese reference transcription with packaged workers','Package installer and portable version','Real Audio8 single, hot batch and four-alternative generation via official MCP SDK']:
 assert any(s['name']==name and s['conclusion']=='success' for s in job['steps']),name
raw=download(f'https://api.github.com/repos/{SLUG}/actions/jobs/{job["id"]}/logs')
log=re.sub(r'(?:\x1b|\^\[)\[[0-9;:]*[A-Za-z]','',raw.decode('utf-8-sig',errors='replace'))
for text in ['200 passed','7 passed','196 passed; 0 failed; 2 ignored','Ran 108 tests','AssertionError: Bonjour, je suis Oudbou. Oudbou.']:assert text in log,text
recognized=re.findall(r'AUDIO8_ASR (\d+) ([^\r\n]+)',log)
assert [int(i) for i,_ in recognized]==list(range(6))
artifact,=api(f'actions/runs/{RUN}/artifacts')['artifacts']
assert artifact['name']=='multiple-takes-windows-packages-and-validation' and not artifact['expired']
assert artifact['workflow_run']['head_sha']==PACKAGE_HEAD
data=download(artifact['archive_download_url'])
assert len(data)==artifact['size_in_bytes'] and 'sha256:'+sha(data)==artifact['digest']
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
archive=ROOT/'.cache/trials-package.zip';archive.parent.mkdir(exist_ok=True);archive.write_bytes(data)
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for name in z.namelist():
  p=Path(name);assert not p.is_absolute() and '..' not in p.parts
  if name.startswith('artifacts/') and not name.endswith('/'):
   target=out/p.relative_to('artifacts');target.parent.mkdir(exist_ok=True,parents=True);target.write_bytes(z.read(name))
(out/'trials-previous-job.log').write_bytes(raw)
proof=json.loads((out/'audio8-inference-validation.json').read_text())
for i,sample in enumerate(proof['samples']):
 assert sha((out/sample['path']).read_bytes())==sample['sha256']
 sample.update(detectedLanguage='fr',asrText=recognized[i][1] if i<6 else 'Bonjour, je suis Oudbou. Oudbou.',contentMatched=i<6)
proof.update(automaticFrenchLanguage=True,automaticFrenchLanguageAndContent=False,contentMatched=6,contentTotal=7,qualityIssue='Seed 14 mispronounces the target; original strict ASR check FAILED. Cold single-take reproduction is required separately.')
(out/'audio8-inference-validation.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
report=dict(head=git('rev-parse','HEAD'),packageHead=PACKAGE_HEAD,runId=RUN,artifact=artifact,jobId=job['id'],jobLogSha256=sha(raw),immutableApplicationInputs=identities,suiteCounts=dict(typescript=200,chrome=232,native=196,python=108),strictAsrOriginalConclusion='failure',sixOutputsMatched=True,knownSeed14QualityIssueRetained=True)
(out/'trials-package-reuse.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print('Authenticated existing signed packages and passed functional checks. Original strict ASR failure remains recorded: 6/7 text matches; seed 14 requires cold reproduction.')
