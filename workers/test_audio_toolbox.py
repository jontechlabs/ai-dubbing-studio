import hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import audio_toolbox_worker as worker

class AudioToolboxTests(unittest.TestCase):
    def request(self):
        return dict(modelId='audiosep',windowSeconds=4,device='cpu',prompt='A person speaking',modelDir='models',runtimeDir='runtime',inputPath='source.wav',outputDir='outputs',resultPath='result.json')

    def test_invalid_options_fail_before_any_weights_or_gpu_are_loaded(self):
        r=self.request();worker.validate(r)
        for update in [dict(modelId='anything'),dict(windowSeconds=0),dict(windowSeconds=9),dict(windowSeconds=2.5),dict(device='cuda:100'),dict(device='vulkan:0'),dict(prompt=''),dict(prompt='x'*501),dict(prompt='a\0b'),dict(resultPath='source.wav')]:
            with self.subTest(update=update),self.assertRaises(ValueError):worker.validate(dict(r,**update))
        worker.validate(dict(r,prompt='a shell-like description; never executed $(anything)'))
        worker.validate(dict(r,modelId='htdemucs',prompt=''))

    def test_overlaps_short_clips_and_last_samples_keep_exact_length_and_energy(self):
        for n in [1,30,100,499,500,999,1000,1001,1750,1999,2000,2001,3500,8001]:
            with self.subTest(n=n):
                x=np.sin(np.arange(n*2,dtype=np.float32).reshape(n,2)*.03)*.3;seen=[];progress=[]
                y=worker.chunks(x,lambda a:seen.append(len(a)) or np.stack((a*.8,a*.2)),500,4,progress.append)
                self.assertEqual(y.shape,(2,n,2));self.assertLessEqual(max(seen),2000)
                self.assertGreaterEqual(min(seen),500);self.assertEqual(progress[-1],1)
                np.testing.assert_allclose(y[0],x*.8,atol=1e-6);np.testing.assert_allclose(y.sum(axis=0),x,atol=1e-6)

    def test_bad_chunk_audio_is_rejected(self):
        x=np.ones((800,2),dtype=np.float32)*.2
        for infer in [lambda a:a[None,:3],lambda a:np.zeros((2,len(a),1)),lambda a:a[None]*float('nan')]:
            with self.assertRaises(ValueError):worker.chunks(x,infer,500,2,lambda _:None)
        for source in [x*float('inf'),np.zeros((0,2))]:
            with self.assertRaises(ValueError):worker.chunks(source,lambda a:a[None],500,2,lambda _:None)

    def test_installed_files_require_both_size_and_full_sha_before_unpickling(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);content=b'verified checkpoint';(p/'model').mkdir();(p/'model/weights').write_bytes(content)
            m=dict(models=[dict(id='audiosep',files=[dict(name='weights',size=len(content),sha256=hashlib.sha256(content).hexdigest())])]);(p/'audio-toolbox-models.json').write_text(json.dumps(m))
            r=dict(self.request(),modelDir=str(p/'model'))
            with patch.object(worker,'HERE',p):
                worker.verified_model(r)
                (p/'model/weights').write_bytes(b'x'*len(content))
                with self.assertRaisesRegex(ValueError,'MODEL_CHECKSUM_FAILED'):worker.verified_model(r)
                m['models'][0]['files'][0]['name']='../audio-toolbox-models.json';(p/'audio-toolbox-models.json').write_text(json.dumps(m))
                with self.assertRaisesRegex(ValueError,'MODEL_CHECKSUM_FAILED'):worker.verified_model(r)

    def test_manifest_contains_expected_stems_and_pinned_models(self):
        m=json.loads((Path(__file__).parent/'audio-toolbox-models.json').read_text())
        self.assertEqual({v['id'] for v in m['models']},worker.IDS)
        for model in m['models']:
            self.assertEqual(len(model['outputs']),len(set(model['outputs'])))
            for f in model['files']:
                self.assertRegex(f['sha256'],r'^[0-9a-f]{64}$');self.assertGreater(f['size'],0)
        demucs=next(v for v in m['models'] if v['id']=='htdemucs')
        self.assertEqual(set(demucs['outputs']),{'vocals','drums','bass','other'})
