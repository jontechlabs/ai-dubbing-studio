import unittest
import numpy as np
from character_worker import vocal_register, describe, plain
from speaker_worker import normalized, match_references

class CharacterReviewTests(unittest.TestCase):
    def test_acoustic_register_tracks_pitch_without_gender_labels(self):
        for frequency in (110, 180, 300, 500):
            t = np.arange(32000) / 16000
            result = vocal_register(.2 * np.sin(2 * np.pi * frequency * t))
            self.assertIsNotNone(result)
            self.assertAlmostEqual(result['medianHz'], frequency, delta=5)
            self.assertGreater(result['confidence'], .6)
            self.assertEqual(set(result), {'medianHz', 'confidence', 'analyzedMs'})

    def test_unvoiced_invalid_and_short_audio_have_no_register(self):
        for audio in (np.zeros(16000), np.ones(300), np.full(16000, np.nan), np.random.default_rng(0).normal(0, .05, 16000)):
            self.assertIsNone(vocal_register(audio))
        self.assertIsNone(vocal_register(np.zeros(32000), 48000))

    def test_reference_guidance_matches_any_enrolled_sample_and_refuses_others(self):
        refs = [normalized([1, 0, 0], np), normalized([0, 1, 0], np)]
        self.assertTrue(match_references(refs[1], refs)[0])
        self.assertFalse(match_references(normalized([0, 0, 1], np), refs)[0])
        self.assertFalse(match_references(refs[0], [])[0])
        self.assertFalse(match_references(normalized([1, 1, 1], np), refs, .8)[0])

    def test_visual_descriptor_is_bounded_deterministic_and_color_sensitive(self):
        try: import cv2
        except ImportError: self.skipTest('OpenCV tested after installation')
        first = np.zeros((256, 256, 3), dtype=np.uint8); first[:, :, 0] = 255
        other = first[:, :, ::-1].copy()
        a, b = describe(first), describe(other)
        self.assertEqual(a, describe(first)); self.assertEqual(len(a['differenceHash']), 16)
        self.assertEqual(len(a['colors']), 48); self.assertNotEqual(a['colors'], b['colors'])
        self.assertTrue(all(0 <= v <= 1 for v in a['colors']))

    def test_unicode_windows_worker_paths_are_normalized(self):
        self.assertEqual(plain('\\\\?\\C:\\Users\\élève\\portrait.png'), 'C:\\Users\\élève\\portrait.png')
        self.assertEqual(plain('\\\\?\\UNC\\server\\share\\x'), '\\\\server\\share\\x')

if __name__ == '__main__': unittest.main()
