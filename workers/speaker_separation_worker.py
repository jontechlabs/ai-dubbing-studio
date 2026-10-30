"""Local two/three-speaker separation; no downloads or remote code at inference."""
from pathlib import Path
import argparse
import hashlib
import itertools
import json
import math
import os
import sys
import time
import traceback

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
HERE = Path(__file__).resolve().parent


def path(value):
    value = str(value)
    if value.startswith('\\\\?\\UNC\\'):
        value = '\\\\' + value[8:]
    elif value.startswith('\\\\?\\'):
        value = value[4:]
    return Path(value)


def emit(**data):
    print(json.dumps(data, ensure_ascii=False, allow_nan=False), flush=True)


def model_spec(model_id):
    data = json.loads((HERE / 'speaker-separation-models.json').read_text(encoding='utf-8-sig'))
    match = next((m for m in data['models'] if m['id'] == model_id), None)
    if not match:
        raise ValueError('SPEAKER_SEPARATION_OPTIONS')
    return match


def check_files(folder, spec):
    for item in spec['files']:
        name = Path(item['name'])
        if name.is_absolute() or '..' in name.parts:
            raise ValueError('SPEAKER_SEPARATION_OPTIONS')
        file = folder / name
        if not file.is_file() or file.stat().st_size != item['size']:
            raise ValueError('SPEAKER_SEPARATION_MODEL_REQUIRED')
        with file.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != item['sha256']:
                raise ValueError('MODEL_CHECKSUM_FAILED')


def device_name(value):
    if value != 'cpu' and (not isinstance(value, str) or not value.startswith('cuda:') or not value[5:].isdigit()):
        raise ValueError('DEVICE_UNAVAILABLE')
    import torch
    if value == 'cpu':
        return value, 'CPU'
    index = int(value[5:])
    if not torch.cuda.is_available() or index >= torch.cuda.device_count():
        raise ValueError('DEVICE_UNAVAILABLE')
    torch.cuda.set_device(index)
    torch.cuda.reset_peak_memory_stats(index)
    return value, torch.cuda.get_device_name(index)


def load_state(module, file, key=None):
    import torch
    data = torch.load(file, map_location='cpu', weights_only=True)
    if key and isinstance(data, dict) and key in data:
        data = data[key]
    if not isinstance(data, dict):
        raise ValueError('SPEAKER_SEPARATION_MODEL_INVALID')
    state = {k.removeprefix('module.'): v for k, v in data.items()}
    module.load_state_dict(state, strict=True)


def load_engine(folder, spec, device):
    import numpy as np
    import torch
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    check_files(folder, spec)
    if spec['family'] == 'mossformer2':
        from types import SimpleNamespace
        vendor = HERE / 'vendor' / 'speaker-separation' / 'mossformer2-source.zip'
        sys.path.insert(0, str(vendor))
        from mossformer2_ss.mossformer2 import MossFormer2_SS_16K
        config = SimpleNamespace(encoder_embedding_dim=512, mossformer_sequence_dim=512,
                                 num_mossformer_layer=24, encoder_kernel_size=16, num_spks=2)
        model = MossFormer2_SS_16K(config).model
        load_state(model, folder / 'last_best_checkpoint.pt', 'model')
        model.to(device).eval()

        def infer(samples):
            with torch.inference_mode():
                outputs = model(torch.from_numpy(samples).unsqueeze(0).to(device))
                return np.stack([s[0].float().cpu().numpy() for s in outputs])
    else:
        from hyperpyyaml import load_hyperpyyaml
        # Only our pinned, checksummed local configuration is evaluated. The
        # Pretrainer is not asked to fetch files; weights are loaded explicitly.
        config = load_hyperpyyaml((folder / 'hyperparams.yaml').read_text(encoding='utf-8'))
        modules = config['modules']
        for name in ['encoder', 'masknet', 'decoder']:
            load_state(modules[name], folder / (name + '.ckpt'))
            modules[name].to(device).eval()

        def infer(samples):
            with torch.inference_mode():
                encoded = modules['encoder'](torch.from_numpy(samples).unsqueeze(0).to(device))
                masks = modules['masknet'](encoded)
                separated = torch.stack([encoded] * spec['speakers']) * masks
                rows = [modules['decoder'](separated[i])[0].float().cpu().numpy()
                        for i in range(spec['speakers'])]
                return np.stack([np.pad(row[:len(samples)], (0, max(0, len(samples)-len(row)))) for row in rows])
    return infer


def align_channels(previous, current):
    """Preserve local stream ordering across overlapping inference windows."""
    import numpy as np
    if previous.shape != current.shape or previous.ndim != 2 or previous.shape[0] not in (2, 3):
        raise ValueError('SPEAKER_SEPARATION_OUTPUT_INVALID')
    norms = np.linalg.norm(previous, axis=1)[:, None] * np.linalg.norm(current, axis=1)[None, :]
    scores = np.divide(previous @ current.T, norms, out=np.zeros_like(norms), where=norms > 1e-10)
    order = max(itertools.permutations(range(len(previous))),
                key=lambda perm: sum(scores[i, j] for i, j in enumerate(perm)))
    return order


def separate_windows(samples, speakers, window, infer, progress=lambda *_: None):
    import numpy as np
    if samples.ndim != 1 or len(samples) == 0 or speakers not in (2, 3) or window < 16:
        raise ValueError('SPEAKER_SEPARATION_OPTIONS')
    hop = max(1, window // 2)
    starts = list(range(0, max(1, len(samples) - window + hop), hop))
    if not starts or starts[-1] + window < len(samples):
        starts.append((starts[-1] if starts else 0) + hop)
    result = np.zeros((speakers, len(samples)), dtype=np.float32)
    weights = np.zeros(len(samples), dtype=np.float32)
    overlap = window - hop
    fade = np.sin(np.linspace(0, math.pi/2, overlap, endpoint=False, dtype=np.float32)) ** 2
    for index, start in enumerate(starts):
        valid = min(window, len(samples) - start)
        if valid <= 0:
            continue
        chunk = np.pad(samples[start:start+valid], (0, window-valid)).astype(np.float32)
        values = np.asarray(infer(chunk), dtype=np.float32)
        if values.shape != (speakers, window) or not np.isfinite(values).all():
            raise ValueError('SPEAKER_SEPARATION_OUTPUT_INVALID')
        if index:
            count = min(overlap, valid)
            known = weights[start:start+count]
            previous = np.divide(result[:, start:start+count], known[None, :],
                                 out=np.zeros((speakers, count), dtype=np.float32), where=known[None, :] > 1e-8)
            values = values[list(align_channels(previous, values[:, :count]))]
        taper = np.ones(window, dtype=np.float32)
        if index:
            taper[:overlap] = fade
        if start + window < len(samples):
            taper[-overlap:] = 1 - fade
        result[:, start:start+valid] += values[:, :valid] * taper[:valid]
        weights[start:start+valid] += taper[:valid]
        progress(index + 1, len(starts))
    if (weights <= 0).any():
        raise ValueError('SPEAKER_SEPARATION_OUTPUT_INVALID')
    return result / weights[None, :]


def resample_exact(values, before, after, frames):
    import numpy as np
    from scipy.signal import resample_poly
    common = math.gcd(before, after)
    output = resample_poly(values, after // common, before // common, axis=-1)
    if output.shape[-1] < frames:
        output = np.pad(output, [(0, 0)] * (output.ndim - 1) + [(0, frames-output.shape[-1])])
    return output[..., :frames].astype(np.float32)


def generate(request):
    import numpy as np
    import soundfile as sf
    started = time.monotonic()
    spec = model_spec(request.get('modelId'))
    window_ms = request.get('windowMs', spec['windowMs'])
    if not isinstance(window_ms, int) or isinstance(window_ms, bool) or not 500 <= window_ms <= 8000:
        raise ValueError('SPEAKER_SEPARATION_OPTIONS')
    source = path(request['inputPath']).resolve()
    folder = path(request['outputDir']).resolve()
    model_dir = path(request['modelDir']).resolve()
    if folder == source.parent or source in [folder / f'voice-{i+1}.wav' for i in range(spec['speakers'])]:
        raise ValueError('SPEAKER_SEPARATION_OPTIONS')
    targets = [folder / f'voice-{i+1}.wav' for i in range(spec['speakers'])]
    if any(p.exists() for p in targets) or (folder / 'result.json').exists():
        raise ValueError('SPEAKER_SEPARATION_OUTPUT_EXISTS')
    samples, rate = sf.read(source, dtype='float32', always_2d=True)
    if rate != 48000 or samples.shape[1] not in (1, 2) or not 4800 <= len(samples) <= 60*48000:
        raise ValueError('SPEAKER_SEPARATION_OPTIONS')
    if not np.isfinite(samples).all():
        raise ValueError('SPEAKER_SEPARATION_OUTPUT_INVALID')
    samples = samples.mean(axis=1)
    if float(np.sqrt(np.mean(samples ** 2))) < 1e-6:
        raise ValueError('SPEAKER_SEPARATION_NO_AUDIO')
    device, name = device_name(request.get('device', 'cpu'))
    emit(stage='speakerSeparationLoad', progress=0.05, device=name, model=spec['id'])
    infer = load_engine(model_dir, spec, device)
    frames = len(samples)
    low = resample_exact(samples, rate, spec['sampleRate'], (frames*spec['sampleRate']+rate-1)//rate)
    outputs = separate_windows(low, spec['speakers'], spec['sampleRate']*window_ms//1000, infer,
                               lambda i, n: emit(stage='speakerSeparationRun', progress=0.15+0.75*i/n, window=i, windows=n))
    outputs = resample_exact(outputs, spec['sampleRate'], 48000, frames)
    peak = float(np.max(np.abs(outputs)))
    if not math.isfinite(peak) or peak < 1e-8:
        raise ValueError('SPEAKER_SEPARATION_OUTPUT_INVALID')
    gain = min(1.0, 0.98 / peak)
    outputs *= gain
    folder.mkdir(parents=True, exist_ok=True)
    rows = []
    for index, target in enumerate(targets):
        sf.write(target, outputs[index], 48000, subtype='PCM_16')
        rms = float(np.sqrt(np.mean(outputs[index] ** 2)))
        with target.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        rows.append(dict(id=f'voice-{index+1}', path=target.name, frames=frames, sampleRate=48000,
                         size=target.stat().st_size, sha256=digest,
                         rmsDb=max(-96.0, 20*math.log10(rms)) if rms > 0 else -96.0))
    import torch
    result = dict(modelId=spec['id'], speakers=spec['speakers'], sourceRate=spec['sampleRate'],
                  sampleRate=48000, frames=frames, commonGain=gain, device=device, deviceName=name,
                  peakVramMb=torch.cuda.max_memory_allocated()//1024**2 if device.startswith('cuda:') else 0,
                  elapsedMs=round((time.monotonic()-started)*1000), outputs=rows)
    temporary = folder / 'result.tmp'
    temporary.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    temporary.replace(folder / 'result.json')
    emit(stage='done', progress=1, result=result)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request')
    parser.add_argument('--info', action='store_true')
    parser.add_argument('--verify-model', nargs=2, metavar=('ID', 'FOLDER'))
    args = parser.parse_args()
    if args.info:
        import torch
        devices = [dict(id='cpu', name='CPU')]
        if torch.cuda.is_available():
            devices += [dict(id=f'cuda:{i}', name=torch.cuda.get_device_name(i)) for i in range(torch.cuda.device_count())]
        emit(devices=devices)
    elif args.verify_model:
        spec = model_spec(args.verify_model[0])
        load_engine(path(args.verify_model[1]), spec, 'cpu')
        emit(verified=True, modelId=spec['id'])
    elif args.request:
        generate(json.loads(path(args.request).read_text(encoding='utf-8-sig')))
    else:
        parser.error('One operation is required')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if str(error).startswith(('SPEAKER_SEPARATION_', 'DEVICE_', 'MODEL_')) else 'SPEAKER_SEPARATION_FAILED'
        if 'out of memory' in str(error).lower():
            code = 'SPEAKER_SEPARATION_OUT_OF_MEMORY'
        emit(error=code, detail=str(error))
        traceback.print_exc()
        sys.exit(1)
