"""Authenticate the original packages and allow only the corrected test harness."""
from pathlib import Path
import hashlib,json,shutil,subprocess
ROOT=Path(__file__).resolve().parents[1]
spec=json.loads((ROOT/'scripts/review-actions-build.json').read_text(encoding='utf8'))
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
allowed={'scripts/test-review-actions-mcp.mjs','scripts/verify-review-actions-package.py','scripts/review-actions-build.json','.github/workflows/review-actions-validation.yml'}
changed=set(git('diff','--name-only',spec['compiledHead'],'HEAD').splitlines());assert changed<=allowed,changed-allowed
source=ROOT/'.cache/review-actions-build';out=ROOT/'artifacts';out.mkdir(exist_ok=True)
for name,digest in spec['packages'].items():
 assert Path(name).name==name
 with (source/name).open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==digest,name
 shutil.copy2(source/name,out/name)
for name in ['SHA256SUMS.txt','review-actions-identity.json','review-native-baseline.log']:shutil.copy2(source/name,out/name)
identity=json.loads((out/'review-actions-identity.json').read_text(encoding='utf8'));assert identity['head']==spec['compiledHead']
report=dict(**spec,head=git('rev-parse','HEAD'),applicationInputsIdentical=True,onlyValidationHarnessChanged=True,changed=sorted(changed))
(out/'review-actions-reuse.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print('Original signed packages authenticated; every application input is byte-identical.')
