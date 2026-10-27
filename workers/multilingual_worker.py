"""VoxCPM2 and Chatterbox Multilingual; explicit local assets and selected device.

One process owns the model for a batch. Process exit releases its GPU allocations.
No web UI, training, remote inference, denoiser or torch.compile is started.
"""
import argparse
import contextlib
import gc
import hashlib
import json
import os
from pathlib import Path
import random
import sys

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
# The embedded Windows interpreter omits the script directory from sys.path.
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'vendor/chatterbox'))
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
IDS = ('voxcpm2-bf16', 'chatterbox-multilingual-v3')


def report(**values):
    print(json.dumps(values), file=sys.__stdout__, flush=True)


def validate(request):
    from cosyvoice_worker import validate_request
    if request.get('variantId') not in IDS:
        raise ValueError('INVALID_TTS_REQUEST')
    validate_request(request)
    if request['variantId'] == 'voxcpm2-bf16' and request['mode'] == 'zeroShot' and not request.get('referenceTranscript', '').strip():
        raise ValueError('TTS_TRANSCRIPT_REQUIRED')
    guide = request.get('intonationGuide')
    if guide is not None:
        if (not isinstance(guide, dict) or guide.get('mode') not in ('style', 'hybrid')
                or request['variantId'] != 'voxcpm2-bf16' or request['mode'] != 'crossLingual'
                or not isinstance(request.get('guideAudio'), str) or not request['guideAudio']):
            raise ValueError('TTS_GUIDE_UNSUPPORTED')
        if guide['mode'] == 'hybrid':
            if not isinstance(request.get('guideTranscript'), str) or not request['guideTranscript'].strip():
                raise ValueError('TTS_GUIDE_TRANSCRIPT_REQUIRED')
            if request.get('accent', 'auto') not in (None, 'auto') or request.get('mood', 'default') not in (None, 'default'):
                raise ValueError('TTS_GUIDE_UNSUPPORTED')
    if request['variantId'].startswith('chatterbox'):
        if request['mode'] != 'crossLingual':
            raise ValueError('INVALID_TTS_REQUEST')
        if (request.get('mood') or 'default') != 'default':
            raise ValueError('TTS_STYLE_UNSUPPORTED')
        if (request.get('accent') or 'auto') != 'auto':
            raise ValueError('TTS_ACCENT_UNSUPPORTED')


def voxcpm_arguments(request, reference, guide=None, guide_analysis=None):
    from voice_mood import mood_spec
    from voice_accent import accent_spec
    directions = []
    accent = accent_spec(request)
    if accent:
        directions.append(accent['fishInstruction'])
    if request.get('mood', 'default') not in (None, 'default'):
        directions.append(mood_spec(request)['fishInstruction'])
    text = request['text']
    if guide_analysis and (request.get('intonationGuide') or {}).get('mode') == 'style':
        directions.append(guide_analysis['direction'])
    if directions and request['mode'] != 'zeroShot':
        text = '(' + ', '.join(directions) + ')' + text
    from voice_quality import quality_options
    quality = quality_options(request)
    options = dict(text=text, cfg_value=quality["cfgStrength"], inference_timesteps=int(quality["inferenceSteps"]),
                   normalize=False, denoise=False, retry_badcase=True, retry_badcase_max_times=1,
                   max_len=1500)
    if (request.get('intonationGuide') or {}).get('mode') == 'hybrid':
        import re
        if guide is None: raise ValueError('TTS_GUIDE_UNSUPPORTED')
        # Separate audio inputs. No pitch-resynthesis or Japanese audio mixing.
        options.update(reference_wav_path=str(reference), prompt_wav_path=str(guide),
                       prompt_text=re.sub(r'<[^>]*>', '', request['guideTranscript']).strip())
    elif request['mode'] == 'zeroShot':
        options.update(reference_wav_path=str(reference), prompt_wav_path=str(reference), prompt_text=request['referenceTranscript'])
    else:
        options['reference_wav_path'] = str(reference)
    return options


def chatterbox_arguments(request, reference):
    # The language token is independent of the reference's language. Upstream
    # recommends CFG=0 for a cross-language reference to reduce language leakage.
    from voice_quality import quality_options
    quality = quality_options(request)
    return dict(text=request['text'], language_id=request['language'], audio_prompt_path=str(reference),
                cfg_weight=quality['cfgWeight'], exaggeration=quality['exaggeration'],
                temperature=quality['temperature'], top_p=quality['topP'], min_p=quality['minP'],
                repetition_penalty=quality['repetitionPenalty'])


def verify_models(request):
    manifest = json.loads((HERE / 'voice-engines.json').read_text(encoding='utf-8'))
    variant = next(v for v in manifest['variants'] if v['id'] == request['variantId'])
    for index, spec in enumerate(variant['files']):
        path = Path(request['modelDir']) / spec['name']
        if not path.is_file() or path.stat().st_size != spec['size']:
            raise ValueError('MODEL_CHECKSUM_FAILED')
        report(stage='ttsVerify', progress=index / len(variant['files']), log='Verifying ' + spec['name'])
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != spec['sha256']:
                raise ValueError('MODEL_CHECKSUM_FAILED')


def protect_pcm_peaks(audio):
    """Avoid hard PCM clipping with attenuation only, preserving relative samples."""
    import numpy as np
    samples = np.asarray(audio, dtype=np.float32)
    if samples.size == 0 or not np.isfinite(samples).all():
        raise ValueError('TTS_EMPTY_AUDIO')
    peak = float(np.max(np.abs(samples)))
    if peak < .001:
        raise ValueError('TTS_EMPTY_AUDIO')
    gain = .98 / peak if peak > 1 else 1.0
    return (samples * gain if gain < 1 else samples), peak, gain


def load_model(request, device):
    directory = Path(request['modelDir'])
    if request['variantId'] == 'voxcpm2-bf16':
        from voxcpm import VoxCPM
        return VoxCPM.from_pretrained(str(directory), load_denoiser=False,
                                      optimize=False, device=device, local_files_only=True)
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    return ChatterboxMultilingualTTS.from_local(directory, device=device, t3_model='v3')


def runtime_info():
    import importlib.metadata
    import inspect
    import torch
    from voxcpm import VoxCPM
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    if torch.__version__ != '2.8.0+cu128':
        raise ValueError('TTS_RUNTIME_FAILED')
    if importlib.metadata.version('voxcpm') != '2.0.3':
        raise ValueError('TTS_RUNTIME_FAILED')
    if 't3_model' not in inspect.signature(ChatterboxMultilingualTTS.from_local).parameters:
        raise ValueError('TTS_RUNTIME_FAILED')
    # A successful import on a developer machine can conceal missing Torch
    # dependencies. The app-owned environment must contain the entire profile.
    manifest = json.loads((HERE / 'multilingual-runtime.json').read_text(encoding='utf-8'))
    normalized = lambda name: name.lower().replace('_', '-').replace('.', '-')
    installed = {(normalized(item.metadata['Name']), item.version) for item in importlib.metadata.distributions()}
    for file in manifest['files']:
        distribution, version = file['name'].split('-')[:2]
        if (normalized(distribution), version) not in installed:
            raise ValueError(f'TTS_RUNTIME_FAILED: {distribution}=={version}')
    return dict(runtimeReady=True, cudaVersion=torch.version.cuda,
                voxcpm=VoxCPM.__name__, chatterbox=ChatterboxMultilingualTTS.__name__)


def generate(request, session=None):
    validate(request)
    requested = request.get('device', 'auto')
    if requested == 'cpu':
        os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
    from cosyvoice_worker import inference_device
    from voice_reference import prepare_reference
    import torch
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    from math import gcd
    torch.set_num_threads(min(6, max(1, (os.cpu_count() or 2) // 2)))
    device = inference_device(requested)
    name = torch.cuda.get_device_name(device) if device.startswith('cuda:') else 'CPU'
    if device.startswith('cuda:'):
        torch.cuda.set_device(device)
        torch.cuda.reset_peak_memory_stats(device)
    identity = (request['variantId'], str(request['modelDir']), device)
    if session and 'model' in session and session.get('identity') != identity:
        raise ValueError('INVALID_TTS_REQUEST')
    if session and 'model' in session:
        model = session['model']
        report(stage='ttsReuse', progress=None, log='Reusing ' + request['variantId'] + ' on ' + name)
    else:
        verify_models(request)
        report(stage='ttsLoad', progress=None, device=requested, deviceName=name)
        model = load_model(request, device)
        if session is not None:
            session.update(model=model, identity=identity)
    random.seed(request['seed'])
    np.random.seed(request['seed'])
    if device.startswith('cuda:'):
        torch.manual_seed(request['seed'])
        torch.cuda.manual_seed_all(request['seed'])
    else:
        torch.random.default_generator.manual_seed(request['seed'])
    guide_analysis = None
    with contextlib.ExitStack() as stack:
        reference = stack.enter_context(prepare_reference(request['referenceAudio'], report, request.get('preparedReferenceAudio')))
        guide = None
        if request.get('intonationGuide'):
            guide = stack.enter_context(prepare_reference(request['guideAudio'], report, request.get('preparedGuideAudio')))
            from intonation_guide import analyze
            guide_analysis = analyze(guide)
            guide_analysis['mode'] = request['intonationGuide']['mode']
            report(log='Intonation guide (acoustic cues, not an emotion classifier): ' + json.dumps(guide_analysis, sort_keys=True))
        from voice_quality import quality_options
        report(log='Generation controls: ' + json.dumps(quality_options(request), sort_keys=True))
        report(stage='ttsGenerate', progress=None,
               log=f'{request["variantId"]}: target language {request["language"]}; selected device {name}')
        with torch.inference_mode():
            if request['variantId'] == 'voxcpm2-bf16':
                audio = model.generate(**voxcpm_arguments(request, reference, guide, guide_analysis))
                rate = model.tts_model.sample_rate
            else:
                audio = model.generate(**chatterbox_arguments(request, reference)).float().cpu().numpy()
                rate = model.sr
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not np.isfinite(audio).all() or len(audio) == 0 or np.max(np.abs(audio)) < 0.001:
        raise ValueError('TTS_EMPTY_AUDIO')
    factor = gcd(int(rate), 24000)
    audio = resample_poly(audio, 24000 // factor, int(rate) // factor)
    if request['speed'] != 1:
        import librosa
        audio = librosa.effects.time_stretch(audio, rate=request['speed'])
    if not 0 < len(audio) <= 120 * 24000:
        raise ValueError('TTS_EMPTY_AUDIO')
    if request['variantId'] == 'voxcpm2-bf16':
        from math import log10
        audio, peak, gain = protect_pcm_peaks(audio)
        report(log=f'VoxCPM2 PCM protection: pre-PCM peak={peak:.6f}; gain={20 * log10(gain):+.2f} dB. Attenuation only when the generated waveform would clip; no denoising or voice change.')
    sf.write(request['outputPath'], np.clip(audio, -1, 1), 24000, subtype='PCM_16')
    metadata = dict(device=device, deviceName=name, peakVramMb=
                    round(torch.cuda.max_memory_allocated(device) / 1024**2) if device.startswith('cuda:') else 0)
    if guide_analysis is not None: metadata['guideAnalysis'] = guide_analysis
    Path(request['resultPath']).write_text(json.dumps(metadata), encoding='utf-8')
    if session is None:
        del model
        gc.collect()
        if device.startswith('cuda:'):
            torch.cuda.empty_cache()
    report(stage='ttsGenerate', progress=1, **metadata)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--info', action='store_true')
    parser.add_argument('--runtime-info', action='store_true')
    parser.add_argument('--request')
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        if args.info:
            from cosyvoice_worker import device_info
            report(**device_info())
        elif args.runtime_info:
            report(**runtime_info())
        else:
            generate(json.loads(Path(args.request).read_text(encoding='utf-8-sig')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        traceback.print_exc(file=sys.stderr)
        code = 'TTS_OUT_OF_MEMORY' if 'out of memory' in str(error).lower() else str(error).split(':')[0]
        report(error=code if code.startswith(('TTS_', 'INVALID_', 'DEVICE_', 'MODEL_')) else 'TTS_ENGINE_FAILED')
        sys.exit(1)
