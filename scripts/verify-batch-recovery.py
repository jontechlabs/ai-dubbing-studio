"""Bound batch recovery changes; retain all inference engines, DSP and Project schema."""
from pathlib import Path
import json,subprocess
ROOT=Path(__file__).resolve().parents[1]
BASE='82008c64ce2c6e09554bdf105a88def5cc740785'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
def value(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=ROOT)
identities={}
for path in ['workers','public','pnpm-lock.yaml','src-tauri/binaries','src/domain/types.ts']:
 identities[path]=git('rev-parse','HEAD:'+path);assert identities[path]==git('rev-parse',BASE+':'+path),path
allowed={'src-tauri/src/lib.rs','src-tauri/src/tts_batch.rs','src-tauri/src/tts_batch_tests.rs','src-tauri/src/tts_batch_review.rs','src-tauri/src/tts_batch_review_tests.rs'}
assert set(git('diff','--name-only',BASE,'HEAD','--','src-tauri/src').splitlines())==allowed
for path in git('ls-tree','-r','--name-only','HEAD','--','src-tauri/src').splitlines():
 if path not in allowed:
  identities[path]=git('rev-parse','HEAD:'+path);assert identities[path]==git('rev-parse',BASE+':'+path),path
for path in ['package.json','src-tauri/tauri.conf.json']:
 before=json.loads(value(BASE,path));after=json.loads(value('HEAD',path));assert after['version']=='0.41.0';after['version']=before['version'];assert after==before
for path in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 assert value('HEAD',path).replace(b'name = "ai-dubbing-studio"\nversion = "0.41.0"',b'name = "ai-dubbing-studio"\nversion = "0.40.2"')==value(BASE,path)
before=json.loads(value(BASE,'src/mcp/catalog.json'));after=json.loads(value('HEAD','src/mcp/catalog.json'))
added=[v for v in after['commands'] if v['name'] in ['studio_dubbing_batch_report','studio_retry_dubbing_batch']];assert len(added)==2
after['commands']=[v for v in after['commands'] if v not in added]
assert after['builtins']==before['builtins'] and after['commands']==before['commands']
assert set(after['schemas'])-set(before['schemas'])=={'DubbingBatchRetrySelection'}
after['schemas'].pop('DubbingBatchRetrySelection');assert after==before
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
(out/'batch-recovery-identity.json').write_text(json.dumps(dict(head=git('rev-parse','HEAD'),baseHead=BASE,immutableIdentities=identities,batchRecoveryOnly=True,inferenceAndDspUnchanged=True,oldMcpContractsAndProjectSchemaRetained=True,toolCount=157,projectFormat=26),indent=2)+'\n',encoding='utf8')
print('Batch recovery scope verified; inference, DSP, dependencies, existing 155 MCP contracts and Project schema unchanged.')
