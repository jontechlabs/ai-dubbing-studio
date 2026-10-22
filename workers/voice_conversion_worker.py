"""Offline Chatterbox audio-to-audio conversion. No text generation or upload.

Bounded overlapping windows keep attention memory independent of take length.
Context is cropped after synthesis; overlap-add avoids hard chunk boundaries.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE / 'vendor/chatterbox'))
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
RATE = 24000
MAX_SAMPLES = 120 * RATE


def report(**values):
    print(json.dumps(values), file=sys.__stdout__, flush=True)


def validate(request):
    if request.get('variantId') != 'chatterbox-vc' or request.get('device') not in ('auto', 'cpu') and not __import__('re').fullmatch(r'cuda:\d{1,2}', str(request.get('device'))):
        raise ValueError('INVALID_VOICE_CONVERSION')
    if any(not isinstance(request.get(k), str) or not request[k] for k in ('modelDir', 'sourceAudio', 'referenceAudio', 'outputPath', 'resultPath')):
        raise ValueError('INVALID_VOICE_CONVERSION')
    paths = [Path(request[k]).resolve() for k in ('sourceAudio', 'referenceAudio', 'outputPath', 'resultPath')]
    if len(set(paths)) != len(paths):
        raise ValueError('INVALID_VOICE_CONVERSION')


def convert_windows(source, convert, progress=lambda _: None):
    import numpy as np
    if source.ndim != 1 or not 150 * 24 <= len(source) <= MAX_SAMPLES or not np.isfinite(source).all() or np.max(np.abs(source)) < .001:
        raise ValueError('VC_INVALID_AUDIO')
    window, overlap, context = RATE * 8, RATE // 4, RATE // 2
    out, weights = np.zeros(len(source), dtype=np.float32), np.zeros(len(source), dtype=np.float32)
    for start in range(0, len(source), window - overlap):
        end = min(start + window, len(source))
        left, right = max(0, start - context), min(len(source), end + context)
        rendered = np.asarray(convert(source[left:right]), dtype=np.float32).reshape(-1)
        # Token quantisation adds/removes a few milliseconds, never justify
        # cutting a word or padding an arbitrarily truncated model result.
        ratio = len(rendered) / (right - left)
        if not .9 <= ratio <= 1.1 or not np.isfinite(rendered).all() or np.max(np.abs(rendered), initial=0) < .001:
            raise ValueError('VC_DURATION_MISMATCH')
        if len(rendered) != right - left:
            import librosa
            rendered = librosa.effects.time_stretch(rendered, rate=ratio)
            rendered = librosa.util.fix_length(rendered, size=right-left)
        rendered = rendered[start-left:end-left]
        weight = np.ones(end-start, dtype=np.float32)
        if start:
            n = min(overlap, len(weight))
            weight[:n] = np.linspace(0, 1, n, endpoint=False)
        if end < len(source):
            weight[-overlap:] = np.linspace(1, 0, overlap, endpoint=False)
        out[start:end] += rendered * weight
        weights[start:end] += weight
        progress(end / len(source))
        if end == len(source):
            break
    if np.any(weights <= 0):
        raise ValueError('VC_DURATION_MISMATCH')
    return np.clip(out / weights, -1, 1)


def generate(request):
    validate(request)
    if request['device'] == 'cpu':
        os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
    import torch
    import soundfile as sf
    import tempfile
    import numpy as np
    from cosyvoice_worker import inference_device
    from multilingual_worker import verify_models
    from chatterbox.vc import ChatterboxVC
    torch.set_num_threads(min(6, max(1, (os.cpu_count() or 2) // 2)))
    device = inference_device(request['device'])
    if device.startswith('cuda:'):
        torch.cuda.set_device(device)
        torch.cuda.reset_peak_memory_stats(device)
    source, rate = sf.read(request['sourceAudio'], dtype='float32')
    reference, ref_rate = sf.read(request['referenceAudio'], dtype='float32')
    if rate != RATE or ref_rate != RATE or reference.ndim != 1 or not RATE <= len(reference) <= 20 * RATE or not np.isfinite(reference).all() or np.max(np.abs(reference), initial=0) < .001:
        raise ValueError('INVALID_REFERENCE_AUDIO')
    verify_models(request)
    report(stage='vcLoad', progress=None)
    model = ChatterboxVC.from_local(request['modelDir'], device=device)
    model.set_target_voice(request['referenceAudio'])
    with tempfile.TemporaryDirectory(prefix='studio-vc-') as folder:
        chunk = Path(folder) / 'source.wav'
        def convert(audio):
            sf.write(chunk, audio, RATE, subtype='PCM_16')
            return model.generate(str(chunk)).float().cpu().numpy()
        output = convert_windows(source, convert, lambda p: report(stage='vcConvert', progress=p))
    sf.write(request['outputPath'], output, RATE, subtype='PCM_16')
    metadata = dict(device=device, deviceName=torch.cuda.get_device_name(device) if device.startswith('cuda:') else 'CPU', peakVramMb=round(torch.cuda.max_memory_allocated(device) / 1024**2) if device.startswith('cuda:') else 0)
    Path(request['resultPath']).write_text(json.dumps(metadata), encoding='utf-8')
    report(stage='vcSave', progress=1, **metadata)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        generate(json.loads(Path(args.request).read_text(encoding='utf-8-sig')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        traceback.print_exc(file=sys.stderr)
        value = str(error)
        report(error='TTS_OUT_OF_MEMORY' if 'out of memory' in value.lower() else value if value.startswith(('VC_', 'INVALID_', 'DEVICE_', 'MODEL_')) else 'VC_FAILED')
        sys.exit(1)
