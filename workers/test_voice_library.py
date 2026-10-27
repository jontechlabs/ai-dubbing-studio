from pathlib import Path
import tempfile
import unittest
import numpy as np
import soundfile as sf
from multilingual_worker import validate, voxcpm_arguments
from intonation_guide import analyze
from character_match_worker import rank_candidates


def request(**changes):
    return dict(text='Nous avons encore quelques minutes.', referenceTranscript='Une voix française.', language='fr',
                mode='crossLingual', device='cpu', speed=1, seed=0, mood='default', accent='auto', variantId='voxcpm2-bf16') | changes


class GuideRoutingTests(unittest.TestCase):
    def test_french_continuation_keeps_clean_target_and_transcript_without_english_directions(self):
        r=request(mode='zeroShot',accent='fr-FR',mood='anxious',text='Tu…',referenceTranscript='Cette cicatrice me lance.')
        validate(r)
        args=voxcpm_arguments(r,'français.wav')
        self.assertEqual(args['text'],'Tu…')
        self.assertEqual(args['prompt_text'],'Cette cicatrice me lance.')
        self.assertEqual(args['reference_wav_path'],args['prompt_wav_path'])
    def test_native_null_guide_keeps_original_controllable_cloning(self):
        r = request(intonationGuide=None)
        validate(r)
        args = voxcpm_arguments(r, 'french.wav')
        self.assertEqual(args['reference_wav_path'], 'french.wav')
        self.assertNotIn('prompt_wav_path', args)

    def test_two_audio_mode_keeps_french_text_and_separate_voice_and_japanese_delivery(self):
        r = request(intonationGuide=dict(mode='hybrid'), guideAudio='japanese.wav', guideTranscript='<i>少し待って。</i>')
        validate(r)
        args = voxcpm_arguments(r, 'french.wav', 'japanese.wav')
        self.assertEqual(args['text'], r['text'])
        self.assertEqual(args['reference_wav_path'], 'french.wav')
        self.assertEqual(args['prompt_wav_path'], 'japanese.wav')
        self.assertEqual(args['prompt_text'], '少し待って。')

    def test_style_guide_becomes_unspoken_directions_without_japanese_continuation(self):
        r = request(intonationGuide=dict(mode='style'), guideAudio='ja.wav', accent='fr-FR')
        validate(r)
        args = voxcpm_arguments(r, 'fr.wav', 'ja.wav', dict(direction='Use clear pauses and a falling ending.'))
        self.assertTrue(args['text'].endswith(r['text']))
        self.assertIn('clear pauses', args['text'].split(')')[0])
        self.assertEqual(args['reference_wav_path'], 'fr.wav')
        self.assertNotIn('prompt_wav_path', args)

    def test_invalid_or_unsupported_guides_fail_before_loading_a_model(self):
        for changes, error in [
            (dict(guideAudio=''), 'TTS_GUIDE_UNSUPPORTED'),
            (dict(variantId='chatterbox-multilingual-v3'), 'TTS_GUIDE_UNSUPPORTED'),
            (dict(mode='zeroShot'), 'TTS_GUIDE_UNSUPPORTED'),
            (dict(intonationGuide=dict(mode='hybrid'),guideTranscript=''), 'TTS_GUIDE_TRANSCRIPT_REQUIRED'),
            (dict(intonationGuide=dict(mode='hybrid'),guideTranscript='日本語',accent='fr-FR'), 'TTS_GUIDE_UNSUPPORTED'),
            (dict(intonationGuide=dict(mode='unknown')), 'TTS_GUIDE_UNSUPPORTED')]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError,error):
                validate(request(intonationGuide=dict(mode='style'),guideAudio='ja.wav') | changes)


class AcousticGuideTests(unittest.TestCase):
    def test_rising_and_falling_guides_are_measured_without_modifying_audio(self):
        with tempfile.TemporaryDirectory(prefix='Guide-日本-') as folder:
            time = np.arange(48000)/24000
            for slope, sign in [(80,1),(-60,-1)]:
                audio = (.25*np.sin(2*np.pi*(240*time+.5*slope*time*time))).astype('float32')
                path = Path(folder)/f'guide-{sign}.wav'; sf.write(path,audio,24000,subtype='PCM_16')
                original = path.read_bytes(); result = analyze(path)
                self.assertEqual(path.read_bytes(),original)
                self.assertEqual(result['durationMs'],2000)
                self.assertGreater(result['pitchConfidence'],.5)
                self.assertGreater(result['endPitchChangeSemitones']*sign,1.5)
                self.assertIn('rising' if sign>0 else 'falling',result['direction'])
                self.assertNotIn('emotion',result)

    def test_silent_stereo_short_and_oversized_guides_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            for i,(audio,rate) in enumerate([(np.zeros(24000),24000),(np.ones((24000,2))*.1,24000),(np.ones(4000)*.1,24000),(np.ones(21*8000)*.1,8000)]):
                path=Path(folder)/f'{i}.wav';sf.write(path,audio,rate)
                with self.subTest(case=i), self.assertRaises(ValueError):analyze(path)


class CandidateReviewTests(unittest.TestCase):
    def test_candidates_are_ranked_per_character_and_ambiguity_is_explicit(self):
        clear=rank_candidates([1,0,0],[('b',[[0,1,0]]),('a',[[.8,0,0],[1,0,0]])])
        self.assertTrue(clear['reliable']);self.assertEqual(clear['candidates'][0]['characterId'],'a')
        ambiguous=rank_candidates([1,0,0],[('a',[[1,0,0]]),('b',[[1,.01,0]])])
        self.assertFalse(ambiguous['reliable']);self.assertEqual(ambiguous['reason'],'uncertain')
        self.assertEqual(len(ambiguous['candidates']),2)

    def test_weak_empty_or_invalid_reference_vectors_cannot_claim_a_reliable_match(self):
        self.assertFalse(rank_candidates([1,0,0],[('a',[[0,1,0]])])['reliable'])
        self.assertEqual(rank_candidates([1,0,0],[])['candidates'],[])
        with self.assertRaises(ValueError):rank_candidates([0,0,0],[('a',[[1,0,0]])])


if __name__=='__main__':unittest.main()
