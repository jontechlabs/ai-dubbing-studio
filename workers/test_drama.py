import json
from pathlib import Path
import unittest
from drama_worker import validate, memory_profile, GIB, verify_models, storage_preflight
from unittest.mock import patch
from types import SimpleNamespace
import tempfile


class DramaTests(unittest.TestCase):
    def test_storage_shortage_logs_measured_path_and_capacity_before_failure(self):
        with tempfile.TemporaryDirectory() as tmp, patch('shutil.disk_usage', return_value=SimpleNamespace(free=GIB)), patch('drama_worker.report') as report:
            with self.assertRaisesRegex(ValueError, 'TTS_DRAMA_DISK_REQUIRED'):
                storage_preflight(tmp, [{'name': 'weights', 'size': 3 * GIB}])
            details = report.call_args.kwargs
            self.assertEqual(details['storagePath'], str(Path(tmp)))
            self.assertEqual(details['availableBytes'], GIB)
            self.assertEqual(details['requiredBytes'], 5 * GIB)
            self.assertIn('available 1.00 GiB; required 5.00 GiB', details['log'])

    def test_storage_reuses_complete_weights_but_reserves_space_for_incomplete_files(self):
        with tempfile.TemporaryDirectory() as tmp, patch('shutil.disk_usage', return_value=SimpleNamespace(free=2 * GIB + 4)), patch('drama_worker.report') as report:
            directory = Path(tmp)
            (directory / 'complete').write_bytes(b'123')
            (directory / 'incomplete').write_bytes(b'1')
            storage_preflight(directory, [{'name': 'complete', 'size': 3}, {'name': 'incomplete', 'size': 4}])
            self.assertEqual(report.call_args.kwargs['requiredBytes'], 2 * GIB + 4)

    def test_transcript_and_gpu_required_before_any_model_load(self):
        request = dict(text='Bonjour', language='fr', mode='zeroShot', speed=1, device='cuda:0', referenceTranscript='こんにちは')
        validate(request)
        for device in ['cpu', 'vulkan:0']:
            request['device'] = device
            with self.assertRaises(ValueError):
                validate(request)
        request.update(device='cuda:0', referenceTranscript='', mood='angry')
        with self.assertRaisesRegex(ValueError, 'TTS_TRANSCRIPT_REQUIRED'):
            validate(request)
        request.update(referenceTranscript='こんにちは', mode='crossLingual')
        with self.assertRaisesRegex(ValueError, 'TTS_TRANSCRIPT_REQUIRED'):
            validate(request)

    def test_64_gb_host_and_16_gb_gpu_budget_leave_explicit_headroom(self):
        self.assertEqual(memory_profile(64 * GIB, 50 * GIB, 15 * GIB), 4)
        with self.assertRaisesRegex(ValueError, 'TTS_DRAMA_RAM_REQUIRED'):
            memory_profile(32 * GIB, 30 * GIB, 16 * GIB)
        with self.assertRaisesRegex(ValueError, 'TTS_DRAMA_RAM_REQUIRED'):
            memory_profile(64 * GIB, 45 * GIB, 16 * GIB)
        with self.assertRaisesRegex(ValueError, 'TTS_DRAMA_VRAM_REQUIRED'):
            memory_profile(64 * GIB, 50 * GIB, 11 * GIB)

    def test_drama_weights_are_distinct_from_s2_and_integrity_is_required(self):
        import tempfile
        folder = Path(__file__).parent
        manifest = json.loads((folder / 'voice-engines.json').read_text(encoding='utf-8'))
        variant = next(v for v in manifest['variants'] if v['id'] == 'drama3-comfy-fp8')
        self.assertEqual(variant['engine'], 'drama3')
        self.assertEqual(sum(f['size'] for f in variant['files']), 40144065412)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'MODEL_CHECKSUM_FAILED'):
                verify_models(Path(tmp))

    def test_packaged_core_has_matching_provenance_and_complete_fp8_dependencies(self):
        import hashlib
        import zipfile
        root = Path(__file__).parent
        vendor = root / 'vendor/drama3'
        provenance = json.loads((vendor / 'COMFY-UPSTREAM.json').read_text())
        self.assertEqual(hashlib.sha256((vendor / 'comfy-core.zip').read_bytes()).hexdigest(), provenance['sha256'])
        with zipfile.ZipFile(vendor / 'comfy-core.zip') as archive:
            self.assertIn('comfy/text_encoders/qwen35.py', archive.namelist())
            self.assertIn('LICENSE', archive.namelist())
        files = json.loads((root / 'drama-runtime.json').read_text())['files']
        names = [f['name'].split('-')[0] for f in files]
        self.assertEqual(len(names), len(set(names)))
        for name in ['torch', 'torchvision', 'comfy_kitchen', 'comfy_aimdo', 'psutil', 'safetensors', 'tokenizers']:
            self.assertIn(name, names)
