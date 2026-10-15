"""Exercise the real reference loader and GPU-independent frontend selection."""
import ast
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import os
from contextlib import nullcontext
import threading
import numpy as np
import soundfile as sf


def function(file, name, cls=None):
    tree = ast.parse((Path(__file__).parent / 'vendor/cosyvoice3/cosyvoice' / file).read_text(encoding='utf-8'))
    body = tree.body if cls is None else next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls).body
    node = next(n for n in body if isinstance(n, ast.FunctionDef) and n.name == name)
    return compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(file), 'exec')


class ReferenceCompatibility(unittest.TestCase):
    def test_model_honors_explicit_cpu_even_when_cuda_is_available(self):
        streams = []
        def device(value): return SimpleNamespace(type=value.split(':')[0], name=value)
        def stream(value): streams.append(value.name); return nullcontext()
        torch = SimpleNamespace(nn=SimpleNamespace(Module=object), device=device,
                                cuda=SimpleNamespace(is_available=lambda: True, Stream=stream, stream=lambda context: context))
        namespace = {'torch':torch, 'nullcontext':nullcontext, 'threading':threading}
        exec(function('cli/model.py', '__init__', 'CosyVoice3Model'), namespace)
        model = SimpleNamespace()
        namespace['__init__'](model, None, None, None, fp16=True, device='cpu')
        self.assertEqual(model.device.name, 'cpu')
        self.assertFalse(model.fp16)
        self.assertEqual(streams, [])
        namespace['__init__'](model, None, None, None, fp16=True, device='cuda:2')
        self.assertEqual(model.device.name, 'cuda:2')
        self.assertTrue(model.fp16)
        self.assertEqual(streams, ['cuda:2'])

    def test_loader_decodes_and_resamples_extended_windows_paths_without_torchaudio(self):
        class Tensor:
            def __init__(self, array): self.array = array
            def unsqueeze(self, axis): return np.expand_dims(self.array, axis)
        namespace = {'torch': SimpleNamespace(from_numpy=Tensor)}
        exec(function('utils/file_utils.py', 'load_wav'), namespace)
        base = tempfile.gettempdir()
        if os.name == 'nt': base = '\\\\?\\' + base
        with tempfile.TemporaryDirectory(prefix='voice reference ', dir=base) as folder:
            path = Path(folder) / 'r\u00e9f\u00e9rence.wav'
            t = np.arange(48000) / 48000
            sf.write(path, np.column_stack([np.sin(2*np.pi*440*t)*0.2]*2), 48000, subtype='PCM_16')
            for rate in (16000, 24000):
                result = namespace['load_wav'](str(path), rate)
                self.assertEqual(result.shape, (1, rate))
                self.assertEqual(result.dtype, np.float32)
                self.assertTrue(np.isfinite(result).all())
                self.assertGreater(float(np.max(np.abs(result))), 0.19)

    def test_cuda_availability_never_requests_an_uninstalled_onnx_gpu_provider(self):
        providers = []
        def session(path, sess_options, providers):
            self.assertEqual(providers, ['CPUExecutionProvider'])
            return path
        def record(path, sess_options, providers):
            session(path, sess_options, providers)
            return providers
        namespace = {'torch': SimpleNamespace(device=lambda device: device, cuda=SimpleNamespace(is_available=lambda: True)),
                     'onnxruntime': SimpleNamespace(SessionOptions=SimpleNamespace, GraphOptimizationLevel=SimpleNamespace(ORT_ENABLE_ALL=1), InferenceSession=record),
                     'Callable': object, 'os': SimpleNamespace(path=SimpleNamespace(exists=lambda _: False)),
                     'inflect': SimpleNamespace(engine=lambda: None), 'logging': SimpleNamespace(info=lambda _: None)}
        exec(function('cli/frontend.py', '__init__', 'CosyVoiceFrontEnd'), namespace)
        frontend = SimpleNamespace()
        namespace['__init__'](frontend, lambda: None, lambda _: None, 'speaker.onnx', 'tokens.onnx')
        self.assertEqual(frontend.device, 'cpu')
        self.assertEqual(frontend.campplus_session, ['CPUExecutionProvider'])
        self.assertEqual(frontend.speech_tokenizer_session, ['CPUExecutionProvider'])


if __name__ == '__main__': unittest.main()
