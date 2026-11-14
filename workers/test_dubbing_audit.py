import unittest
import numpy as np
from dubbing_audit_worker import supported_clusters


class AuditTests(unittest.TestCase):
    def test_one_voice_is_not_split(self):
        self.assertEqual(supported_clusters([np.array([1., 0.]) for _ in range(8)]), 1)

    def test_multiple_voices_require_repeated_independent_windows(self):
        a = np.array([1., 0.])
        b = np.array([0., 1.])
        self.assertEqual(supported_clusters([a, a, b]), 1)
        self.assertEqual(supported_clusters([a, a, b, b]), 2)

    def test_no_speech_is_unknown_not_single_voice(self):
        self.assertIsNone(supported_clusters([]))

