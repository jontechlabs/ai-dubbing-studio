import { expect, it } from 'vitest';
import fixture from '../../tests/fixtures/joint-review.json';
import { validateProject } from './project';
import {
  approveTranslation,
  approveTranslations,
  cleanTranslationApprovals,
  translationState,
} from './translation';
import { reviewGeneration, staleGeneration } from './tts';
import { canApproveJointReview } from './jointReview';
import { changedReviewTakes, reviewDecisionSnapshot } from './reviewChanges';
import { editProject } from '../mcp/actions';
import type { Generation } from './types';
const fresh = () => validateProject(structuredClone(fixture));

it.each(['text', 'timing', 'character', 'reference', 'source'] as const)(
  'requires explicit acceptance of changed %s, then saves an exact common review without rewriting any take',
  (reason) => {
    const p = fresh(),
      line = p.dialogues[0],
      take = p.generations[0] as Generation;
    if (reason === 'text') line.ttsText = 'Bonsoir.';
    if (reason === 'timing') line.endMs += 200;
    if (reason === 'character') {
      p.characters.push({
        id: 'new',
        name: 'Nouveau',
        color: '#123456',
        references: [],
        defaultReferenceId: null,
      });
      line.characterId = 'new';
    }
    if (reason === 'reference') {
      take.options.referenceMode = 'file';
      take.referenceId = 'ref';
      take.referenceTranscript = 'Ancienne référence';
      p.voiceReferences = [
        {
          id: 'ref',
          path: 'characters/ref.wav',
          label: 'Référence',
          durationMs: 2000,
          transcript: 'Correction',
          sourceDialogueId: null,
        },
      ];
    }
    if (reason === 'source') take.sourcePath = 'media/ancienne.mp4';
    cleanTranslationApprovals(p);
    const before = structuredClone(p);
    expect(staleGeneration(p, line, take)).toBe(true);
    expect(canApproveJointReview(p, line)).toBe(false);
    expect(canApproveJointReview(p, line, true)).toBe(true);
    expect(changedReviewTakes(p, line)[0].reasons).toContain(reason);
    expect(() => approveTranslation(p, line.id, true)).toThrow('TTS_STALE_GENERATION');
    expect(() => reviewGeneration(p, line.id, true)).toThrow('TTS_STALE_GENERATION');
    expect(approveTranslations(p, [line.id], true).translationApprovals?.[line.id]).toBeUndefined();
    for (const next of [
      approveTranslation(p, line.id, true, true),
      reviewGeneration(p, line.id, true, true),
      approveTranslations(p, [line.id], true, true),
    ]) {
      const loaded = validateProject(JSON.parse(JSON.stringify(next)));
      expect(translationState(loaded, loaded.dialogues[0])).toBe('approved');
      expect(loaded.dialogues[0].status).toBe('validated');
      expect(loaded.generations).toEqual(before.generations);
      expect(loaded.sourceCues).toEqual(before.sourceCues);
      expect(loaded.targetCues).toEqual(before.targetCues);
      expect(approveTranslation(loaded, line.id, true)).toBe(loaded);
      loaded.dialogues[0].endMs++;
      expect(cleanTranslationApprovals(loaded).translationApprovals?.[line.id]).toBeUndefined();
    }
    expect(p).toEqual(before);
  },
);
it('MCP requires the explicit boolean and preserves take provenance through approval and withdrawal', () => {
  const p = fresh();
  p.dialogues[0].ttsText = 'Texte modifié';
  cleanTranslationApprovals(p);
  expect(() => editProject(p, 'studio_review_take', { lineId: 'line1', validated: true })).toThrow(
    'TTS_STALE_GENERATION',
  );
  for (const tool of ['studio_review_take', 'studio_approve_translations']) {
    const args =
      tool === 'studio_review_take'
        ? { lineId: 'line1', validated: true }
        : { ids: ['line1'], approved: true };
    for (const invalid of ['true', null, 1])
      expect(() => editProject(p, tool, { ...args, acceptChangedTake: invalid })).toThrow(
        'MCP_INVALID_ARGUMENTS',
      );
    const next = editProject(p, tool, { ...args, acceptChangedTake: true });
    expect(translationState(next, next.dialogues[0])).toBe('approved');
    expect(next.generations).toEqual(p.generations);
    const withdrawn = reviewGeneration(next, 'line1', false);
    expect(translationState(withdrawn, withdrawn.dialogues[0])).toBe('translated');
  }
});
it('confirmation snapshots change with selected audio and edits, but not unrelated saves or selection', () => {
  const p = fresh(),
    before = reviewDecisionSnapshot(p, 'line1');
  p.revision++;
  p.name = 'Nouveau nom';
  expect(reviewDecisionSnapshot(p, 'line1')).toEqual(before);
  p.voiceEdits!.take1.outputGain = 1.75;
  expect(reviewDecisionSnapshot(p, 'line1')).not.toEqual(before);
});
