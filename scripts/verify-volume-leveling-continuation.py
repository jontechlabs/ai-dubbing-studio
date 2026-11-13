"""Authenticate the unchanged signed package; only repair the SDK fixture role."""
from pathlib import Path
import hashlib,json,os,subprocess,urllib.request,urllib.error,zipfile
ROOT=Path(__file__).resolve().parents[1]
COMPILED='c11642abd656f7cb07fcda5905462d24bc5aa4cd'
RUN=43444291462
ARTIFACT=14049210607
DIGEST='24d60cc1a07f9cb7fa96953d27b83fe404a1f1b0407f14cdcb957c502609c998'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
allowed={'scripts/test-volume-leveling-mcp.mjs','scripts/verify-volume-leveling-continuation.py','.github/workflows/volume-leveling-sdk.yml'}
assert set(git('diff','--name-only',COMPILED,'HEAD').splitlines())==allowed
old=subprocess.check_output(['git','show',COMPILED+':scripts/test-volume-leveling-mcp.mjs'],cwd=ROOT)
expected=old.replace(b"kind: 'audio',\n            name:",b"kind: 'audio',\n            role: 'speech',\n            name:")
assert expected!=old
assert subprocess.check_output(['git','show','HEAD:scripts/test-volume-leveling-mcp.mjs'],cwd=ROOT)==expected
identities={}
for name in ['src','src-tauri','workers','public','resources','package.json','pnpm-lock.yaml','playwright.config.ts','vite.config.ts','scripts/test-volume-leveling.ps1','scripts/package-windows.ps1']:
    identities[name]=git('rev-parse','HEAD:'+name);assert identities[name]==git('rev-parse',COMPILED+':'+name),name
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
url=f'https://api.github.com/repos/jontechlabs/ai-dubbing-studio/actions/artifacts/{ARTIFACT}'
headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'User-Agent':'Studio-immutable-package-validation'}
with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=60) as response:meta=json.load(response)
assert meta['workflow_run']['id']==RUN and meta['workflow_run']['head_sha']==COMPILED and not meta['expired'] and meta['digest']=='sha256:'+DIGEST
folder=ROOT/'.cache/leveling-sdk';folder.mkdir(parents=True,exist_ok=True);archive=folder/'input.zip'
try:urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url+'/zip',headers=headers),timeout=60);raise RuntimeError('Artifact redirect expected')
except urllib.error.HTTPError as e:
    if e.code!=302:raise
    with urllib.request.urlopen(urllib.request.Request(e.headers['Location'],headers={'User-Agent':'Studio-immutable-package-validation'}),timeout=120) as response, archive.open('wb') as out:
        while block:=response.read(1024**2):out.write(block)
assert archive.stat().st_size==meta['size_in_bytes']
with archive.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==DIGEST
dest=folder/'input';dest.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for n in z.namelist():assert (dest/n).resolve().is_relative_to(dest.resolve())
    z.extractall(dest)
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
proof=dict(head=git('rev-parse','HEAD'),compiledHead=COMPILED,applicationInputsIdentical=True,onlyFixtureRoleAdded=True,immutableIdentities=identities,changedFiles=sorted(allowed),artifactId=ARTIFACT,archiveSha256=DIGEST)
(out/'volume-leveling-continuation.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf8')
print('Original signed archive SHA-256 verified. Product inputs are identical; only the SDK fixture receives its required speech role.')
