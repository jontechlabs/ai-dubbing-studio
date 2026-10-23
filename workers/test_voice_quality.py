import unittest
from voice_quality import CATALOG, quality_options
from multilingual_worker import voxcpm_arguments, chatterbox_arguments
from cosyvoice_worker import validate_request

class QualityTests(unittest.TestCase):
    def test_all_presets_and_defaults_are_bounded(self):
        for id, spec in CATALOG.items():
            for profile in spec['presets'].values():
                self.assertEqual(set(quality_options(dict(variantId=id, quality=profile))), set(spec['parameters']))
        self.assertEqual(quality_options({}), {'inferenceSteps': 10})

    def test_invalid_quality_fails_before_neural_import(self):
        for quality in [[], {'inferenceSteps': 31}, {'inferenceSteps': 4.5}, {'cfgStrength': float('nan')}, {'cfgStrength': True}, {'cfgStrength': '1.6'}, {'unknown': 1}]:
            with self.subTest(quality=quality), self.assertRaisesRegex(ValueError, 'INVALID_TTS_QUALITY'):
                validate_request(dict(variantId='voxcpm2-bf16', quality=quality))
        with self.assertRaisesRegex(ValueError, 'INVALID_TTS_QUALITY'):
            quality_options(dict(variantId='cosy3-official', quality={'temperature': .8}))

    def test_vox_natural_and_standard_keep_target_and_reference_separate(self):
        request = dict(variantId='voxcpm2-bf16', text='Bonjour.', language='fr', mode='crossLingual')
        tuned = voxcpm_arguments(request | dict(quality=CATALOG['voxcpm2-bf16']['presets']['natural']), 'ja.wav')
        default = voxcpm_arguments(request, 'ja.wav')
        self.assertEqual((tuned['inference_timesteps'], tuned['cfg_value']), (20, 1.6))
        self.assertEqual((default['inference_timesteps'], default['cfg_value']), (10, 2))
        self.assertEqual(tuned['text'], 'Bonjour.')
        self.assertEqual(tuned['reference_wav_path'], 'ja.wav')

    def test_chatter_parameters_are_forwarded_without_forcing_reference_accent(self):
        request = dict(variantId='chatterbox-multilingual-v3', text='Bonjour.', language='fr', quality={'temperature': .6, 'exaggeration': .7})
        args = chatterbox_arguments(request, 'ja.wav')
        self.assertEqual(args['temperature'], .6)
        self.assertEqual(args['exaggeration'], .7)
        self.assertEqual(args['cfg_weight'], 0)
        self.assertEqual(args['language_id'], 'fr')

    def test_shared_catalog_is_shipped_in_native_resources(self):
        import json
        from pathlib import Path
        root = Path(__file__).resolve().parents[1]
        resources = json.loads((root/'src-tauri/tauri.conf.json').read_text())['bundle']['resources']
        self.assertEqual(resources['../workers/voice_quality.py'], 'workers/voice_quality.py')
        self.assertEqual(resources['../workers/voice-quality.json'], 'workers/voice-quality.json')

if __name__ == '__main__':
    unittest.main()
