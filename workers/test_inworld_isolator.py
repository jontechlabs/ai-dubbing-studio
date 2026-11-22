import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
import inworld_isolator as adapter


class Fake:
    precision = 'fp32'
    def __init__(self, limit=None, error=None):
        self.model=self;self.calls=[];self.removed=0;self.limit=limit;self.error=error
    def register_forward_hook(self, hook):
        self.hook=hook
        return SimpleNamespace(remove=lambda:setattr(self,'removed',self.removed+1))
    def isolate(self, mono, rate, chunk_seconds, overlap_seconds):
        self.calls.append(chunk_seconds)
        if self.error:raise RuntimeError(self.error)
        if self.limit is not None and chunk_seconds>self.limit:raise RuntimeError('CUDA out of memory')
        chunk=round(chunk_seconds*rate);overlap=round(overlap_seconds*rate)
        total=1 if len(mono)<=chunk else len(range(0,len(mono)-chunk,chunk-overlap))+1
        for _ in range(total):self.hook()
        return mono*.25


class InworldTests(unittest.TestCase):
    def test_official_sources_licenses_and_bundles_are_pinned(self):
        root=Path(__file__).parent;folder=root/'vendor/inworld-isolator'
        data=json.loads((folder/'UPSTREAM.json').read_text())
        self.assertEqual(len(data['revision']),40)
        for name,digest in data['files'].items():
            self.assertEqual(hashlib.sha256((folder/name).read_bytes()).hexdigest(),digest,name)
        self.assertIn('LICENSE',data['files']);self.assertIn('NOTICE',data['files'])
        resources=json.loads((root.parent/'src-tauri/tauri.conf.json').read_text())['bundle']['resources']
        for name in ['inworld_isolator.py','vendor/inworld-isolator/']:
            self.assertEqual(resources['../workers/'+name],'workers/'+name)
        model=next(m for m in json.loads((root/'audio-toolbox-models.json').read_text())['models'] if m['family']=='inworld')
        self.assertEqual(model['outputs'],['vocals','instrumental'])
        self.assertEqual(model['files'][0]['sha256'],'647335a6aeb4dc706b895532c209d51e0e84a4849d17b339f00d4392a050ae53')

    def test_official_window_counts_progress_and_exact_tail_for_short_and_long_clips(self):
        for n in [4800,96000,96001,528001]:
            model=Fake();progress=[];audio=np.ones(n,dtype=np.float32)
            out,window,attempts=adapter.bounded(model,audio,2,'cpu',progress.append)
            self.assertEqual((window,attempts),(2,1));self.assertEqual(len(out),n)
            np.testing.assert_allclose(out,.25);self.assertEqual(progress[-1],1)
            self.assertEqual(model.removed,1)

    def test_oom_reduces_windows_on_same_device_and_removes_every_hook(self):
        model=Fake(limit=1);released=[];audio=np.ones(48013,dtype=np.float32)
        out,window,attempts=adapter.bounded(model,audio,4,'cuda:1',lambda _:None,lambda:released.append(True))
        self.assertEqual(model.calls,[4,2,1]);self.assertEqual((window,attempts),(1,3))
        self.assertEqual(model.removed,3);self.assertEqual(len(released),2)
        self.assertEqual(len(out),len(audio))

    def test_cpu_memory_and_other_cuda_errors_do_not_retry(self):
        for device,error in [('cpu','out of memory'),('cuda:0','invalid kernel')]:
            model=Fake(error=error)
            with self.assertRaisesRegex(RuntimeError,error):
                adapter.bounded(model,np.ones(4800),2,device,lambda _:None,lambda:self.fail('Unexpected retry'))
            self.assertEqual(model.removed,1);self.assertEqual(model.calls,[2])

    def test_oom_floor_fails_without_cpu_fallback(self):
        model=Fake(limit=0)
        with self.assertRaisesRegex(ValueError,'AUDIO_TOOLBOX_GPU_OOM'):
            adapter.bounded(model,np.ones(4800),.5,'cuda:0',lambda _:None,lambda:self.fail('Unexpected retry'))
        self.assertEqual(model.calls,[.5]);self.assertEqual(model.removed,1)

    def test_stereo_background_reconstructs_source_and_preserves_levels_and_tail(self):
        source=np.random.default_rng(58).uniform(-.3,.3,(48013,2)).astype(np.float32)
        before=source.copy()
        with patch.object(adapter,'engine',return_value=Fake()),patch.dict('sys.modules',{'torch':SimpleNamespace()}):
            outputs,metadata=adapter.separate(dict(modelDir='unused',windowSeconds=2),source,'cpu',lambda **_:None)
        self.assertEqual(metadata['windowMs'],2000);self.assertEqual(metadata['peakVramMb'],0)
        np.testing.assert_allclose(outputs['vocals'][:,0],source.mean(axis=1)*.25)
        np.testing.assert_allclose(outputs['vocals']+outputs['instrumental'],source,atol=3e-8)
        np.testing.assert_array_equal(source,before)


if __name__=='__main__':unittest.main()
