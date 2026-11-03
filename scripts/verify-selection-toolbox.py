"""Bound selection/UI changes; no inference engine, worker, audio DSP or project format changes."""
from pathlib import Path
import copy,json,subprocess
ROOT=Path(__file__).resolve().parents[1]
BASE='10fe69c9dbc1ff3a596bd157498e9604421c0294'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf8').strip()
def source(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=ROOT).decode('utf8')
identities={}
for path in ['workers','public','pnpm-lock.yaml','src/services','src-tauri/binaries']:
 identities[path]=git('rev-parse','HEAD:'+path);assert identities[path]==git('rev-parse',BASE+':'+path),path
assert set(git('diff','--name-only',BASE,'HEAD','--','src-tauri/src').splitlines())=={'src-tauri/src/speaker_separation.rs','src-tauri/src/speaker_selection_tests.rs'}
for path in git('ls-tree','-r','--name-only','HEAD','--','src-tauri/src').splitlines():
 if path.endswith(('/speaker_separation.rs','/speaker_selection_tests.rs')):continue
 identities[path]=git('rev-parse','HEAD:'+path);assert identities[path]==git('rev-parse',BASE+':'+path),path
assert set(git('diff','--name-only',BASE,'HEAD','--','src/domain').splitlines())=={'src/domain/speakerDubbing.ts'}
s=source('HEAD','src/domain/speakerDubbing.ts').replace('  /** Omit for a free timeline selection; creating sub-dubs still requires a dialogue. */\n  lineId?: string;','  lineId: string;')
assert s==source(BASE,'src/domain/speakerDubbing.ts')
for path in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 assert source('HEAD',path).replace('name = "ai-dubbing-studio"\nversion = "0.39.0"','name = "ai-dubbing-studio"\nversion = "0.38.0"')==source(BASE,path)
for path in ['package.json','src-tauri/tauri.conf.json']:
 before=json.loads(source(BASE,path));after=json.loads(source('HEAD',path));assert after['version']=='0.39.0';after['version']=before['version'];assert after==before
before=json.loads(source(BASE,'src/mcp/catalog.json'));after=json.loads(source('HEAD','src/mcp/catalog.json'))
def restore_options(schema):
 schema['properties']['lineId']={'type':'string'};schema['required'].insert(0,'lineId')
command=next(c for c in after['commands'] if c['name']=='studio_separate_dialogue_speakers')
command['description']=next(c['description'] for c in before['commands'] if c['name']==command['name'])
restore_options(command['inputSchema']['$defs']['options_SpeakerSeparationOptions_0'])
restore_options(after['schemas']['SpeakerSeparationOptions']['$defs']['SpeakerSeparationOptions_0'])
assert after==before
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
(out/'selection-toolbox-identity.json').write_text(json.dumps(dict(head=git('rev-parse','HEAD'),baseHead=BASE,immutableIdentities=identities,inferenceWorkersAndDspUnchanged=True,optionalDialogueScopeOnly=True,existingMcpToolsAndProjectFormatRetained=True,toolCount=143,projectFormat=26),indent=2)+'\n',encoding='utf8')
print('Inference, workers, audio DSP and project format unchanged; optional bounded speaker-selection scope verified.')
