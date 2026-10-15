import hashlib
import json
from pathlib import Path
import unittest
from cosyvoice_worker import validate_request, compatibility_profile
from types import SimpleNamespace


class CosyVoiceTests(unittest.TestCase):
    def test_compatibility_retry_keeps_cuda_and_disables_only_acceleration_backends(self):
        calls = []
        cudnn = SimpleNamespace(enabled=True)
        torch = SimpleNamespace(backends=SimpleNamespace(cudnn=cudnn, cuda=SimpleNamespace(
            enable_flash_sdp=lambda value: calls.append(('flash', value)),
            enable_mem_efficient_sdp=lambda value: calls.append(('efficient', value)),
            enable_cudnn_sdp=lambda value: calls.append(('cudnn', value)),
            enable_math_sdp=lambda value: calls.append(('math', value)))))
        self.assertTrue(compatibility_profile(torch, 'cuda:0', False))
        self.assertEqual(calls, [])
        self.assertFalse(compatibility_profile(torch, 'cuda:0', True))
        self.assertFalse(cudnn.enabled)
        self.assertEqual(calls, [('flash', False), ('efficient', False), ('cudnn', False), ('math', True)])
        calls.clear()
        self.assertFalse(compatibility_profile(torch, 'cpu', True))
        self.assertEqual(calls, [])
    def request(self, **changes):
        return dict(text='Bonjour', language='fr', speed=1, mode='crossLingual', device='cuda:0', seed=7, **changes)

    def test_cross_language_reference_does_not_require_transcript(self):
        self.assertEqual(validate_request(self.request()), 'cuda:0')
        request=self.request();request.update(device='cpu', mode='zeroShot', referenceTranscript='Hello there')
        self.assertEqual(validate_request(request), 'cpu')

    def test_refuses_missing_text_transcript_language_and_invalid_device(self):
        for changes, error in [({'text':''},'TTS_TEXT_REQUIRED'),({'text':'x'*1001},'TTS_TEXT_REQUIRED'),({'language':'xx'},'TTS_LANGUAGE_UNSUPPORTED'),({'mode':'zeroShot'},'TTS_TRANSCRIPT_REQUIRED'),({'speed':float('nan')},'INVALID_TTS_REQUEST'),({'device':'cuda:-1'},'DEVICE_UNAVAILABLE')]:
            with self.subTest(changes=changes):
                request=self.request();request.update(changes)
                with self.assertRaisesRegex(ValueError,error):validate_request(request)

    def test_model_and_runtime_are_pinned_and_bundled_wheels_match(self):
        root=Path(__file__).parent
        model=json.loads((root/'cosyvoice-model.json').read_text())
        self.assertEqual(model['revision'],'29e01c4e8d000f4bcd70751be16fa94bf3d85a18')
        self.assertEqual(sum(f['size'] for f in model['files']),5427042285)
        runtime=json.loads((root/'cosyvoice-runtime.json').read_text())
        for file in model['files']+runtime['common']+runtime['variants']['cu128']+runtime['variants']['cpu']:
            with self.subTest(file=file['name']):
                self.assertEqual(len(file['sha256']),64)
                self.assertGreater(file['size'],0)
                if 'bundledPath' in file:
                    content=(root/file['bundledPath']).read_bytes()
                    self.assertEqual(len(content),file['size'])
                    self.assertEqual(hashlib.sha256(content).hexdigest(),file['sha256'])
                else:self.assertTrue(file['url'].startswith('https://'))


if __name__=='__main__':unittest.main()
