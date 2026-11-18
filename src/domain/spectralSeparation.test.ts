import { test, expect } from 'vitest';
import { demoProject } from './project';
import { separationWindow, validateSpeakerDubbings, speakerDubbingState } from './speakerDubbing';
import { validateTakeOrigins } from './voiceCapture';
function fixture() {
  const p = demoProject();
  p.formatVersion = 35;
  const parent = p.dialogues[0];
  const voices = Array.from({ length: 5 }, (_, i) => {
    const id = 'isolated-' + i;
    p.dialogues.push({
      ...structuredClone(parent),
      id,
      sourceCueIds: [],
      targetCueIds: [],
      selectedGenerationIds: {},
    });
    return {
      lineId: id,
      outputId: 'voice-' + (i + 1),
      label: 'Voice ' + (i + 1),
      audioPath: 'stems/isolated-' + crypto.randomUUID() + '.wav',
      sourceText: '',
      translations: { fr: '' },
    };
  });
  p.speakerDubbings = [
    {
      id: 'group',
      parentId: parent.id,
      separationId: 'result',
      modelId: 'sr-corrnet-wsj-2-5spk',
      sourcePath: p.media!.path,
      sourceTrackId: 'original',
      startMs: parent.startMs,
      endMs: parent.endMs,
      createdAt: new Date().toISOString(),
      active: true,
      voices,
    },
  ];
  return p;
}
test('memory profiles cap GPU windows without changing a manual window', () => {
  expect(separationWindow('gpu16', 8)).toBe(2);
  expect(separationWindow('quality', 8)).toBe(4);
  expect(separationWindow('manual', 8)).toBe(8);
});
test('five simultaneous streams require format 35 and are all enabled', () => {
  const p = fixture();
  expect(() => validateSpeakerDubbings(p)).not.toThrow();
  const state = speakerDubbingState(p);
  expect(p.speakerDubbings![0].voices.every((v) => state.enabled(v.lineId))).toBe(true);
  p.formatVersion = 34;
  expect(() => validateSpeakerDubbings(p)).toThrow('SPEAKER_SEPARATION_OPTIONS');
});
test('model-specific stream limits reject a fifth output on a two-voice separator', () => {
  const p = fixture();
  p.speakerDubbings![0].modelId = 'tf-gridnet-wsj0-2mix';
  p.speakerDubbings![0].voices = [p.speakerDubbings![0].voices[4]];
  expect(() => validateSpeakerDubbings(p)).toThrow();
  p.speakerDubbings![0].voices[0].outputId = 'voice-2';
  expect(() => validateSpeakerDubbings(p)).not.toThrow();
});
test('five-stream take provenance stays rejected by the old format', () => {
  const p = fixture();
  p.generations = [
    {
      id: 'take',
      kind: 'tts',
      takeOrigin: {
        type: 'separation',
        separationId: 'result',
        outputId: 'voice-5',
        sourceTrackId: 'original',
        sourceLanguage: 'ja',
      },
    },
  ];
  expect(() => validateTakeOrigins(p)).not.toThrow();
  p.formatVersion = 34;
  expect(() => validateTakeOrigins(p)).toThrow();
});
