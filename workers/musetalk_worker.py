"""MuseTalk 1.5 adapter: explicit face crops, one frame at a time, local files only.

The model's latent, positional and Whisper conditioning conventions follow
TMElyralab/MuseTalk 0a89dec45a0192b824e3cf4daf96c239440c5ed8 (MIT).
See MUSETALK-LICENSE.txt. No MMLab face detector is required by this adapter.
"""
import argparse
import json
import math
import os
from pathlib import Path
import sys
import wave

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


def emit(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def plain_path(value):
    value = str(value)
    if value.startswith('\\\\?\\UNC\\'):
        return '\\\\' + value[8:]
    if value.startswith('\\\\?\\'):
        return value[4:]
    return value


def select_device(torch, value, diagnostic=False):
    if diagnostic and value == 'cpu':
        return torch.device('cpu')
    if not isinstance(value, str) or not value.startswith('cuda:') or not value[5:].isdigit():
        raise ValueError('INPAINT_CUDA_REQUIRED')
    index = int(value[5:])
    if not torch.cuda.is_available() or index >= torch.cuda.device_count():
        raise ValueError('DEVICE_UNAVAILABLE')
    if torch.cuda.get_device_properties(index).total_memory < 6 * 1024**3:
        raise ValueError('INPAINT_GPU_MEMORY')
    torch.cuda.set_device(index)
    torch.cuda.set_per_process_memory_fraction(min(.9, 12 * 1024**3 / torch.cuda.get_device_properties(index).total_memory), index)
    torch.zeros((8, 8), device=value).mm(torch.ones((8, 8), device=value))
    return torch.device(value)


def info():
    import torch
    from diffusers import AutoencoderKL, UNet2DConditionModel  # noqa: F401
    from transformers import WhisperModel, WhisperFeatureExtractor  # noqa: F401
    from PIL import Image  # noqa: F401
    devices = []
    if torch.cuda.is_available():
        for index in range(torch.cuda.device_count()):
            p = torch.cuda.get_device_properties(index)
            devices.append(dict(id=f'cuda:{index}', name=p.name, memoryMb=p.total_memory // 1024**2))
    emit(runtimeReady=True, torchVersion=torch.__version__.split('+')[0], cudaVersion=torch.version.cuda, devices=devices)


def read_audio(path):
    import numpy as np
    with wave.open(str(path), 'rb') as file:
        if (file.getnchannels(), file.getsampwidth(), file.getframerate()) != (1, 2, 16000):
            raise ValueError('INPAINT_AUDIO_INVALID')
        data = np.frombuffer(file.readframes(file.getnframes()), dtype='<i2').astype('float32') / 32768
    if len(data) == 0 or len(data) > 20 * 16000 or not np.isfinite(data).all():
        raise ValueError('INPAINT_AUDIO_INVALID')
    if float(np.max(np.abs(data))) < .001:
        raise ValueError('LIPS_VOICE_SILENT')
    return data


def audio_chunks(torch, feature, count):
    # Encoder hidden layers: [1, time@50Hz, five layers, 384].
    if feature.ndim != 4 or feature.shape[2:] != (5, 384):
        raise ValueError('INPAINT_MODEL_INVALID')
    padding = torch.zeros_like(feature[:, :4])
    padded = torch.cat((padding, feature, torch.zeros_like(feature[:, :12])), dim=1)
    return [padded[:, i * 2:i * 2 + 10].reshape(1, 50, 384) for i in range(count)]


def positional(torch, input):
    length, width = input.shape[1:]
    position = torch.arange(length, device=input.device, dtype=torch.float32)[:, None]
    frequency = torch.exp(torch.arange(0, width, 2, device=input.device, dtype=torch.float32) * (-math.log(10000) / width))
    result = torch.empty((length, width), device=input.device, dtype=torch.float32)
    result[:, 0::2] = torch.sin(position * frequency)
    result[:, 1::2] = torch.cos(position * frequency)
    return input + result.to(input.dtype)[None]


def mouth_alpha(mask, feather, blend):
    import numpy as np
    values = [mask[k] for k in ['x', 'y', 'width', 'height']]
    if any(not math.isfinite(v) for v in values) or min(values[:2]) < 0 or min(values[2:]) < .01 or mask['x']+mask['width'] > 1.000001 or mask['y']+mask['height'] > 1.000001 or not .01 <= feather <= .45 or not .1 <= blend <= 1:
        raise ValueError('INPAINT_MASK_INVALID')
    y, x = np.mgrid[:256, :256].astype('float32') + .5
    x = (x/256-mask['x'])/mask['width']; y = (y/256-mask['y'])/mask['height']
    distance = np.minimum(np.minimum(x, 1-x), np.minimum(y, 1-y))
    ramp = np.clip(distance/feather, 0, 1)
    return ((.5-.5*np.cos(ramp*np.pi))*blend*255).round().astype('uint8')


def generate(request, diagnostic=False):
    import numpy as np
    import torch
    from PIL import Image
    from diffusers import AutoencoderKL, UNet2DConditionModel
    from transformers import WhisperModel, WhisperFeatureExtractor
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    device = select_device(torch, request['device'], diagnostic)
    dtype = torch.float16 if device.type == 'cuda' else torch.float32
    folder = Path(plain_path(request['modelDirectory']))
    inputs, outputs = Path(plain_path(request['inputDirectory'])), Path(plain_path(request['outputDirectory']))
    count = request['frames']
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 500:
        raise ValueError('INPAINT_WINDOW_INVALID')
    alpha = mouth_alpha(request['mask'], request['feather'], request['blend'])
    audio = read_audio(plain_path(request['audioPath']))
    if abs(len(audio) / 16000 - count / 25) > .002:
        raise ValueError('INPAINT_AUDIO_INVALID')
    outputs.mkdir(parents=True, exist_ok=True)
    seed = int(request.get('seed', 0))
    torch.manual_seed(seed)
    if device.type == 'cuda':
        torch.cuda.reset_peak_memory_stats(device)
    emit(stage='inpaintModel', progress=None, log=f'MuseTalk 1.5; {device}; {dtype}; batch 1; 256x256; no CPU fallback.')
    with torch.inference_mode():
        # Audio encoder is offloaded after producing the small conditioning array.
        extractor = WhisperFeatureExtractor.from_pretrained(str(folder/'whisper'), local_files_only=True)
        whisper = WhisperModel.from_pretrained(str(folder/'whisper'), local_files_only=True, use_safetensors=True).to(device=device, dtype=dtype).eval()
        mel = extractor(audio, sampling_rate=16000, return_tensors='pt').input_features.to(device=device, dtype=dtype)
        feature = torch.stack(whisper.encoder(mel, output_hidden_states=True).hidden_states, dim=2)
        feature = feature[:, :max(1, count*2)].cpu()
        chunks = audio_chunks(torch, feature, count)
        del whisper, mel, feature
        if device.type == 'cuda':
            torch.cuda.empty_cache()
        # Keep the small VAE in FP32 to avoid overflow on high-contrast drawings.
        vae = AutoencoderKL.from_pretrained(str(folder/'vae'), local_files_only=True, use_safetensors=True).to(device=device, dtype=torch.float32).eval()
        config = json.loads((folder/'unet/musetalk.json').read_text(encoding='utf-8-sig'))
        unet = UNet2DConditionModel.from_config(config)
        weights = torch.load(str(folder/'unet/unet.pth'), map_location='cpu', weights_only=True, mmap=True)
        unet.load_state_dict(weights, strict=True)
        del weights
        unet = unet.to(device=device, dtype=dtype).eval()
        unet.set_attention_slice('auto')
        timestep = torch.tensor([0], device=device)
        for index in range(count):
            with Image.open(inputs/f'{index:06}.png') as image:
                if image.size != (256, 256):
                    raise ValueError('INPAINT_FRAME_INVALID')
                array = np.asarray(image.convert('RGB'), dtype='float32') / 255
            original = torch.from_numpy(array.copy()).permute(2, 0, 1)[None].to(device=device, dtype=torch.float32)
            masked = original.clone()
            masked[:, :, 128:] = 0
            latent_masked = vae.encode(masked * 2 - 1).latent_dist.sample() * vae.config.scaling_factor
            latent_reference = vae.encode(original * 2 - 1).latent_dist.sample() * vae.config.scaling_factor
            latent = torch.cat((latent_masked, latent_reference), dim=1).to(dtype=dtype)
            encoded = positional(torch, chunks[index].to(device=device, dtype=dtype))
            prediction = unet(latent, timestep, encoder_hidden_states=encoded).sample
            result = vae.decode(prediction.float() / vae.config.scaling_factor).sample
            if not torch.isfinite(result).all():
                raise ValueError('INPAINT_NONFINITE')
            pixels = ((result[0].float().cpu().permute(1, 2, 0) / 2 + .5).clamp(0, 1).numpy() * 255).round().astype('uint8')
            Image.fromarray(np.dstack((pixels, alpha))).save(outputs/f'{index:06}.png')
            emit(stage='inpaintGenerate', progress=(index+1)/count)
            del original, masked, latent_masked, latent_reference, latent, prediction, result
        emit(log='Neural frames completed.', peakVramMb=torch.cuda.max_memory_allocated(device)//1024**2 if device.type=='cuda' else 0)
    emit(progress=1, stage='inpaintCompose')


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
        message = 'INPAINT_GPU_MEMORY' if 'out of memory' in str(error).lower() else str(error)
        emit(error=message)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
