from pathlib import Path
import itertools
import json
import tempfile
import unittest
import numpy as np
import speaker_separation_worker as worker


class SpeakerSeparationTests(unittest.TestCase):
    def test_overlap_alignment_keeps_two_and_three_streams_and_their_last_samples(self):
        for count in [2, 3]:
            with self.subTest(count=count):
                n, window, hop = 7137, 2000, 1000
                t = np.arange(n, dtype=np.float32)
                sources = np.stack([.2 * np.sin(t * (.041 + .027*i) + .3 + i) for i in range(count)])
                counter = [0]
                permutations = list(itertools.permutations(range(count)))
                def infer(chunk):
                    start = counter[0]*hop
                    order = permutations[counter[0] % len(permutations)]
                    counter[0] += 1
                    values = np.pad(sources[:, start:start+window], [(0,0),(0,max(0,start+window-n))])
                    return values[list(order)]
                result = worker.separate_windows(sources.sum(axis=0), count, window, infer)
                np.testing.assert_allclose(result, sources, rtol=1e-5, atol=1e-6)
                np.testing.assert_allclose(result[:, -1], sources[:, -1], atol=1e-7)

    def test_stream_matching_ignores_gain_and_handles_silent_overlap_deterministically(self):
        t = np.arange(500, dtype=np.float32)
        previous = np.stack([np.sin(t*.031),np.cos(t*.047),np.sin(t*.081+.6)])
        current = previous[[2,0,1]] * np.array([.2,2,1.5],dtype=np.float32)[:,None]
        self.assertEqual(worker.align_channels(previous,current),(1,2,0))
        self.assertEqual(worker.align_channels(np.zeros((3,500)),np.zeros((3,500))),(0,1,2))

    def test_short_and_partial_windows_keep_exact_length_and_reject_bad_model_shapes(self):
        for n in [1,15,500,2000,2001,4000,4001]:
            result = worker.separate_windows(np.ones(n,dtype=np.float32),2,2000,
                                             lambda chunk:np.stack([chunk,chunk*.5]))
            self.assertEqual(result.shape,(2,n))
            np.testing.assert_allclose(result[0],1)
            np.testing.assert_allclose(result[1],.5)
        for value in [np.zeros((1,2000)),np.zeros((2,1999)),np.full((2,2000),np.nan)]:
            with self.assertRaisesRegex(ValueError,'SPEAKER_SEPARATION_OUTPUT_INVALID'):
                worker.separate_windows(np.ones(2000,dtype=np.float32),2,2000,lambda chunk:value)

    def test_resampling_uses_original_frame_count_without_tail_truncation(self):
        samples = np.stack([np.sin(np.arange(16016)*.01),np.cos(np.arange(16016)*.02)]).astype(np.float32)
        for frames in [48048,48049,48047]:
            result=worker.resample_exact(samples,16000,48000,frames)
            self.assertEqual(result.shape,(2,frames))
            self.assertTrue(np.isfinite(result).all())
        for value in ['auto','cuda:x','vulkan:0',None]:
            with self.assertRaisesRegex(ValueError,'DEVICE_UNAVAILABLE'):worker.device_name(value)

    def test_model_manifests_pin_inference_only_files_and_outputs_never_overwrite(self):
        specs=[worker.model_spec(id_) for id_ in ['mossformer2-16k','sepformer-2mix','sepformer-3mix']]
        self.assertEqual([s['speakers'] for s in specs],[2,2,3])
        for spec in specs:
            self.assertEqual(len(spec['revision']),40)
            self.assertFalse(any('optimizer' in f['name'] for f in spec['files']))
            self.assertTrue(all(len(f['sha256'])==64 and '/resolve/'+spec['revision']+'/' in f['url'] for f in spec['files']))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);target=root/'output';target.mkdir()
            saved=target/'voice-1.wav';saved.write_bytes(b'preserve existing voice')
            with self.assertRaisesRegex(ValueError,'SPEAKER_SEPARATION_OUTPUT_EXISTS'):
                worker.generate(dict(modelId='mossformer2-16k',inputPath=str(root/'input.wav'),
                                     outputDir=str(target),modelDir=str(root/'models'),device='cpu'))
            self.assertEqual(saved.read_bytes(),b'preserve existing voice')


if __name__=='__main__':unittest.main()
