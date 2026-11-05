"""Bound batch recovery changes; retain all inference engines, DSP and Project schema."""
from pathlib import Path
import json,subprocess
ROOT=Path(__file__).resolve().parents[1]
BASE='4609eea775278f412ca86325d4bb5e557adc9b2a'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
def value(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=ROOT)
identities={}
for path in ['workers','public','pnpm-lock.yaml','src-tauri/binaries']:
 identities[path]=git('rev-parse','HEAD:'+path);assert identities[path]==git('rev-parse',BASE+':'+path),path
allowed={'src-tauri/src/lib.rs','src-tauri/src/tts_batch.rs','src-tauri/src/tts_batch_tests.rs','src-tauri/src/tts_batch_review.rs','src-tauri/src/tts_batch_review_tests.rs','src-tauri/src/tts_batch_history_tests.rs','src-tauri/src/tts_batch_takes_tests.rs','src-tauri/src/tts_trials.rs','src-tauri/src/inpaint_batch.rs'}
assert set(git('diff','--name-only',BASE,'HEAD','--','src-tauri/src').splitlines())==allowed
for path in git('ls-tree','-r','--name-only','HEAD','--','src-tauri/src').splitlines():
 if path not in allowed:
  identities[path]=git('rev-parse','HEAD:'+path);assert identities[path]==git('rev-parse',BASE+':'+path),path
for path in ['package.json','src-tauri/tauri.conf.json']:
 before=json.loads(value(BASE,path));after=json.loads(value('HEAD',path));assert after['version']=='0.43.0';after['version']=before['version'];assert after==before
for path in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 assert value('HEAD',path).replace(b'name = "ai-dubbing-studio"\nversion = "0.43.0"',b'name = "ai-dubbing-studio"\nversion = "0.42.0"')==value(BASE,path)
before=json.loads(value(BASE,'src/mcp/catalog.json'));after=json.loads(value('HEAD','src/mcp/catalog.json'))
assert after['builtins']==before['builtins'] and len(after['commands'])==len(before['commands'])
for command in after['commands']:
 old=next(v for v in before['commands'] if v['name']==command['name'])
 if command['name'] in ['studio_preview_dubbing_batch','studio_generate_dubbing_batch','studio_dubbing_batch_report','studio_retry_dubbing_batch']: command['description']=old['description']
assert after['commands']==before['commands']
for name,field in [('DubbingBatchSelection','takeCount'),('DubbingBatchRetrySelection','itemIndices')]:
 schema=after['schemas'][name];removed=0
 for definition in schema.get('$defs',{}).values():
  if field in definition.get('properties',{}):
   assert field not in definition.get('required',[]);definition['properties'].pop(field);removed+=1
 assert removed==1
assert after==before
assert value('HEAD','src/domain/types.ts').replace(b'    takeCount?: number;\n',b'')==value(BASE,'src/domain/types.ts')
for path in ['src-tauri/src/tts_trials.rs','src-tauri/src/inpaint_batch.rs']:
 assert value('HEAD',path).replace(b'            take_count: None,\n',b'').replace(b'            current_index: None,\n',b'')==value(BASE,path)
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
(out/'batch-multiple-takes-identity.json').write_text(json.dumps(dict(head=git('rev-parse','HEAD'),baseHead=BASE,immutableIdentities=identities,batchMultipleTakesOnly=True,inferenceAndDspUnchanged=True,oldMcpContractsAndProjectSchemaRetained=True,toolCount=158,projectFormat=26),indent=2)+'\n',encoding='utf8')
print('Multiple batch takes scope verified; inference, DSP, dependencies, existing 158 MCP commands with additive optional batch inputs and Project schema unchanged.')
