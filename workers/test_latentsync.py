import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
import wave
import numpy as np
from latentsync_worker import settings, window_plan, read_audio, select_device, with_oom_retry


class LatentSyncTests(unittest.TestCase):
    def test_profile_has_real_resolution_and_validated_controls(self):
        self.assertEqual(settings(dict(modelId='latentsync-15', frames=5)), (256, 20, 1.5))
        self.assertEqual(settings(dict(modelId='latentsync-16', frames=3000, inferenceSteps=50, guidanceScale=3)), (512, 50, 3))
        for change in [dict(modelId='other'), dict(frames=3001), dict(frames=4), dict(inferenceSteps=0), dict(inferenceSteps=True), dict(guidanceScale=float('nan')), dict(guidanceScale=3.1)]:
            with self.assertRaises(ValueError):settings(dict(modelId='latentsync-15', frames=10) | change)

    def test_windows_bound_memory_and_cover_every_frame_including_short_tail(self):
        for count in [1, 5, 8, 16, 17, 250, 3000]:
            for size in [4, 8, 16]:
                seen=set();last_end=0
                for start,end,overlap in window_plan(count,size):
                    self.assertLessEqual(end-start,size);self.assertLessEqual(start,last_end)
                    self.assertGreater(end,start);self.assertLessEqual(end,count);self.assertLessEqual(overlap,size//2)
                    seen.update(range(start,end));last_end=end
                self.assertEqual(seen,set(range(count)))

    def test_audio_is_exactly_dialogue_length_not_first_twenty_seconds(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'日本語.wav';frames=2500
            samples=(np.sin(np.arange(frames*640)*.1)*3000).astype('<i2')
            with wave.open(str(path),'wb') as f:
                f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(samples.tobytes())
            self.assertEqual(len(read_audio(path,frames)),frames*640)
            with self.assertRaisesRegex(ValueError,'INPAINT_AUDIO_INVALID'):read_audio(path,frames-1)

    def test_no_cpu_fallback_and_explicit_selected_cuda_index(self):
        calls=[]
        cuda=SimpleNamespace(is_available=lambda:True,device_count=lambda:2,set_device=lambda i:calls.append(i),
            get_device_properties=lambda i:SimpleNamespace(total_memory=16*1024**3),mem_get_info=lambda i:(15*1024**3,16*1024**3),
            set_per_process_memory_fraction=lambda f,i:calls.append((f,i)))
        tensor=SimpleNamespace(mm=lambda other:None)
        torch=SimpleNamespace(cuda=cuda,device=lambda v:v,zeros=lambda *a,**kw:tensor,ones=lambda *a,**kw:tensor)
        self.assertEqual(select_device(torch,'cuda:1'),'cuda:1');self.assertEqual(calls[0],1);self.assertEqual(calls[1][1],1);self.assertLess(calls[1][0],.9)
        with self.assertRaisesRegex(ValueError,'INPAINT_CUDA_REQUIRED'):select_device(torch,'cpu')
        with self.assertRaisesRegex(ValueError,'DEVICE_UNAVAILABLE'):select_device(torch,'cuda:2')

    def test_only_cuda_oom_retries_smaller_windows_not_unrelated_errors(self):
        class OOM(Exception):pass
        calls=[];torch=SimpleNamespace(cuda=SimpleNamespace(OutOfMemoryError=OOM,empty_cache=lambda:None))
        def run(size):
            calls.append(size)
            if size>4:raise OOM('test')
            return 'same device'
        self.assertEqual(with_oom_retry(torch,run,8),'same device');self.assertEqual(calls,[8,4])
        with self.assertRaisesRegex(RuntimeError,'not memory'):with_oom_retry(torch,lambda _:(_ for _ in ()).throw(RuntimeError('not memory')),16)
        with self.assertRaisesRegex(ValueError,'INPAINT_GPU_MEMORY'):with_oom_retry(torch,lambda _:(_ for _ in ()).throw(OOM()),4)

    def test_weights_runtime_and_wrapper_are_pinned_and_versions_stay_distinct(self):
        root=Path(__file__).parent
        model=json.loads((root/'latentsync-model.json').read_text(encoding='utf-8'));runtime=json.loads((root/'latentsync-runtime.json').read_text(encoding='utf-8'))
        self.assertEqual(set(model['variants']),{'latentsync-15','latentsync-16'})
        first=model['variants']['latentsync-15']['files'][0];second=model['variants']['latentsync-16']['files'][0]
        self.assertNotEqual(first['sha256'],second['sha256']);self.assertNotEqual(first['name'],second['name'])
        for f in model['common']+sum([v['files'] for v in model['variants'].values()],[])+runtime['files']:
            self.assertEqual(len(f['sha256']),64);self.assertGreater(f['size'],0);self.assertTrue(f['url'].startswith('https://'))
        self.assertTrue(any(f['name'].startswith('diffusers-0.32.2') for f in runtime['files']))
        self.assertTrue(any(f['name'].startswith('torch-2.8.0+cu128') for f in runtime['files']))
        self.assertTrue((root/'vendor/latentsync/mask.png').is_file())
