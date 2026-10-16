import json
from pathlib import Path
import tempfile
import unittest
import wave
from types import SimpleNamespace
import numpy as np
from musetalk_worker import plain_path, mouth_alpha, select_device, read_audio

class MuseTalkTests(unittest.TestCase):
    def test_windows_normalization_preserves_unc_and_unicode(self):
        self.assertEqual(plain_path('\\\\?\\C:\\Modèles\\test'), 'C:\\Modèles\\test')
        self.assertEqual(plain_path('\\\\?\\UNC\\server\\models'), '\\\\server\\models')

    def test_mask_keeps_every_pixel_outside_selected_mouth_transparent(self):
        alpha=mouth_alpha(dict(x=.2,y=.6,width=.6,height=.3),.15,.7)
        self.assertEqual(alpha.shape,(256,256));self.assertEqual(alpha.dtype,np.uint8)
        self.assertEqual(int(alpha[:153].max()),0);self.assertEqual(int(alpha[:, :50].max()),0)
        self.assertGreater(int(alpha[190,128]),170);self.assertLessEqual(int(alpha.max()),179)

    def test_invalid_mask_and_strength_are_rejected(self):
        for values in [dict(x=-.1,y=.5,width=.5,height=.4),dict(x=.9,y=.5,width=.5,height=.4),dict(x=.1,y=.5,width=float('nan'),height=.4)]:
            with self.assertRaisesRegex(ValueError,'INPAINT_MASK_INVALID'):mouth_alpha(values,.2,1)
        with self.assertRaises(ValueError):mouth_alpha(dict(x=.1,y=.1,width=.5,height=.5),0,1)

    def test_cpu_is_only_available_in_explicit_diagnostic_mode(self):
        torch=SimpleNamespace(device=lambda v:v,cuda=SimpleNamespace(is_available=lambda:False))
        for device in ['cpu','auto','vulkan:0','cuda:0']:
            with self.assertRaisesRegex(ValueError,'INPAINT_CUDA_REQUIRED|DEVICE_UNAVAILABLE'):select_device(torch,device)
        self.assertEqual(select_device(torch,'cpu',True),'cpu')

    def test_reference_audio_rejects_silence_and_wrong_rate(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'ref.wav'
            for rate,signal,error in [(16000,np.zeros(3200,dtype='<i2'),'LIPS_VOICE_SILENT'),(24000,np.ones(4800,dtype='<i2')*4000,'INPAINT_AUDIO_INVALID')]:
                with wave.open(str(path),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate);f.writeframes(signal.tobytes())
                with self.assertRaisesRegex(ValueError,error):read_audio(path)

    def test_manifests_pin_all_components_and_blackwell_cuda(self):
        root=Path(__file__).parent
        model=json.loads((root/'musetalk-model.json').read_text(encoding='utf-8'))
        runtime=json.loads((root/'musetalk-runtime.json').read_text(encoding='utf-8'))
        self.assertEqual(len(model['files']),7)
        self.assertGreater(sum(f['size'] for f in model['files']),3_800_000_000)
        for f in model['files']+runtime['files']:
            self.assertEqual(len(f['sha256']),64);self.assertGreater(f['size'],0);self.assertTrue(f['url'].startswith('https://'))
        self.assertTrue(any('torch-2.8.0' in f['name'] and 'cu128' in f['url'] for f in runtime['files']))
