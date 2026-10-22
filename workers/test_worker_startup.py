"""Exercise entry points with no script directory or PYTHONPATH inheritance."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class IsolatedWorkerStartupTests(unittest.TestCase):
    def test_single_multilingual_requests_resolve_shared_validation_on_cpu_and_cuda(self):
        script = Path(__file__).resolve().with_name('multilingual_worker.py')
        with tempfile.TemporaryDirectory(prefix='studio-startup-') as directory:
            request = Path(directory) / 'référence 日本語.json'
            for variant in ['voxcpm2-bf16', 'chatterbox-multilingual-v3']:
                for device in ['cpu', 'cuda:0']:
                    with self.subTest(variant=variant, device=device):
                        # A controlled validation error must arrive before neural imports.
                        request.write_text(json.dumps(dict(variantId=variant, device=device,
                            text='', language='fr', mode='crossLingual', speed=1,
                            mood='default', accent='auto')), encoding='utf-8-sig')
                        result = subprocess.run([sys.executable, '-I', '-B', str(script),
                            '--request', str(request)], cwd=directory, capture_output=True,
                            text=True, encoding='utf-8', timeout=20,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                        self.assertEqual(result.returncode, 1, result.stderr)
                        self.assertEqual(json.loads(result.stdout), {'error': 'TTS_TEXT_REQUIRED'})
                        self.assertNotIn('ModuleNotFoundError', result.stderr)

    def test_both_entry_points_bootstrap_all_shared_audio_modules_without_the_batch_adapter(self):
        workers = Path(__file__).resolve().parent
        code = """import runpy, sys
runpy.run_path(sys.argv[1])
from cosyvoice_worker import validate_request, inference_device
from voice_reference import prepare_reference
from multilingual_worker import validate, verify_models, voxcpm_arguments
for device in ['cpu', 'cuda:0']:
    request = dict(text='Bonjour.', language='fr', mode='crossLingual', speed=1,
        mood='default', accent='auto', variantId='voxcpm2-bf16', device=device)
    validate(request)
    assert voxcpm_arguments(request, 'ref.wav')['text'] == 'Bonjour.'
assert inference_device('cpu') == 'cpu'
assert 'torch' not in sys.modules
print('ISOLATED_WORKER_IMPORTS_OK')
"""
        with tempfile.TemporaryDirectory() as directory:
            for filename in ['multilingual_worker.py', 'voice_conversion_worker.py']:
                with self.subTest(filename=filename):
                    result = subprocess.run([sys.executable, '-I', '-B', '-c', code,
                        str(workers / filename)], cwd=directory, capture_output=True,
                        text=True, encoding='utf-8', timeout=20,
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), 'ISOLATED_WORKER_IMPORTS_OK')


if __name__ == '__main__':
    unittest.main()
