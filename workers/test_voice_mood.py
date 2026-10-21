import unittest
from types import SimpleNamespace
from cosyvoice_worker import synthesis_stream, validate_request


class MoodTests(unittest.TestCase):
    def test_all_catalogue_directions_are_valid_and_kept_out_of_spoken_text(self):
        from voice_mood import MOODS, mood_spec
        self.assertEqual(len(MOODS), 43)
        self.assertTrue({'dying', 'stressed', 'laughing'}.issubset(MOODS))
        for mood, entry in MOODS.items():
            with self.subTest(mood=mood):
                request = dict(text='Je suis toujours là.', language='fr', mode='zeroShot',
                               referenceTranscript='Bonjour.', speed=1, device='cpu', mood=mood)
                self.assertEqual(validate_request(request), 'cpu')
                calls = []
                model = SimpleNamespace(inference_instruct2=lambda *a, **k: calls.append(a),
                                        inference_zero_shot=lambda *a, **k: calls.append(a))
                synthesis_stream(model, request, 'reference.wav', {})
                self.assertEqual(calls[0][0], request['text'])
                self.assertEqual(calls[0][2], 'reference.wav')
                if mood != 'default':
                    self.assertTrue(entry['cosyInstruction'])
                    self.assertTrue(entry['fishInstruction'])
                    self.assertIn(entry['cosyInstruction'], calls[0][1])
                    self.assertNotIn('Bonjour.', calls[0][1])
                    with self.assertRaisesRegex(ValueError, 'TTS_STYLE_UNSUPPORTED'):
                        mood_spec(dict(request, variantId='qwen3-06b-gguf-q8'))
                self.assertEqual(request['text'], 'Je suis toujours là.')
        for value in ['', 'unknown', [], {}, 12, False]:
            with self.assertRaisesRegex(ValueError, 'TTS_STYLE_UNSUPPORTED'):
                mood_spec({'mood': value})

    def test_accent_and_mood_use_cosy_instruction_without_japanese_transcript_conditioning(self):
        calls = []
        model = SimpleNamespace(inference_instruct2=lambda *a, **k: calls.append((a, k)))
        request = dict(text='Bonjour !', language='fr', mode='zeroShot', speed=1, device='cpu', accent='fr-FR', mood='happy')
        self.assertEqual(validate_request(request), 'cpu')
        synthesis_stream(model, request, 'reference.wav', {'speed': 1})
        args, options = calls[-1]
        self.assertEqual(args[0], 'Bonjour !')
        self.assertIn('法国法语', args[1])
        self.assertIn('开心', args[1])
        self.assertEqual(args[2], 'reference.wav')
        self.assertEqual(options['speed'], 1)
        request['mood'] = 'default'
        self.assertEqual(validate_request(request), 'cpu')

    def test_accent_rejects_wrong_language_unknown_preset_and_qwen_base(self):
        from voice_accent import accent_spec
        for request in [dict(accent='fr-FR',language='ja'), dict(accent='unknown',language='fr'), dict(accent='fr-FR',language='fr',variantId='qwen3-06b-gguf-q8')]:
            with self.assertRaisesRegex(ValueError,'TTS_ACCENT_UNSUPPORTED'):
                accent_spec(request)
        self.assertIsNone(accent_spec({}))

    def test_cosy_style_uses_instruction_api_and_keeps_spoken_text_separate(self):
        calls = []
        model = SimpleNamespace(inference_instruct2=lambda *a, **k: calls.append(('style', a, k)),
                                inference_zero_shot=lambda *a, **k: calls.append(('zero', a, k)),
                                inference_cross_lingual=lambda *a, **k: calls.append(('cross', a, k)))
        request = dict(text='Bonjour !', mode='zeroShot', referenceTranscript='Hello there.', mood='angry')
        synthesis_stream(model, request, 'reference.wav', {'speed': 1})
        self.assertEqual(calls[-1][0], 'style')
        self.assertEqual(calls[-1][1][0], 'Bonjour !')
        self.assertIn('愤怒', calls[-1][1][1])
        self.assertTrue(calls[-1][1][1].endswith('<|endofprompt|>'))
        request['mood'] = 'default'
        synthesis_stream(model, request, 'reference.wav', {})
        self.assertEqual(calls[-1][0], 'zero')
        self.assertTrue(calls[-1][1][1].endswith('Hello there.'))
        request['mode'] = 'crossLingual'
        synthesis_stream(model, request, 'reference.wav', {})
        self.assertEqual(calls[-1][0], 'cross')

    def test_invalid_mood_is_rejected_and_default_still_needs_exact_transcript(self):
        request = dict(text='Bonjour', language='fr', speed=1, mode='zeroShot', device='cpu', mood='default')
        with self.assertRaisesRegex(ValueError, 'TTS_TRANSCRIPT_REQUIRED'):
            validate_request(request)
        request['mood'] = 'angry'
        self.assertEqual(validate_request(request), 'cpu')
        request['mood'] = 'invalid'
        with self.assertRaisesRegex(ValueError, 'TTS_STYLE_UNSUPPORTED'):
            validate_request(request)
