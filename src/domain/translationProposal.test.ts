import { expect, test } from 'vitest';
import { demoProject } from './project';
import { dialogueText, editDialogue } from './subtitles';
import { approveTranslation, translationStates } from './translation';
import {
  applyTranslationProposal,
  proposalCurrent,
  type TranslationProposal,
} from './translationProposal';

function proposal(project = demoProject()): TranslationProposal {
  const line = project.dialogues[0];
  return {
    model: 'test',
    translations: ['Une proposition.'],
    basis: {
      projectId: project.id,
      lineId: line.id,
      sourceLanguage: project.languages.source,
      targetLanguage: project.languages.target,
      sourceText: dialogueText(project, line, 'source'),
      targetText: dialogueText(project, line, 'target'),
      sourceCueIds: line.sourceCueIds,
      targetCueIds: line.targetCueIds,
    },
  };
}
test('applying a proposal preserves cue timing and voice data, revokes approval and leaves input untouched', () => {
  const original = demoProject(),
    id = original.dialogues[0].id;
  const p = approveTranslation(original, id, true),
    suggestion = proposal(p);
  const next = applyTranslationProposal(p, suggestion);
  expect(dialogueText(next, next.dialogues[0], 'target')).toBe('Une proposition.');
  expect(next.targetCues[0]).toEqual({ ...p.targetCues[0], text: 'Une proposition.' });
  expect(next.generations).toEqual(p.generations);
  expect(next.translationApprovals?.[id]).toBeUndefined();
  expect(p.translationApprovals?.[id]).toBeDefined();
});
test('stale text, language, project and associations prevent applying; unrelated edits do not', () => {
  const p = demoProject(),
    suggestion = proposal(p);
  expect(proposalCurrent({ ...p, revision: p.revision + 1 }, suggestion)).toBe(true);
  const changes = [
    editDialogue(p, p.dialogues[0].id, 'source', 'Changed'),
    editDialogue(p, p.dialogues[0].id, 'target', 'Correction'),
    { ...p, languages: { ...p.languages, target: 'es' } },
    { ...p, id: 'other' },
  ];
  for (const changed of changes)
    expect(() => applyTranslationProposal(changed, suggestion)).toThrow('TRANSLATION_STALE');
  const reassociated = structuredClone(p);
  reassociated.dialogues[0].targetCueIds = [];
  expect(proposalCurrent(reassociated, suggestion)).toBe(false);
});
test('multi-cue proposals preserve every cue and a missing translation creates only one cue', () => {
  const p = demoProject(),
    line = p.dialogues[0];
  p.targetCues.push({ ...p.targetCues[0], id: 'extra', startMs: line.endMs - 500, text: 'suite' });
  line.targetCueIds.push('extra');
  const suggestion = proposal(p);
  suggestion.translations.push('Suite traduite.');
  const next = applyTranslationProposal(p, suggestion);
  expect(next.targetCues.find((c) => c.id === 'extra')).toEqual({
    ...p.targetCues.at(-1),
    text: 'Suite traduite.',
  });
  const empty = demoProject();
  empty.dialogues[0].targetCueIds = [];
  const result = applyTranslationProposal(empty, proposal(empty));
  expect(result.dialogues[0].targetCueIds).toHaveLength(1);
  expect(result.targetCues).toHaveLength(empty.targetCues.length + 1);
});
test('empty or wrong-count proposals cannot modify subtitles', () => {
  const p = demoProject(),
    s = proposal(p);
  for (const translations of [[], [''], ['  '], ['one', 'two']])
    expect(() => applyTranslationProposal(p, { ...s, translations })).toThrow(
      'TRANSLATION_OUTPUT_INVALID',
    );
});
test('duration-aware proposals reject changed windows while older proposals remain readable', () => {
  const p = demoProject(),
    suggestion = proposal(p),
    line = p.dialogues[0];
  suggestion.direction = 'Méchant, ton vulgaire et bref.';
  suggestion.basis.timing = {
    startMs: line.startMs,
    endMs: line.endMs,
    targetSlots: line.targetCueIds.map((id) => {
      const cue = p.targetCues.find((c) => c.id === id)!;
      return [cue.startMs, cue.endMs];
    }),
  };
  expect(proposalCurrent(p, suggestion)).toBe(true);
  const changed = structuredClone(p);
  changed.targetCues[0].endMs -= 10;
  expect(proposalCurrent(changed, suggestion)).toBe(false);
  const resized = structuredClone(p);
  resized.dialogues[0].endMs += 10;
  expect(proposalCurrent(resized, suggestion)).toBe(false);
  expect(proposalCurrent(changed, proposal(p))).toBe(true);
});
test('indexed translation states match three colours and reject stale approvals', () => {
  const p = demoProject(),
    first = p.dialogues[0];
  const next = approveTranslation(editDialogue(p, p.dialogues[1].id, 'target', ''), first.id, true);
  const states = translationStates(next);
  expect(states.get(first.id)).toBe('approved');
  expect(states.get(next.dialogues[1].id)).toBe('untranslated');
  expect(states.get(next.dialogues[2].id)).toBe('translated');
  next.targetCues[0].text += ' changed';
  expect(translationStates(next).get(first.id)).toBe('translated');
});
