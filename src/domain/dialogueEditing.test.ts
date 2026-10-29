import { expect, test } from 'vitest';
import { addDialogue, setDialogueExclusion } from './dialogueEditing';
import { demoProject, validateProject } from './project';
import { exportSrt } from './subtitles';
import fixture from '../../tests/fixtures/joint-review.json';
import { dubbingClips } from './mix';
test('manual dialogue creates independent original/translated cues in time order without shifting existing media or takes', () => {
  const p = demoProject(),
    before = structuredClone(p);
  const next = validateProject(
    addDialogue(p, {
      startMs: 100,
      endMs: 600,
      sourceText: '日本語',
      targetText: 'Une réplique oubliée.',
    }),
  );
  expect(next.dialogues[0]).toMatchObject({
    startMs: 100,
    endMs: 600,
    status: 'ungenerated',
    selectedGenerationIds: {},
  });
  expect(next.dialogues.slice(1)).toEqual(p.dialogues);
  expect(next.media).toEqual(p.media);
  expect(next.generations).toEqual(p.generations);
  expect(p).toEqual(before);
  expect(exportSrt(next.targetCues)).toContain(
    '00:00:00,100 --> 00:00:00,600\nUne réplique oubliée.',
  );
  const targetOnly = addDialogue(p, {
    startMs: 4000,
    endMs: 4250,
    sourceText: '',
    targetText: 'Ajout',
  });
  expect(targetOnly.sourceCues).toEqual(p.sourceCues);
  expect(targetOnly.targetCues).toHaveLength(p.targetCues.length + 1);
});
test('manual dialogue rejects invalid, too short, beyond-media and empty ranges atomically', () => {
  const p = demoProject(),
    before = structuredClone(p);
  for (const [startMs, endMs] of [
    [-1, 500],
    [0, 99],
    [1.5, 500],
    [500, 500],
    [0, 16001],
    [0, Infinity],
  ])
    expect(() => addDialogue(p, { startMs, endMs, sourceText: 'A', targetText: '' })).toThrow(
      'INVALID_CUE_RANGE',
    );
  expect(() =>
    addDialogue(p, { startMs: 0, endMs: 1000, sourceText: ' ', targetText: '' }),
  ).toThrow('DIALOGUE_TEXT_REQUIRED');
  expect(p).toEqual(before);
});
test('exclusion preserves both subtitles and every selected take, edit and file reference', () => {
  const p = validateProject(structuredClone(fixture)),
    before = structuredClone(p);
  const next = validateProject(setDialogueExclusion(p, ['line1', 'line1']));
  expect(next.dialogues[0].excludedFromDubbing).toBe(true);
  expect(next.dialogues[0].selectedGenerationIds).toEqual(p.dialogues[0].selectedGenerationIds);
  expect(next.sourceCues).toEqual(p.sourceCues);
  expect(next.targetCues).toEqual(p.targetCues);
  expect(next.translationApprovals).toEqual({});
  expect(next.generations).toEqual(p.generations);
  expect(next.voiceEdits).toEqual(p.voiceEdits);
  expect(p).toEqual(before);
  const restored = validateProject(setDialogueExclusion(next, ['line1'], false));
  expect(restored.dialogues[0].excludedFromDubbing).toBeUndefined();
  expect(restored.translationApprovals).toEqual({});
  expect(restored.generations).toEqual(p.generations);
});
test('bulk exclusion retains shared and unrelated subtitles, rejects unknown IDs atomically and supports a no-op selection', () => {
  const p = demoProject(),
    a = p.dialogues[0],
    b = p.dialogues[1];
  b.sourceCueIds.push(a.sourceCueIds[0]);
  const next = validateProject(setDialogueExclusion(p, [a.id]));
  expect(next.sourceCues).toEqual(p.sourceCues);
  expect(next.targetCues).toEqual(p.targetCues);
  expect(next.dialogues).toHaveLength(4);
  expect(() => setDialogueExclusion(p, [b.id, 'missing'])).toThrow('NO_DIALOGUES');
  expect(setDialogueExclusion(p, [])).toBe(p);
  expect(
    setDialogueExclusion(
      p,
      p.dialogues.map((l) => l.id),
    ).dialogues.every((l) => l.excludedFromDubbing),
  ).toBe(true);
});
test('excluded takes leave the playback mix without changing their audio, edits or placement, then restore exactly', () => {
  const p = validateProject(structuredClone(fixture)),
    demo = demoProject();
  p.media = demo.media;
  p.generations[0].sourcePath = demo.media!.path;
  p.dubbingTiming = {
    sourcePath: demo.media!.path,
    offsetsMs: { line1: { fr: 250 } },
    durationsMs: { line1: { fr: 1250 } },
  };
  const clips = dubbingClips(p);
  expect(clips).toHaveLength(1);
  const excluded = setDialogueExclusion(p, ['line1']);
  expect(dubbingClips(excluded)).toEqual([]);
  expect(exportSrt(excluded.sourceCues)).toBe(exportSrt(p.sourceCues));
  expect(exportSrt(excluded.targetCues)).toBe(exportSrt(p.targetCues));
  expect(excluded.dubbingTiming).toEqual(p.dubbingTiming);
  expect(excluded.voiceEdits).toEqual(p.voiceEdits);
  expect(excluded.generations).toEqual(p.generations);
  const restored = setDialogueExclusion(excluded, ['line1'], false);
  expect(dubbingClips(restored).map((c) => ({ ...c, line: undefined }))).toEqual(
    clips.map((c) => ({ ...c, line: undefined })),
  );
});
