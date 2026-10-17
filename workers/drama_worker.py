"""Headless Drama 3 FP8 inference. File-backed host experts; no neural CPU fallback."""
import argparse
import contextlib
import gc
import hashlib
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'vendor' / 'drama3'))
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
GIB = 1024 ** 3
CACHE_GIB = 4
MIN_TOTAL_RAM_GIB = 48
MIN_AVAILABLE_RAM_GIB = 24


def report(**values):
    print(json.dumps(values), file=sys.__stdout__, flush=True)


def memory_profile(total_ram, free_ram, free_vram):
    # The checkpoint is memory-mapped and its expert banks are not copied into
    # pinned RAM. Windows may reclaim file-backed pages under pressure. Reserve
    # ample working memory for the runtime, dense layers and transfer buffers;
    # do not require 46 GiB of unused physical RAM on a 64 GiB desktop.
    report(stage='ttsMemory', progress=None,
           log=f'Drama 3 memory: physical {total_ram/GIB:.2f} GiB; available {free_ram/GIB:.2f} GiB; '
           f'required {MIN_TOTAL_RAM_GIB} GiB physical / {MIN_AVAILABLE_RAM_GIB} GiB available; '
           f'VRAM available {free_vram/GIB:.2f} GiB / required 12 GiB; '
           f'memory-mapped unpinned experts, GPU cache capped at {CACHE_GIB} GiB.',
           totalRamBytes=total_ram, availableRamBytes=free_ram,
           requiredRamBytes=MIN_AVAILABLE_RAM_GIB * GIB, availableVramBytes=free_vram)
    if total_ram < MIN_TOTAL_RAM_GIB * GIB or free_ram < MIN_AVAILABLE_RAM_GIB * GIB:
        raise ValueError('TTS_DRAMA_RAM_REQUIRED')
    if free_vram < 12 * GIB:
        raise ValueError('TTS_DRAMA_VRAM_REQUIRED')
    return CACHE_GIB


def storage_preflight(directory, files):
    import shutil
    directory = Path(directory)
    remaining = sum(f['size'] for f in files if not (directory / f['name']).is_file()
                    or (directory / f['name']).stat().st_size != f['size'])
    available = shutil.disk_usage(directory).free
    required = remaining + 2 * GIB
    # Emit measured values before failing so the user can choose the right disk.
    report(log=f'Drama 3 storage: {directory}; available {available/GIB:.2f} GiB; '
           f'required {required/GIB:.2f} GiB ({remaining/GIB:.2f} GiB of weights remaining + 2 GiB margin).',
           storagePath=str(directory), availableBytes=available, requiredBytes=required)
    if available < required:
        raise ValueError('TTS_DRAMA_DISK_REQUIRED')


def configure_core(cpu=False):
    # Core is extracted next to this runtime, not a user's ComfyUI installation.
    core = Path(sys.executable).parent.parent / 'core'
    sys.path.insert(0, str(core))
    import comfy.cli_args
    args = comfy.cli_args.args
    args.cpu = cpu
    args.disable_dynamic_vram = True
    args.disable_comfy_compiler = True
    args.disable_cuda_graphs = True
    args.disable_xformers = True
    args.use_pytorch_cross_attention = True
    # HostBank.pinned() then retains contiguous safetensors mmap views instead
    # of allocating/copying all ~30 GiB of experts into non-pageable memory.
    # The selected GPU still performs every neural operation. OS paging may
    # make a busy host slower, but does not create a second resident model.
    args.disable_pinned_memory = True
    args.disable_mmap = False
    args.reserve_vram = 2.0
    import comfy.model_management
    from drama3.loader import load_drama3, load_codec
    from drama3.generate import generate
    return comfy.model_management, load_drama3, load_codec, generate


def runtime_info():
    import importlib.metadata
    import torch
    configure_core(cpu=True)
    from tokenizers import Tokenizer
    Tokenizer.from_file(str(HERE / 'vendor/drama3/drama3/fish/tokenizer.json'))
    for name, version in [('torch', '2.8.0+cu128'), ('comfy-kitchen', '0.2.37'), ('comfy-aimdo', '0.5.6')]:
        if importlib.metadata.version(name) != version:
            raise ValueError('TTS_RUNTIME_FAILED')
    return {'runtimeReady': True, 'cudaVersion': torch.version.cuda, 'expertCacheGiB': CACHE_GIB}


def verify_models(directory):
    manifest = json.loads((HERE / 'voice-engines.json').read_text(encoding='utf-8'))
    variant = next(v for v in manifest['variants'] if v['id'] == 'drama3-comfy-fp8')
    for index, spec in enumerate(variant['files']):
        file = directory / spec['name']
        if not file.is_file() or file.stat().st_size != spec['size']:
            raise ValueError('MODEL_CHECKSUM_FAILED')
        report(stage='ttsVerify', progress=index / len(variant['files']), log=f'Verifying {spec["name"]} (SHA-256)')
        with file.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != spec['sha256']:
                raise ValueError('MODEL_CHECKSUM_FAILED')


def validate(request):
    from cosyvoice_worker import validate_request
    validate_request(request)
    if request.get('mode') != 'zeroShot' or not request.get('referenceTranscript', '').strip():
        raise ValueError('TTS_TRANSCRIPT_REQUIRED')
    device = request.get('device', 'auto')
    if device != 'auto' and not (device.startswith('cuda:') and device[5:].isdigit()):
        raise ValueError('TTS_FP8_CUDA_REQUIRED')


def generate_audio(request):
    validate(request)
    requested = request.get('device', 'auto')
    # Remap before importing torch/Comfy: every operation uses the selected GPU.
    if requested.startswith('cuda:'):
        os.environ['CUDA_VISIBLE_DEVICES'] = requested[5:]
    import torch
    import psutil
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise ValueError('DEVICE_UNAVAILABLE')
    torch.cuda.set_device(0)
    torch.set_num_threads(6)
    ram = psutil.virtual_memory()
    cache = memory_profile(ram.total, ram.available, torch.cuda.mem_get_info(0)[0])
    directory = Path(request['modelDir'])
    verify_models(directory)
    from voice_reference import prepare_reference
    report(stage='ttsReference', progress=None, log=f'Drama 3: FP8 experts in memory-mapped host RAM (unpinned); {cache} GiB GPU cache; {torch.cuda.get_device_name(0)}; RAM available {ram.available/GIB:.1f} GiB')
    with prepare_reference(request['referenceAudio'], report, request.get('preparedReferenceAudio')) as reference:
        synthesize(request, directory, reference, cache)


def synthesize(request, directory, reference, cache):
    import torch
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    mm, load_model, load_codec, generate = configure_core()
    from drama3.codec import SAMPLE_RATE
    from drama3.prompt import build_prompt
    from drama3.chunking import split_text
    device = torch.device('cuda:0')
    torch.cuda.reset_peak_memory_stats(device)
    # Load, use and release the codec before loading the 35B model.
    report(stage='ttsReference', progress=None, log='Drama 3: encoding the reference; codec FP32 on selected GPU')
    codec = load_codec(str(directory / 'drama3_codec.safetensors'))
    audio, rate = sf.read(str(reference), dtype='float32')
    from math import gcd
    factor = gcd(rate, SAMPLE_RATE)
    audio = resample_poly(audio, SAMPLE_RATE // factor, rate // factor)
    with torch.inference_mode(), mm.cuda_device_context(device):
        mm.load_models_gpu([codec.patcher])
        codes = codec.model.encode(torch.from_numpy(audio).to(device)[None])[0].cpu()
    mm.unload_all_models()
    del codec
    gc.collect()
    mm.soft_empty_cache()
    import psutil
    ram = psutil.virtual_memory()
    memory_profile(ram.total, ram.available, torch.cuda.mem_get_info(device)[0])
    report(stage='ttsLoad', progress=None, log='Drama 3: mapping FP8 weights (about 38.6 GB) without a full pinned RAM copy; first load can take several minutes')
    model = load_model(str(directory / 'drama3_fp8experts_bf16.safetensors'), experts_in_ram=True, expert_cache_gb=cache)
    chunks = split_text(request['promptText']) or [request['promptText']]
    reference_pair = (request['referenceTranscript'], codes)
    first = latest = None
    frames = []
    max_frames = 600  # ~28 seconds per chunk; total audio capped below.
    with torch.inference_mode(), mm.cuda_device_context(device):
        mm.load_models_gpu(model.patchers())
        for index, text in enumerate(chunks):
            for history in ([h for h in (first, latest) if h is not None], [first] if first else [], []):
                prompt = build_prompt(model.tokenizer, model.config, text, [reference_pair], history)
                if len(prompt) <= 8192:
                    break
            else:
                raise ValueError('TTS_TEXT_REQUIRED')
            report(stage='ttsGenerate', progress=index / len(chunks), log=f'Drama 3: generating chunk {index+1}/{len(chunks)}; experts in RAM')
            def on_frame(step):
                if step % 10 == 0:
                    report(stage='ttsGenerate', progress=None, log=f'Drama 3: chunk {index+1}/{len(chunks)}, {step+1} audio frames')
            result = generate(model, prompt, max_frames, 1.0, 30, 0.9, request['seed'] + index, on_frame)
            if len(result) >= max_frames:
                raise ValueError('TTS_DRAMA_FRAME_LIMIT')
            frames.append(result[:, 1:].T.contiguous())
            turn = (text, result[:, 1:].T.contiguous())
            if first is None:
                first = turn
            else:
                latest = turn
            if sum(f.shape[-1] for f in frames) > 2500:
                raise ValueError('TTS_DRAMA_FRAME_LIMIT')
    mm.unload_all_models()
    del model, prompt, result
    gc.collect()
    mm.soft_empty_cache()
    output_codes = torch.cat(frames, dim=-1)
    if output_codes.shape[-1] == 0:
        raise ValueError('TTS_EMPTY_AUDIO')
    report(stage='ttsGenerate', progress=None, log='Drama 3: model released; decoding audio with codec FP32')
    codec = load_codec(str(directory / 'drama3_codec.safetensors'))
    with torch.inference_mode(), mm.cuda_device_context(device):
        mm.load_models_gpu([codec.patcher])
        audio = codec.model.decode(output_codes[None].to(device), torch.float32).float().cpu().numpy().reshape(-1)
    mm.unload_all_models()
    if not np.isfinite(audio).all() or not len(audio) or np.max(np.abs(audio)) < 0.001:
        raise ValueError('TTS_EMPTY_AUDIO')
    audio = resample_poly(audio, 80, 147)  # 44.1 kHz -> 24 kHz
    if request['speed'] != 1:
        import librosa
        audio = librosa.effects.time_stretch(audio, rate=request['speed'])
    if not 0 < len(audio) <= 120 * 24000 or not np.isfinite(audio).all():
        raise ValueError('TTS_EMPTY_AUDIO')
    sf.write(request['outputPath'], np.clip(audio, -1, 1), 24000, subtype='PCM_16')
    metadata = {'device': request.get('device', 'auto') if request.get('device') != 'auto' else 'cuda:0', 'deviceName': torch.cuda.get_device_name(0), 'peakVramMb': round(torch.cuda.max_memory_allocated(0)/1024**2), 'expertCacheGiB': cache, 'expertsInRam': True, 'expertMemoryMode': 'mapped'}
    Path(request['resultPath']).write_text(json.dumps(metadata), encoding='utf-8')
    report(stage='ttsGenerate', progress=1, log='Drama 3: WAV ready; GPU model released')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-info', action='store_true')
    parser.add_argument('--info', action='store_true')
    parser.add_argument('--request')
    parser.add_argument('--preflight')
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        if args.preflight:
            import psutil
            directory = Path(args.preflight)
            manifest = json.loads((HERE / 'voice-engines.json').read_text(encoding='utf-8'))
            files = next(v['files'] for v in manifest['variants'] if v['id'] == 'drama3-comfy-fp8')
            storage_preflight(directory, files)
            ram = psutil.virtual_memory()
            report(log=f'Drama 3 installation: physical RAM {ram.total/GIB:.2f} GiB / required {MIN_TOTAL_RAM_GIB} GiB')
            if ram.total < MIN_TOTAL_RAM_GIB * GIB:
                raise ValueError('TTS_DRAMA_RAM_REQUIRED')
            report(log='Drama 3 installation: storage and physical RAM checked')
        elif args.runtime_info:
            report(**runtime_info())
        elif args.info:
            from cosyvoice_worker import device_info
            report(**device_info())
        else:
            generate_audio(json.loads(Path(args.request).read_text(encoding='utf-8-sig')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        traceback.print_exc(file=sys.stderr)
        message = str(error)
        code = 'OUT_OF_MEMORY' if 'out of memory' in message.lower() else message.split(':')[0]
        report(error=code if code.startswith(('TTS_', 'INVALID_', 'DEVICE_', 'MODEL_', 'OUT_')) else 'TTS_ENGINE_FAILED')
        sys.exit(1)
