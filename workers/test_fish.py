import hashlib
import json
from pathlib import Path
import unittest
from fish_worker import generate


class FishTests(unittest.TestCase):
    def test_fp8_requires_a_transcript_and_cuda_before_loading_models(self):
        request=dict(text='Bonjour',language='fr',mode='zeroShot',speed=1,device='cpu',referenceTranscript='Hello')
        with self.assertRaisesRegex(ValueError,'TTS_FP8_CUDA_REQUIRED'): generate(request)
        request['device']='auto';request['referenceTranscript']=''
        with self.assertRaisesRegex(ValueError,'TTS_TRANSCRIPT_REQUIRED'): generate(request)

    def test_model_and_runtime_manifests_include_all_engines_and_verified_files(self):
        root=Path(__file__).parent
        manifest=json.loads((root/'voice-engines.json').read_text(encoding='utf-8'))
        self.assertEqual(len(manifest['variants']),7)
        self.assertTrue(manifest['engine']['name'].endswith('vulkan-portable.zip'))
        runtime=json.loads((root/'fish-runtime.json').read_text(encoding='utf-8'))
        self.assertGreater(len(runtime['files']),100)
        for file in [manifest['engine']]+[f for v in manifest['variants'] for f in v['files']]+runtime['files']:
            with self.subTest(file=file['name']):
                self.assertEqual(len(file['sha256']),64);self.assertGreater(file['size'],0)
                if 'bundledPath' in file:
                    content=(root/file['bundledPath']).read_bytes()
                    self.assertEqual(len(content),file['size']);self.assertEqual(hashlib.sha256(content).hexdigest(),file['sha256'])
                else:self.assertTrue(file['url'].startswith('https://'))
