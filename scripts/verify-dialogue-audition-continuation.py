"""Allow only the browser test adaptation and its validation workflow after the signed build."""
from pathlib import Path
import json,subprocess
ROOT=Path(__file__).resolve().parents[1]
COMPILED='0d55aa05e18aa64e4e46f707d68eba0813df2b25'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
allowed={'tests/e2e/project-home-browser.pw.ts','.github/workflows/dialogue-track-audition-ui.yml','scripts/verify-dialogue-audition-continuation.py'}
assert set(git('diff','--name-only',COMPILED,'HEAD').splitlines())==allowed
identities={}
for path in ['src','src-tauri','workers','public','resources','package.json','pnpm-lock.yaml','playwright.config.ts','vite.config.ts','scripts/test-dialogue-track-audition-mcp.mjs','scripts/test-dialogue-track-audition.ps1']:
 identities[path]=git('rev-parse','HEAD:'+path);assert identities[path]==git('rev-parse',COMPILED+':'+path),path
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
(out/'dialogue-audition-continuation.json').write_text(json.dumps(dict(head=git('rev-parse','HEAD'),compiledHead=COMPILED,applicationInputsIdentical=True,immutableIdentities=identities,changedFiles=sorted(allowed)),indent=2)+'\n',encoding='utf8')
print('Browser test continuation: application, native, worker, dependency and packaged SDK inputs are identical to the signed v0.46.0 build.')
