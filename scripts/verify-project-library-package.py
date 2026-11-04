"""Reuse only the authenticated v0.40 build; never compile or alter application bytes."""
from pathlib import Path
import hashlib,json,shutil,subprocess
ROOT=Path(__file__).resolve().parents[1]
spec=json.loads((ROOT/'scripts/project-library-build.json').read_text(encoding='utf8'))
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
allowed={'.github/workflows/project-library.yml','.github/workflows/project-library-frontend.yml','.github/workflows/project-library-validation.yml','tests/e2e/nativeMock.ts','tests/e2e/phase2.pw.ts','tests/e2e/phase3.pw.ts','tests/e2e/studio.pw.ts','scripts/test-project-library.mjs','scripts/verify-project-library-package.py','scripts/project-library-build.json'}
changed=set(git('diff','--name-only',spec['compiledHead'],'HEAD').splitlines())
assert changed<=allowed,changed-allowed
base=ROOT/'.cache/project-library-build'
source=base/'artifacts' if (base/'artifacts').is_dir() else base
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
for name,digest in spec['packages'].items():
 assert Path(name).name==name
 p=source/name
 with p.open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==digest,name
 shutil.copy2(p,out/name)
for name in ['SHA256SUMS.txt','project-library-identity.json']:shutil.copy2(source/name,out/name)
identity=json.loads((out/'project-library-identity.json').read_text(encoding='utf8'))
assert identity['head']==spec['compiledHead']
report=dict(**spec,head=git('rev-parse','HEAD'),applicationInputsIdentical=True,onlyValidationHarnessChanged=True,changed=sorted(changed))
(out/'project-library-reuse.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print('Exact build files authenticated; all application inputs identical to the fresh native/build commit.')
