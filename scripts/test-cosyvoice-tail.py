"""Exercise finalization with the real causal vocoder, at diagnostic scale on CPU.

No speech-quality or RTX qualification claim: learned-weight tests are separate.
"""
import ast
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np
import torch
import torch.nn.functional as F

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'workers/vendor/cosyvoice3'))
from cosyvoice.hifigan.generator import CausalHiFTGenerator
from cosyvoice.hifigan.f0_predictor import CausalConvRNNF0Predictor

torch.set_num_threads(2)
torch.manual_seed(17)
vocoder = CausalHiFTGenerator(
    in_channels=80, base_channels=16, nb_harmonics=8, sampling_rate=24000,
    upsample_rates=[8, 5, 3], upsample_kernel_sizes=[16, 10, 6],
    istft_params={'n_fft': 16, 'hop_len': 4},
    resblock_kernel_sizes=[3], resblock_dilation_sizes=[[1, 3, 5]],
    source_resblock_kernel_sizes=[3, 3, 3],
    source_resblock_dilation_sizes=[[1, 3, 5]] * 3,
    f0_predictor=CausalConvRNNF0Predictor(in_channels=80, cond_channels=8),
).eval()

# Import this production method without importing unused LLM/ONNX dependencies.
tree = ast.parse((root / 'workers/vendor/cosyvoice3/cosyvoice/cli/model.py').read_text(encoding='utf-8'))
cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'CosyVoice3Model')
method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'token2wav')
scope = {'torch': torch, 'np': np, 'F': F}
exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), 'token2wav', 'exec'), scope)
mel = torch.randn(1, 80, 40) * 0.2 - 5
calls = []

def decode(speech_feat, finalize):
    calls.append((speech_feat.clone(), finalize))
    return vocoder.inference(speech_feat, finalize=finalize)

with torch.inference_mode():
    for speed in (0.5, 1.0, 2.0):
        model = SimpleNamespace(device=torch.device('cpu'), fp16=False,
            flow=SimpleNamespace(token_mel_ratio=2, inference=lambda **_: (mel.clone(), None)),
            hift_cache_dict={'test': None}, hift=SimpleNamespace(inference=decode))
        result = scope['token2wav'](model, torch.zeros(1, 20), torch.zeros(1, 0),
            torch.zeros(1, 0, 80), torch.zeros(1, 192), 0, 'test', finalize=True, speed=speed)
        expected = F.interpolate(mel, size=int(40/speed), mode='linear') if speed != 1 else mel
        conditioned, final = calls[-1]
        torch.testing.assert_close(conditioned[:, :, :-8], expected, rtol=0, atol=0)
        assert final and conditioned.shape[-1] == expected.shape[-1] + 8
        torch.testing.assert_close(conditioned[:, :, -8:], torch.full_like(conditioned[:, :, -8:], float(np.log(1e-5))), rtol=0, atol=0)
        assert result.shape[-1] == conditioned.shape[-1] * 480
        assert torch.isfinite(result).all()
        assert model.hift_cache_dict['test']['mel'].shape[-1] == 40
    # Non-final chunks must retain exactly their own conditioning and offsets.
    model.hift_cache_dict['test'] = None
    scope['token2wav'](model, torch.zeros(1, 20), torch.zeros(1, 0),
        torch.zeros(1, 0, 80), torch.zeros(1, 192), 0, 'test', finalize=False)
    conditioned, final = calls[-1]
    assert not final and conditioned.shape[-1] == 40

print('PASS: actual causal vocoder; final acoustic-silence context; full tail at 0.5x/1x/2x; unmodified non-final chunks and mel cache')
