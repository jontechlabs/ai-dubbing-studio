import { it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import {
  dubbingClips,
  dubbingBounds,
  dubbingDuration,
  dubbingOffset,
  moveDubbing,
  resizeDubbing,
  recoverDubbing,
  mixReport,
} from './mix';
import { defaultVoiceSettings, spokenText } from './tts';
import type { Generation } from './types';
import { editVoice, editDuration, voicePlan } from './voiceEdit';
function fixture() {
  const p = demoProject();
  p.formatVersion = 5;
  p.generations = p.dialogues.map((line, index): Generation => ({
    kind: 'tts',
    id: `take${index}`,
    dialogueId: line.id,
    providerId: 'cosyvoice3',
    modelId: 'cosy3-official',
    path: `generations/take${index}.wav`,
    createdAt: new Date().toISOString(),
    sourcePath: p.media!.path,
    startMs: line.startMs,
    endMs: line.endMs,
    text: spokenText(p, line),
    language: 'fr',
    characterId: line.characterId,
    durationMs: 2000,
    sampleRate: 24000,
    options: { ...defaultVoiceSettings, referenceMode: 'current' },
    referenceTranscript: 'Hello',
    device: 'cpu',
    deviceName: 'CPU',
    peakVramMb: 0,
    inputHash: 'fixture',
  }));
  p.dialogues.forEach((line, i) => {
    line.selectedGenerationIds.fr = `take${i}`;
  });
  return p;
}

it('rejects invalid and oversize numeric duration requests atomically, including one millisecond beyond available space', () => {
  const p = fixture(),
    id = p.dialogues[0].id,
    before = JSON.stringify(p),
    bounds = dubbingBounds(p, id);
  expect(bounds.max).toBe(3750);
  for (const n of [-1, 0, 1.5, NaN, Infinity, 120001, 3751, Number.MAX_VALUE])
    expect(() => resizeDubbing(p, id, n)).toThrow('VOICE_DURATION_OUT_OF_RANGE');
  for (const n of [bounds.min, bounds.max]) {
    const next = resizeDubbing(p, id, n);
    expect(dubbingDuration(next, id)).toBe(n);
    expect(dubbingClips(next)[0].endMs - dubbingClips(next)[0].startMs).toBe(n);
    expect(validateProject(next)).toEqual(next);
  }
  expect(JSON.stringify(p)).toBe(before);
});
it('caps long automatic slots and exact durations at the same 120 second renderer limit', () => {
  const p = fixture();
  p.generations = p.generations.slice(0, 1);
  p.media!.durationMs = 300000;
  p.dialogues[0].endMs = 250000;
  const id = p.dialogues[0].id;
  expect(dubbingClips(p)[0].slotMs).toBe(120000);
  expect(dubbingBounds(p, id).max).toBe(120000);
  const exact = resizeDubbing(p, id, 120000);
  expect(dubbingClips(exact)[0].endMs - dubbingClips(exact)[0].startMs).toBe(120000);
  expect(() => resizeDubbing(p, id, 120001)).toThrow();
});
it('clamps moves at both video edges and occupied intervals without destroying any audible duration', () => {
  const p = fixture(),
    id = p.dialogues[0].id,
    before = dubbingClips(p),
    snapshot = JSON.stringify(p);
  for (const offset of [-1000000, -750, 0, 1000, 3750, 5000, 1000000]) {
    const next = moveDubbing(p, id, offset),
      clips = dubbingClips(next),
      clip = clips.find((c) => c.line.id === id)!;
    expect(clip.endMs - clip.startMs).toBe(2000);
    expect(clip.startMs).toBeGreaterThanOrEqual(0);
    expect(clip.endMs).toBeLessThanOrEqual(p.media!.durationMs);
    for (const other of clips.filter((c) => c.line.id !== id)) {
      const original = before.find((c) => c.line.id === other.line.id)!;
      expect(other.startMs).toBe(original.startMs);
      expect(other.endMs - other.startMs).toBe(original.endMs - original.startMs);
    }
    expect(mixReport(next).conflicts).toBe(0);
    expect(clips.every((c, i) => i === 0 || clips[i - 1].endMs <= c.startMs)).toBe(true);
    expect(validateProject(next)).toEqual(next);
  }
  for (const offset of [NaN, Infinity, 1.5, Number.MAX_VALUE])
    expect(() => moveDubbing(p, id, offset)).toThrow('INVALID_PROJECT');
  expect(JSON.stringify(p)).toBe(snapshot);
});
it('can reorder a take into a later genuinely free gap while preserving originals, subtitles and other takes', () => {
  const p = fixture(),
    id = p.dialogues[0].id,
    next = moveDubbing(p, id, 10000),
    clip = dubbingClips(next).find((c) => c.line.id === id)!;
  expect(clip.startMs).toBe(10500);
  expect(clip.endMs - clip.startMs).toBe(2000);
  expect(next.generations).toEqual(p.generations);
  expect(next.sourceCues).toEqual(p.sourceCues);
  expect(next.targetCues).toEqual(p.targetCues);
  expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next);
});
it('recovers legacy equal-onset conflicts by reserving the other collapsed voice original interval', () => {
  const p = fixture();
  p.dialogues[1].startMs = p.dialogues[0].startMs;
  const id = p.dialogues[0].id;
  expect(mixReport(p).conflicts).toBe(2);
  expect(dubbingBounds(p, id).limited).toBe(true);
  const next = recoverDubbing(p, id);
  expect(mixReport(next).conflicts).toBe(0);
  expect(
    dubbingClips(next).find((c) => c.line.id === id)!.endMs -
      dubbingClips(next).find((c) => c.line.id === id)!.startMs,
  ).toBe(2000);
  expect(p.dubbingTiming).toBeUndefined();
  expect(next.generations).toEqual(p.generations);
  const combined = structuredClone(p);
  combined.formatVersion = 7;
  combined.dubbingTiming = {
    sourcePath: combined.media!.path,
    offsetsMs: {},
    durationsMs: { [id]: { fr: 120000 } },
  };
  const repaired = recoverDubbing(combined, id);
  expect(mixReport(repaired).conflicts).toBe(0);
  expect(dubbingBounds(repaired, id).duration).toBe(2000);
});
it('normalizes an overlong saved request to its current real duration without deleting local edits', () => {
  let p = fixture();
  const id = p.dialogues[0].id;
  p = editVoice(p, 'take0', 500, 1000, { kind: 'gain', gain: 0.5 });
  p.dubbingTiming!.durationsMs![id].fr = 120000;
  expect(validateProject(p)).toEqual(p);
  expect(dubbingBounds(p, id).limited).toBe(true);
  const next = recoverDubbing(p, id);
  expect(dubbingDuration(next, id)).toBe(3750);
  expect(dubbingBounds(next, id).limited).toBe(false);
  expect(next.voiceEdits).toEqual(p.voiceEdits);
});
it('recovers a voice previously squeezed against the video end into a full audible slot', () => {
  const p = fixture(),
    id = p.dialogues[0].id;
  p.formatVersion = 7;
  p.dubbingTiming = {
    sourcePath: p.media!.path,
    offsetsMs: { [id]: { fr: p.media!.durationMs - 1 - p.dialogues[0].startMs } },
  };
  expect(dubbingBounds(p, id).duration).toBe(1);
  expect(dubbingBounds(p, id).limited).toBe(true);
  const next = recoverDubbing(p, id),
    clip = dubbingClips(next).find((c) => c.line.id === id)!;
  expect(clip.endMs - clip.startMs).toBe(2000);
  expect(dubbingBounds(next, id).limited).toBe(false);
  expect(dubbingOffset(next, id)).not.toBe(dubbingOffset(p, id));
});
it('allocates at least one millisecond to highly unequal split pieces when compressing and later resizing', () => {
  let p = editVoice(fixture(), 'take0', 0, 2000, { kind: 'fade', fadeInMs: 100, fadeOutMs: 100 });
  p = editVoice(p, 'take0', 1, 1999, { kind: 'gain', gain: 0.5 });
  p = editVoice(p, 'take0', 0, 2000, { kind: 'stretch', durationMs: 3 });
  expect(p.voiceEdits!.take0.pieces.map((p) => p.durationMs)).toEqual([1, 1, 1]);
  expect(validateProject(p)).toEqual(p);
  const id = p.dialogues[0].id;
  expect(() => resizeDubbing(p, id, 2)).toThrow('VOICE_DURATION_OUT_OF_RANGE');
  const next = resizeDubbing(p, id, 4);
  expect(editDuration(voicePlan(next, next.generations[0] as Generation))).toBe(4);
});
it('enforces the whole take limit for partial stretching and inserted silence at its exact boundary', () => {
  const p = fixture(),
    id = p.dialogues[0].id;
  const exact = editVoice(p, 'take0', 500, 1000, { kind: 'stretch', durationMs: 2250 });
  expect(dubbingBounds(exact, id).duration).toBe(3750);
  expect(() => editVoice(p, 'take0', 500, 1000, { kind: 'stretch', durationMs: 2251 })).toThrow(
    'VOICE_EDIT_NO_ROOM',
  );
  expect(
    editDuration(
      editVoice(p, 'take0', 500, 500, { kind: 'silence', durationMs: 1750 }).voiceEdits!.take0,
    ),
  ).toBe(3750);
  expect(() => editVoice(p, 'take0', 500, 500, { kind: 'silence', durationMs: 1751 })).toThrow(
    'VOICE_EDIT_NO_ROOM',
  );
  expect(p.voiceEdits).toBeUndefined();
});
it('keeps collapsed legacy multi-piece edits loadable and recoverable instead of inventing zero-duration pieces', () => {
  const p = editVoice(fixture(), 'take0', 300, 700, { kind: 'gain', gain: 0.5 });
  const id = p.dialogues[0].id;
  p.dubbingTiming!.durationsMs![id].fr = 1;
  expect(validateProject(p)).toEqual(p);
  expect(dubbingBounds(p, id).limited).toBe(true);
  expect(() => editVoice(p, 'take0', 0, 10, { kind: 'gain', gain: 1 })).toThrow(
    'VOICE_EDIT_NO_ROOM',
  );
  const next = recoverDubbing(p, id);
  expect(dubbingBounds(next, id).limited).toBe(false);
  expect(editDuration(voicePlan(next, next.generations[0] as Generation))).toBe(3);
  expect(next.voiceEdits).toEqual(p.voiceEdits);
});
it('refuses recovery when no free interval can hold the voice and leaves every saved edit untouched', () => {
  const p = fixture();
  p.media!.durationMs = 4000;
  p.dialogues = p.dialogues.slice(0, 2);
  p.generations = p.generations.slice(0, 2);
  for (const line of p.dialogues) {
    line.startMs = 0;
    line.endMs = 4000;
  }
  p.formatVersion = 7;
  p.dubbingTiming = {
    sourcePath: p.media!.path,
    offsetsMs: {},
    durationsMs: { [p.dialogues[1].id]: { fr: 4000 } },
  };
  const before = JSON.stringify(p);
  expect(() => recoverDubbing(p, p.dialogues[0].id)).toThrow('VOICE_EDIT_NO_ROOM');
  expect(JSON.stringify(p)).toBe(before);
});
