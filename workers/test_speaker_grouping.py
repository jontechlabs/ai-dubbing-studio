import unittest
import numpy as np
from speaker_worker import group_embeddings,normalized


class GroupingTests(unittest.TestCase):
    def test_repeated_voices_stay_together_and_distinct_voices_separate(self):
        first=normalized([1,0,0],np);second=normalized([0,1,0],np)
        centers,groups=group_embeddings([first,second,first,second])
        self.assertEqual(len(centers),2)
        self.assertEqual([speaker for speaker,_ in groups],[0,1,0,1])

    def test_ambiguous_voice_is_left_unassigned_at_the_cluster_limit(self):
        first=normalized([1,0],np);second=normalized([0,1],np);mixed=normalized([1,1],np)
        _,groups=group_embeddings([first,second,mixed],limit=2)
        self.assertIsNone(groups[-1][0])

    def test_invalid_embedding_is_rejected(self):
        for vector in [[0,0],[float('nan'),1],[float('inf'),1]]:
            with self.subTest(vector=vector),self.assertRaisesRegex(ValueError,'SPEAKER_ANALYSIS_FAILED'):
                normalized(vector,np)
