import hashlib
from pathlib import Path
import tempfile
import unittest
import numpy as np
import soundfile as sf
from voice_reference import prepare_reference


class ReferenceTests(unittest.TestCase):
    def test_diarization_16k_and_imported_stereo_become_24k_without_changing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'reference.wav'
            for rate, channels in [(16000, 1), (44100, 2), (48000, 1), (24000, 1)]:
                samples = 0.2 * np.sin(2 * np.pi * 220 * np.arange(rate * 2) / rate)
                sf.write(source, np.tile(samples[:, None], (1, channels)), rate, subtype='PCM_16')
                digest = hashlib.sha256(source.read_bytes()).hexdigest()
                with prepare_reference(source) as adapted:
                    info = sf.info(adapted)
                    self.assertEqual((info.channels, info.samplerate, info.frames), (1, 24000, 48000))
                    self.assertGreater(float(np.max(np.abs(sf.read(adapted)[0]))), 0.1)
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)
                if rate != 24000: self.assertFalse(adapted.exists())
            sf.write(source, np.full(32000, 0.1), 16000)
            destination=Path(directory)/'job-normalized.wav'
            with self.assertRaisesRegex(ValueError,'cancelled'):
                with prepare_reference(source,destination=destination) as adapted:
                    self.assertEqual(adapted,destination);self.assertTrue(adapted.is_file())
                    raise ValueError('cancelled')
            self.assertFalse(destination.exists())

    def test_boundaries_silence_and_invalid_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'reference.wav'
            for frames, valid in [(15999, False), (16000, True), (320000, True), (320001, False)]:
                sf.write(source, np.full(frames, 0.1), 16000)
                if valid:
                    with prepare_reference(source) as adapted: self.assertTrue(adapted.is_file())
                else:
                    with self.assertRaisesRegex(ValueError, 'INVALID_REFERENCE_AUDIO'):
                        with prepare_reference(source): pass
            sf.write(source, np.zeros(32000), 16000)
            with self.assertRaisesRegex(ValueError, 'TTS_REFERENCE_SILENT'):
                with prepare_reference(source): pass
            source.write_bytes(b'broken')
            with self.assertRaisesRegex(ValueError, 'INVALID_REFERENCE_AUDIO'):
                with prepare_reference(source): pass
