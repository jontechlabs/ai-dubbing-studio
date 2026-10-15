"""Local CosyVoice3 RL adapter. Official inference runs in an isolated process."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import random
import re
import sys
import threading

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'vendor' / 'cosyvoice3'))
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


def report(**values):
    print(json.dumps(values), flush=True)


def device_info():
    import torch
    from bandit_worker import device_info as inventory
    result = inventory()
    devices = []
    for entry in result['devices']:
        if entry['id'].startswith('cuda:'):
            try:
                with torch.cuda.device(entry['id']):
                    sample = torch.ones((16, 16), dtype=torch.float16, device=entry['id'])
                    sample @ sample
                    torch.cuda.synchronize()
                    free, total = torch.cuda.mem_get_info()
                    entry.update(totalMemoryMb=round(total/1024**2), freeMemoryMb=round(free/1024**2))
            except (RuntimeError, OSError) as error:
                result['unavailableDevices'].append(dict(entry, reason=str(error)))
                continue
        devices.append(entry)
    result['devices'] = devices
    return result


def runtime_info():
    import importlib.metadata
    import torch
    import torchaudio
    from cosyvoice.cli.cosyvoice import CosyVoice3
    from cosyvoice.flow.flow_matching import CausalConditionalCFM
    from matcha.utils.audio import mel_spectrogram
    import soundfile
    if torch.__version__.split('+')[0] != '2.8.0' or torchaudio.__version__.split('+')[0] != '2.8.0':
        raise ValueError('TTS_RUNTIME_FAILED')
    manifest = json.loads((HERE / 'cosyvoice-runtime.json').read_text(encoding='utf-8'))
    normalize = lambda name: re.sub(r'[-_.]+', '-', name).lower()
    installed = {(normalize(item.metadata['Name']), item.version) for item in importlib.metadata.distributions()}
    for file in manifest['common']:
        distribution, version = file['name'].split('-')[:2]
        if (normalize(distribution), version) not in installed:
            raise ValueError(f'TTS_RUNTIME_FAILED: {distribution}=={version}')
    return {'runtimeReady': True, 'torchVersion': '2.8.0', 'cudaVersion': torch.version.cuda}


def verify_model(directory):
    manifest = json.loads((HERE / 'cosyvoice-model.json').read_text(encoding='utf-8'))
    total = sum(file['size'] for file in manifest['files'])
    checked = 0
    for file in manifest['files']:
        path = directory / file['name']
        if not path.is_file() or path.stat().st_size != file['size']:
            raise ValueError('MODEL_CHECKSUM_FAILED')
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != file['sha256']:
            raise ValueError('MODEL_CHECKSUM_FAILED')
        checked += file['size']
        report(stage='ttsVerify', progress=checked / total)


def validate_request(request):
    if not isinstance(request.get('text'), str) or not request['text'].strip() or len(request['text']) > 1000:
        raise ValueError('TTS_TEXT_REQUIRED')
    if request.get('language') not in ['zh', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'it', 'ru']:
        raise ValueError('TTS_LANGUAGE_UNSUPPORTED')
    if not isinstance(request.get('speed'), (int, float)) or not 0.5 <= request['speed'] <= 2:
        raise ValueError('INVALID_TTS_REQUEST')
    if request.get('mode') not in ['zeroShot', 'crossLingual']:
        raise ValueError('INVALID_TTS_REQUEST')
    if request['mode'] == 'zeroShot' and not request.get('referenceTranscript', '').strip():
        raise ValueError('TTS_TRANSCRIPT_REQUIRED')
    device = request.get('device', 'auto')
    if device not in ['cpu', 'auto'] and not re.fullmatch(r'cuda:\d{1,2}', device):
        raise ValueError('DEVICE_UNAVAILABLE')
    return device


def generate(request):
    validate_request(request)
    from voice_reference import prepare_reference
    with prepare_reference(request['referenceAudio'], report, request.get('preparedReferenceAudio')) as reference:
        generate_normalized(dict(request, referenceAudio=str(reference)))


def generate_normalized(request):
    requested = validate_request(request)
    if requested == 'cpu':
        os.environ['CUDA_VISIBLE_DEVICES'] = ''
    elif requested.startswith('cuda:'):
        os.environ['CUDA_VISIBLE_DEVICES'] = requested.split(':')[1]
    import numpy as np
    import soundfile as sf
    import torch
    from bandit_worker import select_device
    from cosyvoice.cli.cosyvoice import CosyVoice3
    torch.set_num_threads(min(6, max(1, (os.cpu_count() or 2) // 2)))
    local = 'cuda:0' if requested.startswith('cuda:') else requested
    device = select_device(local, device_info()['devices'])
    if device == 'cpu' and torch.cuda.is_available():
        raise ValueError('DEVICE_UNAVAILABLE')
    name = torch.cuda.get_device_name(device) if device.startswith('cuda:') else 'CPU'
    if device.startswith('cuda:'):
        torch.cuda.set_device(device)
        torch.cuda.reset_peak_memory_stats()
    reference = Path(request['referenceAudio'])
    info = sf.info(reference)
    if info.channels != 1 or info.samplerate != 24000 or not 1 <= info.duration <= 20:
        raise ValueError('INVALID_REFERENCE_AUDIO')
    audio, _ = sf.read(reference, dtype='float32')
    if not np.isfinite(audio).all() or float(np.max(np.abs(audio))) < 0.001:
        raise ValueError('TTS_REFERENCE_SILENT')
    directory = Path(request['modelDir'])
    verify_model(directory)
    seed = int(request.get('seed', 0))
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if device.startswith('cuda:'):
        torch.cuda.manual_seed_all(seed)
    report(stage='ttsLoad', progress=None, device=requested, deviceName=name)
    import cosyvoice.cli.cosyvoice as official
    from cosyvoice_adapter import inference_yaml
    original_loader = official.load_hyperpyyaml
    official.load_hyperpyyaml = inference_yaml
    try:
        model = CosyVoice3(str(directory), fp16=device.startswith('cuda:'), load_trt=False, load_vllm=False)
    finally:
        official.load_hyperpyyaml = original_loader
    # The official Windows ONNX wheel runs reference tokenization on CPU.
    # Torch LLM, flow and vocoder use the selected CUDA device.
    report(stage='ttsGenerate', progress=None, device=requested, deviceName=name)
    prefix = 'You are a helpful assistant.<|endofprompt|>'
    options = {'stream': False, 'speed': request['speed'], 'text_frontend': False}
    with torch.inference_mode():
        if request['mode'] == 'zeroShot':
            generated = model.inference_zero_shot(request['text'], prefix + request['referenceTranscript'], str(reference), **options)
        else:
            generated = model.inference_cross_lingual(prefix + request['text'], str(reference), **options)
        chunks = [part['tts_speech'].float().cpu() for part in generated]
    if not chunks:
        raise ValueError('TTS_EMPTY_AUDIO')
    speech = torch.cat(chunks, dim=1).numpy().reshape(-1)
    if not np.isfinite(speech).all() or not 0 < speech.size / model.sample_rate <= 120:
        raise ValueError('TTS_EMPTY_AUDIO')
    output = Path(request['outputPath'])
    sf.write(output, speech, model.sample_rate, subtype='PCM_16', format='WAV')
    metadata = {'device': requested if requested != 'auto' else device, 'deviceName': name,
                'sampleRate': model.sample_rate, 'durationMs': round(speech.size * 1000 / model.sample_rate),
                'peakVramMb': round(torch.cuda.max_memory_allocated() / 1024**2) if device.startswith('cuda:') else 0}
    Path(request['resultPath']).write_text(json.dumps(metadata), encoding='utf-8')
    report(stage='done', progress=1, **metadata)


def main():
    global report
    parser = argparse.ArgumentParser()
    parser.add_argument('--info', action='store_true')
    parser.add_argument('--runtime-info', action='store_true')
    parser.add_argument('--request')
    args = parser.parse_args()
    def thread_error(arguments):
        import traceback
        traceback.print_exception(arguments.exc_type, arguments.exc_value, arguments.exc_traceback, file=sys.stderr)
        report(error='TTS_OUT_OF_MEMORY' if 'out of memory' in str(arguments.exc_value).lower() else 'TTS_ENGINE_FAILED')
        os._exit(1)
    threading.excepthook = thread_error
    # Keep stdout a JSON protocol even when imported upstream libraries print.
    if args.info or args.runtime_info:
        with contextlib.redirect_stdout(sys.stderr):
            if args.runtime_info:
                result = runtime_info()
            else:
                result = device_info()
        report(**result)
    else:
        # Preserve JSON progress while redirecting third-party prints.
        protocol = sys.stdout
        def output(**values):
            print(json.dumps(values), file=protocol, flush=True)
        report = output
        with contextlib.redirect_stdout(sys.stderr):
            generate(json.loads(Path(args.request).read_text(encoding='utf-8-sig')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        traceback.print_exc(file=sys.stderr)
        message = 'TTS_OUT_OF_MEMORY' if 'out of memory' in str(error).lower() else str(error)
        report(error=message)
        sys.exit(1)
