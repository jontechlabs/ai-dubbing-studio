"""Actual official-weight offline VC, after multilingual/ASR validation.

No private audio. CPU proof of functionality, not a GPU performance claim.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import numpy as np
import soundfile as sf

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.cache/multilingual-validation'
spec=next(v for v in json.loads((ROOT/'workers/voice-engines.json').read_text())['variants'] if v['id']=='chatterbox-vc')
folder=WORK/'chatterbox-vc';folder.mkdir(exist_ok=True)
for f in spec['files']:
    path=folder/f['name']
    if not path.exists():
        with urllib.request.urlopen(f['url'],timeout=180) as response,path.open('wb') as out:
            while data:=response.read(1024*1024):out.write(data)
    with path.open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==f['sha256']
    assert path.stat().st_size==f['size']
ffmpeg=ROOT/'src-tauri/binaries/ffmpeg.exe'
source_audio,rate=sf.read(WORK/'chatterbox-multilingual-v3-0.wav',dtype='float32')
assert rate==24000
# Exercise a real neural window boundary, not only a single short utterance.
source=np.tile(np.concatenate([source_audio,np.zeros(2400,dtype=np.float32)]),3)
assert 8*rate<len(source)<30*rate
source_path=WORK/'vc-source.wav';reference=WORK/'vc-target.wav'
sf.write(source_path,source,rate,subtype='PCM_16')
subprocess.run([str(ffmpeg),'-v','error','-i',str(WORK/'Référence 日本語/ja.wav'),'-t','10','-ar','24000','-ac','1','-c:a','pcm_s16le','-y',str(reference)],check=True)
originals={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in [source_path,reference]}
output=WORK/'converted-fr.wav';metadata=WORK/'vc-result.json';request=WORK/'vc-request.json'
request.write_text(json.dumps(dict(variantId='chatterbox-vc',device='cpu',modelDir=str(folder),sourceAudio=str(source_path),referenceAudio=str(reference),outputPath=str(output),resultPath=str(metadata))),encoding='utf-8-sig')
started=time.monotonic()
run=subprocess.run([sys.executable,'-B',str(ROOT/'workers/voice_conversion_worker.py'),'--request',str(request)],capture_output=True,text=True,encoding='utf-8',timeout=1200,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
(WORK/'vc.log').write_text(run.stdout+'\n'+run.stderr,encoding='utf-8')
assert run.returncode==0,(run.stdout+run.stderr)[-4000:]
converted,converted_rate=sf.read(output,dtype='float32')
assert converted_rate==rate and len(converted)==len(source) and np.isfinite(converted).all() and np.max(np.abs(converted))>.001
assert not np.allclose(converted,source,atol=.0001)
assert all(hashlib.sha256(p.read_bytes()).hexdigest()==sha for p,sha in originals.items())
raw=WORK/'converted.f32';asr=WORK/'vc-asr.json'
subprocess.run([str(ffmpeg),'-v','error','-i',str(output),'-ar','16000','-ac','1','-f','f32le','-y',str(raw)],check=True)
speech=subprocess.run([str(ROOT/'src-tauri/target/release/ai-dubbing-studio.exe'),'--transcribe-reference',str(ROOT/'.cache/reference-transcription/Référence 日本語/ggml-small-q5_1.bin'),str(raw),'auto',str(asr)],capture_output=True,text=True,encoding='utf-8',timeout=600,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
assert speech.returncode==0,speech.stderr[-3000:]
transcript=json.loads(asr.read_text(encoding='utf-8-sig'))['text']
assert re.search(r'auto-detected language: fr\b',speech.stderr),speech.stderr[-1500:]
assert len(set(re.findall(r'\w+',transcript.lower()))&{'bonjour','je','suis','heureux','de','vous','revoir'})>=4,transcript
proof=dict(device='CPU',hardwareQualified=False,model=spec['id'],revision=spec['revision'],exactDuration=True,sourceFrames=len(source),outputFrames=len(converted),sourceAndReferenceUnchanged=True,multiWindow=True,frenchTranscript=transcript,seconds=round(time.monotonic()-started,2))
(ROOT/'artifacts/voice-conversion-validation.json').write_text(json.dumps(proof,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print('ACTUAL_VOICE_CONVERSION_PROOF',json.dumps(proof,ensure_ascii=False),flush=True)
