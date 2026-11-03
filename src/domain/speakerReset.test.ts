import { expect, test } from 'vitest';
import { demoProject, validateProject } from './project';
import { addCharacter, resetSpeakers, type SpeakerResetMode } from './characters';
import { defaultVoiceSettings, selectedGeneration } from './tts';
import { dubbingClips } from './mix';
import { approveTranslation, translationState } from './translation';
import type { Generation } from './types';

function fixture() {
  const p = addCharacter(addCharacter(demoProject(), 'Speaker A'), 'Speaker B');
  p.formatVersion = 26;
  p.characters.forEach((c, i) => {
    c.references = [
      {
        id: `ref-${i}`,
        path: `characters/ref-${i}.wav`,
        label: c.name,
        durationMs: 2000,
        transcript: 'Référence.',
      },
    ];
    c.defaultReferenceId = `ref-${i}`;
    p.dialogues[i].characterId = c.id;
  });
  p.characterProfiles = {
    [p.characters[0].id]: {
      gender: 'man',
      voiceLibrary: { sources: [], samples: [], defaultSampleId: null },
    },
  };
  p.voiceReferences = [
    { ...p.characters[0].references[0], id: 'file-ref', path: 'characters/file-ref.wav' },
  ];
  p.dialogues[0].voiceSettings = {
    ...defaultVoiceSettings,
    referenceMode: 'custom',
    referenceId: 'ref-0',
  };
  p.dialogues[1].voiceSettings = {
    ...defaultVoiceSettings,
    referenceMode: 'file',
    referenceId: 'file-ref',
  };
  const line = p.dialogues[0];
  const take: Generation = {
    id: 'old-take',
    kind: 'tts',
    dialogueId: line.id,
    providerId: 'cosyvoice3',
    modelId: 'cosy3-official',
    path: 'generations/old.wav',
    createdAt: p.createdAt,
    sourcePath: p.media!.path,
    startMs: line.startMs,
    endMs: line.endMs,
    text: p.targetCues[0].text,
    language: 'fr',
    characterId: line.characterId,
    durationMs: 2000,
    sampleRate: 24000,
    options: { ...line.voiceSettings! },
    referenceTranscript: 'Référence.',
    referenceId: 'ref-0',
    device: 'cpu',
    deviceName: 'CPU',
    peakVramMb: 0,
    inputHash: 'old-take-hash',
  };
  p.generations.push(take);
  line.selectedGenerationIds.fr = take.id;
  p.speakerAnalysis = {
    id: 'analysis',
    sourcePath: p.media!.path,
    lines: p.dialogues.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })),
    assignments: p.dialogues.map((line) => ({
      dialogueId: line.id,
      speaker: 0,
      similarity: 0.95,
      reason: 'identified',
    })),
    clusters: [
      {
        speaker: 0,
        referencePath: 'characters/ref-0.wav',
        durationMs: 2000,
        referenceDialogueId: line.id,
      },
    ],
  };
  return validateProject(p);
}

for (const mode of ['assignments', 'characters'] as const) {
  test(`speaker reset ${mode} preserves playable selected takes, subtitles, tracks and global file references`, () => {
    const p = fixture(),
      before = structuredClone(p),
      next = resetSpeakers(p, mode);
    expect(validateProject(next)).toBe(next);
    expect(next.speakerAnalysis).toBeNull();
    expect(next.dialogues.every((line) => line.characterId === null)).toBe(true);
    for (const key of [
      'generations',
      'sourceCues',
      'targetCues',
      'tracks',
      'media',
      'voiceReferences',
      'pronunciation',
      'voiceEdits',
      'dubbingTiming',
    ] as const)
      expect(next[key]).toEqual(before[key]);
    expect(selectedGeneration(next, next.dialogues[0])?.id).toBe('old-take');
    expect(dubbingClips(next).some((clip) => clip.generation.id === 'old-take')).toBe(true);
    expect(next.dialogues[1].voiceSettings).toEqual(before.dialogues[1].voiceSettings);
    if (mode === 'assignments') {
      expect(next.characters).toEqual(before.characters);
      expect(next.characterProfiles).toEqual(before.characterProfiles);
      expect(next.dialogues[0].voiceSettings).toEqual(before.dialogues[0].voiceSettings);
    } else {
      expect(next.characters).toEqual([]);
      expect(next.characterProfiles).toBeUndefined();
      expect(next.dialogues[0].voiceSettings?.referenceId).toBeNull();
    }
    expect(resetSpeakers(next, mode)).toEqual(next);
    expect(p).toEqual(before);
  });
}
test('speaker reset invalidates only approvals dependent on the previous speaker identity', () => {
  let p = fixture();
  // This line has no selected take, so the joint approval can be created directly.
  p = approveTranslation(p, p.dialogues[1].id, true);
  expect(translationState(p, p.dialogues[1])).toBe('approved');
  const next = resetSpeakers(p, 'assignments');
  expect(translationState(next, next.dialogues[1])).toBe('translated');
  expect(next.targetCues).toEqual(p.targetCues);
  expect(next.generations).toEqual(p.generations);
});
test('speaker reset rejects an unknown mode without mutating the project', () => {
  const p = fixture(),
    before = structuredClone(p);
  expect(() => resetSpeakers(p, 'everything' as SpeakerResetMode)).toThrow('INVALID_CHARACTER');
  expect(p).toEqual(before);
});
