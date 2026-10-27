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
from isolated_worker_validation import prepare

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
assert set(worker.voxcpm_arguments(dict(variantId='voxcpm2-bf16', text='Bonjour.', mood='default', accent='auto', mode='crossLingual'), 'ref')).issubset(inspect.signature(VoxCPM._generate).parameters)


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
embedded_python, packaged_workers = prepare(ROOT, WORK)
proof.update(embeddedPython=True, packagedWorkers=True)
if validated_path:=os.environ.get('STUDIO_VALIDATED_VOX_PROOF'):
    validated=json.loads((ROOT/validated_path).read_text(encoding='utf8'))
    assert validated['baseHead']=='884f24423d0929749f554d3baf235322e708f2f8' and validated['authenticatedBaseRun']==40526247349
    assert validated['device']=='CPU' and validated['packagedWorkers'] and len(validated['engines'])==1
    assert validated['engines'][0]['id']=='voxcpm2-bf16' and validated['engines'][0]['standardTextWordOverlap']>=4
    assert {p['mode'] for p in validated['voiceLibraryGuides']['probes']}=={'french-fidelity','acoustic-guide','hybrid-guide'}
    assert all(p['language']=='fr' and p['textWordOverlap']>=4 for p in validated['voiceLibraryGuides']['probes'])
    proof.update(engines=validated['engines'],voiceLibraryGuides=validated['voiceLibraryGuides'],authenticatedVoxBaseRun=validated['authenticatedBaseRun'])
    print('Using authenticated Vox and guide proofs; production workers are byte-identical.',flush=True)
for id in worker.IDS:
    if id=='voxcpm2-bf16' and proof.get('authenticatedVoxBaseRun'):continue
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
        if index == 0:
            request['quality'] = {'inferenceSteps': 20, 'cfgStrength': 1.6} if id == 'voxcpm2-bf16' else {'temperature': .6, 'topP': .9}
        path = WORK / f'{id}-{index}.request.json'
        path.write_text(json.dumps(request), encoding='utf-8-sig')
        requests.append(request)
    protocol = '\n'.join(json.dumps(dict(requestId=str(i), path=str(WORK / f'{id}-{i}.request.json'))) for i in range(2)) + '\n'
    started = time.monotonic()
    result = subprocess.run([str(embedded_python), '-I', '-B', str(packaged_workers / 'batch_worker.py'), '--engine', 'multilingual_worker'], input=protocol,
                            text=True, encoding='utf-8', capture_output=True, timeout=1500,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), env=dict(os.environ, CUDA_VISIBLE_DEVICES='-1'))
    (WORK / f'{id}.stdout.log').write_text(result.stdout, encoding='utf-8')
    (WORK / f'{id}.stderr.log').write_text(result.stderr, encoding='utf-8')
    assert result.returncode == 0, result.stderr[-6000:] + result.stdout[-3000:]
    events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    assert [e for e in events if 'requestDone' in e] == [{'requestDone': '0'}, {'requestDone': '1'}], events[-5:]
    assert sum(e.get('stage') == 'ttsLoad' for e in events) == 1
    assert sum(e.get('stage') == 'ttsReuse' for e in events) == 1
    from voice_quality import quality_options
    controls = [json.loads(e['log'].removeprefix('Generation controls: ')) for e in events if e.get('log', '').startswith('Generation controls: ')]
    assert controls == [quality_options(request) for request in requests], controls
    for request in requests:
        audio, rate = sf.read(request['outputPath'])
        assert rate == 24000 and 0 < len(audio) <= 120 * rate and np.isfinite(audio).all() and np.max(np.abs(audio)) > .001
        metadata = json.loads(Path(request['resultPath']).read_text())
        assert metadata['device'] == 'cpu' and metadata['peakVramMb'] == 0
    # The batch adapter adds its own import path. A real single-take launch is
    # essential: it caught the production ModuleNotFoundError masked by batch.
    standalone = {key: value for key, value in requests[0].items() if key != 'quality'} | dict(outputPath=str(WORK / f'{id}-standalone.wav'),
                                   resultPath=str(WORK / f'{id}-standalone.json'))
    single_request = WORK / f'{id}-standalone.request.json'
    single_request.write_text(json.dumps(standalone), encoding='utf-8-sig')
    single = subprocess.run([str(embedded_python), '-I', '-B', str(packaged_workers / 'multilingual_worker.py'),
        '--request', str(single_request)], capture_output=True, text=True, encoding='utf-8', timeout=1200,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), env=dict(os.environ, CUDA_VISIBLE_DEVICES='-1'))
    (WORK / f'{id}-standalone.log').write_text(single.stdout+'\n'+single.stderr, encoding='utf-8')
    assert single.returncode == 0, single.stderr[-6000:] + single.stdout[-3000:]
    single_events = [json.loads(line) for line in single.stdout.splitlines() if line.startswith('{')]
    assert sum(e.get('stage') == 'ttsLoad' for e in single_events) == 1
    audio, rate = sf.read(standalone['outputPath'])
    assert rate == 24000 and 0 < len(audio) <= 120*rate and np.isfinite(audio).all() and np.max(np.abs(audio)) > .001
    assert json.loads(Path(standalone['resultPath']).read_text())['device'] == 'cpu'
    # Sampling changes can alter diction. Keep the established content gate on
    # Standard, and separately record language/content for the custom batch take.
    # A custom preset is not a speech-quality or text-fidelity certification.
    assert [json.loads(e['log'].removeprefix('Generation controls: ')) for e in single_events if e.get('log', '').startswith('Generation controls: ')] == [quality_options(standalone)]
    expected_words = {'bonjour', 'je', 'suis', 'heureux', 'de', 'vous', 'revoir'}
    def transcribe(path, label):
        raw = WORK / f'{id}-{label}.f32'
        subprocess.run([str(ffmpeg), '-v', 'error', '-i', str(path), '-ac', '1', '-ar', '16000', '-f', 'f32le', '-y', str(raw)], check=True)
        asr = WORK / f'{id}-{label}.asr.json'
        speech = subprocess.run([str(exe), '--transcribe-reference', str(whisper), str(raw), 'auto', str(asr)], capture_output=True, text=True, encoding='utf-8', timeout=600,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        (WORK / f'{id}-{label}.asr.log').write_text(speech.stderr, encoding='utf-8')
        assert speech.returncode == 0, speech.stderr[-3000:]
        transcript = json.loads(asr.read_text(encoding='utf-8-sig'))['text']
        assert re.search(r'auto-detected language: fr\b', speech.stderr), speech.stderr[-1000:]
        overlap = len(set(re.findall(r'\w+', transcript.lower())) & expected_words)
        return transcript, overlap
    transcript, standard_overlap = transcribe(standalone['outputPath'], 'standard')
    assert standard_overlap >= 4, transcript  # Same content requirement as before quality controls.
    custom_transcript, custom_overlap = transcribe(requests[0]['outputPath'], 'custom')
    if id=='voxcpm2-bf16':
        ja_transcript=json.loads((ROOT/'.cache/reference-transcription/Référence 日本語/ja.json').read_text(encoding='utf-8-sig'))['text']
        source_hash=hashlib.sha256(Path(standalone['outputPath']).read_bytes()).hexdigest()
        guide_hash=hashlib.sha256(reference.read_bytes()).hexdigest()
        probes=[]
        for label in ['french-fidelity','acoustic-guide','hybrid-guide']:
            probe=dict(standalone,referenceAudio=standalone['outputPath'],referenceTranscript=transcript,
                preparedReferenceAudio=str(WORK/f'{label}-reference.wav'),preparedGuideAudio=str(WORK/f'{label}-guide.wav'),
                outputPath=str(WORK/f'{label}.wav'),resultPath=str(WORK/f'{label}.json'),mood='default',accent='auto',
                intonationGuide=None,mode='zeroShot')
            if label!='french-fidelity':
                probe.update(mode='crossLingual',intonationGuide=dict(mode='style' if label=='acoustic-guide' else 'hybrid'),
                    guideAudio=str(reference),guideTranscript=ja_transcript)
                if label=='acoustic-guide':probe['accent']='fr-FR'
            request_path=WORK/f'{label}.request.json';request_path.write_text(json.dumps(probe),encoding='utf-8-sig');probes.append((label,probe,request_path))
        protocol=''.join(json.dumps(dict(requestId=label,path=str(request_path)))+'\n' for label,probe,request_path in probes)
        generated=subprocess.run([str(embedded_python),'-I','-B',str(packaged_workers/'batch_worker.py'),'--engine','multilingual_worker'],input=protocol,text=True,encoding='utf-8',capture_output=True,timeout=1800,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),env=dict(os.environ,CUDA_VISIBLE_DEVICES='-1'))
        (WORK/'voice-library-guides.stdout.log').write_text(generated.stdout,encoding='utf8');(WORK/'voice-library-guides.stderr.log').write_text(generated.stderr,encoding='utf8')
        assert generated.returncode==0,generated.stderr[-5000:]+generated.stdout[-3000:]
        events=[json.loads(line) for line in generated.stdout.splitlines() if line.startswith('{')]
        assert [e for e in events if 'requestDone' in e]==[dict(requestDone=label) for label,_,_ in probes],events[-8:]
        assert sum(e.get('stage')=='ttsLoad' for e in events)==1 and sum(e.get('stage')=='ttsReuse' for e in events)==2
        diagnostics=[]
        for label,probe,_ in probes:
            audio,rate=sf.read(probe['outputPath']);assert rate==24000 and 0<len(audio)<=120*rate and np.isfinite(audio).all() and np.max(np.abs(audio))>.001
            # Keep French language/content gates for fidelity and acoustic guidance.
            # Hybrid is explicitly experimental: any language leakage fails this smoke test too.
            spoken,overlap=transcribe(probe['outputPath'],label);assert overlap>=4,(label,spoken)
            metadata=json.loads(Path(probe['resultPath']).read_text());assert metadata['device']=='cpu'
            diagnostics.append(dict(mode=label,language='fr',textWordOverlap=overlap,transcript=spoken,durationMs=round(len(audio)/rate*1000),guideAnalysis=metadata.get('guideAnalysis')))
        assert hashlib.sha256(Path(standalone['outputPath']).read_bytes()).hexdigest()==source_hash and hashlib.sha256(reference.read_bytes()).hexdigest()==guide_hash
        proof['voiceLibraryGuides']=dict(voiceReferenceLanguage='fr',guideLanguage='ja',twoIndependentFiles=True,inputAudioUnchanged=True,modelLoads=1,reuses=2,probes=diagnostics)
        print('VOICE_LIBRARY_GUIDE_PROOF',json.dumps(proof['voiceLibraryGuides'],ensure_ascii=False),flush=True)
    proof['engines'].append(dict(id=id, revision=spec['revision'], seconds=round(time.monotonic()-started, 2),
                                qualityOverrides=requests[0]['quality'], hotQualityReset=True, standardQuality=True, standardTextWordOverlap=standard_overlap, customLanguage='fr', customFrenchTranscript=custom_transcript, customTextWordOverlap=custom_overlap, frenchTranscript=transcript, batchRequests=2, modelLoads=1, reuses=1, standaloneRequests=1))
    print('ACTUAL_MULTILINGUAL_PROOF', json.dumps(proof['engines'][-1], ensure_ascii=False), flush=True)
(ROOT / 'artifacts/multilingual-inference-validation.json').write_text(json.dumps(proof, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
