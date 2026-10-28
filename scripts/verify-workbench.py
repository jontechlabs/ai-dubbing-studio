"""Fresh workbench/toolbox checks, with explicit identity of existing TTS cores."""
from pathlib import Path
import json,subprocess,hashlib,tomllib
ROOT=Path(__file__).resolve().parents[1]
BASE='8da7af5'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True,encoding='utf-8').strip()
def digest(path):return hashlib.sha256((ROOT/path).read_bytes()).hexdigest()
identities={}
# Every worker/model/runtime/source that existed in v0.31 must remain identical.
# New toolbox assets are tested independently with real installed weights.
current=dict((path,sha) for sha,path in (row.split(' ',1) for row in git('ls-tree','-r','--format=%(objectname) %(path)','HEAD','workers').splitlines()))
for row in git('ls-tree','-r','--format=%(objectname) %(path)',BASE,'workers').splitlines():
 expected,path=row.split(' ',1);actual=current.get(path);assert actual==expected,path;identities[path]=actual
for path in ['pnpm-lock.yaml','public/demo.mp4']:
 assert git('rev-parse',f'HEAD:{path}')==git('rev-parse',f'{BASE}:{path}'),path
old=json.loads(git('show',f'{BASE}:package.json'));new=json.loads((ROOT/'package.json').read_text());old.pop('version');new.pop('version');assert old==new
for path in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']:
 a=tomllib.loads(git('show',f'{BASE}:{path}'));b=tomllib.loads((ROOT/path).read_text())
 if path.endswith('.toml'):a['package'].pop('version');b['package'].pop('version')
 else:
  for doc in [a,b]:next(p for p in doc['package'] if p['name']=='ai-dubbing-studio').pop('version')
 assert a==b,path
def tts_input(s):return next(line.strip() for line in s.splitlines() if 'let input_value = serde_json::json!' in line)
assert tts_input(git('show',f'{BASE}:src-tauri/src/tts.rs'))==tts_input((ROOT/'src-tauri/src/tts.rs').read_text())
old=git('show',f'{BASE}:src-tauri/src/voice_engines.rs');new=(ROOT/'src-tauri/src/voice_engines.rs').read_text();start='pub async fn generate_gguf';assert old[old.index(start):].strip()==new[new.index(start):].strip(),'Existing GGUF inference changed'
report=dict(head=git('rev-parse','HEAD'),baseline=git('rev-parse',BASE),existingWorkerIdentities=identities,existingTtsWorkerRequestUnchanged=True,existingGgufInferenceUnchanged=True,newToolboxIdentities={p:digest(p) for p in ['workers/audio_toolbox_worker.py','workers/audio-toolbox-models.json','workers/audio-toolbox-runtime.json','workers/vendor/audio-toolbox/audiosep-core.zip']},fullExistingTtsWeightTestsRerun=False,newSeparationFullWeights='Separate Windows smoke workflow; compare SHA-256 identities',gpuBenchmark=False)
(ROOT/'artifacts').mkdir(exist_ok=True);(ROOT/'artifacts/workbench-validation.json').write_text(json.dumps(report,indent=2)+'\n');print('WORKBENCH_IDENTITY',report['head'],len(identities),'unchanged existing worker files;',report['newToolboxIdentities'])
