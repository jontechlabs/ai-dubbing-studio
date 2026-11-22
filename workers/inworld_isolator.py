"""Local Inworld offline inference; pinned upstream, bounded windows, no downloads."""
from pathlib import Path
import gc
import sys

HERE = Path(__file__).resolve().parent


def engine(folder, device):
    import torch
    sys.path.insert(0, str(HERE / 'vendor/inworld-isolator'))
    from inworld.voice_isolation import VoiceIsolator
    from inworld.voice_isolation import scan
    # Same frame recurrence and values; smaller blocks of prepared factors
    # avoid multi-GiB temporary allocations in the plain PyTorch frequency scan.
    scan.BLOCK = 8
    torch.set_num_threads(max(1, min(8, __import__('os').cpu_count() or 1)))
    precision = 'bf16' if device.startswith('cuda:') and torch.cuda.is_bf16_supported() else 'fp32'
    checkpoint = Path(folder) / 'denoiser.safetensors'
    if not checkpoint.is_file():
        raise ValueError('MODEL_CHECKSUM_FAILED')
    model = VoiceIsolator(str(checkpoint), device=device, precision=precision, mode='offline')
    if model.sample_rate != 48000 or model.model.config.causal:
        raise ValueError('AUDIO_TOOLBOX_INVALID_AUDIO')
    return model


def bounded(isolator, mono, seconds, device, progress, release=None):
    """Keep official chunking, weights and device; release OOM tracebacks before retry."""
    attempts = 0
    while True:
        attempts += 1
        samples = round(seconds * 48000)
        overlap = samples // 4
        total = 1 if len(mono) <= samples else len(range(0, len(mono)-samples, samples-overlap)) + 1
        completed = 0
        def tick(*_):
            nonlocal completed
            completed += 1
            progress(completed / total)
        def attempt():
            handle = isolator.model.register_forward_hook(tick)
            try:
                return isolator.isolate(mono, 48000, chunk_seconds=seconds, overlap_seconds=seconds/4)
            except RuntimeError as error:
                if not device.startswith('cuda:') or 'out of memory' not in str(error).lower():
                    raise
                if seconds <= .5:
                    raise ValueError('AUDIO_TOOLBOX_GPU_OOM') from error
                return None
            finally:
                handle.remove()
        output = attempt()
        if output is not None:
            return output, seconds, attempts
        gc.collect()
        if release is None:
            import torch
            torch.cuda.empty_cache()
        else:
            release()
        seconds = max(.5, seconds/2)
        progress(None)


def separate(request, source, device, report):
    import numpy as np
    import torch
    if device.startswith('cuda:'):
        torch.cuda.reset_peak_memory_stats()
    isolator = engine(request['modelDir'], device)
    report(stage='toolboxSeparate', progress=0, log=f'Inworld offline · {isolator.precision} · plain PyTorch scan · same selected device {device}')
    mono = source.mean(axis=1).astype(np.float32)
    voice, seconds, attempts = bounded(isolator, mono, request['windowSeconds'], device,
        lambda p: report(stage='toolboxSeparate', progress=p))
    voice = np.asarray(voice, dtype=np.float32)
    if voice.shape != mono.shape or not np.isfinite(voice).all():
        raise ValueError('AUDIO_TOOLBOX_INVALID_AUDIO')
    vocals = np.repeat(voice[:, None], 2, axis=1)
    metadata = dict(precision=isolator.precision, windowMs=round(seconds*1000), attempts=attempts,
                    sampleRate=48000, peakVramMb=torch.cuda.max_memory_allocated()//1024**2 if device.startswith('cuda:') else 0)
    return {'vocals': vocals, 'instrumental': source-vocals}, metadata
