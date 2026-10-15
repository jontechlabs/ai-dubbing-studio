import unittest
from types import SimpleNamespace
from cosyvoice_worker import synthesis_stream, validate_request


class MoodTests(unittest.TestCase):
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
