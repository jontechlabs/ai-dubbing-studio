import { it, expect } from 'vitest';
import { demoProject } from './project';
import { workflowLines } from './workflowSelection';
import { defaultVoiceSettings } from './tts';
import type { DubbingBatchSelection } from '../services/bridge';
const selection: DubbingBatchSelection = {
  scope: 'all',
  lineIds: [],
  force: false,
  options: defaultVoiceSettings,
};
it('queued selection freezes the chosen IDs and excludes discarded dialogues', () => {
  const p = demoProject();
  p.dialogues[1].excludedFromDubbing = true;
  expect(
    workflowLines(p, {
      ...selection,
      scope: 'selected',
      lineIds: [p.dialogues[0].id, p.dialogues[1].id],
    }).map((l) => l.id),
  ).toEqual([p.dialogues[0].id]);
  expect(workflowLines(p, selection)).toHaveLength(p.dialogues.length - 1);
  expect(workflowLines(p, { ...selection, scope: 'selected' })).toEqual([]);
});
it('whole-project isolation processes each multivoice parent once but allows an explicitly selected child', () => {
  const p = demoProject(),
    child = structuredClone(p.dialogues[0]);
  child.id = 'child';
  p.dialogues.push(child);
  p.speakerDubbings = [
    {
      id: 'group',
      parentId: p.dialogues[0].id,
      separationId: 'sep',
      modelId: 'model',
      sourcePath: p.media!.path,
      sourceTrackId: 'original',
      startMs: child.startMs,
      endMs: child.endMs,
      createdAt: new Date().toISOString(),
      active: true,
      voices: [
        {
          lineId: child.id,
          outputId: 'voice1',
          label: 'One',
          audioPath: 'characters/one.wav',
          sourceText: 'Hello',
          translations: { fr: 'Bonjour' },
        },
      ],
    },
  ];
  expect(workflowLines(p, selection).some((l) => l.id === child.id)).toBe(false);
  expect(
    workflowLines(p, { ...selection, scope: 'selected', lineIds: [child.id] }).map((l) => l.id),
  ).toEqual([child.id]);
});
