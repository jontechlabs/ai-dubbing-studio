import { expect, it } from 'vitest';
import { demoProject, validateProject } from './project';
import { dialogueText, editDialogue, exportSrt } from './subtitles';
import { dubbingClips, dubbingBounds, resizeDubbing, moveDubbing } from './mix';
import {
  isolatedVoice,
  retainSpeakerDialogues,
  setSpeakerDubbingGroup,
  speakerDubbingState,
} from './speakerDubbing';
import { defaultVoiceSettings, selectGeneration, spokenText } from './tts';
import { approveTranslation, translationState } from './translation';
import { mergeDialogue, splitDialogue } from './timing';
import type { Generation } from './types';
export function overlapFixture() {
  const p = demoProject();
  p.formatVersion = 25;
  const parent = p.dialogues[0];
  const voices = [1, 2].map((n) => {
    const line = {
      ...structuredClone(parent),
      id: 'child-' + n,
      sourceCueIds: [],
      targetCueIds: [],
      ttsText: null,
      characterId: null,
      selectedGenerationIds: { fr: 'child-take-' + n },
    };
    p.dialogues.push(line);
    return {
      lineId: line.id,
      outputId: 'voice-' + n,
      label: 'Personne ' + n,
      audioPath: 'stems/isolated-' + crypto.randomUUID() + '.wav',
      sourceText: '日本語 ' + n,
      translations: { fr: 'Bonjour ' + n },
    };
  });
  p.speakerDubbings = [
    {
      id: 'group',
      parentId: parent.id,
      separationId: 'separation',
      modelId: 'mossformer2-16k',
      sourcePath: p.media!.path,
      sourceTrackId: 'original',
      startMs: parent.startMs,
      endMs: parent.endMs,
      createdAt: new Date().toISOString(),
      active: true,
      voices,
    },
  ];
  for (const line of [parent, ...p.dialogues.slice(-2)]) {
    const key = line.selectedGenerationIds.fr ?? 'parent-take';
    line.selectedGenerationIds.fr = key;
    p.generations.push({
      id: key,
      kind: 'tts',
      dialogueId: line.id,
      providerId: 'cosyvoice3',
      modelId: 'cosy3-official',
      path: `generations/${key}.wav`,
      createdAt: new Date().toISOString(),
      sourcePath: p.media!.path,
      startMs: line.startMs,
      endMs: line.endMs,
      text: spokenText(p, line),
      language: 'fr',
      characterId: line.characterId,
      durationMs: 1500,
      sampleRate: 24000,
      options: { ...defaultVoiceSettings, mode: 'crossLingual' },
      referenceTranscript: '',
      device: 'cpu',
      deviceName: 'CPU',
      peakVramMb: 0,
      inputHash: 'test',
    } satisfies Generation);
  }
  return p;
}
it('mixes two active sibling voices together and keeps parent/all historical takes untouched', () => {
  const p = overlapFixture(),
    before = JSON.stringify(p.generations);
  validateProject(p);
  const clips = dubbingClips(p);
  expect(clips.map((c) => c.line.id)).toEqual(['child-1', 'child-2']);
  expect(clips.map((c) => c.slotMs)).toEqual([2500, 2500]);
  expect(clips.map((c) => c.lane)).toEqual([0, 1]);
  expect(dubbingBounds(p, 'child-1').max).toBeGreaterThan(0);
  expect(dubbingClips(resizeDubbing(p, 'child-1', 2000))[1].slotMs).toBe(2500);
  expect(
    dubbingClips(moveDubbing(p, 'child-1', 50)).find((c) => c.line.id === 'child-1')!.startMs,
  ).toBe(p.dialogues[0].startMs + 50);
  expect(JSON.stringify(p.generations)).toBe(before);
});
it('does not silently restore the parent when every child is excluded; explicit restore keeps children and SRTs', () => {
  const p = overlapFixture();
  p.dialogues.slice(-2).forEach((l) => (l.excludedFromDubbing = true));
  expect(dubbingClips(p)).toHaveLength(0);
  const restored = setSpeakerDubbingGroup(p, p.dialogues[0].id, null);
  expect(dubbingClips(restored).map((c) => c.generation.id)).toEqual(['parent-take']);
  expect(restored.generations).toEqual(p.generations);
  expect(restored.dialogues).toEqual(p.dialogues);
  expect(selectGeneration(p, 'parent-take').speakerDubbings![0].active).toBe(false);
});
it('stores distinct child source/translated texts without adding, editing or exporting SRT cues', () => {
  const p = overlapFixture(),
    source = exportSrt(p.sourceCues),
    target = exportSrt(p.targetCues);
  const next = editDialogue(
    editDialogue(p, 'child-1', 'source', '新しい声'),
    'child-1',
    'target',
    'Une autre voix.',
  );
  expect(dialogueText(next, next.dialogues.at(-2)!, 'source')).toBe('新しい声');
  expect(spokenText(next, next.dialogues.at(-2)!)).toBe('Une autre voix.');
  expect(dialogueText(next, next.dialogues.at(-1)!, 'target')).toBe('Bonjour 2');
  expect(exportSrt(next.sourceCues)).toBe(source);
  expect(exportSrt(next.targetCues)).toBe(target);
  validateProject(next);
});
it('withdraws a child review when its text changes and preserves unrelated reviews', () => {
  const p = overlapFixture(),
    id = 'child-1';
  p.generations = p.generations.filter((g) => g.id !== 'child-take-1');
  delete p.dialogues.at(-2)!.selectedGenerationIds.fr;
  const approved = approveTranslation(p, id, true);
  expect(translationState(approved, approved.dialogues.at(-2)!)).toBe('approved');
  const changed = editDialogue(approved, id, 'target', 'Changement');
  expect(translationState(changed, changed.dialogues.at(-2)!)).toBe('translated');
});
it('rejects malformed groups, duplicate identities, recursive parents and old format downgrade', () => {
  const p = overlapFixture();
  for (const mutate of [
    (v: typeof p) => {
      v.formatVersion = 24;
    },
    (v: typeof p) => {
      v.speakerDubbings![0].voices[0].audioPath = '../outside.wav';
    },
    (v: typeof p) => {
      v.speakerDubbings![0].voices[1].lineId = 'child-1';
    },
    (v: typeof p) => {
      v.speakerDubbings![0].parentId = 'child-1';
    },
    (v: typeof p) => {
      v.dialogues.at(-2)!.sourceCueIds = [v.sourceCues[0].id];
    },
  ]) {
    const v = structuredClone(p);
    mutate(v);
    expect(() => validateProject(v)).toThrow();
  }
});
it('retains child texts, selected takes and parent on subtitle realignment; guards destructive group edits', () => {
  const p = overlapFixture(),
    next = structuredClone(p);
  next.dialogues = [];
  next.sourceCues = [];
  next.targetCues = [];
  retainSpeakerDialogues(p, next);
  validateProject(next);
  expect(next.dialogues).toHaveLength(3);
  expect(isolatedVoice(next, 'child-1')!.voice.sourceText).toBe('日本語 1');
  expect(() => splitDialogue(p, 'child-1', 1000)).toThrow('SPEAKER_DUBBING_GROUP_EDIT');
  expect(() => mergeDialogue(p, p.dialogues[0].id)).toThrow('SPEAKER_DUBBING_GROUP_EDIT');
});
it('keeps unrelated duplicate starts conflicting and deactivates saved children when the source movie changes', () => {
  const p = overlapFixture();
  p.media!.path = 'media/another.mkv';
  expect(speakerDubbingState(p).enabled('child-1')).toBe(false);
  p.media!.path = p.speakerDubbings![0].sourcePath;
  const retimed = structuredClone(p);
  retimed.dialogues[0].startMs += 100;
  expect(speakerDubbingState(retimed).enabled('child-1')).toBe(false);
  expect(() => setSpeakerDubbingGroup(retimed, retimed.dialogues[0].id, 'group')).toThrow(
    'STALE_REVISION',
  );
  const unrelated = { ...structuredClone(p.dialogues.at(-1)!), id: 'unrelated' };
  p.dialogues.push(unrelated);
  const g = structuredClone(p.generations.at(-1)!);
  g.id = 'other';
  g.dialogueId = unrelated.id;
  unrelated.selectedGenerationIds.fr = 'other';
  p.generations.push(g);
  expect(dubbingClips(p).every((c) => c.slotMs === 0)).toBe(true);
});
