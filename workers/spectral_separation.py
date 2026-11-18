"""Pinned TF-GridNet / SR-CorrNet inference, bounded to one FP32 window."""
from pathlib import Path
import io
import sys
import zipfile

HERE = Path(__file__).resolve().parent


def state_dict(file):
    import torch
    raw = torch.load(file, map_location='cpu', weights_only=True)
    for key in ['model_state_dict', 'state_dict']:
        if isinstance(raw, dict) and key in raw:
            raw = raw[key]
            break
    if not isinstance(raw, dict):
        raise ValueError('SPEAKER_SEPARATION_MODEL_INVALID')
    # THOP's optional profiling counters are not model parameters. Every
    # actual parameter/buffer must still match the pinned architecture exactly.
    return {k.replace('_orig_mod.', '').removeprefix('module.'): v for k, v in raw.items()
            if k.rsplit('.', 1)[-1] not in ('total_ops', 'total_params')}


def load_engine(folder, spec, device, speakers):
    import numpy as np
    import torch
    import yaml
    if spec['family'] == 'tfgridnet':
        sys.path.insert(0, str(HERE / 'vendor/spectral-separation/tfgridnet-core.zip'))
        from studio_tfgridnet import TFGridNet
        base = 'exp/enh_train_enh_tfgridnet_tf_lr-patience3_patience5_raw/'
        with zipfile.ZipFile(folder / 'model.zip') as archive:
            config = yaml.safe_load(archive.read(base + 'config.yaml'))
            weights = state_dict(io.BytesIO(archive.read(base + '98epoch.pth')))
        settings = config['separator_conf']
        if config['sample_rate'] != spec['sampleRate'] or settings['n_imics'] != 1 or settings['n_srcs'] != speakers:
            raise ValueError('SPEAKER_SEPARATION_MODEL_INVALID')
        model = TFGridNet(input_dim=0, **settings, use_builtin_complex=True)
        weights = {k.removeprefix('separator.'): v for k, v in weights.items()}
        model.load_state_dict(weights, strict=True)
        model.to(device).eval()

        def infer(samples):
            if float(np.max(np.abs(samples))) < 1e-8:
                return np.zeros((speakers, len(samples)), dtype=np.float32)
            with torch.inference_mode():
                wave = torch.from_numpy(samples).unsqueeze(0).to(device)
                values = model(wave, torch.tensor([len(samples)], device=device))[0]
                return np.stack([v[0].float().cpu().numpy() for v in values])
        return infer

    sys.path.insert(0, str(HERE / 'vendor/spectral-separation/sr-corrnet-core.zip'))
    from sr_corrnet.models.SR_CorrNet_SS.model import Model
    from sr_corrnet.utils.util_stft import STFT, iSTFT
    config = yaml.safe_load((folder / 'config.yaml').read_text(encoding='utf-8-sig'))['config']
    if config['dataset']['synthesis_config']['sampling_rate'] != spec['sampleRate'] or not 2 <= speakers <= config['max_n_spks']:
        raise ValueError('SPEAKER_SEPARATION_MODEL_INVALID')
    model = Model(**config['model'])
    model.load_state_dict(state_dict(folder / 'model.pt'), strict=True)
    model.to(device).eval()
    stft = STFT(**config['stft'], device=device, normalize=True)
    istft = iSTFT(**config['stft'], device=device, normalize=True)
    frame = config['stft']['frame_length']
    hop = config['stft']['frame_shift']

    def infer(samples):
        if float(np.max(np.abs(samples))) < 1e-8:
            return np.zeros((speakers, len(samples)), dtype=np.float32)
        with torch.inference_mode():
            wave = torch.from_numpy(samples).unsqueeze(0).to(device)
            scale = wave.std(dim=-1, keepdim=True) + 1e-8
            # The upstream convolutional STFT has no centering or length
            # correction. Context padding preserves both boundaries and the
            # exact requested samples, including the last syllable.
            pad = frame - hop
            tail = (-(wave.shape[-1] + 2 * pad - frame)) % hop
            wave = torch.nn.functional.pad(wave / scale, (pad, pad + tail))
            spectrum = stft(wave, cplx=True)
            inputs = torch.cat([spectrum.real, spectrum.imag], dim=0)
            values = model(inputs, n_spks=torch.tensor(speakers, device=device))[0]
            outputs = []
            for value in values:
                value = torch.complex(value[..., 0], value[..., 1])
                audio = istft(value[0, config['model']['ref_ch']], cplx=True, squeeze=True)
                outputs.append((audio[pad:pad+len(samples)] * scale[0, 0]).float().cpu().numpy())
            return np.stack(outputs)
    return infer
