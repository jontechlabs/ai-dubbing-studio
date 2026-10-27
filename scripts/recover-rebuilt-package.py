"""Authenticate the exact rebuilt binary and completed neural checks for VC-only completion."""
from pathlib import Path, PurePosixPath
import hashlib,json,os,re,shutil,subprocess,tempfile,urllib.request,zipfile
ROOT=Path(__file__).resolve().parents[1]
REPO='jontechlabs/ai-dubbing-studio'
RUN=40542206709
BUILD='4ee643d9988e9da356c4d4543ddb4fde7500b2f9'
APP='884f24423d0929749f554d3baf235322e708f2f8'
ALLOWED={'.github/workflows/complete-neural-rebuild.yml','scripts/recover-rebuilt-package.py','scripts/test-voice-conversion.py','scripts/test-multilingual.ps1','tests/fixtures/voice-conversion-source-fr.wav','tests/fixtures/voice-conversion-source-fr.json'}
def api(path):
    req=urllib.request.Request('https://api.github.com/repos/'+REPO+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-rebuilt-package-validation'})
    with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)
def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def log(run):
    return re.sub(r'(?:\x1b|\^\[)\[[0-?]*[ -/]*[@-~]','',subprocess.check_output(['gh','run','view',str(run),'--log'],cwd=ROOT,encoding='utf8'))
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
subprocess.run(['git','merge-base','--is-ancestor',BUILD,head],cwd=ROOT,check=True)
changed=set(subprocess.check_output(['git','diff','--name-only',BUILD,head],cwd=ROOT,text=True).splitlines())
assert changed and changed<=ALLOWED,sorted(changed-ALLOWED)
run=api(f'/actions/runs/{RUN}')
assert run['head_sha']==BUILD and run['status']=='completed' and run['conclusion']=='failure' and run['path']=='.github/workflows/rebuild-neural.yml'
jobs=api(f'/actions/runs/{RUN}/jobs')['jobs'];assert len(jobs)==1
job=jobs[0];assert job['name']=='rebuild-and-complete'
neural='Fresh Chatterbox and conversion with authenticated Vox proofs'
assert [s['name'] for s in job['steps'] if s['conclusion']=='failure']==[neural]
boundary=next(i for i,s in enumerate(job['steps']) if s['name']==neural)
assert all(s['conclusion']=='success' for s in job['steps'][:boundary])
artifact=next(a for a in api(f'/actions/runs/{RUN}/artifacts')['artifacts'] if a['name']=='failure-diagnostics' and not a['expired'])
assert artifact['workflow_run']['head_sha']==BUILD
output=ROOT/'artifacts';output.mkdir(exist_ok=True)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
try:
    urllib.request.build_opener(NoRedirect).open(urllib.request.Request(artifact['archive_download_url'],headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-package-recovery'}),timeout=60)
    raise AssertionError('Expected authenticated redirect')
except urllib.error.HTTPError as e:
    assert e.code==302
    location=e.headers['Location']
with tempfile.TemporaryFile() as f:
    sha=hashlib.sha256();count=0
    with urllib.request.urlopen(location,timeout=180) as response:
        while data:=response.read(1024*1024):f.write(data);sha.update(data);count+=len(data)
    assert count==artifact['size_in_bytes'] and artifact['digest']=='sha256:'+sha.hexdigest()
    f.seek(0)
    with zipfile.ZipFile(f) as z:
        names=[n for n in z.namelist() if n.startswith('artifacts/')]
        assert len(names)==14
        for name in names:
            p=PurePosixPath(name);assert len(p.parts)==2
            (output/p.name).write_bytes(z.read(name))
hashes={}
for line in (output/'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
    sha,name=line.split('  ',1);assert name in {'AI-Dubbing-Studio-0.30.0-Setup.exe','AI-Dubbing-Studio-0.30.0-Setup.exe.sig','AI-Dubbing-Studio-Windows-Portable.zip'}
    assert digest(output/name)==sha;hashes[name]=sha
assert len(hashes)==3
source=json.loads((output/'source-rebuild-validation.json').read_text())
assert source['rebuildHead']==BUILD and source['baseHead']==APP and source['baseRun']==40526247349 and source['sameApplicationSource']
original=log(40526247349);rebuilt=log(RUN)
assert source['baseLogSha256']==hashlib.sha256(original.encode()).hexdigest()
def marker(text,name):
    rows=[r.split(name,1)[1].strip() for r in text.splitlines() if name in r];assert len(rows)==1,(name,len(rows))
    return json.loads(rows[0])
assert marker(rebuilt,'IDENTICAL_APP_SOURCE_AND_BASE_CHECKS ')==source
proof=json.loads((output/'multilingual-inference-validation.json').read_text())
assert proof['authenticatedVoxBaseRun']==40526247349 and proof['packagedWorkers'] and proof['embeddedPython']
assert {e['id'] for e in proof['engines']}=={'voxcpm2-bf16','chatterbox-multilingual-v3'}
assert all(e['standardTextWordOverlap']>=4 and e['customLanguage']=='fr' and e['hotQualityReset'] and e['standardQuality'] for e in proof['engines'])
assert next(e for e in proof['engines'] if e['id']=='chatterbox-multilingual-v3')==marker(rebuilt,'ACTUAL_MULTILINGUAL_PROOF ')
assert next(e for e in proof['engines'] if e['id']=='voxcpm2-bf16')==marker(original,'ACTUAL_MULTILINGUAL_PROOF ')
assert proof['voiceLibraryGuides']==marker(original,'VOICE_LIBRARY_GUIDE_PROOF ')
assert 'AssertionError: Bonjour, je suis à haute bourgoire.' in rebuilt
directory=ROOT/'.cache/recovered-desktop';directory.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(output/'AI-Dubbing-Studio-Windows-Portable.zip') as z:
    for entry in z.infolist():
        p=PurePosixPath(entry.filename)
        assert p.parts[0]=='AI-Dubbing-Studio-Windows' and not p.is_absolute() and '..' not in p.parts and '\\' not in entry.filename
        assert (entry.external_attr>>16)&0o170000!=0o120000
        target=directory.joinpath(*p.parts[1:]);assert target.resolve().is_relative_to(directory.resolve())
        if entry.is_dir():target.mkdir(parents=True,exist_ok=True)
        else:
            target.parent.mkdir(parents=True,exist_ok=True)
            with z.open(entry) as src,target.open('wb') as dst:shutil.copyfileobj(src,dst)
release=ROOT/'src-tauri/target/release';release.mkdir(parents=True,exist_ok=True)
shutil.copyfile(directory/'AI Dubbing Studio.exe',release/'ai-dubbing-studio.exe')
shutil.copytree(directory/'workers',release/'workers',dirs_exist_ok=True)
shutil.copytree(directory/'binaries',ROOT/'src-tauri/binaries',dirs_exist_ok=True)
asr=ROOT/'.cache/reference-transcription/Référence 日本語';asr.mkdir(parents=True,exist_ok=True)
for url,name,sha in [
    ('https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin','ggml-small-q5_1.bin','ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'),
    ('https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/ja.wav','ja.wav','460bd8dccb0d2a5f4e29c628f837be4082d13defc64c3fc21dd1b6bb0e119095')]:
    with urllib.request.urlopen(url,timeout=180) as src,(asr/name).open('wb') as dst:shutil.copyfileobj(src,dst)
    assert digest(asr/name)==sha
result=dict(buildRun=RUN,buildHead=BUILD,validationHead=head,sourceUnchanged=True,changedTestFiles=sorted(changed),artifactId=artifact['id'],artifactDigest=artifact['digest'],buildHashes=hashes,multilingualProofAuthenticated=True,priorVcFailure='Unseeded cascaded/watermarked synthetic input: French output ASR found 3 of 7 expected words; output gate retained, fixed clean source and seed 0 now used for repeatable diagnostic.')
(output/'neural-completion-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print('AUTHENTICATED_REBUILT_PACKAGE',json.dumps(result),flush=True)
