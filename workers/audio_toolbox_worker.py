"""Bounded local source separation. Only verified installed models are loaded.

No model downloading, shell commands or prompt evaluation occurs in this process.
"""
import argparse
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
IDS = {'bs-roformer-viperx-1297', 'mel-band-roformer-kim', 'htdemucs', 'htdemucs-ft', 'audiosep'}


def report(**values):
    print(json.dumps(values), file=sys.__stdout__, flush=True)


def validate(r):
    if r.get('modelId') not in IDS or not isinstance(r.get('windowSeconds'), int) or not 2 <= r['windowSeconds'] <= 8:
        raise ValueError('AUDIO_TOOLBOX_OPTIONS')
    if r.get('device') not in ('auto', 'cpu') and not re.fullmatch(r'cuda:\d{1,2}', str(r.get('device'))):
        raise ValueError('DEVICE_UNAVAILABLE')
    if r['modelId'] == 'audiosep' and (not isinstance(r.get('prompt'), str) or not r['prompt'].strip() or len(r['prompt']) > 500 or '\0' in r['prompt']):
        raise ValueError('AUDIO_TOOLBOX_PROMPT')
    paths = [Path(r[k]).resolve() for k in ['modelDir', 'runtimeDir', 'inputPath', 'outputDir', 'resultPath']]
    if len(set(paths)) != len(paths):
        raise ValueError('AUDIO_TOOLBOX_OPTIONS')


def verified_model(r):
    manifest = json.loads((HERE / 'audio-toolbox-models.json').read_text(encoding='utf-8-sig'))
    spec = next(m for m in manifest['models'] if m['id'] == r['modelId'])
    root = Path(r['modelDir']).resolve()
    report(stage='toolboxVerify', progress=None)
    for f in spec['files']:
        path = (root / f['name']).resolve()
        if not path.is_relative_to(root) or path.stat().st_size != f['size']:
            raise ValueError('MODEL_CHECKSUM_FAILED')
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != f['sha256']:
                raise ValueError('MODEL_CHECKSUM_FAILED')
    return spec


def chunks(x, infer, rate, seconds, progress):
    """Linear overlap-add with common boundaries, including very short clips."""
    import numpy as np
    n = len(x)
    if x.ndim!=2 or n==0 or not np.isfinite(x).all():
        raise ValueError('AUDIO_TOOLBOX_INVALID_AUDIO')
    window = rate * seconds
    overlap = min(rate // 2, window // 4)
    stride = window - overlap
    starts = list(range(0, max(1, n - overlap), stride))
    total = weight = None
    for index, start in enumerate(starts):
        end = min(n, start + window)
        original = x[start:end]
        padded = np.pad(original, ((0, max(0, rate - len(original))), (0, 0)))
        y = np.asarray(infer(padded), dtype=np.float32)[:, :len(original)]
        if y.ndim != 3 or y.shape[1:] != original.shape or not np.isfinite(y).all():
            raise ValueError('AUDIO_TOOLBOX_INVALID_AUDIO')
        if total is None:
            total = np.zeros((len(y), n, x.shape[1]), dtype=np.float32)
            weight = np.zeros(n, dtype=np.float32)
        ramp = np.ones(len(original), dtype=np.float32)
        if start:
            k = min(overlap, len(ramp)); ramp[:k] = np.arange(1, k + 1) / (k + 1)
        if end < n:
            k = min(overlap, len(ramp)); ramp[-k:] = np.arange(k, 0, -1) / (k + 1)
        total[:, start:end] += y * ramp[None, :, None]
        weight[start:end] += ramp
        progress((index + 1) / len(starts))
    return total / np.maximum(weight[None, :, None], 1e-12)


def clean_path(path):
    value = str(path)
    if os.name == 'nt' and value.startswith('\\\\?\\') and len(value) < 240:
        return '\\\\' + value[8:] if value.startswith('\\\\?\\UNC\\') else value[4:]
    return value


def audiosep(r, source, device):
    import numpy as np
    import torch
    import yaml
    from scipy.signal import resample_poly
    model_dir = Path(clean_path(r['modelDir']))
    os.environ['DUBBING_ROBERTA_DIR'] = str(model_dir / 'roberta')
    core = Path(r['runtimeDir']) / 'audiosep'
    sys.path.insert(0, str(core))
    from models.clap_encoder import CLAP_Encoder
    from models.audiosep import AudioSep, get_model_class
    config = yaml.safe_load((core / 'config/audiosep_base.yaml').read_text())['model']
    query = CLAP_Encoder(pretrained_path=str(model_dir / 'clap.pt')).eval()
    ss = get_model_class(config['model_type'])(input_channels=1, output_channels=1, condition_size=512)
    model = AudioSep.load_from_checkpoint(str(model_dir / 'audiosep.ckpt'), strict=False, ss_model=ss, query_encoder=query, waveform_mixer=None, loss_function=None, optimizer_type=None, learning_rate=None, lr_lambda_func=None, map_location='cpu', weights_only=False).eval().to(device)
    mono = resample_poly(source.mean(axis=1), 2, 3).astype(np.float32)[:, None]
    with torch.inference_mode():
        condition = model.query_encoder.get_query_embed(modality='text', text=[r['prompt'].strip()], device=device)
        def infer(x):
            result = model.ss_model({'mixture': torch.from_numpy(x.T[None]).to(device), 'condition': condition})['waveform']
            return result.float().cpu().numpy().reshape(1, -1, 1)
        separated = chunks(mono, infer, 32000, r['windowSeconds'], lambda p: report(stage='toolboxSeparate', progress=p))[0, :, 0]
    isolated = resample_poly(separated, 3, 2)[:len(source)]
    isolated = np.pad(isolated, (0, len(source) - len(isolated)))[:, None].repeat(2, axis=1)
    return {'isolated': isolated, 'residual': source - isolated}


def separator(r, spec, source, device):
    import numpy as np
    import soundfile as sf
    import torch
    import yaml
    from audio_separator.separator import Separator
    from scipy.signal import resample_poly
    model_dir = Path(clean_path(r['modelDir']))
    raw = Path(r['outputDir']) / 'raw'; raw.mkdir()
    class LocalSeparator(Separator):
        def setup_torch_device(self, _info):
            self.torch_device = torch.device(device)
            self.torch_device_cpu = torch.device('cpu')
            self.torch_device_mps = None
            self.onnx_execution_provider = ['CPUExecutionProvider']
        def download_model_files(self, _filename):
            filename = 'model.ckpt' if spec['family'] == 'roformer' else ('htdemucs_ft.yaml' if r['modelId'] == 'htdemucs-ft' else 'htdemucs.yaml')
            return filename, 'MDXC' if spec['family'] == 'roformer' else 'Demucs', spec['name'], str(model_dir / filename), 'model.yaml' if spec['family'] == 'roformer' else str(model_dir / filename)
        def load_model_data_from_yaml(self, path):
            if spec['family'] == 'demucs':
                return {'primary_stem': 'Vocals'}
            value = yaml.load((model_dir / path).read_text(), Loader=yaml.FullLoader)
            value['is_roformer'] = True
            value['audio']['chunk_size'] = min(value['audio']['chunk_size'], r['windowSeconds'] * 44100)
            return value
        def download_file_if_not_exists(self, *_args, **_kwargs):
            raise ValueError('MODEL_CHECKSUM_FAILED')
    engine = LocalSeparator(model_file_dir=str(model_dir), output_dir=str(raw), output_format='WAV', sample_rate=44100, use_soundfile=True, normalization_threshold=1.0, amplification_threshold=0.0, use_autocast=device.startswith('cuda:'), log_level=logging.WARNING, demucs_params={'segment_size':str(min(7, r['windowSeconds'])), 'shifts':1, 'overlap':.25, 'segments_enabled':True}, mdxc_params={'segment_size':256,'override_model_segment_size':False,'batch_size':1,'overlap':2})
    engine.load_model('model.ckpt' if spec['family'] == 'roformer' else ('htdemucs_ft.yaml' if r['modelId'] == 'htdemucs-ft' else 'htdemucs.yaml'))
    # Export floating WAVs; the studio applies one common attenuation afterwards.
    def write_float(stem_path, stem_source):
        target=Path(stem_path)
        if not target.is_absolute():target=raw/target
        sf.write(target, np.asarray(stem_source).T if np.asarray(stem_source).shape[0] == 2 else stem_source, 44100, subtype='FLOAT')
    engine.model_instance.write_audio = write_float
    mapping = {'Vocals':'vocals','Instrumental':'instrumental','Drums':'drums','Bass':'bass','Other':'other'}
    names = {name:role for name,role in mapping.items() if role in spec['outputs']}
    report(stage='toolboxSeparate', progress=None)
    files = engine.separate(clean_path(r['inputPath']), custom_output_names=names)
    outputs = {}
    for filename in files:
        file = Path(filename)
        if not file.is_absolute(): file = raw / file
        role = next((role for role in spec['outputs'] if file.stem == role), None)
        if role is None: raise ValueError('AUDIO_TOOLBOX_INVALID_AUDIO')
        data, rate = sf.read(file, dtype='float32', always_2d=True)
        if rate != 44100: raise ValueError('AUDIO_TOOLBOX_INVALID_AUDIO')
        data = resample_poly(data, 160, 147, axis=0)[:len(source)]
        data = np.pad(data, ((0,len(source)-len(data)),(0,0)))
        if data.shape[1] == 1: data = data.repeat(2,axis=1)
        outputs[role] = data
    if set(outputs) != set(spec['outputs']): raise ValueError('AUDIO_TOOLBOX_INVALID_AUDIO')
    return outputs


def generate(r):
    validate(r)
    spec = verified_model(r)
    import torch
    import numpy as np
    import soundfile as sf
    from cosyvoice_worker import inference_device
    device=inference_device(r['device'])
    name=torch.cuda.get_device_name(device) if device.startswith('cuda:') else 'CPU'
    if device.startswith('cuda:'): torch.cuda.set_device(torch.device(device))
    source, rate = sf.read(clean_path(r['inputPath']), dtype='float32', always_2d=True)
    if rate != 48000 or source.shape[1] != 2 or not 4800 <= len(source) <= 60*rate or not np.isfinite(source).all():
        raise ValueError('AUDIO_TOOLBOX_INVALID_AUDIO')
    Path(r['outputDir']).mkdir(exist_ok=True)
    report(stage='toolboxLoad', progress=None, log=f"{spec['name']} · {name} · bounded {r['windowSeconds']} s windows")
    with contextlib.redirect_stdout(sys.stderr):
        outputs = audiosep(r,source,device) if spec['family']=='audiosep' else separator(r,spec,source,device)
    if any(y.shape!=source.shape or not np.isfinite(y).all() for y in outputs.values()): raise ValueError('AUDIO_TOOLBOX_INVALID_AUDIO')
    peak = max(float(np.max(np.abs(y))) for y in outputs.values())
    scale = min(1.0,.98/max(peak,1e-9))
    rows=[]
    for role,y in outputs.items():
        path = Path(r['outputDir']) / f'{role}.wav'
        sf.write(path,y*scale,48000,subtype='PCM_16')
        rows.append({'id':role,'file':path.name,'frames':len(y)})
    Path(r['resultPath']).write_text(json.dumps({'outputs':rows,'commonGain':scale,'device':device,'deviceName':name}),encoding='utf-8')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--request');parser.add_argument('--runtime-info',action='store_true');parser.add_argument('--info',action='store_true');args=parser.parse_args()
    if args.runtime_info or args.info:
        import torch, audio_separator, lightning, torchlibrosa, rotary_embedding_torch
        from audio_separator.separator.architectures import mdxc_separator, demucs_separator
        from cosyvoice_worker import device_info
        info=device_info()
        report(runtimeReady=True,torchVersion=torch.__version__.split('+')[0],cudaVersion=torch.version.cuda,devices=info['devices']);return
    generate(json.loads(Path(args.request).read_text(encoding='utf-8-sig')))


if __name__=='__main__':
    try: main()
    except Exception as error:
        code='AUDIO_TOOLBOX_GPU_OOM' if 'out of memory' in str(error).lower() else str(error) if str(error).isupper() else 'AUDIO_TOOLBOX_FAILED'
        report(error=code)
        raise
