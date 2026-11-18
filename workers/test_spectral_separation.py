"""Fast contracts; real frozen weights are exercised by the opt-in smoke."""
from pathlib import Path
import hashlib
import json
import unittest
import zipfile
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import speaker_separation_worker as worker


class SpectralContracts(unittest.TestCase):
    def test_auto_uses_actual_cuda_availability_and_an_explicit_gpu_never_falls_back(self):
        selected = []
        cuda = SimpleNamespace(is_available=lambda: True, device_count=lambda: 2,
            set_device=lambda n: selected.append(n), reset_peak_memory_stats=lambda n: None,
            get_device_name=lambda n: 'GPU ' + str(n))
        with patch.dict(sys.modules, {'torch': SimpleNamespace(cuda=cuda)}):
            self.assertEqual(worker.device_name('auto'), ('cuda:0', 'GPU 0'))
            self.assertEqual(worker.device_name('cuda:1'), ('cuda:1', 'GPU 1'))
            self.assertEqual(selected, [0, 1])
            cuda.is_available = lambda: False
            self.assertEqual(worker.device_name('auto'), ('cpu', 'CPU'))
            with self.assertRaisesRegex(ValueError, 'DEVICE_UNAVAILABLE'):
                worker.device_name('cuda:1')

    def test_isolated_launcher_finds_bundled_helpers_from_an_unrelated_directory(self):
        source = Path(__file__).parent.resolve()
        command = f"import runpy,pathlib;runpy.run_path({str(source/'speaker_separation_worker.py')!r},run_name='isolated_worker');import spectral_separation;assert pathlib.Path(spectral_separation.__file__).resolve()==pathlib.Path({str(source/'spectral_separation.py')!r})"
        with tempfile.TemporaryDirectory() as folder:
            subprocess.run([sys.executable, '-I', '-B', '-c', command], cwd=folder, check=True, timeout=30, capture_output=True)

    def test_window_polarity_inversions_do_not_cancel_the_overlap_or_last_samples(self):
        calls = []
        def infer(chunk):
            calls.append(True)
            return np.stack([chunk, chunk * .5]) * (-1 if len(calls) % 2 == 0 else 1)
        source = np.random.default_rng(5060).normal(size=5001).astype(np.float32)
        result = worker.separate_windows(source, 2, 1000, infer)
        np.testing.assert_allclose(result[0], source, atol=1e-6)
        np.testing.assert_allclose(result[1], source * .5, atol=1e-6)

    def test_profiles_bound_windows_and_reject_invalid_counts_and_values(self):
        tf = worker.model_spec('tf-gridnet-wsj0-2mix')
        sr = worker.model_spec('sr-corrnet-wsj-2-5spk')
        self.assertEqual(worker.settings(tf, {}), (2, 'gpu16', 2000))
        self.assertEqual(worker.settings(sr, {'speakerCount': 5, 'windowMs': 8000}), (5, 'gpu16', 2000))
        self.assertEqual(worker.settings(sr, {'memoryProfile': 'quality', 'windowMs': 8000}), (2, 'quality', 4000))
        self.assertEqual(worker.settings(sr, {'memoryProfile': 'manual', 'windowMs': 6000}), (2, 'manual', 6000))
        for request in [{'speakerCount': True}, {'speakerCount': 6}, {'speakerCount': 1}, {'speakerCount': 2.5}, {'memoryProfile': 'fp16'}, {'windowMs': 9000}]:
            with self.assertRaisesRegex(ValueError, 'SPEAKER_SEPARATION_OPTIONS'):
                worker.settings(sr, request)
        with self.assertRaisesRegex(ValueError, 'SPEAKER_SEPARATION_OPTIONS'):
            worker.settings(tf, {'speakerCount': 3})
        legacy = worker.model_spec('sepformer-3mix')
        self.assertEqual(worker.settings(legacy, {'windowMs': 8000}), (3, 'manual', 8000))

    def test_cuda_oom_retries_smaller_windows_keeps_all_samples_and_never_moves_device(self):
        windows, released = [], []
        def infer(samples):
            windows.append(len(samples))
            if len(samples) > 1000:
                raise RuntimeError('CUDA out of memory')
            return np.stack([samples, samples * 0.5])
        audio, window, attempts = worker.bounded_separation(np.ones(3301, dtype=np.float32), 2, 1000, 4000, infer, 'cuda:1', lambda *_: None, lambda: released.append(True))
        self.assertEqual((window, attempts), (1000, 3))
        self.assertEqual(released, [True, True])
        self.assertEqual(windows[:3], [4000, 2000, 1000])
        np.testing.assert_allclose(audio[0], 1)
        np.testing.assert_allclose(audio[1], .5)
        self.assertEqual(audio.shape, (2, 3301))

    def test_cpu_errors_and_non_memory_cuda_errors_are_not_retried(self):
        for device, message in [('cpu', 'out of memory'), ('cuda:0', 'invalid kernel')]:
            def infer(_):
                raise RuntimeError(message)
            with self.assertRaisesRegex(RuntimeError, message):
                worker.bounded_separation(np.ones(1000, dtype=np.float32), 2, 1000, 2000, infer, device, lambda *_: None, lambda: self.fail('Unexpected retry'))

    def test_oom_floor_fails_instead_of_silently_using_cpu(self):
        def infer(_):
            raise RuntimeError('CUDA out of memory')
        with self.assertRaisesRegex(ValueError, 'SPEAKER_SEPARATION_OUT_OF_MEMORY'):
            worker.bounded_separation(np.ones(1000, dtype=np.float32), 2, 1000, 500, infer, 'cuda:0', lambda *_: None, lambda: self.fail('Unexpected retry'))

    def test_five_stream_permutations_are_aligned_across_windows(self):
        rng = np.random.default_rng(128)
        reference = rng.normal(size=(5, 1000)).astype(np.float32)
        perm = [4, 2, 0, 3, 1]
        self.assertEqual(worker.align_channels(reference, reference[perm]), (2, 4, 1, 3, 0))
        for n in [1, 1001, 3001, 6000]:
            audio = worker.separate_windows(np.ones(n, dtype=np.float32), 5, 1000,
                lambda chunk: np.stack([chunk * (i + 1) for i in range(5)]))
            self.assertEqual(audio.shape, (5, n))
            for i in range(5): np.testing.assert_allclose(audio[i], i + 1)

    def test_vendors_and_checkpoints_are_pinned_and_inference_only(self):
        resources = json.loads((Path(__file__).parents[1] / 'src-tauri/tauri.conf.json').read_text())['bundle']['resources']
        for name in ['spectral_separation.py', 'spectral_compat.py', 'vendor/spectral-separation/']:
            self.assertEqual(resources.get('../workers/' + name), 'workers/' + name)
        folder = Path(__file__).parent / 'vendor/spectral-separation'
        data = json.loads((folder / 'sources.json').read_text())
        for key, name in [('tfgridnet', 'tfgridnet-core.zip'), ('srCorrnet', 'sr-corrnet-core.zip')]:
            self.assertEqual(len(data[key]['revision']), 40)
            with (folder / name).open('rb') as stream:
                self.assertEqual(hashlib.file_digest(stream, 'sha256').hexdigest(), data[key]['archiveSha256'])
            with zipfile.ZipFile(folder / name) as archive:
                self.assertIsNone(archive.testzip())
                self.assertIn('LICENSE', archive.namelist())
                self.assertFalse(any('dataset.py' in n or 'optimizer' in n for n in archive.namelist()))
        with zipfile.ZipFile(folder / 'sr-corrnet-core.zip') as archive:
            source = archive.read('sr_corrnet/models/SR_CorrNet_SS/modules/module.py').decode()
            self.assertNotIn('self.get_2d_sinusoids(5000, 1500', source)
            self.assertIn('self.get_2d_sinusoids(T, F, C)', source)
        for model in json.loads((Path(__file__).parent / 'speaker-separation-models.json').read_text())['models']:
            if model['family'] not in ('tfgridnet', 'srcorrnet'): continue
            self.assertEqual(len(model['revision']), 40)
            for item in model['files']:
                self.assertEqual(len(item['sha256']), 64)
                self.assertGreater(item['size'], 0)
                self.assertTrue(item['url'].startswith('https://'))


if __name__ == '__main__': unittest.main()
