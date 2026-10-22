import unittest
from pathlib import Path
import voice_conversion_worker as vc

class VoiceConversionTests(unittest.TestCase):
    def test_paths_and_devices_are_validated_before_loading_weights(self):
        r=dict(variantId='chatterbox-vc',device='cuda:0',modelDir='model',sourceAudio='source.wav',referenceAudio='ref.wav',outputPath='out.wav',resultPath='result.json')
        vc.validate(r)
        for bad in ['vulkan:0','cuda:-1','cuda:100','other']:
            with self.assertRaises(ValueError):vc.validate(dict(r,device=bad))
        with self.assertRaises(ValueError):vc.validate(dict(r,outputPath='source.wav'))

    def test_windows_cover_the_whole_take_without_tail_loss_or_hard_seams(self):
        import numpy as np
        for duration in [.15,1,8,8.01,16,120]:
            source=np.sin(np.arange(round(duration*vc.RATE),dtype=np.float32)*.023)*.3
            seen=[]
            output=vc.convert_windows(source,lambda a: seen.append(len(a)) or a*.8)
            self.assertEqual(len(output),len(source))
            self.assertLess(max(seen),10*vc.RATE)
            np.testing.assert_allclose(output,source*.8,atol=1e-6)
            self.assertGreater(np.max(np.abs(output[-200:])),.01)

    def test_silence_nan_truncated_or_missing_model_audio_is_rejected(self):
        import numpy as np
        source=np.sin(np.arange(24000,dtype=np.float32)*.03)*.3
        for bad in [np.zeros(24000),source*float('nan'),source[:100]]:
            with self.assertRaises(ValueError):vc.convert_windows(bad,lambda a:a)
        for render in [lambda a:a[:100],lambda a:np.zeros(len(a)),lambda a:a*float('nan')]:
            with self.assertRaises(ValueError):vc.convert_windows(source,render)

    def test_muted_edit_regions_remain_silent_after_conversion(self):
        import numpy as np
        source=np.sin(np.arange(vc.RATE*18,dtype=np.float32)*.023)*.3
        source[vc.RATE:vc.RATE*2]=0
        source[vc.RATE*5:vc.RATE*17]=0
        output=vc.convert_windows(source,lambda a:np.ones(len(a),dtype=np.float32)*.2)
        self.assertEqual(len(output),len(source))
        self.assertTrue(np.all(output[vc.RATE:vc.RATE*2]==0))
        self.assertTrue(np.all(output[vc.RATE*5:vc.RATE*17]==0))
        self.assertGreater(output[-500],.01)

if __name__=='__main__':unittest.main()
