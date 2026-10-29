import { expect, test } from 'vitest';
import fixture from '../../tests/fixtures/joint-review.json';
import { jointReviewSnapshot } from './jointReview';
import { approveTranslation, cleanTranslationApprovals, translationState } from './translation';
import { selectGeneration } from './tts';
import { validateProject } from './project';
import type { Generation, Project } from './types';
const fresh = () => validateProject(structuredClone(fixture));

test('joint approval uses the same persisted JS/Rust snapshot, preserving no-op metadata and other tracks', () => {
  const p = fresh(),
    line = p.dialogues[0];
  expect(jointReviewSnapshot(p, line)).toEqual(p.translationApprovals!.line1.joint);
  p.revision++;
  p.updatedAt = 'Later';
  p.name = 'Renamed';
  p.tracks.push({
    id: 'music',
    kind: 'audio',
    role: 'music',
    language: '',
    mute: false,
    solo: false,
    gain: 1.5,
  });
  expect(translationState(cleanTranslationApprovals(p), line)).toBe('approved');
  expect(selectGeneration(p, 'take1')).toBe(p);
});
test('any text, pronunciation, selected take, local edit, gain, fade or timing change withdraws the common review', () => {
  const changes: ((p: Project) => void)[] = [
    (p) => {
      p.sourceCues[0].text += ' !';
    },
    (p) => {
      p.targetCues[0].text += ' !';
    },
    (p) => {
      p.dialogues[0].ttsText = 'Autre texte';
    },
    (p) => {
      p.pronunciation.Bonjour = 'Bonsoir';
    },
    (p) => {
      p.voiceEdits!.take1.outputGain = 1.75;
    },
    (p) => {
      p.voiceEdits!.take1.pieces[0].gain = 0;
    },
    (p) => {
      p.voiceEdits!.take1.pieces[0].durationMs = 1750;
    },
    (p) => {
      p.voiceEdits!.take1.pieces[0].envelope = [
        { atMs: 0, level: 0 },
        { atMs: 1500, level: 1 },
      ];
    },
    (p) => {
      p.voiceEdits!.take1.pieces[0].effects = [{ kind: 'reverb', enabled: true, parameters: {} }];
    },
    (p) => {
      p.dialogues[0].startMs = 1;
    },
    (p) => {
      p.dialogues[0].status = 'review';
    },
    (p) => {
      (p.generations[0] as Generation).path = 'generations/other.wav';
    },
    (p) => {
      p.generations.push({ ...structuredClone(p.generations[0]), id: 'take2' });
      p.dialogues[0].selectedGenerationIds.fr = 'take2';
    },
    (p) => {
      p.dialogues[0].selectedGenerationIds = {};
    },
  ];
  for (const change of changes) {
    const p = fresh(),
      original = structuredClone(p.generations);
    change(p);
    expect(translationState(p, p.dialogues[0])).toBe('translated');
    cleanTranslationApprovals(p);
    expect(p.translationApprovals?.line1).toBeUndefined();
    expect(p.dialogues[0].status).not.toBe('validated');
    if (p.generations[0].path === original[0].path && p.generations.length === original.length)
      expect(p.generations).toEqual(original);
  }
});
test('review withdrawal is permanent after reverting text; explicit review and undo snapshots restore it', () => {
  const p = fresh(),
    original = structuredClone(p);
  p.targetCues[0].text = 'Changed';
  cleanTranslationApprovals(p);
  p.targetCues[0].text = 'Bonjour.';
  expect(translationState(p, p.dialogues[0])).toBe('translated');
  const approved = approveTranslation(p, 'line1', true);
  expect(approved.dialogues[0].status).toBe('validated');
  expect(translationState(original, original.dialogues[0])).toBe('approved');
});
test('old separately approved text and voice migrate together, without approving a new or stale take', () => {
  const p = fresh();
  p.formatVersion = 23;
  delete p.translationApprovals!.line1.joint;
  const upgraded = cleanTranslationApprovals(p);
  expect(upgraded.formatVersion).toBe(24);
  expect(upgraded.dialogues[0].status).toBe('validated');
  expect(translationState(upgraded, upgraded.dialogues[0])).toBe('approved');
  for (const status of ['generated', 'review'] as const) {
    const p = fresh();
    delete p.translationApprovals!.line1.joint;
    p.dialogues[0].status = status;
    expect(cleanTranslationApprovals(p).translationApprovals?.line1).toBeUndefined();
  }
});
test('text-only approval prepares batches, then adding a selected voice requires a common review', () => {
  const p = fresh();
  p.dialogues[0].selectedGenerationIds = {};
  p.dialogues[0].status = 'ungenerated';
  p.translationApprovals = {};
  const approved = approveTranslation(p, 'line1', true);
  expect(translationState(approved, approved.dialogues[0])).toBe('approved');
  approved.dialogues[0].selectedGenerationIds.fr = 'take1';
  approved.dialogues[0].status = 'generated';
  expect(cleanTranslationApprovals(approved).translationApprovals?.line1).toBeUndefined();
  expect(approved.generations).toEqual(p.generations);
});
