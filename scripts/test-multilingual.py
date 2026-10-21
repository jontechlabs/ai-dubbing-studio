"""Real pinned VoxCPM2 / Chatterbox V3 CPU inference, not a 5060 Ti benchmark.

Uses public Japanese speech, French target text and offline worker generation.
The production CUDA dependency profile is imported locally and on installation;
this runner uses the same Torch 2.8 API on CPU. No private project/audio is used.
"""
from pathlib import Path
import hashlib
import importlib.metadata
import inspect
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.cache/multilingual-validation'
sys.path.insert(0, str(ROOT / 'workers'))
import multilingual_worker as worker
import torch
from voxcpm import VoxCPM
from chatterbox.mtl_tts import ChatterboxMultilingualTTS
import soundfile as sf
import numpy as np

assert torch.__version__.split('+')[0] == '2.8.0'
assert sys.prefix != sys.base_prefix
for module in [torch, np, sf]:
    assert Path(module.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()), module.__file__
runtime = json.loads((ROOT / 'workers/multilingual-runtime.json').read_text(encoding='utf-8'))
for file in runtime['files']:
    name, version = file['name'].split('-')[:2]
    if name in ['torch', 'torchvision', 'torchaudio']:
        continue
    distribution = importlib.metadata.distribution(name)
    assert distribution.version == version, name
    assert Path(distribution.locate_file('')).resolve().is_relative_to(Path(sys.prefix).resolve()), name
assert 't3_model' in inspect.signature(ChatterboxMultilingualTTS.from_local).parameters
assert set(worker.voxcpm_arguments(dict(text='Bonjour.', mood='default', accent='auto', mode='crossLingual'), 'ref')).issubset(inspect.signature(VoxCPM._generate).parameters)


def fetch(url, destination, sha, size=None):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file():
        with destination.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() == sha:
                return
    print('Fetch verified public asset:', destination.name, flush=True)
    partial = destination.with_suffix(destination.suffix + '.part')
    with urllib.request.urlopen(url, timeout=180) as response, partial.open('wb') as stream:
        while data := response.read(1024 * 1024):
            stream.write(data)
    with partial.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == sha, destination
    if size is not None:
        assert partial.stat().st_size == size
    partial.replace(destination)


reference = WORK / 'Référence 日本語/ja.wav'
fetch('https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/ja.wav', reference,
      '460bd8dccb0d2a5f4e29c628f837be4082d13defc64c3fc21dd1b6bb0e119095')
manifest = json.loads((ROOT / 'workers/voice-engines.json').read_text(encoding='utf-8'))
proof = {'device': 'CPU', 'torch': torch.__version__, 'hardwareQualified': False, 'isolatedEnvironment': True, 'engines': []}
exe = ROOT / 'src-tauri/target/release/ai-dubbing-studio.exe'
ffmpeg = ROOT / 'src-tauri/binaries/ffmpeg.exe'
whisper = ROOT / '.cache/reference-transcription/Référence 日本語/ggml-small-q5_1.bin'
assert exe.is_file() and whisper.is_file(), 'Build and ASR validation must run first'
for id in worker.IDS:
    spec = next(v for v in manifest['variants'] if v['id'] == id)
    model = WORK / id
    for file in spec['files']:
        fetch(file['url'], model / file['name'], file['sha256'], file['size'])
    if id.startswith('chatterbox'):
        with zipfile.ZipFile(model / 'pkuseg.zip') as archive:
            assert set(archive.namelist()) == {'features.msgpack', 'weights.npz'}
            archive.extractall(model / 'pkuseg')
    requests = []
    texts = ['Bonjour, je suis heureux de vous revoir.', 'Merci, à bientôt.']
    for index, text in enumerate(texts):
        request = dict(text=text, promptText=text, language='fr', variantId=id, device='cpu',
                       referenceAudio=str(reference), referenceTranscript='', mode='crossLingual',
                       mood='default', accent='auto', speed=1, seed=0, modelDir=str(model),
                       outputPath=str(WORK / f'{id}-{index}.wav'), resultPath=str(WORK / f'{id}-{index}.json'))
        path = WORK / f'{id}-{index}.request.json'
        path.write_text(json.dumps(request), encoding='utf-8-sig')
        requests.append(request)
    protocol = '\n'.join(json.dumps(dict(requestId=str(i), path=str(WORK / f'{id}-{i}.request.json'))) for i in range(2)) + '\n'
    started = time.monotonic()
    result = subprocess.run([sys.executable, '-B', str(ROOT / 'workers/batch_worker.py'), '--engine', 'multilingual_worker'], input=protocol,
                            text=True, encoding='utf-8', capture_output=True, timeout=1500,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), env=dict(os.environ, CUDA_VISIBLE_DEVICES='-1'))
    (WORK / f'{id}.stdout.log').write_text(result.stdout, encoding='utf-8')
    (WORK / f'{id}.stderr.log').write_text(result.stderr, encoding='utf-8')
    assert result.returncode == 0, result.stderr[-6000:] + result.stdout[-3000:]
    events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    assert [e for e in events if 'requestDone' in e] == [{'requestDone': '0'}, {'requestDone': '1'}], events[-5:]
    assert sum(e.get('stage') == 'ttsLoad' for e in events) == 1
    assert sum(e.get('stage') == 'ttsReuse' for e in events) == 1
    for request in requests:
        audio, rate = sf.read(request['outputPath'])
        assert rate == 24000 and 0 < len(audio) <= 120 * rate and np.isfinite(audio).all() and np.max(np.abs(audio)) > .001
        metadata = json.loads(Path(request['resultPath']).read_text())
        assert metadata['device'] == 'cpu' and metadata['peakVramMb'] == 0
    raw = WORK / f'{id}.f32'
    subprocess.run([str(ffmpeg), '-v', 'error', '-i', requests[0]['outputPath'], '-ac', '1', '-ar', '16000', '-f', 'f32le', '-y', str(raw)], check=True)
    asr = WORK / f'{id}.asr.json'
    speech = subprocess.run([str(exe), '--transcribe-reference', str(whisper), str(raw), 'auto', str(asr)], capture_output=True, text=True, encoding='utf-8', timeout=600,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    (WORK / f'{id}.asr.log').write_text(speech.stderr, encoding='utf-8')
    assert speech.returncode == 0, speech.stderr[-3000:]
    transcript = json.loads(asr.read_text(encoding='utf-8-sig'))['text']
    assert re.search(r'auto-detected language: fr\b', speech.stderr), speech.stderr[-1000:]
    assert len(set(re.findall(r'\w+', transcript.lower())) & {'bonjour', 'je', 'suis', 'heureux', 'de', 'vous', 'revoir'}) >= 4, transcript
    proof['engines'].append(dict(id=id, revision=spec['revision'], seconds=round(time.monotonic()-started, 2),
                                frenchTranscript=transcript, batchRequests=2, modelLoads=1, reuses=1))
    print('ACTUAL_MULTILINGUAL_PROOF', json.dumps(proof['engines'][-1], ensure_ascii=False), flush=True)
(ROOT / 'artifacts/multilingual-inference-validation.json').write_text(json.dumps(proof, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
