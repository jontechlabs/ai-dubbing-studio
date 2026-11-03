import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np
import portrait_preview_worker

class PreviewTests(unittest.TestCase):
    def test_all_faces_are_returned_spatially_without_names_and_source_is_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'Visages 日本語'; root.mkdir()
            image = root / 'image.png'; output = root / 'result.json'
            cv2.imencode('.png', np.zeros((360, 640, 3), dtype=np.uint8))[1].tofile(str(image))
            before = image.read_bytes()
            with patch('face_detection_worker.Detector') as detector:
                detector.return_value.detect.return_value = [(.6, .2, .2, .5), (.1, .2, .25, .5)]
                result = portrait_preview_worker.preview(dict(input=str(image), output=str(output), models=str(root), profile='anime'))
                detector.assert_called_once_with(str(root), 'anime')
            self.assertEqual(result['faces'][0]['x'], .1)
            self.assertEqual(len(result['faces']), 2)
            self.assertEqual(set(result), {'width', 'height', 'faces'})
            self.assertEqual(image.read_bytes(), before)
            self.assertEqual(json.loads(output.read_text()), result)

    def test_empty_and_many_detections_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image = root / 'i.png'
            cv2.imencode('.png', np.zeros((64, 64, 3), dtype=np.uint8))[1].tofile(str(image))
            for faces in [[], [(.1, .1, .2, .2)] * 100]:
                with patch('face_detection_worker.Detector') as detector:
                    detector.return_value.detect.return_value = faces
                    r = portrait_preview_worker.preview(dict(input=str(image), output=str(root / 'out.json'), models=str(root), profile='live'))
                self.assertEqual(len(r['faces']), min(32, len(faces)))

    def test_invalid_profile_or_oversized_frame_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image = root / 'i.png'
            cv2.imencode('.png', np.zeros((641, 20, 3), dtype=np.uint8))[1].tofile(str(image))
            for profile, error in [('guess', 'FACE_PROFILE_INVALID'), ('auto', 'CHARACTER_PORTRAIT_INVALID')]:
                with self.assertRaisesRegex(ValueError, error):
                    portrait_preview_worker.preview(dict(input=str(image), output=str(root / 'out.json'), models=str(root), profile=profile))

if __name__ == '__main__': unittest.main()
