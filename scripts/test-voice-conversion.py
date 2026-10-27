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
from isolated_worker_validation import prepare

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.cache/multilingual-validation'
embedded_python, packaged_workers = prepare(ROOT, WORK)
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
fixture=ROOT/'tests/fixtures/voice-conversion-source-fr.wav'
fixture_info=json.loads(fixture.with_suffix('.json').read_text(encoding='utf8'))
assert hashlib.sha256(fixture.read_bytes()).hexdigest()==fixture_info['sha256']
source_audio,rate=sf.read(fixture,dtype='float32')
assert rate==24000
# Exercise a real neural window boundary, not only a single short utterance.
period=np.concatenate([source_audio,np.zeros(2400,dtype=np.float32)])
source=np.tile(period,max(3,int(np.ceil(9*rate/len(period)))))
assert 8*rate<len(source)<30*rate
source_path=WORK/'vc-source.wav';reference=WORK/'vc-target.wav'
sf.write(source_path,source,rate,subtype='PCM_16')
subprocess.run([str(ffmpeg),'-v','error','-i',str(ROOT/'.cache/reference-transcription/Référence 日本語/ja.wav'),'-t','10','-ar','24000','-ac','1','-c:a','pcm_s16le','-y',str(reference)],check=True)
originals={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in [source_path,reference]}
output=WORK/'converted-fr.wav';metadata=WORK/'vc-result.json';request=WORK/'vc-request.json'
request.write_text(json.dumps(dict(variantId='chatterbox-vc',device='cpu',modelDir=str(folder),sourceAudio=str(source_path),referenceAudio=str(reference),outputPath=str(output),resultPath=str(metadata))),encoding='utf-8-sig')
started=time.monotonic()
# Seed only this diagnostic process. The packaged production worker is unchanged.
# Its flow sampler is stochastic; an unseeded cascaded/watermarked TTS fixture
# gave unstable phonemes and ASR. Use fixed clean French speech and preserve the
# same output-content gate, while also checking the source transcript below.
bootstrap="import sys,random,runpy,numpy,torch;random.seed(0);numpy.random.seed(0);torch.manual_seed(0);p=sys.argv.pop(1);sys.argv[0]=p;runpy.run_path(p,run_name='__main__')"
run=subprocess.run([str(embedded_python),'-I','-B','-c',bootstrap,str(packaged_workers/'voice_conversion_worker.py'),'--request',str(request)],capture_output=True,text=True,encoding='utf-8',timeout=1200,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
(WORK/'vc.log').write_text(run.stdout+'\n'+run.stderr,encoding='utf-8')
assert run.returncode==0,(run.stdout+run.stderr)[-4000:]
converted,converted_rate=sf.read(output,dtype='float32')
assert converted_rate==rate and len(converted)==len(source) and np.isfinite(converted).all() and np.max(np.abs(converted))>.001
assert not np.allclose(converted,source,atol=.0001)
assert all(hashlib.sha256(p.read_bytes()).hexdigest()==sha for p,sha in originals.items())
raw=WORK/'converted.f32';asr=WORK/'vc-asr.json'
# Verify that all seven expected words are present in the clean source, too.
source_raw=WORK/'vc-source.f32';source_asr=WORK/'vc-source-asr.json'
subprocess.run([str(ffmpeg),'-v','error','-i',str(source_path),'-ar','16000','-ac','1','-f','f32le','-y',str(source_raw)],check=True)
source_speech=subprocess.run([str(ROOT/'src-tauri/target/release/ai-dubbing-studio.exe'),'--transcribe-reference',str(ROOT/'.cache/reference-transcription/Référence 日本語/ggml-small-q5_1.bin'),str(source_raw),'auto',str(source_asr)],capture_output=True,text=True,encoding='utf-8',timeout=600,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
assert source_speech.returncode==0,source_speech.stderr[-2000:]
source_text=json.loads(source_asr.read_text(encoding='utf-8-sig'))['text']
assert re.search(r'auto-detected language: fr\b',source_speech.stderr)
assert len(set(re.findall(r'\w+',source_text.lower()))&{'bonjour','je','suis','heureux','de','vous','revoir'})==7,source_text
subprocess.run([str(ffmpeg),'-v','error','-i',str(output),'-ar','16000','-ac','1','-f','f32le','-y',str(raw)],check=True)
speech=subprocess.run([str(ROOT/'src-tauri/target/release/ai-dubbing-studio.exe'),'--transcribe-reference',str(ROOT/'.cache/reference-transcription/Référence 日本語/ggml-small-q5_1.bin'),str(raw),'auto',str(asr)],capture_output=True,text=True,encoding='utf-8',timeout=600,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
assert speech.returncode==0,speech.stderr[-3000:]
transcript=json.loads(asr.read_text(encoding='utf-8-sig'))['text']
assert re.search(r'auto-detected language: fr\b',speech.stderr),speech.stderr[-1500:]
assert len(set(re.findall(r'\w+',transcript.lower()))&{'bonjour','je','suis','heureux','de','vous','revoir'})>=4,transcript
proof=dict(device='CPU',hardwareQualified=False,embeddedPython=True,packagedWorkers=True,model=spec['id'],revision=spec['revision'],exactDuration=True,sourceMode='fixedCleanFrench',diagnosticSeed=0,sourceTakeSha256=fixture_info['sha256'],sourceFrenchTranscript=source_text,sourceWordOverlap=7,outputWordOverlap=len(set(re.findall(r'\w+',transcript.lower()))&{'bonjour','je','suis','heureux','de','vous','revoir'}),sourceFrames=len(source),outputFrames=len(converted),sourceAndReferenceUnchanged=True,multiWindow=True,frenchTranscript=transcript,seconds=round(time.monotonic()-started,2))
(ROOT/'artifacts/voice-conversion-validation.json').write_text(json.dumps(proof,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print('ACTUAL_VOICE_CONVERSION_PROOF',json.dumps(proof,ensure_ascii=False),flush=True)
