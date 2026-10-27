import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from multilingual_worker import validate, voxcpm_arguments, chatterbox_arguments, verify_models, protect_pcm_peaks
from drama_worker import target_prompt, target_chunks


def request(**changes):
    return dict(text='Ah ! Je vire ça !', referenceTranscript='あぁ！ 外すんだよ!!', language='fr',
                mode='crossLingual', device='cuda:0', speed=1, seed=0, mood='default', accent='auto',
                variantId='voxcpm2-bf16') | changes


class MultilingualTests(unittest.TestCase):
    def test_voxcpm_controllable_and_continuation_do_not_swap_target_and_reference(self):
        r = request()
        validate(r)
        args = voxcpm_arguments(r, Path('reference.wav'))
        self.assertEqual(args['text'], 'Ah ! Je vire ça !')
        self.assertEqual(args['reference_wav_path'], 'reference.wav')
        self.assertNotIn('prompt_text', args)
        self.assertNotIn('seed', args)  # Seed is set on generators, not an upstream API argument.
        r['mode'] = 'zeroShot'
        validate(r)
        args = voxcpm_arguments(r, Path('reference.wav'))
        self.assertEqual(args['prompt_text'], r['referenceTranscript'])
        self.assertEqual(args['text'], r['text'])
        self.assertEqual(args['reference_wav_path'], 'reference.wav')

    def test_voxcpm_styled_continuation_still_requires_an_exact_transcript(self):
        for extra in ({}, {'mood': 'dying'}, {'accent': 'fr-FR'}):
            r = request(mode='zeroShot', referenceTranscript='', **extra)
            with self.assertRaisesRegex(ValueError, 'TTS_TRANSCRIPT_REQUIRED'):
                validate(r)
        args = voxcpm_arguments(request(mood='stressed', accent='fr-FR'), 'ref.wav')
        self.assertTrue(args['text'].startswith('('))
        self.assertTrue(args['text'].endswith('Ah ! Je vire ça !'))

    def test_chatterbox_explicit_french_is_independent_of_japanese_reference(self):
        r = request(variantId='chatterbox-multilingual-v3', referenceTranscript='')
        validate(r)
        args = chatterbox_arguments(r, Path('日本語.wav'))
        self.assertEqual(args['language_id'], 'fr')
        self.assertEqual(args['cfg_weight'], 0)
        self.assertEqual(args['text'], r['text'])
        self.assertEqual(args['audio_prompt_path'], '日本語.wav')
        self.assertNotIn('prompt_text', args)

    def test_unsupported_chatterbox_controls_and_device_fail_before_model_loading(self):
        for change, error in [({'mood': 'happy'}, 'TTS_STYLE_UNSUPPORTED'),
                              ({'accent': 'fr-FR'}, 'TTS_ACCENT_UNSUPPORTED'),
                              ({'device': 'vulkan:0'}, 'DEVICE_UNAVAILABLE'),
                              ({'mode': 'zeroShot'}, 'INVALID_TTS_REQUEST')]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, error):
                validate(request(variantId='chatterbox-multilingual-v3', **change))

    def test_model_integrity_detects_same_length_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            spec = dict(name='model', size=3, sha256=hashlib.sha256(b'abc').hexdigest())
            (directory / 'voice-engines.json').write_text(json.dumps({'variants': [dict(id='voxcpm2-bf16', files=[spec])]}))
            (directory / 'model').write_bytes(b'abc')
            with patch('multilingual_worker.HERE', directory), patch('multilingual_worker.report'):
                verify_models(request(modelDir=str(directory)))
                (directory / 'model').write_bytes(b'bad')
                with self.assertRaisesRegex(ValueError, 'MODEL_CHECKSUM_FAILED'):
                    verify_models(request(modelDir=str(directory)))

    def test_pinned_runtime_and_v3_assets_are_shipped_without_english_turbo_weights(self):
        root = Path(__file__).parent
        manifest = json.loads((root / 'voice-engines.json').read_text())
        vox, chatter = [next(v for v in manifest['variants'] if v['id'] == id) for id in ['voxcpm2-bf16', 'chatterbox-multilingual-v3']]
        self.assertEqual(vox['engine'], chatter['engine'])
        self.assertEqual(chatter['engine'], 'multilingual')
        self.assertEqual([f['name'] for f in chatter['files']], ['t3_mtl23ls_v3.safetensors', 's3gen.pt', 've.pt', 'grapheme_mtl_merged_expanded_v1.json', 'Cangjie5_TC.json', 'pkuseg.zip'])
        wheels = json.loads((root / 'multilingual-runtime.json').read_text())['files']
        names = [f['name'].split('-')[0] for f in wheels]
        self.assertEqual(len(names), len(set(names)))
        self.assertIn('torch-2.8.0+cu128-cp312-cp312-win_amd64.whl', [f['name'] for f in wheels])
        self.assertFalse({'gradio', 'modelscope', 'funasr', 'triton'} & set(names))
        self.assertIn('resemble_perth', names)
        self.assertTrue({'filelock', 'fsspec', 'typing_extensions', 'sympy', 'mpmath', 'networkx', 'jinja2', 'markupsafe', 'setuptools'}.issubset({name.lower() for name in names}))
        provenance = json.loads((root / 'vendor/chatterbox/UPSTREAM.json').read_text())
        self.assertEqual(len(provenance['revision']), 40)
        self.assertTrue(provenance['changes'])

    def test_drama_language_is_explicit_even_with_auto_accent_and_on_each_chunk(self):
        r = request()
        chunks = ['Ah ! Je vire ça !', 'La suite de la phrase.']
        for chunk, prompt in zip(chunks, target_chunks(r, lambda text: chunks)):
            self.assertTrue(prompt.startswith('[Speak the following text in French] '))
            self.assertTrue(prompt.endswith(chunk))
            self.assertNotIn(r['referenceTranscript'], prompt)
        self.assertEqual(r['text'], 'Ah ! Je vire ça !')
        with self.assertRaisesRegex(ValueError, 'TTS_LANGUAGE_UNSUPPORTED'):
            target_prompt(request(language='xx'), 'test')
        with self.assertRaisesRegex(ValueError, 'TTS_TEXT_MISMATCH'):
            target_chunks(request(promptText='あぁ！ 外すんだよ!!'))
        self.assertEqual(target_chunks(r, lambda text: [text]), ['[Speak the following text in French] Ah ! Je vire ça !'])


class PcmProtectionTests(unittest.TestCase):
    def test_clean_audio_is_not_boosted_or_changed(self):
        import numpy as np
        samples = (.25 * np.sin(np.arange(24000) / 24000 * 2 * np.pi * 220)).astype('float32')
        audio, peak, gain = protect_pcm_peaks(samples)
        self.assertIs(audio, samples)
        np.testing.assert_array_equal(audio, samples)
        self.assertEqual(gain, 1)
        self.assertAlmostEqual(peak, .25, places=5)

    def test_overshoot_is_attenuated_without_flattening_samples_or_changing_duration(self):
        import numpy as np
        import soundfile as sf
        samples = (1.5 * np.sin(np.arange(48000) / 24000 * 2 * np.pi * 220)).astype('float32')
        audio, peak, gain = protect_pcm_peaks(samples)
        self.assertGreater(peak, 1)
        self.assertLess(gain, 1)
        np.testing.assert_allclose(audio, samples * gain, atol=1e-7)
        self.assertLessEqual(float(np.max(np.abs(audio))), .981)
        with tempfile.TemporaryDirectory(prefix='PCM-é-') as directory:
            path = Path(directory) / 'doublage.wav'
            sf.write(path, audio, 24000, subtype='PCM_16')
            encoded, rate = sf.read(path, dtype='int16')
            self.assertEqual(rate, 24000)
            self.assertEqual(len(encoded), len(samples))
            self.assertFalse(np.any((encoded == 32767) | (encoded == -32768)))

    def test_empty_silent_or_nonfinite_output_is_rejected_before_encoding(self):
        import numpy as np
        for samples in [[], [0, 0], [np.nan], [np.inf], [-np.inf]]:
            with self.subTest(samples=samples), self.assertRaisesRegex(ValueError, 'TTS_EMPTY_AUDIO'):
                protect_pcm_peaks(samples)


if __name__ == '__main__':
    unittest.main()
