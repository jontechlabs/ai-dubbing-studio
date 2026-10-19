"""Local LatentSync 1.5/1.6, adapted from ShmuelRonen's Apache-2.0 wrapper.

The source movie is never opened for writing. Inputs and RGBA patches belong to
one dialogue's temporary directory. See vendor/latentsync/UPSTREAM.json.
"""
import argparse
import gc
import json
import math
import os
from pathlib import Path
import sys
import wave

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
from musetalk_worker import emit, plain_path

VENDOR = Path(__file__).resolve().parent / 'vendor' / 'latentsync'
sys.path.insert(0, str(VENDOR))


def settings(request):
    model = request.get('modelId')
    steps = request.get('inferenceSteps', 20)
    guidance = request.get('guidanceScale', 1.5)
    frames = request.get('frames')
    if model not in ['latentsync-15', 'latentsync-16']:
        raise ValueError('INPAINT_MODEL_INVALID')
    if isinstance(steps, bool) or not isinstance(steps, int) or not 10 <= steps <= 50:
        raise ValueError('INPAINT_SETTINGS_INVALID')
    if isinstance(guidance, bool) or not isinstance(guidance, (float, int)) or not math.isfinite(guidance) or not 1 <= guidance <= 3:
        raise ValueError('INPAINT_SETTINGS_INVALID')
    if isinstance(frames, bool) or not isinstance(frames, int) or not 5 <= frames <= 3000:
        raise ValueError('INPAINT_WINDOW_INVALID')
    return (256 if model == 'latentsync-15' else 512), steps, guidance


def select_device(torch, value, diagnostic=False):
    if diagnostic and value == 'cpu':
        return torch.device('cpu')
    if not isinstance(value, str) or not value.startswith('cuda:') or not value[5:].isdigit():
        raise ValueError('INPAINT_CUDA_REQUIRED')
    index = int(value[5:])
    if not torch.cuda.is_available() or index >= torch.cuda.device_count():
        raise ValueError('DEVICE_UNAVAILABLE')
    torch.cuda.set_device(index)
    properties = torch.cuda.get_device_properties(index)
    free, total = torch.cuda.mem_get_info(index)
    if properties.total_memory < 8 * 1024**3 or free < 6 * 1024**3:
        raise ValueError('INPAINT_GPU_MEMORY')
    # Leave room for the desktop, the video decoder and non-PyTorch allocations.
    budget = min(14 * 1024**3, .88 * total, .94 * free)
    torch.cuda.set_per_process_memory_fraction(budget / total, index)
    torch.zeros((8, 8), device=value).mm(torch.ones((8, 8), device=value))
    return torch.device(value)


def info():
    import torch
    import diffusers
    from diffusers import AutoencoderKL, DDIMScheduler  # noqa: F401
    from transformers import WhisperModel, WhisperFeatureExtractor  # noqa: F401
    from latentsync.models.unet import UNet3DConditionModel  # noqa: F401
    devices = []
    if torch.cuda.is_available():
        for i in range(torch.cuda.device_count()):
            p = torch.cuda.get_device_properties(i)
            devices.append(dict(id=f'cuda:{i}', name=p.name, memoryMb=p.total_memory // 1024**2))
    emit(runtimeReady=True, torchVersion=torch.__version__.split('+')[0], cudaVersion=torch.version.cuda,
         diffusersVersion=diffusers.__version__, devices=devices)


def read_audio(path, frames):
    import numpy as np
    with wave.open(str(path), 'rb') as file:
        if (file.getnchannels(), file.getsampwidth(), file.getframerate()) != (1, 2, 16000):
            raise ValueError('INPAINT_AUDIO_INVALID')
        if file.getnframes() != frames * 640:
            raise ValueError('INPAINT_AUDIO_INVALID')
        samples = np.frombuffer(file.readframes(file.getnframes()), dtype='<i2').astype('float32') / 32768
    if not np.isfinite(samples).all() or np.max(np.abs(samples)) < .001:
        raise ValueError('LIPS_VOICE_SILENT')
    return samples


def encoder_features(torch, encoder, mel):
    # The wrapper collects every hidden layer BEFORE the final LayerNorm.
    # HF's final hidden_states entry is normalized; replacing it is essential.
    last = []
    hook = encoder.layer_norm.register_forward_pre_hook(lambda _, args: last.append(args[0]))
    try:
        result = encoder(mel, output_hidden_states=True)
    finally:
        hook.remove()
    if len(last) != 1:
        raise ValueError('INPAINT_MODEL_INVALID')
    return torch.stack((*result.hidden_states[:-1], last[0]), dim=2)


def audio_embeddings(torch, features, indices):
    if features.ndim != 3 or features.shape[1:] != (5, 384):
        raise ValueError('INPAINT_MODEL_INVALID')
    # Wrapper Audio2Feature.get_sliced_feature: ten 50 Hz positions,
    # clamping to real edge features (not zero-padding or positional encoding).
    offsets = torch.arange(-4, 6)
    locations = (torch.tensor(indices)[:, None] * 2 + offsets).clamp(0, features.shape[0] - 1)
    return features[locations].reshape(len(indices), 50, 384)


def window_plan(count, size):
    if count < 1 or size not in [4, 8, 16]:
        raise ValueError('INPAINT_WINDOW_INVALID')
    overlap = min(4, size // 2)
    start = 0
    while True:
        end = min(count, start + size)
        yield start, end, overlap
        if end == count:
            break
        start += size - overlap


def sequential_guidance(unet, model_input, timestep, audio, scale):
    # Never double the video batch for classifier-free guidance.
    conditioned = unet(model_input, timestep, encoder_hidden_states=audio).sample
    if scale == 1:
        return conditioned
    import torch
    unconditioned = unet(model_input, timestep, encoder_hidden_states=torch.zeros_like(audio)).sample
    return unconditioned + scale * (conditioned - unconditioned)


def strict_load(torch, unet, checkpoint):
    weights = torch.load(str(checkpoint), map_location='cpu', weights_only=True, mmap=True)
    state = weights.get('state_dict', weights)
    # Bypass the upstream convenience loader which deletes mismatches and uses
    # strict=False: missing trained layers must never become random output.
    torch.nn.Module.load_state_dict(unet, state, strict=True, assign=True)
    del state, weights
    return unet


def denoise(torch, unet, scheduler, references, masked, mask, features, device, dtype,
            steps, guidance, seed, window, progress=emit):
    count, _, height, width = references.shape
    sums = torch.zeros((count, 4, height, width), dtype=torch.float32)
    weights = torch.zeros(count, dtype=torch.float32)
    generator = torch.Generator(device=device).manual_seed(seed)
    noise = torch.randn((1, 4, 1, height, width), generator=generator, device=device, dtype=dtype)
    plan = list(window_plan(count, window))
    for number, (start, end, overlap) in enumerate(plan):
        length = end - start
        indices = list(range(start, end))
        audio = audio_embeddings(torch, features, indices).to(device=device, dtype=dtype)
        ref = references[start:end].to(device=device, dtype=dtype).permute(1, 0, 2, 3)[None]
        cut = masked[start:end].to(device=device, dtype=dtype).permute(1, 0, 2, 3)[None]
        keep = mask.to(device=device, dtype=dtype)[None, :, None].expand(1, 1, length, height, width)
        scheduler.set_timesteps(steps, device=device)
        latents = noise.repeat(1, 1, length, 1, 1) * scheduler.init_noise_sigma
        for index, timestep in enumerate(scheduler.timesteps):
            scaled = scheduler.scale_model_input(latents, timestep)
            model_input = torch.cat((scaled, keep, cut, ref), dim=1)
            prediction = sequential_guidance(unet, model_input, timestep, audio, guidance)
            latents = scheduler.step(prediction, timestep, latents).prev_sample
            if not torch.isfinite(latents).all():
                raise ValueError('INPAINT_NONFINITE')
            progress(stage='inpaintGenerate', progress=.2 + .65 * (number + (index + 1) / steps) / len(plan))
        cpu = latents[0].permute(1, 0, 2, 3).float().cpu()
        ramp = torch.ones(length)
        if start:
            n = min(overlap, length)
            ramp[:n] = torch.arange(1, n + 1) / (n + 1)
        if end < count:
            n = min(overlap, length)
            ramp[-n:] = torch.arange(n, 0, -1) / (n + 1)
        sums[start:end] += cpu * ramp[:, None, None, None]
        weights[start:end] += ramp
        del ref, cut, keep, audio, scaled, model_input, prediction, latents, cpu
    if (weights <= 0).any():
        raise ValueError('INPAINT_FRAME_INVALID')
    return sums / weights[:, None, None, None]


def with_oom_retry(torch, run, initial):
    for window in [n for n in [16, 8, 4] if n <= initial]:
        try:
            return run(window)
        except torch.cuda.OutOfMemoryError:
            emit(log=f'CUDA memory pressure at {window} frames. Retrying a smaller temporal window on the SAME GPU.')
        gc.collect()
        torch.cuda.empty_cache()
    raise ValueError('INPAINT_GPU_MEMORY')


def generate(request, diagnostic=False):
    resolution, steps, guidance = settings(request)
    import numpy as np
    import torch
    from PIL import Image
    from diffusers import AutoencoderKL, DDIMScheduler
    from transformers import WhisperModel, WhisperFeatureExtractor
    from latentsync.models.unet import UNet3DConditionModel
    device = select_device(torch, request['device'], diagnostic)
    dtype = torch.float16 if device.type == 'cuda' else torch.float32
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    seed = request.get('seed', 0)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 4294967295:
        raise ValueError('INPAINT_SETTINGS_INVALID')
    count = request['frames']
    folder = Path(plain_path(request['modelDirectory']))
    common = folder / 'common'
    inputs, outputs = Path(plain_path(request['inputDirectory'])), Path(plain_path(request['outputDirectory']))
    samples = read_audio(plain_path(request['audioPath']), count)
    from musetalk_worker import mouth_alpha
    alpha = mouth_alpha(request['mask'], request['feather'], request['blend'], resolution)
    keep_pixels = np.asarray(Image.open(VENDOR / 'mask.png').convert('L').resize((resolution, resolution), Image.Resampling.LANCZOS), dtype='float32') / 255
    alpha = np.round(alpha * (1 - keep_pixels)).astype('uint8')
    outputs.mkdir(parents=True, exist_ok=True)
    emit(stage='inpaintModel', progress=None, log=f"{request['modelId']} / ShmuelRonen core; {device}; sequential CFG; staged VAE offload; no CPU fallback for video inference.")
    with torch.inference_mode():
        extractor = WhisperFeatureExtractor.from_pretrained(str(common / 'whisper'), local_files_only=True)
        encoder = WhisperModel.from_pretrained(str(common / 'whisper'), local_files_only=True, use_safetensors=True).encoder.eval()
        features = []
        for start in range(0, len(samples), 30 * 16000):
            part = samples[start:start + 30 * 16000]
            mel = extractor(part, sampling_rate=16000, return_tensors='pt').input_features
            features.append(encoder_features(torch, encoder, mel)[0, :math.ceil(len(part) / 320)].cpu())
        features = torch.cat(features)
        del encoder, mel
        # The VAE and UNet are NEVER resident on the GPU together.
        vae = AutoencoderKL.from_pretrained(str(common / 'vae'), local_files_only=True, use_safetensors=True).float().eval().to(device)
        vae.enable_slicing()
        vae.enable_tiling()
        scale = vae.config.scaling_factor
        shift = getattr(vae.config, 'shift_factor', 0) or 0
        generator = torch.Generator(device=device).manual_seed(seed)
        keep = torch.from_numpy(keep_pixels.copy())[None, None].to(device)
        references, masked = [], []
        for index in range(count):
            with Image.open(inputs / f'{index:06}.png') as image:
                if image.size != (resolution, resolution):
                    raise ValueError('INPAINT_FRAME_INVALID')
                pixels = torch.from_numpy(np.asarray(image.convert('RGB'), dtype='float32') / 127.5 - 1).permute(2, 0, 1)[None].to(device)
            references.append(((vae.encode(pixels).latent_dist.sample(generator=generator) - shift) * scale)[0].to(dtype=dtype).cpu())
            masked.append(((vae.encode(pixels * keep).latent_dist.sample(generator=generator) - shift) * scale)[0].to(dtype=dtype).cpu())
            emit(stage='inpaintPrepare', progress=.05 + .15 * (index + 1) / count)
        references, masked = torch.stack(references), torch.stack(masked)
        mask = torch.nn.functional.interpolate(keep, size=references.shape[-2:])[0].cpu()
        vae.to('cpu')
        del pixels, keep
        gc.collect()
        if device.type == 'cuda':
            torch.cuda.empty_cache()
        config = json.loads((VENDOR / ('config-15.json' if resolution == 256 else 'config-16.json')).read_text(encoding='utf-8'))
        unet = strict_load(torch, UNet3DConditionModel.from_config(config), folder / request['modelId'] / 'unet.pt').to(dtype=dtype).eval().to(device)
        scheduler = DDIMScheduler(beta_end=.012, beta_schedule='scaled_linear', beta_start=.00085,
                                  clip_sample=False, num_train_timesteps=1000, prediction_type='epsilon',
                                  set_alpha_to_one=False, steps_offset=1)
        run = lambda window: denoise(torch, unet, scheduler, references, masked, mask, features, device, dtype, steps, guidance, seed, window)
        latents = with_oom_retry(torch, run, 8 if resolution == 512 else 16)
        unet.to('cpu')
        del unet, references, masked, features, run
        gc.collect()
        if device.type == 'cuda':
            torch.cuda.empty_cache()
        vae.to(device)
        for index, latent in enumerate(latents):
            decoded = vae.decode(latent[None].to(device=device, dtype=torch.float32) / scale + shift).sample[0]
            if not torch.isfinite(decoded).all():
                raise ValueError('INPAINT_NONFINITE')
            # Conversion happens on CPU, never keeping a full clip in VRAM.
            pixels = ((decoded.float().cpu().permute(1, 2, 0) / 2 + .5).clamp(0, 1).numpy() * 255).round().astype('uint8')
            Image.fromarray(np.dstack((pixels, alpha))).save(outputs / f'{index:06}.png')
            emit(stage='inpaintGenerate', progress=.85 + .15 * (index + 1) / count)
        emit(log='LatentSync patches completed; source movie unchanged.', peakVramMb=torch.cuda.max_memory_allocated(device) // 1024**2 if device.type == 'cuda' else 0)
    emit(stage='inpaintCompose', progress=1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--info', action='store_true')
    parser.add_argument('--request')
    parser.add_argument('--diagnostic-cpu', action='store_true')
    args = parser.parse_args()
    try:
        if args.info:
            info()
        else:
            generate(json.loads(Path(plain_path(args.request)).read_text(encoding='utf-8-sig')), args.diagnostic_cpu)
    except Exception as error:
        emit(error='INPAINT_GPU_MEMORY' if 'out of memory' in str(error).lower() else str(error))
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
