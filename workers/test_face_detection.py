import unittest
from face_detection_worker import propose, iou, plain, normalized_boxes

class FaceTests(unittest.TestCase):
    def test_partly_visible_boxes_clip_to_image_and_invalid_offscreen_boxes_are_ignored(self):
        self.assertEqual(normalized_boxes([(-10,-10,60,60),(110,10,40,40),(float('nan'),0,40,40)],100,100),[(0,0,.5,.5)])
    def test_static_face_pads_forehead_chin_and_stays_in_frame(self):
        p=propose([[ [.3,.2,.2,.3] ]] * 5)['crop']
        self.assertLess(p['face']['x'],.3);self.assertGreater(p['face']['height'],.3)
        self.assertAlmostEqual(p['endX'],p['face']['x'])
    def test_linear_motion_proposes_fixed_size_endpoints(self):
        p=propose([[[.1+i*.02,.2,.2,.3]] for i in range(5)])['crop']
        self.assertGreater(p['endX'],p['face']['x'])
    def test_multiple_faces_never_guesses_the_speaker(self):
        self.assertEqual(propose([[[.1,.1,.2,.3],[.6,.1,.2,.3]]]*5)['reason'],'FACE_MULTIPLE')
    def test_missing_or_occluded_face_needs_manual_crop(self):
        self.assertEqual(propose([[[.1,.1,.2,.3]]]*4+[[]])['reason'],'FACE_NOT_FOUND')
    def test_scene_changes_are_not_bridged(self):
        self.assertEqual(propose([[[.1,.1,.2,.3]]]*5,True)['reason'],'FACE_SCENE_CHANGE')
    def test_nonlinear_motion_or_zoom_is_rejected(self):
        for boxes in [[[[x,.1,.2,.3]] for x in [.1,.2,.1,.3,.1]],[[[.1,.1,w,.3]] for w in [.1,.15,.2,.25,.3]]]:
            self.assertEqual(propose(boxes)['reason'],'FACE_MOVEMENT')
    def test_bad_numeric_results_are_never_valid_crops(self):
        for value in [float('nan'),float('inf'),-1,1.5]:
            with self.assertRaisesRegex(ValueError,'FACE_RESULT_INVALID'):propose([[[value,.1,.2,.3]]]*5)
    def test_bounds_overlap_and_extended_unicode_paths(self):
        self.assertAlmostEqual(iou([0,0,1,1],[0,0,1,1]),1)
        self.assertEqual(plain('C:/é/audio.png'),'C:/é/audio.png')
        b=chr(92)
        self.assertEqual(plain(b*2+'?'+b+'C:'+b+'é.png'),'C:'+b+'é.png')
        self.assertEqual(plain(b*2+'?'+b+'UNC'+b+'server'+b+'é.png'),b*2+'server'+b+'é.png')

if __name__=='__main__':unittest.main()
