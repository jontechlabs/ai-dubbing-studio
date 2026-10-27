"""Check a presentation-only clone-mode choice, then inherit authenticated unchanged-engine proofs."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,tempfile,urllib.request,urllib.error,zipfile
ROOT=Path(__file__).resolve().parents[1]
BASE='f843744543080d6cda2d2f2f3d2eada18faacdca'
RUN=40549500577
ALLOWED={'src/components/DubPanel.tsx','src/locales/fr.json','src/locales/en.json','tests/e2e/voice-library.pw.ts','docs/CHARACTER-VOICE-LIBRARY.md','docs/screenshots/voxcpm-ultimate-fr.png','README.md','README.fr.md','.github/workflows/voice-ui-final.yml','scripts/verify-voice-ui-final.py'}
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True).strip()
head=git('rev-parse','HEAD')
subprocess.run(['git','merge-base','--is-ancestor',BASE,head],cwd=ROOT,check=True)
changed=set(git('diff','--name-only',BASE,head).splitlines());assert changed and changed<=ALLOWED,sorted(changed-ALLOWED)
identities={}
for path in ['workers','src-tauri/src','src/domain','src/services','src/mcp','src/hooks','resources','public','pnpm-lock.yaml','package.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json']:
    identities[path]=git('rev-parse',f'HEAD:{path}')
    assert identities[path]==git('rev-parse',f'{BASE}:{path}'),path
for language in ['fr','en']:
    path=f'src/locales/{language}.json'
    before=json.loads(subprocess.check_output(['git','show',f'{BASE}:{path}'],cwd=ROOT))
    after=json.loads((ROOT/path).read_text(encoding='utf8'))
    original=before.pop('library');current=after.pop('library');assert before==after
    keys={k for k in current if current[k]!=original.get(k)}
    assert keys=={'frenchFidelityHint','voxStandardOption','voxHiFiOption','voxHybridOption','voxStandardHint','voxHiFiHint','voxHybridHint'}
output=ROOT/'artifacts';output.mkdir(exist_ok=True)
source=dict(baseHead=BASE,head=head,changedFiles=sorted(changed),immutableIdentities=identities,onlyCloneModePresentationChanged=True)
(output/'ui-source-validation.json').write_text(json.dumps(source,indent=2)+'\n')
print('VOICE_UI_SOURCE_IDENTITY',json.dumps(source),flush=True)
if '--import-evidence' not in sys.argv:sys.exit(0)
REPO='jontechlabs/ai-dubbing-studio'
def api(path):
    req=urllib.request.Request('https://api.github.com/repos/'+REPO+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-voice-ui-validation'})
    with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)
run=api(f'/actions/runs/{RUN}')
assert run['status']=='completed' and run['conclusion']=='success' and run['head_sha']==BASE and run['path']=='.github/workflows/complete-neural-rebuild.yml'
jobs=api(f'/actions/runs/{RUN}/jobs')['jobs'];assert len(jobs)==1 and jobs[0]['name']=='complete-voice-conversion' and jobs[0]['conclusion']=='success'
assert all(s['conclusion'] in ('success','skipped') for s in jobs[0]['steps'])
artifact=next(a for a in api(f'/actions/runs/{RUN}/artifacts')['artifacts'] if a['name']=='windows-x64-development-build' and not a['expired'])
assert artifact['workflow_run']['head_sha']==BASE
assets={'AI-Dubbing-Studio-0.30.0-Setup.exe','AI-Dubbing-Studio-0.30.0-Setup.exe.sig','AI-Dubbing-Studio-Windows-Portable.zip','SHA256SUMS.txt'}
diagnostics={'cosyvoice-tail-validation.txt','latentsync-core-validation.txt','drama-core-validation.txt','reference-transcription-validation.json','translation-model-validation.txt','face-detection-validation.txt','mcp-native-validation.json','multilingual-inference-validation.json','voice-conversion-validation.json','character-match-validation.json','source-rebuild-validation.json','neural-completion-validation.json'}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
try:
    urllib.request.build_opener(NoRedirect).open(urllib.request.Request(artifact['archive_download_url'],headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-neural-proof'}),timeout=60)
    raise AssertionError('Expected redirect')
except urllib.error.HTTPError as error:
    assert error.code==302;location=error.headers['Location']
with tempfile.TemporaryFile() as f:
    sha=hashlib.sha256();count=0
    with urllib.request.urlopen(location,timeout=180) as src:
        while data:=src.read(1024*1024):f.write(data);sha.update(data);count+=len(data)
    assert count==artifact['size_in_bytes'] and artifact['digest']=='sha256:'+sha.hexdigest()
    f.seek(0)
    with zipfile.ZipFile(f) as z:
        assert set(z.namelist())==assets|diagnostics and z.testzip() is None
        # Keep this new UI build's executable, packages, ASR and official-SDK proof.
        for name in diagnostics-{'reference-transcription-validation.json','mcp-native-validation.json'}:(output/name).write_bytes(z.read(name))
completion=json.loads((output/'neural-completion-validation.json').read_text())
assert completion['validationHead']==BASE and completion['sourceUnchanged'] and completion['multilingualProofAuthenticated'] and completion['buildRun']==40542206709
vc=json.loads((output/'voice-conversion-validation.json').read_text())
assert vc['sourceMode']=='fixedCleanFrench' and vc['diagnosticSeed']==0 and vc['sourceWordOverlap']==7 and vc['outputWordOverlap']>=4
assert vc['sourceAndReferenceUnchanged'] and vc['multiWindow'] and vc['sourceFrames']==vc['outputFrames']
proof=json.loads((output/'multilingual-inference-validation.json').read_text())
assert {e['id'] for e in proof['engines']}=={'voxcpm2-bf16','chatterbox-multilingual-v3'} and all(e['standardTextWordOverlap']>=4 and e['customLanguage']=='fr' for e in proof['engines'])
assert proof['voiceLibraryGuides']['inputAudioUnchanged'] and len(proof['voiceLibraryGuides']['probes'])==3
fresh_hashes={}
for line in (output/'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
    sha,name=line.split('  ',1)
    with (output/name).open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==sha
    fresh_hashes[name]=sha
report=dict(head=head,coreHead=BASE,neuralRun=RUN,neuralArtifactId=artifact['id'],neuralArtifactDigest=artifact['digest'],immutableIdentities=identities,cloningModeOnly=True,freshUiPackageHashes=fresh_hashes,corePackageHashes=completion['buildHashes'],freshSuites=dict(typescript=174,chrome=176),inheritedSuites=dict(rust=165,python=96),neuralProofAuthenticated=True)
(output/'ui-final-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('VOICE_UI_FINAL_PROOF',json.dumps(report),flush=True)
