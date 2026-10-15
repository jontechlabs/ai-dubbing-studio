"""Isolated Fish S2 FP8 inference; weights stay FP8, activations use BF16."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys
import threading

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'vendor/fish-s2'))
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')


def report(**values):
    print(json.dumps(values), flush=True)


def runtime_info():
    import importlib.metadata
    import re
    import torch
    import torchaudio
    from fish_speech.models.text2semantic.inference import launch_thread_safe_queue
    from fish_speech.models.text2semantic.llama import FP8Linear
    from fish_speech.models.dac.inference import load_model
    from fish_speech.inference_engine import TTSInferenceEngine
    if torch.__version__ != '2.8.0+cu128' or torchaudio.__version__ != '2.8.0+cu128':
        raise ValueError('TTS_RUNTIME_FAILED')
    normalize = lambda name: re.sub(r'[-_.]+', '-', name).lower()
    installed = {(normalize(d.metadata['Name']), d.version) for d in importlib.metadata.distributions()}
    manifest = json.loads((HERE/'fish-runtime.json').read_text(encoding='utf-8'))
    for file in manifest['files']:
        distribution, version = file['name'].split('-')[:2]
        if (normalize(distribution), version) not in installed:
            raise ValueError(f'TTS_RUNTIME_FAILED: {distribution}=={version}')
    return dict(runtimeReady=True, torchVersion=torch.__version__, cudaVersion=torch.version.cuda)


def generate(request):
    from cosyvoice_worker import validate_request
    requested = validate_request(request)
    if request['mode'] != 'zeroShot' or not request.get('referenceTranscript', '').strip():
        raise ValueError('TTS_TRANSCRIPT_REQUIRED')
    if requested == 'cpu' or requested.startswith('vulkan:'):
        raise ValueError('TTS_FP8_CUDA_REQUIRED')
    if requested.startswith('cuda:'):
        os.environ['CUDA_VISIBLE_DEVICES'] = requested.split(':')[1]
    import numpy as np
    import soundfile as sf
    import torch
    from cosyvoice_worker import device_info
    from bandit_worker import select_device
    device = select_device('cuda:0' if requested.startswith('cuda:') else requested, device_info()['devices'])
    if not device.startswith('cuda:') or not torch.cuda.is_bf16_supported():
        raise ValueError('TTS_FP8_CUDA_REQUIRED')
    torch.cuda.set_device(device)
    torch.cuda.reset_peak_memory_stats()
    if torch.cuda.mem_get_info()[0] < 12 * 1024**3:
        raise ValueError('TTS_FP8_MEMORY_REQUIRED')
    torch.set_num_threads(6)
    name = torch.cuda.get_device_name(device)
    from voice_reference import prepare_reference
    with prepare_reference(request['referenceAudio'], report, request.get('preparedReferenceAudio')) as reference:
        manifest = json.loads((HERE/'voice-engines.json').read_text(encoding='utf-8'))
        variant = next(v for v in manifest['variants'] if v['id'] == 'fish-s2-fp8')
        directory = Path(request['modelDir'])
        total = sum(f['size'] for f in variant['files']); checked = 0
        for file in variant['files']:
            path = directory/file['name']
            if not path.is_file() or path.stat().st_size != file['size']:
                raise ValueError('MODEL_CHECKSUM_FAILED')
            with path.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != file['sha256']: raise ValueError('MODEL_CHECKSUM_FAILED')
            checked += file['size']; report(stage='ttsVerify', progress=checked/total)
        synthesize(request, reference, directory, 'cuda', requested if requested != 'auto' else device, name)


def synthesize(request, reference, directory, execution_device, metadata_device, name, max_new_tokens=2048):
    import numpy as np
    import soundfile as sf
    import torch
    report(stage='ttsLoad', progress=None, deviceName=name)
    from fish_speech.models.text2semantic.inference import launch_thread_safe_queue
    from fish_speech.models.dac.inference import load_model
    from fish_speech.inference_engine import TTSInferenceEngine
    from fish_speech.utils.schema import ServeTTSRequest, ServeReferenceAudio
    queue, thread = launch_thread_safe_queue(str(directory), execution_device, torch.bfloat16, compile=False)
    decoder = load_model('modded_dac_vq', str(directory/'codec.pth'), device=execution_device)
    engine = TTSInferenceEngine(queue, decoder, torch.bfloat16, False)
    report(stage='ttsGenerate', progress=None, deviceName=name)
    options = ServeTTSRequest(text=request.get('promptText', request['text']), references=[ServeReferenceAudio(audio=reference.read_bytes(), text=request['referenceTranscript'])], seed=int(request.get('seed', 0)), streaming=False, max_new_tokens=max_new_tokens)
    final = None
    for result in engine.inference(options):
        if result.code == 'error': raise RuntimeError(f'TTS_ENGINE_FAILED: {result.error}')
        if result.code == 'final': final = result.audio
    if final is None: raise ValueError('TTS_EMPTY_AUDIO')
    rate, audio = final
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not np.isfinite(audio).all() or not 0 < len(audio)/rate <= 120:
        raise ValueError('TTS_EMPTY_AUDIO')
    import librosa
    if request['speed'] != 1: audio = librosa.effects.time_stretch(audio, rate=request['speed'])
    audio = librosa.resample(audio, orig_sr=rate, target_sr=24000)
    sf.write(request['outputPath'], audio, 24000, subtype='PCM_16', format='WAV')
    metadata = dict(device=metadata_device, deviceName=name, peakVramMb=round(torch.cuda.max_memory_allocated()/1024**2) if execution_device.startswith('cuda') else 0, sampleRate=24000, durationMs=round(len(audio)*1000/24000))
    Path(request['resultPath']).write_text(json.dumps(metadata), encoding='utf-8')
    report(progress=1, **metadata)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--info',action='store_true');parser.add_argument('--runtime-info',action='store_true');parser.add_argument('--request');args=parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        if args.info:
            from cosyvoice_worker import device_info
            result=device_info()
        elif args.runtime_info: result=runtime_info()
        else:
            result=None
            # Progress must remain NDJSON on stdout while third-party logs use stderr.
            global report
            stdout=sys.__stdout__
            report=lambda **v: print(json.dumps(v),file=stdout,flush=True)
            generate(json.loads(Path(args.request).read_text(encoding='utf-8-sig')))
    if result is not None: report(**result)


if __name__=='__main__':
    def thread_error(args):
        import traceback
        traceback.print_exception(args.exc_type,args.exc_value,args.exc_traceback)
        message=str(args.exc_value).lower()
        code='OUT_OF_MEMORY' if 'out of memory' in message else 'TTS_FP8_MEMORY_REQUIRED' if 'insufficient vram' in message else 'TTS_ENGINE_FAILED'
        report(error=code);os._exit(1)
    threading.excepthook=thread_error
    try: main()
    except Exception as error:
        import traceback
        traceback.print_exc()
        message=str(error)
        code='OUT_OF_MEMORY' if 'out of memory' in message.lower() else message.split(':')[0]
        report(error=code if code.startswith(('TTS_','INVALID_','DEVICE_','MODEL_','OUT_')) else 'TTS_ENGINE_FAILED')
        sys.exit(1)
