"""Bound the release to subtitle ASR and post-generation output gain.

Full-weight TTS/VC benchmarks from v0.30 are not rerun: verify unchanged
inference source and dependencies, then run fresh native/worker/media/UI tests.
This does not claim identical native application code or a new GPU benchmark.
"""
from pathlib import Path
import json,subprocess
ROOT=Path(__file__).resolve().parents[1]
BASE='268b4c72e28ae149c65d052d0d52c5911d1bbe14'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True).strip()
identities={}
for path in ['workers','resources','public','pnpm-lock.yaml','src-tauri/src/voice_engines.rs','src-tauri/src/tts_session.rs','src-tauri/src/voice_capture.rs','src-tauri/src/prosody.rs','src-tauri/src/qwen_safety.rs']:
    # No optional path or skipped assertion: every inference tree must exist.
    current=git('rev-parse',f'HEAD:{path}');assert current==git('rev-parse',f'{BASE}:{path}'),path;identities[path]=current
for path in ['package.json','src-tauri/tauri.conf.json']:
    old=json.loads(git('show',f'{BASE}:{path}'));new=json.loads((ROOT/path).read_text());old.pop('version');new.pop('version');assert old==new,path
old=git('show',f'{BASE}:src-tauri/src/tts.rs');new=(ROOT/'src-tauri/src/tts.rs').read_text()
def worker_input(s):return next(line.strip() for line in s.splitlines() if 'let input_value = serde_json::json!' in line)
assert worker_input(old)==worker_input(new),'Inference request must stay unchanged'
out=ROOT/'artifacts';out.mkdir(exist_ok=True)
report=dict(head=git('rev-parse','HEAD'),baseline=BASE,identicalInferenceSources=identities,workerRequestUnchanged=True,fullWeightInferenceRerun=False,freshChecks='TypeScript, Chrome, Rust/FFmpeg, Python, Japanese Whisper, packaged MCP SDK')
(out/'source-volume-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('SOURCE_VOLUME_IDENTITY',json.dumps(report))
