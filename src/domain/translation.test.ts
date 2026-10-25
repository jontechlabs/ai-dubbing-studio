import { expect, test } from 'vitest';
import { demoProject, validateProject } from './project';
import {
  approveTranslation,
  approveTranslations,
  cleanTranslationApprovals,
  translationState,
} from './translation';
import { editDialogue } from './subtitles';
import { rebaseProject } from './rebase';

test('translation approval persists independently of voice validation and supports withdrawal', () => {
  const p = demoProject(),
    line = p.dialogues[0];
  line.status = 'validated';
  expect(translationState(p, line)).toBe('translated');
  const approved = approveTranslation(p, line.id, true);
  expect(approved.formatVersion).toBe(10);
  expect(
    translationState(validateProject(JSON.parse(JSON.stringify(approved))), approved.dialogues[0]),
  ).toBe('approved');
  expect(approveTranslation(approved, line.id, false).dialogues[0].status).toBe('validated');
  expect(translationState(approveTranslation(approved, line.id, false), line)).toBe('translated');
});
test('text and language changes revoke approval, while timing and pronunciation edits preserve it', () => {
  const p = demoProject(),
    id = p.dialogues[0].id,
    approved = approveTranslation(p, id, true);
  for (const role of ['source', 'target'] as const) {
    const edited = cleanTranslationApprovals(editDialogue(approved, id, role, 'Correction'));
    expect(translationState(edited, edited.dialogues[0])).toBe('translated');
    expect(edited.translationApprovals?.[id]).toBeUndefined();
  }
  const language = structuredClone(approved);
  language.languages.target = 'en';
  expect(cleanTranslationApprovals(language).translationApprovals?.[id]).toBeUndefined();
  const timed = editDialogue(approved, id, 'tts', 'Texte parlé');
  timed.dialogues[0].startMs++;
  expect(translationState(cleanTranslationApprovals(timed), timed.dialogues[0])).toBe('approved');
});
test('empty or formatting-only translations cannot be approved and legacy projects stay unapproved', () => {
  const p = demoProject(),
    line = p.dialogues[0];
  for (const text of ['', '  ', '<i> </i>']) {
    const blank = editDialogue(p, line.id, 'target', text);
    expect(translationState(blank, blank.dialogues[0])).toBe('untranslated');
    expect(() => approveTranslation(blank, line.id, true)).toThrow('TRANSLATION_REQUIRED');
  }
  expect(translationState(p, line)).toBe('translated');
  const approved = approveTranslation(p, line.id, true);
  approved.formatVersion = 9;
  expect(() => validateProject(approved)).toThrow('INVALID_PROJECT');
});
test('approval survives concurrent batch results and never resurrects after a text edit', () => {
  const base = demoProject(),
    id = base.dialogues[0].id,
    local = approveTranslation(base, id, true),
    incoming = structuredClone(base);
  incoming.dialogues[0].status = 'generated';
  incoming.revision++;
  const next = validateProject(rebaseProject(base, local, incoming));
  expect(translationState(next, next.dialogues[0])).toBe('approved');
  expect(next.dialogues[0].status).toBe('generated');
  const edited = cleanTranslationApprovals(editDialogue(next, id, 'target', 'Nouveau texte'));
  const restored = editDialogue(edited, id, 'target', base.targetCues[0].text);
  expect(translationState(restored, restored.dialogues[0])).toBe('translated');
});

test('bulk approval skips empty translations and preserves unselected approvals, voices and timing', () => {
  let p = demoProject();
  const [a, b, c, d] = p.dialogues;
  p = editDialogue(p, b.id, 'target', '<i> </i>');
  p.dialogues[1].ttsText = 'Pronunciation alone is not a translation';
  p.dialogues[0].status = 'validated';
  p = approveTranslation(p, d.id, true);
  const before = structuredClone(p);
  const next = approveTranslations(p, [a.id, b.id, c.id, a.id], true);
  expect(next.dialogues.map((line) => translationState(next, line))).toEqual([
    'approved',
    'untranslated',
    'approved',
    'approved',
  ]);
  expect(next.translationApprovals?.[d.id]).toEqual(p.translationApprovals?.[d.id]);
  expect(next.dialogues).toEqual(p.dialogues);
  expect(next.generations).toEqual(p.generations);
  expect(next.sourceCues).toEqual(p.sourceCues);
  expect(next.targetCues).toEqual(p.targetCues);
  expect(p).toEqual(before);
  expect(validateProject(JSON.parse(JSON.stringify(next))).translationApprovals).toEqual(
    next.translationApprovals,
  );
  const withdrawn = approveTranslations(next, [a.id, b.id, c.id], false);
  expect(withdrawn.dialogues.map((line) => translationState(withdrawn, line))).toEqual([
    'translated',
    'untranslated',
    'translated',
    'approved',
  ]);
  expect(withdrawn.dialogues[0].status).toBe('validated');
});

test('bulk approval snapshots ordered multiline cues and is revoked by changed text or language', () => {
  const p = demoProject(),
    line = p.dialogues[0];
  line.targetCueIds = [p.targetCues[1].id, p.targetCues[0].id];
  const next = approveTranslations(p, [line.id], true);
  expect(next.translationApprovals?.[line.id].targetText).toBe(
    p.targetCues[1].text + '\n' + p.targetCues[0].text,
  );
  expect(translationState(next, next.dialogues[0])).toBe('approved');
  const edited = editDialogue(next, line.id, 'target', 'Changed');
  expect(cleanTranslationApprovals(edited).translationApprovals?.[line.id]).toBeUndefined();
  next.languages.target = 'en';
  expect(cleanTranslationApprovals(next).translationApprovals?.[line.id]).toBeUndefined();
});

test('bulk approval rejects an unknown ID atomically and leaves no-op selections unchanged', () => {
  const p = demoProject(),
    id = p.dialogues[0].id,
    before = structuredClone(p);
  for (const approved of [true, false]) {
    expect(() => approveTranslations(p, [id, 'missing'], approved)).toThrow('NO_DIALOGUES');
    expect(p).toEqual(before);
    expect(approveTranslations(p, [], approved)).toBe(p);
  }
  expect(approveTranslations(p, [id], false)).toBe(p);
  const approved = approveTranslations(p, [id], true);
  expect(approveTranslations(approved, [id, id], true)).toBe(approved);
  const blank = editDialogue(approved, id, 'target', '');
  expect(approveTranslations(blank, [id], true)).toBe(blank);
  expect(approveTranslations(blank, [id], false).translationApprovals?.[id]).toBeUndefined();
});
